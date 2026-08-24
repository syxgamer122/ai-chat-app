import { describe, expect, it, beforeEach } from 'vitest';
import {
  extractImageDataUrl,
  shouldBridgeImages,
  buildGeminiPayload,
  parseGeminiDescription,
  appendDescription,
  bridgeImagesInMessages,
  resetVisionBridgeCache,
  VISION_BRIDGE_PROMPT,
} from '@/lib/vision-bridge';

const PNG_DATA_URL =
  'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64');

function geminiResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
  } as unknown as Response;
}

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

  it('buildGeminiPayload gom prompt + nhiều ảnh vào 1 request', () => {
    const payload = buildGeminiPayload(
      [
        { mimeType: 'image/png', base64: 'AAA' },
        { mimeType: 'image/jpeg', base64: 'BBB' },
      ],
      VISION_BRIDGE_PROMPT,
    ) as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    const parts = payload.contents[0].parts;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ text: VISION_BRIDGE_PROMPT });
    expect(parts[1]).toEqual({ inline_data: { mime_type: 'image/png', data: 'AAA' } });
    expect(parts[2]).toEqual({ inline_data: { mime_type: 'image/jpeg', data: 'BBB' } });
  });

  it('parseGeminiDescription đọc text, rỗng/lỗi -> null', () => {
    expect(parseGeminiDescription({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] })).toBe('ab');
    expect(parseGeminiDescription({ candidates: [] })).toBeNull();
    expect(parseGeminiDescription(null)).toBeNull();
    expect(parseGeminiDescription({ candidates: [{ content: { parts: [{ text: '  ' }] } }] })).toBeNull();
  });

  it('appendDescription nối block mô tả vào cuối content', () => {
    expect(appendDescription('Câu hỏi', 'MÔ TẢ')).toBe('Câu hỏi\n\n[Ảnh đính kèm — mô tả tự động cho model không xem được ảnh]\nMÔ TẢ');
    expect(appendDescription('', 'MÔ TẢ')).toContain('MÔ TẢ');
  });
});

describe('vision-bridge — bridgeImagesInMessages', () => {
  beforeEach(() => resetVisionBridgeCache());

  const makeFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>) =>
    impl as unknown as typeof fetch;

  it('thay ảnh bằng mô tả, giữ các attachment không phải ảnh', async () => {
    const calls: string[] = [];
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
    const out = await bridgeImagesInMessages(
      messages,
      {
        apiKey: 'k',
        fetchImpl: makeFetch(async (url) => {
          calls.push(url);
          return geminiResponse('Screenshot lỗi màu đỏ');
        }),
      },
    );

    expect(calls).toHaveLength(1);
    expect(out).toHaveLength(1);
    // Ảnh bị thay, PDF giữ lại
    expect(out[0].experimental_attachments).toHaveLength(1);
    expect(out[0].experimental_attachments?.[0].contentType).toBe('application/pdf');
    expect(out[0].content).toContain('Screenshot lỗi màu đỏ');
    expect(out[0].content).toContain('Ảnh này là gì?');
  });

  it('Gemini fail -> giữ message nguyên trạng (không bridge nửa chừng)', async () => {
    const messages = [
      {
        role: 'user',
        content: 'x',
        experimental_attachments: [{ contentType: 'image/png', url: PNG_DATA_URL }],
      },
    ];
    const out = await bridgeImagesInMessages(messages, {
      apiKey: 'k',
      fetchImpl: makeFetch(async () => {
        throw new Error('network down');
      }),
    });
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
      apiKey: 'k',
      fetchImpl: makeFetch(async () => {
        n += 1;
        if (n === 1) {
          return { ok: false, status: 429, json: async () => ({}) } as unknown as Response;
        }
        return geminiResponse('desc');
      }),
    });
    expect(n).toBe(2);
    expect(out[0].content).toContain('desc');
  });

  it('cache theo nội dung ảnh: ảnh gửi lại không gọi Gemini lần 2', async () => {
    let calls = 0;
    const atts = [{ contentType: 'image/png', url: PNG_DATA_URL }];
    const messages = [
      { role: 'user', content: '1', experimental_attachments: atts },
      { role: 'user', content: '2', experimental_attachments: atts },
    ];
    const out = await bridgeImagesInMessages(messages, {
      apiKey: 'k',
      fetchImpl: makeFetch(async () => {
        calls += 1;
        return geminiResponse('same');
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
      apiKey: 'k',
      fetchImpl: makeFetch(async () => geminiResponse('nope')),
    });
    expect(out).toBe(messages); // không đổi gì -> trả mảng gốc
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
      apiKey: 'k',
      fetchImpl: makeFetch(async () => geminiResponse('desc')),
    });
    expect(out[0].content).toEqual([{ type: 'text', text: 'parts' }]);
    expect(out[0].experimental_attachments).toHaveLength(1);
  });
});
