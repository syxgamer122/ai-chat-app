'use client';

/*
 * Toast thông báo. `chat-interface` vốn có state `notice` + `showNotice()` gọi
 * ở ~10 chỗ (tệp quá lớn, stream gián đoạn, lỗi chuyển nhánh…) nhưng chưa bao
 * giờ được render — mọi thông báo lỗi đều bị mất. Component này lấp chỗ đó.
 *
 * Nguồn notice giờ là lib/notice-store (leaf store): ToastHost tự subscribe, ChatInterface
 * chỉ import showNotice() để gọi — một toast không còn re-render cây chat.
 */
import { Z_CLASS } from '@/lib/ui-z';
import React, { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { clearNotice, useNotice } from '@/lib/notice-store';

interface ToastProps {
  message: string | null;
  onClose: () => void;
}

export function Toast({ message, onClose }: ToastProps) {
  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none fixed inset-x-0 bottom-[calc(7rem+env(safe-area-inset-bottom))] ${Z_CLASS.toast} flex justify-center px-4`}
    >
      <div className="pointer-events-auto flex max-w-md items-start gap-2.5 rounded-none border border-status-warning/40 bg-panel-bg p-3 text-xs font-mono text-text-primary animate-slide-up">
        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-status-warning" />
        <p className="min-w-0 flex-1">{message}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng thông báo"
          className="-mr-1 -mt-0.5 flex-shrink-0 rounded-none p-0.5 text-status-warning transition-colors hover:bg-[#e8993a]/10"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

export function ToastHost() {
  const notice = useNotice();

  useEffect(() => {
    return () => clearNotice();
  }, []);

  return <Toast message={notice} onClose={clearNotice} />;
}
