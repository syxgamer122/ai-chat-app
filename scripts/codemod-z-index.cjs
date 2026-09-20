#!/usr/bin/env node
/**
 * Áp dụng thang z-index tập trung (lib/ui-z.ts) vào các overlay.
 *
 * Thay `z-[NN]` cứng bằng `${Z_CLASS.<layer>}` để chỉ còn MỘT nguồn sự thật.
 * Chạy một lần rồi có thể xoá; giữ lại cũng vô hại (idempotent: file đã chuyển
 * sang Z_CLASS sẽ không khớp mẫu nữa).
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const JOBS = [
  ['components/diff-confirm.tsx', 'z-[80]', 'approval'],
  ['components/shell-confirm.tsx', 'z-[80]', 'approval'],
  ['components/staging-panel.tsx', 'z-[80]', 'approval'],
  ['components/mcp/tool-approval-dialog.tsx', 'z-[85]', 'approvalCritical'],
  ['components/tools-panel.tsx', 'z-[90]', 'navigation'],
  ['components/recipes/recipes-panel.tsx', 'z-[90]', 'navigation'],
  ['components/toast.tsx', 'z-[60]', 'toast'],
  ['components/workspace-checkpoints.tsx', 'z-[90]', 'navigation'],
  ['components/settings-dialog.tsx', 'z-[100]', 'system'],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let changed = 0;
for (const [rel, cls, layer] of JOBS) {
  const file = path.join(ROOT, rel);
  let src = fs.readFileSync(file, 'utf8');

  const re = new RegExp(`className="([^"]*?)${escapeRe(cls)}([^"]*)"`);
  if (!re.test(src)) {
    console.log(`  bỏ qua (đã chuyển hoặc không khớp): ${rel}`);
    continue;
  }
  src = src.replace(re, (_m, a, b) => 'className={`' + a + '${Z_CLASS.' + layer + '}' + b + '`}');

  if (!src.includes("from '@/lib/ui-z'")) {
    const lines = src.split('\n');
    const idx = lines.findIndex((l) => l.startsWith('import '));
    lines.splice(idx < 0 ? 0 : idx, 0, "import { Z_CLASS } from '@/lib/ui-z';");
    src = lines.join('\n');
  }

  fs.writeFileSync(file, src, 'utf8');
  changed++;
  console.log(`  OK: ${rel} -> Z_CLASS.${layer}`);
}
console.log(`\n${changed} file đã chuyển sang thang z-index tập trung.`);
