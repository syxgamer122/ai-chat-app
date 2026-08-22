import { describe, expect, it } from 'vitest';
import { isReplayEcho, normalizeSpeechText } from '@/lib/use-speech-recognition';

describe('speech-dedupe — chống lặp câu sau restart phiên', () => {
  it('normalizeSpeechText thường hoá và gộp khoảng trắng', () => {
    expect(normalizeSpeechText('  Xin   Chào  ')).toBe('xin chào');
  });

  it('final trùng hệt final liền trước bị coi là echo', () => {
    expect(isReplayEcho('xin chào bạn', 'xin chào bạn')).toBe(true);
  });

  it('đuôi/đầu của final trước (replay một phần) là echo', () => {
    expect(isReplayEcho('chào bạn', 'xin chào bạn')).toBe(true); // replay đuôi
    expect(isReplayEcho('xin chào', 'xin chào bạn')).toBe(true); // replay nửa đầu
    expect(isReplayEcho('xin chào bạn tên gì', 'xin chào')).toBe(true); // replay + câu mới dính nhau
  });

  it('câu mới hoàn toàn không bị chặn', () => {
    expect(isReplayEcho('hôm nay trời đẹp', 'xin chào bạn')).toBe(false);
  });

  it('từ ngắn nói lại (dưới 6 ký tự) không bị nuốt', () => {
    expect(isReplayEcho('dấm', 'dấm')).toBe(true); // trùng hệt vẫn chặn
    expect(isReplayEcho('bàn', 'đặt bàn')).toBe(false); // quá ngắn → không coi là echo
  });

  it('chuỗi rỗng không phải echo', () => {
    expect(isReplayEcho('', 'xin chào')).toBe(false);
    expect(isReplayEcho('xin chào', '')).toBe(false);
  });
});
