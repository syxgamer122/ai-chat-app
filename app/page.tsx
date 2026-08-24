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
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const isSidebarCollapsed = useAppStore((s) => s.isSidebarCollapsed);
  const animations = useAppStore((s) => s.settings.perf.animations);
  const theme = useAppStore((s) => s.theme);

  /*
   * Gắn class `dark` lên <html> theo lựa chọn của user. 'system' nghe thêm
   * matchMedia để đổi realtime khi OS đổi theme. Script inline trong layout
   * đã đặt class đúng từ trước first-paint — effect này chỉ giữ đồng bộ.
   */
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark =
        theme === 'dark' || (theme === 'system' && mq.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    if (theme !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    setIsMounted(true);
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Chat mới: Ctrl/Cmd+Alt+N. Ctrl+N và Ctrl+Shift+O là tổ hợp browser
      // reserved (cửa sổ mới / bookmark manager) — preventDefault không chặn
      // được nên phím tắt cũ không bao giờ chạy.
      if (mod && e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setCurrentChatId(null);
      }
      // Ctrl+\ — thu gọn/mở rộng sidebar trên desktop.
      if (mod && e.key === '\\') {
        e.preventDefault();
        setSidebarCollapsed(!isSidebarCollapsed);
      }
      if (e.key === 'Escape' && isSettingsOpen) setSettingsOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setCurrentChatId, isSettingsOpen, setSettingsOpen, setSidebarCollapsed, isSidebarCollapsed]);

  /* Cờ tắt hiệu ứng — CSS trong globals.css đọc qua html[data-animations]. */
  useEffect(() => {
    const root = document.documentElement;
    if (animations) root.removeAttribute('data-animations');
    else root.setAttribute('data-animations', 'off');
  }, [animations]);

  useEffect(() => {
    document.body.style.overflow = isSettingsOpen ? 'hidden' : 'unset';
    return () => { document.body.style.overflow = 'unset'; };
  }, [isSettingsOpen]);

  if (!isMounted) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-dvh items-center justify-center bg-surface text-sm text-zinc-500"
      >
        Đang mở không gian làm việc…
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
