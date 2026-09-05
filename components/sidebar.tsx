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
import { VyenLogo } from '@/components/vyen-logo';
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
          className="z-[100] w-48 animate-pop-in rounded-none border border-[#495059] bg-[#161d27] p-1 font-mono text-xs"
        >
          <button
            type="button" role="menuitem"
            onClick={() => { onTogglePin(chat.id, (chat.pinned ?? 0) as 0 | 1); closeMenu(); }}
            className="flex w-full items-center gap-2 rounded-none px-2.5 py-1.5 text-[12px] text-[#ebe7e4] transition-colors hover:bg-[#212730]"
          >
            <Pin size={13} className="text-[#6a9fcc]" />
            {chat.pinned ? 'Bỏ ghim' : 'Ghim lên đầu'}
          </button>
          <button
            type="button" role="menuitem"
            onClick={() => { onExport(chat.id, 'json'); closeMenu(); }}
            className="flex w-full items-center gap-2 rounded-none px-2.5 py-1.5 text-[12px] text-[#ebe7e4] transition-colors hover:bg-[#212730]"
          >
            <FileJson size={13} className="text-[#6a9fcc]" /> Xuất JSON
          </button>
          <button
            type="button" role="menuitem"
            onClick={() => { onExport(chat.id, 'md'); closeMenu(); }}
            className="flex w-full items-center gap-2 rounded-none px-2.5 py-1.5 text-[12px] text-[#ebe7e4] transition-colors hover:bg-[#212730]"
          >
            <FileText size={13} className="text-[#6a9fcc]" /> Xuất Markdown
          </button>
          <div className="my-1 h-px bg-[#495059]" />
          <button
            type="button" role="menuitem"
            onClick={() => { onDelete(chat.id); closeMenu(); }}
            className="flex w-full items-center gap-2 rounded-none px-2.5 py-1.5 text-[12px] text-[#e8704f] transition-colors hover:bg-[#e8704f]/10"
          >
            <Trash2 size={13} /> Xóa cuộc trò chuyện
          </button>
        </div>,
        document.body,
      )
    : null;

  return (
    <div
      className={`group relative flex w-full flex-col rounded-none text-left transition-colors duration-100 ease-out font-mono ${
        isActive
          ? 'pi-active-indicator bg-[#212730] text-[#ebe7e4]'
          : 'text-[#9fa4ab] hover:bg-[#161d27] hover:text-[#ebe7e4]'
      }`}
    >
      <div className="flex w-full items-center justify-between gap-1 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => onSelect(chat.id)}
          aria-current={isActive ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-none text-left outline-none"
        >
          <MessageSquare
            size={13}
            className={`flex-shrink-0 ${isActive ? 'text-[#6a9fcc]' : 'text-[#9fa4ab]'}`}
          />
          <span className={`truncate text-[12.5px] ${isActive ? 'font-medium text-[#ebe7e4]' : 'text-[#9fa4ab]'}`}>
            {titleSegments ? <Highlight segments={titleSegments} /> : chat.title}
          </span>
        </button>

        <div className="flex items-center gap-0.5">
          {chat.pinned && <Pin size={10} className="rotate-45 text-[#e8993a]" />}
          <button
            ref={triggerRef}
            type="button"
            aria-label="Tùy chọn cuộc trò chuyện"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => (menuOpen ? closeMenu() : openMenu())}
            className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-none text-[#9fa4ab] transition-all hover:bg-[#252f3d] hover:text-[#ebe7e4] ${
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
            <p key={i} className="truncate text-[11px] leading-relaxed text-[#9fa4ab]">
              <Highlight segments={seg} />
            </p>
          ))}
          {extraHits ? (
            <p className="text-[11px] text-[#9fa4ab]">+{extraHits} kết quả khác</p>
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
          className="fixed inset-0 z-30 bg-black/60 animate-fade-in md:hidden"
        />
      )}

      {!collapsed && (
        <aside
          aria-label="Danh sách cuộc trò chuyện"
          aria-hidden={isDrawerHidden ? true : undefined}
          inert={isDrawerHidden ? true : undefined}
          className={`fixed inset-y-0 left-0 z-40 flex w-[17rem] max-w-[85vw] flex-col border-r border-[#495059] bg-[#0d1116] pt-safe transition-transform duration-200 ease-out md:static md:w-64 md:max-w-none md:translate-x-0 ${
            isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="flex items-center justify-between px-3 pb-2 pt-3">
            <VyenLogo size="sm" />
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                aria-label="Thu gọn thanh bên"
                title="Thu gọn (Ctrl+\)"
                onClick={() => setSidebarCollapsed(true)}
                className="flex h-7 w-7 items-center justify-center rounded-none text-[#9fa4ab] transition-colors hover:bg-[#252f3d] hover:text-[#ebe7e4] hidden md:inline-flex"
              >
                <PanelLeftClose size={15} />
              </button>
              <button
                type="button"
                aria-label="Đóng thanh bên"
                onClick={() => setSidebarOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-none text-[#9fa4ab] transition-colors hover:bg-[#252f3d] hover:text-[#ebe7e4] md:hidden"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="px-3 pb-2">
            <button
              type="button"
              onClick={handleNewChat}
              className="flex w-full items-center justify-center gap-2 rounded-none border border-[#495059] bg-[#161d27] px-3 py-1.5 font-mono text-xs font-medium text-[#ebe7e4] transition-colors hover:border-[#757d89] hover:bg-[#212730] active:scale-[0.98]"
            >
              <Plus size={13} className="text-[#6a9fcc]" />
              <span>$ new session</span>
            </button>
          </div>

          <BackupReminder chatCount={chats.length} />

          <div className="px-3 pb-2">
            <div className="relative flex items-center">
              <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2.5 text-[#9fa4ab]" />
              <input
                type="search"
                aria-label="Tìm trong các cuộc trò chuyện"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="$ /search..."
                className="w-full rounded-none border border-[#495059] bg-[#0d1116] py-1.5 pl-8 pr-7 font-mono text-[12px] text-[#ebe7e4] outline-none transition-colors placeholder:text-[#9fa4ab] focus:border-[#6a9fcc] focus:bg-[#161d27]"
              />
              {isSearching ? (
                <Loader2 size={12} aria-hidden="true" className="absolute right-2 animate-spin text-[#6a9fcc]" />
              ) : searchQuery ? (
                <button
                  type="button"
                  aria-label="Xóa từ khóa"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1.5 flex h-4 w-4 items-center justify-center rounded-none text-[#9fa4ab] transition-colors hover:bg-[#252f3d] hover:text-[#ebe7e4]"
                >
                  <X size={11} />
                </button>
              ) : null}
            </div>
          </div>

          <div className="no-scrollbar flex-1 overflow-y-auto px-2 py-0.5">
            {showingSearch ? (
              <div aria-busy={isSearching} className="flex flex-col gap-0.5 border-l border-[#495059]/40 ml-2 pl-1.5">
                {visibleResults === null ? (
                  <div className="py-8 text-center text-[12px] text-[#9fa4ab]">
                    <Loader2 size={14} className="mx-auto animate-spin" />
                    <span className="sr-only">Đang tìm kiếm…</span>
                  </div>
                ) : visibleResults.length === 0 ? (
                  <div className="py-8 text-center text-[12px] text-[#9fa4ab]">
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
                  <div className="px-2 pb-1 pt-1 font-pixel text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6a9fcc] [image-rendering:pixelated]">
                    $ {g.label}
                  </div>
                  <div className="flex flex-col gap-0.5 border-l border-[#495059]/40 ml-2 pl-1.5">
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

          <div className="border-t border-[#495059] px-2 pb-safe-2 pt-1.5 font-mono">
            <button
              type="button"
              onClick={cycleTheme}
              aria-label={`Giao diện: ${themeLabel}`}
              title={`Giao diện: ${themeLabel} (bấm để đổi)`}
              className="flex w-full items-center gap-2 rounded-none px-2 py-1.5 text-[11.5px] text-[#9fa4ab] transition-colors hover:bg-[#252f3d] hover:text-[#ebe7e4]"
            >
              <ThemeIcon size={13} />
              <span>{themeLabel}</span>
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex w-full items-center gap-2 rounded-none px-2 py-1.5 text-[11.5px] text-[#9fa4ab] transition-colors hover:bg-[#252f3d] hover:text-[#ebe7e4]"
            >
              <SettingsIcon size={13} />
              <span>Cài đặt</span>
            </button>
          </div>
        </aside>
      )}

      {collapsed && (
        <aside
          aria-label="Thanh bên thu gọn"
          className="fixed inset-y-0 left-0 z-40 hidden w-12 flex-col items-center border-r border-[#495059] bg-[#0d1116] pt-safe transition-colors duration-200 md:flex"
        >
          <div className="flex flex-col items-center gap-1 py-2">
            <button
              type="button"
              aria-label="Mở rộng thanh bên"
              title="Mở rộng (Ctrl+\)"
              onClick={() => setSidebarCollapsed(false)}
              className="flex h-8 w-8 items-center justify-center rounded-none text-[#9fa4ab] transition-colors hover:bg-[#252f3d] hover:text-[#ebe7e4]"
            >
              <PanelLeftOpen size={15} />
            </button>
            <button
              type="button"
              aria-label="Đoạn chat mới"
              title="Đoạn chat mới (Ctrl+Alt+N)"
              onClick={() => void handleNewChat()}
              className="flex h-8 w-8 items-center justify-center rounded-none text-[#9fa4ab] transition-colors hover:bg-[#252f3d] hover:text-[#6a9fcc]"
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="flex-1" />
          <div className="flex flex-col items-center gap-1 py-2 pb-safe-2">
            <button
              type="button"
              aria-label={`Giao diện: ${themeLabel}`}
              title={`Giao diện: ${themeLabel} (bấm để đổi)`}
              onClick={cycleTheme}
              className="flex h-8 w-8 items-center justify-center rounded-none text-[#9fa4ab] transition-colors hover:bg-[#252f3d] hover:text-[#ebe7e4]"
            >
              <ThemeIcon size={14} />
            </button>
            <button
              type="button"
              aria-label="Cài đặt"
              title="Cài đặt"
              onClick={() => setSettingsOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-none text-[#9fa4ab] transition-colors hover:bg-[#252f3d] hover:text-[#ebe7e4]"
            >
              <SettingsIcon size={14} />
            </button>
          </div>
        </aside>
      )}
    </>
  );
}
