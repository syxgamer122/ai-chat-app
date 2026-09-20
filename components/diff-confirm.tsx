'use client';

import { Z_CLASS } from '@/lib/ui-z';
import { useEffect, useMemo, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { lineDiff, renderUnifiedDiff } from '@/lib/naive-diff';
import { useHaptics } from '@/components/effects';
import { useFocusTrap } from '@/lib/hooks/use-focus-trap';

/**
 * Modal phê duyệt ghi file của agent coding — cổng an toàn BẮT BUỘC trước
 * khi fs_write chạm vào đĩa của người dùng. Hiển thị unified diff (naive),
 * Escape = từ chối. Promise-based để onToolCall await quyết định.
 */

export interface DiffConfirmState {
  open: boolean;
  path: string;
  oldText: string;
  newText: string;
  /** resolve(true) = Apply, resolve(false) = Discard. */
  resolve: (approved: boolean) => void;
}

export function DiffConfirm({
  state,
  onClose,
}: {
  state: DiffConfirmState | null;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);

  const diff = useMemo(() => {
    if (!state?.open) return null;
    return renderUnifiedDiff(lineDiff(state.oldText, state.newText));
  }, [state]);

  /* Hook PHẢI gọi trước mọi early-return (rules-of-hooks). */
  const haptics = useHaptics();

  const decide = (approved: boolean) => {
    if (approved) haptics.trigger('success');
    state?.resolve(approved);
    onClose();
  };

  useFocusTrap(containerRef, {
    active: Boolean(state?.open && diff),
    onEscape: () => decide(false),
  });

  if (!state?.open || !diff) return null;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="diff-confirm-title"
      className={`fixed inset-0 ${Z_CLASS.approval} flex items-center justify-center bg-black/60 p-4`}
      onClick={() => decide(false)}
    >
      <div
        className="pi-frame relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-none border border-border-hairline bg-panel-bg font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="pi-corner-tl" />
        <span className="pi-corner-tr" />
        <span className="pi-corner-bl" />
        <span className="pi-corner-br" />

        <div className="flex items-center justify-between gap-2 border-b border-border-hairline bg-surface-raised px-4 py-3">
          <h2 id="diff-confirm-title" className="flex items-center gap-2 min-w-0 font-pixel text-[16px] [image-rendering:pixelated]">
            <span className="font-bold text-accent-steel">$</span>
            <span className="font-semibold text-accent-steel">write</span>
            <span className="truncate text-xs font-mono text-text-primary">{state.path}</span>
          </h2>
          <div className="flex flex-shrink-0 items-center gap-1.5 text-[11px] font-mono">
            <span className="rounded-none border border-status-success/30 bg-[#5db87a]/10 px-1.5 py-0.5 text-status-success">
              +{diff.adds}
            </span>
            <span className="rounded-none border border-status-error/30 bg-[#e8704f]/10 px-1.5 py-0.5 text-status-error">
              -{diff.dels}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-bg-deep p-3.5 font-mono text-[11.5px] leading-relaxed">
          {diff.text.split('\n').map((line, idx) => {
            const isAdd = line.startsWith('+');
            const isDel = line.startsWith('-');
            const isHunk = line.startsWith('@');
            return (
              <div
                key={idx}
                className={
                  isAdd
                    ? 'diff-line-added px-1 text-status-success bg-[#5db87a]/10'
                    : isDel
                      ? 'diff-line-removed px-1 text-status-error bg-[#e8704f]/10'
                      : isHunk
                        ? 'text-accent-steel font-semibold'
                        : 'text-text-muted'
                }
              >
                {line || ' '}
              </div>
            );
          })}
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
              Duyệt & ghi
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
