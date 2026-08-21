'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat, type Message } from 'ai/react';
import { useVirtualizer } from '@tanstack/react-virtual';
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

const attachmentCache = new WeakMap<object, StoredAttachment>();

async function toStoredAttachment(a: any): Promise<StoredAttachment> {
  if (typeof a === 'object' && a !== null && attachmentCache.has(a)) {
    return attachmentCache.get(a)!;
  }

  const name = a.name ?? 'file';
  const contentType = a.contentType ?? '';

  let stored: StoredAttachment;

  if (a.blob instanceof Blob) {
    stored = {
      name,
      contentType: contentType || a.blob.type,
      blob: a.blob,
    };
  } else {
    const url = typeof a.url === 'string' ? a.url : '';

    if (url.startsWith('data:') || url.startsWith('blob:')) {
      try {
        const response = await fetch(url);
        const blob = await response.blob();
        stored = {
          name,
          contentType: contentType || blob.type,
          blob,
        };
      } catch {
        stored = { name, contentType };
      }
    } else if (/^https?:\/\//i.test(url)) {
      stored = { name, contentType, url };
    } else {
      stored = { name, contentType };
    }
  }

  if (typeof a === 'object' && a !== null) {
    attachmentCache.set(a, stored);
  }
  return stored;
}

function revokeObjectUrls(urls: Set<string>) {
  for (const url of urls) {
    URL.revokeObjectURL(url);
  }
  urls.clear();
}

