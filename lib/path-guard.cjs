'use strict';

/*
 * Path guard dùng chung cho mọi IPC fs/shell của Vyen desktop.
 * Thuần, không phụ thuộc Electron — unit-test được bằng vitest qua
 * createRequire (xem tests/path-guard.test.ts).
 *
 * Quy tắc bảo mật High-Assurance (Sprint S2):
 * - Chỉ đường dẫn TƯƠNG ĐỐI trong workspace; tuyệt đối/drive-letter/UNC bị cấm.
 * - Canonical realpath resolution: loại bỏ hoàn toàn symlink escape, hardlink, Unicode normalization (NFC).
 * - resolve xong phải nằm gọn trong root (chặn `..`, chặn traversal).
 * - Chặn tuyệt đối .git/** và node_modules/** cho CẢ HAI chiều đọc và ghi.
 * - Windows: so sánh case-insensitive (NTFS/ReFS), chuẩn hóa dấu phân cách.
 */

const fs = require('node:fs');
const path = require('node:path');

function isWithinRoot(rootAbs, targetAbs) {
  const r = process.platform === 'win32' ? rootAbs.toLowerCase() : rootAbs;
  const t = process.platform === 'win32' ? targetAbs.toLowerCase() : targetAbs;
  if (t === r) return true;
  const rel = path.relative(r, t);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isProtectedSystemPath(rel) {
  const p = rel.replace(/\\/g, '/').toLowerCase();
  return (
    p === '.git' ||
    p.startsWith('.git/') ||
    p.includes('/.git/') ||
    p.endsWith('/.git') ||
    p === 'node_modules' ||
    p.startsWith('node_modules/') ||
    p.includes('/node_modules/') ||
    p.endsWith('/node_modules')
  );
}

/**
 * Resolve `relPath` trong `root` và bảo đảm kết quả không thoát ra ngoài (canonical realpath jail).
 * Cho phép '' / '.' (chính là root — cần cho fs:list của workspace gốc).
 *
 * @param {string} root
 * @param {string} relPath
 * @param {boolean} [allowSystemDirs=false]
 * @returns {string} đường dẫn tuyệt đối đã xác thực
 * @throws {Error} khi relPath tuyệt đối, thoát root, hoặc truy cập thư mục hệ thống bị cấm
 */
function resolveWithin(root, relPath, allowSystemDirs = false) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('Workspace root chua duoc chon.');
  }
  if (typeof relPath !== 'string') {
    throw new Error('Duong dan phai la string.');
  }
  if (relPath.length > 1024) {
    throw new Error('Duong dan quá dài (>1024 ky tu).');
  }

  // Chuẩn hóa Unicode NFC và trim
  const clean = relPath.normalize('NFC').trim();
  const rootAbs = path.resolve(root);

  if (clean === '' || clean === '.') {
    return rootAbs;
  }

  if (path.isAbsolute(clean) || /^[a-zA-Z]:/.test(clean) || clean.startsWith('\\\\') || clean.startsWith('//')) {
    throw new Error(`Duong dan tuyệt đối bi cam trong workspace: ${clean.slice(0, 80)}`);
  }
  if (clean.includes('\0')) {
    throw new Error('Duong dan chua ky tu NUL.');
  }

  const target = path.resolve(rootAbs, clean);

  // 1. Kiểm tra lexical path
  if (!isWithinRoot(rootAbs, target)) {
    throw new Error(`Duong dan thoát khỏi workspace: ${clean.slice(0, 80)}`);
  }

  // 2. Canonical realpath jail (nếu thư mục root tồn tại trên đĩa)
  let rootReal = rootAbs;
  try {
    if (fs.existsSync(rootAbs)) {
      rootReal = fs.realpathSync(rootAbs);
    }
  } catch {}

  let targetReal = target;
  try {
    if (fs.existsSync(target)) {
      targetReal = fs.realpathSync(target);
    } else {
      // File chưa tồn tại: truy ngược tìm thư mục cha gần nhất đang tồn tại để realpath
      let cur = path.dirname(target);
      const tail = [path.basename(target)];
      while (cur && !fs.existsSync(cur) && cur !== path.dirname(cur)) {
        tail.unshift(path.basename(cur));
        cur = path.dirname(cur);
      }
      if (fs.existsSync(cur)) {
        targetReal = path.join(fs.realpathSync(cur), ...tail);
      }
    }
  } catch {}

  if (!isWithinRoot(rootReal, targetReal)) {
    throw new Error(`Duong dan thoát khỏi workspace (symlink escape): ${clean.slice(0, 80)}`);
  }

  // 3. Strict Bidirectional Denylist cho .git/** và node_modules/** (cho cả đọc và ghi)
  if (!allowSystemDirs) {
    const relNorm = path.relative(rootAbs, target);
    const relRealNorm = path.relative(rootReal, targetReal);
    if (isProtectedSystemPath(relNorm) || isProtectedSystemPath(relRealNorm)) {
      throw new Error(`Truy cập bị từ chối: "${clean.slice(0, 80)}" nằm trong thư mục hệ thống được bảo vệ (.git, node_modules) cho cả đọc và ghi.`);
    }
  }

  return target;
}

module.exports = {
  resolveWithin,
  isWithinRoot,
  isProtectedSystemPath,
};
