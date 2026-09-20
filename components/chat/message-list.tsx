/*
 * Danh sách tin nhắn virtualized + các chiến lược scroll/pin.
 */
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from 'ai/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import { ChatErrorBoundary } from '@/components/chat-error-boundary';
import { MessageItem, type BranchInfo } from './message-item';

/* ------------------------------------------------------------------ */
/* Subcomponent 2: Memoized MessageList with Virtualization           */
/* ------------------------------------------------------------------ */

/**
 * Bounded LRU cache cho chiều cao dòng theo `${chatId}:${messageId}:${widthBucket}`.
 * Tự động giới hạn trần 2.000 bản ghi, chống rò rỉ bộ nhớ qua các phiên dài.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly maxSize: number = 2000) {}

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  get size(): number {
    return this.map.size;
  }
}

export function getWidthBucket(width?: number): number {
  if (!width || width <= 0) return 800;
  return Math.round(width / 50) * 50;
}

/** Cache chiều cao thật theo chatId:messageId:widthBucket — sống qua unmount/đổi chat. */
const HEIGHT_CACHE = new LruCache<string, number>(2000);
const cacheKey = (chatId: string, id: string, widthBucket: number) =>
  `${chatId}:${id}:${widthBucket}`;

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
 * hoặc regenerate chưa nhả chữ). Chấm nảy + số giây đã chờ để người dùng biết
 * hệ thống còn hoạt động, không phải treo.
 *
 * Tông màu theo độ chờ (mượn ý UI): <10s bình thường, 10-30s chờ
 * dài (vàng), >30s đỏ kèm chú thích. Model suy luận nặng từng đo TTFT tới
 * 60s nên đỏ không có nghĩa là lỗi, chỉ là "còn chờ hơi lâu".
 */