function createAttachmentUrl(attachment: StoredAttachment, urls: Set<string>): string {
  if (attachment.blob) {
    const url = URL.createObjectURL(attachment.blob);
    urls.add(url);
    return url;
  }
  return attachment.url ?? '';
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
    const shouldAnimateLayout = animations && !isStreaming;

    return (
      <motion.div
        layout={shouldAnimateLayout}
        initial={shouldAnimateLayout ? { opacity: 0, y: 10 } : false}
        animate={shouldAnimateLayout ? { opacity: 1, y: 0 } : false}
        transition={{ duration: shouldAnimateLayout ? 0.2 : 0 }}
        style={{ contentVisibility: 'auto', containIntrinsicSize: '0 160px' }}
        className={`group flex w-full ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
      >
        <div
          className={`relative max-w-[85%] rounded-2xl px-4 py-3 shadow-sm md:max-w-[75%] ${
            m.role === 'user'
              ? 'bg-blue-600 text-white rounded-br-none'
              : 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100 rounded-bl-none border border-zinc-200/50 dark:border-zinc-700/50'
          }`}
        >
          {/* File Attachments */}
          {m.experimental_attachments && m.experimental_attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {m.experimental_attachments.map((att, idx) => (
                <div key={idx} className="relative overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
                  {att.contentType?.startsWith('image/') ? (
                    <img
                      src={att.url}
                      alt={att.name ?? 'attachment'}
                      className="max-h-48 max-w-xs object-cover rounded-md"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex items-center gap-2 bg-black/5 p-2 text-xs dark:bg-white/5">
                      <Paperclip className="h-4 w-4" />
                      <span className="truncate max-w-[150px]">{att.name}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Nội dung tin nhắn / Chỉnh sửa */}
          {isEditing ? (
            <div className="flex flex-col gap-2 min-w-[240px]">
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
                className="w-full resize-none rounded-lg bg-white p-2 text-sm text-zinc-900 outline-none ring-2 ring-blue-500 dark:bg-zinc-900 dark:text-zinc-100"
                autoFocus
              />
              <div className="flex justify-end gap-2 text-xs">
                <button
                  onClick={onCancelEdit}
                  className="rounded px-2.5 py-1 text-zinc-500 hover:bg-black/5 dark:hover:bg-white/5"
                >
                  Hủy
                </button>
                <button
                  onClick={() => onSaveEdit(m.id)}
                  className="rounded bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-700"
                >
                  Lưu & Gửi lại
                </button>
              </div>
            </div>
          ) : (
            <ErrorBoundary>
              <MarkdownRenderer
                content={m.content}
                isStreaming={isStreaming}
                throttleMs={throttleMs}
              />
            </ErrorBoundary>
          )}

          {/* Action toolbar */}
          {!isEditing && (
            <div
              className={`mt-2 flex items-center gap-1 text-xs opacity-0 transition-opacity group-hover:opacity-100 ${
                isTouchDevice ? 'opacity-100' : ''
              } ${m.role === 'user' ? 'justify-end text-blue-100' : 'justify-start text-zinc-400'}`}
            >
              <button
                onClick={() => onCopy(m)}
                title="Sao chép nội dung"
                className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
              >
                {isCopied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              </button>

              {m.role === 'user' && (
                <button
                  onClick={() => onStartEdit(m)}
                  title="Chỉnh sửa và gửi lại"
                  className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}

              {m.role === 'assistant' && (
                <button
                  onClick={() => onRegenerate(m.id)}
                  title="Tạo lại câu trả lời"
                  className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                </button>
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
    prev.m.role === next.m.role &&
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
/* Subcomponent 1: Memoized ChatHeader                                 */
/* ------------------------------------------------------------------ */
interface ChatHeaderProps {
  hasMessages: boolean;
  confirmClear: boolean;
  onSetConfirmClear: (val: boolean) => void;
  onDeleteChat: () => void;
  onOpenSidebar: () => void;
}

const ChatHeader = memo(function ChatHeader({
  hasMessages,
  confirmClear,
  onSetConfirmClear,
  onDeleteChat,
  onOpenSidebar,
}: ChatHeaderProps) {
  return (
    <div className="absolute top-0 left-0 right-0 z-20 p-3 flex items-center justify-between pointer-events-none">
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label="Open sidebar menu"
        className="md:hidden pointer-events-auto p-2 bg-zinc-900/80 border border-zinc-800 text-zinc-400 hover:text-zinc-200 rounded-xl backdrop-blur-sm transition-colors shadow-sm"
      >
        <Menu size={18} />
      </button>

      {hasMessages && (
        <div className="ml-auto pointer-events-auto flex items-center gap-2">
          {confirmClear ? (
            <div className="flex items-center gap-1.5 bg-zinc-900/90 border border-zinc-800 rounded-xl p-1 backdrop-blur-sm shadow-lg">
              <button
                onClick={onDeleteChat}
                className="px-2.5 py-1 text-xs text-red-400 hover:bg-red-950/50 rounded-lg transition font-medium"
              >
                Xóa hẳn
              </button>
              <button
                onClick={() => onSetConfirmClear(false)}
                className="px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 rounded-lg transition"
              >
                Hủy
              </button>
            </div>
          ) : (
            <button
              onClick={() => onSetConfirmClear(true)}
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
  );
});

/* ------------------------------------------------------------------ */
/* Subcomponent 2: Memoized MessageList with Virtualization           */
/* ------------------------------------------------------------------ */
interface MessageListProps {
  messages: Message[];
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
  autoScroll: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onScrollToBottom: () => void;
  onCopy: (m: Message) => void;
  onRegenerate: (id: string) => void;
  onStartEdit: (m: Message) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onDraftChange: (text: string) => void;
  onSelectSuggestion: (prompt: string) => void;
  onReload: () => void;
}

const MessageList = memo(function MessageList({
  messages,
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
  autoScroll,
  scrollRef,
  onScroll,
  onScrollToBottom,
  onCopy,
  onRegenerate,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDraftChange,
  onSelectSuggestion,
  onReload,
}: MessageListProps) {
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 140,
    overscan: 5,
    getItemKey: (index) => messages[index]?.id ?? index,
  });

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
                  onClick={() => onSelectSuggestion(prompt)}
                  className="p-4 text-left border border-zinc-800 rounded-xl hover:bg-zinc-900 transition-all text-sm text-zinc-400 hover:text-zinc-200"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
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
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                    paddingBottom: '1.5rem',
                  }}
                >
                  <MessageItem
                    m={m}
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
                    onStartEdit={onStartEdit}
                    onSaveEdit={onSaveEdit}
                    onCancelEdit={onCancelEdit}
                    onDraftChange={onDraftChange}
                  />
                </div>
              );
            })}

            {isLoading && messages[messages.length - 1]?.role === 'user' && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${rowVirtualizer.getTotalSize()}px)`,
                }}
                className="flex justify-start"
              >
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
            <button onClick={onReload} className="px-3 py-1 bg-red-900/50 rounded hover:bg-red-800 transition">
              Thử lại
            </button>
          </div>
        )}
      </div>

      {!autoScroll && (
        <button
          type="button"
          onClick={onScrollToBottom}
          aria-label="Scroll to bottom"
          className="absolute bottom-32 left-1/2 -translate-x-1/2 p-2 bg-zinc-800 text-zinc-300 rounded-full shadow-lg border border-zinc-700 hover:bg-zinc-700 transition"
        >
          <ArrowDown size={18} />
        </button>
      )}
    </>
  );
});

