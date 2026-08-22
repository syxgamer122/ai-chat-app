'use client';

import { useCallback, useEffect, useRef } from 'react';

type TitleState = 'idle' | 'pending' | 'settled';

interface Options {
  onTitle: (conversationId: string, title: string) => void | Promise<void>;
  accessCode?: string;
  apiKey?: string;
}

function localTitle(text: string): string {
  const words = text
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length ? words.slice(0, 5).join(' ').slice(0, 50) : 'Cuộc trò chuyện mới';
}

export function useTitleGenerator({ onTitle, accessCode, apiKey }: Options) {
  /**
   * Map<conversationId, TitleState>.
   * QUY TẮC BẤT BIẾN: chuyển sang 'pending' TRƯỚC khi fetch,
   * và KHÔNG BAO GIỜ quay lại 'idle'. Lỗi => 'settled' + title local.
   */
  const state = useRef<Map<string, TitleState>>(new Map());
  const controllers = useRef<Map<string, AbortController>>(new Map());
  const cooldownUntil = useRef(0);

  useEffect(
    () => () => {
      for (const c of controllers.current.values()) c.abort();
      controllers.current.clear();
    },
    [],
  );

  const generateTitle = useCallback(
    async (conversationId: string, firstUserMessage: string) => {
      if (!conversationId || !firstUserMessage.trim()) return;
      if (state.current.get(conversationId)) return; // pending hoặc settled -> chặn tuyệt đối

      state.current.set(conversationId, 'pending');
      const heuristic = localTitle(firstUserMessage);

      // Đang trong cooldown do 429 trước đó: dùng title local, không gọi mạng.
      if (Date.now() < cooldownUntil.current) {
        state.current.set(conversationId, 'settled');
        await onTitle(conversationId, heuristic);
        return;
      }

      const controller = new AbortController();
      controllers.current.set(conversationId, controller);
      const timeout = setTimeout(() => controller.abort(), 12_000);

      try {
        const res = await fetch('/api/title', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(accessCode ? { Authorization: `Bearer ${accessCode}` } : {}),
            ...(apiKey ? { 'x-api-key': apiKey } : {}),
          },
          body: JSON.stringify({ message: firstUserMessage.slice(0, 2000) }),
          signal: controller.signal,
          cache: 'no-store',
        });

        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('Retry-After') ?? '60');
          cooldownUntil.current = Date.now() + Math.min(Math.max(retryAfter, 5), 300) * 1000;
        }

        let title = heuristic;
        try {
          const data = await res.json();
          if (typeof data?.title === 'string' && data.title.trim()) title = data.title.trim();
        } catch {
          /* giữ heuristic */
        }
        await onTitle(conversationId, title);
      } catch {
        await onTitle(conversationId, heuristic);
      } finally {
        clearTimeout(timeout);
        controllers.current.delete(conversationId);
        state.current.set(conversationId, 'settled');
      }
    },
    [onTitle, accessCode, apiKey],
  );

  /** Gọi khi load conversation đã có title sẵn từ Dexie. */
  const markTitled = useCallback((conversationId: string) => {
    state.current.set(conversationId, 'settled');
  }, []);

  return { generateTitle, markTitled };
}