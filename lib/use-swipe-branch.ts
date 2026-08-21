"use client";

import {
  useCallback,
  useRef,
  type PointerEvent,
} from "react";

import { resolveSwipeDirection } from "./swipe-utils";

interface SwipeStart {
  x: number;
  y: number;
  pointerId: number;
}

interface UseSwipeBranchOptions {
  threshold?: number;
  maxVerticalDistance?: number;
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
}

export function useSwipeBranch({
  threshold = 64,
  maxVerticalDistance = 80,
  onSwipeLeft,
  onSwipeRight,
}: UseSwipeBranchOptions) {
  const startRef = useRef<SwipeStart | null>(null);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      /**
       * Không kích hoạt swipe bằng chuột.
       * Chuột vẫn có thể dùng để click branch button.
       */
      if (event.pointerType === "mouse") {
        return;
      }

      /**
       * Nếu đang chạm vào button, link, input hoặc control,
       * không coi đó là thao tác swipe của chat.
       */
      const target = event.target;

      if (
        target instanceof HTMLElement &&
        target.closest(
          "button, a, input, textarea, select, [data-no-swipe='true']",
        )
      ) {
        return;
      }

      startRef.current = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
      };

      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Một số browser không hỗ trợ pointer capture đầy đủ.
      }
    },
    [],
  );

  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const start = startRef.current;

      if (!start || start.pointerId !== event.pointerId) {
        return;
      }

      const deltaX = event.clientX - start.x;
      const deltaY = event.clientY - start.y;

      startRef.current = null;

      const direction = resolveSwipeDirection(
        deltaX,
        deltaY,
        threshold,
        maxVerticalDistance,
      );

      if (direction === "left") {
        onSwipeLeft();
      } else if (direction === "right") {
        onSwipeRight();
      }
    },
    [
      maxVerticalDistance,
      onSwipeLeft,
      onSwipeRight,
      threshold,
    ],
  );

  const onPointerCancel = useCallback(() => {
    startRef.current = null;
  }, []);

  return {
    onPointerDown,
    onPointerUp,
    onPointerCancel,
  };
}
