'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { DEFAULT_THINKING_LEVEL, THINKING_LEVELS, type ThinkingLevel } from '@/lib/provider-url';
import { resolveNearestEffort } from '@/lib/reasoning-capability';
import { useAnchoredPanel } from '@/lib/hooks/use-anchored-panel';

const LEVELS: {
  key: ThinkingLevel;
  label: string;
  description: string;
}[] = [
  /* Mô tả phải vừa một dòng trong menu 240px, nếu không `truncate` sẽ cắt giữa từ. */
  { key: 'low', label: 'Thấp', description: 'Cho câu hỏi đơn giản' },
  { key: 'medium', label: 'Trung bình', description: 'Cân bằng tốc độ và độ sâu' },
  { key: 'high', label: 'Cao', description: 'Phân tích sâu, chậm hơn' },
  { key: 'max', label: 'Tối đa', description: 'Sâu nhất, tốn nhiều token' },
];

const LEVEL_LABEL: Record<ThinkingLevel, string> = {
  low: 'Thấp',
  medium: 'Trung bình',
  high: 'Cao',
  max: 'Tối đa',
};

function levelLabel(key: ThinkingLevel): string {
  return LEVEL_LABEL[key];
}

/** Danh sách mức hỗ trợ bằng tiếng Việt, theo thang low → max. */
export function supportedLevelsText(levels: readonly ThinkingLevel[]): string {
  const order = [...levels].sort(
    (a, b) => THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b),
  );
  return order.map(levelLabel).join(', ');
}

/**
 * Phụ đề menu theo metadata của model:
 *  - không có metadata: mô tả chung tính năng;
 *  - khai báo subset: liệt kê đúng các mức model hỗ trợ;
 *  - efforts rỗng (toggle-only): gateway tự dịch mức thành bật/tắt;
 *  - mandatory: luôn suy luận, không có chế độ tắt.
 */
export function menuSubtitle(
  supportedLevels: ThinkingLevel[] | null | undefined,
  mandatory: boolean,
): string {
  let base: string;
  if (!supportedLevels) {
    base = 'Điều khiển độ sâu phân tích của AI';
  } else if (supportedLevels.length === 0) {
    base = 'Gateway tự dịch mức thành bật/tắt';
  } else {
    base = `Model hỗ trợ: ${supportedLevelsText(supportedLevels)}`;
  }
  return mandatory ? `${base} · Model này luôn suy luận` : base;
}

