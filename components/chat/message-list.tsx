/*
 * Danh sách tin nhắn virtualized + các chiến lược scroll/pin.
 */
import React, { memo, useEffect, useMemo } from 'react';
import type { Message } from 'ai/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Sparkles } from 'lucide-react';
import { ChatErrorBoundary } from '@/components/chat-error-boundary';
import { MessageItem, type BranchInfo } from './message-item';

/* ------------------------------------------------------------------ */
/* Subcomponent 2: Memoized MessageList with Virtualization           */
/* ------------------------------------------------------------------ */

/** Cache chiều cao thật theo chatId:messageId — sống qua unmount/đổi chat. */
const HEIGHT_CACHE = new Map<string, number>();
const cacheKey = (chatId: string, id: string) => `${chatId}:${id}`;

/** Ước lượng sát thực tế cho hàng chưa từng render. */
function estimateMessageHeight(m: Message): number {
  const text = m.content ?? '';
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
  animations: boolean;
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
  animations,
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
}: MessageListProps) {
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => messages[index]?.id ?? `row-${index}`,
    overscan: 6,
    paddingStart: 16,
    paddingEnd: 96,
    estimateSize: (index) => {
      const m = messages[index];
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

  const lastMsg = messages[messages.length - 1];
  const lastRole = lastMsg?.role;
  const lastContentLen = lastMsg?.content?.length ?? 0;

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
    () => ['Explain quantum computing', 'Write a Python script for scraping', 'Plan a healthy meal', 'Summarize an article'],
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
        className="chat-scroll h-full overflow-y-auto px-4 md:px-8"
      >
        {!hasMessages ? (
          <div className="flex h-full flex-col items-center justify-center px-4 pb-16 pt-10">
            <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-[#c96442]/25 bg-gradient-to-br from-[#c96442]/15 to-[#c96442]/5 text-[#e08a68] shadow-[0_8px_32px_-8px_rgba(201,100,66,0.35)]">
              <Sparkles size={30} strokeWidth={1.8} />
            </div>
            <h1 className="bg-gradient-to-b from-zinc-50 to-zinc-400 bg-clip-text text-center text-[28px] font-semibold leading-tight tracking-tight text-transparent">
              Hôm nay mình giúp gì cho bạn?
            </h1>
            <p className="mt-2 text-center text-[13px] text-zinc-500">
              Hỏi bất cứ điều gì — nói bằng giọng nói, hoặc gõ / để chèn prompt mẫu.
            </p>
            <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-2.5 md:grid-cols-2">
              {suggestions.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => onSelectSuggestion(prompt)}
                  className="group flex items-center justify-between gap-3 rounded-xl border border-zinc-800/80 bg-[#161619]/60 p-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-[#c96442]/40 hover:bg-[#1c1c20] hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.8)]"
                >
                  <span className="text-sm text-zinc-400 transition-colors group-hover:text-zinc-100">
                    {prompt}
                  </span>
                  <ArrowUp
                    size={13}
                    className="flex-shrink-0 text-zinc-700 transition-colors group-hover:text-[#c96442]"
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
                maxWidth: '48rem',
                margin: '0 auto',
                position: 'relative',
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const m = messages[virtualRow.index];
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
                        animations={animations}
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

            {isLoading && lastRole === 'user' && (
              <div className="flex justify-start px-1 pb-6">
                <span className="inline-block h-4 w-2 animate-pulse bg-indigo-500" />
              </div>
            )}
          </>
        )}

        {error && (
          <div className="max-w-[720px] p-4 bg-red-950/50 border border-red-900 text-red-400 rounded-xl mx-auto flex items-center justify-between">
            <span>{error.message || 'An error occurred.'}</span>
            <button onClick={onReload} className="px-3 py-1 bg-red-900/50 rounded hover:bg-red-800 transition">
              Thử lại
            </button>
          </div>
        )}
      </div>

      {!isAtBottom && (
        <button
          type="button"
          onClick={onScrollToBottom}
          aria-label="Scroll to bottom"
          className="absolute bottom-6 left-1/2 -translate-x-1/2 p-2 bg-zinc-800 text-zinc-300 rounded-full shadow-lg border border-zinc-700 hover:bg-zinc-700 transition"
        >
          <ArrowDown size={18} />
        </button>
      )}
    </>
  );
});