function ThinkingIndicator() {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    setElapsedSec(0);
    // 100ms cho số lẻ 12.3s: con số chạy thấy được tự nó là tín hiệu "còn sống".
    const timer = setInterval(() => {
      setElapsedSec((Date.now() - startedAt) / 1000);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  const slowTone = elapsedSec >= 30;
  const tone = slowTone
    ? 'text-status-error'
    : elapsedSec >= 10
      ? 'text-status-warning'
      : 'text-text-muted';

  return (
    <div className="mx-auto flex max-w-thread items-start gap-3 px-4 py-3 md:px-4">
      <p className="flex min-w-0 items-baseline gap-2 py-1 font-mono text-xs" role="status">
        <span className="text-text-muted">$</span>
        <span className="text-text-primary">đang soạn câu trả lời</span>
        <span className={`tabular-nums ${tone}`}>{elapsedSec >= 1 ? `${elapsedSec.toFixed(1)}s` : ''}</span>
        {slowTone && (
          <span className="text-status-error">model nặng có thể chờ 30-60s</span>
        )}
        <span className="terminal-cursor" aria-hidden="true" />
      </p>
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
   * diện — nếu không sẽ có 2 avatar Vyen cùng lúc cho 1 câu trả lời. Ký tự
   * đầu tiên tới → hàng hiện lại và indicator tự ẩn (caret tiếp quản).
   */
  const pendingEmptyAssistant =
    isLoading &&
    lastRole === 'assistant' &&
    lastContentLen === 0 &&
    !(lastMsg as any)?.reasoning;

  /**
   * P2.1: Tin nhắn assistant đang stream (đã có nội dung hoặc reasoning)
   * được tách khỏi virtualizer để render ở sticky footer container bên dưới,
   * triệt tiêu hoàn toàn đo đạc giật lag (measurement thrashing) trên từng token.
   */
  const isStreamingAssistant =
    isLoading &&
    lastRole === 'assistant' &&
    (Boolean((lastMsg as any)?.reasoning) || lastContentLen > 0);

  const visibleMessages = useMemo(() => {
    if (pendingEmptyAssistant || isStreamingAssistant) {
      return messages.slice(0, -1);
    }
    return messages;
  }, [messages, pendingEmptyAssistant, isStreamingAssistant]);

  /** Theo dõi kích thước container để chọn width bucket cho HEIGHT_CACHE */
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateWidth = () => {
      const w = el.clientWidth;
      if (w > 0) {
        setContainerWidth((prev) => {
          const prevBucket = getWidthBucket(prev);
          const newBucket = getWidthBucket(w);
          return prevBucket !== newBucket ? w : prev;
        });
      }
    };
    updateWidth();
    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRef]);

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
    paddingEnd: isStreamingAssistant ? 16 : 96,
    estimateSize: (index) => {
      const m = visibleMessages[index];
      if (!m) return 140;
      const bucket = getWidthBucket(containerWidth || scrollRef.current?.clientWidth);
      return HEIGHT_CACHE.get(cacheKey(chatId, m.id, bucket)) ?? estimateMessageHeight(m);
    },
    measureElement: (el) => {
      const h = el.getBoundingClientRect().height;
      const id = el.getAttribute('data-message-id');
      const bucket = getWidthBucket(
        containerWidth || scrollRef.current?.clientWidth || el.getBoundingClientRect().width,
      );
      if (id && h > 0) HEIGHT_CACHE.set(cacheKey(chatId, id, bucket), h);
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

  /* 1. Đổi chat: nhảy đáy TỨC THÌ rồi ghim 1s để bù các lần đo lại.
     HEIGHT_CACHE là bounded LRU (2.000 phần tử) nên tự giới hạn trần bộ nhớ,
     giữ chiều cao các chat gần đây sống qua unmount/đổi chat để không bị giật layout. */
  useEffect(() => {
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

  /* 3b. Kết thúc streaming (isLoading: true -> false):
     Tin nhắn chuyển từ sticky footer vào virtualizer list.
     Đảm bảo virtualizer đo lại và giữ vị trí đáy mượt mà nếu đang ở đáy. */
  const prevLoadingRef = useRef(isLoading);
  useEffect(() => {
    if (prevLoadingRef.current && !isLoading) {
      rowVirtualizer.measure();
      if (isAtBottomRef.current) pin(400);
    }
    prevLoadingRef.current = isLoading;
  }, [isLoading, pin, rowVirtualizer, isAtBottomRef]);

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
        style={{ overflowAnchor: 'none' }}
        className="chat-scroll h-full overflow-hidden overflow-y-auto px-4 md:px-8 [overflow-anchor:none]"
      >
        {!hasMessages ? (
          <div className="mx-auto flex h-full max-w-thread flex-col justify-center px-4 pb-16 pt-8">
            <h1 className="font-pixel text-[24px] tracking-[0.05em] text-text-primary [image-rendering:pixelated]">
              VYEN<span className="text-accent-steel">_</span>
            </h1>
            <p className="mt-2 font-mono text-xs text-text-muted leading-relaxed">
              Agent harness tối giản: session tree, core tools, tự mở rộng theo workflow của bạn.
            </p>

            <div className="mt-6 flex w-full max-w-lg flex-col gap-2">
              {suggestions.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => onSelectSuggestion(prompt)}
                  className="rounded-none border border-border-hairline bg-panel-bg px-3 py-2 text-left font-mono text-xs text-text-primary transition-colors duration-150 hover:border-border-hover hover:bg-panel-soft"
                >
                  {prompt}
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
                          <details className="rounded-none border border-[#4b607c] bg-surface-raised px-3 py-1.5 font-mono text-xs text-status-warning">
                            <summary className="cursor-pointer select-none font-medium text-accent-steel">
                              Đã nén {compaction.compactedCount} tin nhắn trước đó. Bấm để xem tóm tắt
                            </summary>
                            <div className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-status-warning">
                              {compaction.summary}
                            </div>
                          </details>
                        ) : (
                          <div className="rounded-none border border-[#4b607c] bg-surface-raised px-3 py-1.5 font-mono text-xs text-status-warning">
                            Đã lược bỏ {compaction.compactedCount} tin nhắn cũ
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

            {isStreamingAssistant && lastMsg && (
              <div className="mx-auto w-full max-w-thread pb-24">
                <ChatErrorBoundary onReset={() => rowVirtualizer.measure()}>
                  <MessageItem
                    m={lastMsg}
                    branchInfo={branchInfoByMessageId.get(lastMsg.id)}
                    isStreaming={true}
                    isEditing={editingId === lastMsg.id}
                    isCopied={copiedId === lastMsg.id}
                    draft={editingId === lastMsg.id ? draft : ''}
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
            )}
          </>
        )}

        {error && (
          <div className="notice-error mx-auto mb-4 flex max-w-thread flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
            <span className="min-w-0">{friendlyErrorMessage(error.message)}</span>
            <button
              type="button"
              onClick={onReload}
              className="flex-shrink-0 rounded-none bg-[#e8704f] px-3 py-1 font-mono text-xs font-medium text-[#0d1116] transition-colors hover:bg-[#e8704f]/85"
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
          className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full border border-border-hairline bg-panel-bg p-2 text-accent-steel transition-colors hover:border-border-hover hover:bg-panel-soft hover:text-text-primary"
        >
          <ArrowDown size={16} />
        </button>
      )}
    </>
  );
});

