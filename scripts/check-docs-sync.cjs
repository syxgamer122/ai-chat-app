#!/usr/bin/env node
/**
 * Cổng kiểm tra TÀI LIỆU ↔ CODEBASE (`npm run docs:check`).
 *
 * Vì sao cần: docs Vyen từng trôi khỏi code — `npm run app:fast` được doc nhắc
 * nhưng không có trong `package.json`; `/api/diag`, `/api/orchestrate` và
 * `components/orchestrator/` đã gỡ nhưng README vẫn quảng cáo.
 *
 * Hai lớp tài liệu:
 *  - CONTRACT_DOCS (hiện trạng): mọi đường dẫn file và biến môi trường nêu ra
 *    phải tồn tại / phải được code đọc, mọi `npm run <x>` phải có thật.
 *  - RECORD_DOCS (bản ghi lịch sử, kế hoạch, báo cáo thi công): được phép nhắc
 *    file đã bị gỡ, nhưng KHÔNG được nhắc lệnh `npm run` không tồn tại.
 *
 * Thoát mã 1 khi có vi phạm ⇒ dùng được trong CI.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const CONTRACT_DOCS = [
  'README.md',
  'DESIGN.md',
  'DOCS_TSX_ARCHITECTURE.md',
  'TEST_INFRA.md',
  'docs/DESKTOP_ARCHITECTURE.md',
  'docs/DESKTOP-CHOICE.md',
  'docs/harness-port-handoff.md',
  'AGENTS.md',
  'PROJECT.md',
];

const RECORD_DOCS = [
  'CRITIQUE_RECONCILIATION.md',
  'ORIGINAL_REQUEST.md',
  'TEST_READY.md',
  'docs/MCP_INTEGRATION_DESIGN.md',
  'docs/UI_REDESIGN_PLAN_V2.md',
  'docs/UI_REDESIGN_REPORT.md',
  'docs/UI_SETTINGS_REFACTOR_PLAN.md',
  'docs/agent-memory-port-report.md',
];

const DOCS = [...CONTRACT_DOCS, ...RECORD_DOCS];
const CODE_EXT = /\.(ts|tsx|cjs|mjs|js|json)$/;

const ENV_READ_RE = /[a-zA-Z]+\s*\.\s*env\s*(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g;

const PATH_RE = /`([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:ts|tsx|cjs|mjs|js|json|md|ya?ml))`/g;
/** Route API được nhắc trong docs phải có `app/api/<đoạn>/route.ts` thật. */
const ROUTE_RE = /`?\/api\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)`?/g;
const CMD_RE = /npm run ([A-Za-z0-9:_-]+)/g;
const ENV_RE = /`([A-Z][A-Z0-9]*_[A-Z0-9_]+)`/g;

const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
const trackedSet = new Set(tracked);
const scripts = Object.keys(require(path.join(ROOT, 'package.json')).scripts);
const codeText = tracked
  .filter((p) => CODE_EXT.test(p) && !p.startsWith('package-lock'))
  .map((p) => fs.readFileSync(path.join(ROOT, p), 'utf8'))
  .join('\n');

/** `foo/bar.ts` khớp khi tồn tại đúng đường dẫn, hoặc khớp hậu tố đường dẫn. */
function pathExists(token) {
  if (trackedSet.has(token)) return true;
  const suffix = '/' + token;
  return tracked.some((p) => p.endsWith(suffix));
}

/** Biến môi trường mà code thật sự đọc — nguồn để đối chiếu bảng env trong docs. */
function envNamesRead() {
  const names = new Set();
  for (const m of codeText.matchAll(ENV_READ_RE)) names.add(m[1] || m[2]);
  return [...names].sort();
}

if (process.argv.includes('--list-env')) {
  console.log(envNamesRead().join('\n'));
  process.exit(0);
}

const problems = [];
const skipPath = (t) => t.startsWith('node_modules/') || t.includes('*') || t.startsWith('/');

for (const doc of DOCS) {
  if (!fs.existsSync(path.join(ROOT, doc))) {
    problems.push([doc, 0, 'doc', 'file tài liệu không tồn tại']);
    continue;
  }
  const contract = CONTRACT_DOCS.includes(doc);
  fs.readFileSync(path.join(ROOT, doc), 'utf8').split('\n').forEach((line, i) => {
    const at = i + 1;
    /* Dòng có `docs-check:ignore` được miễn kiểm tra đường dẫn/env — dùng cho câu khẳng định
       phủ định kiểu "không có `tauri.conf.json`" trong doc hiện trạng. */
    if (line.includes('docs-check:ignore')) return;
    for (const m of line.matchAll(CMD_RE)) {
      if (!scripts.includes(m[1])) problems.push([doc, at, 'lệnh', `npm run ${m[1]}`]);
    }
    if (contract) {
      for (const m of line.matchAll(PATH_RE)) {
        if (skipPath(m[1])) continue;
        if (!pathExists(m[1])) problems.push([doc, at, 'đường dẫn', m[1]]);
      }
      for (const m of line.matchAll(ROUTE_RE)) {
        /* Bỏ qua khi `/api/...` là phần đuôi của URL ngoài (`https://host/api/v1`)
           hay của đường dẫn file (`app/api/bridge/route.ts`). */
        if (/[A-Za-z0-9_.\/-]$/.test(line.slice(0, m.index))) continue;
        const route = `app/api/${m[1]}/route.ts`;
        if (!trackedSet.has(route)) problems.push([doc, at, 'route API', `/api/${m[1]}`]);
      }
      for (const m of line.matchAll(ENV_RE)) {
        if (!codeText.includes(m[1])) problems.push([doc, at, 'biến môi trường', m[1]]);
      }
    }
  });
}

if (problems.length === 0) {
  console.log(`docs:check OK — ${DOCS.length} tài liệu, 0 lệch (${tracked.length} file theo dõi).`);
  process.exit(0);
}

console.error(`docs:check FAIL — ${problems.length} điểm lệch:\n`);
for (const [doc, line, kind, token] of problems) {
  console.error(`  ${doc}:${line}  [${kind}]  ${token}`);
}
console.error('\nSửa code cho khớp docs, hoặc sửa docs cho khớp code — đừng bỏ qua.');
process.exit(1);
