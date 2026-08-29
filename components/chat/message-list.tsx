/*
 * Danh sách tin nhắn virtualized + các chiến lược scroll/pin.
 */
import React, { memo, useEffect, useMemo, useState } from 'react';
import type { Message } from 'ai/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { ChatErrorBoundary } from '@/components/chat-error-boundary';
import { KodaLogo } from '@/components/koda-logo';
import { TextShimmer } from '@/components/effects';
import { MessageItem, AssistantAvatar, type BranchInfo } from './message-item';
import { motion } from 'framer-motion';

/* ------------------------------------------------------------------ */
/* Subcomponent 2: Memoized MessageList with Virtualization           */
/* ------------------------------------------------------------------ */

/** Cache chiều cao thật theo chatId:messageId — sống qua unmount/đổi chat. */
const HEIGHT_CACHE = new Map<string, number>();
const cacheKey = (chatId: string, id: string) => `${chatId}:${id}`;

/** Ước lượng sát thực tế cho hàng chưa từng render. */
function estimateMessageHeight(m: Message): number {  const text = m.content ?? '';
  const newlines = text.match(/\n/g)?.length ?? 0;
  const wrapped = Math.ceil(text.length / 68);
  let h = 64 + Math.max(newlines, wrapped) * 26;

  h += Math.floor((text.match(/```/g)?.length ?? 0) / 2) * 150;  // code block
  h += Math.floor((text.match(/\$\$/g)?.length ?? 0) / 2) * 58;  // math block
  h += (text.match(/\\\[/g)?.length ?? 0) * 58;                  // \[...\]
  h += (text.match(/^\|/gm)?.length ?? 0) * 14;                  // dòng bảng
  if (m.experimental_attachments?.length) h += 210;

  return Math.min(Math.max(h, 72), 8000);
}

/** Lỗi từ API về dạng JSON thô (`{"error":...}`) → rút ra câu thông báo. */
function friendlyErrorMessage(raw?: string): string {
  if (!raw) return 'Đã xảy ra lỗi.';
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const text = [parsed.error, parsed.message].find((v) => typeof v === 'string') as
      | string
      | undefined;
    return text || raw;
  } catch {
    return raw;
  }
}

/**
 * Hàng "AI đang xử lý" — hiện giữa lúc chờ token đầu tiên (user vừa gửi,
 * hoặc regenerate chưa nhả chữ). Avatar + chấm nảy + số giây đã chờ để
 * người dùng biết hệ thống còn hoạt động, không phải treo.
 */
function ThinkingIndicator() {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    setElapsedSec(0);
    const timer = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="mx-auto flex max-w-thread items-start gap-3 px-4 py-3 md:px-4">
      <AssistantAvatar />
      <div className="flex items-center gap-3" role="status" aria-live="polite">
        <div className="grid grid-cols-3 gap-[3px]" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <motion.div
              key={i}
              className="h-1.5 w-1.5 rounded-[1px] bg-brand dark:bg-aurora-from"
              animate={{ opacity: [0.2, 1, 0.2] }}
              transition={{
                duration: 1.2,
                repeat: Infinity,
                delay: i * 0.08,
                ease: 'easeInOut',
              }}
            />
          ))}
        </div>
        <span className="text-[13px] tabular-nums text-zinc-500 dark:text-zinc-400">
          <TextShimmer text={`Đang suy nghĩ${elapsedSec >= 2 ? ` · ${elapsedSec}s` : '…'}`} className="" />
        </span>
        <span className="sr-only">AI đang xử lý câu trả lời của bạn</span>
      </div>
    </div>
  );
}

interface MessageListProps {
  chatId: string;
  messages: Message[];

  branchInfoByMessageId: Map<
    string,
    BranchInfo
  >;

  isLoading: boolean;
  lastMessageId?: string;
  editingId: string | null;
  copiedId: string | null;
  draft: string;
  isTouchDevice: boolean;
  sendOnEnter: boolean;
  throttleMs: number;
  error?: Error;
  isAtBottom: boolean;
  isAtBottomRef: React.MutableRefObject<boolean>;
  pin: (durationMs?: number) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;

  onScroll: () => void;
  onScrollToBottom: () => void;
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
  onSelectSuggestion: (prompt: string) => void;
  onReload: () => void;
  onContinueGenerating?: () => void;

  /** Marker nén hội thoại — banner gắn vào tin ĐẦU TIÊN sau ranh giới. */
  compaction?: {
    upToId: string;
    summary: string;
    compactedCount: number;
  } | null;
}

export const MessageList = memo(function MessageList({
  chatId,
  messages,
  branchInfoByMessageId,
  isLoading,
  lastMessageId,
  editingId,
  copiedId,
  draft,
  isTouchDevice,
  sendOnEnter,
  throttleMs,
  error,
  isAtBottom,
  isAtBottomRef,
  pin,
  scrollRef,
  onScroll,
  onScrollToBottom,
  onCopy,
  onRegenerate,
  onSwitchBranch,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDraftChange,
  onSelectSuggestion,
  onReload,
  onContinueGenerating,
  compaction,
}: MessageListProps) {
  const lastMsg = messages[messages.length - 1];
  const lastRole = lastMsg?.role;
  const lastContentLen = lastMsg?.content?.length ?? 0;

  /**
   * Đang chờ token đầu tiên mà tin nhắn assistant cuối vẫn rỗng: hàng rỗng
   * (avatar + caret nháy trên bong bóng trống) bị ẩn, ThinkingIndicator đại
   * diện — nếu không sẽ có 2 avatar KODA cùng lúc cho 1 câu trả lời. Ký tự
   * đầu tiên tới → hàng hiện lại và indicator tự ẩn (caret tiếp quản).
   */
  const pendingEmptyAssistant =
    isLoading &&
    lastRole === 'assistant' &&
    lastContentLen === 0 &&
    !(lastMsg as any)?.reasoning;

  const visibleMessages = useMemo(
    () => (pendingEmptyAssistant ? messages.slice(0, -1) : messages),
    [messages, pendingEmptyAssistant],
  );

  /** Banner nén gắn vào tin ĐẦU TIÊN nằm sau ranh giới marker. */
  const compactionBannerBeforeId = useMemo(() => {
    if (!compaction) return null;
    const idx = visibleMessages.findIndex((m) => m.id === compaction.upToId);
    const next = idx >= 0 ? visibleMessages[idx + 1] : undefined;
    return next?.id ?? null;
  }, [compaction, visibleMessages]);

  // App không bật React Compiler; useVirtualizer của TanStack trả về hàm
  // mỗi render là hành vi chủ đích của thư viện — bỏ cảnh báo nhiễu.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => visibleMessages[index]?.id ?? `row-${index}`,
    overscan: 6,
    paddingStart: 16,
    paddingEnd: 96,
    estimateSize: (index) => {
      const m = visibleMessages[index];
      if (!m) return 140;
      return HEIGHT_CACHE.get(cacheKey(chatId, m.id)) ?? estimateMessageHeight(m);
    },
    measureElement: (el) => {
      const h = el.getBoundingClientRect().height;
      const id = el.getAttribute('data-message-id');
      if (id && h > 0) HEIGHT_CACHE.set(cacheKey(chatId, id), h);
      return h;
    },
  });

  const branchLayoutSignature = useMemo(
    () =>
      messages
        .map((message) => {
          const info =
            branchInfoByMessageId.get(message.id);

          return [
            message.id,
            info?.currentIndex ?? -1,
            info?.total ?? 1,
          ].join(':');
        })
        .join('|'),
    [messages, branchInfoByMessageId],
  );

  /* 1. Đổi chat: xoá cache chiều cao của chat khác (tránh phình vô hạn theo
     phiên), nhảy đáy TỨC THÌ rồi ghim 1s để bù các lần đo lại */
  useEffect(() => {
    const prefix = `${chatId}:`;
    for (const key of HEIGHT_CACHE.keys()) {
      if (!key.startsWith(prefix)) HEIGHT_CACHE.delete(key);
    }
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    el.scrollTop = el.scrollHeight;
    pin(1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  /* 2. Có tin nhắn mới */
  useEffect(() => {
    if (messages.length === 0) return;
    if (lastRole === 'user') {
      pin(1500); // user vừa gửi → LUÔN về đáy
    } else if (isAtBottomRef.current) {
      pin(600);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, lastRole, pin]);

  /* 3. Streaming: hook đã ghim vô hạn. Nhích thêm khi nội dung tăng */
  useEffect(() => {
    if (isLoading && isAtBottomRef.current) pin(200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastContentLen, isLoading, pin]);

  /* 4. Font KaTeX/mono nạp xong */
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) return;
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (cancelled) return;
      HEIGHT_CACHE.clear();
      rowVirtualizer.measure();
      if (isAtBottomRef.current) pin(700);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowVirtualizer, pin]);

  /* 5. Ảnh trong markdown load xong */
  useEffect(() => {
    let raf = 0;
    const onImageLoaded = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (isAtBottomRef.current) pin(300);
      });
    };
    window.addEventListener('chat:image-loaded', onImageLoaded);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('chat:image-loaded', onImageLoaded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  /* 6. Đổi nhánh */
  useEffect(() => {
    rowVirtualizer.measure();
    if (isAtBottomRef.current) pin(700);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchLayoutSignature]);

  const suggestions = useMemo(
    () => [
      'Giải thích máy tính lượng tử một cách dễ hiểu',
      'Viết script Python để thu thập dữ liệu web',
      'Lên thực đơn ăn uống lành mạnh cho một tuần',
      'Tóm tắt bài viết tôi sắp dán vào đây',
    ],
    [],
  );

  const hasMessages = messages.length > 0;

  return (
    <>
      <div
        ref={scrollRef as any}
        onScroll={onScroll}
        tabIndex={0}
        role="log"
        aria-label="Danh sách tin nhắn"
        className="chat-scroll h-full overflow-hidden overflow-y-auto px-4 md:px-8"
      >
        {!hasMessages ? (
          <div className="mx-auto flex h-full max-w-thread flex-col items-center justify-center px-4 pb-16 pt-10">
            <KodaLogo size="lg" className="mb-5" />
            <h1 className="w-full min-w-0 max-w-[16rem] text-balance text-center text-[20px] font-semibold leading-tight tracking-tight text-zinc-800 sm:max-w-none md:text-[26px]">
              Hôm nay mình giúp gì cho bạn?
            </h1>
            <p className="mt-2 w-full min-w-0 text-pretty text-center text-[13px] text-zinc-500">
              Hỏi bất cứ điều gì — nói bằng giọng nói, hoặc gõ / để chèn prompt mẫu.
            </p>
            <div className="mt-8 grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2">
              {suggestions.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => onSelectSuggestion(prompt)}
                  className="group flex items-center justify-between gap-3 rounded-xl border border-zinc-200/80 bg-surface-raised/70 p-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-brand/40 hover:bg-surface-muted hover:shadow-card"
                >
                  <span className="text-sm text-zinc-600 transition-colors group-hover:text-zinc-900">
                    {prompt}
                  </span>
                  <ArrowUp
                    size={13}
                    aria-hidden="true"
                    className="flex-shrink-0 text-zinc-400 transition-colors group-hover:text-brand"
                  />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                width: '100%',
                margin: '0 auto',
                position: 'relative',
              }}
              className="max-w-thread"
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const m = visibleMessages[virtualRow.index];
                if (!m) return null;

                return (
                  <div
                    key={m.id}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    data-message-id={m.id}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                      paddingBottom: '1.5rem',
                    }}
                  >
                    {compaction && compactionBannerBeforeId === m.id && (
                      <div className="mb-2">
                        {compaction.summary ? (
                          <details className="surface-panel rounded-lg px-3 py-1.5 text-[11px] text-zinc-500">
                            <summary className="cursor-pointer select-none font-medium text-zinc-600">
                              ✂ Đã nén {compaction.compactedCount} tin nhắn trước đó — bấm để xem
                              tóm tắt
                            </summary>
                            <div className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap leading-relaxed text-zinc-600">
                              {compaction.summary}
                            </div>
                          </details>
                        ) : (
                          <div className="surface-panel rounded-lg px-3 py-1.5 text-[11px] text-zinc-500">
                            ✂ Đã lược bỏ {compaction.compactedCount} tin nhắn cũ
                          </div>
                        )}
                      </div>
                    )}
                    <ChatErrorBoundary onReset={() => rowVirtualizer.measure()}>
                      <MessageItem
                        m={m}
                        branchInfo={branchInfoByMessageId.get(m.id)}
                        isStreaming={isLoading && m.role === 'assistant' && m.id === lastMessageId}
                        isEditing={editingId === m.id}
                        isCopied={copiedId === m.id}
                        draft={editingId === m.id ? draft : ''}
                        isTouchDevice={isTouchDevice}
                        sendOnEnter={sendOnEnter}
                        throttleMs={throttleMs}
                        onCopy={onCopy}
                        onRegenerate={onRegenerate}
                        onSwitchBranch={onSwitchBranch}
                        onStartEdit={onStartEdit}
                        onSaveEdit={onSaveEdit}
                        onCancelEdit={onCancelEdit}
                        onDraftChange={onDraftChange}
                        onContinueGenerating={onContinueGenerating}
                        onContentResize={() => {
                          if (isAtBottomRef.current) pin(300);
                        }}
                      />
                    </ChatErrorBoundary>
                  </div>
                );
              })}
            </div>

            {isLoading &&
              !(
                lastRole === 'assistant' &&
                ((lastMsg as any)?.reasoning || lastContentLen > 0)
              ) &&
              <ThinkingIndicator />}
          </>
        )}

        {error && (
          <div className="notice-error mx-auto mb-4 flex max-w-thread flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
            <span className="min-w-0">{friendlyErrorMessage(error.message)}</span>
            <button
              type="button"
              onClick={onReload}
              className="flex-shrink-0 rounded-lg bg-red-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-red-700"
            >
              Thử lại
            </button>
          </div>
        )}
      </div>

      {!isAtBottom && (
        <button
          type="button"
          onClick={onScrollToBottom}
          aria-label="Xuống tin nhắn mới nhất"
          className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full border border-zinc-200 bg-surface-raised p-2 text-zinc-600 shadow-card transition-colors hover:bg-zinc-100 hover:text-zinc-900"
        >
          <ArrowDown size={18} />
        </button>
      )}
    </>
  );
});

