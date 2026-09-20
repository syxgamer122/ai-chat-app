'use client';

/**
 * Quản lý MCP server trong Cài đặt.
 *
 * MCP chỉ tồn tại trong Vyen desktop: client MCP sống trong Electron main
 * (nơi spawn được process con và giữ kết nối HTTP), renderer chỉ nói chuyện
 * qua IPC. Trên web component này tự thu mình lại thành một dòng giải thích
 * thay vì giả vờ có tính năng.
 *
 * Cấu hình được lưu ở Electron userData (vyen-mcp-configs.json) — MỘT nguồn
 * duy nhất, vì renderer (Zustand/localStorage) và main không chia sẻ bộ nhớ.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, RefreshCw, Server, Trash2, TriangleAlert } from 'lucide-react';
import {
  addMcpServer,
  isMcpAvailable,
  listMcpServers,
  onMcpServerStatus,
  reconnectMcpServer,
  removeMcpServer,
  setMcpExposeMode,
} from '@/lib/mcp/bridge';
import type {
  VyenMcpServerConfig,
  VyenMcpServerState,
  VyenMcpServerStatus,
} from '@/lib/desktop-bridge';

type Transport = 'stdio' | 'streamable-http' | 'sse';

const TRANSPORT_LABELS: Record<Transport, string> = {
  stdio: 'stdio (chạy lệnh trên máy)',
  'streamable-http': 'Streamable HTTP (khuyên dùng cho server từ xa)',
  sse: 'HTTP+SSE (server cũ)',
};

/**
 * Id server đi thẳng vào tên tool (`mcp__<id>__<tool>`) nên phải khớp tập ký
 * tự mà gateway chấp nhận. Validate ở đây để người dùng thấy lỗi ngay, trước
 * khi main từ chối bằng một thông báo IPC khó đọc.
 */
const SERVER_ID_RE = /^[A-Za-z0-9_-]+$/;

const inputClass =
  'w-full rounded-none border border-border-hairline bg-bg-deep px-2.5 py-1.5 text-xs text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-steel';

function StatusBadge({ status }: { status: VyenMcpServerState }) {
  const map: Record<VyenMcpServerState, { label: string; className: string }> = {
    connected: { label: 'Đã kết nối', className: 'border border-status-success/30 bg-[#5db87a]/15 text-status-success' },
    connecting: { label: 'Đang kết nối', className: 'border border-status-warning/30 bg-[#e8993a]/15 text-status-warning' },
    disconnected: { label: 'Chưa kết nối', className: 'border border-border-hairline/40 bg-panel-bg text-text-muted' },
    error: { label: 'Lỗi', className: 'border border-status-error/30 bg-[#e8704f]/15 text-status-error' },
  };
  const item = map[status] ?? map.disconnected;
  return (
    <span className={`rounded-none px-1.5 py-0.5 text-[10px] font-medium ${item.className}`}>
      {item.label}
    </span>
  );
}