/** title/aria-label khi mức yêu cầu bị model snapping sang mức gần nhất. */
export function snappedTitle(requested: ThinkingLevel, effective: ThinkingLevel): string {
  return `Mức suy luận: ${levelLabel(effective)} (Model không hỗ trợ ${levelLabel(requested)}, đang gửi ${levelLabel(effective)})`;
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
 * enabled GẦN NHẤT khi mức đó bị model khóa; hòa khoảng cách thì mức thấp hơn
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

/**
 * Meter 4 ô vuông 5x5px (gap 2px): số ô sáng = độ sâu mức (low 1 → max 4).
 * Màu 'max' dùng token warning vì đó là mức đốt token nhiều nhất; màu ở đây
 * báo chi phí, không phải để phân biệt mức (số ô đã làm việc đó).
 */
function LevelMeter({ level, inert }: { level: ThinkingLevel; inert?: boolean }) {
  const fill = THINKING_LEVELS.indexOf(level) + 1;
  const accent = inert ? '#495059' : level === 'max' ? '#e8993a' : '#6a9fcc';
  return (
    <span className="flex flex-none items-center gap-0.5" aria-hidden="true">
      {THINKING_LEVELS.map((lvl, i) => (
        <span
          key={lvl}
          className="h-[5px] w-[5px] border"
          style={
            i < fill
              ? { backgroundColor: accent, borderColor: accent }
              : { backgroundColor: inert ? 'transparent' : '#1c2128', borderColor: '#495059' }
          }
        />
      ))}
    </span>
  );
}

interface ThinkingMenuProps {
  value: ThinkingLevel;
  onChange: (value: ThinkingLevel) => void;
  disabled?: boolean;
  /**
   * Các mức model đang chọn hỗ trợ (metadata kiểu OpenRouter).
   * null/undefined = không có metadata. [] = model chỉ bật/tắt suy luận
   * (gateway tự dịch mức). Mức ngoài danh sách bị mờ; giá trị hiện tại không
   * được hỗ trợ sẽ hiển thị mức gần nhất.
   */
  supportedLevels?: ThinkingLevel[] | null;
  /** Model bắt buộc luôn suy luận (metadata reasoning.mandatory). */
  mandatory?: boolean;
}

export function ThinkingMenu({ value, onChange, disabled, supportedLevels, mandatory }: ThinkingMenuProps) {
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
  const snapped = effectiveValue !== value;
  const isLevelSupported = (key: ThinkingLevel) =>
    !supportedLevels || supportedLevels.length === 0 || supportedLevels.includes(key);

  const current =
    LEVELS.find((l) => l.key === effectiveValue)
    ?? LEVELS.find((l) => l.key === DEFAULT_THINKING_LEVEL)!;

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  /*
   * Menu render qua portal + position:fixed (xem use-anchored-panel cho
   * recipe chung). Trigger nằm sát phải status line: canh mép PHẢI panel theo
   * mép phải trigger rồi kẹp trong viewport.
   */
  const { pos, panelRef } = useAnchoredPanel({
    open,
    triggerRef,
    width: 240,
    align: 'right',
    close,
    insideRef: containerRef,
  });

  // Chuẩn chung của các menu trong status line (ModelSelector,
  // ChatExportMenu): Escape trả focus về trigger; đóng khi click/cuộn ngoài
  // panel và khi bị disable giữa lúc đang mở (ví dụ stream bắt đầu) do hook
  // và effect dưới lo.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
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
  // bắt user Tab thêm một bước (APG menu pattern); cũng là điều kiện để
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

  const snappedLabel = snapped
    ? snappedTitle(value, effectiveValue)
    : `Mức suy luận: ${current.label}`;

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        aria-label={snappedLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={snapped ? snappedLabel : 'Mức độ suy luận của AI'}
        /* `after:-inset-6px` nới vùng chạm 36px lên 48px (mốc 44px trên mobile) mà không đổi khối hiển thị, giống nút icon trong composer. */
        className={`relative flex h-8 items-center gap-1.5 rounded-none border border-[#495059] bg-[#161d27] px-2.5 text-xs font-medium text-[#ebe7e4] transition-colors after:absolute after:-inset-[6px] after:content-[''] hover:border-[#757d89] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#6a9fcc] disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? 'border-[#757d89]' : ''
        }`}
      >
        <LevelMeter level={effectiveValue} />
        <span className="hidden sm:inline">
          {current.label}
          {snapped ? '*' : ''}
        </span>
        <ChevronDown
          className={`h-3 w-3 text-[#9fa4ab] transition-transform duration-100 ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label="Mức suy luận"
            aria-orientation="vertical"
            tabIndex={-1}
            onKeyDown={onMenuKeyDown}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
            className="surface-panel z-40 animate-pop-in overflow-hidden p-1.5"
          >
            <div className="border-b border-[#495059] px-2.5 pb-1.5 pt-1">
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6a9fcc]">
                Mức suy luận
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-[#9fa4ab]">
                {menuSubtitle(supportedLevels, !!mandatory)}
              </p>
            </div>
            <div className="mt-1 space-y-0.5">
              {LEVELS.map((level, i) => {
                const isActive = effectiveValue === level.key;
                const levelSupported = isLevelSupported(level.key);
                const activeToneClass = level.key === 'max' ? 'text-[#e8993a]' : 'text-[#6a9fcc]';
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
                    title={
                      levelSupported || !supportedLevels || supportedLevels.length === 0
                        ? undefined
                        : `Model chỉ hỗ trợ: ${supportedLevelsText(supportedLevels)}`
                    }
                    onFocus={() => setCursor(i)}
                    onClick={() => {
                      onChange(level.key);
                      close();
                    }}
                    className={`menu-item ${isActive ? 'bg-[#252f3d] text-[#ebe7e4]' : ''} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#6a9fcc] ${
                      levelSupported ? '' : 'cursor-not-allowed opacity-40'
                    }`}
                  >
                    <LevelMeter level={level.key} inert={!levelSupported} />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block text-xs font-medium ${
                          isActive ? activeToneClass : 'text-[#ebe7e4]'
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
            {snapped && (
              <p className="mt-1 border-t border-[#495059] px-2.5 py-1.5 text-[11px] leading-relaxed text-[#e8993a]">
                {levelLabel(value)} không khả dụng, đang gửi {levelLabel(effectiveValue)}
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
