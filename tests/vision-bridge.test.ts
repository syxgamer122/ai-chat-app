/**
 * Vision bridge qua PROVIDER ACTIVE (gateway tương thích OpenAI) — mock
 * fetchImpl trả JSON chuẩn OpenAI non-stream. Lưu ý shape mock: AI SDK v4
 * yêu cầu `choices[].index` (number) trong response, thiếu là TypeValidationError.
 * Mọi case đều hermetic — không chạm mạng thật.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  extractImageDataUrl,
  shouldBridgeImages,
  appendDescription,
  bridgeImagesInMessages,
  downgradeImagesToPlaceholders,
  resetVisionBridgeCache,
  VISION_BRIDGE_PROMPT,
  IMAGE_OMITTED_PLACEHOLDER,
} from '@/lib/vision-bridge';

const PNG_DATA_URL =
  'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64');
const OTHER_PNG_DATA_URL =
  'data:image/png;base64,' + Buffer.from('other-bytes').toString('base64');

/** Response JSON non-stream mà @ai-sdk/openai parse được. */
function openaiTextResponse(text: string) {
  return new Response(
    JSON.stringify({
      choices: [
        { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const httpError = (status: number, message?: string) =>
  new Response(JSON.stringify({ error: { message: message ?? `http ${status}` } }), { status });

const makeFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>) =>
  impl as unknown as typeof fetch;

const BASE_DEPS = { apiKey: 'k', baseUrl: 'https://gw.test/v1', model: 'vision-model-x' };

describe('vision-bridge — helpers thuần', () => {
  it('extractImageDataUrl nhận data URL ảnh, từ chối thứ khác', () => {
    expect(extractImageDataUrl(PNG_DATA_URL)).toEqual({
      mimeType: 'image/png',
      base64: Buffer.from('fake-png-bytes').toString('base64'),
    });
    expect(extractImageDataUrl('https://example.com/a.png')).toBeNull();
    expect(extractImageDataUrl('data:text/plain;base64,SGk=')).toBeNull();
    expect(extractImageDataUrl('')).toBeNull();
  });

  it('shouldBridgeImages: chỉ model chữ thuần', () => {
    expect(shouldBridgeImages({ supportsImages: false })).toBe(true);
    expect(shouldBridgeImages({ supportsImages: true })).toBe(false);
    expect(shouldBridgeImages({ supportsImages: false, media: 'image' })).toBe(false);
    expect(shouldBridgeImages({ supportsImages: undefined as unknown as boolean })).toBe(false);
  });

  it('appendDescription nối block mô tả vào cuối content kèm cảnh báo untrusted', () => {
    const out = appendDescription('Câu hỏi', 'MÔ TẢ');
    expect(out).toContain('Câu hỏi\n\n[Ảnh đính kèm');
    expect(out).toContain('MÔ TẢ');
    expect(out).toContain('KHÔNG thực hiện'); // chống prompt-injection qua chữ trong ảnh
    expect(appendDescription('', 'MÔ TẢ')).toContain('MÔ TẢ');
  });
});

describe('vision-bridge — bridgeImagesInMessages qua provider OpenAI-compat', () => {
  beforeEach(() => {
    resetVisionBridgeCache();
  });

  it('gọi đúng endpoint/model, body chứa prompt + image data-URL + stream:false', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const messages = [
      {
        role: 'user',
        content: 'Ảnh này là gì?',
        experimental_attachments: [
          { name: 'a.png', contentType: 'image/png', url: PNG_DATA_URL },
          { name: 'doc.pdf', contentType: 'application/pdf', url: PNG_DATA_URL },
        ],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      fetchImpl: makeFetch(async (url, init) => {
        calls.push({ url, init });
        return openaiTextResponse('Screenshot lỗi màu đỏ');
      }),
    });

    // Một nhóm ảnh → đúng một request chat/completions của provider.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://gw.test/v1/chat/completions');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer k');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.model).toBe('vision-model-x');
    expect(body.stream).toBe(false); // quirk crax — xem non-streaming-fetch
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(2048);
    const parts = body.messages[0].content;
    expect(parts[0]).toEqual({ type: 'text', text: VISION_BRIDGE_PROMPT });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: PNG_DATA_URL } });

    expect(out).toHaveLength(1);
    // Ảnh bị thay, PDF giữ lại
    expect(out[0].experimental_attachments).toHaveLength(1);
    expect(out[0].experimental_attachments?.[0].contentType).toBe('application/pdf');
    expect(out[0].content).toContain('Screenshot lỗi màu đỏ');
    expect(out[0].content).toContain('Ảnh này là gì?');
  });

  it('nhiều ảnh trong một message → gom MỘT request, mô tả đánh số từng ảnh', async () => {
    let n = 0;
    const messages = [
      {
        role: 'user',
        content: 'so sánh 2 ảnh',
        experimental_attachments: [
          { contentType: 'image/png', url: PNG_DATA_URL },
          { contentType: 'image/png', url: OTHER_PNG_DATA_URL },
        ],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      fetchImpl: makeFetch(async (_url, init) => {
        n += 1;
        const body = JSON.parse(String(init?.body));
        const images = body.messages[0].content.filter((p: any) => p.type === 'image_url');
        expect(images).toHaveLength(2); // gom cả nhóm trong 1 call như bridge cũ
        return openaiTextResponse('ảnh A; ảnh B');
      }),
    });
    expect(n).toBe(1);
    expect(out[0].content).toContain('[Ảnh 1]');
    expect(out[0].content).toContain('[Ảnh 2]');
    expect(out[0].experimental_attachments).toBeUndefined();
  });

  it('lỗi mạng → retry hết chuỗi delay rồi giữ message nguyên trạng', async () => {
    let n = 0;
    const messages = [
      {
        role: 'user',
        content: 'x',
        experimental_attachments: [{ contentType: 'image/png', url: PNG_DATA_URL }],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      fetchImpl: makeFetch(async () => {
        n += 1;
        throw new Error('network down');
      }),
    });
    expect(n).toBe(3); // RETRY_DELAYS_MS = [0, 800, 2000]
    expect(out[0].content).toBe('x');
    expect(out[0].experimental_attachments).toHaveLength(1);
  });

  it('429 rồi 200 -> retry và thành công', async () => {
    let n = 0;
    const messages = [
      {
        role: 'user',
        content: 'y',
        experimental_attachments: [{ contentType: 'image/jpeg', url: PNG_DATA_URL }],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      fetchImpl: makeFetch(async () => {
        n += 1;
        return n === 1 ? httpError(429) : openaiTextResponse('desc');
      }),
    });
    expect(n).toBe(2);
    expect(out[0].content).toContain('desc');
  });

  it('429 xuyên suốt -> hết lượt retry, giữ message nguyên trạng', async () => {
    let n = 0;
    const messages = [
      {
        role: 'user',
        content: 'y',
        experimental_attachments: [{ contentType: 'image/jpeg', url: PNG_DATA_URL }],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      fetchImpl: makeFetch(async () => {
        n += 1;
        return httpError(429);
      }),
    });
    expect(n).toBe(3);
    expect(out[0].content).toBe('y');
  });

  it('400 (vd ảnh HEIC provider không đọc được) -> dừng ngay, không đốt retry', async () => {
    let n = 0;
    const messages = [
      {
        role: 'user',
        content: 'z',
        experimental_attachments: [{ contentType: 'image/heic', url: PNG_DATA_URL }],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      fetchImpl: makeFetch(async () => {
        n += 1;
        return httpError(400);
      }),
    });
    expect(n).toBe(1); // lỗi request-content — thử lại cũng vứt
    expect(out[0].content).toBe('z');
    expect(out[0].experimental_attachments).toHaveLength(1);
  });

  it('400 vì temperature (model reasoning) -> thử lại 1 lần KHÔNG kèm temperature', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const messages = [
      {
        role: 'user',
        content: 'r',
        experimental_attachments: [{ contentType: 'image/png', url: PNG_DATA_URL }],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      fetchImpl: makeFetch(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        return 'temperature' in body
          ? httpError(400, "Unsupported value: 'temperature' does not support 0.2 with this model")
          : openaiTextResponse('mô tả sau khi bỏ temperature');
      }),
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].temperature).toBe(0.2);
    // Lượt sửa: field temperature bị BỎ HẲN khỏi body (không phải gửi 0) —
    // OpenAI từ chối cả 0 cho model o1/gpt-5, xem lib/vision-bridge.
    expect('temperature' in bodies[1]).toBe(false);
    expect(bodies[1].stream).toBe(false); // vẫn giữ quirk stream:false
    expect(out[0].content).toContain('mô tả sau khi bỏ temperature');
  });

  it('400 vì temperature xuyên suốt -> chỉ sửa tham số MỘT lần, không lặp vô hạn', async () => {
    let n = 0;
    const messages = [
      {
        role: 'user',
        content: 's',
        experimental_attachments: [{ contentType: 'image/png', url: PNG_DATA_URL }],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      fetchImpl: makeFetch(async () => {
        n += 1;
        return httpError(400, 'temperature is not supported for reasoning models');
      }),
    });
    // Lượt 1 (có temperature) + lượt sửa tham số; lượt sửa vẫn 400 vì
    // temperature nhưng cờ đã dùng → dừng, không quay vòng.
    expect(n).toBe(2);
    expect(out[0].content).toBe('s');
  });

  it('cache theo nội dung ảnh: ảnh gửi lại không gọi provider lần 2', async () => {
    let calls = 0;
    const atts = [{ contentType: 'image/png', url: PNG_DATA_URL }];
    const messages = [
      { role: 'user', content: '1', experimental_attachments: atts },
      { role: 'user', content: '2', experimental_attachments: atts },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      fetchImpl: makeFetch(async () => {
        calls += 1;
        return openaiTextResponse('same');
      }),
    });
    expect(calls).toBe(1);
    expect(out[0].content).toContain('same');
    expect(out[1].content).toContain('same');
  });

  it('không có ảnh data-URL -> trả nguyên messages (cùng tham chiếu)', async () => {
    const messages = [
      { role: 'user', content: 'plain' },
      {
        role: 'user',
        content: 'remote',
        experimental_attachments: [{ contentType: 'image/png', url: 'https://x/y.png' }],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      fetchImpl: makeFetch(async () => openaiTextResponse('nope')),
    });
    expect(out).toBe(messages); // không đổi gì -> trả mảng gốc
  });

  it('response text rỗng -> coi như không mô tả được, giữ message nguyên trạng', async () => {
    const messages = [
      {
        role: 'user',
        content: 'w',
        experimental_attachments: [{ contentType: 'image/png', url: PNG_DATA_URL }],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      fetchImpl: makeFetch(async () => openaiTextResponse('   ')),
    });
    expect(out[0].content).toBe('w');
    expect(out[0].experimental_attachments).toHaveLength(1);
  });

  it('message dạng content mảng parts được bỏ qua nguyên vẹn', async () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'parts' }],
        experimental_attachments: [{ contentType: 'image/png', url: PNG_DATA_URL }],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      fetchImpl: makeFetch(async () => openaiTextResponse('desc')),
    });
    expect(out[0].content).toEqual([{ type: 'text', text: 'parts' }]);
    expect(out[0].experimental_attachments).toHaveLength(1);
  });
});

