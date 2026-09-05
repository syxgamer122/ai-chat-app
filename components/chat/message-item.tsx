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
import { OrchestratorBadge, getOrchestratorAdoptedAnnotation } from '@/components/chat/orchestrator-badge';
import { VyenMark } from '@/components/vyen-logo';

export function AssistantAvatar() {
  return (
    <div
      aria-hidden="true"
      className="mt-0.5 flex h-7 w-7 flex-shrink-0 select-none items-center justify-center rounded-none border border-[#495059] bg-[#212730] text-[#6a9fcc]"
    >
      <VyenMark size={14} />
    </div>
  );
}

function ThinkingBlock({ reasoning, isStreaming }: { reasoning: string; isStreaming: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = reasoning.trim().split('\n').filter(Boolean);
  const preview = lines[lines.length - 1] || 'thinking...';

  return (
    <div className="my-2 rounded-none border border-[#495059] bg-[#161d27] p-2 text-xs font-mono">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline justify-between gap-2 text-left text-[11px] text-[#6a9fcc] hover:text-[#ebe7e4]"
      >
        <span className="flex min-w-0 items-baseline gap-1.5 italic">
          <span className="font-semibold not-italic">thinking</span>
          {isStreaming && <span className="terminal-cursor not-italic" aria-hidden="true" />}
          {!open && <span className="truncate text-[#9fa4ab]">· {preview}</span>}
        </span>
        <span className="flex-shrink-0 text-[10px] text-[#9fa4ab]">[{open ? 'hide' : 'expand'}]</span>
      </button>
      {open && (
        <div className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap border-l border-[#495059] pl-2.5 font-mono text-[11.5px] italic leading-relaxed text-[#9fa4ab]">
          {reasoning}
        </div>
      )}
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
      className={`relative flex h-6 w-6 items-center justify-center rounded-none transition-colors after:absolute after:-inset-[10px] after:content-[''] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#6a9fcc] ${
        active
          ? 'bg-[#252f3d] text-[#6a9fcc]'
          : 'text-[#9fa4ab] hover:bg-[#252f3d] hover:text-[#ebe7e4]'
      }`}
    >
      <Icon size={13} />
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
        <div className="group flex w-full justify-end px-4 py-1.5">
          <div className="flex max-w-[88%] md:max-w-[72%] flex-col items-end gap-1">
            {m.experimental_attachments && m.experimental_attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2 justify-end">
                {m.experimental_attachments.map((att, idx) => (
                  <div key={idx} className="relative overflow-hidden rounded-none border border-[#495059] bg-[#212730]">
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
                      <div className="flex items-center gap-2 px-3 py-2 text-xs font-mono text-[#ebe7e4]">
                        <Paperclip size={12} className="text-[#6a9fcc]" />
                        <span className="truncate max-w-[150px]">{att.name}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {isEditing ? (
              <div className="flex w-full min-w-[280px] flex-col gap-2 rounded-none border border-[#495059] bg-[#161d27] p-3">
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
                  className="w-full resize-none bg-transparent font-mono text-sm text-[#ebe7e4] outline-none placeholder:text-[#9fa4ab]"
                  autoFocus
                />
                <div className="flex justify-end gap-2 border-t border-[#495059] pt-2 text-xs font-mono">
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    className="rounded-none px-2.5 py-1 text-[#9fa4ab] transition-colors hover:bg-[#252f3d] hover:text-[#ebe7e4]"
                  >
                    Hủy
                  </button>
                  <button
                    type="button"
                    onClick={() => onSaveEdit(m.id)}
                    className="rounded-none bg-[#6a9fcc] px-3 py-1 font-medium text-[#0d1116] transition-colors hover:bg-[#6a9fcc]/85"
                  >
                    Lưu & Gửi lại
                  </button>
                </div>
              </div>
            ) : (
              <div className="relative rounded-none border border-[#495059] bg-[#212730] px-4 py-2.5 text-[17px] leading-relaxed text-[#ebe7e4]">
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
                    <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[#212730] via-[#212730]/70 to-transparent" />
                  )}
                </div>

                {isLongUserMsg && (
                  <button
                    type="button"
                    onClick={() => setIsExpanded((prev) => !prev)}
                    aria-expanded={isExpanded}
                    className="mt-1.5 inline-flex items-center gap-1 font-mono text-[11px] font-medium text-[#6a9fcc] transition-colors hover:text-[#ebe7e4]"
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
              <div className="msg-actions mt-0.5 flex items-center gap-1">
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
                <div key={idx} className="relative overflow-hidden rounded-none border border-[#495059] bg-[#212730]">
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
                    <div className="flex items-center gap-2 px-3 py-2 text-xs font-mono text-[#ebe7e4]">
                      <Paperclip size={12} className="text-[#6a9fcc]" />
                      <span className="truncate max-w-[150px]">{att.name}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {(() => {
            const adopted = getOrchestratorAdoptedAnnotation(
              (m as any).annotations as unknown[] | undefined,
            );
            return adopted ? <OrchestratorBadge payload={adopted} /> : null;
          })()}

          <ToolTrace
            annotations={(m as any).annotations as Array<Record<string, unknown>> | undefined}
            toolInvocations={(m as any).toolInvocations as Array<{
              toolCallId?: string;
              state?: string;
            }> | undefined}
          />

          {(() => {
            const reasoning = (m as any).reasoning;
            if (typeof reasoning === 'string' && reasoning.trim()) {
              return <ThinkingBlock reasoning={reasoning} isStreaming={isStreaming} />;
            }
            return null;
          })()}

          <div
            className={`claude-prose text-[#ebe7e4] ${isStreaming ? 'streaming-caret' : ''}`}
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
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-none border border-[#e8993a]/30 bg-[#161d27] px-3 py-2 text-xs font-mono text-[#e8993a]">
                <span className="min-w-0">{note ?? 'Câu trả lời có thể chưa hoàn chỉnh.'}</span>
                {onContinueGenerating && (
                  <button
                    type="button"
                    onClick={onContinueGenerating}
                    className="flex-shrink-0 rounded-none bg-[#e8993a] px-2.5 py-1 font-medium text-[#0d1116] transition-colors hover:bg-[#e8993a]/85"
                  >
                    Viết tiếp
                  </button>
                )}
              </div>
            );
          })()}

          {m.role === 'assistant' && (m as any).status === 'aborted' && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-[#495059] pt-2 font-mono">
              <div className="flex items-center gap-1.5">
                <MessageStatusBadge status="aborted" />
                <span className="text-[11px] text-[#9fa4ab]">· Bạn có thể tạo lại</span>
              </div>
              <button
                type="button"
                onClick={() => onRegenerate(m.id)}
                className="inline-flex items-center gap-1 rounded-none px-2 py-1 text-[11px] text-[#6a9fcc] transition-colors hover:bg-[#252f3d] hover:text-[#ebe7e4]"
              >
                <RefreshCcw size={12} />
                <span>Tạo nhánh mới</span>
              </button>
            </div>
          )}

          {!isStreaming && (
            <div className="msg-actions -ml-1 flex items-center gap-1 pt-1">
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
