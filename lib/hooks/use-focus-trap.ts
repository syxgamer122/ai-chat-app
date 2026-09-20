'use client';

import { useEffect, type RefObject } from 'react';

export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface UseFocusTrapOptions {
  active?: boolean;
  onEscape?: () => void;
  initialFocusSelector?: string;
}

/**
 * Hook quản lý focus trap cho modal / dialog:
 * 1. Tự động focus vào phần tử đầu tiên (hoặc selector chỉ định) khi mở.
 * 2. Giữ phím Tab / Shift+Tab quay vòng bên trong container.
 * 3. Hỗ trợ bấm Escape để đóng modal (nghe ở tầng document để click vào diff text không làm chết phím).
 * 4. Trả lại focus cho phần tử trước đó khi đóng / unmount.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  options: UseFocusTrapOptions = {},
) {
  const { active = true, onEscape, initialFocusSelector } = options;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    if (!container.hasAttribute('tabindex')) {
      container.setAttribute('tabindex', '-1');
    }

    const focusTarget = initialFocusSelector
      ? container.querySelector<HTMLElement>(initialFocusSelector)
      : container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);

    const timer = setTimeout(() => {
      const target = focusTarget ?? container;
      target?.focus();
    }, 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onEscape) {
        e.stopPropagation();
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);

      if (focusables.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;

      // Nếu focus rơi ra ngoài container (click body/text trần), kéo lại vào container
      if (!current || !container.contains(current)) {
        e.preventDefault();
        if (e.shiftKey) {
          last.focus();
        } else {
          first.focus();
        }
        return;
      }

      if (e.shiftKey) {
        if (current === first || current === container) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (current === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [containerRef, active, onEscape, initialFocusSelector]);
}
