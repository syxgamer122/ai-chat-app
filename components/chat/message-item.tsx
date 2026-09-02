import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from 'ai/react';
import TextareaAutosize from 'react-textarea-autosize';
import { RefreshCcw, Paperclip, Pencil, Copy, Check, ChevronDown, ChevronUp, Volume2, OctagonX } from 'lucide-react';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { ErrorBoundary } from '@/components/error-boundary';
import { BranchSwitcher } from '@/components/branch-switcher';
import { MessageStatusBadge } from '@/components/message-status-badge';
import { sanitizeContent, getFinishInfo } from '@/lib/chat-tree-persistence';
import { stripEmulatedToolMarkup } from '@/lib/text-tool-guard';
import { stripMarkdownForSpeech } from '@/lib/speech-text';
import { useTts } from '@/lib/use-tts';
import { ToolTrace } from '@/components/chat/tool-trace';
import { VyenMark } from '@/components/vyen-logo';

export function AssistantAvatar() {
  return (
    <div
      aria-hidden="true"
      className="mt-0.5 flex h-7 w-7 flex-shrink-0 select-none items-center justify-center rounded-full bg-zinc-900 dark:bg-gradient-to-br dark:from-aurora-from/20 dark:via-aurora-via/15 dark:to-aurora-to/20 dark:shadow-[0_0_12px_rgb(var(--aurora-from)/0.2)]"
    >
      <VyenMark size={14} className="text-white dark:text-aurora-from" />
    </div>
  );
}

export interface BranchInfo {
  currentIndex: number;
  total: number;
}

interface MessageItemProps {
  m: Message;
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
  onSwitchBranch: (messageId: string, direction: 'previous' | 'next') => void;
  onStartEdit: (m: Message) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onDraftChange: (text: string) => void;
  onContinueGenerating?: () => void;
  onContentResize?: () => void;
}

