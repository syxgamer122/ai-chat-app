'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat, type Message } from 'ai/react';
import { useAppStore } from '@/lib/store';
import { db } from '@/lib/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { MarkdownRenderer } from './markdown-renderer';
import { motion, AnimatePresence } from 'framer-motion';
import TextareaAutosize from 'react-textarea-autosize';
import {
  Send, StopCircle, RefreshCcw, ArrowDown, Paperclip, X,
  Pencil, Copy, Check, Trash2,
} from 'lucide-react';

export default function ChatInterface() {
  const { currentChatId, settings, setCurrentChatId } = useAppStore();

  const [autoScroll, setAutoScroll] = useState(true);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** chat đã nạp từ Dexie -> chống ghi đè luồng stream */
  const hydratedFor = useRef<string | null>(null);

  const dbMessages = useLiveQuery(
    () =>
      currentChatId
        ? db.messages.where('chatId').equals(currentChatId).sortBy('createdAt')
        : [],
    [currentChatId],
  );

  const {
    messages, setMessages, input, setInput, handleInputChange,
    handleSubmit, stop, reload, isLoading, error,
  } = useChat({
    id: currentChatId || 'new',
    body: {
      model: settings.model,
      temperature: settings.temperature,
      system: settings.systemPrompt,
    },
    // Có ở @ai-sdk/react >= 3.4; phiên bản cũ bỏ qua vô hại.
    experimental_throttle: 50,
    onFinish: async (message) => {
      try {
        if (!currentChatId) return;
        await db.messages.put({ ...message, chatId: currentChatId, createdAt: Date.now() });
        await db.chats.update(currentChatId, { updatedAt: Date.now() });
      } catch (err) {
        console.error('[onFinish] persist failed:', err);
      }
    },
    onError: (err) => console.error('[useChat]', err),
  });

  /* ---------------------------------------------------------------- */
  /* Nạp lịch sử từ Dexie đúng MỘT lần cho mỗi chat                    */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    if (!currentChatId) {
      hydratedFor.current = null;
      setMessages([]);
      return;
    }
    if (hydratedFor.current === currentChatId) return; // đã nạp -> không đụng vào
    if (!dbMessages) return;                            // Dexie chưa trả kết quả
    hydratedFor.current = currentChatId;
    setMessages(dbMessages as Message[]);
  }, [currentChatId, dbMessages, setMessages]);

  /* Đặt tiêu đề tự động */
  useEffect(() => {
    if (messages.length !== 2 || !currentChatId) return;
    (async () => {
      try {
        const chat = await db.chats.get(currentChatId);
        if (!chat || chat.title !== 'New Chat') return;
        const res = await fetch('/api/title', {
          method: 'POST',
          body: JSON.stringify({ message: messages[0].content }),
        });
        const data = await res.json();
        if (data?.title) await db.chats.update(currentChatId, { title: data.title });
      } catch (err) {
        console.error('[title]', err);
      }
    })();
  }, [messages, currentChatId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && autoScroll) el.scrollTop = el.scrollHeight;
  }, [messages, autoScroll]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop <= el.clientHeight + 50);
  };

  /* ---------------------------------------------------------------- */
  /* Helper: cắt hội thoại từ index -> Dexie + state                   */
  /* ---------------------------------------------------------------- */
  const truncateFrom = useCallback(
    async (index: number, keep: Message[]) => {
      const removed = messages.slice(index);
      if (currentChatId && removed.length) {
        await db.messages.bulkDelete(removed.map((m) => m.id));
        await db.chats.update(currentChatId, { updatedAt: Date.now() });
      }
      setMessages(keep);
      // Nhường 1 frame để messagesRef của SDK chắc chắn đã đồng bộ.
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    },
    [messages, currentChatId, setMessages],
  );

  /* 1. REGENERATE ---------------------------------------------------- */
  const handleRegenerate = useCallback(
    async (id: string) => {
      if (isLoading) return;
      try {
        const idx = messages.findIndex((m) => m.id === id);
        if (idx < 1) return; // phải có tin nhắn user phía trước
        await truncateFrom(idx, messages.slice(0, idx));
        // Lúc này tin nhắn cuối là của user -> reload() gửi lại nguyên trạng.
        await reload();
      } catch (err) {
        console.error('[regenerate]', err);
      }
    },
    [isLoading, messages, truncateFrom, reload],
  );

  /* 2. EDIT MESSAGE -------------------------------------------------- */
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
      try {
        const idx = messages.findIndex((m) => m.id === id);
        if (idx === -1) return;

        // Giữ nguyên attachments Base64 của tin nhắn gốc.
        const edited: Message = { ...messages[idx], content: text };

        await truncateFrom(idx, [...messages.slice(0, idx), edited]);
        if (currentChatId) {
          await db.messages.put({ ...edited, chatId: currentChatId, createdAt: Date.now() });
        }
        setEditingId(null);
        setDraft('');
        await reload();
      } catch (err) {
        console.error('[saveEdit]', err);
        setEditingId(null);
      }
    },
    [draft, isLoading, messages, truncateFrom, currentChatId, reload],
  );

  /* 3. COPY ---------------------------------------------------------- */
  const copyMessage = useCallback(async (m: Message) => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopiedId(m.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (err) {
      console.error('[copy]', err);
    }
  }, []);

  /* 4. CLEAR / DELETE CHAT ------------------------------------------ */
  const clearChat = useCallback(async () => {
    try {
      stop();
      if (currentChatId) {
        await db.messages.where('chatId').equals(currentChatId).delete();
        await db.chats.delete(currentChatId);
      }
      hydratedFor.current = null;
      setMessages([]);
      setCurrentChatId(null);
      setAttachments([]);
      setConfirmClear(false);
    } catch (err) {
      console.error('[clearChat]', err);
      setConfirmClear(false);
    }
  }, [stop, currentChatId, setMessages, setCurrentChatId]);

  /* ---------------------------------------------------------------- */
  /* Gửi tin nhắn                                                      */
  /* ---------------------------------------------------------------- */
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && attachments.length === 0) || isLoading) return;

    try {
      let chatId = currentChatId;
      if (!chatId) {
        chatId = crypto.randomUUID();
        hydratedFor.current = chatId; // chặn effect hydrate ghi đè stream
        setCurrentChatId(chatId);
        await db.chats.put({
          id: chatId, title: 'New Chat', pinned: false,
          createdAt: Date.now(), updatedAt: Date.now(),
        });
      }

      const processedAttachments = await Promise.all(
        attachments.map(
          (file) =>
            new Promise<{ name: string; contentType: string; url: string }>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = (ev) =>
                resolve({ name: file.name, contentType: file.type, url: ev.target?.result as string });
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(file);
            }),
        ),
      );

      await db.messages.put({
        id: crypto.randomUUID(),
        chatId,
        role: 'user',
        content: input,
        createdAt: Date.now(),
        experimental_attachments: processedAttachments.length ? processedAttachments : undefined,
      });

      const dataTransfer = new DataTransfer();
      attachments.forEach((f) => dataTransfer.items.add(f));
      const options = attachments.length ? { experimental_attachments: dataTransfer.files } : undefined;

      setAttachments([]);
      handleSubmit(e, options);
    } catch (err) {
      console.error('[onSubmit]', err);
    }
  };

  const lastMessageId = messages[messages.length - 1]?.id;
  const hasMessages = messages.length > 0;

  const suggestions = useMemo(
    () => ['Explain quantum computing', 'Write a Python script for scraping', 'Plan a healthy meal', 'Summarize an article'],
    [],
  );

  return (
    <div className="flex-1 flex flex-col relative h-full">
      {/* HEADER: Clear chat */}
      {hasMessages && (
        <div className="absolute top-0 right-0 z-20 p-3 flex items-center gap-2">
          {confirmClear ? (
            <div className="flex items-center gap-1.5 bg-zinc-900/90 border border-zinc-800 rounded-xl p-1 backdrop-blur-sm">
              <button onClick={clearChat} className="px-2.5 py-1 text-xs text-red-400 hover:bg-red-950/50 rounded-lg transition">
                Xóa hẳn
              </button>
              <button onClick={() => setConfirmClear(false)} className="px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 rounded-lg transition">
                Hủy
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              title="Xóa đoạn hội thoại"
              className="p-2 text-zinc-500 hover:text-red-400 hover:bg-zinc-900 rounded-xl transition-colors"
            >
              <Trash2 size={18} />
            </button>
          )}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 pb-40 scroll-smooth"
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
          <AnimatePresence initial={false}>
            {messages.map((m) => {
              const streamingThis = isLoading && m.role === 'assistant' && m.id === lastMessageId;
              const isEditing = editingId === m.id;

              return (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                  style={{ contain: 'layout style' }}
                  className={`group flex w-full ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[720px] w-full p-5 rounded-2xl ${
                      m.role === 'user' ? 'bg-zinc-800/80 text-zinc-100 ml-auto' : 'bg-transparent text-zinc-200'
                    }`}
                  >
                    {/* Attachments (Base64) */}
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

                    {/* Nội dung */}
                    {isEditing ? (
                      <div className="space-y-2">
                        <TextareaAutosize
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              void saveEdit(m.id);
                            }
                            if (e.key === 'Escape') cancelEdit();
                          }}
                          autoFocus
                          minRows={1}
                          maxRows={12}
                          className="w-full bg-zinc-900 border border-zinc-700 rounded-xl p-3 text-sm text-zinc-100 resize-none outline-none focus:border-indigo-500/60"
                        />
                        <div className="flex justify-end gap-2">
                          <button onClick={cancelEdit} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 rounded-lg transition">
                            Hủy
                          </button>
                          <button
                            onClick={() => saveEdit(m.id)}
                            disabled={!draft.trim()}
                            className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded-lg disabled:opacity-40 transition"
                          >
                            Lưu &amp; gửi lại
                          </button>
                        </div>
                      </div>
                    ) : m.role === 'assistant' ? (
                      <MarkdownRenderer
                        content={m.content}
                        isStreaming={streamingThis}
                        throttleMs={settings.perf?.throttleMs ?? 150}
                      />
                    ) : (
                      <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                    )}

                    {/* Thanh hành động — dùng group-hover, không phải hover trên chính nó */}
                    {!isEditing && !streamingThis && (
                      <div className="mt-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        {m.role === 'assistant' && (
                          <>
                            <button onClick={() => copyMessage(m)} title="Copy" className="p-1.5 text-zinc-500 hover:text-zinc-200 rounded">
                              {copiedId === m.id ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                            <button
                              onClick={() => handleRegenerate(m.id)}
                              disabled={isLoading}
                              title="Tạo lại câu trả lời"
                              className="p-1.5 text-zinc-500 hover:text-zinc-200 rounded disabled:opacity-40"
                            >
                              <RefreshCcw size={14} />
                            </button>
                          </>
                        )}
                        {m.role === 'user' && (
                          <>
                            <button onClick={() => copyMessage(m)} title="Copy" className="p-1.5 text-zinc-500 hover:text-zinc-200 rounded">
                              {copiedId === m.id ? <Check size={14} /> : <Copy size={14} />}
                            </button>
                            <button
                              onClick={() => startEdit(m)}
                              disabled={isLoading}
                              title="Chỉnh sửa"
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
            })}

            {isLoading && messages[messages.length - 1]?.role === 'user' && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
                <div className="max-w-[720px] p-5">
                  <span className="inline-block w-2 h-4 bg-indigo-500 animate-pulse" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
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
          onClick={() => setAutoScroll(true)}
          className="absolute bottom-32 left-1/2 -translate-x-1/2 p-2 bg-zinc-800 text-zinc-300 rounded-full shadow-lg border border-zinc-700 hover:bg-zinc-700 transition"
        >
          <ArrowDown size={18} />
        </button>
      )}

      <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent pt-10">
        <div className="max-w-[720px] mx-auto relative">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2 p-2 bg-zinc-900/80 border border-zinc-800 rounded-xl backdrop-blur-sm">
              {attachments.map((file, i) => (
                <div key={`${file.name}-${i}`} className="relative flex items-center gap-2 bg-zinc-800 p-2 rounded-lg text-xs text-zinc-300">
                  {file.type.startsWith('image/') ? (
                    <img src={URL.createObjectURL(file)} alt={file.name} className="w-8 h-8 object-cover rounded" />
                  ) : (
                    <Paperclip size={14} className="text-zinc-500" />
                  )}
                  <span className="truncate max-w-[120px]">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                    className="absolute -top-1.5 -right-1.5 bg-zinc-700 hover:bg-zinc-600 rounded-full p-0.5"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
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
                if (e.target.files) setAttachments((prev) => [...prev, ...Array.from(e.target.files!)]);
                e.target.value = '';
              }}
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="absolute left-3 bottom-3 p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-xl transition-colors"
            >
              <Paperclip size={18} />
            </button>

            <TextareaAutosize
              value={input}
              onChange={handleInputChange}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit(e as unknown as React.FormEvent);
                }
              }}
              placeholder="Gửi tin nhắn..."
              className="w-full max-h-[200px] bg-transparent text-zinc-100 placeholder:text-zinc-600 resize-none outline-none p-4 pl-14 pr-16 py-5"
              minRows={1}
              maxRows={8}
            />

            <div className="absolute right-3 bottom-3 flex items-center gap-2">
              {isLoading ? (
                <button type="button" onClick={stop} className="p-2 bg-zinc-800 text-zinc-300 rounded-xl hover:text-red-400 transition-colors">
                  <StopCircle size={18} />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim() && attachments.length === 0}
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