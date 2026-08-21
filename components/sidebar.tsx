'use client';

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { useAppStore } from '@/lib/store';
import { Plus, MessageSquare, Pin, Trash2, Search, Settings as SettingsIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { currentChatId, setCurrentChatId } = useAppStore();
  const [search, setSearch] = useState('');
  
  const chats = useLiveQuery(() => 
    db.chats.orderBy('updatedAt').reverse().toArray(), []
  );

  const filteredChats = chats?.filter(c => c.title.toLowerCase().includes(search.toLowerCase())) || [];
  const pinnedChats = filteredChats.filter(c => c.pinned);
  const recentChats = filteredChats.filter(c => !c.pinned);

  const createNewChat = () => setCurrentChatId(null);

  const deleteChat = async (e: React.MouseEvent, id: string) => {
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
  };

  const togglePin = async (e: React.MouseEvent, id: string, currentPin: boolean) => {
    e.stopPropagation();
    await db.chats.update(id, { pinned: !currentPin });
  };

  const ChatItem = ({ chat }: { chat: any }) => (
    <motion.div layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={() => setCurrentChatId(chat.id)}
      className={`group w-full flex items-center justify-between p-2.5 rounded-lg cursor-pointer transition-all ${
        currentChatId === chat.id ? 'bg-zinc-800/80 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
      }`}
    >
      <div className="flex items-center gap-3 overflow-hidden">
        <MessageSquare size={16} className={currentChatId === chat.id ? 'text-indigo-400' : 'text-zinc-600'} />
        <div className="truncate text-sm font-medium">{chat.title}</div>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={(e) => togglePin(e, chat.id, chat.pinned)} className="p-1 hover:text-indigo-400"><Pin size={14} /></button>
        <button onClick={(e) => deleteChat(e, chat.id)} className="p-1 hover:text-red-400"><Trash2 size={14} /></button>
      </div>
    </motion.div>
  );

  return (
    <div className="w-[280px] h-full bg-zinc-950 border-r border-zinc-800/50 flex flex-col flex-shrink-0 hidden md:flex">
      <div className="p-4 space-y-3">
        <button onClick={createNewChat} className="w-full flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl transition-colors text-sm font-medium shadow-sm">
          <Plus size={16} /> New Chat <span className="ml-auto text-xs opacity-60 font-mono">⌘N</span>
        </button>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input 
            type="text" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-4 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-700 transition-colors"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-6">
        {pinnedChats.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-zinc-600 mb-2 px-2 uppercase tracking-wider">Pinned</div>
            <div className="space-y-0.5">{pinnedChats.map(c => <ChatItem key={c.id} chat={c} />)}</div>
          </div>
        )}
        <div>
          <div className="text-xs font-semibold text-zinc-600 mb-2 px-2 uppercase tracking-wider">Recent</div>
          <div className="space-y-0.5">{recentChats.map(c => <ChatItem key={c.id} chat={c} />)}</div>
        </div>
      </div>

      <div className="p-4 border-t border-zinc-800/50">
        <button onClick={onOpenSettings} className="w-full flex items-center gap-3 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 rounded-lg transition-colors">
          <SettingsIcon size={16} /> Settings
        </button>
      </div>
    </div>
  );
}
