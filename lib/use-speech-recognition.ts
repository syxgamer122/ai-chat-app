'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Web Speech API — nhận diện giọng nói chạy 100% client, miễn phí.
 * Lưu ý: Chrome tự stop sau khoảng im lặng; hook tự mở phiên MỚI khi user
 * còn đang bật. Tuyệt đối không tái dùng instance cũ bằng start() lại —
 * Chrome có bug replay lại audio cuối phiên trước, khiến câu vừa nói bị
 * lặp lại nhiều lần trong input.
 */

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  0: { transcript: string };
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as RecognitionCtor | null;
}

/** Chuẩn hoá để so sánh: thường, gộp khoảng trắng. */
export function normalizeSpeechText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Phát hiện "echo" — browser replay lại audio cuối của phiên trước ở final
 * ĐẦU TIÊN của phiên mới (sau restart): trùng hệt hoặc chồng lấn đuôi/đầu
 * với final cuối của phiên trước. Chỉ được dùng cho final đầu phiên — giữa
 * phiên không bao giờ replay nên không được dedupe (user có thể cố nhắc lại).
 */
export function isReplayEcho(norm: string, last: string): boolean {
  if (!last || !norm) return false;
  if (norm === last) return true;
  if (norm.length < 6 || last.length < 6) return false;
  return last.endsWith(norm) || last.startsWith(norm) || norm.startsWith(last);
}

export interface UseSpeechRecognitionOptions {
  /** Ngôn ngữ nhận diện — mặc định tiếng Việt. */
  lang?: string;
  /** Mỗi câu hoàn chỉnh (final) sẽ được gọi với text đã chuẩn hoá. */
  onFinalText?: (text: string) => void;
}

export function useSpeechRecognition({
  lang = 'vi-VN',
  onFinalText,
}: UseSpeechRecognitionOptions = {}) {
  const [supported] = useState(() => getRecognitionCtor() !== null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef(onFinalText);
  finalRef.current = onFinalText;
  /** Ý định của user — phân biệt với việc engine tự stop sau im lặng. */
  const wantListeningRef = useRef(false);
  /** Final gần nhất (đã chuẩn hoá) — để chặn echo replay sau restart. */
  const lastFinalRef = useRef('');
  /** Final đầu tiên của phiên mới là nơi duy nhất có thể xảy ra echo. */
  const firstFinalRef = useRef(false);
  const createSessionRef = useRef<() => void>(() => {});

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    setListening(false);
    setInterim('');
    try {
      recRef.current?.stop();
    } catch {
      // đã dừng sẵn
    }
  }, []);

  const createSession = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;

    // Instance mới cho mỗi phiên — tái dùng instance cũ là nguyên nhân
    // câu bị lặp lại sau mỗi lần Chrome tự kết thúc phiên.
    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    // Final đầu của phiên mới (do restart) là điểm cần soi echo replay.
    firstFinalRef.current = true;

    rec.onresult = (e) => {
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const result = e.results[i];
        const text = (result[0]?.transcript ?? '').trim();
        if (result.isFinal) {
          if (text) {
            const norm = normalizeSpeechText(text);
            const isEcho =
              firstFinalRef.current && isReplayEcho(norm, lastFinalRef.current);
            firstFinalRef.current = false;
            if (!isEcho) {
              lastFinalRef.current = norm;
              finalRef.current?.(text);
            }
          }
        } else {
          interimText += text + ' ';
        }
      }
      setInterim(interimText.trim());
    };

    rec.onerror = (e) => {
      const code = e?.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setError('Không có quyền dùng micro. Hãy cho phép truy cập micro rồi thử lại.');
        wantListeningRef.current = false;
        setListening(false);
      } else if (code === 'no-speech') {
        // Im lặng kéo dài — engine sẽ tự end và được restart bên dưới.
      } else if (code !== 'aborted') {
        setError('Lỗi nhận diện giọng nói: ' + (code ?? 'không rõ'));
      }
    };

    rec.onend = () => {
      if (!wantListeningRef.current) {
        setListening(false);
        setInterim('');
        return;
      }
      // Chrome tự kết thúc sau im lặng — mở phiên mới để tiếp tục nghe.
      try {
        createSessionRef.current();
      } catch {
        // start() quá sớm sau phiên cũ — đợi một nhịp rồi thử lại.
        window.setTimeout(() => {
          if (!wantListeningRef.current) return;
          try {
            createSessionRef.current();
          } catch {
            setListening(false);
          }
        }, 300);
      }
    };

    rec.start();
  }, [lang]);
  createSessionRef.current = createSession;

  const start = useCallback(() => {
    if (wantListeningRef.current) return; // đã đang nghe — tránh 2 phiên song song
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('Trình duyệt không hỗ trợ nhận diện giọng nói.');
      return;
    }
    setError(null);
    wantListeningRef.current = true;
    lastFinalRef.current = '';
    createSession();
    setListening(true);
  }, [createSession]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  const clearError = useCallback(() => setError(null), []);

  // Unmount / đổi chat — huỷ phiên đang nghe.
  useEffect(
    () => () => {
      wantListeningRef.current = false;
      try {
        recRef.current?.abort();
      } catch {
        // bỏ qua
      }
      recRef.current = null;
    },
    [],
  );

  return { supported, listening, interim, error, start, stop, toggle, clearError };
}
