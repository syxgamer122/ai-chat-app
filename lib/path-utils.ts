/**
 * Path normalization utility — single source of truth cho việc chuẩn hóa
 * đường dẫn tương đối dùng làm key so sánh (staging, read-before-edit...).
 *
 * TRƯỚC ĐÂY logic này lặp lại ở 6 nơi (tool-call-budget, staging, chat-interface ×4).
 * Sửa một nơi phải sửa cả sáu — giờ gộp về đây.
 *
 * LƯU Ý: Đây là normalization cho KEY SO SÁNH (lowercase, strip prefix/suffix).
 * KHÁC với normalizeRelPath() trong fs-access.ts vốn là security guard
 * (strip .., reject absolute paths) — KHÔNG được gộp hai hàm này.
 */

export function normalizePathKey(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * Kiểm tra xem một đường dẫn tương đối (ví dụ: cwd của shell_run hoặc relPath)
 * có an toàn và nằm gọn trong workspace hay không.
 * Chặn:
 * - Đường dẫn tuyệt đối (POSIX '/', Windows drive 'C:', UNC '\\')
 * - Path traversal ('..', '....', v.v.)
 * - Ký tự NUL
 * - Ký tự nguy hiểm
 */
export function validateSafeRelativePath(relPath?: string): { ok: boolean; reason?: string } {
  if (!relPath || relPath.trim() === '' || relPath.trim() === '.') {
    return { ok: true };
  }
  const clean = relPath.trim();
  if (clean.includes('\0')) {
    return { ok: false, reason: 'Đường dẫn chứa ký tự NUL.' };
  }
  if (clean.length > 1024) {
    return { ok: false, reason: 'Đường dẫn quá dài (>1024 ký tự).' };
  }
  // Windows absolute (C:, D:\...), UNC (\\server\share, //server/share), POSIX absolute (/...), Home directory (~)
  if (
    /^[a-zA-Z]:/.test(clean) ||
    clean.startsWith('\\\\') ||
    clean.startsWith('//') ||
    clean.startsWith('/') ||
    clean.startsWith('\\') ||
    clean.startsWith('~')
  ) {
    return { ok: false, reason: 'Đường dẫn tuyệt đối hoặc thoát thư mục nhà (~) bị cấm trong workspace.' };
  }
  // Environment variable expansion (%VAR%, $VAR, ${VAR})
  if (/%[^%]+%/.test(clean) || /(?:^|[\\/])\$[a-zA-Z_{]/.test(clean)) {
    return { ok: false, reason: 'Đường dẫn chứa biến môi trường có thể gây thoát workspace.' };
  }
  // Check path segments for directory traversal
  const normalized = clean.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const seg of segments) {
    const s = seg.trim();
    if (s === '' || s === '.') continue;
    if (/^\.+$/.test(s)) {
      return { ok: false, reason: 'Đường dẫn chứa ký tự thoát thư mục (..).' };
    }
  }
  return { ok: true };
}

/**
 * Kiểm tra xem đường dẫn có trỏ tới file cấu hình nhạy cảm hoặc file có khả năng auto-execute hay không:
 * - .git/** (hooks, config...)
 * - package.json (scripts auto-run trên npm install/test/build)
 * - .vscode/** (tasks.json, settings.json...)
 * - .env* (.env, .env.local, .env.production...)
 * - .vyen/** (internal rules & credentials)
 */
export function isProtectedPath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  const p = filePath.replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();

  // 1. .git/**
  if (p === '.git' || p.startsWith('.git/') || p.includes('/.git/') || p.endsWith('/.git')) return true;

  // 2. package.json (root hoặc bất kỳ sub-package.json nào)
  if (p === 'package.json' || p.endsWith('/package.json')) return true;

  // 3. .vscode/**
  if (p === '.vscode' || p.startsWith('.vscode/') || p.includes('/.vscode/') || p.endsWith('/.vscode')) return true;

  // 4. .env* (.env, .env.local, nested config/.env, v.v.)
  const baseName = p.split('/').pop() || '';
  if (baseName.startsWith('.env')) return true;

  // 5. .vyen/**
  if (p === '.vyen' || p.startsWith('.vyen/') || p.includes('/.vyen/') || p.endsWith('/.vyen')) return true;

  return false;
}
