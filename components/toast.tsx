'use client';

/*
 * Toast thông báo. `chat-interface` vốn có state `notice` + `showNotice()` gọi
 * ở ~10 chỗ (tệp quá lớn, stream gián đoạn, lỗi chuyển nhánh…) nhưng chưa bao
 * giờ được render — mọi thông báo lỗi đều bị mất. Component này lấp chỗ đó.
 */
import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

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
      className="pointer-events-none fixed inset-x-0 bottom-[calc(7rem+env(safe-area-inset-bottom))] z-50 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex max-w-md items-start gap-2.5 rounded-none border border-[#e8993a]/40 bg-[#212730] p-3 text-xs font-mono text-[#ebe7e4] animate-slide-up">
        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="min-w-0 flex-1">{message}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng thông báo"
          className="-mr-1 -mt-0.5 flex-shrink-0 rounded-none p-0.5 text-amber-700/70 transition-colors hover:bg-amber-100 hover:text-amber-900 dark:text-amber-400/70 dark:hover:bg-amber-500/10 dark:hover:text-amber-300"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
