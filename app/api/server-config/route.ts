import { supportsMediaGeneration, supportsThinkingLevel } from '@/lib/provider-url';
import { checkSameOrigin } from '@/lib/security';

export const runtime = 'nodejs';

/**
 * Cho client biết provider mặc định của server (env) hỗ trợ những gì —
 * chỉ trả boolean, không tiết lộ base URL hay key.
 */
export async function GET(req: Request) {
  if (!checkSameOrigin(req)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const base = process.env.OPENAI_BASE_URL;
  return Response.json(
    {
      thinkingLevel: supportsThinkingLevel(base),
      media: supportsMediaGeneration(base),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
