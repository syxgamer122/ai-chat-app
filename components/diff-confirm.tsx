'use client';

import { useEffect, useMemo, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { lineDiff, renderUnifiedDiff } from '@/lib/naive-diff';

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
  const discardRef = useRef<HTMLButtonElement>(null);

  const diff = useMemo(() => {
    if (!state?.open) return null;
    return renderUnifiedDiff(lineDiff(state.oldText, state.newText));
  }, [state]);

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

  if (!state?.open || !diff) return null;

  const decide = (approved: boolean) => {
    state.resolve(approved);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Phê duyệt ghi file ${state.path}`}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={() => decide(false)}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-300 bg-surface-raised shadow-panel dark:border-zinc-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-zinc-900">Agent muốn ghi file</div>
            <div className="truncate font-mono text-[11px] text-zinc-600">{state.path}</div>
          </div>
          <div className="flex flex-shrink-0 gap-1.5 text-[11px] font-medium">
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700">
              +{diff.adds}
            </span>
            <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700">-{diff.dels}</span>
          </div>
        </div>

        <pre className="flex-1 overflow-auto bg-surface-muted p-3 font-mono text-[11px] leading-relaxed text-zinc-800">
          {diff.text}
        </pre>

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
              Duyệt &amp; ghi
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
