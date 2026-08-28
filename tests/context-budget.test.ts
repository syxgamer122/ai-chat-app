import { describe, expect, it } from 'vitest';
import {
  estimateContextTokens,
  estimatePromptTokens,
  evaluateUsageTrigger,
  isContextOverflowError,
  retainedTailBudget,
  shouldCompact,
  splitForCompaction,
  KEEP_RECENT_MESSAGES,
  KEEP_RECENT_TOKENS,
  MIN_KEEP_RECENT_TOKENS,
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

  it('tính kết quả tool invocation theo JSON, có trần ký tự', () => {
    const m = {
      role: 'assistant',
      content: 'abcd',
      toolInvocations: [
        { state: 'call', args: { path: 'ab' } },
        { state: 'result', args: { path: 'cd' }, result: { content: 'x'.repeat(40) } },
      ],
    };
    // text 1 + args(12/4=3) + result JSON ~54/4=14
    expect(estimateContextTokens([m])).toBeGreaterThan(15);
  });

  it('bỏ qua partial-call và giá trị không serialize được', () => {
    const m = {
      role: 'assistant',
      content: '',
      toolInvocations: [
        { state: 'partial-call', args: { path: 'x'.repeat(100) } },
        { state: 'call', args: { circular: BigInt(1) } },
      ],
    };
    expect(estimateContextTokens([m])).toBe(0);
  });
});

