'use client';

/**
 * Text-to-speech cho tin nhắn assistant — Web Speech Synthesis API của trình
 * duyệt: 0 backend, 0 chi phí, không key.
 *
 * State "message nào đang được đọc" là module-level singleton vì MessageItem
 * bị memo hóa và có nhiều instance: bấm loa ở message A phải tắt nút ở message
 * B. Các instance đăng ký listener qua useSyncExternalStore — đúng pattern
 * external store của React 19, không cần đưa vào zustand store chung.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { chunkSpeechText } from '@/lib/speech-text';

let speakingId: string | null = null;
const listeners = new Set<() => void>();

// Dừng giọng khi THẬT SỰ rời trang — đăng ký đúng MỘT lần ở mức module.
// KHÔNG đặt cancel trong cleanup của từng MessageItem: danh sách tin nhắn
// được virtualize (@tanstack/react-virtual), cuộn ra xa là hàng bị unmount
// và cleanup sẽ tắt oan giọng đang đọc.
let pageListenersBound = false;
function bindPageListenersOnce(): void {
  if (pageListenersBound || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  pageListenersBound = true;
  const stopAll = () => {
    window.speechSynthesis.cancel();
    setSpeakingId(null);
  };
  window.addEventListener('beforeunload', stopAll);
  document.addEventListener('visibilitychange', () => {
    // Tab ẩn lâu (đóng/mở app PWA trên mobile) cũng nên im — tránh giọng đọc
    // vang lên bất ngờ khi người dùng đã quên.
    if (document.visibilityState === 'hidden' && speakingId !== null) {
      const synth = window.speechSynthesis;
      // paused ≠ kết thúc: mobile Safari tự pause khi ẩn tab; chỉ hủy nếu
      // không còn active nào (trường hợp engine chết ngầm).
      setTimeout(() => {
        if (!synth.speaking && !synth.pending && !synth.paused) setSpeakingId(null);
      }, 500);
    }
  });
}

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): string | null {
  return speakingId;
}

/** Server render: chưa biết id đang đọc, trả null ổn định để tránh hydration mismatch. */
function getServerSnapshot(): string | null {
  return null;
}

function setSpeakingId(id: string | null) {
  if (speakingId === id) return;
  speakingId = id;
  emit();
}

export function isTtsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Chọn voice khớp ngôn ngữ nội dung: ưu tiên voice đúng lang, rồi voice cùng
 * gốc ngôn ngữ (vi-VN khớp vi), rồi voice mặc định hệ điều hành, cuối cùng
 * voice đầu tiên tìm được.
 */
export function pickVoice(
  voices: SpeechSynthesisVoice[],
  preferredLang?: string,
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const lang = (preferredLang ?? '').toLowerCase().replace('_', '-');
  const base = lang.split('-')[0];
  if (base) {
    const match =
      voices.find((v) => v.lang.toLowerCase().replace('_', '-') === lang) ??
      voices.find((v) => v.lang.toLowerCase().replace('_', '-').split('-')[0] === base);
    if (match) return match;
  }
  return voices.find((v) => v.default) ?? voices[0];
}

/**
 * Nhận diện tiếng Việt qua ký tự đặc trưng (ơ ư đ và các nguyên âm mang thanh
 * điệu trong Latin Extended Additional) — thứ tiếng Anh không bao giờ có.
 * Không khớp thì mặc định en-US.
 */
const VIETNAMESE_CHARS =
  /[ăâđêôơưăâđêôơư\u1EA0-\u1EFF]/;

export function detectSpeechLang(text: string): 'vi-VN' | 'en-US' {
  return VIETNAMESE_CHARS.test(text) ? 'vi-VN' : 'en-US';
}

/** Token thế hệ — cancel/chuyển bài tăng gen; closure cũ fire onend muộn
    thì bị loại (bug: tắt nhầm speakingId của bài MỚI). */
let ttsGeneration = 0;

function speakChunks(chunks: string[], lang: string, onEnd: () => void) {
  const synth = window.speechSynthesis;
  const myGen = ++ttsGeneration;
  synth.cancel(); // dừng utterance các phiên trước khi xếp hàng mới

  // getVoices có thể trả rỗng lần đầu (Chrome load voice async); khi có
  // voice, trình duyệt tự dừng default.
  const voice = pickVoice(synth.getVoices(), lang);
  let finished = false;
  const finishOnce = () => {
    if (!finished && myGen === ttsGeneration) {
      finished = true;
      onEnd();
    }
  };

  chunks.forEach((text, i) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    if (voice) u.voice = voice;
    u.rate = 1;
    // Chỉ chunk cuối gắn callback clear state; chunk giữa bị cancel vẫn fire
    // onend/onerror nhưng cờ finished chặn double-clear.
    if (i === chunks.length - 1) {
      u.onend = finishOnce;
      u.onerror = finishOnce;
    }
    synth.speak(u);
  });

  // Queue rỗng/đột tử không fire event (một số trình duyệt khi tab bị ẩn).
  setTimeout(() => {
    if (!synth.speaking && !synth.pending && !synth.paused) finishOnce();
  }, 120);
}

export function stopSpeaking() {
  if (!isTtsSupported()) return;
  ttsGeneration += 1; // vô hiệu hóa closure cũ đang chờ onend
  window.speechSynthesis.cancel();
  setSpeakingId(null);
}

/**
 * Hook cho message-item: đọc to một message, bấm lại thì dừng, bấm loa message
 * khác thì chuyển sang message đó. Trả speakingId để UI đổi icon loa → stop.
 */
export function useTts(): {
  speakingId: string | null;
  supported: boolean;
  toggleSpeak: (id: string, text: string) => void;
  stop: () => void;
} {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    bindPageListenersOnce();
  }, []);

  const toggleSpeak = useCallback((id: string, text: string) => {
    if (!isTtsSupported()) return;
    if (speakingId === id) {
      stopSpeaking();
      return;
    }
    if (!text.trim()) return;

    setSpeakingId(id); // set TRƯỚC speak để nút đổi icon tức thì
    speakChunks(chunkSpeechText(text), detectSpeechLang(text), () => setSpeakingId(null));
  }, []);

  return { speakingId: current, supported: isTtsSupported(), toggleSpeak, stop: stopSpeaking };
}
