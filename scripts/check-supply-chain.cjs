/**
 * Kiểm tra supply-chain (port từ Pi `npm run check`):
 * 1. Mọi dep trực tiếp trong package.json phải pin exact (không ^ ~ >= < x).
 * 2. Dep có lifecycle script (hasInstallScript trong lock) phải nằm trong ALLOWLIST.
 *
 * Chạy: `node scripts/check-supply-chain.cjs` (được gọi từ `npm run check`).
 * Thêm dep mới có install script → review rồi mới thêm vào ALLOWLIST dưới đây.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Dep trực tiếp/transitive có lifecycle script đã REVIEW.
 * - esbuild: postinstall tải binary platform (cần cho tsx/vitest).
 * - unrs-resolver: postinstall build native binding (dep của Next/Turbopack).
 * - fsevents: chỉ chạy trên macOS (dep optional của Next/chokidar).
 */
const LIFECYCLE_SCRIPT_ALLOWLIST = new Set(['esbuild', 'unrs-resolver', 'fsevents']);

function isExact(spec) {
  const s = String(spec).trim();
  // Cho phép: "1.2.3", "=1.2.3", "npm:pkg@1.2.3", "git+https://...", "file:...", "link:...".
  if (/^(npm:|git\+|github:|file:|link:|https?:)/.test(s)) return true;
  return /^(?:=?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.test(s.replace(/^=\s*/, ''));
}

function main() {
  let failed = false;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (!isExact(spec)) {
        console.error(`[supply-chain] ${section}.${name} chưa pin exact: "${spec}"`);
        failed = true;
      }
    }
  }

  const offenders = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!entry?.hasInstallScript) continue;
    const name = key === '' ? '(root)' : key.replace(/^node_modules\//, '');
    const top = name.split('/')[0].replace(/^@/, '');
    const short = name.includes('/') ? name : top;
    if (!LIFECYCLE_SCRIPT_ALLOWLIST.has(name) && !LIFECYCLE_SCRIPT_ALLOWLIST.has(short)) {
      offenders.push(name);
    }
  }
  if (offenders.length > 0) {
    console.error('[supply-chain] dep có lifecycle script CHƯA review:', offenders.join(', '));
    failed = true;
  }

  if (failed) {
    console.error('\n[supply-chain] FAIL — xem scripts/check-supply-chain.cjs để sửa.');
    process.exit(1);
  }
  console.log('[supply-chain] OK: dep trực tiếp pin exact, lifecycle script nằm trong allowlist.');
}

main();
