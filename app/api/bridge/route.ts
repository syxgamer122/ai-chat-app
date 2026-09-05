import { NextResponse } from 'next/server';
import {
  invokeBridgeChannel,
  isLocalRequest,
  initServerBridge,
} from '@/lib/bridge/server-bridge';
import { verifyBridgeToken } from '@/lib/bridge/bridge-token';
import { checkRateLimit, getClientIp, rateLimitHeaders } from '@/lib/security';

export const dynamic = 'force-dynamic';

/* Bucket chỉ dành cho request SAI token. Phiên desktop agent gọi bridge dồn
   dập (fs tools, git, vision) dễ vượt 30 POST/phút — thắt cả request hợp lệ
   là tự cắt tay chân mình. Brute-force protection giữ nguyên: mọi lần đoán
   sai bị đếm, vượt 30 lần/phút thì IP đó bị khoá một phút. */
const BRIDGE_RATE_LIMIT = 30;
const BRIDGE_RATE_WINDOW_MS = 60_000;

function bridgeUnauthorized(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      code: 'BRIDGE_UNAUTHORIZED',
      error:
        'Bridge chỉ khả dụng khi chạy qua Vyen Desktop (npm run desktop). ' +
        'Chế độ dev: khởi động server với biến VYEN_BRIDGE_TOKEN rồi mở app tại /#bt=<token>.',
    },
    { status: 401 },
  );
}

/**
 * Chuỗi guard dùng chung cho GET + POST, theo thứ tự:
 * (a) isLocalRequest — giữ nguyên lớp cũ (chặn cross-site/rebinding);
 * (b) verifyBridgeToken — thiếu/sai token → 401 (không tốn bucket);
 * (c) rate-limit per-IP — CHỈ đếm request vừa sai token, chặn brute-force.
 * Request hợp lệ đi thẳng, không đếm — bridge là internal endpoint của chính
 * phiên desktop, không cần throttle nó.
 * Trả null khi request được phép đi tiếp.
 */
function guardBridgeRequest(req: Request): NextResponse | null {
  if (!isLocalRequest(req)) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden: Bridge endpoint is only accessible locally.' },
      { status: 403 },
    );
  }

  if (verifyBridgeToken(req)) {
    return null;
  }

  const rl = checkRateLimit(`bridge-auth:${getClientIp(req)}`, BRIDGE_RATE_LIMIT, BRIDGE_RATE_WINDOW_MS);
  if (!rl.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: 'BRIDGE_RATE_LIMITED',
        error: 'Quá nhiều request sai token tới bridge trong một phút — thử lại sau.',
      },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }
  return bridgeUnauthorized();
}

export async function GET(req: Request) {
  const blocked = guardBridgeRequest(req);
  if (blocked) return blocked;

  const dispatcher = initServerBridge();
  const workspaceInfo = (await dispatcher.handlers.get('vyen:workspace-get')?.(null)) as
    | { path: string | null }
    | undefined;

  // Không trả `channels` nữa: renderer đã hardcode tên kênh
  // (lib/desktop-bridge.ts) — danh sách kênh là thông tin recon không cần.
  return NextResponse.json({
    ok: true,
    status: 'ready',
    workspace: workspaceInfo?.path ?? dispatcher.workspaceRoot,
  });
}

export async function POST(req: Request) {
  const blocked = guardBridgeRequest(req);
  if (blocked) return blocked;

  let body: { channel?: string; payload?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Malformed JSON payload' },
      { status: 400 },
    );
  }

  const { channel, payload } = body;
  if (!channel || typeof channel !== 'string') {
    return NextResponse.json(
      { ok: false, error: 'Channel name must be a non-empty string' },
      { status: 400 },
    );
  }

  try {
    const result = await invokeBridgeChannel(channel, payload);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
