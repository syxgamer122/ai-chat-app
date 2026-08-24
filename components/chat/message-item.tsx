/*
 * Hàng tin nhắn (user/assistant) — memoized, hỗ trợ edit/branch/attachment.
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from 'ai/react';
import TextareaAutosize from 'react-textarea-autosize';
import { RefreshCcw, Paperclip, Pencil, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { ErrorBoundary } from '@/components/error-boundary';
import { BranchSwitcher } from '@/components/branch-switcher';
import { MessageStatusBadge } from '@/components/message-status-badge';
import { sanitizeContent, getFinishInfo } from '@/lib/chat-tree-persistence';

/* ------------------------------------------------------------------ */
/* Memoized Message Item                                              */
/* ------------------------------------------------------------------ */
export interface BranchInfo {
  /**
   * Index zero-based của message hiện tại trong nhóm siblings.
   */
  currentIndex: number;

  /**
   * Tổng số siblings.
   */
  total: number;
}

interface MessageItemProps {
  m: Message;

  /**
   * Thông tin branch của message đang hiển thị.
   * undefined nếu message không có siblings.
   */
  branchInfo?: BranchInfo;

  isStreaming: boolean;
  isEditing: boolean;
  isCopied: boolean;
  draft: string;
  isTouchDevice: boolean;
  sendOnEnter: boolean;
  throttleMs: number;

  onCopy: (m: Message) => void;
  onRegenerate: (id: string) => void;
  onSwitchBranch: (
    messageId: string,
    direction: 'previous' | 'next',
  ) => void;
  onStartEdit: (m: Message) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onDraftChange: (text: string) => void;
  onContinueGenerating?: () => void;
  onContentResize?: () => void;
}