function ActionButton({
  icon: Icon,
  onClick,
  label,
  active,
}: {
  icon: React.ElementType;
  onClick: () => void;
  label: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
        active
          ? 'bg-white/10 text-emerald-400'
          : 'text-slate-500 hover:bg-white/10 hover:text-slate-300'
      }`}
    >
      <Icon size={14} />
    </button>
  );
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
    const { speakingId, supported: ttsSupported, toggleSpeak } = useTts();
    const isSpeakingThis = speakingId === m.id;

    if (m.role === 'user') {
      return (
        <div className="group flex w-full justify-end px-4 py-1">
          <div className="flex max-w-[85%] md:max-w-[70%] flex-col items-end gap-1">
            {m.experimental_attachments && m.experimental_attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2 justify-end">
                {m.experimental_attachments.map((att, idx) => (
                  <div key={idx} className="relative overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                    {att.contentType?.startsWith('image/') ? (
                      <img
                        src={att.url}
                        alt={att.name ?? 'attachment'}
                        className="max-h-48 max-w-xs object-cover"
                        loading="eager"
                        decoding="async"
                        onLoad={onContentResize}
                        onError={onContentResize}
                      />
                    ) : (
                      <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400">
                        <Paperclip size={12} className="text-zinc-400" />
                        <span className="truncate max-w-[150px]">{att.name}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {isEditing ? (
              <div className="flex w-full min-w-[280px] flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
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
                  className="w-full resize-none bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
                  autoFocus
                />
                <div className="flex justify-end gap-2 border-t border-zinc-100 pt-2 text-xs dark:border-zinc-900">
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    className="rounded-md px-2.5 py-1 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-300"
                  >
                    Hủy
                  </button>
                  <button
                    type="button"
                    onClick={() => onSaveEdit(m.id)}
                    className="rounded-md bg-zinc-900 px-3 py-1 font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-100"
                  >
                    Lưu & Gửi lại
                  </button>
                </div>
              </div>
            ) : (
              <div className="relative rounded-2xl rounded-br-sm bg-gradient-to-br from-emerald-600/60 to-cyan-600/60 px-4 py-2.5 text-[15px] leading-relaxed text-white shadow-lg backdrop-blur-md border border-emerald-400/20">
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
                    <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-emerald-700/60 via-emerald-600/40 to-transparent" />
                  )}
                </div>

                {isLongUserMsg && (
                  <button
                    type="button"
                    onClick={() => setIsExpanded((prev) => !prev)}
                    aria-expanded={isExpanded}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-emerald-200/80 transition-colors hover:text-white"
                  >
                    {isExpanded ? (
                      <>
                        <ChevronUp size={12} />
                        <span>Thu gọn</span>
                      </>
                    ) : (
                      <>
                        <ChevronDown size={12} />
                        <span>Xem thêm ({m.content.length.toLocaleString('vi-VN')} ký tự)</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            )}

            {!isEditing && (
              <div className="msg-actions mt-0.5 flex items-center gap-0.5">
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
                <ActionButton
                  icon={isCopied ? Check : Copy}
                  onClick={() => onCopy(m)}
                  label="Sao chép"
                  active={isCopied}
                />
                <ActionButton
                  icon={Pencil}
                  onClick={() => onStartEdit(m)}
                  label="Chỉnh sửa"
                />
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="group flex w-full items-start gap-3 px-4 py-2">
        <AssistantAvatar />

        <div className="min-w-0 flex-1 space-y-2">
          {m.experimental_attachments && m.experimental_attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {m.experimental_attachments.map((att, idx) => (
                <div key={idx} className="relative overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
                  {att.contentType?.startsWith('image/') ? (
                    <img
                      src={att.url}
                      alt={att.name ?? 'attachment'}
                      className="max-h-48 max-w-xs object-cover"
                      loading="eager"
                      decoding="async"
                      onLoad={onContentResize}
                      onError={onContentResize}
                    />
                  ) : (
                    <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400">
                      <Paperclip size={12} className="text-zinc-400" />
                      <span className="truncate max-w-[150px]">{att.name}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <ToolTrace
            annotations={(m as any).annotations as Array<Record<string, unknown>> | undefined}
            toolInvocations={(m as any).toolInvocations as Array<{
              toolCallId?: string;
              state?: string;
            }> | undefined}
          />

          {isStreaming && typeof (m as any).reasoning === 'string' && (m as any).reasoning.trim() && (
            <p role="status" className="flex items-center gap-2 text-[12px] text-zinc-500">
              <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-zinc-400" />
              <span className="truncate">
                {(m as any).reasoning.trim().split('\n').filter(Boolean).slice(-1)[0]}
              </span>
            </p>
          )}

          <div
            className={`claude-prose text-slate-300 ${isStreaming ? 'streaming-caret' : ''}`}
            aria-busy={isStreaming}
          >
            <ErrorBoundary resetKey={`${m.id}:${m.content.length}`}>
              <MarkdownRenderer
                content={sanitizeContent(stripEmulatedToolMarkup(m.content).text)}
                isStreaming={isStreaming}
                throttleMs={throttleMs}
              />
            </ErrorBoundary>
          </div>

          {(() => {
            const { truncated, message: note } = getFinishInfo(m);
            if (!truncated || isStreaming) return null;
            return (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300 backdrop-blur-sm">
                <span className="min-w-0">{note ?? 'Câu trả lời có thể chưa hoàn chỉnh.'}</span>
                {onContinueGenerating && (
                  <button
                    type="button"
                    onClick={onContinueGenerating}
                    className="flex-shrink-0 rounded-md bg-amber-600 px-2.5 py-1 font-medium text-white transition-colors hover:bg-amber-700"
                  >
                    Viết tiếp
                  </button>
                )}
              </div>
            );
          })()}

          {m.role === 'assistant' && (m as any).status === 'aborted' && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2">
              <div className="flex items-center gap-1.5">
                <MessageStatusBadge status="aborted" />
                <span className="text-[11px] text-zinc-400">· Bạn có thể tạo lại</span>
              </div>
              <button
                type="button"
                onClick={() => onRegenerate(m.id)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
              >
                <RefreshCcw size={12} />
                <span>Tạo nhánh mới</span>
              </button>
            </div>
          )}

          {!isStreaming && (
            <div className="msg-actions -ml-1 flex items-center gap-0.5 pt-1">
              <ActionButton
                icon={isCopied ? Check : Copy}
                onClick={() => onCopy(m)}
                label="Sao chép"
                active={isCopied}
              />
              {ttsSupported && m.content.trim() && (
                <ActionButton
                  icon={isSpeakingThis ? OctagonX : Volume2}
                  onClick={() => toggleSpeak(m.id, stripMarkdownForSpeech(sanitizeContent(m.content)))}
                  label={isSpeakingThis ? 'Dừng đọc' : 'Đọc to'}
                  active={isSpeakingThis}
                />
              )}
              <ActionButton
                icon={RefreshCcw}
                onClick={() => onRegenerate(m.id)}
                label="Tạo lại"
              />
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
    (prev.m as any).reasoning === (next.m as any).reasoning &&
    prev.m.role === next.m.role &&
    (prev.m as any).status === (next.m as any).status &&
    prev.m.annotations === next.m.annotations &&
    (prev.m as any).toolInvocations === (next.m as any).toolInvocations &&
    prev.m.experimental_attachments === next.m.experimental_attachments &&
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
