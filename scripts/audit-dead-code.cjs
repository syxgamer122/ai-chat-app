#!/usr/bin/env node
/**
 * Phân tích khả năng tiếp cận (reachability) để tìm code chết.
 *
 * Khác với "đếm in-degree", script này duyệt đồ thị từ ENTRY POINT THẬT
 * (app/, bin/, scripts/) rồi lan theo import/require/re-export. Nhờ đó phân
 * biệt được ba loại:
 *
 *   1. SỐNG      — đi tới được từ app/ (hoặc bin/, scripts/)
 *   2. CHỈ-TEST  — không đi tới được từ app/ nhưng test có import
 *                  → tính năng đã bị gỡ khỏi sản phẩm, chỉ còn test canh
 *   3. MỒ CÔI    — không ai import (kể cả test)
 *
 * Công cụ chẩn đoán, không tự xoá gì.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIRS = ['app', 'components', 'lib', 'bin', 'scripts', 'tests'];
const EXTS = ['.ts', '.tsx', '.cjs', '.mjs', '.js'];
const SKIP = new Set(['node_modules', '.next', '.git', '.vyen', 'temp-test-profile', 'public']);

/** Entry point thật: Next.js app router + CLI + script vận hành. */
const APP_ROOTS = ['app', 'bin', 'scripts'];

/**
 * Route API KHÔNG được cây UI thật gọi thì không phải entry point — nếu tính nó
 * là gốc thì toàn bộ cây dependency của một tính năng đã gỡ vẫn bị coi là "sống".
 *
 * "Cây UI thật" = app/ TRỪ app/api (page/layout/route khác) + bin/ + scripts/,
 * lan theo import. Nhờ vậy một hook mồ côi (lib/use-orchestrator.ts) không thể
 * giữ cho route của nó sống được — đúng với thực tế: không ai render hook đó.
 */
function unreferencedApiRoutes() {
  const uiRoots = APP_ROOTS
    .flatMap((d) => walk(path.join(ROOT, d)))
    .filter((f) => !rel(f).startsWith('app/api/'));
  const liveFromUi = reachableFrom(uiRoots);

  const routes = walk(path.join(ROOT, 'app', 'api')).filter((f) => /[\\/]route\.tsx?$/.test(f));
  const dead = new Set();
  for (const f of routes) {
    const urlPath = '/' + rel(f).replace(/^app\//, '').replace(/\/route\.tsx?$/, '');
    const needles = [`'${urlPath}`, `"${urlPath}`, '`' + urlPath];
    let referenced = false;
    for (const other of allFiles) {
      if (other === f || rel(other).startsWith('app/api/')) continue;
      if (!liveFromUi.has(other)) continue;
      const code = fs.readFileSync(other, 'utf8');
      if (needles.some((n) => code.includes(n))) { referenced = true; break; }
    }
    if (!referenced) dead.add(f);
  }
  return dead;
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (EXTS.includes(path.extname(e.name))) out.push(full);
  }
  return out;
}

const allFiles = SRC_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function specifiers(code) {
  const out = [];
  const patterns = [
    /\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(code)) !== null) out.push(m[1]);
  }
  return out;
}

function resolveSpec(fromFile, spec) {
  let base;
  if (spec.startsWith('@/')) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  const cands = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, 'index' + e))];
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* thử tiếp */ }
  }
  return null;
}

/* Nạp một lần: bản đồ file -> danh sách file nó trỏ tới. */
const edges = new Map();
for (const f of allFiles) {
  const code = fs.readFileSync(f, 'utf8');
  const targets = new Set();
  for (const spec of specifiers(code)) {
    const t = resolveSpec(f, spec);
    if (t && t !== f && allFiles.includes(t)) targets.add(t);
  }
  edges.set(f, [...targets]);
}

/** Duyệt BFS từ một tập gốc. */
function reachableFrom(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const cur = queue.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of edges.get(cur) ?? []) if (!seen.has(next)) queue.push(next);
  }
  return seen;
}

const appRootFiles = APP_ROOTS.flatMap((d) => walk(path.join(ROOT, d)));
const deadRoutes = unreferencedApiRoutes();
const liveFromApp = reachableFrom(appRootFiles.filter((f) => !deadRoutes.has(f)));

const testRootFiles = walk(path.join(ROOT, 'tests'));
const liveFromTests = reachableFrom(testRootFiles);

const testOnly = [];
const orphans = [];

for (const f of allFiles) {
  const r = rel(f);
  if (r.startsWith('tests/')) continue;
  if (appRootFiles.includes(f)) continue;
  if (liveFromApp.has(f)) continue;
  if (liveFromTests.has(f)) testOnly.push(r);
  else orphans.push(r);
}

function report(title, list) {
  console.log(`\n=== ${title} (${list.length}) ===`);
  if (list.length === 0) { console.log('  (không có)'); return; }
  for (const f of list.sort()) console.log('  ' + f);
}

report('A. CHỈ-TEST — tính năng đã gỡ khỏi sản phẩm, chỉ còn test canh', testOnly);
report('B. MỒ CÔI — không ai import', orphans);
report('C. ROUTE API KHÔNG CLIENT NÀO GỌI', [...deadRoutes].map(rel));

console.log(`\n=== TỔNG ===`);
console.log(`  ${allFiles.length} file nguồn | ${liveFromApp.size} tiếp cận từ app/ | ` +
  `${testOnly.length} chỉ-test | ${orphans.length} mồ côi | ${deadRoutes.size} route chết`);
