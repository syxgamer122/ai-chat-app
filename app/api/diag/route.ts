import { getAllConfiguredKeys, getKeyLabel, getKeyPoolSnapshot } from '@/lib/api-keys';
import { checkSameOrigin } from '@/lib/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = process.env.APP_ACCESS_PASSWORD?.trim() || process.env.DIAG_SECRET?.trim();
  const provided = new URL(req.url).searchParams.get('secret')?.trim();
  if (secret && provided !== secret) {
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
    origin: checkSameOrigin(req),
    pool: getKeyPoolSnapshot(),
    probes,
    env: {
      VERCEL_URL: process.env.VERCEL_URL ?? null,
      VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL ?? null,
      hasAccessPassword: Boolean(process.env.APP_ACCESS_PASSWORD),
    },
  });
}
