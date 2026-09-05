'use client';

import { useCallback, useEffect, useRef, useState, type ElementType } from 'react';
import { Brain, Check, ChevronDown, Lightbulb, Rocket, Sparkles } from 'lucide-react';
import { DEFAULT_THINKING_LEVEL, type ThinkingLevel } from '@/lib/provider-url';
import { resolveNearestEffort } from '@/lib/reasoning-capability';

const LEVELS: {
  key: ThinkingLevel;
  label: string;
  icon: ElementType;
  description: string;
}[] = [
  /* Mô tả phải vừa một dòng trong menu 270px, nếu không `truncate` sẽ cắt giữa từ. */
  { key: 'low', label: 'Thấp', icon: Lightbulb, description: 'Cho câu hỏi đơn giản' },
  { key: 'medium', label: 'Trung bình', icon: Brain, description: 'Cân bằng tốc độ và độ sâu' },
  { key: 'high', label: 'Cao', icon: Sparkles, description: 'Phân tích sâu, chậm hơn' },
  { key: 'max', label: 'Tối đa', icon: Rocket, description: 'Sâu nhất, tốn nhiều token' },
];

/**
 * Màu của mức ĐANG CHỌN: accent-steel như mọi trạng thái chọn khác của app,
 * riêng 'max' dùng token warning vì đó là mức đốt token nhiều nhất — màu ở đây
 * báo chi phí, không phải để phân biệt mức (bốn icon lucide đã làm việc đó).
 */
function activeToneClass(key: ThinkingLevel): string {
  return key === 'max' ? 'text-[#e8993a]' : 'text-[#6a9fcc]';
}

/**
 * Một bước mũi tên trong menu mức suy luận: bỏ qua mức bị model khóa
 * (disabled) và quay vòng ở hai đầu. Hàm thuần để test được mà không cần DOM.
 */
export function stepLevelCursor(from: number, direction: 1 | -1, enabled: boolean[]): number {
  const n = enabled.length;
  if (n === 0) return from;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = (i + direction + n) % n;
    if (enabled[i]) return i;
  }
  return from;
}

/**
 * Item nhận focus ngay khi menu mở (APG menu pattern): mức đang chọn, hoặc mức
 * enabled GẦN NHẤT khi mức đó bị model khóa — hòa khoảng cách thì mức thấp hơn
 * thắng, cùng quy ước với `resolveNearestEffort`. Trả -1 khi không còn mức nào
 * mở. Hàm thuần để test được mà không cần DOM.
 */
export function resolveOpenFocusIndex(activeIndex: number, enabled: boolean[]): number {
  if (enabled[activeIndex]) return activeIndex;
  let best = -1;
  for (let i = 0; i < enabled.length; i++) {
    if (!enabled[i]) continue;
    if (best < 0 || Math.abs(i - activeIndex) < Math.abs(best - activeIndex)) best = i;
  }
  return best;
}

interface ThinkingSliderProps {
  value: ThinkingLevel;
  onChange: (value: ThinkingLevel) => void;
  disabled?: boolean;
  /**
   * Các mức model đang chọn hỗ trợ (metadata kiểu OpenRouter).
   * null/undefined = không ràng buộc (crax hoặc toggle-only). Mức ngoài danh
   * sách bị mờ; giá trị hiện tại không được hỗ trợ sẽ hiển thị mức gần nhất.
   */
  supportedLevels?: ThinkingLevel[] | null;
}

