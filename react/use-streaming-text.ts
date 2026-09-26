/**
 * React Adapter — useStreamingText hook (Tầng 2).
 *
 * Nhiệm vụ:
 * Bộ đệm điều tiết re-render theo tần số quét màn hình `requestAnimationFrame` (60fps),
 * loại bỏ hoàn toàn tình trạng re-render hàng nghìn lần mỗi giây khi nhận streaming token từ LLM.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseStreamingTextOptions {
  rawText?: string;
  rawReasoning?: string;
  isStreaming?: boolean;
}

export interface UseStreamingTextReturn {
  displayText: string;
  displayReasoning: string;
  isBuffering: boolean;
  appendChunk: (textChunk?: string, reasoningChunk?: string) => void;
  flush: () => void;
  reset: () => void;
}

const safeRequestAnimationFrame = (callback: FrameRequestCallback): number => {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback);
  }
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(callback);
  }
  return setTimeout(callback, 16) as unknown as number;
};

const safeCancelAnimationFrame = (id: number): void => {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(id);
    return;
  }
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(id);
    return;
  }
  clearTimeout(id);
};

export function useStreamingText({
  rawText,
  rawReasoning,
  isStreaming = false,
}: UseStreamingTextOptions = {}): UseStreamingTextReturn {
  const [displayText, setDisplayText] = useState(rawText ?? '');
  const [displayReasoning, setDisplayReasoning] = useState(rawReasoning ?? '');
  const [isBuffering, setIsBuffering] = useState(false);

  // Bộ đệm token trong RAM
  const bufferRef = useRef({
    text: rawText ?? '',
    reasoning: rawReasoning ?? '',
  });

  const rafIdRef = useRef<number | null>(null);

  // Xả ngay lập tức bộ đệm vào state hiển thị
  const flush = useCallback(() => {
    if (rafIdRef.current !== null) {
      safeCancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    setDisplayText(bufferRef.current.text);
    setDisplayReasoning(bufferRef.current.reasoning);
    setIsBuffering(false);
  }, []);

  // Đặt lại bộ đệm
  const reset = useCallback(() => {
    if (rafIdRef.current !== null) {
      safeCancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    bufferRef.current = { text: '', reasoning: '' };
    setDisplayText('');
    setDisplayReasoning('');
    setIsBuffering(false);
  }, []);

  // Nạp thêm chunk chủ động qua API (chống per-token re-render thrashing)
  const appendChunk = useCallback((textChunk = '', reasoningChunk = '') => {
    if (textChunk) bufferRef.current.text += textChunk;
    if (reasoningChunk) bufferRef.current.reasoning += reasoningChunk;

    setIsBuffering(true);

    if (rafIdRef.current === null) {
      rafIdRef.current = safeRequestAnimationFrame(() => {
        setDisplayText(bufferRef.current.text);
        setDisplayReasoning(bufferRef.current.reasoning);
        rafIdRef.current = null;
        setIsBuffering(false);
      });
    }
  }, []);

  // Lắng nghe thay đổi từ rawText / rawReasoning nếu caller truyền props có kiểm soát
  useEffect(() => {
    if (rawText !== undefined) {
      bufferRef.current.text = rawText;
    }
    if (rawReasoning !== undefined) {
      bufferRef.current.reasoning = rawReasoning;
    }

    if (!isStreaming) {
      // Khi dừng stream hoặc lượt chat kết thúc: xả ngay không chờ RAF, bảo toàn dữ liệu appendChunk
      flush();
      return;
    }

    setIsBuffering(true);

    if (rafIdRef.current === null) {
      rafIdRef.current = safeRequestAnimationFrame(() => {
        setDisplayText(bufferRef.current.text);
        setDisplayReasoning(bufferRef.current.reasoning);
        rafIdRef.current = null;
        setIsBuffering(false);
      });
    }
  }, [rawText, rawReasoning, isStreaming, flush]);

  // Dọn dẹp RAF khi component unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        safeCancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  return {
    displayText,
    displayReasoning,
    isBuffering,
    appendChunk,
    flush,
    reset,
  };
}