describe('estimatePromptTokens', () => {
  it('cộng messages và các block system động', () => {
    expect(
      estimatePromptTokens([msg('abcd')], ['x'.repeat(8), undefined, null]),
    ).toBe(3);
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

describe('retainedTailBudget — nửa ngưỡng, kẹp trong [MIN, KEEP_RECENT_TOKENS]', () => {
  it('window nhỏ: một nửa ngưỡng (window − reserve)', () => {
    // 32k − 6k = 26k -> 13k
    expect(retainedTailBudget(32_000)).toBe(13_000);
  });

  it('window lớn: chạm trần tuyệt đối', () => {
    // 128k − 6k = 122k -> 61k, bị kẹp về KEEP_RECENT_TOKENS
    expect(retainedTailBudget(128_000)).toBe(KEEP_RECENT_TOKENS);
  });

  it('window tí hon vẫn giữ được sàn', () => {
    expect(retainedTailBudget(7_000)).toBe(MIN_KEEP_RECENT_TOKENS);
  });

  it('window không hợp lệ -> dùng FALLBACK', () => {
    expect(retainedTailBudget(undefined)).toBe(retainedTailBudget(FALLBACK_CONTEXT_WINDOW));
    expect(retainedTailBudget(0)).toBe(retainedTailBudget(FALLBACK_CONTEXT_WINDOW));
  });
});

describe('splitForCompaction — cắt theo SỐ LƯỢNG và NGÂN SÁCH TOKEN', () => {
  it('hội thoại ngắn -> null (không đáng nén)', () => {
    const few = Array.from({ length: MIN_MESSAGES_TO_COMPACT }, (_, i) => msg(`m${i}`));
    expect(splitForCompaction(few)).toBeNull();
  });

  it('tin nhắn nhẹ -> vẫn cắt theo KEEP_RECENT_MESSAGES như trước', () => {
    const list = Array.from({ length: MIN_MESSAGES_TO_COMPACT + KEEP_RECENT_MESSAGES + 2 }, (_, i) =>
      msg(`m${i}`),
    );
    const out = splitForCompaction(list)!;
    expect(out.older).toHaveLength(list.length - KEEP_RECENT_MESSAGES);
    expect(out.keep).toHaveLength(KEEP_RECENT_MESSAGES);
    expect(out.firstKept).toBe(list.length - KEEP_RECENT_MESSAGES);
    expect((out.older[0] as ReturnType<typeof msg>).content).toBe('m0');
  });

  it('tool result khổng lồ: evict SÂU HƠN trần số lượng', () => {
    /* Kịch bản agent coding thật: 12 tin, mỗi tin một tool result 24k ký tự
       (~6k token). Trần số lượng giữ 8 tin => ~48k token, vẫn tràn window 32k.
       Ngân sách token (13k) chỉ cho giữ 2 tin. */
    const heavy = Array.from({ length: 12 }, (_, i) => ({
      role: 'assistant',
      content: '',
      toolInvocations: [
        { state: 'result', args: { path: `f${i}.ts` }, result: { content: 'x'.repeat(24_000) } },
      ],
    }));
    const out = splitForCompaction(heavy, 32_000)!;
    expect(out.firstKept).toBeGreaterThan(heavy.length - KEEP_RECENT_MESSAGES);
    expect(out.keptTokens).toBeLessThanOrEqual(retainedTailBudget(32_000));
  });

  it('luôn giữ lại ít nhất MỘT tin dù tin đó vượt ngân sách', () => {
    const giant = Array.from({ length: 10 }, () => msg('y'.repeat(400_000)));
    const out = splitForCompaction(giant, 32_000)!;
    expect(out.keep).toHaveLength(1);
    expect(out.firstKept).toBe(giant.length - 1);
  });

  it('điểm cắt giữa lượt -> splitTurnStart trỏ vào tin user mở lượt', () => {
    /* 15 tin, trần số lượng giữ 8 cuối => firstKept = 7 (một assistant giữa
       lượt). Phải truy ngược ra tin user mở lượt ở index 6. */
    const list = [
      ...Array.from({ length: 6 }, (_, i) => msg(`cũ ${i}`)),
      { role: 'user', content: 'sửa file cho tôi' },
      ...Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', content: `bước ${i}` })),
    ];
    const out = splitForCompaction(list)!;
    expect(out.firstKept).toBe(7);
    expect(list[out.firstKept].role).toBe('assistant');
    expect(out.splitTurnStart).toBe(6);
    expect((list[out.splitTurnStart!] as { content: string }).content).toBe('sửa file cho tôi');
  });

  it('điểm cắt đúng ranh giới lượt user -> không có splitTurnStart', () => {
    const list = [
      ...Array.from({ length: 8 }, (_, i) => msg(`cũ ${i}`)),
      ...Array.from({ length: 8 }, () => ({ role: 'user', content: 'hỏi' })),
    ];
    const out = splitForCompaction(list)!;
    expect(list[out.firstKept].role).toBe('user');
    expect(out.splitTurnStart).toBeUndefined();
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

describe('evaluateUsageTrigger — trigger theo usage thật từ upstream', () => {
  const base = (overrides: Record<string, unknown> = {}) => ({
    promptTokens: 20_000,
    completionTokens: 500,
    finishReason: 'stop',
    windowTokens: 32_000,
    ...overrides,
  });

  it('dưới ngưỡng → skip', () => {
    expect(evaluateUsageTrigger(base({ promptTokens: 10_000 })).kind).toBe('skip');
  });

  it('threshold: promptTokens > window − reserve → trigger', () => {
    // 32k − 6k = 26k; 27k > 26k
    const d = evaluateUsageTrigger(base({ promptTokens: 27_000 }));
    expect(d.kind).toBe('threshold');
  });

  it('silent overflow: stop + promptTokens > window → trigger', () => {
    // promptTokens 35k > window 32k nhưng finishReason vẫn 'stop'
    const d = evaluateUsageTrigger(base({ promptTokens: 35_000, finishReason: 'stop' }));
    expect(d.kind).toBe('silent_overflow');
  });

  it('length-stop zero-output: input ≥ 99% window → trigger', () => {
    const d = evaluateUsageTrigger(base({
      promptTokens: 31_800, // ≥ 32k * 0.99 = 31_680
      completionTokens: 0,
      finishReason: 'length',
    }));
    expect(d.kind).toBe('length_stop_zero_output');
  });

  it('length-stop có output + dưới ngưỡng threshold → skip', () => {
    // promptTokens 25k < threshold 26k; length + output → không phải overflow
    const d = evaluateUsageTrigger(base({
      promptTokens: 25_000,
      completionTokens: 100,
      finishReason: 'length',
    }));
    expect(d.kind).toBe('skip');
  });

  it('length-stop dưới 99% window + dưới ngưỡng threshold → skip', () => {
    const d = evaluateUsageTrigger(base({
      promptTokens: 20_000, // < 31_680 và < 26_000
      completionTokens: 0,
      finishReason: 'length',
    }));
    expect(d.kind).toBe('skip');
  });

  it('window = 0 hoặc undefined → skip (gate an toàn)', () => {
    expect(evaluateUsageTrigger(base({ windowTokens: 0 })).kind).toBe('skip');
    expect(evaluateUsageTrigger(base({ windowTokens: undefined })).kind).toBe('skip');
    expect(evaluateUsageTrigger(base({ windowTokens: null })).kind).toBe('skip');
  });

  it('promptTokens = 0 → skip (usage không tin cậy)', () => {
    expect(evaluateUsageTrigger(base({ promptTokens: 0 })).kind).toBe('skip');
  });

  it('reserve tuỳ chỉnh', () => {
    // window 32k, reserve 2k → ngưỡng 30k; 29k < 30k → skip
    expect(evaluateUsageTrigger(base({ promptTokens: 29_000, reserveTokens: 2_000 })).kind).toBe('skip');
    // 31k > 30k → threshold
    expect(evaluateUsageTrigger(base({ promptTokens: 31_000, reserveTokens: 2_000 })).kind).toBe('threshold');
  });
});
