'use client';

import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/sidebar';
import ChatInterface from '@/components/chat-interface';
import { ChatErrorBoundary } from '@/components/chat-error-boundary';
import { SettingsDialog } from '@/components/settings-dialog';
import { useAppStore } from '@/lib/store';

export default function Home() {
  const [isMounted, setIsMounted] = useState(false);
  const isSettingsOpen = useAppStore((s) => s.isSettingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setCurrentChatId = useAppStore((s) => s.setCurrentChatId);

  useEffect(() => {
    setIsMounted(true);
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if ((mod && e.key === 'n') || (mod && e.shiftKey && e.key.toLowerCase() === 'o')) {
        e.preventDefault();
        setCurrentChatId(null);
      }
      if (e.key === 'Escape' && isSettingsOpen) setSettingsOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setCurrentChatId, isSettingsOpen, setSettingsOpen]);

  useEffect(() => {
    document.body.style.overflow = isSettingsOpen ? 'hidden' : 'unset';
    return () => { document.body.style.overflow = 'unset'; };
  }, [isSettingsOpen]);

  if (!isMounted) {
    return (
      <div className="h-dvh bg-zinc-950 flex items-center justify-center text-zinc-500 font-mono text-sm">
        Loading workspace...
      </div>
    );
  }

  return (
    <main className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 h-full">
        <ChatErrorBoundary>
          <ChatInterface />
        </ChatErrorBoundary>
      </div>

      {isSettingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </main>
  );
}