export function McpSettingsPanel() {
  const [available] = useState(() => isMcpAvailable());
  const [servers, setServers] = useState<VyenMcpServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [transport, setTransport] = useState<Transport>('stdio');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [env, setEnv] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [timeoutSecs, setTimeoutSecs] = useState('');
  const [autoApprove, setAutoApprove] = useState('');
  const [availableTools, setAvailableTools] = useState('');
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    if (!available) {
      setLoading(false);
      return;
    }
    setServers(await listMcpServers());
    setLoading(false);
  }, [available]);

  useEffect(() => {
    void refresh();
    if (!available) return;
    /* Trạng thái server thay đổi ở main (reconnect, mất kết nối) — nạp lại
       để danh sách không lừa người dùng bằng dữ liệu cũ. */
    return onMcpServerStatus(() => {
      void refresh();
    });
  }, [available, refresh]);

  /**
   * Parse "MỖI DÒNG MỘT CẶP" thành record.
   * Dùng cho cả env (`KEY=value`) và header HTTP (`Name: value`).
   */
  function parsePairs(
    text: string,
    separator: '=' | ':',
    onBadLine: (line: string) => void,
  ): Record<string, string> | null {
    const out: Record<string, string> = {};
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const at = line.indexOf(separator);
      const key = at > 0 ? line.slice(0, at).trim() : '';
      const value = at > 0 ? line.slice(at + 1).trim() : '';
      if (!key || !value) {
        onBadLine(line);
        return null;
      }
      out[key] = value;
    }
    return out;
  }

  /** Gom form thành config đúng schema của main; trả null khi chưa hợp lệ. */
  function buildConfig(): VyenMcpServerConfig | null {
    const trimmedId = id.trim();
    if (!SERVER_ID_RE.test(trimmedId)) {
      setError('Id server chỉ được chứa chữ, số, gạch ngang và gạch dưới (ví dụ: filesystem).');
      return null;
    }
    if (!name.trim()) {
      setError('Cần một tên để hiển thị.');
      return null;
    }
    if (servers.some((s) => s.id === trimmedId)) {
      setError(`Id "${trimmedId}" đã được dùng.`);
      return null;
    }

    const approve = autoApprove
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);

    const whitelist = availableTools
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);

    /* Timeout tuỳ chọn. Để trống → manager dùng mặc định 60s.
       Sai định dạng là lỗi NHÌN THẤY ĐƯỢC, không được phép âm thầm bỏ qua. */
    let timeout: number | undefined;
    if (timeoutSecs.trim()) {
      timeout = Number(timeoutSecs.trim());
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
        setError('Timeout phải là số nguyên từ 1 đến 600 giây.');
        return null;
      }
    }

    if (transport === 'stdio') {
      if (!command.trim()) {
        setError('Cần lệnh để chạy server (ví dụ: npx).');
        return null;
      }
      /* Env: đa số server thật cần khoá API (GitHub, Brave…). Chỉ gửi những
         gì người dùng KHAI BÁO — phần còn lại lấy từ tập an toàn của SDK. */
      const envRecord = parsePairs(env, '=', (line) =>
        setError(`Dòng biến môi trường không hợp lệ: "${line}" (cần dạng KEY=value).`),
      );
      if (!envRecord) return null;

      return {
        id: trimmedId,
        name: name.trim(),
        transport: 'stdio',
        command: command.trim(),
        args: args.split(/\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 50),
        autoApprove: approve,
        ...(whitelist.length > 0 ? { availableTools: whitelist } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        ...(Object.keys(envRecord).length > 0 ? { env: envRecord } : {}),
        ...(timeout !== undefined ? { timeoutSecs: timeout } : {}),
      };
    }

    if (!url.trim()) {
      setError('Cần URL của server MCP.');
      return null;
    }
    try {
      new URL(url.trim());
    } catch {
      setError('URL không hợp lệ — cần đầy đủ giao thức (ví dụ: https://…).');
      return null;
    }
    /* Header: server từ xa hầu như luôn cần Authorization. */
    const headerRecord = parsePairs(headers, ':', (line) =>
      setError(`Dòng header không hợp lệ: "${line}" (cần dạng Name: value).`),
    );
    if (!headerRecord) return null;

    return {
      id: trimmedId,
      name: name.trim(),
      transport,
      url: url.trim(),
      autoApprove: approve,
      ...(whitelist.length > 0 ? { availableTools: whitelist } : {}),
      ...(Object.keys(headerRecord).length > 0 ? { headers: headerRecord } : {}),
      ...(timeout !== undefined ? { timeoutSecs: timeout } : {}),
    };
  }

  const add = async () => {
    setError(null);
    const config = buildConfig();
    if (!config) return;

    setAdding(true);
    try {
      await addMcpServer(config);
      setId('');
      setName('');
      setCommand('');
      setArgs('');
      setCwd('');
      setEnv('');
      setUrl('');
      setHeaders('');
      setTimeoutSecs('');
      setAutoApprove('');
      await refresh();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (serverId: string) => {
    setError(null);
    setBusyId(serverId);
    try {
      await removeMcpServer(serverId);
      await refresh();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusyId(null);
    }
  };

  const retry = async (serverId: string) => {
    setError(null);
    setBusyId(serverId);
    try {
      await reconnectMcpServer(serverId);
      await refresh();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusyId(null);
    }
  };

  /** Đổi chế độ expose — không reconnect: chỉ cách tool vào ngữ cảnh model. */
  const toggleExpose = async (serverId: string, next: 'full' | 'proxy') => {
    setError(null);
    setBusyId(serverId);
    try {
      await setMcpExposeMode(serverId, next);
      await refresh();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusyId(null);
    }
  };

  if (!available) {
    return (
      <div className="space-y-2 border-l-2 border-border-hairline pl-3 font-mono">
        <h3 className="text-sm font-semibold text-text-primary">MCP server</h3>
        <p className="text-[11px] leading-relaxed text-text-muted">
          MCP chỉ chạy trong <span className="font-medium text-text-primary">Vyen desktop</span> (Electron) — nơi app
          có thể chạy lệnh và giữ kết nối tới server MCP. Trên trình duyệt không có mặt phẳng đó.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-l-2 border-border-hairline pl-3 font-mono">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">MCP server</h3>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-none border border-border-hairline bg-surface-raised px-2 py-1 text-[11px] text-text-primary hover:bg-panel-bg"
        >
          Làm mới
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-text-muted">
        Mỗi server cung cấp thêm công cụ cho agent. Mặc định mọi lần gọi đều phải duyệt — liệt kê
        vào &ldquo;Tự duyệt&rdquo; (cách nhau bởi dấu phẩy, <code>*</code> = tất cả) để bỏ qua bước
        đó với những công cụ bạn tin.
      </p>

      {/* ---- Danh sách server ---- */}
      {loading ? (
        <p className="flex items-center gap-2 text-[11px] text-text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang nạp…
        </p>
      ) : servers.length === 0 ? (
        <p className="text-[11px] text-text-muted">Chưa có server nào.</p>
      ) : (
        <ul className="space-y-2">
          {servers.map((server) => (
            <li
              key={server.id}
              className="rounded-none border border-border-hairline bg-surface-raised px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Server className="h-3.5 w-3.5 flex-shrink-0 text-[#757d89]" />
                    <span className="truncate text-xs font-medium text-text-primary">
                      {server.name}
                    </span>
                    <StatusBadge status={server.status} />
                    <span className="text-[10px] text-[#757d89]">{server.toolCount} công cụ</span>
                  </div>
                  <div className="mt-1 space-y-0.5">
                    <p className="truncate text-[10px] text-text-muted">
                      <code>{server.id}</code>
                      {server.serverVersion ? ` · ${server.serverVersion}` : ''}
                    </p>
                    {server.error && (
                      <p className="flex items-start gap-1 text-[10px] text-status-error">
                        <TriangleAlert className="mt-0.5 h-3 w-3 flex-shrink-0" />
                        <span className="min-w-0 break-words">{server.error}</span>
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex flex-shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      void toggleExpose(server.id, server.exposeMode === 'proxy' ? 'full' : 'proxy')
                    }
                    disabled={busyId === server.id}
                    title={
                      server.exposeMode === 'proxy'
                        ? 'Chế độ proxy: model tìm tool qua mcp__search thay vì nhận toàn bộ schema. Bấm để trả về chế độ đầy đủ.'
                        : 'Bật chế độ proxy: schema không nằm trong ngữ cảnh mỗi request — model tìm tool qua mcp__search (thêm một lượt gọi trung gian).'
                    }
                    className={`rounded-none px-1.5 py-0.5 text-[10px] font-medium disabled:opacity-50 ${
                      server.exposeMode === 'proxy'
                        ? 'bg-[#6a9fcc] text-[#0d1116] font-semibold'
                        : 'border border-border-hairline bg-panel-bg text-text-muted hover:bg-panel-soft'
                    }`}
                  >
                    {server.exposeMode === 'proxy' ? 'proxy' : 'đầy đủ'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void retry(server.id)}
                    disabled={busyId === server.id}
                    title="Kết nối lại"
                    className="rounded-none border border-border-hairline bg-panel-bg p-1 text-text-primary hover:bg-panel-soft disabled:opacity-50"
                  >
                    {busyId === server.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(server.id)}
                    disabled={busyId === server.id}
                    title="Xoá server"
                    className="rounded-none border border-border-hairline bg-panel-bg p-1 text-status-error hover:bg-[#e8704f]/10 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* ---- Thêm server ---- */}
      <div className="space-y-2 rounded-none border border-border-hairline bg-surface-raised px-3 py-2.5">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-text-muted">Id</span>
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="filesystem"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-text-muted">Tên hiển thị</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Máy local"
              className={inputClass}
            />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-text-muted">Kiểu kết nối</span>
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as Transport)}
            className={inputClass}
          >
            {(Object.keys(TRANSPORT_LABELS) as Transport[]).map((t) => (
              <option key={t} value={t}>
                {TRANSPORT_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        {transport === 'stdio' ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-text-muted">Lệnh</span>
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-text-muted">
                  Tham số (cách nhau bởi dấu cách)
                </span>
                <input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-filesystem C:/Users"
                  className={inputClass}
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-text-muted">
                Thư mục làm việc (tuỳ chọn)
              </span>
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="C:/Users/ban/project"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-text-muted">
                Biến môi trường (mỗi dòng một KEY=value)
              </span>
              <textarea
                value={env}
                onChange={(e) => setEnv(e.target.value)}
                rows={2}
                placeholder={'GITHUB_TOKEN=ghp_xxx\nBRAVE_API_KEY=yyy'}
                className={`${inputClass} resize-y font-mono text-[11px]`}
              />
              <span className="mt-1 block text-[10px] text-[#757d89]">
                Chỉ những gì bạn khai báo ở đây được truyền cho server — Vyen không tự động chia
                sẻ biến môi trường của máy.
              </span>
            </label>
          </>
        ) : (
          <>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-text-muted">URL</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.example.com/mcp"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-text-muted">
                Header (mỗi dòng một Name: value)
              </span>
              <textarea
                value={headers}
                onChange={(e) => setHeaders(e.target.value)}
                rows={2}
                placeholder="Authorization: Bearer abc123"
                className={`${inputClass} resize-y font-mono text-[11px]`}
              />
            </label>
          </>
        )}

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-text-muted">
            Timeout mỗi lần gọi (giây, mặc định 60)
          </span>
          <input
            value={timeoutSecs}
            onChange={(e) => setTimeoutSecs(e.target.value)}
            placeholder="60"
            inputMode="numeric"
            className={`${inputClass} max-w-[8rem]`}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-text-muted">
            Tự duyệt (tuỳ chọn)
          </span>
          <input
            value={autoApprove}
            onChange={(e) => setAutoApprove(e.target.value)}
            placeholder="read_*, list_*"
            className={inputClass}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-text-muted">
            Danh sách tool cho phép (available_tools whitelist, tuỳ chọn)
          </span>
          <input
            value={availableTools}
            onChange={(e) => setAvailableTools(e.target.value)}
            placeholder="read_file, list_dir (để trống = cho phép tất cả tool)"
            className={inputClass}
          />
          <span className="mt-1 block text-[10px] text-[#757d89]">
            available_tools: chỉ nạp các tool trong danh sách này để giảm bớt token và giới hạn phạm vi.
          </span>
        </label>

        {error && (
          <p className="border border-status-error/30 bg-[#e8704f]/10 px-2.5 py-1.5 text-[11px] text-status-error">{error}</p>
        )}

        <button
          type="button"
          onClick={() => void add()}
          disabled={adding}
          className="btn-primary"
        >
          {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Thêm server
        </button>
      </div>
    </div>
  );
}
