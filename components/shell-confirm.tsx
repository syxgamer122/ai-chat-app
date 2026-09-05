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
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
      onClick={() => decide(false)}
    >
      <div
        className="pi-frame relative flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-none border border-[#495059] bg-[#212730] font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="pi-corner-tl" />
        <span className="pi-corner-tr" />
        <span className="pi-corner-bl" />
        <span className="pi-corner-br" />

        <div className="flex items-center gap-2 border-b border-[#495059] bg-[#161d27] px-4 py-3">
          <Terminal size={14} className="text-[#6a9fcc]" />
          <div className="flex items-center gap-1.5 text-xs">
            <span className="font-bold text-[#6a9fcc]">$</span>
            <span className="font-semibold text-[#6a9fcc]">bash</span>
            <span className="text-[#9fa4ab]">· execution permission</span>
          </div>
        </div>

        <div className="px-4 py-3 space-y-2">
          {state.cwd && (
            <div className="truncate text-[11px] text-[#9fa4ab]">
              cwd: {state.cwd || '.'}
            </div>
          )}
          <div className="rounded-none border border-[#495059] bg-[#0d1116] p-3 font-mono text-xs text-[#ebe7e4]">
            <div className="flex items-start gap-2">
              <span className="select-none font-bold text-[#6a9fcc]">$</span>
              <span className="break-all leading-relaxed">{state.command}</span>
            </div>
          </div>
          <div className="text-[11px] text-[#9fa4ab] leading-relaxed">
            Lệnh sẽ chạy trong workspace desktop của bạn.
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[#495059] bg-[#161d27] px-4 py-2.5">
          <span className="text-[11px] text-[#9fa4ab]">$ Esc to reject</span>
          <div className="flex gap-2">
            <button
              ref={discardRef}
              type="button"
              onClick={() => decide(false)}
              className="flex items-center gap-1.5 rounded-none border border-[#495059] bg-[#252f3d] px-3 py-1.5 text-xs text-[#ebe7e4] transition-colors hover:border-[#757d89]"
            >
              <X size={13} />
              Từ chối
            </button>
            <button
              type="button"
              onClick={() => decide(true)}
              className="flex items-center gap-1.5 rounded-none bg-[#6a9fcc] px-3.5 py-1.5 text-xs font-semibold text-[#0d1116] transition-colors hover:bg-[#6a9fcc]/85"
            >
              <Check size={13} />
              Duyệt & chạy
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
