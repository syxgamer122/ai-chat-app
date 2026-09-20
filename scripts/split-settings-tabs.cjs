#!/usr/bin/env node
/**
 * Tách metadata tab + search index của Settings ra `components/settings/settings-tabs.ts`.
 *
 * Lý do: `SETTINGS_TABS` + `SETTINGS_SEARCH_ITEMS` + `resolveSettingsTab` là DỮ LIỆU,
 * không phải giao diện — để chung file với component 1.000 dòng khiến ai muốn thêm
 * một mục cấu hình phải cuộn qua toàn bộ phần render.
 *
 * Chạy một lần.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'components', 'settings-dialog.tsx');
const OUT = path.join(ROOT, 'components', 'settings', 'settings-tabs.ts');

let src = fs.readFileSync(SRC, 'utf8');
const crlf = src.includes('\r\n');
if (crlf) src = src.replace(/\r\n/g, '\n');

const START = "export type SettingsTab = 'appearance'";
const END = 'const FOCUSABLE_SELECTOR =';
const a = src.indexOf(START);
const b = src.indexOf(END, a);
if (a < 0 || b < 0) throw new Error('Không xác định được khối metadata tab.');

const block = src.slice(a, b).replace(/\s+$/, '');
src = src.slice(0, a) + src.slice(b);

const header = `/**
 * Metadata điều hướng của màn hình Cài đặt: danh mục tab, chỉ mục tìm kiếm và
 * hàm suy ra tab từ một khoá bất kỳ.
 *
 * Tách khỏi \`components/settings-dialog.tsx\` (component render) vì đây là DỮ LIỆU:
 * thêm một mục cấu hình chỉ nên phải sửa file này, không phải cuộn qua phần render.
 */

import { Brain, Database, Layers, Server, Shield, Sliders } from 'lucide-react';

`;

fs.writeFileSync(OUT, header + block + '\n', 'utf8');
fs.writeFileSync(SRC, crlf ? src.replace(/\n/g, '\r\n') : src, 'utf8');

console.log(`Đã tạo components/settings/settings-tabs.ts (${block.split('\n').length} dòng)`);
console.log(`settings-dialog.tsx còn ${src.split('\n').length} dòng.`);
