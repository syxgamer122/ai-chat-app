'use client';

import { useCallback, useEffect, useRef } from 'react';

type TitleState = 'idle' | 'pending' | 'settled';

interface Options {
  onTitle: (conversationId: string, title: string) => void | Promise<void>;
  accessCode?: string;
  apiKey?: string;
  /** Provider preset đang active — override baseUrl/key của server env. */
  providerBase?: string;
  providerKey?: string;
  /** Model đang chọn ở client — /api/title ưu tiên khi provider active. */
  model?: string;
}

function localTitle(text: string): string {
  const words = text
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length ? words.slice(0, 5).join(' ').slice(0, 50) : 'Cuộc trò chuyện mới';
}

export function useTitleGenerator({ onTitle, accessCode, apiKey, providerBase, providerKey, model }: Options) {
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

      /**
       * Key gửi lên phải thuộc đúng baseUrl sẽ được dùng. Có providerBase =>
       * chỉ dùng providerKey; không có => mới dùng key của máy chủ mặc định.
       * Fallback `providerKey || apiKey` cũ làm key của server env bị gửi tới
       * gateway do người dùng tự khai.
       */
      const outboundKey = providerBase ? providerKey : apiKey;

      try {
        const res = await fetch('/api/title', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(accessCode ? { Authorization: `Bearer ${accessCode}` } : {}),
            ...(outboundKey ? { 'x-api-key': outboundKey } : {}),
            ...(providerBase ? { 'x-api-base': providerBase } : {}),
          },
          body: JSON.stringify({ message: firstUserMessage.slice(0, 2000), ...(model ? { model } : {}) }),
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
    [onTitle, accessCode, apiKey, providerBase, providerKey, model],
  );

  /** Gọi khi load conversation đã có title sẵn từ Dexie. */
  const markTitled = useCallback((conversationId: string) => {
    state.current.set(conversationId, 'settled');
  }, []);

  return { generateTitle, markTitled };
}