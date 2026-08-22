'use client';

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type ChatSession } from '@/lib/db';
import { useAppStore } from '@/lib/store';
import { searchChats, type ChatSearchResult } from '@/lib/chat-search';
import { groupChatsByDate } from '@/lib/date-groups';
import { exportJson, exportMarkdown } from '@/lib/backup';
import { Highlight } from '@/components/highlight';
import type { SnippetSegment } from '@/lib/search-utils';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import {
  Plus, MessageSquare, Pin, Trash2, Search, Settings as SettingsIcon,
  X, Download, Loader2, FileJson, FileText,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

/* ------------------------------------------------------------------ */
/* ChatItem                                                           */
/* ------------------------------------------------------------------ */
interface ChatItemProps {
  chat: ChatSession;
  isActive: boolean;
  titleSegments?: SnippetSegment[];
  snippets?: SnippetSegment[][];
  extraHits?: number;
  onSelect: (id: string) => void;
  onTogglePin: (e: React.MouseEvent, id: string, currentPin: 0 | 1) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onExport: (id: string, format: 'json' | 'md') => void;
}

const ChatItem = memo(function ChatItem({
  chat, isActive, titleSegments, snippets, extraHits,
  onSelect, onTogglePin, onDelete, onExport,
}: ChatItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [menuOpen]);

  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -6 }}
      transition={{ duration: 0.12 }}
      onClick={() => onSelect(chat.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(chat.id);
        }
      }}
      className={`group relative w-full flex flex-col gap-1 p-2.5 rounded-xl cursor-pointer transition-all text-left outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
        isActive
          ? 'bg-zinc-800/90 text-zinc-100 shadow-sm'
          : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
      }`}
    >
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-3 overflow-hidden flex-1 min-w-0 pr-2">
          <MessageSquare
            size={16}
            className={`flex-shrink-0 ${isActive ? 'text-indigo-400' : 'text-zinc-600'}`}
          />
          <span className="truncate text-sm font-medium">
            {titleSegments ? <Highlight segments={titleSegments} /> : chat.title}
          </span>
        </div>

        <div className="flex items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={(e) => onTogglePin(e, chat.id, chat.pinned)}
            title={chat.pinned ? 'Bỏ ghim' : 'Ghim đoạn chat'}
            aria-label="Toggle pin chat"
            className={`p-1.5 rounded-lg transition-colors ${
              chat.pinned
                ? 'text-indigo-400 bg-indigo-500/10'
                : 'text-zinc-500 hover:text-indigo-400 hover:bg-zinc-800'
            }`}
          >
            <Pin size={13} />
          </button>

          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              title="Xuất đoạn chat"
              aria-label="Export chat"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="p-1.5 text-zinc-500 hover:text-indigo-400 hover:bg-zinc-800 rounded-lg transition-colors"
            >
              <Download size={13} />
            </button>
            {menuOpen && (
              <div
                role="menu"
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 top-full mt-1 w-40 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl py-1 z-50"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); onExport(chat.id, 'json'); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 transition"
                >
                  <FileJson size={13} /> Xuất .json
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); onExport(chat.id, 'md'); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 transition"
                >
                  <FileText size={13} /> Xuất .md
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={(e) => onDelete(e, chat.id)}
            title="Xóa cuộc trò chuyện"
            aria-label="Delete chat"
            className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {snippets && snippets.length > 0 && (
        <div className="pl-7 pr-1 space-y-1">
          {snippets.map((segments, i) => (
            <p key={i} className="text-[11px] leading-relaxed text-zinc-500 line-clamp-2">
              <Highlight segments={segments} />
            </p>
          ))}
          {!!extraHits && extraHits > 0 && (
            <p className="text-[10px] text-zinc-600">+{extraHits} kết quả khác</p>
          )}
        </div>
      )}
    </motion.div>
  );
});