export function ThinkingSlider({ value, onChange, disabled, supportedLevels }: ThinkingSliderProps) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Giá trị hiện tại không nằm trong mức model hỗ trợ → hiển thị mức gần nhất
  // (server cũng map nearest khi gửi, UI chỉ phản chiếu cho trung thực).
  const effectiveValue =
    supportedLevels && supportedLevels.length > 0 && !supportedLevels.includes(value)
      ? resolveNearestEffort(value, { efforts: supportedLevels, mandatory: false })
      : value;
  const isLevelSupported = (key: ThinkingLevel) =>
    !supportedLevels || supportedLevels.length === 0 || supportedLevels.includes(key);

  const current = LEVELS.find((l) => l.key === effectiveValue)
    ?? LEVELS.find((l) => l.key === DEFAULT_THINKING_LEVEL)!;
  const CurrentIcon = current.icon;

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Chuẩn chung của các menu trong composer (OverflowMenu, ModelSelector):
  // đóng khi click ngoài, Escape trả focus về trigger, đóng khi bị disable
  // giữa lúc đang mở (ví dụ stream bắt đầu).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  const enabledMask = LEVELS.map((l) => isLevelSupported(l.key));
  const activeIndex = LEVELS.findIndex((l) => l.key === effectiveValue);

  // Mở menu / đổi giá trị: con trỏ đứng ở mức đang chọn.
  useEffect(() => {
    if (open) setCursor(activeIndex >= 0 ? activeIndex : 0);
  }, [open, activeIndex]);

  // Ảnh chụp cho effect dưới. `enabledMask` là mảng mới mỗi render nên không
  // đưa vào deps được: effect sẽ chạy lại và giật focus khỏi item user đang
  // đứng (ví dụ metadata model về muộn làm component render lại).
  const openFocusIndexRef = useRef(0);
  openFocusIndexRef.current = resolveOpenFocusIndex(activeIndex, enabledMask);

  // Mở bằng Enter/Space/click là focus ngay vào item của mức đang chọn, không
  // bắt user Tab thêm một bước (APG menu pattern) — cũng là điều kiện để
  // ArrowUp/Down tới được onKeyDown của menu.
  useEffect(() => {
    if (!open) return;
    const target = openFocusIndexRef.current;
    if (target < 0) return;
    setCursor(target);
    itemRefs.current[target]?.focus();
  }, [open]);

  const focusItem = (i: number) => {
    setCursor(i);
    itemRefs.current[i]?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(stepLevelCursor(cursor, 1, enabledMask));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItem(stepLevelCursor(cursor, -1, enabledMask));
    } else if (e.key === 'Home') {
      e.preventDefault();
      const first = enabledMask.indexOf(true);
      if (first >= 0) focusItem(first);
    } else if (e.key === 'End') {
      e.preventDefault();
      for (let i = enabledMask.length - 1; i >= 0; i--) {
        if (enabledMask[i]) {
          focusItem(i);
          break;
        }
      }
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        aria-label={`Mức suy luận: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Mức độ suy luận của AI"
        /* `after:-inset-6px` nới vùng chạm 36px lên 48px (mốc 44px trên mobile) mà không đổi khối hiển thị, giống nút icon trong composer. */
        className={`relative flex h-8 items-center gap-1.5 rounded-none border border-[#495059] bg-[#161d27] px-2.5 text-xs font-medium text-[#ebe7e4] transition-colors after:absolute after:-inset-[6px] after:content-[''] hover:border-[#757d89] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#6a9fcc] disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? 'border-[#757d89]' : ''
        }`}
      >
        <CurrentIcon className={`h-3.5 w-3.5 ${activeToneClass(current.key)}`} aria-hidden="true" />
        <span className="hidden sm:inline">{current.label}</span>
        <ChevronDown
          className={`h-3 w-3 text-[#9fa4ab] transition-transform duration-100 ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Mức độ suy luận"
          aria-orientation="vertical"
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          className="surface-panel absolute bottom-full left-0 z-40 mb-2 w-60 animate-slide-up overflow-hidden p-1.5"
        >
          <div className="border-b border-[#495059] px-2.5 pb-1.5 pt-1">
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6a9fcc]">
              Mức độ suy luận
            </p>
            <p className="mt-0.5 text-[11px] text-[#9fa4ab]">
              {supportedLevels
                ? 'Model đang chọn chỉ hỗ trợ một số mức'
                : 'Điều khiển độ sâu phân tích của AI'}
            </p>
          </div>
          <div className="mt-1 space-y-0.5">
            {LEVELS.map((level, i) => {
              const Icon = level.icon;
              const isActive = effectiveValue === level.key;
              const levelSupported = isLevelSupported(level.key);
              return (
                <button
                  key={level.key}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  disabled={!levelSupported}
                  title={levelSupported ? undefined : 'Model này không hỗ trợ mức suy luận'}
                  onFocus={() => setCursor(i)}
                  onClick={() => {
                    onChange(level.key);
                    close();
                  }}
                  className={`menu-item ${isActive ? 'bg-[#252f3d] text-[#ebe7e4]' : ''} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#6a9fcc] ${
                    levelSupported ? '' : 'cursor-not-allowed opacity-40'
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${isActive ? activeToneClass(level.key) : 'text-[#9fa4ab]'}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-xs font-medium ${
                        isActive ? activeToneClass(level.key) : 'text-[#ebe7e4]'
                      }`}
                    >
                      {level.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] leading-tight text-[#9fa4ab]">
                      {level.description}
                    </span>
                  </span>
                  {isActive && (
                    <Check size={13} className="flex-none text-[#6a9fcc]" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
