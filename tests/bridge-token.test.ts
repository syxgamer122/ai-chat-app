/**
 * Tests cho lib/bridge/bridge-token.ts — chìa khoá khóa /api/bridge.
 *
 * Hermetic: set env trực tiếp + tmpdir cho userDataDir (qua
 * VYEN_USER_DATA_DIR), luôn khôi phục env và reset trạng thái module sau
 * mỗi test để không rò rỉ token/env sang file test khác trong cùng worker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ensureBridgeToken,
  getActiveBridgeToken,
  verifyBridgeToken,
  resetBridgeTokenForTests,
  BRIDGE_TOKEN_HEADER,
} from '../lib/bridge/bridge-token';

const TOKEN_FILENAME = 'vyen-bridge-token';

let scratchDir: string;
let prevEnvToken: string | undefined;
let prevEnvUserDataDir: string | undefined;

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function tokenFilePath(): string {
  return path.join(scratchDir, TOKEN_FILENAME);
}

/** Request giả lập đúng dạng route truyền vào verifyBridgeToken. */
function requestWithToken(token?: string): Request {
  return new Request('http://localhost:3000/api/bridge', {
    headers: {
      host: 'localhost:3000',
      ...(token ? { [BRIDGE_TOKEN_HEADER]: token } : {}),
    },
  });
}

beforeEach(() => {
  scratchDir = mkdtempSync(path.join(tmpdir(), 'vyen-bridge-token-'));
  prevEnvToken = process.env.VYEN_BRIDGE_TOKEN;
  prevEnvUserDataDir = process.env.VYEN_USER_DATA_DIR;
  setEnv('VYEN_BRIDGE_TOKEN', undefined);
  setEnv('VYEN_USER_DATA_DIR', scratchDir);
  resetBridgeTokenForTests();
});

afterEach(() => {
  setEnv('VYEN_BRIDGE_TOKEN', prevEnvToken);
  setEnv('VYEN_USER_DATA_DIR', prevEnvUserDataDir);
  resetBridgeTokenForTests();
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('ensureBridgeToken — nguồn token', () => {
  it('env VYEN_BRIDGE_TOKEN thắng: dùng nguyên vẹn và KHÔNG ghi file', () => {
    // Đảo điều kiện: nếu bỏ nhánh env (luôn sinh mới), token trả về sẽ khác
    // giá trị env → test này đỏ.
    const envToken = 'envtoken'.repeat(4) + 'x'.repeat(11); // 43 ký tự
    process.env.VYEN_BRIDGE_TOKEN = envToken;

    const token = ensureBridgeToken();
    expect(token).toBe(envToken);
    expect(existsSync(tokenFilePath())).toBe(false);
    expect(getActiveBridgeToken()).toBe(envToken);
  });

  it('fallback (không env): sinh 256-bit base64url 43 ký tự và ghi file cùng nội dung', () => {
    // Đảo điều kiện: nếu fallback không ghi file hoặc sinh token ngắn hơn
    // 256-bit, một trong hai expect dưới đỏ.
    const token = ensureBridgeToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(existsSync(tokenFilePath())).toBe(true);
    expect(readFileSync(tokenFilePath(), 'utf8')).toBe(token);
  });

  it('file token fallback chỉ đọc được bởi owner (mode 0600) trên filesystem hỗ trợ', () => {
    ensureBridgeToken();
    if (process.platform === 'win32') return; // ACL Windows, mode không áp dụng
    const mode = statSync(tokenFilePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('idempotent: gọi nhiều lần trong một phiên trả đúng một token', () => {
    const first = ensureBridgeToken();
    expect(ensureBridgeToken()).toBe(first);
    expect(ensureBridgeToken()).toBe(getActiveBridgeToken());
  });

  it('mỗi phiên (sau reset) sinh token khác nhau', () => {
    const first = ensureBridgeToken();
    resetBridgeTokenForTests();
    const second = ensureBridgeToken();
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });
});

describe('verifyBridgeToken — so token từ header', () => {
  it('header đúng token → true', () => {
    const token = ensureBridgeToken();
    expect(verifyBridgeToken(requestWithToken(token))).toBe(true);
  });

  it('header sai token → false', () => {
    ensureBridgeToken();
    expect(verifyBridgeToken(requestWithToken('wrong-token'.repeat(3)))).toBe(false);
  });

  it('thiếu header → false', () => {
    ensureBridgeToken();
    expect(verifyBridgeToken(requestWithToken(undefined))).toBe(false);
  });

  it('token khác độ dài (tiền tố của token thật) → false, không crash', () => {
    // Đảo điều kiện: nếu so sánh không xử lý chênh lệch độ dài an toàn,
    // expect này đỏ hoặc verify ném exception.
    const token = ensureBridgeToken();
    expect(verifyBridgeToken(requestWithToken(token.slice(0, 10)))).toBe(false);
    expect(verifyBridgeToken(requestWithToken(token + 'xx'))).toBe(false);
  });

  it('chưa ensure lần nào → verify tự sinh token phiên và từ chối token lạ', () => {
    // resetBridgeTokenForTests đã chạy ở beforeEach — trạng thái module trống.
    expect(verifyBridgeToken(requestWithToken('anything'))).toBe(false);
    // Sau verify, token đã được sinh cho phiên (không trả null cho route).
    expect(getActiveBridgeToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('env token cũng được verify như token sinh trong phiên', () => {
    const envToken = 'a'.repeat(43);
    process.env.VYEN_BRIDGE_TOKEN = envToken;
    expect(verifyBridgeToken(requestWithToken(envToken))).toBe(true);
    expect(verifyBridgeToken(requestWithToken('b'.repeat(43)))).toBe(false);
  });
});
