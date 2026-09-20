#!/usr/bin/env node
/**
 * Tách 6 tabpanel khỏi `components/settings-dialog.tsx` thành component riêng.
 *
 * Khảo sát trước khi làm cho thấy cấu trúc rất thuận lợi: 5/6 tab chỉ dùng
 * `settings` / `updateSettings` / `updatePerf` / `activeProviderId` — đều đọc
 * thẳng từ `useAppStore`, đúng như `MemoriesSection` và `VisionModelSection` đã
 * làm. Nên chúng nhận **0 prop**. Chỉ tab Dữ liệu có state cục bộ
 * (status/importMode/fileInputRef) — và state đó thuộc về chính nó, nên được
 * CHUYỂN HẲN vào component thay vì luồn prop ngược lên.
 *
 * Kết quả: settings-dialog.tsx từ chỗ là god component chỉ còn phần khung
 * (tab bar + search + focus trap).
 *
 * Chạy một lần.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'components', 'settings-dialog.tsx');
const OUT = path.join(ROOT, 'components', 'settings');

let src = fs.readFileSync(SRC, 'utf8');
const crlf = src.includes('\r\n');
if (crlf) src = src.replace(/\r\n/g, '\n');

/** Bỏ 10 khoảng thụt đầu dòng (16 -> 6) để khối JSX vừa thân component mới. */
const dedent = (s) =>
  s
    .split('\n')
    .map((l) => (l.startsWith('          ') ? l.slice(10) : l))
    .join('\n')
    .replace(/^\n+|\s+$/g, '');

/** Bóc nội dung JSX của tab `id`, thay bằng `<Comp />` tại chỗ. */
function extractTab(id, comp) {
  const marker = `{visited.has('${id}') && (`;
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`Không thấy tab ${id}`);

  const fragStart = src.indexOf('<>', start);
  const fragEnd = src.indexOf('</>', fragStart);
  if (fragStart < 0 || fragEnd < 0) throw new Error(`Không thấy fragment của ${id}`);

  const tail = /\n\s*\)\}/.exec(src.slice(fragEnd));
  if (!tail) throw new Error(`Không thấy điểm đóng của ${id}`);
  const closeEnd = fragEnd + tail.index + tail[0].length;

  const content = dedent(src.slice(fragStart + 2, fragEnd));
  src = src.slice(0, start) + `{visited.has('${id}') && <${comp} />}` + src.slice(closeEnd);
  return content;
}

