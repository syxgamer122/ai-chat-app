'use client';

import { useMemo } from 'react';
import { Check, X, Trash2, FileText } from 'lucide-react';
import { lineDiff, renderUnifiedDiff } from '@/lib/naive-diff';
import type { StagingStore, StagingStats } from '@/lib/staging';
import { stagingStats as computeStats } from '@/lib/staging';

export interface StagingPanelState {
  open: boolean;
}

/**
 * Panel review batch thay đổi của agent (Plandex-style staging sandbox).
 * Hiển thị diff từng file, reject từng file hoặc reject all, Apply all.
 * Đĩa CHƯA BAO GIỜ bị đụng cho tới khi user bấm Apply.
 */
export function StagingPanel({
  store,
  onClose,
  onApplyAll,
  onRejectFile,
  onRejectAll,
}: {
  store: StagingStore;
  onClose: () => void;
  onApplyAll: () => void;
  onRejectFile: (path: string) => void;
  onRejectAll: () => void;
}) {
  const stats: StagingStats = useMemo(() => computeStats(store), [store]);
  const files = useMemo(() => Object.values(store).sort((a, b) => a.path.localeCompare(b.path)), [store]);

  if (!files.length) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review staged changes"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-300 bg-surface-raised shadow-panel dark:border-zinc-700"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-zinc-900">
              Staged Changes — {stats.files} file{stats.files !== 1 ? 's' : ''}
            </div>
            <div className="text-[11px] text-zinc-600">
              {stats.newFiles > 0 && `${stats.newFiles} new · `}
              Thay đổi chưa ghi vào đĩa. Review rồi Apply hoặc Reject.
            </div>
          </div>
          <div className="flex flex-shrink-0 gap-1.5 text-[11px] font-medium">
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700">+{stats.addedLines}</span>
            <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700">-{stats.removedLines}</span>
          </div>
        </div>

        {/* File list with diffs */}
        <div className="flex-1 overflow-auto p-3 space-y-3">
          {files.map((file) => {
            const diff = renderUnifiedDiff(lineDiff(file.original ?? '', file.content), { contextLines: 2 });
            return (
              <div key={file.path} className="rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
                <div className="flex items-center justify-between gap-2 bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <FileText size={13} className="flex-shrink-0 text-zinc-500" />
                    <span className="truncate font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{file.path}</span>
                    {file.original === null && (
                      <span className="flex-shrink-0 rounded bg-blue-100 px-1 py-0.5 text-[10px] font-medium text-blue-700">NEW</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRejectFile(file.path)}
                    title="Reject this file"
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                  >
                    <X size={12} />
                    Reject
                  </button>
                </div>
                <pre className="max-h-48 overflow-auto bg-surface-muted p-2 font-mono text-[11px] leading-relaxed text-zinc-800 dark:text-zinc-300 whitespace-pre-wrap break-all">
                  {diff.text}
                </pre>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-4 py-3">
          <button
            type="button"
            onClick={onRejectAll}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
          >
            <Trash2 size={13} />
            Reject All
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onApplyAll}
              className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover"
            >
              <Check size={13} />
              Apply All ({stats.files} files)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
