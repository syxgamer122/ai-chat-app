"use client";

import { useEffect, useRef } from "react";
import {
  heartbeatStreamLease,
  releaseStreamLease,
  STREAM_LEASE_HEARTBEAT_MS,
} from "@/lib/stream-lease";

interface UseStreamLeaseOptions {
  sessionId: string | null;
  streamId: string | null;
  enabled: boolean;
}

export function useStreamLease({
  sessionId,
  streamId,
  enabled,
}: UseStreamLeaseOptions) {
  const releasedRef = useRef(false);

  useEffect(() => {
    releasedRef.current = false;

    if (!enabled || !sessionId || !streamId) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void heartbeatStreamLease(sessionId, streamId);
    }, STREAM_LEASE_HEARTBEAT_MS);

    const release = () => {
      if (releasedRef.current) {
        return;
      }

      releasedRef.current = true;
      void releaseStreamLease(sessionId, streamId);
    };

    window.addEventListener("pagehide", release);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [enabled, sessionId, streamId]);
}