/* ------------------------------------------------------------------ */
/* Subcomponent 3: Memoized ChatComposer                               */
/* ------------------------------------------------------------------ */
interface ChatComposerProps {
  input: string;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement> | React.ChangeEvent<HTMLInputElement>) => void;
  onTextareaKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (e?: React.FormEvent) => void;
  isLoading: boolean;
  handleStop: () => void;
  notice: string | null;
  onClearNotice: () => void;
  attachments: File[];
  addFiles: (files: FileList | File[] | null) => void;
  removeAttachment: (index: number) => void;
  previewMap: Map<File, string>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  isTouchDevice: boolean;
}

const ChatComposer = memo(function ChatComposer({
  input,
  handleInputChange,
  onTextareaKeyDown,
  onSubmit,
  isLoading,
  handleStop,
  notice,
  onClearNotice,
  attachments,
  addFiles,
  removeAttachment,
  previewMap,
  fileInputRef,
  isTouchDevice,
}: ChatComposerProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent pt-10">
      <div className="max-w-[720px] mx-auto relative">
        {notice && (
          <div className="mb-2 p-2.5 bg-amber-950/80 border border-amber-800/80 rounded-xl text-xs text-amber-300 flex items-center justify-between shadow-lg">
            <span>{notice}</span>
            <button type="button" onClick={onClearNotice} className="p-1 hover:text-amber-100 transition">
              <X size={14} />
            </button>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 p-2 bg-zinc-900/80 border border-zinc-800 rounded-xl backdrop-blur-sm">
            {attachments.map((file, i) => {
              const isImage = file.type.startsWith('image/');
              const previewUrl = previewMap.get(file);
              return (
                <div key={`${file.name}-${i}`} className="relative flex items-center gap-2 bg-zinc-800 p-2 rounded-lg text-xs text-zinc-300">
                  {isImage && previewUrl ? (
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
            ref={fileInputRef as any}
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
              <button
                type="button"
                onClick={handleStop}
                aria-label="Stop generation"
                className="p-2 bg-zinc-800 text-zinc-300 rounded-xl hover:text-red-400 transition-colors"
              >
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
  );
});

/* ------------------------------------------------------------------ */
/* Main ChatInterface Orchestrator                                     */
/* ------------------------------------------------------------------ */
export default function ChatInterface() {
  const currentChatId = useAppStore((s) => s.currentChatId);
  const setCurrentChatId = useAppStore((s) => s.setCurrentChatId);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);

  const model = useAppStore((s) => s.settings.model);
  const temperature = useAppStore((s) => s.settings.temperature);
  const systemPrompt = useAppStore((s) => s.settings.systemPrompt);
  const apiKey = useAppStore((s) => s.settings.apiKey);
  const accessCode = useAppStore((s) => s.settings.accessCode);
  const sendOnEnter = useAppStore((s) => s.settings.sendOnEnter);
  const throttleMs = useAppStore((s) => s.settings.perf.throttleMs);
  const animations = useAppStore((s) => s.settings.perf.animations);

  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const chatKey = currentChatId ?? draftId;
  const tabId = useRef(crypto.randomUUID());
  const requestEpoch = useRef(0);
  const previousChatId = useRef<string | null>(currentChatId);
  const messageRowsCache = useRef<Map<string, { content: string; finishReason: string; row: StoredMessage }>>(new Map());
  const broadcastRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
    const channel = new BroadcastChannel('ai-chat-sync');
    broadcastRef.current = channel;
    return () => {
      channel.close();
      broadcastRef.current = null;
    };
  }, []);

  const notifyChatUpdated = useCallback((chatId: string) => {
    try {
      broadcastRef.current?.postMessage({
        type: 'CHAT_UPDATED',
        chatId,
        from: tabId.current,
      });
    } catch {}
  }, []);

  const [autoScroll, setAutoScroll] = useState(true);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((message: string, duration = 4000) => {
    setNotice(message);
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
    }
    noticeTimer.current = setTimeout(() => {
      setNotice(null);
      noticeTimer.current = null;
    }, duration);
  }, []);

  const onClearNotice = useCallback(() => {
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    setNotice(null);
  }, []);

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

  const MAX_TOTAL_ATTACHMENT_BYTES = 3 * 1024 * 1024;
  const MAX_FILES = 4;

  const addFiles = useCallback((files: FileList | File[] | null) => {
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
      showNotice(`Bỏ qua file vượt quá tổng giới hạn 3MB: ${rejected.join(', ')}`);
    }
    setAttachments((prev) => [...prev, ...ok].slice(0, MAX_FILES));
  }, [attachments, showNotice]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef<number | null>(null);
  const lastTop = useRef(0);
  const stick = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hydratedFor = useRef<string | null>(null);
  const titledFor = useRef<string | null>(null);
  const finishRef = useRef<'stop' | 'abort' | 'error'>('stop');
  const [isTouchDevice, setIsTouchDevice] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia('(pointer: coarse)');
    const update = () => setIsTouchDevice(media.matches);
    update();

    media.addEventListener?.('change', update);
    return () => {
      media.removeEventListener?.('change', update);
    };
  }, []);

  const {
    messages, setMessages, input, setInput, handleInputChange,
    handleSubmit, stop, reload, isLoading, error, data,
  } = useChat({
    id: chatKey,
    headers: {
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...(accessCode ? { 'x-access-code': accessCode } : {}),
    },
    body: {
      model,
      temperature,
      system: systemPrompt,
    },
    experimental_throttle: throttleMs,
    onError: (err) => console.error('[useChat]', err),
  });

  useEffect(() => {
    if (previousChatId.current !== currentChatId) {
      requestEpoch.current++;
      if (isLoading) {
        finishRef.current = 'abort';
        stop();
      }
      previousChatId.current = currentChatId;
    }
  }, [currentChatId, isLoading, stop]);

  useEffect(() => {
    if (error) finishRef.current = 'error';
  }, [error]);

  useEffect(() => {
    if (!data?.length) return;
    const lastData = data[data.length - 1] as any;
    if (lastData?.type === 'generation-error') {
      finishRef.current = 'error';
      showNotice(lastData.message || 'Kết nối AI bị gián đoạn giữa chừng.');
    }
  }, [data, showNotice]);

  const handleStop = useCallback(() => {
    finishRef.current = 'abort';
    stop();
  }, [stop]);

  useEffect(() => {
    if (!currentChatId) {
      hydratedFor.current = null;
      setMessages([]);
      return;
    }
    if (hydratedFor.current === currentChatId) return;
    const chatId = currentChatId;
    hydratedFor.current = chatId;
    const epoch = requestEpoch.current;
    let cancelled = false;

    (async () => {
      try {
        const rows = await db.messages
          .where('[chatId+seq]')
          .between([chatId, Dexie.minKey], [chatId, Dexie.maxKey])
          .toArray();

        if (cancelled || epoch !== requestEpoch.current || chatId !== useAppStore.getState().currentChatId) return;

        revokeObjectUrls(createdObjectUrls.current);

        setMessages(
          rows.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            experimental_attachments: m.attachments?.map((a) => ({
              name: a.name,
              contentType: a.contentType,
              url: createAttachmentUrl(a, createdObjectUrls.current),
            })) as any,
          })) as Message[],
        );
      } catch (err) {
        console.error('[hydrate]', err);
      }
    })();

    return () => {
      cancelled = true;
      revokeObjectUrls(createdObjectUrls.current);
    };
  }, [currentChatId, setMessages]);

  useEffect(() => {
    return () => {
      revokeObjectUrls(createdObjectUrls.current);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    };
  }, []);

  useEffect(() => {
    if (isLoading || !currentChatId || !messages.length) return;
    const chatId = currentChatId;
    const reason = finishRef.current;
    const epoch = requestEpoch.current;

    (async () => {
      try {
        if (epoch !== requestEpoch.current || chatId !== useAppStore.getState().currentChatId) return;

        const baseTime = Date.now();

        const rows: StoredMessage[] = await Promise.all(
          messages.map(async (m, i) => {
            const isLast = i === messages.length - 1;
            const itemReason = isLast ? reason : 'stop';
            const cacheKey = `${chatId}:${m.id}`;
            const cached = messageRowsCache.current.get(cacheKey);

            if (cached && cached.content === m.content && cached.finishReason === itemReason) {
              return { ...cached.row, seq: i };
            }

            const rawAttachments = m.experimental_attachments as any[] | undefined;
            const attachments = rawAttachments?.length
              ? await Promise.all(rawAttachments.map(toStoredAttachment))
              : undefined;

            const createdAt =
              typeof m.createdAt === 'number'
                ? m.createdAt
                : m.createdAt instanceof Date
                  ? m.createdAt.getTime()
                  : baseTime + i;

            const row: StoredMessage = {
              id: m.id,
              chatId,
              role: m.role as StoredMessage['role'],
              content: m.content,
              parentId: i === 0 ? null : (messages[i - 1]?.id ?? null),
              seq: i,
              createdAt,
              attachments,
              finishReason: itemReason,
            };

            messageRowsCache.current.set(cacheKey, { content: m.content, finishReason: itemReason, row });
            return row;
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

        notifyChatUpdated(chatId);
      } catch (err: any) {
        console.error('[persist]', err);
        if (err?.name === 'QuotaExceededError') {
          showNotice('Bộ nhớ IndexedDB đã đầy. Vui lòng dọn bớt ảnh hoặc đoạn chat cũ.');
        }
      }
    })();
  }, [isLoading, messages, currentChatId, notifyChatUpdated, showNotice]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
    let cancelled = false;
    const bc = new BroadcastChannel('ai-chat-sync');

    bc.onmessage = async (e) => {
      if (cancelled) return;
      if (e.data?.from === tabId.current) return;
      if (e.data?.type !== 'CHAT_UPDATED') return;
      if (e.data?.chatId !== currentChatId) return;
      if (isLoading || !currentChatId) return;

      hydratedFor.current = null;
      const chatId = currentChatId;
      try {
        const rows = await db.messages
          .where('[chatId+seq]')
          .between([chatId, Dexie.minKey], [chatId, Dexie.maxKey])
          .toArray();

        if (cancelled || chatId !== useAppStore.getState().currentChatId) return;

        revokeObjectUrls(createdObjectUrls.current);

        setMessages(
          rows.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            experimental_attachments: m.attachments?.map((a) => ({
              name: a.name,
              contentType: a.contentType,
              url: createAttachmentUrl(a, createdObjectUrls.current),
            })) as any,
          })) as Message[],
        );
      } catch (err) {
        console.error('[broadcastSync]', err);
      }
    };

    return () => {
      cancelled = true;
      bc.close();
    };
  }, [currentChatId, isLoading, setMessages]);

  useEffect(() => {
    if (!currentChatId || isLoading || messages.length < 2) return;
    const chatId = currentChatId;
    if (titledFor.current === chatId) return;

    const firstUserMsg = messages.find((m) => m.role === 'user');
    const userPrompt = (firstUserMsg?.content || '').slice(0, 1000).trim();
    if (!userPrompt) return;

    const ctrl = new AbortController();
    (async () => {
      try {
        const chat = await db.chats.get(chatId);
        if (!chat) return;
        if (chat.title !== 'New Chat') {
          titledFor.current = chatId;
          return;
        }

        titledFor.current = chatId;

        const res = await fetch('/api/title', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'x-api-key': apiKey } : {}),
            ...(accessCode ? { 'x-access-code': accessCode } : {}),
          },
          body: JSON.stringify({ message: userPrompt }),
          signal: ctrl.signal,
        });

        if (!res.ok) {
          if (titledFor.current === chatId) titledFor.current = null;
          return;
        }

        const data = await res.json();
        if (data?.title) {
          await db.chats.update(chatId, { title: String(data.title).slice(0, 60) });
          notifyChatUpdated(chatId);
        }
      } catch (err: any) {
        if (titledFor.current === chatId) titledFor.current = null;
        if (err?.name !== 'AbortError') console.error('[title]', err);
      }
    })();

    return () => {
      ctrl.abort();
    };
  }, [messages, currentChatId, isLoading, apiKey, accessCode, notifyChatUpdated]);

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

    if (scrollFrame.current !== null) {
      cancelAnimationFrame(scrollFrame.current);
    }

    scrollFrame.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
      scrollFrame.current = null;
    });

    return () => {
      if (scrollFrame.current !== null) {
        cancelAnimationFrame(scrollFrame.current);
        scrollFrame.current = null;
      }
    };
  }, [messages.length, messages[messages.length - 1]?.content]);

  const scrollToBottom = useCallback(() => {
    stick.current = true;
    setAutoScroll(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, []);

  const truncateFrom = useCallback(
    async (index: number, keep: Message[]) => {
      if (currentChatId) {
        await db.transaction('rw', db.messages, db.chats, async () => {
          await db.messages
            .where('[chatId+seq]')
            .between([currentChatId, index], [currentChatId, Dexie.maxKey], true, true)
            .delete();

          const stale = await db.messages
            .where('chatId')
            .equals(currentChatId)
            .filter((m) => m.seq >= index)
            .primaryKeys();

          if (stale.length) {
            await db.messages.bulkDelete(stale as string[]);
          }

          await db.chats.update(currentChatId, { updatedAt: Date.now() });
        });
      }
      setMessages(keep);
    },
    [currentChatId, setMessages],
  );

  const triggerReload = useCallback(() => {
    if (reloadTimer.current) {
      clearTimeout(reloadTimer.current);
    }
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      void reload();
    }, 0);
  }, [reload]);

  const handleRegenerate = useCallback(
    async (id: string) => {
      if (isLoading) return;
      const idx = messages.findIndex((m) => m.id === id);
      if (idx < 1 || messages[idx - 1]?.role !== 'user') return;
      finishRef.current = 'stop';
      await truncateFrom(idx, messages.slice(0, idx));
      triggerReload();
    },
    [isLoading, messages, truncateFrom, triggerReload],
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
      triggerReload();
    },
    [draft, isLoading, messages, truncateFrom, triggerReload],
  );

  const copyMessage = useCallback(async (m: Message) => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopiedId(m.id);
      if (copiedTimer.current) {
        clearTimeout(copiedTimer.current);
      }
      copiedTimer.current = setTimeout(() => {
        setCopiedId(null);
        copiedTimer.current = null;
      }, 1500);
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

  const onSubmit = useCallback(async (e?: React.FormEvent) => {
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
  }, [input, attachments, isLoading, currentChatId, draftId, setCurrentChatId, handleSubmit]);

  const onTextareaKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as any).isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { handleStop(); return; }
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (isTouchDevice || !sendOnEnter) return;
    e.preventDefault();
    void onSubmit();
  }, [handleStop, isTouchDevice, sendOnEnter, onSubmit]);

  const onOpenSidebar = useCallback(() => setSidebarOpen(true), [setSidebarOpen]);

  const lastMessageId = messages[messages.length - 1]?.id;
  const hasMessages = messages.length > 0;

  return (
    <div className="flex-1 flex flex-col relative h-[100dvh]">
      <ChatHeader
        hasMessages={hasMessages}
        confirmClear={confirmClear}
        onSetConfirmClear={setConfirmClear}
        onDeleteChat={deleteChat}
        onOpenSidebar={onOpenSidebar}
      />

      <MessageList
        messages={messages}
        isLoading={isLoading}
        lastMessageId={lastMessageId}
        editingId={editingId}
        copiedId={copiedId}
        draft={draft}
        isTouchDevice={isTouchDevice}
        sendOnEnter={sendOnEnter}
        throttleMs={throttleMs}
        animations={animations}
        error={error}
        autoScroll={autoScroll}
        scrollRef={scrollRef}
        onScroll={onScroll}
        onScrollToBottom={scrollToBottom}
        onCopy={copyMessage}
        onRegenerate={handleRegenerate}
        onStartEdit={startEdit}
        onSaveEdit={saveEdit}
        onCancelEdit={cancelEdit}
        onDraftChange={setDraft}
        onSelectSuggestion={setInput}
        onReload={reload}
      />

      <ChatComposer
        input={input}
        handleInputChange={handleInputChange}
        onTextareaKeyDown={onTextareaKeyDown}
        onSubmit={onSubmit}
        isLoading={isLoading}
        handleStop={handleStop}
        notice={notice}
        onClearNotice={onClearNotice}
        attachments={attachments}
        addFiles={addFiles}
        removeAttachment={removeAttachment}
        previewMap={previewMap}
        fileInputRef={fileInputRef}
        isTouchDevice={isTouchDevice}
      />
    </div>
  );
}