/* ------------------------------------------------------------------ */
/* Sidebar                                                            */
/* ------------------------------------------------------------------ */
export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const currentChatId = useAppStore((s) => s.currentChatId);
  const setCurrentChatId = useAppStore((s) => s.setCurrentChatId);
  const isSidebarOpen = useAppStore((s) => s.isSidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ChatSearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const debouncedSearch = useDebouncedValue(search, 220);

  const chats = useLiveQuery(() => db.chats.orderBy('updatedAt').reverse().toArray(), []);

  /* ---- Tìm kiếm bất đồng bộ ---- */
  useEffect(() => {
    const query = debouncedSearch.trim();
    if (!query) {
      setResults(null);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);

    searchChats(query, chats ?? [])
      .then((found) => { if (!cancelled) setResults(found); })
      .catch((err) => {
        console.error('[sidebar search]', err);
        if (!cancelled) setResults([]);
      })
      .finally(() => { if (!cancelled) setIsSearching(false); });

    return () => { cancelled = true; };
  }, [debouncedSearch, chats]);

  /* ---- ⌘K / Ctrl+K để focus search ---- */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSidebarOpen(true);
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setSidebarOpen]);

  const groups = useMemo(() => groupChatsByDate(chats), [chats]);

  const createNewChat = useCallback(() => {
    setCurrentChatId(null);
    setSidebarOpen(false);
  }, [setCurrentChatId, setSidebarOpen]);

  const selectChat = useCallback((id: string) => {
    setCurrentChatId(id);
    setSidebarOpen(false);
  }, [setCurrentChatId, setSidebarOpen]);

  const deleteChat = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await db.transaction('rw', db.messages, db.chats, async () => {
        await db.messages.where('chatId').equals(id).delete();
        await db.chats.delete(id);
      });
      if (currentChatId === id) setCurrentChatId(null);
    } catch (err) {
      console.error('[sidebar deleteChat]', err);
    }
  }, [currentChatId, setCurrentChatId]);

  const togglePin = useCallback(async (e: React.MouseEvent, id: string, currentPin: 0 | 1) => {
    e.stopPropagation();
    try {
      await db.chats.update(id, { pinned: currentPin ? 0 : 1 });
    } catch (err) {
      console.error('[sidebar togglePin]', err);
    }
  }, []);

  const exportOne = useCallback(async (id: string, format: 'json' | 'md') => {
    try {
      if (format === 'json') await exportJson([id]);
      else await exportMarkdown([id]);
    } catch (err) {
      console.error('[sidebar exportOne]', err);
    }
  }, []);

  const isSearchMode = debouncedSearch.trim().length > 0;

  const sidebarContent = (
    <div className="w-[280px] h-full bg-zinc-950 border-r border-zinc-800/50 flex flex-col flex-shrink-0 z-40">
      {/* Header */}
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={createNewChat}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl transition-colors text-sm font-medium shadow-sm"
          >
            <Plus size={16} /> New Chat
            <span className="ml-auto text-xs opacity-60 font-mono hidden md:inline">⌘N</span>
          </button>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
            className="md:hidden p-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 rounded-xl transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Tìm tiêu đề & nội dung…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
            aria-label="Tìm kiếm lịch sử chat"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-9 pr-9 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 transition-colors"
          />
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center">
            {isSearching ? (
              <Loader2 size={13} className="text-zinc-500 animate-spin" />
            ) : search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Xoá từ khoá"
                className="p-0.5 text-zinc-500 hover:text-zinc-300 transition"
              >
                <X size={13} />
              </button>
            ) : (
              <span className="text-[10px] font-mono text-zinc-700 hidden md:inline">⌘K</span>
            )}
          </div>
        </div>
      </div>

      {/* Danh sách */}
      <div className="flex-1 overflow-y-auto p-3 space-y-6">
        {isSearchMode ? (
          <div>
            <div className="text-xs font-semibold text-zinc-600 mb-2 px-2 uppercase tracking-wider">
              Kết quả {results ? `(${results.length})` : ''}
            </div>
            <div className="space-y-0.5">
              {results?.map((r) => (
                <ChatItem
                  key={r.chat.id}
                  chat={r.chat}
                  isActive={currentChatId === r.chat.id}
                  titleSegments={r.titleMatch ? r.titleSegments : undefined}
                  snippets={r.hits.map((h) => h.snippet)}
                  extraHits={Math.max(0, r.totalHits - r.hits.length)}
                  onSelect={selectChat}
                  onTogglePin={togglePin}
                  onDelete={deleteChat}
                  onExport={exportOne}
                />
              ))}
              {results?.length === 0 && !isSearching && (
                <div className="text-center py-8 text-xs text-zinc-600">
                  Không tìm thấy kết quả nào cho “{debouncedSearch.trim()}”
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <div key={group.key}>
                <div className="text-xs font-semibold text-zinc-600 mb-2 px-2 uppercase tracking-wider flex items-center gap-1.5">
                  {group.key === 'pinned' && <Pin size={11} className="text-indigo-500" />}
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  <AnimatePresence initial={false}>
                    {group.chats.map((c) => (
                      <ChatItem
                        key={c.id}
                        chat={c}
                        isActive={currentChatId === c.id}
                        onSelect={selectChat}
                        onTogglePin={togglePin}
                        onDelete={deleteChat}
                        onExport={exportOne}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            ))}
            {chats && groups.length === 0 && (
              <div className="text-center py-8 text-xs text-zinc-600">
                Chưa có lịch sử trò chuyện
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-zinc-800/50">
        <button
          type="button"
          onClick={() => {
            onOpenSettings();
            setSidebarOpen(false);
          }}
          className="w-full flex items-center gap-3 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 rounded-xl transition-colors"
        >
          <SettingsIcon size={16} /> Cài đặt & Sao lưu
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div className="hidden md:block h-full">{sidebarContent}</div>

      <AnimatePresence>
        {isSidebarOpen && (
          <div className="fixed inset-0 z-50 md:hidden flex">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSidebarOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="relative z-10 h-full shadow-2xl"
            >
              {sidebarContent}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
