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

let tracked;
try {
  tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/).filter(Boolean);
} catch {
  function walkFiles(dir) {
    let res = [];
    for (const f of fs.readdirSync(dir)) {
      if (f === 'node_modules' || f === '.git' || f === '.next') continue;
      const fp = path.join(dir, f);
      const st = fs.statSync(fp);
      if (st.isDirectory()) res = res.concat(walkFiles(fp));
      else res.push(path.relative(ROOT, fp).replace(/\\/g, '/'));
    }
    return res;
  }
  tracked = walkFiles(ROOT);
}
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

// Kiểm tra đồng bộ tuyệt đối bảng mã nguồn TSX trong DOCS_TSX_ARCHITECTURE.md
const tsxDocPath = path.join(ROOT, 'DOCS_TSX_ARCHITECTURE.md');
if (fs.existsSync(tsxDocPath)) {
  const tsxDocText = fs.readFileSync(tsxDocPath, 'utf8');
  const tsxFilesActual = tracked.filter((p) => p.endsWith('.tsx')).sort();
  const tsxActualSet = new Set(tsxFilesActual);

  const tableRows = tsxDocText.split(/\r?\n/).filter((l) => /\|\s*\d+\s*\|\s*([^|]*)\|\s*`([^`]+\.tsx)`\s*\|\s*([0-9,]+)\s*\|/.test(l));

  const tableFiles = new Set();
  let tableSum = 0;

  for (const row of tableRows) {
    const m = row.match(/\|\s*\d+\s*\|\s*([^|]*)\|\s*`([^`]+\.tsx)`\s*\|\s*([0-9,]+)\s*\|/);
    if (m) {
      const file = m[2];
      const reportedLines = parseInt(m[3].replace(/,/g, ''), 10);
      tableSum += reportedLines;

      if (tableFiles.has(file)) {
        problems.push(['DOCS_TSX_ARCHITECTURE.md', 136, 'trùng lặp file bảng §3', file]);
      }
      tableFiles.add(file);

      const absFile = path.join(ROOT, file);
      if (!fs.existsSync(absFile)) {
        problems.push(['DOCS_TSX_ARCHITECTURE.md', 136, 'file không tồn tại', file]);
      } else {
        const content = fs.readFileSync(absFile, 'utf8');
        const splitLines = content.split('\n').length;
        if (reportedLines !== splitLines) {
          problems.push(['DOCS_TSX_ARCHITECTURE.md', 136, 'lệch dòng tsx', `${file}: bảng ghi ${reportedLines}, thực tế split=${splitLines}`]);
        }
      }
    }
  }

  // Đối soát tập hợp 2 chiều: bảng §3 ↔ codebase
  for (const f of tsxFilesActual) {
    if (!tableFiles.has(f)) {
      problems.push(['DOCS_TSX_ARCHITECTURE.md', 136, 'thiếu file trong bảng §3', f]);
    }
  }
  for (const f of tableFiles) {
    if (!tsxActualSet.has(f)) {
      problems.push(['DOCS_TSX_ARCHITECTURE.md', 136, 'thừa file trong bảng §3', f]);
    }
  }

  // Kiểm tra tổng dòng thực tế
  let actualWcTotal = 0;
  let actualSplitTotal = 0;
  for (const f of tsxFilesActual) {
    const c = fs.readFileSync(path.join(ROOT, f), 'utf8');
    actualWcTotal += (c.match(/\n/g) || []).length;
    actualSplitTotal += c.split('\n').length;
  }

  if (tableSum !== actualSplitTotal) {
    problems.push(['DOCS_TSX_ARCHITECTURE.md', 136, 'tổng dòng bảng §3 lệch codebase', `cột cộng ra ${tableSum}, codebase split=${actualSplitTotal}`]);
  }

  // Kiểm tra tổng dòng trong văn bản
  const totalRegex = /\*\*([0-9,]+)\s*dòng code\*\*\s*loại trừ trailing newlines,\s*tương đương\s*\*\*([0-9,]+)\s*dòng\*\*/;
  const totalMatch = tsxDocText.match(totalRegex);
  if (!totalMatch) {
    problems.push(['DOCS_TSX_ARCHITECTURE.md', 4, 'thiếu tổng dòng trong văn bản', 'Không tìm thấy mẫu định dạng tổng dòng code']);
  } else {
    const docWcTotal = parseInt(totalMatch[1].replace(/,/g, ''), 10);
    const docSplitTotal = parseInt(totalMatch[2].replace(/,/g, ''), 10);
    if (docWcTotal !== actualWcTotal) {
      problems.push(['DOCS_TSX_ARCHITECTURE.md', 4, 'tổng dòng wc -l', `doc ghi ${docWcTotal}, thực tế ${actualWcTotal}`]);
    }
    if (docSplitTotal !== actualSplitTotal) {
      problems.push(['DOCS_TSX_ARCHITECTURE.md', 4, 'tổng dòng split', `doc ghi ${docSplitTotal}, thực tế ${actualSplitTotal}`]);
    }
  }

  // Kiểm tra đồng bộ dòng của toàn bộ 58 file ở mục §4
  const sec4Start = tsxDocText.indexOf('## 4. ĐẶC TẢ CHI TIẾT');
  const sec4End = tsxDocText.indexOf('## 5. ĐỐI SOÁT');
  if (sec4Start !== -1 && sec4End !== -1) {
    const sec4Text = tsxDocText.substring(sec4Start, sec4End);
    const bulletRegex = /- \*\*`([^`]+\.tsx)`\s*\(([0-9,]+)\s*dòng[^)]*\)\*\*:/g;
    let bm;
    const sec4Files = new Set();
    while ((bm = bulletRegex.exec(sec4Text)) !== null) {
      const bFile = bm[1];
      const bLines = parseInt(bm[2].replace(/,/g, ''), 10);
      sec4Files.add(bFile);
      const absFile = path.join(ROOT, bFile);
      if (fs.existsSync(absFile)) {
        const c = fs.readFileSync(absFile, 'utf8');
        const split = c.split('\n').length;
        if (bLines !== split) {
          problems.push(['DOCS_TSX_ARCHITECTURE.md', 200, 'lệch dòng §4', `${bFile}: ghi ${bLines}, thực tế ${split}`]);
        }
      }
    }
    for (const f of tsxFilesActual) {
      if (!sec4Files.has(f)) {
        problems.push(['DOCS_TSX_ARCHITECTURE.md', 200, 'thiếu đặc tả file trong §4', f]);
      }
    }
  }

  // Kiểm tra số lượng test suite (168 tests/*.test.ts)
  const testsActual = tracked.filter((p) => p.startsWith('tests/') && p.endsWith('.test.ts'));
  const testCountRegex = /([0-9]+)\s*file\s*`tests\/\*\.test\.ts`/g;
  for (const doc of ['DOCS_TSX_ARCHITECTURE.md', 'PROJECT.md', 'TEST_INFRA.md']) {
    const docPathFull = path.join(ROOT, doc);
    if (fs.existsSync(docPathFull)) {
      const content = fs.readFileSync(docPathFull, 'utf8');
      let tm;
      while ((tm = testCountRegex.exec(content)) !== null) {
        const statedCount = parseInt(tm[1], 10);
        if (statedCount !== testsActual.length) {
          problems.push([doc, 0, 'số file test', `doc ghi ${statedCount}, thực tế ${testsActual.length}`]);
        }
      }
    }
  }
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
