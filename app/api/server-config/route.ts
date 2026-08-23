import { supportsThinkingLevel } from '@/lib/provider-url';
import { checkSameOrigin } from '@/lib/security';

export const runtime = 'edge';

/**
 * Cho client biết provider mặc định của server (env) có hỗ trợ mức suy luận
 * không — chỉ trả boolean, không tiết lộ base URL hay key.
 */
export async function GET(req: Request) {
  if (!checkSameOrigin(req)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  return Response.json(
    { thinkingLevel: supportsThinkingLevel(process.env.OPENAI_BASE_URL) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
