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
  X, MoreHorizontal, FileJson, FileText, Loader2,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/* ChatItem                                                            */
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

  const runExport = (format: 'json' | 'md') => (e: React.MouseEvent) => {
    e.stopPropagation();
    onExport(chat.id, format);
    setMenuOpen(false);
  };

  return (
    <div
      onClick={() => onSelect(chat.id)}
      onKeyDown={(e) => e.key === 'Enter' && onSelect(chat.id)}
      role="button"
      tabIndex={0}
      className={`group relative flex w-full cursor-pointer flex-col rounded-lg px-2.5 py-2 text-left outline-none ${
        isActive
          ? 'bg-zinc-800/80 text-zinc-100'
          : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200'
      }`}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <MessageSquare
            size={14}
            className={`flex-shrink-0 ${isActive ? 'text-[#c96442]' : 'text-zinc-600'}`}
          />
          <span className="truncate text-[13px] font-medium">
            {titleSegments ? <Highlight segments={titleSegments} /> : chat.title}
          </span>
          {chat.pinned ? (
            <Pin size={11} className="flex-shrink-0 rotate-45 text-zinc-500" />
          ) : null}
        </div>

        <div
          ref={menuRef}
          className={`relative flex-shrink-0 ${
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
          }`}
        >
          <button
            type="button"
            aria-label="Tùy chọn cuộc trò chuyện"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-200"
          >
            <MoreHorizontal size={14} />
          </button>

          {menuOpen && (
            <div
              role="menu"
              onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-zinc-800 bg-[#1a1a1d] p-1 shadow-xl"
            >
              <button
                type="button"
                onClick={(e) => {
                  onTogglePin(e, chat.id, (chat.pinned ?? 0) as 0 | 1);
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px] text-zinc-300 hover:bg-zinc-800"
              >
                <Pin size={13} className="text-zinc-500" />
                {chat.pinned ? 'Bỏ ghim' : 'Ghim lên đầu'}
              </button>
              <button
                type="button"
                onClick={runExport('json')}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px] text-zinc-300 hover:bg-zinc-800"
              >
                <FileJson size={13} className="text-zinc-500" />
                Xuất JSON
              </button>
              <button
                type="button"
                onClick={runExport('md')}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px] text-zinc-300 hover:bg-zinc-800"
              >
                <FileText size={13} className="text-zinc-500" />
                Xuất Markdown
              </button>
              <div className="my-1 h-px bg-zinc-800" />
              <button
                type="button"
                onClick={(e) => {
                  onDelete(e, chat.id);
                  setMenuOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10"
              >
                <Trash2 size={13} />
                Xóa cuộc trò chuyện
              </button>
            </div>
          )}
        </div>
      </div>

      {snippets?.length ? (
        <div className="mt-1 space-y-0.5 pl-6">
          {snippets.slice(0, 2).map((seg, i) => (
            <p key={i} className="truncate text-[11px] leading-relaxed text-zinc-500">
              <Highlight segments={seg} />
            </p>
          ))}
          {extraHits ? (
            <p className="text-[10px] text-zinc-600">+{extraHits} kết quả khác</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */
export function Sidebar({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const isSidebarOpen = useAppStore((s) => s.isSidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const currentChatId = useAppStore((s) => s.currentChatId);
  const setCurrentChatId = useAppStore((s) => s.setCurrentChatId);

  const [searchQuery, setSearchQuery] = useState('');
  const debouncedQuery = useDebouncedValue(searchQuery, 220);
  const [searchResults, setSearchResults] = useState<ChatSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const rawChats = useLiveQuery(
    () => db.chats.orderBy('updatedAt').reverse().toArray(),
    [],
  );
  const allChats = useMemo(() => rawChats ?? [], [rawChats]);
  const dateGroups = useMemo(() => groupChatsByDate(allChats), [allChats]);

  const isSearchMode = debouncedQuery.trim().length > 0;

  /* Tìm kiếm full-text qua tokens (Dexie) — giữ nguyên contract của searchChats */
  useEffect(() => {
    let cancelled = false;
    const q = debouncedQuery.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    (async () => {
      try {
        const res = await searchChats(q, allChats);
        if (!cancelled) setSearchResults(res);
      } catch (err) {
        console.error('[Sidebar:search]', err);
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, allChats]);

  const createNewChat = useCallback(() => {
    setCurrentChatId(null);
    setSearchQuery('');
    if (window.innerWidth < 768) setSidebarOpen(false);
  }, [setCurrentChatId, setSidebarOpen]);

  const selectChat = useCallback(
    (id: string) => {
      setCurrentChatId(id);
      if (window.innerWidth < 768) setSidebarOpen(false);
    },
    [setCurrentChatId, setSidebarOpen],
  );

  const togglePin = useCallback(async (e: React.MouseEvent, id: string, cur: 0 | 1) => {
    e.stopPropagation();
    await db.chats.update(id, { pinned: cur ? 0 : 1, updatedAt: Date.now() });
  }, []);

  const deleteChat = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      await db.transaction('rw', db.chats, db.messages, async () => {
        await db.messages.where('chatId').equals(id).delete();
        await db.chats.delete(id);
      });
      if (currentChatId === id) setCurrentChatId(null);
    },
    [currentChatId, setCurrentChatId],
  );

  const handleExport = useCallback(async (id: string, format: 'json' | 'md') => {
    try {
      if (format === 'json') await exportJson([id]);
      else await exportMarkdown([id]);
    } catch (err) {
      console.error('[Sidebar:export]', err);
    }
  }, []);

  /* Phím tắt ⌘K / ⌘N */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSidebarOpen(true);
        searchInputRef.current?.focus();
      }
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        createNewChat();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [createNewChat, setSidebarOpen]);

  return (
    <>
      {isSidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
        />
      )}

      <aside
        className={`fixed bottom-0 left-0 top-0 z-40 flex w-[280px] flex-col border-r border-zinc-800/70 bg-[#121214] transition-transform duration-150 ease-out md:static md:translate-x-0 ${
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Header + New chat */}
        <div className="px-3 pb-2 pt-3 pt-safe">
          <button
            type="button"
            onClick={createNewChat}
            className="flex w-full items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-[13px] font-medium text-zinc-100 hover:border-zinc-700 hover:bg-zinc-800/70"
          >
            <span className="flex items-center gap-2.5">
              <Plus size={15} className="text-[#c96442]" />
              Cuộc trò chuyện mới
            </span>
            <kbd className="rounded border border-zinc-700/60 bg-zinc-800/70 px-1.5 py-0.5 text-[10px] text-zinc-500">
              ⌘N
            </kbd>
          </button>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="relative flex items-center">
            <Search size={14} className="pointer-events-none absolute left-2.5 text-zinc-600" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm kiếm..."
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900/50 py-2 pl-8 pr-14 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-700"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Xóa tìm kiếm"
                className="absolute right-2 text-zinc-500 hover:text-zinc-300"
              >
                <X size={13} />
              </button>
            ) : (
              <kbd className="pointer-events-none absolute right-2 rounded border border-zinc-700/50 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-600">
                ⌘K
              </kbd>
            )}
          </div>
        </div>

        {/* Danh sách */}
        <div className="no-scrollbar flex-1 space-y-4 overflow-y-auto px-3 py-1">
          {isSearchMode ? (
            <div className="space-y-1">
              <SectionLabel>
                {searching ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 size={11} className="animate-spin" /> Đang tìm
                  </span>
                ) : (
                  `Kết quả (${searchResults.length})`
                )}
              </SectionLabel>
              {!searching && searchResults.length === 0 && (
                <p className="px-2.5 py-4 text-center text-[12px] text-zinc-600">
                  Không tìm thấy kết quả nào.
                </p>
              )}
              {searchResults.map((r) => (
                <ChatItem
                  key={r.chat.id}
                  chat={r.chat}
                  isActive={currentChatId === r.chat.id}
                  titleSegments={r.titleSegments}
                  snippets={r.hits?.map((h) => h.snippet)}
                  extraHits={Math.max(0, (r.totalHits ?? 0) - (r.hits?.length ?? 0))}
                  onSelect={selectChat}
                  onTogglePin={togglePin}
                  onDelete={deleteChat}
                  onExport={handleExport}
                />
              ))}
            </div>
          ) : (
            dateGroups.map((group) => (
              <div key={group.key} className="space-y-0.5">
                <SectionLabel>{group.label}</SectionLabel>
                {group.chats.map((chat) => (
                  <ChatItem
                    key={chat.id}
                    chat={chat}
                    isActive={currentChatId === chat.id}
                    onSelect={selectChat}
                    onTogglePin={togglePin}
                    onDelete={deleteChat}
                    onExport={handleExport}
                  />
                ))}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-zinc-800/70 p-3 pb-safe">
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] font-medium text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
          >
            <SettingsIcon size={15} />
            Cài đặt & Sao lưu
          </button>
        </div>
      </aside>
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-zinc-600">
      {children}
    </div>
  );
}
