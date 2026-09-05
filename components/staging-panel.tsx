'use client';

import { useEffect, useMemo, useRef } from 'react';
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

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Mở dialog: focus nút Close (phần tử hợp lệ đầu tiên) để keyboard/Escape
    // hoạt động ngay; đóng thì trả focus về nơi đã mở panel.
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeBtnRef.current?.focus();
    return () => {
      restoreFocusRef.current?.focus();
    };
  }, []);

  // Escape nghe ở document chứ không phải onKeyDown trên container: click vào
  // vùng diff (không focusable) đẩy focus về document.body, keydown khi đó
  // không đi qua dialog nên handler trên container câm. Cùng chuẩn với
  // ThinkingSlider và OverflowMenu trong composer. Không nghe khi panel rỗng
  // (render null) để không cướp Escape của UI khác.
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

  if (!files.length) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review staged changes"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-none border border-[#495059] bg-[#212730] font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-[#495059] bg-[#161d27] px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-pixel text-[16px] font-semibold text-[#ebe7e4] [image-rendering:pixelated]">
              <span className="font-bold text-[#6a9fcc]">$</span>
              <span className="text-[#6a9fcc]">staged</span>
              <span>· {stats.files} file{stats.files !== 1 ? 's' : ''}</span>
            </div>
            <div className="text-[11px] text-[#9fa4ab]">
              {stats.newFiles > 0 && `${stats.newFiles} new · `}
              Thay đổi chưa ghi vào đĩa. Review rồi Apply hoặc Reject.
            </div>
          </div>
          <div className="flex flex-shrink-0 gap-1.5 text-[11px] font-mono">
            <span className="rounded-none border border-[#5db87a]/30 bg-[#5db87a]/10 px-1.5 py-0.5 text-[#5db87a]">
              +{stats.addedLines}
            </span>
            <span className="rounded-none border border-[#e8704f]/30 bg-[#e8704f]/10 px-1.5 py-0.5 text-[#e8704f]">
              -{stats.removedLines}
            </span>
          </div>
        </div>

        {/* File list with diffs */}
        <div className="flex-1 overflow-auto p-3 space-y-3">
          {files.map((file) => {
            const diff = renderUnifiedDiff(lineDiff(file.original ?? '', file.content), { contextLines: 2 });
            return (
              <div key={file.path} className="rounded-none border border-[#495059] bg-[#161d27] overflow-hidden">
                <div className="flex items-center justify-between gap-2 bg-[#161d27] border-b border-[#495059] px-3 py-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <FileText size={12} className="flex-shrink-0 text-[#6a9fcc]" />
                    <span className="truncate font-mono text-[11px] text-[#ebe7e4]">{file.path}</span>
                    {file.original === null && (
                      <span className="flex-shrink-0 rounded-none border border-[#6a9fcc]/40 bg-[#6a9fcc]/10 px-1 py-0.5 text-[9.5px] font-mono text-[#6a9fcc]">
                        NEW
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRejectFile(file.path)}
                    title="Reject this file"
                    className="flex items-center gap-1 rounded-none px-1.5 py-0.5 text-[11px] text-[#9fa4ab] hover:bg-[#e8704f]/10 hover:text-[#e8704f]"
                  >
                    <X size={12} />
                    Reject
                  </button>
                </div>
                <div className="max-h-48 overflow-auto bg-[#0d1116] p-2.5 font-mono text-[11px] leading-relaxed">
                  {diff.text.split('\n').map((line, idx) => {
                    const isAdd = line.startsWith('+');
                    const isDel = line.startsWith('-');
                    const isHunk = line.startsWith('@');
                    return (
                      <div
                        key={idx}
                        className={
                          isAdd
                            ? 'text-[#5db87a] bg-[#5db87a]/10 px-1'
                            : isDel
                              ? 'text-[#e8704f] bg-[#e8704f]/10 px-1'
                              : isHunk
                                ? 'text-[#6a9fcc] font-semibold'
                                : 'text-[#9fa4ab]'
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
        <div className="flex items-center justify-between gap-2 border-t border-[#495059] bg-[#161d27] px-4 py-2.5">
          <button
            type="button"
            onClick={onRejectAll}
            className="flex items-center gap-1.5 rounded-none border border-[#e8704f]/30 bg-[#0d1116] px-3 py-1.5 text-xs text-[#e8704f] transition-colors hover:bg-[#e8704f]/10"
          >
            <Trash2 size={13} />
            Reject All
          </button>
          <div className="flex gap-2">
            <button
              ref={closeBtnRef}
              type="button"
              onClick={onClose}
              className="rounded-none border border-[#495059] bg-[#252f3d] px-3 py-1.5 text-xs text-[#ebe7e4] transition-colors hover:border-[#757d89]"
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
