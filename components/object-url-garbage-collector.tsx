"use client";

import { useEffect } from "react";
import {
  forceGarbageCollectObjectUrls,
  revokeAllObjectUrls,
} from "@/lib/object-url-registry";

export function ObjectUrlGarbageCollector() {
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      forceGarbageCollectObjectUrls(60_000);
    }, 30_000);

    const handlePageHide = () => {
      /**
       * pagehide phù hợp hơn unload.
       * Không revoke toàn bộ ở visibilitychange vì tab có thể
       * chỉ bị đưa xuống background rồi quay lại.
       */
      revokeAllObjectUrls();
    };

    window.addEventListener("pagehide", handlePageHide);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, []);

  return null;
}
