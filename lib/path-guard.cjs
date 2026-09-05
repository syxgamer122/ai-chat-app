'use strict';

/*
 * Path guard dùng chung cho mọi IPC fs/shell của Vyen desktop.
 * Thuần, không phụ thuộc Electron — unit-test được bằng vitest qua
 * createRequire (xem tests/path-guard.test.ts).
 *
 * Quy tắc bảo mật (đối xứng với lib/fs-access.ts phía browser):
 * - Chỉ đường dẫn TƯƠNG ĐỐI trong workspace; tuyệt đối/drive-letter/UNC bị cấm.
 * - resolve xong phải vẫn nằm trong root (chặn `..`; symlink resolve ở tầng
 *   fs phía caller tự xử lý — guard này là lớp 1).
 * - Windows: so sánh case-insensitive (NTFS mặc định), chặn cả `\` thủ công.
 */

const path = require('node:path');

function isWithinRoot(rootAbs, targetAbs) {
  const r = process.platform === 'win32' ? rootAbs.toLowerCase() : rootAbs;
  const t = process.platform === 'win32' ? targetAbs.toLowerCase() : targetAbs;
  if (t === r) return true;
  const sep = process.platform === 'win32' ? '\\' : '/';
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Resolve `relPath` trong `root` và bảo đảm kết quả không thoát ra ngoài.
 * Cho phép '' / '.' (chính là root — cần cho fs:list của workspace gốc).
 * @returns {string} đường dẫn tuyệt đối
 * @throws {Error} khi relPath tuyệt đối, thoát root, hoặc vô hiệu
 */
function resolveWithin(root, relPath) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('Workspace root chua duoc chon.');
  }
  if (typeof relPath !== 'string') {
    throw new Error('Duong dan phai la string.');
  }
  if (relPath.length > 1024) {
    throw new Error('Duong dan quá dài (>1024 ky tu).');
  }
  const clean = relPath.trim();
  if (clean === '' || clean === '.') {
    return path.resolve(root);
  }
  if (path.isAbsolute(clean) || /^[a-zA-Z]:/.test(clean) || clean.startsWith('\\\\') || clean.startsWith('//')) {
    throw new Error(`Duong dan tuyệt đối bi cam trong workspace: ${clean.slice(0, 80)}`);
  }
  if (clean.includes('\0')) {
    throw new Error('Duong dan chua ky tu NUL.');
  }
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, clean);
  if (!isWithinRoot(rootAbs, target)) {
    throw new Error(`Duong dan thoát khỏi workspace: ${clean.slice(0, 80)}`);
  }
  return target;
}

module.exports = { resolveWithin, isWithinRoot };
