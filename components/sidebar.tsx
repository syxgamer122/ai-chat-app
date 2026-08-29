'use client';

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, deleteChatCascade, type ChatSession } from '@/lib/db';
import { chatBroadcast } from '@/lib/chat-broadcast';
import { useAppStore } from '@/lib/store';
import { searchChats, type ChatSearchResult } from '@/lib/chat-search';
import { groupChatsByDate } from '@/lib/date-groups';
import { exportJson, exportMarkdown } from '@/lib/backup';
import { Highlight } from '@/components/highlight';
import type { SnippetSegment } from '@/lib/search-utils';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import { MD_QUERY, useMediaQuery } from '@/lib/hooks/use-media-query';
import { BackupReminder } from '@/components/backup-reminder';
import { KodaLogo } from '@/components/koda-logo';
import {
  Plus, MessageSquare, Pin, Trash2, Search, Settings as SettingsIcon,
  X, MoreHorizontal, FileJson, FileText, Loader2, PanelLeftClose, PanelLeftOpen,
  Sun, Moon, Monitor,
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
          className="z-[100] w-48 animate-pop-in rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
        >
          <button
            type="button" role="menuitem"
            onClick={() => { onTogglePin(chat.id, (chat.pinned ?? 0) as 0 | 1); closeMenu(); }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
          >
            <Pin size={13} className="text-zinc-400" />
            {chat.pinned ? 'Bỏ ghim' : 'Ghim lên đầu'}
          </button>
          <button
            type="button" role="menuitem"
            onClick={() => { onExport(chat.id, 'json'); closeMenu(); }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
          >
            <FileJson size={13} className="text-zinc-400" /> Xuất JSON
          </button>
          <button
            type="button" role="menuitem"
            onClick={() => { onExport(chat.id, 'md'); closeMenu(); }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
          >
            <FileText size={13} className="text-zinc-400" /> Xuất Markdown
          </button>
          <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-900" />
          <button
            type="button" role="menuitem"
            onClick={() => { onDelete(chat.id); closeMenu(); }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-red-600 transition-colors hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-500/10 dark:hover:text-red-300"
          >
            <Trash2 size={13} /> Xóa cuộc trò chuyện
          </button>
        </div>,
        document.body,
      )
    : null;

  return (
    <div
      className={`group relative flex w-full flex-col rounded-lg text-left transition-all duration-100 ease-out ${
        isActive
          ? 'bg-white/10 shadow-[0_0_8px_rgba(16,185,129,0.08)]'
          : 'hover:bg-white/5'
      }`}
    >
      <div className="flex w-full items-center justify-between gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={() => onSelect(chat.id)}
          aria-current={isActive ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
        >
          <MessageSquare
            size={14}
            className={`flex-shrink-0 ${isActive ? 'text-emerald-400' : 'text-slate-500'}`}
          />
          <span className={`truncate text-[13px] ${isActive ? 'font-medium text-slate-100' : 'text-slate-400'}`}>
            {titleSegments ? <Highlight segments={titleSegments} /> : chat.title}
          </span>
        </button>

        <div className="flex items-center gap-0.5">
          {chat.pinned && <Pin size={10} className="rotate-45 text-zinc-400" />}
          <button
            ref={triggerRef}
            type="button"
            aria-label="Tùy chọn cuộc trò chuyện"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => (menuOpen ? closeMenu() : openMenu())}
            className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-zinc-400 transition-all hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 ${
              menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100'
            }`}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>

      {snippets?.length ? (
        <div className="px-2 pb-1.5 pl-8">
          {snippets.slice(0, 2).map((seg, i) => (
            <p key={i} className="truncate text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-500">
              <Highlight segments={seg} />
            </p>
          ))}
          {extraHits ? (
            <p className="text-[11px] text-zinc-400">+{extraHits} kết quả khác</p>
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
  const isSidebarCollapsed = useAppStore((s) => s.isSidebarCollapsed);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  const cycleTheme = useCallback(() => {
    const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
    setTheme(next);
  }, [theme, setTheme]);

  const ThemeIcon =
    theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const themeLabel =
    theme === 'light' ? 'Sáng' : theme === 'dark' ? 'Tối' : 'Hệ thống';

  const isDesktop = useMediaQuery(MD_QUERY);
  const isDrawerHidden = !isDesktop && !isSidebarOpen;
  const collapsed = isDesktop && isSidebarCollapsed;

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

  const newChatBusyRef = useRef(false);

  const handleNewChat = useCallback(async () => {
    if (newChatBusyRef.current) return;
    newChatBusyRef.current = true;
    try {
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
    } finally {
      newChatBusyRef.current = false;
    }
  }, []);

  const handleTogglePin = useCallback(async (id: string, cur: 0 | 1) => {
    await db.chats.update(id, { pinned: cur === 1 ? 0 : 1, updatedAt: Date.now() });
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm('Bạn có chắc muốn xóa cuộc trò chuyện này?')) return;
    await deleteChatCascade(id);
    chatBroadcast.publish({
      type: 'chat-deleted',
      sessionId: id,
      mutationId: crypto.randomUUID(),
    });
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

  useEffect(() => {
    if (!isSidebarOpen || isDesktop) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [isSidebarOpen, isDesktop, setSidebarOpen]);

  const visibleResults = search?.query === trimmedQuery ? search.results : null;

  return (
    <>
      {isSidebarOpen && !isDesktop && (
        <div
          role="presentation"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/20 backdrop-blur-sm animate-fade-in md:hidden dark:bg-black/40"
        />
      )}

      {!collapsed && (
        <aside
          aria-label="Danh sách cuộc trò chuyện"
          aria-hidden={isDrawerHidden ? true : undefined}
          inert={isDrawerHidden ? true : undefined}
          className={`fixed inset-y-0 left-0 z-40 flex w-[17rem] max-w-[85vw] flex-col border-r border-white/10 bg-slate-900/40 backdrop-blur-xl pt-safe transition-transform duration-200 ease-out md:static md:w-64 md:max-w-none md:translate-x-0 ${
            isSidebarOpen ? 'translate-x-0 shadow-2xl md:shadow-none' : '-translate-x-full'
          }`}
        >
          <div className="flex items-center justify-between px-3 pb-2 pt-3">
            <KodaLogo size="sm" />
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                aria-label="Thu gọn thanh bên"
                title="Thu gọn (Ctrl+\\)"
                onClick={() => setSidebarCollapsed(true)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200 hidden md:inline-flex"
              >
                <PanelLeftClose size={15} />
              </button>
              <button
                type="button"
                aria-label="Đóng thanh bên"
                onClick={() => setSidebarOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200 md:hidden"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="px-3 pb-2">
            <button
              type="button"
              onClick={handleNewChat}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-600/20 px-3 py-1.5 text-[13px] font-medium text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.15)] backdrop-blur-sm transition-all hover:bg-emerald-600/30 hover:shadow-[0_0_20px_rgba(16,185,129,0.25)] active:scale-[0.98]"
            >
              <Plus size={14} />
              <span>Chat mới</span>
            </button>
          </div>

          <BackupReminder chatCount={chats.length} />

          <div className="px-3 pb-2">
            <div className="relative flex items-center">
              <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2.5 text-zinc-400" />
              <input
                type="search"
                aria-label="Tìm trong các cuộc trò chuyện"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Tìm kiếm..."
                className="w-full rounded-md border border-white/10 bg-white/5 py-1.5 pl-8 pr-7 text-[16px] text-slate-200 outline-none transition-all placeholder:text-slate-500 focus:border-emerald-500/30 focus:bg-white/10 focus:shadow-[0_0_8px_rgba(16,185,129,0.1)] sm:text-[12px]"
              />
              {isSearching ? (
                <Loader2 size={12} aria-hidden="true" className="absolute right-2 animate-spin text-zinc-400" />
              ) : searchQuery ? (
                <button
                  type="button"
                  aria-label="Xóa từ khóa"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1.5 flex h-4 w-4 items-center justify-center rounded text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
                >
                  <X size={11} />
                </button>
              ) : null}
            </div>
          </div>

          <div className="no-scrollbar flex-1 overflow-y-auto px-2 py-0.5">
            {showingSearch ? (
              <div aria-busy={isSearching} className="flex flex-col gap-0.5">
                {visibleResults === null ? (
                  <div className="py-8 text-center text-[12px] text-zinc-400">
                    <Loader2 size={14} className="mx-auto animate-spin" />
                    <span className="sr-only">Đang tìm kiếm…</span>
                  </div>
                ) : visibleResults.length === 0 ? (
                  <div className="py-8 text-center text-[12px] text-zinc-400">
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
                <div key={g.label} className="mb-3 last:mb-0">
                  <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
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

          <div className="border-t border-white/10 px-2 pb-safe-2 pt-1.5">
            <button
              type="button"
              onClick={cycleTheme}
              aria-label={`Giao diện: ${themeLabel}`}
              title={`Giao diện: ${themeLabel} (bấm để đổi)`}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200"
            >
              <ThemeIcon size={14} />
              <span>{themeLabel}</span>
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200"
            >
              <SettingsIcon size={14} />
              <span>Cài đặt</span>
            </button>
          </div>
        </aside>
      )}

      {collapsed && (
        <aside
          aria-label="Thanh bên thu gọn"
          className="fixed inset-y-0 left-0 z-40 hidden w-12 flex-col items-center border-r border-white/10 bg-slate-900/40 backdrop-blur-xl pt-safe transition-colors duration-200 md:flex"
        >
          <div className="flex flex-col items-center gap-1 py-2">
            <button
              type="button"
              aria-label="Mở rộng thanh bên"
              title="Mở rộng (Ctrl+\\)"
              onClick={() => setSidebarCollapsed(false)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
            >
              <PanelLeftOpen size={15} />
            </button>
            <button
              type="button"
              aria-label="Đoạn chat mới"
              title="Đoạn chat mới (Ctrl+Alt+N)"
              onClick={() => void handleNewChat()}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="flex-1" />
          <div className="flex flex-col items-center gap-1 py-2 pb-safe-2">
            <button
              type="button"
              aria-label={`Giao diện: ${themeLabel}`}
              title={`Giao diện: ${themeLabel} (bấm để đổi)`}
              onClick={cycleTheme}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
            >
              <ThemeIcon size={15} />
            </button>
            <button
              type="button"
              aria-label="Cài đặt"
              title="Cài đặt"
              onClick={() => setSettingsOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
            >
              <SettingsIcon size={15} />
            </button>
          </div>
        </aside>
      )}
    </>
  );
}