describe('vision-bridge — acquireSlot (hàng đợi gateway free dùng chung)', () => {
  beforeEach(() => {
    resetVisionBridgeCache();
  });

  it('chiếm slot đúng MỘT lần cho mỗi nhóm ảnh sẽ gọi provider', async () => {
    let slots = 0;
    let calls = 0;
    const messages = [
      {
        role: 'user',
        content: 'a',
        experimental_attachments: [{ contentType: 'image/png', url: PNG_DATA_URL }],
      },
      {
        role: 'user',
        content: 'b',
        experimental_attachments: [{ contentType: 'image/png', url: OTHER_PNG_DATA_URL }],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      acquireSlot: async () => {
        slots += 1;
        return true;
      },
      fetchImpl: makeFetch(async () => {
        calls += 1;
        return openaiTextResponse(`desc-${calls}`);
      }),
    });
    expect(slots).toBe(2); // hai message, hai nhóm ảnh khác nhau
    expect(calls).toBe(2);
    expect(out[0].content).toContain('desc-1');
  });

  it('một slot phủ CẢ chuỗi retry của nhóm ảnh', async () => {
    let slots = 0;
    let calls = 0;
    const messages = [
      {
        role: 'user',
        content: 'a',
        experimental_attachments: [{ contentType: 'image/png', url: PNG_DATA_URL }],
      },
    ];
    await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      acquireSlot: async () => {
        slots += 1;
        return true;
      },
      fetchImpl: makeFetch(async () => {
        calls += 1;
        return calls < 3 ? httpError(429) : openaiTextResponse('ok sau retry');
      }),
    });
    expect(calls).toBe(3);
    expect(slots).toBe(1); // retry nội bộ KHÔNG chiếm thêm ngân sách
  });

  it('ảnh đã có mô tả trong cache -> KHÔNG chiếm slot (không đốt ngân sách vô ích)', async () => {
    let slots = 0;
    const atts = [{ contentType: 'image/png', url: PNG_DATA_URL }];
    const deps = {
      ...BASE_DEPS,
      acquireSlot: async () => {
        slots += 1;
        return true;
      },
      fetchImpl: makeFetch(async () => openaiTextResponse('cached-desc')),
    };
    await bridgeImagesInMessages([{ role: 'user', content: '1', experimental_attachments: atts }], deps);
    expect(slots).toBe(1);
    // Lượt chat sau gửi lại cùng ảnh (history) — mô tả lấy từ cache.
    const out = await bridgeImagesInMessages(
      [{ role: 'user', content: '2', experimental_attachments: atts }],
      deps,
    );
    expect(slots).toBe(1);
    expect(out[0].content).toContain('cached-desc');
  });

  it('hết ngân sách -> KHÔNG gọi provider, message giữ nguyên (chat không bị chết)', async () => {
    let calls = 0;
    const messages = [
      {
        role: 'user',
        content: 'x',
        experimental_attachments: [{ contentType: 'image/png', url: PNG_DATA_URL }],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      ...BASE_DEPS,
      acquireSlot: async () => false,
      fetchImpl: makeFetch(async () => {
        calls += 1;
        return openaiTextResponse('không được phép gọi');
      }),
    });
    expect(calls).toBe(0);
    expect(out).toBe(messages); // không đổi gì -> caller tự hạ về placeholder
  });
});