/** Bóc một đoạn theo mốc đầu/cuối (để chuyển state sang file mới). */
function cutRange(from, to) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`Không thấy mốc: ${from}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`Không thấy mốc kết: ${to}`);
  const body = src.slice(a, b + to.length);
  src = src.slice(0, a) + src.slice(b + to.length);
  return body;
}

const TABS = [
  {
    id: 'appearance',
    comp: 'AppearanceTab',
    file: 'appearance-tab.tsx',
    title: 'Settings → tab "Giao diện & trải nghiệm"',
    note: 'Tham số model mặc định, thao tác nhập liệu, hàng đợi và hiệu năng hiển thị.',
    imports: [
      "import { useAppStore } from '@/lib/store';",
      "import { isQueueMode } from '@/lib/message-queue';",
    ],
    state: [
      'const settings = useAppStore((s) => s.settings);',
      'const updateSettings = useAppStore((s) => s.updateSettings);',
      'const updatePerf = useAppStore((s) => s.updatePerf);',
    ],
  },
  {
    id: 'providers',
    comp: 'ProvidersTab',
    file: 'providers-tab.tsx',
    title: 'Settings → tab "Model & Nhà cung cấp"',
    note: 'Quản lý provider preset, định tuyến model và model đọc ảnh.',
    imports: [
      "import dynamic from 'next/dynamic';",
      "import { useAppStore, SERVER_PROVIDER_ID } from '@/lib/store';",
      "import { SectionLoading } from '@/components/settings/section-loading';",
      "import { VisionModelSection } from '@/components/settings/vision-model-section';",
    ],
    state: [
      'const activeProviderId = useAppStore((s) => s.activeProviderId);',
      'const settings = useAppStore((s) => s.settings);',
      'const updateSettings = useAppStore((s) => s.updateSettings);',
    ],
    dynamic: [
      "const ProviderManager = dynamic(() => import('@/components/provider-manager').then((m) => m.ProviderManager), { ssr: false, loading: SectionLoading });",
      "const RoutingSettingsPanel = dynamic(() => import('@/components/routing-settings-panel').then((m) => m.RoutingSettingsPanel), { ssr: false, loading: SectionLoading });",
    ],
  },
  {
    id: 'safety',
    comp: 'SafetyTab',
    file: 'safety-tab.tsx',
    title: 'Settings → tab "Quyền & An toàn"',
    note: 'Chính sách phê duyệt, auto-pilot, code mode và bảng phân quyền từng công cụ.',
    imports: [
      "import { Zap } from 'lucide-react';",
      "import dynamic from 'next/dynamic';",
      "import { useAppStore } from '@/lib/store';",
      "import { SectionLoading } from '@/components/settings/section-loading';",
    ],
    state: [
      'const settings = useAppStore((s) => s.settings);',
      'const updateSettings = useAppStore((s) => s.updateSettings);',
    ],
    dynamic: [
      "const ToolPermissionsTable = dynamic(() => import('@/components/tool-permissions-table').then((m) => m.ToolPermissionsTable), { ssr: false, loading: SectionLoading });",
    ],
  },
  {
    id: 'extensions',
    comp: 'ExtensionsTab',
    file: 'extensions-tab.tsx',
    title: 'Settings → tab "Mở rộng"',
    note: 'Máy chủ MCP, skills trên đĩa và lệnh gõ nhanh.',
    imports: [
      "import dynamic from 'next/dynamic';",
      "import { useAppStore } from '@/lib/store';",
      "import { SectionLoading } from '@/components/settings/section-loading';",
      "import { DiskSkillsSection } from '@/components/settings-skills';",
      "import { CustomSlashCommandsSection } from '@/components/settings/slash-commands-section';",
    ],
    state: ['const settings = useAppStore((s) => s.settings);'],
    dynamic: [
      "const McpSettingsPanel = dynamic(() => import('@/components/mcp/mcp-settings-panel').then((m) => m.McpSettingsPanel), { ssr: false, loading: SectionLoading });",
    ],
  },
  {
    id: 'memory',
    comp: 'MemoryTab',
    file: 'memory-tab.tsx',
    title: 'Settings → tab "Bộ nhớ"',
    note: 'Luồng thống nhất: duyệt ứng viên → ký ức đã duyệt → bộ nhớ có cấu trúc.',
    imports: [
      "import { useAppStore } from '@/lib/store';",
      "import { MemoriesSection } from '@/components/settings/memories-section';",
      "import { AgentMemorySection } from '@/components/settings-agent-memory';",
    ],
    state: ['const settings = useAppStore((s) => s.settings);'],
  },
];

const written = [];
for (const t of TABS) {
  const content = extractTab(t.id, t.comp);
  const body = [
    ...(t.imports || []),
    '',
    ...(t.dynamic || []),
    ...(t.dynamic ? [''] : []),
    `export function ${t.comp}() {`,
    ...(t.state || []).map((s) => '  ' + s),
    '',
    '  return (',
    '    <>',
    content,
    '    </>',
    '  );',
    '}',
  ].join('\n');

  const head = `'use client';\n\n/**\n * ${t.title}\n *\n * ${t.note}\n *\n * (Tách ra từ components/settings-dialog.tsx.)\n *\n * Không nhận prop: tự đọc \`useAppStore\` như các section khác trong\n * components/settings/ — tránh luồn chục prop qua nhiều tầng chỉ để lấy \`settings\`.\n */\n\n`;
  const out = head + body + '\n';
  fs.writeFileSync(path.join(OUT, t.file), crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');
  written.push(`${t.file} (${out.split('\n').length} dòng)`);
}

/* ----- Tab Dữ liệu: mang theo CẢ state cục bộ của nó ----- */
const dataContent = extractTab('data', 'DataTab');
const dataState = cutRange(
  'const [importMode, setImportMode] = useState<ImportMode>(\'merge\');',
  'const fileInputRef = useRef<HTMLInputElement>(null);',
);
const dataHandlers = cutRange(
  'const runBackupTask = async (label: string, task: () => Promise<void>) => {',
  'const busy = status.kind === \'busy\';',
);

const dataBody = `'use client';

/**
 * Settings → tab "Dữ liệu & Tự động hoá"
 *
 * Sao lưu / phục hồi, tự động sao lưu định kỳ, thống kê token và vùng nguy hiểm.
 *
 * (Tách ra từ components/settings-dialog.tsx.)
 *
 * KHÁC 5 tab còn lại: tab này nhận 0 prop nhưng mang theo TOÀN BỘ state cục bộ
 * của nó (status, importMode, fileInputRef). Trước đây state đó nằm ở
 * SettingsDialog rồi luồn xuống chỉ để phục vụ duy nhất tab này.
 */

import React, { useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { db } from '@/lib/db';
import { exportJson, exportMarkdown, importBackup, type ImportMode } from '@/lib/backup';
import { Download, Loader2, ShieldAlert, Upload } from 'lucide-react';
import { SectionLoading } from '@/components/settings/section-loading';
import { AutoBackupSection } from '@/components/settings/auto-backup-section';

const UsageStats = dynamic(() => import('@/components/usage-stats').then((m) => m.UsageStats), { ssr: false, loading: SectionLoading });
const SchedulerPanel = dynamic(() => import('@/components/scheduler/scheduler-panel').then((m) => m.SchedulerPanel), { ssr: false, loading: SectionLoading });

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; message?: string };

export function DataTab() {
${dataState.split('\n').map((l) => (l ? '  ' + l : l)).join('\n')}

${dataHandlers.split('\n').map((l) => (l ? '  ' + l : l)).join('\n')}

  return (
    <>
${dataContent}
    </>
  );
}
`;
fs.writeFileSync(
  path.join(OUT, 'data-tab.tsx'),
  crlf ? dataBody.replace(/\n/g, '\r\n') : dataBody,
  'utf8',
);
written.push(`data-tab.tsx (${dataBody.split('\n').length} dòng)`);

fs.writeFileSync(SRC, crlf ? src.replace(/\n/g, '\r\n') : src, 'utf8');

console.log('Đã tách:');
for (const w of written) console.log('  components/settings/' + w);
console.log(`\nsettings-dialog.tsx còn ${src.split('\n').length} dòng.`);
