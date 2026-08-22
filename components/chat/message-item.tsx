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
  animations: boolean;

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
    animations,
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
                  <div key={idx} className="relative overflow-hidden rounded-lg border border-zinc-700/60 bg-zinc-800/60">
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
                      <div className="flex items-center gap-2 p-2 text-xs text-zinc-300">
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
              <div className="flex flex-col gap-2 w-full min-w-[260px] bg-[#1e1e22] border border-zinc-700 p-3 rounded-2xl shadow-xl">
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
                  className="w-full resize-none bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                  autoFocus
                />
                <div className="flex justify-end gap-2 text-xs pt-1 border-t border-zinc-800">
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    className="rounded-lg px-2.5 py-1 text-zinc-400 hover:bg-zinc-800"
                  >
                    Hủy
                  </button>
                  <button
                    type="button"
                    onClick={() => onSaveEdit(m.id)}
                    className="rounded-lg bg-[#c96442] hover:bg-[#b5573a] px-3 py-1 font-medium text-white shadow-sm"
                  >
                    Lưu & Gửi lại
                  </button>
                </div>
              </div>
            ) : (
              <div className="relative rounded-2xl bg-[#2b2b30] px-4 py-2.5 text-[15px] leading-relaxed text-zinc-100 shadow-sm">
                <div className={isLongUserMsg && !isExpanded ? 'max-h-36 overflow-hidden relative' : ''}>
                  <ErrorBoundary>
                    <MarkdownRenderer
                      content={sanitizeContent(m.content)}
                      isStreaming={isStreaming}
                      throttleMs={throttleMs}
                    />
                  </ErrorBoundary>

                  {isLongUserMsg && !isExpanded && (
                    <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[#2b2b30] via-[#2b2b30]/80 to-transparent pointer-events-none" />
                  )}
                </div>

                {isLongUserMsg && (
                  <button
                    type="button"
                    onClick={() => setIsExpanded((prev) => !prev)}
                    className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-zinc-400 hover:text-zinc-200"
                  >
                    {isExpanded ? (
                      <>
                        <ChevronUp size={13} />
                        <span>Thu gọn</span>
                      </>
                    ) : (
                      <>
                        <ChevronDown size={13} />
                        <span>Xem toàn bộ ({m.content.length.toLocaleString()} ký tự)</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            )}

            {/* Action bar + Branch switcher */}
            {!isEditing && (
              <div className="mt-1 flex items-center gap-1 text-xs opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
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
                  title="Sao chép"
                  className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  {isCopied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => onStartEdit(m)}
                  title="Chỉnh sửa"
                  className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
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
      <div className="group flex w-full gap-3 items-start px-2 md:px-4">
        <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[#c96442] text-[11px] font-semibold text-white shadow-sm select-none">
          AI
        </div>

        <div className="min-w-0 flex-1">
          {/* File Attachments */}
          {m.experimental_attachments && m.experimental_attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {m.experimental_attachments.map((att, idx) => (
                <div key={idx} className="relative overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60">
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
                    <div className="flex items-center gap-2 p-2 text-xs text-zinc-300">
                      <Paperclip className="h-3.5 w-3.5 text-zinc-500" />
                      <span className="truncate max-w-[150px]">{att.name}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
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
              <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
                <span>{note ?? 'Câu trả lời có thể chưa hoàn chỉnh do đạt giới hạn token.'}</span>
                {onContinueGenerating && (
                  <button
                    type="button"
                    onClick={onContinueGenerating}
                    className="rounded-lg bg-amber-600/30 px-2.5 py-1 font-medium text-amber-100 hover:bg-amber-600/50 transition-colors shadow-sm"
                  >
                    Viết tiếp
                  </button>
                )}
              </div>
            );
          })()}

          {m.role === 'assistant' && (m as any).status === 'aborted' && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-2">
              <div className="flex items-center gap-1.5">
                <MessageStatusBadge status="aborted" />
                <span className="text-[11px] text-zinc-500">· Bạn có thể tạo lại để sinh câu trả lời mới</span>
              </div>
              <button
                type="button"
                onClick={() => onRegenerate(m.id)}
                className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400 hover:bg-amber-500/20"
              >
                <RefreshCcw size={12} />
                <span>Tạo nhánh mới</span>
              </button>
            </div>
          )}

          {/* Action toolbar + Branch switcher */}
          {!isStreaming && (
            <div className="mt-2 flex items-center gap-1 text-xs opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <button
                type="button"
                onClick={() => onCopy(m)}
                title="Sao chép"
                className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              >
                {isCopied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => onRegenerate(m.id)}
                title="Tạo lại câu trả lời"
                className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
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
    prev.m.role === next.m.role &&
    prev.branchInfo?.currentIndex === next.branchInfo?.currentIndex &&
    prev.branchInfo?.total === next.branchInfo?.total &&
    prev.isStreaming === next.isStreaming &&
    prev.isEditing === next.isEditing &&
    prev.isCopied === next.isCopied &&
    prev.draft === next.draft &&
    prev.isTouchDevice === next.isTouchDevice &&
    prev.sendOnEnter === next.sendOnEnter &&
    prev.animations === next.animations &&
    prev.throttleMs === next.throttleMs,
);

