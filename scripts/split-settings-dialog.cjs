#!/usr/bin/env node
/**
 * Tách `components/settings-dialog.tsx` (1.668 dòng) thành các file theo section.
 *
 * Vì sao: đây là god component của màn hình Settings — 5 section con + component
 * chính nằm chung một file, sửa một chỗ phải cuộn qua 1.600 dòng.
 *
 * Script bóc NGUYÊN VĂN từng section sang `components/settings/<tên>.tsx`, thay
 * vị trí cũ bằng import. Phần import của file mới để trống — typecheck sẽ chỉ ra
 * chính xác cần gì, an toàn hơn là đoán.
 *
 * Chạy một lần.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'components', 'settings-dialog.tsx');
const OUT_DIR = path.join(ROOT, 'components', 'settings');

let src = fs.readFileSync(SRC, 'utf8');
const usesCrlf = src.includes('\r\n');
if (usesCrlf) src = src.replace(/\r\n/g, '\n');

/** Cắt đoạn từ `startMarker` tới `endMarker` (không gồm endMarker). */
function cut(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error(`Không thấy mốc đầu: ${startMarker}`);
  const b = src.indexOf(endMarker, a + startMarker.length);
  if (b < 0) throw new Error(`Không thấy mốc cuối: ${endMarker}`);
  const body = src.slice(a, b);
  src = src.slice(0, a) + src.slice(b);
  return body.replace(/\s+$/, '') + '\n';
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const HEADER = (title, note) =>
  `'use client';\n\n/**\n * ${title}\n *\n * ${note}\n *\n * (Tách ra từ components/settings-dialog.tsx — file đó từng dài 1.668 dòng.)\n */\n\n`;

const JOBS = [
  {
    file: 'memories-section.tsx',
    title: 'Settings → Ghi nhớ: reviewer gate',
    note: 'Duyệt / từ chối / hoãn các đề xuất ghi nhớ do agent tạo.',
    body: () => cut('function MemoriesSection()', 'function VisionModelSection()'),
  },
  {
    file: 'vision-model-section.tsx',
    title: 'Settings → Model đọc ảnh (Vision)',
    note: 'Chọn model mô tả ảnh cho workspace và kết quả MCP.',
    body: () => cut('function VisionModelSection()', 'function CustomSlashCommandsSection()'),
  },
  {
    file: 'slash-commands-section.tsx',
    title: 'Settings → Lệnh gõ nhanh (Slash commands)',
    note: 'Ánh xạ /<tên> tuỳ biến sang recipe.',
    body: () => cut('function CustomSlashCommandsSection()', 'function AutoBackupSection()'),
  },
  {
    file: 'auto-backup-section.tsx',
    title: 'Settings → Tự động sao lưu',
    note: 'Chu kỳ sao lưu và thư mục đích (File System Access API).',
    body: () => cut('function AutoBackupSection()', 'export function SettingsDialog('),
  },
];

const written = [];
for (const job of JOBS) {
  const body = job.body();
  const out = HEADER(job.title, job.note) + body;
  fs.writeFileSync(path.join(OUT_DIR, job.file), usesCrlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');
  written.push(`${job.file} (${body.split('\n').length} dòng)`);
}

fs.writeFileSync(SRC, usesCrlf ? src.replace(/\n/g, '\r\n') : src, 'utf8');

console.log('Đã tách:');
for (const w of written) console.log('  components/settings/' + w);
console.log(`\nsettings-dialog.tsx còn ${src.split('\n').length} dòng.`);
