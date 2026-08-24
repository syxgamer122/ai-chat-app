/*
 * HÃ ng tin nháº¯n (user/assistant) â€” memoized, há»— trá»£ edit/branch/attachment.
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
import { KodaMark } from '@/components/koda-logo';

/* ------------------------------------------------------------------ */
/* Memoized Message Item                                              */
/* ------------------------------------------------------------------ */

/** Avatar của trợ lý — dấu hiệu KODA trên nền thương hiệu nhạt. */
export function AssistantAvatar() {
  return (
    <div
      aria-hidden="true"
      className="mt-0.5 flex h-7 w-7 flex-shrink-0 select-none items-center justify-center rounded-full bg-surface-bubble shadow-sm ring-1 ring-brand/30"
    >
      <KodaMark size={15} />
    </div>
  );
}
export interface BranchInfo {
  /**
   * Index zero-based cá»§a message hiá»‡n táº¡i trong nhÃ³m siblings.
   */
  currentIndex: number;

  /**
   * Tá»•ng sá»‘ siblings.
   */
  total: number;
}

interface MessageItemProps {
  m: Message;

  /**
   * ThÃ´ng tin branch cá»§a message Ä‘ang hiá»ƒn thá»‹.
   * undefined náº¿u message khÃ´ng cÃ³ siblings.
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

            {/* Ná»™i dung tin nháº¯n / Chá»‰nh sá»­a */}
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
                  aria-label="Sá»­a ná»™i dung tin nháº¯n"
                  className="w-full resize-none bg-transparent text-sm text-zinc-800 outline-none placeholder:text-zinc-400"
                  autoFocus
                />
                <div className="flex justify-end gap-2 border-t border-zinc-200 pt-1 text-xs">
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    className="rounded-lg px-2.5 py-1 text-zinc-600 transition-colors hover:bg-zinc-100"
                  >
                    Há»§y
                  </button>
                  <button
                    type="button"
                    onClick={() => onSaveEdit(m.id)}
                    className="rounded-lg bg-brand px-3 py-1 font-medium text-white shadow-sm transition-colors hover:bg-brand-hover"
                  >
                    LÆ°u &amp; Gá»­i láº¡i
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
                  <ErrorBoundary resetKey={`${m.id}:${m.content.length}`}>
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
                        <span>Thu gá»n</span>
                      </>
                    ) : (
                      <>
                        <ChevronDown size={13} />
                        <span>Xem toÃ n bá»™ ({m.content.length.toLocaleString('vi-VN')} kÃ½ tá»±)</span>
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
                  aria-label="Sao chÃ©p tin nháº¯n"
                  title="Sao chÃ©p"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-800"
                >
                  {isCopied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => onStartEdit(m)}
                  aria-label="Chá»‰nh sá»­a tin nháº¯n"
                  title="Chá»‰nh sá»­a"
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
        <AssistantAvatar />

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

          {/* Tiáº¿n trÃ¬nh táº¡o áº£nh/video (route ghi vÃ o kÃªnh reasoning). Chá»‰ hiá»‡n
              lÃºc Ä‘ang stream â€” media máº¥t vÃ i phÃºt nÃªn cáº§n dáº¥u hiá»‡u cÃ²n sá»‘ng. */}
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
            <ErrorBoundary resetKey={`${m.id}:${m.content.length}`}>
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
                <span className="min-w-0">{note ?? 'CÃ¢u tráº£ lá»i cÃ³ thá»ƒ chÆ°a hoÃ n chá»‰nh do Ä‘áº¡t giá»›i háº¡n token.'}</span>
                {onContinueGenerating && (
                  <button
                    type="button"
                    onClick={onContinueGenerating}
                    className="flex-shrink-0 rounded-lg bg-amber-600 px-2.5 py-1 font-medium text-white shadow-sm transition-colors hover:bg-amber-700"
                  >
                    Viáº¿t tiáº¿p
                  </button>
                )}
              </div>
            );
          })()}

          {m.role === 'assistant' && (m as any).status === 'aborted' && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 pt-2">
              <div className="flex items-center gap-1.5">
                <MessageStatusBadge status="aborted" />
                <span className="text-[11px] text-zinc-500">Â· Báº¡n cÃ³ thá»ƒ táº¡o láº¡i Ä‘á»ƒ sinh cÃ¢u tráº£ lá»i má»›i</span>
              </div>
                <button
                  type="button"
                  onClick={() => onRegenerate(m.id)}
                  className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
                >
                <RefreshCcw size={12} />
                <span>Táº¡o nhÃ¡nh má»›i</span>
              </button>
            </div>
          )}

          {/* Action toolbar + Branch switcher */}
          {!isStreaming && (
            <div className="msg-actions mt-2 flex items-center gap-1 text-xs">
              <button
                type="button"
                onClick={() => onCopy(m)}
                aria-label="Sao chÃ©p cÃ¢u tráº£ lá»i"
                title="Sao chÃ©p"
                className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-800"
              >
                {isCopied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => onRegenerate(m.id)}
                aria-label="Táº¡o láº¡i cÃ¢u tráº£ lá»i"
                title="Táº¡o láº¡i cÃ¢u tráº£ lá»i"
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
    // Model media chÆ°a cÃ³ content nÃ o trong lÃºc cháº¡y â€” tiáº¿n trÃ¬nh Ä‘i qua
    // `reasoning`, pháº£i so cáº£ field nÃ y náº¿u khÃ´ng dÃ²ng tráº¡ng thÃ¡i Ä‘á»©ng im.
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

