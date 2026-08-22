'use client';

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, deleteChatCascade, type ChatSession } from '@/lib/db';
import { useAppStore } from '@/lib/store';
import { searchChats, type ChatSearchResult } from '@/lib/chat-search';
import { groupChatsByDate } from '@/lib/date-groups';
import { exportJson, exportMarkdown } from '@/lib/backup';
import { Highlight } from '@/components/highlight';
import type { SnippetSegment } from '@/lib/search-utils';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { BackupReminder } from '@/components/backup-reminder';
import {
  Plus, MessageSquare, Pin, Trash2, Search, Settings as SettingsIcon,
  X, MoreHorizontal, FileJson, FileText, Loader2,
} from 'lucide-react';

const EMPTY_CHATS: ChatSession[] = [];
const CHAT_PAGE_SIZE = 200;

function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface ChatItemProps {
  chat: ChatSession;
  isActive: boolean;
  titleSegments?: SnippetSegment[];
  snippets?: SnippetSegment[][];
  extraHits?: number;
  onSelect: (id: string) => void;
  onTogglePin: (id: string, currentPin: 0 | 1) => void;
  onDelete: (id: string) => void;
  onExport: (id: string, format: 'json' | 'md') => void;
}

const ChatItem = memo(function ChatItem({
  chat, isActive, titleSegments, snippets, extraHits,
  onSelect, onTogglePin, onDelete, onExport,
}: ChatItemProps) {
  const [menuRect, setMenuRect] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuOpen = menuRect !== null;

  const openMenu = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    setMenuRect({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };
  const closeMenu = useCallback(() => setMenuRect(null), []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) closeMenu();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { closeMenu(); triggerRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [menuOpen, closeMenu]);

  const menu = menuOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', top: menuRect.top, right: menuRect.right }}
          className="z-[100] w-48 rounded-lg border border-zinc-200 bg-[#FFFFFF] p-1 shadow-xl"
        >
          <button
            type="button" role="menuitem"
            onClick={() => { onTogglePin(chat.id, (chat.pinned ?? 0) as 0 | 1); closeMenu(); }}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px] text-zinc-600 hover:bg-zinc-200"
          >
            <Pin size={13} className="text-zinc-500" />
            {chat.pinned ? 'Bỏ ghim' : 'Ghim lên đầu'}
          </button>
          <button
            type="button" role="menuitem"
            onClick={() => { onExport(chat.id, 'json'); closeMenu(); }}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px] text-zinc-600 hover:bg-zinc-200"
          >
            <FileJson size={13} className="text-zinc-500" /> Xuất JSON
          </button>
          <button
            type="button" role="menuitem"
            onClick={() => { onExport(chat.id, 'md'); closeMenu(); }}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px] text-zinc-600 hover:bg-zinc-200"
          >
            <FileText size={13} className="text-zinc-500" /> Xuất Markdown
          </button>
          <div className="my-1 h-px bg-zinc-200" />
          <button
            type="button" role="menuitem"
            onClick={() => { onDelete(chat.id); closeMenu(); }}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10"
          >
            <Trash2 size={13} /> Xóa cuộc trò chuyện
          </button>
        </div>,
        document.body,
      )
    : null;

  return (
    <div
      className={`group relative flex w-full flex-col rounded-lg text-left ${
        isActive
          ? 'bg-zinc-200/80 before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-[#0A7E8C]'
          : 'hover:bg-zinc-200/40'
      }`}
    >
      <div className="flex w-full items-center justify-between gap-1 pr-1">
        <button
          type="button"
          onClick={() => onSelect(chat.id)}
          aria-current={isActive ? 'true' : undefined}
          className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-[#0A7E8C] ${
            isActive ? 'text-zinc-800' : 'text-zinc-500 group-hover:text-zinc-700'
          }`}
        >
          <MessageSquare
            size={14}
            className={`flex-shrink-0 ${isActive ? 'text-[#0A7E8C]' : 'text-zinc-500'}`}
          />
          <span className="truncate text-[13px] font-medium">
            {titleSegments ? <Highlight segments={titleSegments} /> : chat.title}
          </span>
          {chat.pinned ? <Pin size={11} className="flex-shrink-0 rotate-45 text-zinc-500" /> : null}
        </button>

        <button
          ref={triggerRef}
          type="button"
          aria-label="Tùy chọn cuộc trò chuyện"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => (menuOpen ? closeMenu() : openMenu())}
          className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-300/60 hover:text-zinc-700 ${
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
          }`}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>

      {snippets?.length ? (
        <div className="px-2.5 pb-2 pl-[30px]">
          {snippets.slice(0, 2).map((seg, i) => (
            <p key={i} className="truncate text-[11px] leading-relaxed text-zinc-500">
              <Highlight segments={seg} />
            </p>
          ))}
          {extraHits ? (
            <p className="text-[10px] text-zinc-500">+{extraHits} kết quả khác</p>
          ) : null}
        </div>
      ) : null}

      {menu}
    </div>
  );
});

