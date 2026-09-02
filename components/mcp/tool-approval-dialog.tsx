'use client';

/**
 * Hộp thoại phê duyệt tool MCP.
 *
 * Tool MCP là mã của BÊN THỨ BA chạy trên máy người dùng, nên mặc định mọi
 * lần gọi đều phải xin phép — trừ khi tool nằm trong danh sách tự duyệt của
 * server (autoApprove) hoặc người dùng đã chọn "Luôn cho phép".
 *
 * Bốn quyết định (giống Goose ACP):
 *   allow_once    — cho phép đúng lần này
 *   always_allow  — cho phép và nhớ mãi (ghi policy xuống đĩa ở main)
 *   deny_once     — từ chối lần này
 *   always_deny   — từ chối và chặn mãi
 *
 * Yêu cầu đến từ Electron main qua event một chiều; component này chỉ là
 * mặt tiền, mọi quyết định đều đi qua IPC để main giải quyết (kể cả khi
 * người dùng không trả lời — main tự từ chối sau 120 giây).
 */

import { useEffect, useState } from 'react';
import { ShieldAlert, Terminal } from 'lucide-react';
import {
  onMcpApprovalRequested,
  onMcpApprovalResolved,
  resolveMcpApproval,
} from '@/lib/mcp/bridge';
import type {
  KodaMcpApprovalRequest,
  KodaMcpPermissionDecision,
} from '@/lib/desktop-bridge';

const DECISIONS: Array<{ value: KodaMcpPermissionDecision; label: string; primary?: boolean }> = [
  { value: 'allow_once', label: 'Cho phép lần này', primary: true },
  { value: 'always_allow', label: 'Luôn cho phép' },
  { value: 'deny_once', label: 'Từ chối lần này' },
  { value: 'always_deny', label: 'Luôn từ chối' },
];

function formatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args ?? {}, null, 2);
  } catch {
    return '(tham số không hiển thị được)';
  }
}

export function McpToolApprovalDialog() {
  const [queue, setQueue] = useState<KodaMcpApprovalRequest[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const offRequested = onMcpApprovalRequested((req) => {
      setQueue((prev) => (prev.some((p) => p.id === req.id) ? prev : [...prev, req]));
    });
    /* Gỡ khỏi hàng đợi khi main kết luận — kể cả khi chính main tự từ chối
       sau timeout, hoặc khi một cửa sổ khác đã trả lời. */
    const offResolved = onMcpApprovalResolved(({ id }) => {
      setQueue((prev) => prev.filter((p) => p.id !== id));
    });
    return () => {
      offRequested();
      offResolved();
    };
  }, []);

  const current = queue[0];
  if (!current) return null;

  const decide = async (decision: KodaMcpPermissionDecision) => {
    setError(null);
    // Lạc quan: bỏ khỏi hàng đợi ngay để modal trống không kẹt lại giữa
    // lượt quyết định nối tiếp nhau.
    setQueue((prev) => prev.filter((p) => p.id !== current.id));
    try {
      await resolveMcpApproval(current.id, decision);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-approval-title"
        className="relative w-full max-w-lg overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-zinc-200 bg-amber-50 px-4 py-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600" />
          <div className="min-w-0">
            <h2 id="mcp-approval-title" className="text-sm font-semibold text-zinc-800">
              MCP server muốn chạy một công cụ
            </h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-600">
              Công cụ này do server bên ngoài cung cấp. Chỉ cho phép nếu bạn tin server này.
            </p>
          </div>
        </div>

        <div className="space-y-3 px-4 py-3">
          <div className="flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2">
            <Terminal className="h-4 w-4 flex-shrink-0 text-zinc-500" />
            <code className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-800">
              {current.toolName}
            </code>
            <span className="flex-shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-600">
              {current.serverId}
            </span>
          </div>

          <div>
            <div className="mb-1 text-[11px] font-medium text-zinc-500">Tham số</div>
            <pre className="max-h-48 overflow-auto rounded-lg bg-zinc-900 px-3 py-2 text-[11px] leading-relaxed text-zinc-100">
              {formatArgs(current.arguments)}
            </pre>
          </div>

          {queue.length > 1 && (
            <p className="text-[11px] text-zinc-500">
              Còn {queue.length - 1} yêu cầu khác đang chờ sau yêu cầu này.
            </p>
          )}

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-[11px] text-red-700">{error}</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-zinc-200 bg-zinc-50 px-4 py-3">
          {DECISIONS.map((d) => (
            <button
              key={d.value}
              type="button"
              onClick={() => void decide(d.value)}
              className={
                d.primary
                  ? 'rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:opacity-90'
                  : 'rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100'
              }
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
