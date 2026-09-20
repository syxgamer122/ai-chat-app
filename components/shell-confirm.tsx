'use client';

import { Z_CLASS } from '@/lib/ui-z';
import { useEffect, useRef } from 'react';
import { Check, Terminal, X } from 'lucide-react';
import { useHaptics } from '@/components/effects';
import { useFocusTrap } from '@/lib/hooks/use-focus-trap';

export interface ShellConfirmState {
  open: boolean;
  command: string;
  cwd?: string;
  resolve: (approved: boolean) => void;
}

export function ShellConfirm({ state, onClose }: { state: ShellConfirmState | null; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const haptics = useHaptics();

  const decide = (approved: boolean) => {
    if (approved) haptics.trigger('success');
    state?.resolve(approved);
    onClose();
  };

  useFocusTrap(containerRef, {
    active: Boolean(state?.open),
    onEscape: () => decide(false),
  });

  if (!state?.open) return null;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="shell-confirm-title"
      className={`fixed inset-0 ${Z_CLASS.approval} flex items-center justify-center bg-black/70 p-4`}
      onClick={() => decide(false)}
    >
      <div
        className="pi-frame relative flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-none border border-border-hairline bg-panel-bg font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="pi-corner-tl" />
        <span className="pi-corner-tr" />
        <span className="pi-corner-bl" />
        <span className="pi-corner-br" />

        <div className="flex items-center gap-2 border-b border-border-hairline bg-surface-raised px-4 py-3">
          <Terminal size={14} className="text-accent-steel" />
          <h2 id="shell-confirm-title" className="flex items-center gap-1.5 text-xs font-semibold">
            <span className="font-bold text-accent-steel">$</span>
            <span className="text-accent-steel">bash</span>
            <span className="text-text-muted">· execution permission</span>
          </h2>
        </div>

        <div className="px-4 py-3 space-y-2">
          {state.cwd && (
            <div className="truncate text-[11px] text-text-muted">
              cwd: {state.cwd || '.'}
            </div>
          )}
          <div className="rounded-none border border-border-hairline bg-bg-deep p-3 font-mono text-xs text-text-primary">
            <div className="flex items-start gap-2">
              <span className="select-none font-bold text-accent-steel">$</span>
              <span className="break-all leading-relaxed">{state.command}</span>
            </div>
          </div>
          <div className="text-[11px] text-text-muted leading-relaxed">
            Lệnh sẽ chạy trong workspace desktop của bạn.
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border-hairline bg-surface-raised px-4 py-2.5">
          <span className="text-[11px] text-text-muted">$ Esc to reject</span>
          <div className="flex gap-2">
            <button
              ref={discardRef}
              type="button"
              onClick={() => decide(false)}
              className="flex items-center gap-1.5 rounded-none border border-border-hairline bg-panel-soft px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-border-hover"
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
