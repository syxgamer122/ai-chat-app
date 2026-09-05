/**
 * Tests cho `llmFetch` — LLM fetch proxy chạy trong Electron main (giai đoạn 2,
 * desktop tự chủ). Renderer mượn main gọi gateway để né CORS/403-Origin.
 *
 * Handler được export riêng và nhận `deps.fetch` tiêm được nên test chạy trong
 * node thuần không cần Electron (pattern tests/mcp-electron.test.ts) —
 * mọi networking đều là mock.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { llmFetch, LLM_FETCH_ALLOWED_HEADERS, LIMITS } = require('../lib/ipc.cjs');

/** Response giả đủ shape mà llmFetch đọc: ok/status/headers.get/text. */
function fakeResponse(
  body: string,
  opts: { ok?: boolean; status?: number; headers?: Record<string, string> } = {},
) {
  const headers = opts.headers ?? {};
  return {
    ok: opts.ok ?? (opts.status ?? 200) < 400,
    status: opts.status ?? 200,
    headers: { get: (name: string) => headers[name] ?? null },
    text: async () => body,
  };
}

const OK_URL = 'https://gateway.example/v1/models';
const basePayload = { url: OK_URL, method: 'GET' as const };

describe('llmFetch — validate payload', () => {
  it('chặn URL không phải http(s)', async () => {
    await expect(
      llmFetch({ ...basePayload, url: 'file:///etc/passwd' }),
    ).rejects.toThrow(/http\(s\)/i);
  });

  it('chặn URL rác không parse được', async () => {
    await expect(llmFetch({ ...basePayload, url: 'not-a-url' })).rejects.toThrow();
  });

  it('chặn method ngoài GET/POST (zod)', async () => {
    await expect(
      llmFetch({ ...basePayload, method: 'DELETE' as never }),
    ).rejects.toThrow();
  });

  it('chặn body vượt trần 2MB (zod) — không fetch', async () => {
    let called = 0;
    await expect(
      llmFetch(
        { url: OK_URL, method: 'POST', body: 'x'.repeat(LIMITS.LLM_FETCH_MAX_BODY_CHARS + 1) },
        { fetch: async () => { called += 1; return fakeResponse('{}'); } },
      ),
    ).rejects.toThrow();
    expect(called).toBe(0);
  });
});

describe('llmFetch — header allowlist', () => {
  it('cho phép accept/authorization/content-type', async () => {
    const seen: Array<Record<string, string>> = [];
    const res = await llmFetch(
      {
        url: OK_URL,
        method: 'POST',
        headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
      },
      {
        fetch: async (_url: unknown, init?: { headers?: Record<string, string> }) => {
          seen.push(init?.headers as Record<string, string>);
          return fakeResponse('{"ok":true}');
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(seen[0]).toMatchObject({ Authorization: 'Bearer k' });
  });

  it('chặn header ngoài allowlist (Origin/Cookie/Host...)', async () => {
    let called = 0;
    await expect(
      llmFetch(
        { ...basePayload, headers: { Origin: 'https://evil.example', Cookie: 'x=1' } },
        { fetch: async () => { called += 1; return fakeResponse('{}'); } },
      ),
    ).rejects.toThrow(/không được phép/i);
    expect(called).toBe(0);
    // Export dùng để khóa danh sách — thêm header nào phải sửa test này ý thức.
    expect([...LLM_FETCH_ALLOWED_HEADERS].sort()).toEqual(['accept', 'authorization', 'content-type']);
  });
});

describe('llmFetch — response', () => {
  it('trả đủ {ok,status,headers,bodyText} và lọc header trả về', async () => {
    const res = await llmFetch(basePayload, {
      fetch: async () =>
        fakeResponse('{"data":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'set-cookie': 'secret=1' },
        }),
    });
    expect(res).toMatchObject({ ok: true, status: 200, bodyText: '{"data":[]}' });
    expect(res.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('response vượt 10MB bị cắt + truncated: true', async () => {
    const huge = 'a'.repeat(LIMITS.LLM_FETCH_MAX_RESPONSE_CHARS + 100);
    const res = await llmFetch(basePayload, {
      fetch: async () => fakeResponse(huge),
    });
    expect(res.truncated).toBe(true);
    expect(res.bodyText.length).toBe(LIMITS.LLM_FETCH_MAX_RESPONSE_CHARS);
  });

  it('ok=false cho HTTP lỗi nhưng KHÔNG ném — caller tự đọc status/bodyText', async () => {
    const res = await llmFetch(basePayload, {
      fetch: async () => fakeResponse('{"error":"rate limited"}', { status: 429, headers: { 'retry-after': '30' } }),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('30');
  });
});

describe('llmFetch — timeout & lỗi mạng', () => {
  it('timeout abort → lỗi tiếng Việt có số giây', async () => {
    await expect(
      llmFetch({ ...basePayload, timeoutMs: 1000 }, {
        fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
          // Giả gateway treo: chỉ resolve khi bị abort signal hủy.
          return new Promise((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
          }) as never;
        },
      }),
    ).rejects.toThrow(/1s/);
  }, 10_000);

  it('lỗi mạng (không phải timeout) → lỗi "Không gọi được gateway"', async () => {
    await expect(
      llmFetch(basePayload, {
        fetch: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toThrow(/Không gọi được gateway.*ECONNREFUSED/);
  });

  it('fetch không khả dụng → lỗi rõ (môi trường lạ)', async () => {
    // Giả môi trường không có fetch: gỡ globalThis.fetch trong phạm vi test
    // rồi trả lại — llmFetch phải chặn trước khi thử gọi.
    const savedFetch = globalThis.fetch;
    // @ts-expect-error -- cố ý xóa để mô phỏng môi trường lạ.
    delete globalThis.fetch;
    try {
      await expect(llmFetch(basePayload)).rejects.toThrow(/fetch không khả dụng/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
