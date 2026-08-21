'use client';

import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/sidebar';
import ChatInterface from '@/components/chat-interface';
import { db } from '@/lib/db';
import { useAppStore } from '@/lib/store';

export default function Home() {
  const [isMounted, setIsMounted] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { settings, updateSettings, setCurrentChatId } = useAppStore();

  useEffect(() => {
    setIsMounted(true);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'n') { 
        e.preventDefault();
        setCurrentChatId(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setCurrentChatId]);

  if (!isMounted) return <div className="h-screen bg-zinc-950 flex items-center justify-center text-zinc-500 font-mono text-sm">Loading workspace...</div>;

  return (
    <main className="flex h-screen overflow-hidden">
      <Sidebar onOpenSettings={() => setShowSettings(true)} />
      <ChatInterface />
      
      {showSettings && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <h2 className="text-xl font-medium mb-6">Settings</h2>
            <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-zinc-400 mb-1.5 block">AI Model</label>
                  <select 
                     value={settings.model}
                     onChange={(e) => updateSettings({ model: e.target.value })}
                     className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-sm outline-none focus:border-indigo-500"
                  >
                     <option value="gpt-5.5">GPT-5.5</option>
                     <option value="gpt-5.6-luna">GPT-5.6 Luna</option>
                     <option value="gpt-5.6-sol">GPT-5.6 Sol</option>
                     <option value="gpt-5.6-terra">GPT-5.6 Terra</option>
                     <option value="claude-opus-5">Claude Opus 5</option>
                     <option value="claude-sonnet-5">Claude Sonnet 5</option>
                     <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
                     <option value="minimax_m3">MiniMax M3</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm font-medium text-zinc-400 mb-1.5 block">
                    Custom API Key <span className="text-xs text-zinc-600 font-normal">(Tùy chọn - để trống sẽ dùng Key xoay vòng của Server)</span>
                  </label>
                  <input
                    type="password"
                    placeholder="sk-..."
                    value={settings.apiKey || ''}
                    onChange={(e) => updateSettings({ apiKey: e.target.value })}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-sm outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
                <div className="pt-4 border-t border-zinc-800">
                 <button onClick={async () => {
                   if(confirm('Are you sure you want to delete all local data?')) {
                     await db.delete(); window.location.reload();
                   }
                 }} className="text-red-400 text-sm hover:text-red-300 font-medium">
                   Delete All Local Data
                 </button>
               </div>
            </div>
            <button onClick={() => setShowSettings(false)} className="mt-8 w-full bg-zinc-100 text-zinc-900 font-medium py-2.5 rounded-xl hover:bg-white transition-colors">Done</button>
          </div>
        </div>
      )}
    </main>
  );
}
