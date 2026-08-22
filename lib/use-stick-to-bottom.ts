'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const BOTTOM_THRESHOLD = 96;      // px: coi như "đang ở đáy"
const PROGRAMMATIC_GRACE_MS = 150; // bỏ qua scroll event do chính mình gây ra

interface Options {
  /** true khi đang stream token — giữ ghim liên tục */
  streaming?: boolean;
}

export function useStickToBottom(
  scrollRef: React.RefObject<HTMLElement | null>,
  { streaming = false }: Options = {},
) {
  const [isAtBottom, setIsAtBottom] = useState(true);

  const stickRef = useRef(true);          // nguồn sự thật, đọc được trong rAF
  const isAtBottomRef = stickRef;         // alias cho consumer
  const rafRef = useRef(0);
  const pinUntilRef = useRef(0);
  const infiniteRef = useRef(false);
  const streamingRef = useRef(streaming);
  const lastProgrammaticRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const touchStartYRef = useRef(0);

  const setStick = useCallback((v: boolean) => {
    stickRef.current = v;
    setIsAtBottom((prev) => (prev === v ? prev : v));
  }, []);

  const distanceFromBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, [scrollRef]);

  const stopLoop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    pinUntilRef.current = 0;
    infiniteRef.current = false;
  }, []);

  /** Vòng lặp ghim: mỗi frame kéo scrollTop về đáy thật hiện tại.
   *  Tự bù mọi thay đổi chiều cao do KaTeX / Prism / ảnh / re-measure. */
  const runLoop = useCallback(() => {
    if (rafRef.current) return;
    const step = () => {
      rafRef.current = 0;
      const el = scrollRef.current;
      if (!el || !stickRef.current) {
        stopLoop();
        return;
      }
      const target = el.scrollHeight - el.clientHeight;
      if (Math.abs(el.scrollTop - target) > 0.5) {
        lastProgrammaticRef.current = performance.now();
        el.scrollTop = target;
        lastScrollTopRef.current = target;
      }
      if (infiniteRef.current || performance.now() < pinUntilRef.current) {
        rafRef.current = requestAnimationFrame(step);
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, [scrollRef, stopLoop]);

  /** Ghim đáy trong `durationMs`. Dùng khi gửi tin, đổi nhánh, đổi chat. */
  const pin = useCallback(
    (durationMs = 800) => {
      setStick(true);
      pinUntilRef.current = Math.max(pinUntilRef.current, performance.now() + durationMs);
      runLoop();
    },
    [runLoop, setStick],
  );

  const release = useCallback(() => {
    stopLoop();
    setStick(false);
  }, [setStick, stopLoop]);

  /** Cho nút "scroll to bottom" — có animation. */
  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const el = scrollRef.current;
      if (!el) return;
      setStick(true);
      lastProgrammaticRef.current = performance.now();
      el.scrollTo({ top: el.scrollHeight, behavior });
      window.setTimeout(() => pin(600), behavior === 'smooth' ? 320 : 0);
    },
    [pin, scrollRef, setStick],
  );

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const top = el.scrollTop;
    const prev = lastScrollTopRef.current;
    lastScrollTopRef.current = top;

    // Scroll do reflow hoặc do chính vòng lặp → không đổi trạng thái
    if (performance.now() - lastProgrammaticRef.current < PROGRAMMATIC_GRACE_MS) return;

    const dist = el.scrollHeight - top - el.clientHeight;

    if (stickRef.current) {
      // CHỈ nhả ghim khi người dùng thực sự cuộn LÊN
      if (top < prev - 4 && dist > BOTTOM_THRESHOLD) release();
      return;
    }

    if (dist <= BOTTOM_THRESHOLD) {
      setStick(true);
      if (streamingRef.current) {
        infiniteRef.current = true;
        runLoop();
      }
    }
  }, [release, runLoop, scrollRef, setStick]);

  // Nhả ghim theo *ý định* người dùng, không chờ scroll event
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && distanceFromBottom() > 4) release();
    };
    const onTouchStart = (e: TouchEvent) => {
      touchStartYRef.current = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y - touchStartYRef.current > 12 && distanceFromBottom() > 4) release();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) release();
    };

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('keydown', onKeyDown);
    };
  }, [distanceFromBottom, release, scrollRef]);

  // Bật/tắt ghim vô hạn theo trạng thái streaming
  useEffect(() => {
    streamingRef.current = streaming;
    if (streaming) {
      if (stickRef.current) {
        infiniteRef.current = true;
        runLoop();
      }
    } else {
      infiniteRef.current = false;
      if (stickRef.current) pin(500); // bù lần đo cuối sau khi stream xong
    }
  }, [pin, runLoop, streaming]);

  // Viewport đổi (bàn phím mobile bật lên, resize) → giữ đáy
  useEffect(() => {
    const onResize = () => {
      if (stickRef.current) pin(400);
    };
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, [pin]);

  useEffect(() => stopLoop, [stopLoop]);

  return { isAtBottom, isAtBottomRef, onScroll, pin, release, scrollToBottom };
}