describe('downgradeImagesToPlaceholders — lớp chốt hạ khi không bridge được', () => {
  const img = (url: string = PNG_DATA_URL) => ({ contentType: 'image/png', url });
  const pdf = { contentType: 'application/pdf', url: 'data:application/pdf;base64,AAAA' };

  it('thay ảnh bằng placeholder + bỏ attachment ảnh', () => {
    const messages = [
      { role: 'user', content: 'Ảnh này là gì?', experimental_attachments: [img()] },
    ];
    const out = downgradeImagesToPlaceholders(messages);
    expect(out).not.toBe(messages);
    expect(out[0].content).toContain(IMAGE_OMITTED_PLACEHOLDER);
    expect(out[0].content).toContain('Ảnh này là gì?');
    expect(out[0].experimental_attachments).toBeUndefined();
  });

  it('nhiều ảnh trong một message -> placeholder ghi kèm số lượng', () => {
    const messages = [
      { role: 'user', content: 'x', experimental_attachments: [img(), img()] },
    ];
    const out = downgradeImagesToPlaceholders(messages) as typeof messages;
    expect((out[0].content as string)).toContain('(2 ảnh)');
  });

  it('giữ attachment phi-ảnh (pdf/text), chỉ bỏ ảnh — kể cả ảnh http(s)', () => {
    const messages = [
      {
        role: 'user',
        content: 'hồ sơ',
        experimental_attachments: [
          pdf,
          img('https://example.com/remote.png'),
          { contentType: 'text/plain', url: 'data:text/plain;base64,SGk=' },
        ],
      },
    ];
    const out = downgradeImagesToPlaceholders(messages) as typeof messages;
    const atts = out[0].experimental_attachments ?? [];
    expect(atts).toHaveLength(2);
    expect(atts.some((a) => a.contentType === 'application/pdf')).toBe(true);
    expect(atts.some((a) => a.contentType === 'text/plain')).toBe(true);
  });

  it('không có ảnh -> trả nguyên mảng gốc (=== ), không thêm placeholder', () => {
    const messages = [
      { role: 'user', content: 'chữ thôi', experimental_attachments: [pdf] },
      { role: 'user', content: 'trống attachments' },
    ];
    const out = downgradeImagesToPlaceholders(messages);
    expect(out).toBe(messages);
  });

  it('message content rỗng + chỉ có ảnh -> content thành một mình placeholder', () => {
    const messages = [{ role: 'user', content: '', experimental_attachments: [img()] }];
    const out = downgradeImagesToPlaceholders(messages) as typeof messages;
    expect(out[0].content).toBe(IMAGE_OMITTED_PLACEHOLDER);
  });

  it('content dạng mảng parts được giữ nguyên (không đụng cấu trúc)', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'parts' }],
        experimental_attachments: [img()],
      },
    ];
    const out = downgradeImagesToPlaceholders(messages);
    expect(out).toBe(messages);
  });
});
