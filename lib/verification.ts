/**
 * Verification Receipts — lưu vết và xác thực bằng chứng thực tế từ môi trường.
 *
 * Một biên nhận kiểm chứng (VerificationReceipt) chỉ hợp lệ và có thể tái sử dụng
 * khi cả 3 yếu tố: revision (git/staging digest), command (lệnh test), và envFingerprint (môi trường)
 * KHỚP HOÀN TOÀN. Lệch bất kỳ trường nào thì biên nhận bị vô hiệu và bắt buộc phải kiểm chứng lại.
 */

export interface VerificationReceipt {
  revision: string; // git commit hash (HEAD) hoặc digest SHA-256 của staging overlay
  command: string; // lệnh đã thực thi, vd: "npm test -- tests/foo.test.ts"
  envFingerprint: string; // mã băm môi trường (node version + OS + lockfile hash)
  exitCode: number; // 0 = pass, non-zero = fail
  stdoutTail: string; // 20-50 dòng cuối của stdout/stderr
  observedAt: string; // ISO timestamp thời điểm quan sát
}

/**
 * Tạo dấu vân tay môi trường (envFingerprint) từ thông tin hệ thống.
 */
export function computeEnvFingerprint(opts?: {
  nodeVersion?: string;
  platform?: string;
  lockfileHash?: string;
}): string {
  const nodeVer = opts?.nodeVersion || (typeof process !== 'undefined' ? process.version : 'node-env');
  const platform = opts?.platform || (typeof process !== 'undefined' ? process.platform : 'browser');
  const lockfile = opts?.lockfileHash || 'default-lock-hash';
  return `${platform}::${nodeVer}::${lockfile}`;
}

/**
 * Kiểm tra xem một VerificationReceipt có thể được tái sử dụng hay không.
 * Điều kiện tái sử dụng: revision + command + envFingerprint PHẢI TRÙNG KHỚP CẢ BA.
 */
export function isReusable(
  r: VerificationReceipt | null | undefined,
  now: {
    revision: string;
    command: string;
    envFingerprint: string;
  },
): boolean {
  if (!r) return false;
  if (r.exitCode !== 0) return false; // Không tái dùng kết quả fail
  return (
    r.revision === now.revision &&
    r.command === now.command &&
    r.envFingerprint === now.envFingerprint
  );
}

/**
 * Cắt ngắn output shell để chỉ lưu phần đuôi quan trọng (chứa summary/lỗi).
 */
export function captureStdoutTail(stdout: string, maxLines = 50, maxChars = 8000): string {
  if (!stdout) return '';
  const lines = stdout.split(/\r?\n/);
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length > maxChars ? tail.slice(-maxChars) : tail;
}
