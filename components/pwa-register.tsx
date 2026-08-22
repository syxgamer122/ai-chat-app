'use client';

import { useEffect } from 'react';

/**
 * Đăng ký service worker — chỉ chạy production build để không can thiệp vào HMR của dev.
 * Render 1 lần trong layout, không trả về UI.
 */
export function PWARegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js')
        .catch((err) => console.warn('[pwa] Không đăng ký được service worker:', err));
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }
    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
