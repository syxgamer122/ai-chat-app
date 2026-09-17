import { describe, it, expect } from 'vitest';
import {
  budgetForTool,
  collapseBlankRuns,
  DEFAULT_OBSERVATION_CHARS,
  elideBlobs,
  looksLikeError,
  normalizeCarriageReturns,
  sanitizeObservation,
  sanitizeToolObservation,
  savedRatio,
  stripAnsi,
  trimTrailingSpaces,
  truncateObservation,
} from '@/lib/agent-runtime/observation';

describe('agent runtime observation — stripAnsi', () => {
  it('bỏ mã màu và giữ nguyên nội dung', () => {
    const raw = '\u001B[32mPASS\u001B[0m tests/foo.test.ts (\u001B[1m12ms\u001B[0m)';
    expect(stripAnsi(raw)).toBe('PASS tests/foo.test.ts (12ms)');
  });

  it('bỏ OSC (title cửa sổ) và escape 2 ký tự', () => {
    const raw = '\u001B]0;npm install\u0007installing…\u001B7done';
    expect(stripAnsi(raw)).toBe('installing…done');
  });

  it('bỏ ký tự điều khiển nhưng giữ tab và xuống dòng', () => {
    const raw = 'a\u0000b\tc\nd\u0007e';
    expect(stripAnsi(raw)).toBe('ab\tc\nde');
  });

  it('text sạch thì không đổi (không tốn công copy)', () => {
    const clean = 'npm run test\n\n50 passed';
    expect(stripAnsi(clean)).toBe(clean);
  });
});

describe('agent runtime observation — làm sạch terminal', () => {
  it('giải \\r theo frame CUỐI như terminal thật', () => {
    const raw = 'progress 10%\rprogress 50%\rprogress 100%';
    expect(normalizeCarriageReturns(raw)).toBe('progress 100%');
  });

  it('dòng nhiều frame nhưng frame cuối rỗng → giữ frame cuối có nội dung', () => {
    expect(normalizeCarriageReturns('done 100%\r')).toBe('done 100%');
  });

  it('không có \\r thì trả nguyên văn', () => {
    const raw = 'line1\nline2';
    expect(normalizeCarriageReturns(raw)).toBe(raw);
  });

  it('gộp run dòng trống, tối đa 1 dòng trống', () => {
    expect(collapseBlankRuns('a\n\n\n\n\nb', 1)).toBe('a\n\nb');
    expect(collapseBlankRuns('a\n\n\nb', 2)).toBe('a\n\n\nb');
  });

  it('bỏ space/tab cuối dòng', () => {
    expect(trimTrailingSpaces('a   \nb\t\t\nc')).toBe('a\nb\nc');
  });

  it('lược blob base64 chỉ khi bật', () => {
    const blob = 'A'.repeat(500);
    expect(elideBlobs(blob)).toContain('500 ký tự base64 đã lược');
    const dataUri = `data:image/png;base64,${'B'.repeat(200)}`;
    expect(elideBlobs(dataUri)).toContain('[…blob base64 đã lược…]');
  });
});

describe('agent runtime observation — truncate', () => {
  it('dưới trần → không cắt', () => {
    const r = truncateObservation('ngắn gọn', { maxChars: 1000 });
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('ngắn gọn');
    expect(r.omittedChars).toBe(0);
  });

  it('head_tail giữ cả đầu và đuôi, marker ghi số ký tự đã lược', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `dòng ${i} ${'x'.repeat(20)}`);
    const text = lines.join('\n');
    const r = truncateObservation(text, { maxChars: 800 });
    expect(r.truncated).toBe(true);
    expect(r.strategy).toBe('head_tail');
    expect(r.text.startsWith('dòng 0')).toBe(true);
    expect(r.text.endsWith('x')).toBe(true);
    expect(r.text).toContain('đã lược');
    expect(r.text.length).toBeLessThanOrEqual(900);
    expect(r.omittedChars).toBeGreaterThan(3000);
  });

  it('nghiêng về đuôi khi output có lỗi → stack trace không bị mất', () => {
    const headLines = Array.from({ length: 200 }, (_, i) => `bước ${i} ${'y'.repeat(30)}`).join('\n');
    const ok = truncateObservation(`${headLines}\nKẾT THÚC OK`, { maxChars: 600 });
    const err = truncateObservation(
      `${headLines}\nTraceback (most recent call last):\n  File "a.py", line 3\nValueError: boom`,
      { maxChars: 600 },
    );
    expect(err.text).toContain('ValueError: boom');
    expect(ok.text).toContain('KẾT THÚC OK');
    // Tỉ lệ đuôi của output lỗi lớn hơn → phần đầu giữ lại ít hơn.
    const headOk = ok.text.indexOf('đã lược');
    const headErr = err.text.indexOf('đã lược');
    expect(headErr).toBeLessThan(headOk);
  });

  it('tắt errorAware → tỉ lệ 50/50 dù có lỗi', () => {
    const text = `${'z'.repeat(4000)}Traceback (most recent call last):\nValueError`;
    const a = truncateObservation(text, { maxChars: 500, errorAware: false });
    const b = truncateObservation(text, { maxChars: 500 });
    expect(a.text).not.toBe(b.text);
  });

  it("strategy 'tail' giữ phần đuôi", () => {
    const r = truncateObservation(`${'a'.repeat(3000)}\nKẾT THÚC`, { maxChars: 300, strategy: 'tail' });
    expect(r.text.endsWith('KẾT THÚC')).toBe(true);
    expect(r.text).toContain('đã lược');
  });

  it("strategy 'head' giữ phần đầu", () => {
    const r = truncateObservation(`BẮT ĐẦU\n${'a'.repeat(3000)}`, { maxChars: 300, strategy: 'head' });
    expect(r.text.startsWith('BẮT ĐẦU')).toBe(true);
  });

  it('text một dòng khổng lồ vẫn giữ đầu + đuôi (không chỉ còn marker)', () => {
    const text = `ĐẦU${'q'.repeat(30000)}CUỐI`;
    const r = truncateObservation(text, { maxChars: 500 });
    expect(r.text.startsWith('ĐẦU')).toBe(true);
    expect(r.text.endsWith('CUỐI')).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(500);
  });

  it('trần dưới sàn MIN_OBSERVATION_CHARS bị nâng lên 200', () => {
    const r = truncateObservation('a'.repeat(5000), { maxChars: 10 });
    expect(r.text.length).toBeLessThanOrEqual(200);
    expect(r.text.length).toBeGreaterThan(100);
  });

  it('looksLikeError phân biệt log lỗi và log thường', () => {
    expect(looksLikeError('FAIL src/a.test.ts')).toBe(true);
    expect(looksLikeError('src/a.ts(3,5): error TS2322')).toBe(true);
    expect(looksLikeError('✖ 3 failing')).toBe(true);
    expect(looksLikeError('All 120 tests passed in 3.2s')).toBe(false);
  });
});

