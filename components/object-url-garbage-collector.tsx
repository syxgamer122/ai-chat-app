'use client';

import { useEffect } from 'react';
import {
  revokeAllObjectUrls,
  sweepObjectUrls,
} from '@/lib/object-url-registry';

const SWEEP_INTERVAL_MS = 60_000;

export function ObjectUrlGarbageCollector() {
  useEffect(() => {
    const interval = window.setInterval(() => sweepObjectUrls(), SWEEP_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') sweepObjectUrls();
    };

    const onPageHide = () => revokeAllObjectUrls();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
    };
  }, []);

  return null;
}