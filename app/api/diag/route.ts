import { getAllConfiguredKeys, getKeyLabel, getKeyPoolSnapshot } from '@/lib/api-keys';
import { timingSafeEqual } from '@/lib/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Endpoint chẩn đoán — BỊ KHÓA mặc định.
 * Mở bằng env DIAG_SECRET (hoặc APP_ACCESS_PASSWORD). Truyền secret qua
 * header `x-diag-secret` (không dùng query param để tránh lọt vào access log).
 * Ví dụ: curl -H "x-diag-secret: ..." https://.../api/diag
 */
export async function GET(req: Request) {
  const secret = process.env.DIAG_SECRET?.trim() || process.env.APP_ACCESS_PASSWORD?.trim();
  if (!secret) {
    return Response.json(
      { error: 'Endpoint chẩn đoán bị khóa. Đặt biến môi trường DIAG_SECRET để bật.' },
      { status: 403 },
    );
  }

  const provided = req.headers.get('x-diag-secret')?.trim();
  if (!provided || !timingSafeEqual(provided, secret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const baseURL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const keys = getAllConfiguredKeys();

  const probes = await Promise.all(
    keys.slice(0, 5).map(async (key) => {
      const started = Date.now();
      try {
        const res = await fetch(`${baseURL}/models`, {
          headers: {
            Authorization: `Bearer ${key}`,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            Accept: 'application/json',
          },
          cache: 'no-store',
        });
        const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
        return {
          key: getKeyLabel(key),
          status: res.status,
          ok: res.ok,
          cfRay: res.headers.get('cf-ray'),
          server: res.headers.get('server'),
          bodySnippet: body,
          ms: Date.now() - started,
        };
      } catch (e: any) {
        return { key: getKeyLabel(key), status: null, ok: false, error: String(e?.message ?? e), ms: Date.now() - started };
      }
    }),
  );

  return Response.json({
    baseURL,
    keyCount: keys.length,
    pool: getKeyPoolSnapshot(),
    probes,
    env: {
      hasAccessPassword: Boolean(process.env.APP_ACCESS_PASSWORD),
    },
  });
}
