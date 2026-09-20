#!/usr/bin/env node
/**
 * Codemod: hex thô → token ngữ nghĩa (DESIGN.md mục 6.3).
 *
 * Vì sao cần: vòng sửa trước đã "token hoá" bằng cách dịch `bg-zinc-900` thành
 * `bg-[#212730]` — tức chỉ đổi tên gọi sang mã hex. Màu đúng nhưng KHÔNG có lớp
 * ngữ nghĩa, nên không thể tạo tầng bậc (mọi viền cùng một mã) và không thể đổi
 * hệ thống về sau.
 *
 * Codemod này làm hai việc:
 *   1. Đổi hex → class token (`bg-panel-bg`, `border-border-hairline`...).
 *   2. Gán VAI TRÒ cho viền: đường phân cách một cạnh (border-t/b/l/r) là
 *      `border-subtle` (mờ đi), viền khung là `border-hairline`, viền trên nền
 *      sâu (ô nhập) là `border-control` (nổi lên).
 *
 * Chạy: node scripts/codemod-tokens.cjs [--dry]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');
const TARGET_DIRS = ['components', 'app'];
const SKIP = new Set(['node_modules', '.next', '.git']);

/** Bảng ánh xạ màu nền / chữ — 1:1, an toàn. */
const COLOR_MAP = [
  // Nền
  ['bg-[#0d1116]', 'bg-bg-deep'],
  ['bg-[#161d27]', 'bg-surface-raised'],
  ['bg-[#212730]', 'bg-panel-bg'],
  ['bg-[#252f3d]', 'bg-panel-soft'],
  ['bg-[#1c2128]', 'bg-surface-code'],
  // Chữ
  ['text-[#ebe7e4]', 'text-text-primary'],
  ['text-[#9fa4ab]', 'text-text-muted'],
  ['text-[#6a9fcc]', 'text-accent-steel'],
  /*
   * Cố ý KHÔNG map `text-[#757d89]`: token tương ứng là --border-hover, vốn
   * mang nghĩa "viền khi hover". Dùng nó cho màu chữ là lệch ngữ nghĩa, mà hex
   * này vẫn thuộc bảng màu nên để nguyên vẫn hợp lệ.
   */
  ['text-[#5db87a]', 'text-status-success'],
  ['text-[#e8993a]', 'text-status-warning'],
  ['text-[#e8704f]', 'text-status-error'],
];

/** Viền — gán theo VAI TRÒ, thứ tự quan trọng (cụ thể trước, chung sau). */
function mapBorders(code) {
  // 1. Đường phân cách MỘT CẠNH → subtle (mờ đi để không tranh chấp với khung).
  code = code.replace(/\bborder-(t|b|l|r)-\[#495059\]/g, 'border-$1-border-subtle');

  // 2. Viền accent / hover / trạng thái.
  code = code.replace(/\bborder-\[#6a9fcc\]/g, 'border-accent-steel');
  code = code.replace(/\bborder-\[#757d89\]/g, 'border-border-hover');
  code = code.replace(/\bborder-\[#e8704f\]/g, 'border-status-error');
  code = code.replace(/\bborder-\[#e8993a\]/g, 'border-status-warning');
  code = code.replace(/\bborder-\[#5db87a\]/g, 'border-status-success');

  // 3. Còn lại: viền KHUNG bao ngoài.
  code = code.replace(/\bborder-\[#495059\]/g, 'border-border-hairline');

  return code;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(full);
  }
  return out;
}

const files = TARGET_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const report = [];

for (const file of files) {
  const original = fs.readFileSync(file, 'utf8');
  let code = original;

  for (const [from, to] of COLOR_MAP) {
    code = code.split(from).join(to);
  }
  code = mapBorders(code);

  /*
   * Ô nhập dùng nền sâu nhất (bg-bg-deep). Sau khi đổi màu, ô nào vừa có nền
   * sâu vừa mang viền khung thì nâng viền lên bậc CONTROL để mắt thấy được đó
   * là chỗ bấm được, tách khỏi khung tĩnh xung quanh.
   */
  code = code.replace(
    /(className="[^"]*bg-bg-deep[^"]*?)border-border-hairline/g,
    '$1border-border-control',
  );

  if (code !== original) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const before = (original.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length;
    const after = (code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length;
    report.push({ rel, before, after });
    if (!DRY) fs.writeFileSync(file, code, 'utf8');
  }
}

report.sort((a, b) => b.before - a.before);
console.log(DRY ? '=== DRY RUN — không ghi file ===' : '=== ĐÃ GHI ===');
console.log('| File | hex trước | hex sau | giảm |');
console.log('|---|---|---|---|');
let tb = 0;
let ta = 0;
for (const r of report) {
  tb += r.before;
  ta += r.after;
  console.log(`| ${r.rel} | ${r.before} | ${r.after} | −${r.before - r.after} |`);
}
console.log(`\n${report.length} file đổi | hex ${tb} → ${ta} (giảm ${tb - ta})`);
