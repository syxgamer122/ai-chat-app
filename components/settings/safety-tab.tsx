'use client';

/**
 * Settings → tab "Quyền & An toàn"
 *
 * Chính sách phê duyệt, auto-pilot, code mode và bảng phân quyền từng công cụ.
 *
 * (Tách ra từ components/settings-dialog.tsx.)
 *
 * Không nhận prop: tự đọc `useAppStore` như các section khác trong
 * components/settings/ — tránh luồn chục prop qua nhiều tầng chỉ để lấy `settings`.
 */

import { Zap, ShieldCheck } from 'lucide-react';
import React, { useState } from 'react';
import dynamic from 'next/dynamic';
import { useAppStore } from '@/lib/store';
import { SectionLoading } from '@/components/settings/section-loading';

const ToolPermissionsTable = dynamic(() => import('@/components/tool-permissions-table').then((m) => m.ToolPermissionsTable), { ssr: false, loading: SectionLoading });
const AuditViewerDialog = dynamic(() => import('@/components/audit-viewer-dialog').then((m) => m.AuditViewerDialog), { ssr: false });
const McpToolGrantsPanel = dynamic(() => import('@/components/mcp/tool-grants-panel').then((m) => m.McpToolGrantsPanel), { ssr: false, loading: SectionLoading });

