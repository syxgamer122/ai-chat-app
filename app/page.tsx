'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Sidebar } from '@/components/sidebar';
import ChatInterface from '@/components/chat-interface';
import { ChatErrorBoundary } from '@/components/chat-error-boundary';
import { useAppStore } from '@/lib/store';

/**
 * Settings tách khỏi bundle khởi động: đây là màn hình LỚN NHẤT (~40KB nguồn,
 * kéo theo provider-manager + prompt library + usage-stats) nhưng chỉ mở khi
 * người dùng bấm vào. Trước đây nó nằm trong chunk chính nên ai cũng phải tải
 * dù không bao giờ mở.
 *
 * `ssr: false` là đúng ngữ nghĩa ở đây: toàn bộ nội dung đọc từ IndexedDB nên
 * không render được phía server; hơn nữa page này đã nằm sau cổng `isMounted`.
 */
const SettingsDialog = dynamic(
  () => import('@/components/settings-dialog').then((m) => m.SettingsDialog),
  { ssr: false },
);

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
   * Vyen đã commit dark-only (xem app/layout.tsx). Effect này giữ cứng
   * class `dark` lên <html> cho mọi lần re-render, phòng extension hoặc
   * mã khác gỡ nhầm. Có thể xoá khi nào `theme` bị gỡ khỏi store.
   */
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, [theme]);

  /* Trạng thái mới nhất cho handler phím tắt. Đọc qua ref để listener KHÔNG
     phải gắn/gỡ lại mỗi lần thu gọn sidebar hay mở settings — trước đây
     effect phụ thuộc `isSidebarCollapsed` + `isSettingsOpen` nên cứ đổi là
     removeEventListener + addEventListener một vòng. */
  const latest = useRef({ isSettingsOpen, isSidebarCollapsed });
  latest.current = { isSettingsOpen, isSidebarCollapsed };

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
        setSidebarCollapsed(!latest.current.isSidebarCollapsed);
      }
      if (e.key === 'Escape' && latest.current.isSettingsOpen) setSettingsOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // Các setter của Zustand ổn định — effect này chạy đúng MỘT lần.
  }, [setCurrentChatId, setSettingsOpen, setSidebarCollapsed]);

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
