#!/usr/bin/env node
/**
 * Bổ sung import + export cho 4 file vừa tách khỏi settings-dialog.tsx.
 * Chạy một lần sau scripts/split-settings-dialog.cjs.
 */
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.resolve(__dirname, '..', 'components', 'settings');

const JOBS = [
  {
    file: 'memories-section.tsx',
    exportName: 'MemoriesSection',
    imports: [
      "import { useMemo, useState } from 'react';",
      "import { useLiveQuery } from 'dexie-react-hooks';",
      "import { AlertCircle, Ban, Check, Clock, Sparkles, Trash2 } from 'lucide-react';",
      "import { db, MAX_MEMORY_CHARS } from '@/lib/db';",
      "import { proposeCandidate, reviewCandidate, deleteReviewedRecord } from '@/lib/memory/store';",
      "import type { MemoryKind } from '@/lib/memory/types';",
    ],
  },
  {
    file: 'vision-model-section.tsx',
    exportName: 'VisionModelSection',
    imports: [
      "import { useAppStore, SERVER_PROVIDER_ID, isApiModelId } from '@/lib/store';",
    ],
  },
  {
    file: 'slash-commands-section.tsx',
    exportName: 'CustomSlashCommandsSection',
    imports: [
      "import { useState } from 'react';",
      "import { useLiveQuery } from 'dexie-react-hooks';",
      "import { Trash2 } from 'lucide-react';",
      "import { db, type RecipeRecord } from '@/lib/db';",
      "import { useAppStore } from '@/lib/store';",
      "import { BUILTIN_SLASH_COMMANDS } from '@/lib/slash-commands';",
    ],
  },
  {
    file: 'auto-backup-section.tsx',
    exportName: 'AutoBackupSection',
    imports: [
      "import { useEffect, useState } from 'react';",
      "import { Download, Loader2 } from 'lucide-react';",
      'import {',
      '  backupNow,',
      '  chooseBackupDirectory,',
      '  clearBackupDirectory,',
      '  getAutoBackupDirName,',
      '  getBackupIntervalDays,',
      '  isFileSystemAccessSupported,',
      '  getLastBackupAt,',
      '  setBackupIntervalDays,',
      "} from '@/lib/auto-backup';",
    ],
  },
];

for (const job of JOBS) {
  const p = path.join(DIR, job.file);
  let s = fs.readFileSync(p, 'utf8');
  const crlf = s.includes('\r\n');
  if (crlf) s = s.replace(/\r\n/g, '\n');

  // 1. Xuất component để file khác import được.
  s = s.replace(`\nfunction ${job.exportName}(`, `\nexport function ${job.exportName}(`);

  // 2. Chèn import ngay trước khai báo component.
  const marker = `export function ${job.exportName}(`;
  const idx = s.indexOf(marker);
  if (idx < 0) throw new Error(`${job.file}: không thấy ${job.exportName}`);
  s = s.slice(0, idx) + job.imports.join('\n') + '\n\n' + s.slice(idx);

  // 3. Bỏ dấu vết của đường cắt (comment phân mục cũ còn sót ở cuối file).
  s = s.replace(/\n\/\* -{5,}[^\n]*\*\/\s*$/, '\n');

  fs.writeFileSync(p, crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8');
  console.log(`  OK: components/settings/${job.file}`);
}
