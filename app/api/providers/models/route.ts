import { validateProviderBaseUrl, normalizeProviderModels } from '@/lib/provider-url';
import { checkSameOrigin, verifyAccessAuth } from '@/lib/security';

export const runtime = 'nodejs';

/**
 * POST { baseUrl, apiKey } → fetch `${baseUrl}/models` phía server
 * (client không gọi thẳng: né CORS + chặn Origin của một số gateway).
 * Đồng thời đóng vai trò "test kết nối" cho provider preset.
 */
export async function POST(req: Request) {
  if (!checkSameOrigin(req as any)) {
    return Response.json({ error: 'Origin không được phép.' }, { status: 403 });
  }
  const auth = verifyAccessAuth(req as any);
  if (!auth.ok) {
    return Response.json({ error: auth.error ?? 'Unauthorized' }, { status: auth.status ?? 401 });
  }

  let body: { baseUrl?: unknown; apiKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Body không hợp lệ.' }, { status: 400 });
  }

  const check = validateProviderBaseUrl(String(body.baseUrl ?? ''));
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: 400 });
  }

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim().slice(0, 256) : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${check.url}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      return Response.json(
        {
          error: `Nhà cung cấp trả ${res.status}. ${res.status === 403 ? 'Có thể chặn request server — thử lại.' : 'Kiểm tra địa chỉ / key.'}`,
        },
        { status: 502 },
      );
    }
    const models = normalizeProviderModels(await res.json());
    // crax có alias `qwen-video` (tạo video ~5s qua chat SSE) không được liệt kê
    // trong /v1/models — tiêm sẵn để user chọn được trong model selector.
    let host = '';
    try {
      host = new URL(check.url).hostname.toLowerCase();
    } catch {
      host = '';
    }
    if (/(^|\.)crax\.lol$/.test(host) && !models.some((m) => m.id === 'qwen-video')) {
      models.push({ id: 'qwen-video', name: 'Qwen Video (5s)' });
      models.sort((a, b) => a.id.localeCompare(b.id));
    }
    return Response.json({ models, fetchedAt: Date.now() });
  } catch {
    return Response.json(
      { error: 'Không kết nối được nhà cung cấp (timeout hoặc địa chỉ sai).' },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
