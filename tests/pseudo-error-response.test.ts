/**
 * Payload trong file này là dữ liệu THẬT, ghi lại từ request tới
 * gpt.crax.lol khi pool backend cạn: HTTP 200, SSE hợp lệ,
 * finish_reason 'stop', nhưng nội dung là thông báo lỗi.
 */

import { describe, expect, it } from 'vitest';
import {
  extractPseudoErrorMessage,
  isErrorChunkId,
  looksLikePseudoError,
} from '@/lib/pseudo-error-response';

const REAL_CRAX_ERROR =
  '\n\n[Notion is currently unavailable — tried 22 accounts over 0s, every account ' +
  "tried is over its usage cap for this model right now. This usually clears within a " +
  "few minutes as the account pool refreshes; try again shortly, or shorten/simplify " +
  "the prompt if it's very large. If it keeps happening, report it in the Discord.]";

describe('nhận diện lỗi trá hình dưới HTTP 200', () => {
  it('bắt được payload THẬT của crax khi pool cạn', () => {
    expect(looksLikePseudoError(REAL_CRAX_ERROR)).toBe(true);
  });

  it('bắt được ngay cả khi mới nhận một phần đầu (stream chưa xong)', () => {
    expect(looksLikePseudoError(REAL_CRAX_ERROR.slice(0, 60))).toBe(true);
  });

  it('id chunk "err" của gateway được nhận diện', () => {
    expect(isErrorChunkId('err')).toBe(true);
    expect(isErrorChunkId('error')).toBe(true);
    expect(isErrorChunkId('chatcmpl-abc123')).toBe(false);
    expect(isErrorChunkId(undefined)).toBe(false);
  });

  it('trích thông điệp gọn, bỏ ngoặc vuông', () => {
    const msg = extractPseudoErrorMessage(REAL_CRAX_ERROR);
    expect(msg.startsWith('Notion is currently unavailable')).toBe(true);
    expect(msg).not.toContain('[');
    expect(msg.length).toBeLessThanOrEqual(300);
  });
});

describe('KHÔNG chặn nhầm câu trả lời hợp lệ', () => {
  it('câu trả lời thường đi qua', () => {
    expect(looksLikePseudoError('Chào bạn! Hôm nay tôi có thể giúp gì?')).toBe(false);
    expect(looksLikePseudoError('OK')).toBe(false);
    expect(looksLikePseudoError('')).toBe(false);
    expect(looksLikePseudoError(null)).toBe(false);
  });

  it('câu trả lời NÓI VỀ lỗi quota vẫn đi qua (không dương tính giả)', () => {
    const answer =
      'Lỗi 429 nghĩa là bạn đã vượt quá giới hạn số request. ' +
      'Hãy chờ vài phút rồi thử lại, hoặc nâng cấp gói để có usage cap cao hơn.';
    expect(looksLikePseudoError(answer)).toBe(false);
  });

  it('code block chứa chữ "unavailable" không bị chặn', () => {
    const answer = '```js\nif (!service) throw new Error("service unavailable");\n```';
    expect(looksLikePseudoError(answer)).toBe(false);
  });

  it('chỉ soi phần đầu — lỗi giả nằm sâu trong câu trả lời dài không kích hoạt', () => {
    const long = `${'Đây là nội dung hợp lệ. '.repeat(60)}${REAL_CRAX_ERROR}`;
    expect(looksLikePseudoError(long)).toBe(false);
  });
});
