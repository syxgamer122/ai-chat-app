/**
 * Test route-level cho POST /api/vision — nhánh LỖI là phần dễ hỏng nhất
 * (không test nào phủ trước đây): thiếu model, base sai định dạng, chưa cấu
 * hình provider, describer trả null, và hàng đợi gateway free.
 *
 * Hermetic 100%: `@/lib/vision-bridge` và `acquireUpstreamSlot` đều bị mock
 * nên không có byte nào ra mạng. Same-origin pass bằng header
 * `sec-fetch-site: same-origin` (xem lib/security.ts checkSameOrigin); mỗi case
 * dùng một `x-forwarded-for` riêng để rate limit in-memory (20/60s theo IP)
 * không dội chéo giữa các case.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { POST } from '@/app/api/vision/route';

/* vi.hoisted: factory của vi.mock được gọi trong pha import (trước khi thân
   file chạy), nên state điều khiển mock phải được khởi tạo hoisted kèm. */
const bridgeMock = vi.hoisted(() => ({
  calls: [] as Array<{ dataUrl: string; deps: Record<string, unknown> }>,
  result: null as string | null,
  throws: false,
}));

const queueMock = vi.hoisted(() => ({
  calls: [] as string[],
  busy: false,
}));

vi.mock('@/lib/vision-bridge', () => ({
  describeImageDataUrl: async (dataUrl: string, deps: Record<string, unknown>) => {
    bridgeMock.calls.push({ dataUrl, deps });
    if (bridgeMock.throws) throw new Error('provider nổ');
    return bridgeMock.result;
  },
}));

vi.mock('@/lib/upstream-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/upstream-queue')>();
  return {
    ...actual,
    /* Chỉ thay hàm chiếm slot: sharedFreeBudget giữ bản thật để test kiểm
       chứng đúng chính sách "chỉ host free mới xếp hàng". */
    acquireUpstreamSlot: async (baseUrl: string) => {
      queueMock.calls.push(baseUrl);
      return queueMock.busy ? { ok: false as const, retryAfterSec: 7 } : { ok: true as const };
    },
  };
});

const PNG_DATA_URL = 'data:image/png;base64,' + Buffer.from('fake-png-bytes-here').toString('base64');
const CRAX = 'https://gpt.crax.lol/v1';

let ipCounter = 0;

