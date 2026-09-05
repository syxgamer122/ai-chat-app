'use client';

import { useSyncExternalStore } from 'react';

/**
 * Notice nằm ở leaf: component nào cần báo người dùng gọi showNotice() mà
 * KHÔNG kéo re-render ChatInterface (trước đây setState ở component 4.8k dòng
 * nghĩa là một toast = re-render toàn bộ cây, kể cả khi đang stream).
 */
let message: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(next: string | null) {
  message = next;
  listeners.forEach((l) => l());
}

export function showNotice(text: string, duration = 4000) {
  if (timer) clearTimeout(timer);
  emit(text);
  timer = setTimeout(() => {
    timer = null;
    emit(null);
  }, duration);
}

export function clearNotice() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  emit(null);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useNotice(): string | null {
  return useSyncExternalStore(subscribe, () => message, () => null);
}
