'use client';

import { useEffect, useRef } from 'react';
import { Check, Terminal, X } from 'lucide-react';
import { useHaptics } from '@/components/effects';

export interface ShellConfirmState {
  open: boolean;
  command: string;
  cwd?: string;
  resolve: (approved: boolean) => void;
}

export function ShellConfirm({ state, onClose }: { state: ShellConfirmState | null; onClose: () => void }) {
  const discardRef = useRef<HTMLButtonElement>(null);
  const haptics = useHaptics();

  useEffect(() => {
    if (!state?.open) return;
    discardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        state.resolve(false);
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, onClose]);

  if (!state?.open) return null;

  const decide = (approved: boolean) => {
    if (approved) haptics.trigger('success');
    state.resolve(approved);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Phê duyệt chạy lệnh shell"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={() => decide(false)}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-zinc-300 bg-surface-raised shadow-panel dark:border-zinc-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3">
          <Terminal size={16} className="text-zinc-600" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-zinc-900">Agent muốn chạy lệnh</div>
            {state.cwd ? <div className="truncate font-mono text-[11px] text-zinc-600">cwd: {state.cwd || '.'}</div> : null}
          </div>
        </div>

        <div className="px-4 py-3">
          <div className="rounded-lg border border-zinc-200 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-100">
            <span className="text-zinc-500">$</span> {state.command}
          </div>
          <div className="mt-2 text-[11px] text-zinc-600">Lệnh sẽ chạy trong workspace desktop của bạn. Kiểm tra kỹ trước khi duyệt.</div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-4 py-3">
          <span className="text-[11px] text-zinc-600">Escape để từ chối</span>
          <div className="flex gap-2">
            <button
              ref={discardRef}
              type="button"
              onClick={() => decide(false)}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
            >
              <X size={13} />
              Từ chối
            </button>
            <button
              type="button"
              onClick={() => decide(true)}
              className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover"
            >
              <Check size={13} />
              Duyệt &amp; chạy
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
