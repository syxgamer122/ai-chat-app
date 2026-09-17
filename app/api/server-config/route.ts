import { checkSameOrigin } from '@/lib/security';

export const runtime = 'nodejs';

/**
 * Cho client biết capability mặc định của server-side model (metadata tĩnh).
 * Tầng gateway env (OPENAI_BASE_URL) đã gỡ — client dựa vào provider active
 * của mình (supportsThinkingLevel/supportsMediaGeneration trên baseUrl BYOK).
 */
export async function GET(req: Request) {
  if (!checkSameOrigin(req)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  return Response.json(
    {
      thinkingLevel: false,
      media: false,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
