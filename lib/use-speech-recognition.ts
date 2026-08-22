'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Web Speech API — nhận diện giọng nói chạy 100% client, miễn phí.
 * Lưu ý: Chrome tự stop sau khoảng im lặng; hook tự restart khi user còn đang bật.
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

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('Trình duyệt không hỗ trợ nhận diện giọng nói.');
      return;
    }
    setError(null);
    wantListeningRef.current = true;

    try {
      const rec = new Ctor();
      recRef.current = rec;
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onresult = (e) => {
        let interimText = '';
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const result = e.results[i];
          const text = (result[0]?.transcript ?? '').trim();
          if (result.isFinal) {
            if (text) finalRef.current?.(text);
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
        if (wantListeningRef.current) {
          // Chrome tự kết thúc sau im lặng — khởi động lại để phiên liên tục.
          try {
            rec.start();
            return;
          } catch {
            // start() quá sớm — rơi xuống dưới, user bấm lại.
          }
        }
        setListening(false);
        setInterim('');
      };

      rec.start();
      setListening(true);
    } catch {
      setError('Không khởi động được nhận diện giọng nói.');
      wantListeningRef.current = false;
    }
  }, [lang]);

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
