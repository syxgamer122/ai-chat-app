'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat, type Message } from 'ai/react';
import { useAppStore } from '@/lib/store';
import { db, Dexie, type StoredMessage, type StoredAttachment } from '@/lib/db';
import { MarkdownRenderer } from './markdown-renderer';
import { ErrorBoundary } from './error-boundary';
import { motion } from 'framer-motion';
import TextareaAutosize from 'react-textarea-autosize';
import {
  Send, StopCircle, RefreshCcw, ArrowDown, Paperclip, X,
  Pencil, Copy, Check, Trash2, Menu,
} from 'lucide-react';

async function toStoredAttachment(a: any): Promise<StoredAttachment> {
  if (a.blob instanceof Blob) {
    return { name: a.name ?? 'file', contentType: a.contentType ?? a.blob.type, blob: a.blob };
  }
  if (typeof a.url === 'string' && a.url.startsWith('data:')) {
    try {
      const res = await fetch(a.url);
      const blob = await res.blob();
      return { name: a.name ?? 'file', contentType: a.contentType ?? blob.type, blob };
    } catch {
      return { name: a.name ?? 'file', contentType: a.contentType, url: a.url };
    }
  }
  return { name: a.name ?? 'file', contentType: a.contentType, url: a.url };
}

/* ------------------------------------------------------------------ */
/* Memoized Message Item                                              */
/* ------------------------------------------------------------------ */
interface MessageItemProps {
  m: Message;
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
  onStartEdit: (m: Message) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onDraftChange: (text: string) => void;
}

