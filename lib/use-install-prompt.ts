'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    /iphone|ipad|ipod/i.test(window.navigator.userAgent) &&
    !/crios|fxios/i.test(window.navigator.userAgent)
  );
}

/**
 * Bắt beforeinstallprompt để hiện nút "Cài đặt app" chủ động
 * (Chrome/Edge/Android). iOS Safari không hỗ trợ event này —
 * trả thêm isIOS để UI hiện hướng dẫn "Thêm vào Màn hình chính".
 */
export function useInstallPrompt() {
  const [canInstall, setCanInstall] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [ios] = useState(isIOS);
  const deferredRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      deferredRef.current = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    const onInstalled = () => {
      deferredRef.current = null;
      setCanInstall(false);
      setInstalled(true);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    if (isStandalone()) setInstalled(true);

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async (): Promise<
    'accepted' | 'dismissed' | 'unavailable'
  > => {
    const event = deferredRef.current;
    if (!event) return 'unavailable';
    await event.prompt();
    const choice = await event.userChoice;
    deferredRef.current = null;
    setCanInstall(false);
    return choice.outcome;
  }, []);

  return { canInstall, installed, isIOS: ios, install };
}
