'use client';

/**
 * Quản lý MCP server trong Cài đặt.
 *
 * MCP chỉ tồn tại trong Koda desktop: client MCP sống trong Electron main
 * (nơi spawn được process con và giữ kết nối HTTP), renderer chỉ nói chuyện
 * qua IPC. Trên web component này tự thu mình lại thành một dòng giải thích
 * thay vì giả vờ có tính năng.
 *
 * Cấu hình được lưu ở Electron userData (koda-mcp-configs.json) — MỘT nguồn
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
} from '@/lib/mcp/bridge';
import type {
  KodaMcpServerConfig,
  KodaMcpServerState,
  KodaMcpServerStatus,
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
  'w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-brand';

function StatusBadge({ status }: { status: KodaMcpServerState }) {
  const map: Record<KodaMcpServerState, { label: string; className: string }> = {
    connected: { label: 'Đã kết nối', className: 'bg-emerald-100 text-emerald-700' },
    connecting: { label: 'Đang kết nối', className: 'bg-amber-100 text-amber-700' },
    disconnected: { label: 'Chưa kết nối', className: 'bg-zinc-100 text-zinc-600' },
    error: { label: 'Lỗi', className: 'bg-red-100 text-red-700' },
  };
  const item = map[status] ?? map.disconnected;
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${item.className}`}>
      {item.label}
    </span>
  );
}

export function McpSettingsPanel() {
  const [available] = useState(() => isMcpAvailable());
  const [servers, setServers] = useState<KodaMcpServerStatus[]>([]);
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
  function buildConfig(): KodaMcpServerConfig | null {
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

  if (!available) {
    return (
      <div className="space-y-2 border-l-2 border-zinc-200 pl-3">
        <h3 className="text-sm font-semibold text-zinc-700">MCP server</h3>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          MCP chỉ chạy trong <span className="font-medium">Koda desktop</span> (Electron) — nơi app
          có thể chạy lệnh và giữ kết nối tới server MCP. Trên trình duyệt không có mặt phẳng đó.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-l-2 border-zinc-200 pl-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-700">MCP server</h3>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-lg border border-zinc-300 px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-50"
        >
          Làm mới
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Mỗi server cung cấp thêm công cụ cho agent. Mặc định mọi lần gọi đều phải duyệt — liệt kê
        vào &ldquo;Tự duyệt&rdquo; (cách nhau bởi dấu phẩy, <code>*</code> = tất cả) để bỏ qua bước
        đó với những công cụ bạn tin.
      </p>

      {/* ---- Danh sách server ---- */}
      {loading ? (
        <p className="flex items-center gap-2 text-[11px] text-zinc-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Đang nạp…
        </p>
      ) : servers.length === 0 ? (
        <p className="text-[11px] text-zinc-500">Chưa có server nào.</p>
      ) : (
        <ul className="space-y-2">
          {servers.map((server) => (
            <li
              key={server.id}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Server className="h-3.5 w-3.5 flex-shrink-0 text-zinc-400" />
                    <span className="truncate text-xs font-medium text-zinc-800">
                      {server.name}
                    </span>
                    <StatusBadge status={server.status} />
                    <span className="text-[10px] text-zinc-400">{server.toolCount} công cụ</span>
                  </div>
                  <div className="mt-1 space-y-0.5">
                    <p className="truncate text-[10px] text-zinc-500">
                      <code>{server.id}</code>
                      {server.serverVersion ? ` · ${server.serverVersion}` : ''}
                    </p>
                    {server.error && (
                      <p className="flex items-start gap-1 text-[10px] text-red-600">
                        <TriangleAlert className="mt-0.5 h-3 w-3 flex-shrink-0" />
                        <span className="min-w-0 break-words">{server.error}</span>
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex flex-shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void retry(server.id)}
                    disabled={busyId === server.id}
                    title="Kết nối lại"
                    className="rounded-lg border border-zinc-300 p-1 text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
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
                    className="rounded-lg border border-zinc-300 p-1 text-red-600 hover:bg-red-50 disabled:opacity-50"
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
      <div className="space-y-2 rounded-lg bg-zinc-50 px-3 py-2.5">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-zinc-600">Id</span>
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="filesystem"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-zinc-600">Tên hiển thị</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Máy local"
              className={inputClass}
            />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-zinc-600">Kiểu kết nối</span>
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
                <span className="mb-1 block text-[11px] font-medium text-zinc-600">Lệnh</span>
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-zinc-600">
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
              <span className="mb-1 block text-[11px] font-medium text-zinc-600">
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
              <span className="mb-1 block text-[11px] font-medium text-zinc-600">
                Biến môi trường (mỗi dòng một KEY=value)
              </span>
              <textarea
                value={env}
                onChange={(e) => setEnv(e.target.value)}
                rows={2}
                placeholder={'GITHUB_TOKEN=ghp_xxx\nBRAVE_API_KEY=yyy'}
                className={`${inputClass} resize-y font-mono text-[11px]`}
              />
              <span className="mt-1 block text-[10px] text-zinc-500">
                Chỉ những gì bạn khai báo ở đây được truyền cho server — Koda không tự động chia
                sẻ biến môi trường của máy.
              </span>
            </label>
          </>
        ) : (
          <>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-zinc-600">URL</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.example.com/mcp"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-zinc-600">
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
          <span className="mb-1 block text-[11px] font-medium text-zinc-600">
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
          <span className="mb-1 block text-[11px] font-medium text-zinc-600">
            Tự duyệt (tuỳ chọn)
          </span>
          <input
            value={autoApprove}
            onChange={(e) => setAutoApprove(e.target.value)}
            placeholder="read_*, list_*"
            className={inputClass}
          />
        </label>

        {error && (
          <p className="rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">{error}</p>
        )}

        <button
          type="button"
          onClick={() => void add()}
          disabled={adding}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Thêm server
        </button>
      </div>
    </div>
  );
}
