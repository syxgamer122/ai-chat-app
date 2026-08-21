'use client';

import React, { memo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type ChatSession } from '@/lib/db';
import { useAppStore } from '@/lib/store';
import { Plus, MessageSquare, Pin, Trash2, Search, Settings as SettingsIcon, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

/* ------------------------------------------------------------------ */
/* Hoisted & Memoized ChatItem                                        */
/* ------------------------------------------------------------------ */
interface ChatItemProps {
  chat: ChatSession;
  isActive: boolean;
  onSelect: (id: string) => void;
  onTogglePin: (e: React.MouseEvent, id: string, currentPin: 0 | 1) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
}

const ChatItem = memo(function ChatItem({
  chat,
  isActive,
  onSelect,
  onTogglePin,
  onDelete,
}: ChatItemProps) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -10 }}
      transition={{ duration: 0.15 }}
      onClick={() => onSelect(chat.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(chat.id);
        }
      }}
      className={`group w-full flex items-center justify-between p-2.5 rounded-xl cursor-pointer transition-all text-left outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
        isActive
          ? 'bg-zinc-800/90 text-zinc-100 shadow-sm'
          : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
      }`}
    >
      <div className="flex items-center gap-3 overflow-hidden flex-1 min-w-0 pr-2">
        <MessageSquare
          size={16}
          className={`flex-shrink-0 ${isActive ? 'text-indigo-400' : 'text-zinc-600'}`}
        />
        <span className="truncate text-sm font-medium">{chat.title}</span>
      </div>
      <div className="flex items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={(e) => onTogglePin(e, chat.id, chat.pinned)}
          title={chat.pinned ? 'Bỏ ghim' : 'Ghim đoạn chat'}
          aria-label="Toggle pin chat"
          className={`p-1.5 rounded-lg transition-colors ${
            chat.pinned ? 'text-indigo-400 bg-indigo-500/10' : 'text-zinc-500 hover:text-indigo-400 hover:bg-zinc-800'
          }`}
        >
          <Pin size={13} />
        </button>
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
    </motion.div>
  );
});

/* ------------------------------------------------------------------ */
/* Sidebar Component (Hỗ trợ Desktop & Mobile Drawer)                 */
/* ------------------------------------------------------------------ */
export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const currentChatId = useAppStore((s) => s.currentChatId);
  const setCurrentChatId = useAppStore((s) => s.setCurrentChatId);
  const isSidebarOpen = useAppStore((s) => s.isSidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);

  const [search, setSearch] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const chats = useLiveQuery(() => db.chats.orderBy('updatedAt').reverse().toArray(), []);

  const filteredChats =
    chats?.filter((c) => c.title.toLowerCase().includes(search.toLowerCase())) || [];
  const pinnedChats = filteredChats.filter((c) => Boolean(c.pinned));
  const recentChats = filteredChats.filter((c) => !c.pinned);

  const createNewChat = () => {
    setCurrentChatId(null);
    setSidebarOpen(false);
  };

  const selectChat = (id: string) => {
    setCurrentChatId(id);
    setSidebarOpen(false);
  };

  const deleteChat = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await db.transaction('rw', db.messages, db.chats, async () => {
        await db.messages.where('chatId').equals(id).delete();
        await db.chats.delete(id);
      });
      if (currentChatId === id) setCurrentChatId(null);
      setDeletingId(null);
    } catch (err) {
      console.error('[sidebar deleteChat]', err);
    }
  };

  const togglePin = async (e: React.MouseEvent, id: string, currentPin: 0 | 1) => {
    e.stopPropagation();
    try {
      await db.chats.update(id, { pinned: currentPin ? 0 : 1 });
    } catch (err) {
      console.error('[sidebar togglePin]', err);
    }
  };

  const sidebarContent = (
    <div className="w-[280px] h-full bg-zinc-950 border-r border-zinc-800/50 flex flex-col flex-shrink-0 z-40">
      {/* Header / New Chat */}
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={createNewChat}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl transition-colors text-sm font-medium shadow-sm"
          >
            <Plus size={16} /> New Chat <span className="ml-auto text-xs opacity-60 font-mono hidden md:inline">⌘N</span>
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
            type="text"
            placeholder="Tìm kiếm..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl pl-9 pr-4 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 transition-colors"
          />
        </div>
      </div>

      {/* Chat list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-6">
        {pinnedChats.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-zinc-600 mb-2 px-2 uppercase tracking-wider">
              Pinned
            </div>
            <div className="space-y-0.5">
              <AnimatePresence initial={false}>
                {pinnedChats.map((c) => (
                  <ChatItem
                    key={c.id}
                    chat={c}
                    isActive={currentChatId === c.id}
                    onSelect={selectChat}
                    onTogglePin={togglePin}
                    onDelete={deleteChat}
                  />
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}

        <div>
          <div className="text-xs font-semibold text-zinc-600 mb-2 px-2 uppercase tracking-wider">
            Recent
          </div>
          <div className="space-y-0.5">
            <AnimatePresence initial={false}>
              {recentChats.map((c) => (
                <ChatItem
                  key={c.id}
                  chat={c}
                  isActive={currentChatId === c.id}
                  onSelect={selectChat}
                  onTogglePin={togglePin}
                  onDelete={deleteChat}
                />
              ))}
            </AnimatePresence>
            {filteredChats.length === 0 && (
              <div className="text-center py-8 text-xs text-zinc-600">
                {search ? 'Không tìm thấy cuộc trò chuyện' : 'Chưa có lịch sử trò chuyện'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer / Settings */}
      <div className="p-4 border-t border-zinc-800/50">
        <button
          type="button"
          onClick={() => {
            onOpenSettings();
            setSidebarOpen(false);
          }}
          className="w-full flex items-center gap-3 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 rounded-xl transition-colors"
        >
          <SettingsIcon size={16} /> Cài đặt
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Persistent Sidebar */}
      <div className="hidden md:flex h-full">{sidebarContent}</div>

      {/* Mobile Drawer Backdrop & Sidebar */}
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
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
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