interface SearchState {
  query: string;
  results: ChatSearchResult[];
}

export function Sidebar() {
  const currentChatId = useAppStore((s) => s.currentChatId);
  const isSidebarOpen = useAppStore((s) => s.isSidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const [searchQuery, setSearchQuery] = useState('');
  const [search, setSearch] = useState<SearchState | null>(null);
  const [searchError, setSearchError] = useState(false);
  const debouncedQuery = useDebouncedValue(searchQuery, 250);
  const trimmedQuery = debouncedQuery.trim();

  const chats =
    useLiveQuery(
      () => db.chats.orderBy('updatedAt').reverse().limit(CHAT_PAGE_SIZE).toArray(),
      [],
    ) ?? EMPTY_CHATS;

  const isSearching = trimmedQuery.length > 0 && search?.query !== trimmedQuery && !searchError;
  const showingSearch = trimmedQuery.length > 0;

  useEffect(() => {
    if (!trimmedQuery) {
      setSearch(null);
      setSearchError(false);
      return;
    }
    const controller = new AbortController();
    setSearchError(false);

    (async () => {
      try {
        const results = await searchChats(trimmedQuery, { signal: controller.signal });
        if (!controller.signal.aborted) setSearch({ query: trimmedQuery, results });
      } catch (err) {
        if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return;
        console.error('[Sidebar] search error:', err);
        setSearch({ query: trimmedQuery, results: [] });
        setSearchError(true);
      }
    })();

    return () => controller.abort();
  }, [trimmedQuery]);

  const handleSelect = useCallback((id: string) => {
    useAppStore.getState().setCurrentChatId(id);
    if (window.matchMedia('(max-width: 767px)').matches) {
      useAppStore.getState().setSidebarOpen(false);
    }
  }, []);

  const handleNewChat = useCallback(async () => {
    const recent = await db.chats.orderBy('updatedAt').reverse().limit(5).toArray();
    for (const c of recent) {
      const count = await db.messages.where('chatId').equals(c.id).count();
      if (count === 0) {
        useAppStore.getState().setCurrentChatId(c.id);
        return;
      }
    }
    const id = newId();
    const now = Date.now();
    await db.chats.add({ id, title: 'Cuộc trò chuyện mới', pinned: 0, createdAt: now, updatedAt: now });
    useAppStore.getState().setCurrentChatId(id);
  }, []);

  const handleTogglePin = useCallback(async (id: string, cur: 0 | 1) => {
    await db.chats.update(id, { pinned: cur === 1 ? 0 : 1, updatedAt: Date.now() });
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm('Bạn có chắc muốn xóa cuộc trò chuyện này?')) return;
    await deleteChatCascade(id);
    if (useAppStore.getState().currentChatId === id) {
      useAppStore.getState().setCurrentChatId(null);
    }
  }, []);

  const handleExport = useCallback(async (id: string, format: 'json' | 'md') => {
    if (format === 'json') await exportJson(id);
    else await exportMarkdown(id);
  }, []);

  const groups = useMemo(
    () => (showingSearch ? [] : groupChatsByDate(chats)),
    [chats, showingSearch],
  );

  const visibleResults = search?.query === trimmedQuery ? search.results : null;

  return (
    <aside
      aria-label="Danh sách cuộc trò chuyện"
      className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-zinc-200/80 bg-[#FFFFFF] transition-transform duration-200 md:static md:translate-x-0 md:!opacity-100 ${
        isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      {/* Brand */}
      <div className="flex items-center justify-between px-4 pb-1 pt-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-200/60 ring-1 ring-zinc-900/5 shadow-[0_4px_14px_-6px_rgba(45,170,120,0.55)]">
            <svg width="16" height="16" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="koda-mark" x1="8" y1="7" x2="24" y2="25" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#0A7E8C" />
                  <stop offset="1" stopColor="#4ECB71" />
                </linearGradient>
              </defs>
              <path d="M10.5 8V24" stroke="url(#koda-mark)" strokeWidth="3.2" strokeLinecap="round" />
              <path d="M10.5 16L22.5 8" stroke="url(#koda-mark)" strokeWidth="3.2" strokeLinecap="round" />
              <path d="M10.5 16L22.5 24" stroke="url(#koda-mark)" strokeWidth="3.2" strokeLinecap="round" />
              <circle cx="22.5" cy="8" r="2.4" fill="#0A7E8C" />
              <circle cx="22.5" cy="24" r="2.4" fill="#4ECB71" />
            </svg>
          </div>
          <div className="leading-tight">
            <div className="text-[14px] font-extrabold tracking-tight text-zinc-800">KODA</div>
            <div className="text-[9px] font-medium uppercase tracking-[0.24em] text-zinc-500">AI Innovations</div>
          </div>
        </div>
        <button
          type="button"
          aria-label="Đóng thanh bên"
          onClick={() => setSidebarOpen(false)}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200 md:hidden"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex items-center gap-1.5 p-3 pt-2">
        <button
          type="button"
          onClick={handleNewChat}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#0A7E8C] px-3 py-2 text-[13px] font-semibold text-white shadow-[0_4px_16px_-6px_rgba(10,126,140,0.6)] transition hover:bg-[#086E7A] active:scale-[0.98]"
        >
          <Plus size={15} />
          <span>Đoạn chat mới</span>
        </button>
      </div>

      <BackupReminder chatCount={chats.length} />

      <div className="px-3 pb-2">
        <div className="relative flex items-center">
          <Search size={14} className="absolute left-2.5 text-zinc-500" />
          <input
            type="search"
            role="searchbox"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm kiếm..."
            className="w-full rounded-lg border border-zinc-200/80 bg-[#FFFFFF] py-1.5 pl-8 pr-8 text-[13px] text-zinc-700 outline-none placeholder:text-zinc-500 transition focus:border-[#0A7E8C]/50 focus:ring-2 focus:ring-[#0A7E8C]/15"
          />
          {isSearching ? (
            <Loader2 size={13} className="absolute right-2.5 animate-spin text-zinc-500" />
          ) : searchQuery ? (
            <button
              type="button"
              aria-label="Xóa từ khóa"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 text-zinc-500 hover:text-zinc-600"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="no-scrollbar flex-1 overflow-y-auto px-2 py-1">
        {showingSearch ? (
          <div aria-busy={isSearching} className="flex flex-col gap-1">
            {visibleResults === null ? (
              <div className="py-8 text-center text-[13px] text-zinc-500">
                <Loader2 size={16} className="mx-auto animate-spin" />
              </div>
            ) : visibleResults.length === 0 ? (
              <div className="py-8 text-center text-[13px] text-zinc-500">
                {searchError ? 'Tìm kiếm gặp lỗi' : 'Không tìm thấy kết quả'}
              </div>
            ) : (
              visibleResults.map((res) => (
                <ChatItem
                  key={res.chat.id}
                  chat={res.chat}
                  isActive={res.chat.id === currentChatId}
                  titleSegments={res.titleSegments}
                  snippets={res.snippets}
                  extraHits={res.extraHits}
                  onSelect={handleSelect}
                  onTogglePin={handleTogglePin}
                  onDelete={handleDelete}
                  onExport={handleExport}
                />
              ))
            )}
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-4 last:mb-0">
              <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                {g.label}
              </div>
              <div className="flex flex-col gap-0.5">
                {g.chats.map((c) => (
                  <ChatItem
                    key={c.id}
                    chat={c}
                    isActive={c.id === currentChatId}
                    onSelect={handleSelect}
                    onTogglePin={handleTogglePin}
                    onDelete={handleDelete}
                    onExport={handleExport}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-zinc-200/80 p-2">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-zinc-500 hover:bg-zinc-200/50 hover:text-zinc-700"
        >
          <SettingsIcon size={15} />
          <span>Cài đặt</span>
        </button>
      </div>
    </aside>
  );
}