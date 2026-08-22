"use client";

import {
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

export interface BranchSwitcherProps {
  currentIndex: number;
  total: number;
  disabled?: boolean;
  isTouchDevice?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

export function BranchSwitcher({
  currentIndex,
  total,
  disabled = false,
  isTouchDevice = false,
  onPrevious,
  onNext,
}: BranchSwitcherProps) {
  if (total <= 1) {
    return null;
  }

  const canGoPrevious = currentIndex > 0;
  const canGoNext = currentIndex < total - 1;

  return (
    <div
      role="group"
      aria-label="Điều hướng giữa các nhánh"
      className="inline-flex items-center gap-1 rounded-md border border-zinc-200/50 bg-white/80 px-1 py-0.5 shadow-sm dark:border-zinc-700/50 dark:bg-zinc-900/80 backdrop-blur-sm"
    >
      <button
        type="button"
        data-no-swipe="true"
        disabled={disabled || !canGoPrevious}
        onClick={onPrevious}
        className={`rounded p-1 transition-colors hover:bg-black/10 dark:hover:bg-white/10 disabled:pointer-events-none disabled:opacity-30 ${
          isTouchDevice ? "min-h-8 min-w-8" : "min-h-6 min-w-6"
        }`}
        aria-label="Nhánh trước"
        title="Nhánh trước · Alt + ←"
      >
        <ChevronLeft
          size={15}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>

      <span
        aria-live="polite"
        className="min-w-10 select-none text-center font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400"
      >
        {currentIndex + 1} / {total}
      </span>

      <button
        type="button"
        data-no-swipe="true"
        disabled={disabled || !canGoNext}
        onClick={onNext}
        className={`rounded p-1 transition-colors hover:bg-black/10 dark:hover:bg-white/10 disabled:pointer-events-none disabled:opacity-30 ${
          isTouchDevice ? "min-h-8 min-w-8" : "min-h-6 min-w-6"
        }`}
        aria-label="Nhánh sau"
        title="Nhánh sau · Alt + →"
      >
        <ChevronRight
          size={15}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