const MessageItem = memo(
  function MessageItem({
    m,
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
    onStartEdit,
    onSaveEdit,
    onCancelEdit,
    onDraftChange,
  }: MessageItemProps) {
    return (
      <motion.div
        layout={animations}
        initial={animations ? { opacity: 0, y: 10 } : false}
        animate={animations ? { opacity: 1, y: 0 } : false}
        transition={{ duration: animations ? 0.2 : 0 }}
        style={{ contentVisibility: 'auto', containIntrinsicSize: '0 160px' }}
        className={`group flex w-full ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
      >
        <div
          className={`max-w-[720px] w-full p-5 rounded-2xl ${
            m.role === 'user' ? 'bg-zinc-800/80 text-zinc-100 ml-auto' : 'bg-transparent text-zinc-200'
          }`}
        >
          {m.experimental_attachments && m.experimental_attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {m.experimental_attachments.map((a: any, i: number) => (
                <div key={i} className="flex items-center gap-2">
                  {a.contentType?.startsWith('image/') ? (
                    <img
                      src={a.url}
                      alt={a.name || 'Image'}
                      className="w-40 rounded-xl object-contain bg-zinc-900 border border-zinc-700"
                    />
                  ) : (
                    <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-700 p-2.5 rounded-xl text-sm">
                      <Paperclip size={16} />
                      <span className="truncate max-w-[150px]">{a.name || 'File'}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {isEditing ? (
            <div className="space-y-2">
              <TextareaAutosize
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.nativeEvent as any).isComposing || e.keyCode === 229) return;
                  if (e.key === 'Escape') { onCancelEdit(); return; }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    if (isTouchDevice || !sendOnEnter) return;
                    e.preventDefault();
                    onSaveEdit(m.id);
                  }
                }}
                autoFocus
                minRows={1}
                maxRows={12}
                className="w-full bg-zinc-900 border border-zinc-700 rounded-xl p-3 text-sm text-zinc-100 resize-none outline-none focus:border-indigo-500/60"
              />
              <div className="flex justify-end gap-2">
                <button onClick={onCancelEdit} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 rounded-lg transition">
                  Hủy
                </button>
                <button
                  onClick={() => onSaveEdit(m.id)}
                  disabled={!draft.trim()}
                  className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded-lg disabled:opacity-40 transition"
                >
                  Lưu &amp; gửi lại
                </button>
              </div>
            </div>
          ) : m.role === 'assistant' ? (
            <div aria-live={isStreaming ? 'polite' : 'off'}>
              <ErrorBoundary>
                <MarkdownRenderer
                  content={m.content}
                  isStreaming={isStreaming}
                  throttleMs={throttleMs}
                />
              </ErrorBoundary>
            </div>
          ) : (
            <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
          )}

          {!isEditing && !isStreaming && (
            <div className="mt-3 flex items-center gap-1 transition-opacity opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-within:opacity-100">
              {m.role === 'assistant' && (
                <>
                  <button onClick={() => onCopy(m)} title="Copy" aria-label="Copy message" className="p-1.5 text-zinc-500 hover:text-zinc-200 rounded">
                    {isCopied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <button
                    onClick={() => onRegenerate(m.id)}
                    title="Tạo lại câu trả lời"
                    aria-label="Regenerate message"
                    className="p-1.5 text-zinc-500 hover:text-zinc-200 rounded disabled:opacity-40"
                  >
                    <RefreshCcw size={14} />
                  </button>
                </>
              )}
              {m.role === 'user' && (
                <>
                  <button onClick={() => onCopy(m)} title="Copy" aria-label="Copy message" className="p-1.5 text-zinc-500 hover:text-zinc-200 rounded">
                    {isCopied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <button
                    onClick={() => onStartEdit(m)}
                    title="Chỉnh sửa"
                    aria-label="Edit message"
                    className="p-1.5 text-zinc-500 hover:text-zinc-200 rounded disabled:opacity-40"
                  >
                    <Pencil size={14} />
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </motion.div>
    );
  },
  (prev, next) =>
    prev.m.id === next.m.id &&
    prev.m.content === next.m.content &&
    prev.isStreaming === next.isStreaming &&
    prev.isEditing === next.isEditing &&
    prev.isCopied === next.isCopied &&
    prev.draft === next.draft &&
    prev.isTouchDevice === next.isTouchDevice &&
    prev.sendOnEnter === next.sendOnEnter &&
    prev.animations === next.animations &&
    prev.throttleMs === next.throttleMs,
);

/* ------------------------------------------------------------------ */
/* Main ChatInterface                                                 */
/* ------------------------------------------------------------------ */
export default function ChatInterface() {
  const currentChatId = useAppStore((s) => s.currentChatId);
  const setCurrentChatId = useAppStore((s) => s.setCurrentChatId);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);

  const model = useAppStore((s) => s.settings.model);
  const temperature = useAppStore((s) => s.settings.temperature);
  const systemPrompt = useAppStore((s) => s.settings.systemPrompt);
  const apiKey = useAppStore((s) => s.settings.apiKey);
  const sendOnEnter = useAppStore((s) => s.settings.sendOnEnter);
  const throttleMs = useAppStore((s) => s.settings.perf.throttleMs);
  const animations = useAppStore((s) => s.settings.perf.animations);

  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const chatKey = currentChatId ?? draftId;
  const tabId = useRef(crypto.randomUUID());

  const [autoScroll, setAutoScroll] = useState(true);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const [previewMap, setPreviewMap] = useState<Map<File, string>>(new Map());
  const createdObjectUrls = useRef<Set<string>>(new Set());

  useEffect(() => {
    const created: string[] = [];
    const next = new Map<File, string>();
    for (const f of attachments) {
      if (!f.type.startsWith('image/')) continue;
      const url = URL.createObjectURL(f);
      created.push(url);
      next.set(f, url);
    }
    setPreviewMap(next);
    return () => {
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [attachments]);

  const MAX_TOTAL_ATTACHMENT_BYTES = 3 * 1024 * 1024; // 3MB limit để không vượt trần Vercel 4.5MB
  const MAX_FILES = 4;

  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const fileArr = Array.from(files);
    let totalSize = attachments.reduce((sum, f) => sum + f.size, 0);
    const ok: File[] = [];
    const rejected: string[] = [];

    for (const f of fileArr) {
      if (totalSize + f.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        rejected.push(f.name);
      } else {
        totalSize += f.size;
        ok.push(f);
      }
    }

    if (rejected.length) {
      setNotice(`Bỏ qua file vượt quá tổng giới hạn 3MB: ${rejected.join(', ')}`);
      setTimeout(() => setNotice(null), 4000);
    }
    setAttachments((prev) => [...prev, ...ok].slice(0, MAX_FILES));
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTop = useRef(0);
  const stick = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hydratedFor = useRef<string | null>(null);
  const titledFor = useRef<string | null>(null);
  const finishRef = useRef<'stop' | 'abort' | 'error'>('stop');
  const [isTouchDevice, setIsTouchDevice] = useState(false);

  useEffect(() => {
    setIsTouchDevice(
      typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
    );
  }, []);

  const {
    messages, setMessages, input, setInput, handleInputChange,
    handleSubmit, stop, reload, isLoading, error,
  } = useChat({
    id: chatKey,
    headers: apiKey ? { 'x-api-key': apiKey } : undefined,
    body: {
      model,
      temperature,
      system: systemPrompt,
    },
    experimental_throttle: throttleMs,
    onError: (err) => console.error('[useChat]', err),
  });

  useEffect(() => {
    if (error) finishRef.current = 'error';
  }, [error]);

  const handleStop = useCallback(() => {
    finishRef.current = 'abort';
    stop();
  }, [stop]);

  /* Hydrate lịch sử từ Dexie và quản lý vòng đời ObjectURL không rò rỉ */
  useEffect(() => {
    if (!currentChatId) {
      hydratedFor.current = null;
      setMessages([]);
      return;
    }
    if (hydratedFor.current === currentChatId) return;
    const chatId = currentChatId;
    hydratedFor.current = chatId;
    let cancelled = false;

    (async () => {
      try {
        const rows = await db.messages
          .where('[chatId+seq]')
          .between([chatId, Dexie.minKey], [chatId, Dexie.maxKey])
          .toArray();

        if (cancelled || chatId !== useAppStore.getState().currentChatId) return;

        // Dọn sạch URL cũ trước khi tạo URL mới
        createdObjectUrls.current.forEach((u) => URL.revokeObjectURL(u));
        createdObjectUrls.current.clear();

        setMessages(
          rows.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            experimental_attachments: m.attachments?.map((a) => {
              let url = a.url ?? '';
              if (a.blob) {
                url = URL.createObjectURL(a.blob);
                createdObjectUrls.current.add(url);
              }
              return {
                name: a.name,
                contentType: a.contentType,
                url,
              };
            }) as any,
          })) as Message[],
        );
      } catch (err) {
        console.error('[hydrate]', err);
      }
    })();

    return () => {
      cancelled = true;
      createdObjectUrls.current.forEach((u) => URL.revokeObjectURL(u));
      createdObjectUrls.current.clear();
    };
  }, [currentChatId, setMessages]);

  /* Idempotent Projection Persist với BroadcastChannel chống tự dội */
  useEffect(() => {
    if (isLoading || !currentChatId || !messages.length) return;
    const chatId = currentChatId;
    const reason = finishRef.current;

    (async () => {
      try {
        if (chatId !== useAppStore.getState().currentChatId) return;

        const rows: StoredMessage[] = await Promise.all(
          messages.map(async (m, i) => {
            const rawAttachments = m.experimental_attachments as any[] | undefined;
            const attachments = rawAttachments?.length
              ? await Promise.all(rawAttachments.map(toStoredAttachment))
              : undefined;

            return {
              id: m.id,
              chatId,
              role: m.role as StoredMessage['role'],
              content: m.content,
              seq: i,
              createdAt: (m.createdAt as any)?.getTime?.() ?? Date.now(),
              attachments,
              finishReason: i === messages.length - 1 ? reason : 'stop',
            };
          }),
        );

        const keep = new Set(rows.map((r) => r.id));

        await db.transaction('rw', db.messages, db.chats, async () => {
          const existing = await db.messages.where('chatId').equals(chatId).primaryKeys();
          const stale = existing.filter((id) => !keep.has(id as string));
          if (stale.length) await db.messages.bulkDelete(stale as string[]);
          await db.messages.bulkPut(rows);
          await db.chats.update(chatId, { updatedAt: Date.now() });
        });

        if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
          try {
            const bc = new BroadcastChannel('ai-chat-sync');
            bc.postMessage({ type: 'CHAT_UPDATED', chatId, from: tabId.current });
            bc.close();
          } catch {}
        }
      } catch (err: any) {
        console.error('[persist]', err);
        if (err?.name === 'QuotaExceededError') {
          setNotice('Bộ nhớ IndexedDB đã đầy. Vui lòng dọn bớt ảnh hoặc đoạn chat cũ.');
        }
      }
    })();
  }, [isLoading, messages, currentChatId]);

  /* Lắng nghe đồng bộ từ tab khác (bỏ qua nếu là chính tab mình) */
  useEffect(() => {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
    const bc = new BroadcastChannel('ai-chat-sync');
    bc.onmessage = (e) => {
      if (e.data?.from === tabId.current) return;
      if (e.data?.type === 'CHAT_UPDATED' && e.data?.chatId === currentChatId && !isLoading) {
        hydratedFor.current = null;
        void (async () => {
          const rows = await db.messages
            .where('[chatId+seq]')
            .between([currentChatId, Dexie.minKey], [currentChatId, Dexie.maxKey])
            .toArray();
          if (currentChatId === useAppStore.getState().currentChatId) {
            createdObjectUrls.current.forEach((u) => URL.revokeObjectURL(u));
            createdObjectUrls.current.clear();

            setMessages(
              rows.map((m) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                experimental_attachments: m.attachments?.map((a) => {
                  let url = a.url ?? '';
                  if (a.blob) {
                    url = URL.createObjectURL(a.blob);
                    createdObjectUrls.current.add(url);
                  }
                  return {
                    name: a.name,
                    contentType: a.contentType,
                    url,
                  };
                }) as any,
              })) as Message[],
            );
          }
        })();
      }
    };
    return () => bc.close();
  }, [currentChatId, isLoading, setMessages]);

  /* Đặt tiêu đề tự động */
  useEffect(() => {
    if (!currentChatId || isLoading || messages.length < 2) return;
    if (titledFor.current === currentChatId) return;
    titledFor.current = currentChatId;

    const firstUserMsg = messages.find((m) => m.role === 'user');
    const userPrompt = (firstUserMsg?.content || '').slice(0, 1000).trim();
    if (!userPrompt) return;

    const ctrl = new AbortController();
    (async () => {
      try {
        const chat = await db.chats.get(currentChatId);
        if (!chat || chat.title !== 'New Chat') return;
        const res = await fetch('/api/title', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'x-api-key': apiKey } : {}),
          },
          body: JSON.stringify({ message: userPrompt }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          titledFor.current = null;
          return;
        }
        const data = await res.json();
        if (data?.title) {
          await db.chats.update(currentChatId, { title: String(data.title).slice(0, 60) });
        }
      } catch (err: any) {
        titledFor.current = null;
        if (err?.name !== 'AbortError') console.error('[title]', err);
      }
    })();
    return () => {
      ctrl.abort();
    };
  }, [messages, currentChatId, isLoading, apiKey]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const up = el.scrollTop < lastTop.current - 4;
    lastTop.current = el.scrollTop;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (up) stick.current = false;
    else if (atBottom) stick.current = true;
    setAutoScroll(stick.current);
  }, []);

  useEffect(() => {
    if (!stick.current) return;
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior: isLoading ? 'auto' : 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, isLoading]);

  const scrollToBottom = useCallback(() => {
    stick.current = true;
    setAutoScroll(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, []);

  const truncateFrom = useCallback(
    async (index: number, keep: Message[]) => {
      if (currentChatId) {
        await db.messages
          .where('[chatId+seq]')
          .between([currentChatId, index], [currentChatId, Dexie.maxKey], true, true)
          .delete();
        await db.chats.update(currentChatId, { updatedAt: Date.now() });
      }
      setMessages(keep);
    },
    [currentChatId, setMessages],
  );

  const handleRegenerate = useCallback(
    async (id: string) => {
      if (isLoading) return;
      const idx = messages.findIndex((m) => m.id === id);
      if (idx < 1 || messages[idx - 1]?.role !== 'user') return;
      finishRef.current = 'stop';
      await truncateFrom(idx, messages.slice(0, idx));
      setTimeout(() => {
        void reload();
      }, 0);
    },
    [isLoading, messages, truncateFrom, reload],
  );

  const startEdit = useCallback((m: Message) => {
    setEditingId(m.id);
    setDraft(m.content);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraft('');
  }, []);

  const saveEdit = useCallback(
    async (id: string) => {
      const text = draft.trim();
      if (!text || isLoading) return;
      const idx = messages.findIndex((m) => m.id === id);
      if (idx === -1) return;
      const edited: Message = { ...messages[idx], content: text };
      finishRef.current = 'stop';
      await truncateFrom(idx, [...messages.slice(0, idx), edited]);
      setEditingId(null);
      setDraft('');
      setTimeout(() => {
        void reload();
      }, 0);
    },
    [draft, isLoading, messages, truncateFrom, reload],
  );

  const copyMessage = useCallback(async (m: Message) => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopiedId(m.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (err) {
      console.error('[copy]', err);
    }
  }, []);

  const deleteChat = useCallback(async () => {
    try {
      handleStop();
      if (currentChatId) {
        await db.transaction('rw', db.messages, db.chats, async () => {
          await db.messages.where('chatId').equals(currentChatId).delete();
          await db.chats.delete(currentChatId);
        });
      }
      hydratedFor.current = null;
      titledFor.current = null;
      setMessages([]);
      setDraftId(crypto.randomUUID());
      setCurrentChatId(null);
      setAttachments([]);
      setConfirmClear(false);
    } catch (err) {
      console.error('[deleteChat]', err);
      setConfirmClear(false);
    }
  }, [handleStop, currentChatId, setMessages, setCurrentChatId]);

  const onSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if ((!input.trim() && attachments.length === 0) || isLoading) return;

    try {
      finishRef.current = 'stop';
      let chatId = currentChatId;
      if (!chatId) {
        chatId = draftId;
        hydratedFor.current = chatId;
        await db.chats.put({
          id: chatId,
          title: 'New Chat',
          pinned: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        setCurrentChatId(chatId);
      }

      const dataTransfer = new DataTransfer();
      attachments.forEach((f) => dataTransfer.items.add(f));
      const options = attachments.length ? { experimental_attachments: dataTransfer.files } : undefined;

      setAttachments([]);
      handleSubmit(undefined, options);
    } catch (err) {
      console.error('[onSubmit]', err);
    }
  };

  const onTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as any).isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { handleStop(); return; }
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (isTouchDevice || !sendOnEnter) return;
    e.preventDefault();
    void onSubmit();
  };

  const lastMessageId = messages[messages.length - 1]?.id;
  const hasMessages = messages.length > 0;

  const suggestions = useMemo(
    () => ['Explain quantum computing', 'Write a Python script for scraping', 'Plan a healthy meal', 'Summarize an article'],
    [],
  );

  return (
    <div className="flex-1 flex flex-col relative h-[100dvh]">
      <div className="absolute top-0 left-0 right-0 z-20 p-3 flex items-center justify-between pointer-events-none">
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open sidebar menu"
          className="md:hidden pointer-events-auto p-2 bg-zinc-900/80 border border-zinc-800 text-zinc-400 hover:text-zinc-200 rounded-xl backdrop-blur-sm transition-colors shadow-sm"
        >
          <Menu size={18} />
        </button>

        {hasMessages && (
          <div className="ml-auto pointer-events-auto flex items-center gap-2">
            {confirmClear ? (
              <div className="flex items-center gap-1.5 bg-zinc-900/90 border border-zinc-800 rounded-xl p-1 backdrop-blur-sm shadow-lg">
                <button onClick={deleteChat} className="px-2.5 py-1 text-xs text-red-400 hover:bg-red-950/50 rounded-lg transition font-medium">
                  Xóa hẳn
                </button>
                <button onClick={() => setConfirmClear(false)} className="px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 rounded-lg transition">
                  Hủy
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmClear(true)}
                title="Xóa cuộc trò chuyện này"
                aria-label="Delete chat conversation"
                className="p-2 text-zinc-500 hover:text-red-400 hover:bg-zinc-900/80 border border-transparent hover:border-zinc-800 rounded-xl transition-all"
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 pb-40 pt-14 md:pt-8"
      >
        {!hasMessages ? (
          <div className="flex flex-col items-center justify-center h-full pt-10 space-y-8">
            <div className="w-16 h-16 bg-indigo-500/10 rounded-2xl flex items-center justify-center text-indigo-500 mb-4">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h1 className="text-2xl font-medium text-zinc-200">How can I help you today?</h1>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-2xl">
              {suggestions.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => setInput(prompt)}
                  className="p-4 text-left border border-zinc-800 rounded-xl hover:bg-zinc-900 transition-all text-sm text-zinc-400 hover:text-zinc-200"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {messages.map((m) => (
              <MessageItem
                key={m.id}
                m={m}
                isStreaming={isLoading && m.role === 'assistant' && m.id === lastMessageId}
                isEditing={editingId === m.id}
                isCopied={copiedId === m.id}
                draft={editingId === m.id ? draft : ''}
                isTouchDevice={isTouchDevice}
                sendOnEnter={sendOnEnter}
                throttleMs={throttleMs}
                animations={animations}
                onCopy={copyMessage}
                onRegenerate={handleRegenerate}
                onStartEdit={startEdit}
                onSaveEdit={saveEdit}
                onCancelEdit={cancelEdit}
                onDraftChange={setDraft}
              />
            ))}

            {isLoading && messages[messages.length - 1]?.role === 'user' && (
              <div className="flex justify-start">
                <div className="max-w-[720px] p-5">
                  <span className="inline-block w-2 h-4 bg-indigo-500 animate-pulse" />
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="max-w-[720px] p-4 bg-red-950/50 border border-red-900 text-red-400 rounded-xl mx-auto flex items-center justify-between">
            <span>{error.message || 'An error occurred.'}</span>
            <button onClick={() => reload()} className="px-3 py-1 bg-red-900/50 rounded hover:bg-red-800 transition">
              Thử lại
            </button>
          </div>
        )}
      </div>

      {!autoScroll && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          className="absolute bottom-32 left-1/2 -translate-x-1/2 p-2 bg-zinc-800 text-zinc-300 rounded-full shadow-lg border border-zinc-700 hover:bg-zinc-700 transition"
        >
          <ArrowDown size={18} />
        </button>
      )}

      {/* Input container */}
      <div className="absolute bottom-0 left-0 right-0 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent pt-10">
        <div className="max-w-[720px] mx-auto relative">
          {notice && (
            <div className="mb-2 p-2.5 bg-amber-950/80 border border-amber-800/80 rounded-xl text-xs text-amber-300 flex items-center justify-between shadow-lg">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice(null)} className="p-1 hover:text-amber-100 transition">
                <X size={14} />
              </button>
            </div>
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2 p-2 bg-zinc-900/80 border border-zinc-800 rounded-xl backdrop-blur-sm">
              {attachments.map((file, i) => {
                const previewUrl = previewMap.get(file);
                return (
                  <div key={`${file.name}-${i}`} className="relative flex items-center gap-2 bg-zinc-800 p-2 rounded-lg text-xs text-zinc-300">
                    {previewUrl ? (
                      <img src={previewUrl} alt={file.name} className="w-8 h-8 object-cover rounded" />
                    ) : (
                      <Paperclip size={14} className="text-zinc-500" />
                    )}
                    <span className="truncate max-w-[120px]">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      aria-label="Remove attachment"
                      className="absolute -top-1.5 -right-1.5 bg-zinc-700 hover:bg-zinc-600 rounded-full p-0.5"
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <form
            onSubmit={onSubmit}
            className="relative bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden focus-within:border-indigo-500/50 transition-colors shadow-sm"
          >
            <input
              type="file"
              multiple
              className="hidden"
              ref={fileInputRef}
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach files"
              className="absolute left-3 bottom-3 p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-xl transition-colors"
            >
              <Paperclip size={18} />
            </button>

            <TextareaAutosize
              value={input}
              onChange={handleInputChange}
              onKeyDown={onTextareaKeyDown}
              enterKeyHint={isTouchDevice ? 'enter' : 'send'}
              autoCapitalize="sentences"
              spellCheck={false}
              placeholder="Gửi tin nhắn..."
              className="w-full max-h-[200px] bg-transparent text-zinc-100 placeholder:text-zinc-600 resize-none outline-none p-4 pl-14 pr-16 py-5"
              minRows={1}
              maxRows={8}
            />

            <div className="absolute right-3 bottom-3 flex items-center gap-2">
              {isLoading ? (
                <button type="button" onClick={handleStop} aria-label="Stop generation" className="p-2 bg-zinc-800 text-zinc-300 rounded-xl hover:text-red-400 transition-colors">
                  <StopCircle size={18} />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim() && attachments.length === 0}
                  aria-label="Send message"
                  className="p-2 bg-indigo-600 text-white rounded-xl disabled:opacity-50 disabled:bg-zinc-800 transition-colors"
                >
                  <Send size={18} />
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}