/** Mỗi lời gọi dùng IP mới → bucket rate limit riêng. */
function callVision(
  body: unknown,
  headers: Record<string, string> = {},
  ipOverride?: string,
): Promise<Response> {
  ipCounter += 1;
  return POST(
    new Request('http://localhost/api/vision', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'sec-fetch-site': 'same-origin',
        'x-forwarded-for': ipOverride ?? `10.9.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const OK_BODY = { dataUrl: PNG_DATA_URL, model: 'vision-model-x' };

describe('/api/vision — nhánh lỗi và hợp đồng response', () => {
  const envBase = process.env.OPENAI_BASE_URL;

  beforeEach(() => {
    bridgeMock.calls.length = 0;
    bridgeMock.result = 'MÔ TẢ ẢNH';
    bridgeMock.throws = false;
    queueMock.calls.length = 0;
    queueMock.busy = false;
    delete process.env.OPENAI_BASE_URL;
  });

  afterEach(() => {
    if (envBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = envBase;
  });

  it('403 khi không phải same-origin', async () => {
    const res = await POST(
      new Request('http://localhost/api/vision', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site', 'x-forwarded-for': '10.1.1.1' },
        body: JSON.stringify(OK_BODY),
      }),
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ ok: false, error: 'forbidden' });
    expect(bridgeMock.calls).toHaveLength(0);
  });

  it('400 bad_request khi body không đúng schema', async () => {
    const res = await callVision({ dataUrl: 'https://example.com/a.png', model: 'm' });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ ok: false, error: 'bad_request' });
  });

  it('400 kèm hướng dẫn khi THIẾU model (khác hẳn bad_request)', async () => {
    const res = await callVision({ dataUrl: PNG_DATA_URL }, { 'x-api-key': 'sk-user' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Thiếu model vision');
    expect(bridgeMock.calls).toHaveLength(0);
  });

  it('model RÁC bị bỏ qua và báo như thiếu model — không gửi tên rác lên provider', async () => {
    const res = await callVision(
      { dataUrl: PNG_DATA_URL, model: 'model có khoảng trắng' },
      { 'x-api-key': 'sk-user' },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.error).toContain('Thiếu model vision');
    expect(bridgeMock.calls).toHaveLength(0);
  });

  it('400 khi x-api-base có nhưng SAI định dạng — không được im lặng gửi key sang host khác', async () => {
    const res = await callVision(OK_BODY, {
      'x-api-base': 'http://192.168.1.10/v1', // http + mạng nội bộ
      'x-api-key': 'sk-user-secret',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.error).toContain('Địa chỉ Nhà cung cấp không hợp lệ');
    // Điểm cốt tử: key người dùng KHÔNG được đem đi gọi upstream nào cả.
    expect(bridgeMock.calls).toHaveLength(0);
    expect(queueMock.calls).toHaveLength(0);
  });

  it('503 khi chưa cấu hình provider (không base, không key)', async () => {
    const res = await callVision(OK_BODY);
    expect(res.status).toBe(503);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.error).toContain('Chưa cấu hình Nhà cung cấp');
    expect(bridgeMock.calls).toHaveLength(0);
  });

  it('502 khi describer trả null (model không xem được ảnh / key sai)', async () => {
    bridgeMock.result = null;
    const res = await callVision(OK_BODY, { 'x-api-base': 'https://gw.test/v1', 'x-api-key': 'k' });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.error).toContain('không trả được mô tả');
  });

  it('502 khi describer ném lỗi', async () => {
    bridgeMock.throws = true;
    const res = await callVision(OK_BODY, { 'x-api-base': 'https://gw.test/v1' });
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: 'Lỗi khi gọi model vision của Nhà cung cấp.',
    });
  });

  it('200 + description khi ổn; deps truyền đúng base/key/model và có fetchImpl', async () => {
    const res = await callVision(OK_BODY, {
      'x-api-base': 'https://gw.test/v1/',
      'x-api-key': 'sk-user',
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, description: 'MÔ TẢ ẢNH' });
    expect(res.headers.get('Cache-Control')).toContain('no-store');

    expect(bridgeMock.calls).toHaveLength(1);
    const deps = bridgeMock.calls[0].deps;
    expect(bridgeMock.calls[0].dataUrl).toBe(PNG_DATA_URL);
    expect(deps.apiKey).toBe('sk-user');
    expect(deps.baseUrl).toBe('https://gw.test/v1'); // slash cuối đã bị strip
    expect(deps.model).toBe('vision-model-x');
    // req.signal được ghép vào fetch để Stop giữa lượt là dừng thật.
    expect(typeof deps.fetchImpl).toBe('function');
  });

  it('base không kèm key -> vẫn thử với key ảo provider-no-key', async () => {
    const res = await callVision(OK_BODY, { 'x-api-base': 'https://gw.test/v1' });
    expect(res.status).toBe(200);
    expect(bridgeMock.calls[0].deps.apiKey).toBe('provider-no-key');
  });

  it('key rác (ký tự ngoài ASCII in được) bị bỏ, chỉ còn base -> provider-no-key', async () => {
    const res = await callVision(OK_BODY, {
      'x-api-base': 'https://gw.test/v1',
      'x-api-key': 'sk user',
    });
    expect(res.status).toBe(200);
    expect(bridgeMock.calls[0].deps.apiKey).toBe('provider-no-key');
  });

  it('429 rate_limited sau 20 lượt trong cùng cửa sổ của MỘT IP', async () => {
    const ip = '10.77.77.77';
    for (let i = 0; i < 20; i++) {
      // Body rác: rate limit chạy TRƯỚC khi parse body nên vẫn tính lượt,
      // đồng thời không tốn lượt gọi describer nào.
      const res = await callVision('{}', {}, ip);
      expect(res.status).toBe(400);
    }
    const res = await callVision('{}', {}, ip);
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ ok: false, error: 'rate_limited' });
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });
});

describe('/api/vision — hàng đợi gateway free dùng chung', () => {
  const envBase = process.env.OPENAI_BASE_URL;

  beforeEach(() => {
    bridgeMock.calls.length = 0;
    bridgeMock.result = 'MÔ TẢ ẢNH';
    bridgeMock.throws = false;
    queueMock.calls.length = 0;
    queueMock.busy = false;
    delete process.env.OPENAI_BASE_URL;
  });

  afterEach(() => {
    if (envBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = envBase;
  });

  it('provider free (crax) -> xếp hàng TRƯỚC khi gọi describer, đúng base sẽ gọi', async () => {
    const res = await callVision(OK_BODY, { 'x-api-base': CRAX, 'x-api-key': 'sk-user' });
    expect(res.status).toBe(200);
    expect(queueMock.calls).toEqual([CRAX]);
  });

  it('không providerBase mà env base là gateway free -> vẫn xếp hàng theo env base', async () => {
    process.env.OPENAI_BASE_URL = CRAX;
    const res = await callVision(OK_BODY, { 'x-api-key': 'sk-user' });
    expect(res.status).toBe(200);
    expect(queueMock.calls).toEqual([CRAX]);
    expect(bridgeMock.calls[0].deps.baseUrl).toBe(CRAX);
  });

  it('provider thường -> KHÔNG xếp hàng (không đụng ngân sách của ai)', async () => {
    const res = await callVision(OK_BODY, { 'x-api-base': 'https://api.openai.com/v1' });
    expect(res.status).toBe(200);
    expect(queueMock.calls).toHaveLength(0);
  });

  it('hết ngân sách -> 429 kèm Retry-After, KHÔNG gọi provider', async () => {
    queueMock.busy = true;
    const res = await callVision(OK_BODY, { 'x-api-base': CRAX, 'x-api-key': 'sk-user' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('7');
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Gateway đang đông');
    expect(json.error).toContain('7');
    // Nhảy hàng là vấn đề P1: không được gọi describer khi bị từ chối slot.
    expect(bridgeMock.calls).toHaveLength(0);
  });
});
