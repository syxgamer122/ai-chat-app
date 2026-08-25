import { describe, expect, it } from 'vitest';
import {
  estimateContextTokens,
  isContextOverflowError,
  shouldCompact,
  splitForCompaction,
  KEEP_RECENT_MESSAGES,
  MIN_MESSAGES_TO_COMPACT,
  FALLBACK_CONTEXT_WINDOW,
  IMAGE_TOKEN_ESTIMATE,
} from '@/lib/context-budget';

const msg = (content: string, attachments?: Array<{ contentType?: string; url?: string }>) => ({
  role: 'user',
  content,
  ...(attachments ? { experimental_attachments: attachments } : {}),
});

describe('estimateContextTokens — chars/4 + ảnh hằng số', () => {
  it('chuỗi đơn giản', () => {
    expect(estimateContextTokens([msg('abcd'.repeat(100))])).toBe(100);
    expect(estimateContextTokens([msg('abc')])).toBe(1); // ceil(3/4)
  });

  it('content dạng mảng parts của AI SDK', () => {
    const m = { role: 'user', content: [{ type: 'text', text: 'x'.repeat(80) }] };
    expect(estimateContextTokens([m])).toBe(20);
  });

  it('ảnh đính kèm tính IMAGE_TOKEN_ESTIMATE, không cộng base64', () => {
    const img = { contentType: 'image/png', url: 'data:image/png;base64,' + 'A'.repeat(4000) };
    expect(estimateContextTokens([msg('hi', [img])])).toBe(1 + IMAGE_TOKEN_ESTIMATE);
  });

  it('attachment phi-ảnh trần theo độ dài URL', () => {
    const pdf = { contentType: 'application/pdf', url: 'data:application/pdf;base64,' + 'B'.repeat(400) };
    // 26 ký tự prefix + 400 = 426 -> ceil/4 = 107
    expect(estimateContextTokens([msg('hi', [pdf])])).toBe(1 + 107);
  });
});

describe('shouldCompact — tokens > window − reserve', () => {
  it('dưới ngưỡng: false; vượt ngưỡng: true', () => {
    expect(shouldCompact(10_000, 32_000)).toBe(false); // 10k < 32k − 6k
    expect(shouldCompact(27_000, 32_000)).toBe(true); // 27k > 26k
  });

  it('window không hợp lệ -> dùng FALLBACK_CONTEXT_WINDOW', () => {
    // 25k < 32k − 6k = 26k ngưỡng
    expect(shouldCompact(FALLBACK_CONTEXT_WINDOW - 7_000, undefined)).toBe(false);
    // 31k > 26k
    expect(shouldCompact(FALLBACK_CONTEXT_WINDOW - 1_000, 0)).toBe(true);
  });

  it('reserve tuỳ chỉnh', () => {
    expect(shouldCompact(9_500, 12_000, 2_000)).toBe(false);
    expect(shouldCompact(10_100, 12_000, 2_000)).toBe(true);
  });
});

describe('splitForCompaction — cắt tại ranh giới giữ tin cuối', () => {
  it('hội thoại ngắn -> null (không đáng nén)', () => {
    const few = Array.from({ length: MIN_MESSAGES_TO_COMPACT }, (_, i) => msg(`m${i}`));
    expect(splitForCompaction(few)).toBeNull();
  });

  it('đủ dài -> older = trước KEEP_RECENT, keep = KEEP_RECENT tin cuối', () => {
    const list = Array.from({ length: MIN_MESSAGES_TO_COMPACT + KEEP_RECENT_MESSAGES + 2 }, (_, i) =>
      msg(`m${i}`),
    );
    const out = splitForCompaction(list)!;
    expect(out.older).toHaveLength(list.length - KEEP_RECENT_MESSAGES);
    expect(out.keep).toHaveLength(KEEP_RECENT_MESSAGES);
    expect((out.older[0] as ReturnType<typeof msg>).content).toBe('m0');
    expect((out.keep[out.keep.length - 1] as ReturnType<typeof msg>).content).toContain(
      `m${list.length - 1}`,
    );
  });
});

describe('isContextOverflowError — regex theo provider', () => {
  it.each([
    ['Anthropic', 400, 'prompt is too long: 213462 tokens > 200000 maximum'],
    ['OpenAI', 400, 'Your input exceeds the context window of this model'],
    ['OpenRouter', 400, "This endpoint's maximum context length is 8192 tokens. However, you requested about 12000 tokens"],
    ['Groq', 400, 'Please reduce the length of the messages or completion'],
    ['Kimi', 400, 'Your request exceeded model token limit: 90000 (requested: 120000)'],
    ['Generic', 500, 'context_length_exceeded after 210000 tokens'],
  ])('%s: nhận diện qua body dù status %i', (_name, status, text) => {
    expect(isContextOverflowError(status, text)).toBe(true);
  });

  it('rate limit KHÔNG bị nhầm là tràn dù body nhắc "tokens"', () => {
    expect(
      isContextOverflowError(429, 'Too many tokens, please wait before trying again'),
    ).toBe(false);
    expect(isContextOverflowError(429, 'Rate limit exceeded for requests')).toBe(false);
  });

  it('body rỗng / lỗi thường -> false', () => {
    expect(isContextOverflowError(500, '')).toBe(false);
    expect(isContextOverflowError(undefined, 'Internal Server Error')).toBe(false);
    expect(isContextOverflowError(401, 'Unauthorized')).toBe(false);
  });
});
