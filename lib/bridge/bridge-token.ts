/**
 * Bridge token — chìa khoá 256-bit cho /api/bridge (khử lỗ hổng RCE cục bộ).
 *
 * Vấn đề: guard duy nhất `isLocalRequest` (server-bridge.ts) chỉ soi header
 * host/origin/referer + sec-fetch-site. curl hoặc script chạy ngay trên máy
 * KHÔNG gửi Origin nên lọt thẳng; trang localhost ở cổng khác (same-site)
 * cũng lọt — mà /api/bridge mở toang fs-write/fs-delete/shell-run/git/llm-fetch.
 *
 * Cơ chế: token sinh cho MỖI phiên server.
 * - Desktop launcher sinh token, truyền vào server con qua env
 *   VYEN_BRIDGE_TOKEN, rồi gắn fragment `#bt=<token>` vào URL mở browser.
 * - Renderer tách fragment ra sessionStorage (không nằm trong URL/history)
 *   và gắn header `x-vyen-bridge-token` cho mọi call bridge.
 * - Server không có env token (npm run dev) sinh ephemeral in-memory VÀ ghi
 *   best-effort ra file `<userDataDir>/vyen-bridge-token` (mode 0600) để
 *   launcher reconnect đọc lại được.
 *
 * THREAT MODEL (ghi nhận chủ ý — defense-in-depth, không phải biên giới tuyệt đối):
 * - CHẶN được: curl/script local "mù" (không biết token), trang localhost cổng
 *   khác cùng máy (same-site nhưng không đọc được fragment của app khác),
 *   CSRF/recon từ trang web lạ (cross-site đã bị isLocalRequest chặn, giờ còn
 *   thiếu token), brute-force (256-bit + rate-limit ở route).
 * - KHÔNG chặn được: tiến trình khác cùng user — nó đọc được command line/env
 *   của tiến trình server hoặc thẳng file token trong userDataDir.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { timingSafeEqual } from '@/lib/security';

export const BRIDGE_TOKEN_HEADER = 'x-vyen-bridge-token';

const TOKEN_FILENAME = 'vyen-bridge-token';

let activeToken: string | null = null;

/**
 * Tính userDataDir cho token file — logic mirror `getBridgeUserDataDir`
 * (lib/bridge/server-bridge.ts). Không import thẳng để tránh vòng
 * server-bridge → bridge-token → server-bridge; đổi một chỗ thì sửa cả hai.
 */
function resolveBridgeUserDataDir(): string {
  const custom = process.env.VYEN_USER_DATA_DIR;
  if (custom && fs.existsSync(custom)) return custom;

  const baseDir =
    process.platform === 'win32'
      ? process.env.APPDATA || os.homedir()
      : path.join(os.homedir(), '.config');

  const target = path.join(baseDir, 'ai-chat');
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    return os.tmpdir();
  }
  return target;
}

function writeTokenFileBestEffort(token: string): void {
  try {
    const dir = resolveBridgeUserDataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, TOKEN_FILENAME), token, { mode: 0o600 });
  } catch {
    // Best-effort: mất file chỉ khiến launcher reconnect không gắn được
    // token; bridge vẫn hoạt động trong phiên qua token in-memory.
  }
}

/**
 * Nạp (hoặc sinh) token của phiên server này. Idempotent: gọi nhiều lần
 * luôn trả cùng một token.
 */
export function ensureBridgeToken(): string {
  if (activeToken) return activeToken;

  // Launcher truyền token qua env — dùng nguyên vẹn, không ghi ra file
  // (env là kênh riêng launcher→con, file chỉ dành cho luồng fallback).
  const fromEnv = process.env.VYEN_BRIDGE_TOKEN?.trim();
  if (fromEnv) {
    activeToken = fromEnv;
    return activeToken;
  }

  activeToken = crypto.randomBytes(32).toString('base64url');
  writeTokenFileBestEffort(activeToken);
  return activeToken;
}

/** Token đang hoạt động (không tự sinh) — cho diagnose/test. */
export function getActiveBridgeToken(): string | null {
  return activeToken;
}

/**
 * So token trong header request với token của phiên. Timing-safe kể cả khi
 * hai chuỗi khác độ dài (timingSafeEqual đã xử lý chênh lệch length).
 */
export function verifyBridgeToken(req: Request): boolean {
  const expected = activeToken ?? ensureBridgeToken();
  const provided = req.headers.get(BRIDGE_TOKEN_HEADER)?.trim() ?? '';
  if (!provided) return false;
  return timingSafeEqual(provided, expected);
}

/** Chỉ dùng bởi test: xoá trạng thái module để giả lập một phiên server mới. */
export function resetBridgeTokenForTests(): void {
  activeToken = null;
}
