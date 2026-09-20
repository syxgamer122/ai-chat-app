'use client';

import { Z_CLASS } from '@/lib/ui-z';
import { useEffect, useMemo, useRef } from 'react';
import { Check, X, Trash2, FileText } from 'lucide-react';
import { lineDiff, renderUnifiedDiff } from '@/lib/naive-diff';
import type { StagingStore, StagingStats } from '@/lib/staging';
import { stagingStats as computeStats } from '@/lib/staging';
import { EvidenceBadge } from '@/components/evidence-badge';
import { useFocusTrap } from '@/lib/hooks/use-focus-trap';

export interface StagingPanelState {
  open: boolean;
}

/**
 * Panel review batch thay đổi của agent (staging sandbox).
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

  const containerRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!files.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [files.length, onClose]);

  useFocusTrap(containerRef, {
    active: files.length > 0,
    onEscape: onClose,
  });

  if (!files.length) return null;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="staging-panel-title"
      className={`fixed inset-0 ${Z_CLASS.approval} flex items-center justify-center bg-black/60 p-4`}
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-none border border-border-hairline bg-panel-bg font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-border-hairline bg-surface-raised px-4 py-3">
          <div className="min-w-0">
            <h2 id="staging-panel-title" className="flex items-center gap-2 font-pixel text-[16px] font-semibold text-text-primary [image-rendering:pixelated]">
              <span className="font-bold text-accent-steel">$</span>
              <span className="text-accent-steel">staged</span>
              <span>· {stats.files} file{stats.files !== 1 ? 's' : ''}</span>
              <EvidenceBadge level="reported_done" className="ml-1" />
            </h2>
            <div className="text-[11px] text-text-muted">
              {stats.newFiles > 0 && `${stats.newFiles} new · `}
              Thay đổi chưa ghi vào đĩa. Review rồi Apply hoặc Reject.
            </div>
          </div>
          <div className="flex flex-shrink-0 gap-1.5 text-[11px] font-mono">
            <span className="rounded-none border border-status-success/30 bg-[#5db87a]/10 px-1.5 py-0.5 text-status-success">
              +{stats.addedLines}
            </span>
            <span className="rounded-none border border-status-error/30 bg-[#e8704f]/10 px-1.5 py-0.5 text-status-error">
              -{stats.removedLines}
            </span>
          </div>
        </div>

        {/* File list with diffs */}
        <div className="flex-1 overflow-auto p-3 space-y-3">
          {files.map((file) => {
            const diff = renderUnifiedDiff(lineDiff(file.original ?? '', file.content), { contextLines: 2 });
            return (
              <div key={file.path} className="rounded-none border border-border-hairline bg-surface-raised overflow-hidden">
                <div className="flex items-center justify-between gap-2 bg-surface-raised border-b border-border-hairline px-3 py-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <FileText size={12} className="flex-shrink-0 text-accent-steel" />
                    <span className="truncate font-mono text-[11px] text-text-primary">{file.path}</span>
                    {file.original === null && (
                      <span className="flex-shrink-0 rounded-none border border-accent-steel/40 bg-[#6a9fcc]/10 px-1 py-0.5 text-[9.5px] font-mono text-accent-steel">
                        NEW
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRejectFile(file.path)}
                    title="Reject this file"
                    className="flex items-center gap-1 rounded-none px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-[#e8704f]/10 hover:text-status-error"
                  >
                    <X size={12} />
                    Reject
                  </button>
                </div>
                <div className="max-h-48 overflow-auto bg-bg-deep p-2.5 font-mono text-[11px] leading-relaxed">
                  {diff.text.split('\n').map((line, idx) => {
                    const isAdd = line.startsWith('+');
                    const isDel = line.startsWith('-');
                    const isHunk = line.startsWith('@');
                    return (
                      <div
                        key={idx}
                        className={
                          isAdd
                            ? 'text-status-success bg-[#5db87a]/10 px-1'
                            : isDel
                              ? 'text-status-error bg-[#e8704f]/10 px-1'
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
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-border-hairline bg-surface-raised px-4 py-2.5">
          <button
            type="button"
            onClick={onRejectAll}
            className="flex items-center gap-1.5 rounded-none border border-status-error/30 bg-bg-deep px-3 py-1.5 text-xs text-status-error transition-colors hover:bg-[#e8704f]/10"
          >
            <Trash2 size={13} />
            Reject All
          </button>
          <div className="flex gap-2">
            <button
              ref={closeBtnRef}
              type="button"
              onClick={onClose}
              className="rounded-none border border-border-hairline bg-panel-soft px-3 py-1.5 text-xs text-text-primary transition-colors hover:border-border-hover"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onApplyAll}
              className="flex items-center gap-1.5 rounded-none bg-[#6a9fcc] px-3.5 py-1.5 text-xs font-semibold text-[#0d1116] transition-colors hover:bg-[#6a9fcc]/85"
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