export const MessageItem = memo(
  function MessageItem({
    m,
    branchInfo,
    isStreaming,
    isEditing,
    isCopied,
    draft,
    isTouchDevice,
    sendOnEnter,
    throttleMs,
    onCopy,
    onRegenerate,
    onSwitchBranch,
    onStartEdit,
    onSaveEdit,
    onCancelEdit,
    onDraftChange,
    onContinueGenerating,
    onContentResize,
  }: MessageItemProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const isLongUserMsg = m.role === 'user' && m.content.length > 250;

    if (m.role === 'user') {
      return (
        <div className="group flex w-full justify-end px-2 md:px-4">
          <div className="flex max-w-[85%] md:max-w-[75%] flex-col items-end gap-1">
            {/* File Attachments */}
            {m.experimental_attachments && m.experimental_attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-2 justify-end">
                {m.experimental_attachments.map((att, idx) => (
                  <div key={idx} className="relative overflow-hidden rounded-lg border border-zinc-300/60 bg-zinc-200/60">
                    {att.contentType?.startsWith('image/') ? (
                      <img
                        src={att.url}
                        alt={att.name ?? 'attachment'}
                        className="max-h-48 max-w-xs object-cover rounded-md"
                        loading="eager"
                        decoding="async"
                        onLoad={onContentResize}
                        onError={onContentResize}
                      />
                    ) : (
                      <div className="flex items-center gap-2 p-2 text-xs text-zinc-600">
                        <Paperclip className="h-3.5 w-3.5 text-zinc-500" />
                        <span className="truncate max-w-[150px]">{att.name}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Nội dung tin nhắn / Chỉnh sửa */}
            {isEditing ? (
              <div className="flex w-full min-w-[260px] flex-col gap-2 rounded-2xl border border-zinc-300 bg-surface-raised p-3 shadow-panel">
                <TextareaAutosize
                  value={draft}
                  onChange={(e) => onDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (sendOnEnter && e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      onSaveEdit(m.id);
                    }
                    if (e.key === 'Escape') onCancelEdit();
                  }}
                  aria-label="Sửa nội dung tin nhắn"
                  className="w-full resize-none bg-transparent text-sm text-zinc-800 outline-none placeholder:text-zinc-400"
                  autoFocus
                />
                <div className="flex justify-end gap-2 border-t border-zinc-200 pt-1 text-xs">
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    className="rounded-lg px-2.5 py-1 text-zinc-600 transition-colors hover:bg-zinc-100"
                  >
                    Hủy
                  </button>
                  <button
                    type="button"
                    onClick={() => onSaveEdit(m.id)}
                    className="rounded-lg bg-brand px-3 py-1 font-medium text-white shadow-sm transition-colors hover:bg-brand-hover"
                  >
                    Lưu &amp; Gửi lại
                  </button>
                </div>
              </div>
            ) : (
              <div className="relative rounded-2xl rounded-br-md border border-brand-border/70 bg-surface-bubble px-4 py-2.5 text-[15px] leading-relaxed text-zinc-800 shadow-sm">
                <div
                  className={`claude-prose claude-prose-bubble ${
                    isLongUserMsg && !isExpanded ? 'relative max-h-36 overflow-hidden' : ''
                  }`}
                >
                  <ErrorBoundary>
                    <MarkdownRenderer
                      content={sanitizeContent(m.content)}
                      isStreaming={isStreaming}
                      throttleMs={throttleMs}
                    />
                  </ErrorBoundary>

                  {isLongUserMsg && !isExpanded && (
                    <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-surface-bubble via-surface-bubble/80 to-transparent" />
                  )}
                </div>

                {isLongUserMsg && (
                  <button
                    type="button"
                    onClick={() => setIsExpanded((prev) => !prev)}
                    aria-expanded={isExpanded}
                    className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-zinc-600 transition-colors hover:text-zinc-900"
                  >
                    {isExpanded ? (
                      <>
                        <ChevronUp size={13} />
                        <span>Thu gọn</span>
                      </>
                    ) : (
                      <>
                        <ChevronDown size={13} />
                        <span>Xem toàn bộ ({m.content.length.toLocaleString('vi-VN')} ký tự)</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            )}

            {/* Action bar + Branch switcher */}
            {!isEditing && (
              <div className="msg-actions mt-1 flex items-center gap-1 text-xs">
                {branchInfo && (
                  <BranchSwitcher
                    currentIndex={branchInfo.currentIndex}
                    total={branchInfo.total}
                    isTouchDevice={isTouchDevice}
                    disabled={isStreaming}
                    onPrevious={() => onSwitchBranch(m.id, 'previous')}
                    onNext={() => onSwitchBranch(m.id, 'next')}
                  />
                )}
                <button
                  type="button"
                  onClick={() => onCopy(m)}
                  aria-label="Sao chép tin nhắn"
                  title="Sao chép"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-800"
                >
                  {isCopied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => onStartEdit(m)}
                  aria-label="Chỉnh sửa tin nhắn"
                  title="Chỉnh sửa"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-800"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }

    /* ---------- ASSISTANT ---------- */
    return (
      <div className="group flex w-full items-start gap-3 px-2 md:px-4">
        <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 select-none items-center justify-center rounded-full bg-brand text-[11px] font-semibold text-white shadow-sm">
          AI
        </div>

        <div className="min-w-0 flex-1">
          {/* File Attachments */}
          {m.experimental_attachments && m.experimental_attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {m.experimental_attachments.map((att, idx) => (
                <div key={idx} className="relative overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100/60">
                  {att.contentType?.startsWith('image/') ? (
                    <img
                      src={att.url}
                      alt={att.name ?? 'attachment'}
                      className="max-h-48 max-w-xs object-cover rounded-md"
                      loading="eager"
                      decoding="async"
                      onLoad={onContentResize}
                      onError={onContentResize}
                    />
                  ) : (
                    <div className="flex items-center gap-2 p-2 text-xs text-zinc-600">
                      <Paperclip className="h-3.5 w-3.5 text-zinc-500" />
                      <span className="truncate max-w-[150px]">{att.name}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Tiến trình tạo ảnh/video (route ghi vào kênh reasoning). Chỉ hiện
              lúc đang stream — media mất vài phút nên cần dấu hiệu còn sống. */}
          {isStreaming && typeof (m as any).reasoning === 'string' && (m as any).reasoning.trim() && (
            <p role="status" className="mb-2 flex items-center gap-1.5 text-[12px] text-zinc-600">
              <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-brand" />
              <span className="truncate">
                {(m as any).reasoning.trim().split('\n').filter(Boolean).slice(-1)[0]}
              </span>
            </p>
          )}

          <div
            className={`claude-prose ${isStreaming ? 'streaming-caret' : ''}`}
            aria-busy={isStreaming}
          >
            <ErrorBoundary>
              <MarkdownRenderer
                content={sanitizeContent(m.content)}
                isStreaming={isStreaming}
                throttleMs={throttleMs}
              />
            </ErrorBoundary>
          </div>

          {(() => {
            const { truncated, message: note } = getFinishInfo(m);
            if (!truncated || isStreaming) return null;
            return (
              <div className="notice-warn mt-2.5 flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">{note ?? 'Câu trả lời có thể chưa hoàn chỉnh do đạt giới hạn token.'}</span>
                {onContinueGenerating && (
                  <button
                    type="button"
                    onClick={onContinueGenerating}
                    className="flex-shrink-0 rounded-lg bg-amber-600 px-2.5 py-1 font-medium text-white shadow-sm transition-colors hover:bg-amber-700"
                  >
                    Viết tiếp
                  </button>
                )}
              </div>
            );
          })()}

          {m.role === 'assistant' && (m as any).status === 'aborted' && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 pt-2">
              <div className="flex items-center gap-1.5">
                <MessageStatusBadge status="aborted" />
                <span className="text-[11px] text-zinc-500">· Bạn có thể tạo lại để sinh câu trả lời mới</span>
              </div>
              <button
                type="button"
                onClick={() => onRegenerate(m.id)}
                className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-100"
              >
                <RefreshCcw size={12} />
                <span>Tạo nhánh mới</span>
              </button>
            </div>
          )}

          {/* Action toolbar + Branch switcher */}
          {!isStreaming && (
            <div className="msg-actions mt-2 flex items-center gap-1 text-xs">
              <button
                type="button"
                onClick={() => onCopy(m)}
                aria-label="Sao chép câu trả lời"
                title="Sao chép"
                className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-800"
              >
                {isCopied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => onRegenerate(m.id)}
                aria-label="Tạo lại câu trả lời"
                title="Tạo lại câu trả lời"
                className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-800"
              >
                <RefreshCcw className="h-3.5 w-3.5" />
              </button>
              {branchInfo && (
                <BranchSwitcher
                  currentIndex={branchInfo.currentIndex}
                  total={branchInfo.total}
                  isTouchDevice={isTouchDevice}
                  disabled={isStreaming}
                  onPrevious={() => onSwitchBranch(m.id, 'previous')}
                  onNext={() => onSwitchBranch(m.id, 'next')}
                />
              )}
            </div>
          )}
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.m.id === next.m.id &&
    prev.m.content === next.m.content &&
    // Model media chưa có content nào trong lúc chạy — tiến trình đi qua
    // `reasoning`, phải so cả field này nếu không dòng trạng thái đứng im.
    (prev.m as any).reasoning === (next.m as any).reasoning &&
    prev.m.role === next.m.role &&
    prev.branchInfo?.currentIndex === next.branchInfo?.currentIndex &&
    prev.branchInfo?.total === next.branchInfo?.total &&
    prev.isStreaming === next.isStreaming &&
    prev.isEditing === next.isEditing &&
    prev.isCopied === next.isCopied &&
    prev.draft === next.draft &&
    prev.isTouchDevice === next.isTouchDevice &&
    prev.sendOnEnter === next.sendOnEnter &&
    prev.throttleMs === next.throttleMs,
);

