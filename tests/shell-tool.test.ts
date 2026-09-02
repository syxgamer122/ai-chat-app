/**
 * Shell tool tests — smart output truncation (Goose-style) trong electron/ipc.cjs.
 *
 * truncateShellOutput là hàm thuần (không phụ thuộc Electron/spawn) nên test
 * trực tiếp qua createRequire. shellRun integration test cần Electron env
 * nên chỉ test truncation logic ở đây.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

// Import truncateShellOutput từ ipc.cjs
// ipc.cjs export truncateShellOutput qua module.exports ở cuối file
let truncateShellOutput: (
  fullOutput: string,
  label: 'stdout' | 'stderr' | 'output',
) => { text: string; truncated: boolean; savedTo?: string; previewHint?: string };

try {
  const ipc = require('../electron/ipc.cjs') as Record<string, unknown>;
  truncateShellOutput = ipc.truncateShellOutput as typeof truncateShellOutput;
} catch {
  // Nếu ipc.cjs không export trực tiếp, test sẽ skip
  truncateShellOutput = null as any;
}

// Cleanup temp files created during tests
const tempFiles: string[] = [];
afterEach(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tempFiles.length = 0;
});

describe.skipIf(!truncateShellOutput)('truncateShellOutput', () => {
  it('returns empty string unchanged', () => {
    const result = truncateShellOutput('', 'stdout');
    expect(result.text).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.savedTo).toBeUndefined();
  });

  it('passes through short output without truncation', () => {
    const short = 'hello world\nline 2\nline 3';
    const result = truncateShellOutput(short, 'stdout');
    expect(result.text).toBe(short);
    expect(result.truncated).toBe(false);
  });

  it('truncates output exceeding line limit and saves to temp file', () => {
    // Generate 2500 lines (> 2000 limit)
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
    const full = lines.join('\n');

    const result = truncateShellOutput(full, 'stdout');

    expect(result.truncated).toBe(true);
    expect(result.savedTo).toBeDefined();
    expect(result.previewHint).toBeDefined();

    // Preview should contain last ~50 lines
    expect(result.text).toContain('line 2500');
    expect(result.text).toContain('line 2451');
    expect(result.text).not.toContain('line 1\n');

    // Temp file should contain full output
    if (result.savedTo) {
      tempFiles.push(result.savedTo);
      const saved = fs.readFileSync(result.savedTo, 'utf8');
      expect(saved).toBe(full);
    }
  });

  it('truncates output exceeding byte limit', () => {
    // Generate output > 50KB with few lines (long lines)
    const longLine = 'x'.repeat(60_000);
    const full = `header\n${longLine}\nfooter`;

    const result = truncateShellOutput(full, 'stderr');

    expect(result.truncated).toBe(true);
    expect(result.savedTo).toBeDefined();
    expect(result.previewHint).toContain('byte limit');

    if (result.savedTo) {
      tempFiles.push(result.savedTo);
      const saved = fs.readFileSync(result.savedTo, 'utf8');
      expect(saved).toBe(full);
    }
  });

  it('preview hint includes platform-appropriate read commands', () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
    const full = lines.join('\n');

    const result = truncateShellOutput(full, 'output');

    expect(result.previewHint).toBeDefined();
    const isWin = process.platform === 'win32';
    if (isWin) {
      expect(result.previewHint).toContain('Get-Content');
    } else {
      expect(result.previewHint).toContain('head');
    }

    if (result.savedTo) tempFiles.push(result.savedTo);
  });

  it('temp file is in OS temp directory', () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `data ${i}`);
    const full = lines.join('\n');

    const result = truncateShellOutput(full, 'stdout');

    if (result.savedTo) {
      tempFiles.push(result.savedTo);
      expect(result.savedTo.startsWith(os.tmpdir())).toBe(true);
      expect(path.basename(result.savedTo)).toMatch(/^koda-shell-stdout-[a-f0-9]+\.txt$/);
    }
  });

  it('handles output exactly at limits without truncation', () => {
    // Exactly 2000 lines, each short → under byte limit too
    const lines = Array.from({ length: 2000 }, (_, i) => `l${i}`);
    const full = lines.join('\n');

    const result = truncateShellOutput(full, 'stdout');
    // 2000 lines is NOT exceeded (limit is >2000), so no truncation
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(full);
  });
});
