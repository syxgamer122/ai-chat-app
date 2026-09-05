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

  // Thiết bị cảm ứng cần vùng bấm ≥ 32px; chuột thì gọn hơn cho đỡ chiếm chỗ.
  const hitArea = isTouchDevice ? 'min-h-8 min-w-8' : 'min-h-6 min-w-6';

  return (
    <div
      role="group"
      aria-label="Điều hướng giữa các nhánh"
      className="inline-flex items-center gap-0.5 rounded-none border border-[#495059] bg-[#161d27] px-1 py-0.5"
    >
      <button
        type="button"
        data-no-swipe="true"
        disabled={disabled || !canGoPrevious}
        onClick={onPrevious}
        className={`rounded-none p-0.5 text-[#9fa4ab] transition-colors hover:bg-[#252f3d] hover:text-[#6a9fcc] disabled:pointer-events-none disabled:opacity-20 ${hitArea}`}
        aria-label="Nhánh trước"
        title="Nhánh trước · Alt + ←"
      >
        <ChevronLeft size={13} strokeWidth={2} aria-hidden="true" />
      </button>

      <span
        aria-live="polite"
        className="min-w-8 select-none text-center font-mono text-[10.5px] tabular-nums text-[#6a9fcc]"
      >
        {currentIndex + 1}/{total}
      </span>

      <button
        type="button"
        data-no-swipe="true"
        disabled={disabled || !canGoNext}
        onClick={onNext}
        className={`rounded-none p-0.5 text-[#9fa4ab] transition-colors hover:bg-[#252f3d] hover:text-[#6a9fcc] disabled:pointer-events-none disabled:opacity-20 ${hitArea}`}
        aria-label="Nhánh sau"
        title="Nhánh sau · Alt + →"
      >
        <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
