'use client';

import { useEffect, useState } from 'react';

/**
 * Theo dõi một media query. Trả về `false` ở lần render đầu (kể cả trên
 * server) rồi đồng bộ ngay trong effect — tránh lệch hydration.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);

  return matches;
}

/** Breakpoint `md` của Tailwind — mốc sidebar chuyển từ drawer sang cột tĩnh. */
export const MD_QUERY = '(min-width: 768px)';
