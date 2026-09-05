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
  VyenMcpApprovalRequest,
  VyenMcpPermissionDecision,
} from '@/lib/desktop-bridge';

const DECISIONS: Array<{ value: VyenMcpPermissionDecision; label: string; primary?: boolean }> = [
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
  const [queue, setQueue] = useState<VyenMcpApprovalRequest[]>([]);
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

  const decide = async (decision: VyenMcpPermissionDecision) => {
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
        className="pi-frame relative w-full max-w-lg overflow-hidden rounded-none border border-[#495059] bg-[#212730] font-mono text-[#ebe7e4]"
      >
        <span className="pi-corner-tl" />
        <span className="pi-corner-tr" />
        <span className="pi-corner-bl" />
        <span className="pi-corner-br" />

        <div className="flex items-start gap-3 border-b border-[#495059] bg-[#161d27] px-4 py-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-[#e8993a]" />
          <div className="min-w-0">
            <h2 id="mcp-approval-title" className="font-pixel text-[16px] font-semibold text-[#ebe7e4] [image-rendering:pixelated]">
              <span className="text-[#6a9fcc] font-bold mr-1">$</span>mcp approval
            </h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-[#9fa4ab]">
              Công cụ này do server bên ngoài cung cấp. Chỉ cho phép nếu bạn tin server này.
            </p>
          </div>
        </div>

        <div className="space-y-3 px-4 py-3">
          <div className="flex items-center gap-2 rounded-none border border-[#495059] bg-[#161b22] px-3 py-2">
            <Terminal className="h-4 w-4 flex-shrink-0 text-[#6a9fcc]" />
            <code className="min-w-0 flex-1 truncate text-xs font-medium text-[#ebe7e4]">
              {current.toolName}
            </code>
            <span className="flex-shrink-0 rounded-none border border-[#495059] bg-[#212730] px-1.5 py-0.5 text-[10px] text-[#9fa4ab]">
              {current.serverId}
            </span>
          </div>

          <div>
            <div className="mb-1 text-[11px] font-medium text-[#9fa4ab]">Tham số</div>
            <pre className="max-h-48 overflow-auto rounded-none border border-[#495059] bg-[#1c2128] px-3 py-2 text-[11px] leading-relaxed text-[#7ea3c7]">
              {formatArgs(current.arguments)}
            </pre>
          </div>

          {queue.length > 1 && (
            <p className="text-[11px] text-[#9fa4ab]">
              Còn {queue.length - 1} yêu cầu khác đang chờ sau yêu cầu này.
            </p>
          )}

          {error && (
            <p className="rounded-none border border-[#e8704f]/40 bg-[#241313] px-3 py-2 text-[11px] text-[#e8704f]">{error}</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-[#495059] bg-[#1c2128] px-4 py-3">
          {DECISIONS.map((d) => (
            <button
              key={d.value}
              type="button"
              onClick={() => void decide(d.value)}
              className={
                d.primary
                  ? 'rounded-none bg-[#6a9fcc] px-3.5 py-1.5 text-xs font-semibold text-[#0d1116] transition-colors hover:bg-[#89b8e0]'
                  : 'rounded-none border border-[#495059] bg-[#212730] px-3 py-1.5 text-xs font-medium text-[#ebe7e4] transition-colors hover:border-[#757d89] hover:bg-[#252f3d]'
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