describe('agent runtime observation — budget theo tool', () => {
  it('khớp tên tool chính xác', () => {
    expect(budgetForTool('shell')).toBe(16_000);
    expect(budgetForTool('fs_read')).toBe(20_000);
  });

  it('tên tool namespace dùng budget theo tiền tố', () => {
    expect(budgetForTool('mcp__github__list_prs')).toBe(10_000);
    expect(budgetForTool('fs_search_files')).toBe(12_000);
  });

  it('không khớp → trần mặc định', () => {
    expect(budgetForTool('unknown_tool')).toBe(DEFAULT_OBSERVATION_CHARS);
    expect(budgetForTool(null)).toBe(DEFAULT_OBSERVATION_CHARS);
  });

  it('cho phép override bảng budget', () => {
    expect(budgetForTool('shell', { shell: 100 })).toBe(100);
  });
});

describe('agent runtime observation — pipeline sanitize', () => {
  it('shell output nhiều màu + progress bar được gọn lại đáng kể', () => {
    const frames = Array.from({ length: 400 }, (_, i) => `\r\u001B[32m downloading ${i}%\u001B[0m`).join('');
    const raw = `\u001B[1m> vite build\u001B[0m\n${frames}\n\n\n\ndone\n`;
    const r = sanitizeObservation(raw, { maxChars: 5000 });
    expect(r.notes).toContain('ansi');
    expect(r.notes).toContain('carriage-returns');
    expect(r.notes).toContain('blank-runs');
    expect(r.text).toContain('downloading 399%');
    expect(r.text).not.toContain('\u001B');
    expect(r.omittedChars).toBeGreaterThan(0);
    expect(savedRatio(r)).toBeGreaterThan(0.5);
  });

  it('không cắt khi dưới trần và ghi rõ đã can thiệp gì', () => {
    const r = sanitizeObservation('ok  \n\n\n\nfine  ');
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('ok\n\nfine');
    expect(r.notes).toEqual(['trailing-spaces', 'blank-runs']);
    expect(r.changed).toBe(true);
  });

  it('text đã sạch → changed false, không note nào', () => {
    const r = sanitizeObservation('ok\nfine');
    expect(r.changed).toBe(false);
    expect(r.notes).toEqual([]);
    expect(savedRatio(r)).toBe(0);
  });

  it('sanitizeToolObservation áp trần riêng của tool', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i} ${'x'.repeat(10)}`).join('\n');
    const shell = sanitizeToolObservation('shell', big);
    const grep = sanitizeToolObservation('grep', big);
    expect(shell.finalChars).toBeGreaterThan(grep.finalChars);
    expect(shell.finalChars).toBeLessThanOrEqual(16_400);
    expect(grep.finalChars).toBeLessThanOrEqual(10_400);
  });

  it('elideBlobs mặc định tắt, bật thì lược', () => {
    const raw = `token: ${'A'.repeat(400)}`;
    expect(sanitizeObservation(raw, { maxChars: 5000 }).text).toContain('A'.repeat(400));
    expect(sanitizeObservation(raw, { maxChars: 5000, elideBlobs: true }).notes).toContain('blobs');
  });
});
