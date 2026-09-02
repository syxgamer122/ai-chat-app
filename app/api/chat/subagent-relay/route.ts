import { resolveSubagentRelay } from '@/lib/subagent-relay';

/**
 * Renderer trả kết quả thực thi tool client cho SUBAGENT đang chờ server-side
 * (xem lib/subagent-relay.ts). Endpoint chỉ resolve promise — không có tác
 * động phụ nào khác. Chỉ những call do stream đang sống đăng ký mới resolve
 * được; stream đã đóng thì 404 và relay timeout bên stream tự dọn.
 */
export async function POST(req: Request) {
  /* CSRF: trình duyệt độc hại từ site khác có thể cố POST localhost. Giá trị
     "cross-site" chỉ xuất hiện khi request thật sự chéo gốc từ browser —
     chặn; curl/test không gửi header này thì cho qua (requestId random đủ
     khó đoán, và đây là app local-first). */
  const secFetchSite = req.headers.get('sec-fetch-site');
  if (secFetchSite === 'cross-site') {
    return Response.json({ ok: false, error: 'CROSS_SITE_BLOCKED' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'INVALID_JSON' }, { status: 400 });
  }
  const { requestId, toolCallId, result } = (body ?? {}) as {
    requestId?: unknown;
    toolCallId?: unknown;
    result?: unknown;
  };
  if (typeof requestId !== 'string' || requestId.length === 0 || typeof toolCallId !== 'string') {
    return Response.json({ ok: false, error: 'INVALID_PAYLOAD' }, { status: 400 });
  }
  const resultText = typeof result === 'string' ? result : JSON.stringify(result ?? { error: 'no result' });

  const ok = resolveSubagentRelay(requestId, toolCallId, resultText);
  return Response.json({ ok }, { status: ok ? 200 : 404 });
}