export function SafetyTab() {
  const [isAuditViewerOpen, setIsAuditViewerOpen] = useState(false);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  return (
    <>
      <div className="border-b border-border-hairline pb-2">
        <h3 className="text-sm font-semibold text-text-primary">Quyền &amp; An toàn</h3>
        <p className="mt-0.5 text-[11px] text-text-muted">
          Kiểm soát mức độ tự chủ của Agent, chính sách phê duyệt và giới hạn công cụ.
        </p>
      </div>

      {/* Chế độ phê duyệt chính */}
      <div className="border border-border-hairline bg-surface-raised p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <Zap size={14} className="text-status-warning" />
          <label htmlFor="approval-policy" className="text-xs font-semibold text-text-primary">
            Chế độ phê duyệt (Approval Policy)
          </label>
        </div>
        <select
          id="approval-policy"
          value={settings.approvalPolicy ?? (settings.autoPilot ? 'smart' : 'always')}
          onChange={(e) => {
            const policy = e.target.value as 'always' | 'smart' | 'never' | 'chat_only';
            updateSettings({ approvalPolicy: policy });
          }}
          className="field w-full text-xs"
        >
          <option value="smart">Smart (Thông minh — mặc định) — tự duyệt đọc & safe shell, hỏi khi ghi/destructive</option>
          <option value="never">Autonomous (Tự chủ / YOLO) — tự duyệt tất cả trừ lệnh cấm</option>
          <option value="always">Manual (Thủ công) — luôn hỏi phê duyệt trước khi chạy bất kỳ tool nào</option>
          <option value="chat_only">Chat Only (Chỉ chat) — vô hiệu hoàn toàn toàn bộ công cụ (kể cả fs_read)</option>
        </select>
        <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">
          {(settings.approvalPolicy ?? 'smart') === 'smart' &&
            '✅ Read-only tools và safe commands (npm test, git status...) tự động duyệt. Write/destructive vẫn hỏi.'}
          {(settings.approvalPolicy ?? 'smart') === 'never' &&
            '⚡ Tất cả tool calls tự động duyệt TRỪ lệnh luôn-chặn (rm -rf /, mkfs, shutdown...). Khuyên dùng kèm Staging Sandbox.'}
          {(settings.approvalPolicy ?? 'smart') === 'always' &&
            '🔒 Luôn hỏi trước khi chạy bất kỳ tool nào. Tương đương Manual mode.'}
          {(settings.approvalPolicy ?? 'smart') === 'chat_only' &&
            '💬 Vô hiệu hoàn toàn tất cả công cụ (kể cả fs_read). AI chỉ trả lời bằng kiến thức văn bản.'}
        </p>
      </div>

      {/* Staging sandbox */}
      {settings.approvalPolicy !== 'chat_only' && (
        <label
          htmlFor="staging-sandbox-toggle"
          className="flex items-start justify-between gap-3 border-l-2 border-border-hairline pl-3 cursor-pointer"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-text-primary">
              Staging Sandbox (review batch trước khi ghi đĩa)
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-text-muted">
              Agent ghi thay đổi vào bộ đệm thay vì đĩa. Bạn review toàn bộ diff rồi bấm Apply để ghi thật hoặc Reject để hủy.
            </span>
          </span>
          <input
            id="staging-sandbox-toggle"
            type="checkbox"
            checked={settings.stagingSandbox ?? true}
            onChange={(e) => updateSettings({ stagingSandbox: e.target.checked })}
            className="mt-0.5 h-4 w-4 flex-shrink-0 rounded-none accent-[#6a9fcc]"
          />
        </label>
      )}

      {/* Bảng phân quyền chi tiết per-tool (thu gọn mặc định) */}
      {settings.approvalPolicy !== 'chat_only' && (
        <details className="border border-border-hairline bg-surface-raised">
          <summary className="flex cursor-pointer items-center justify-between p-3 text-xs font-semibold text-text-primary hover:bg-panel-bg/60">
            <span>Bảng phân quyền chi tiết từng công cụ (Per-Tool Permissions)</span>
            <span className="text-[10px] text-[#757d89]">bấm để mở rộng</span>
          </summary>
          <div className="border-t border-border-hairline p-3">
            <p className="mb-2 text-[11px] text-text-muted">
              Cấu hình quyền Tự duyệt (auto), Luôn hỏi (ask) hoặc Chặn (deny) cho từng tool độc lập.
            </p>
            <ToolPermissionsTable />
          </div>
        </details>
      )}

      {/* Nhật ký kiểm toán an toàn (Tamper-Evident Audit Log) */}
      <div className="border border-border-hairline bg-surface-raised p-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <ShieldCheck size={14} className="text-status-success" />
            <span className="text-xs font-semibold text-text-primary">
              Nhật ký kiểm toán an toàn (Tamper-Evident Audit Log)
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-text-muted">
            Xem lịch sử phê duyệt, can thiệp đĩa và lệnh shell gắn chuỗi băm SHA-256 đối soát với anchor đĩa.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIsAuditViewerOpen(true)}
          className="btn-secondary text-xs px-3 py-1.5 shrink-0"
        >
          Mở Nhật ký Kiểm toán
        </button>
      </div>

      <AuditViewerDialog
        isOpen={isAuditViewerOpen}
        onClose={() => setIsAuditViewerOpen(false)}
      />

      {/* Quản trị cấp quyền MCP động */}
      {settings.approvalPolicy !== 'chat_only' && <McpToolGrantsPanel />}

      {/* Code Mode */}
      {settings.approvalPolicy !== 'chat_only' && (
        <div className="border border-border-hairline bg-surface-raised p-3">
          <label htmlFor="code-mode-toggle" className="flex items-start justify-between gap-3 cursor-pointer">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-text-primary">
                Code Mode (Thực thi JS gọi MCP on-demand)
              </span>
              <span className="mt-0.5 block text-xs text-text-muted">
                Cung cấp công cụ <code className="claude-inline-code">run_code</code> cho phép model viết script JavaScript thực thi trong Node bridge để gọi công cụ MCP mà không cần nạp từng tool riêng lẻ vào context.
              </span>
            </span>
            <input
              id="code-mode-toggle"
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded-none accent-[#6a9fcc]"
              checked={settings.codeModeEnabled ?? false}
              onChange={(e) => updateSettings({ codeModeEnabled: e.target.checked })}
            />
          </label>
        </div>
      )}

      {/* Đường tool giả lập */}
      {settings.approvalPolicy !== 'chat_only' && (
        <label
          htmlFor="force-emulated-tools"
          className="flex items-start justify-between gap-3 border-l-2 border-border-hairline pl-3 cursor-pointer"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-text-primary">
              Đường tool giả lập (provider không hỗ trợ function calling)
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-text-muted">
              Bật khi model cố gọi công cụ nhưng JSON rò rỉ ra văn bản câu trả lời (gateway bỏ qua tham số tools).
            </span>
          </span>
          <input
            id="force-emulated-tools"
            type="checkbox"
            checked={settings.forceEmulatedTools ?? false}
            onChange={(e) => updateSettings({ forceEmulatedTools: e.target.checked })}
            className="mt-0.5 h-4 w-4 flex-shrink-0 rounded-none accent-[#6a9fcc]"
          />
        </label>
      )}
    </>
  );
}
