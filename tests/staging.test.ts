/**
 * Staging Diff Sandbox — module thuần.
 * Port mô hình Plandex (MIT): thay đổi tích lũy trong overlay, đĩa được bảo
 * vệ cho tới khi user Apply. Reject = xóa overlay, đĩa chưa bao giờ bị đụng.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeStagingPath,
  stageFile,
  unstageFile,
  clearStaging,
  stagingCount,
  stagingStats,
  stagedFileDiff,
  serializeStaging,
  parseStaging,
  emptyStagingStore,
  STAGING_KV_KEY,
} from '@/lib/staging';

describe('normalizeStagingPath', () => {
  it('strip ./ và trailing slash, lowercase — khớp readFilesRef', () => {
    expect(normalizeStagingPath('./SRC/App.tsx/')).toBe('src/app.tsx');
    expect(normalizeStagingPath('src/app.tsx')).toBe('src/app.tsx');
  });
});

describe('stageFile', () => {
  it('stage file mới: original = null', () => {
    const store = stageFile(emptyStagingStore(), 'new.ts', null, 'hello');
    expect(stagingCount(store)).toBe(1);
    expect(store['new.ts']).toMatchObject({ original: null, content: 'hello' });
  });

  it('stage lần 2+ GIỮ original của lần đầu (diff so với đĩa gốc)', () => {
    let store = stageFile(emptyStagingStore(), 'a.ts', 'v1', 'v2');
    store = stageFile(store, 'a.ts', 'v2', 'v3'); // đĩa thực ra vẫn là v1
    expect(store['a.ts'].original).toBe('v1');
    expect(store['a.ts'].content).toBe('v3');
  });

  it('path khác hoa thường/th_prefix stage vào CÙNG một record', () => {
    let store = stageFile(emptyStagingStore(), 'Src/A.ts', 'v1', 'v2');
    store = stageFile(store, './src/a.ts', 'v1', 'v3');
    expect(stagingCount(store)).toBe(1);
    expect(store['src/a.ts'].content).toBe('v3');
  });
});

describe('unstageFile / clearStaging', () => {
  it('reject từng file — record biến mất, file khác còn', () => {
    let store = stageFile(emptyStagingStore(), 'a.ts', 'x', 'y');
    store = stageFile(store, 'b.ts', null, 'z');
    store = unstageFile(store, 'A.TS');
    expect(stagingCount(store)).toBe(1);
    expect(store['b.ts']).toBeDefined();
  });

  it('reject file chưa staged → store nguyên vẹn (idempotent)', () => {
    const store = stageFile(emptyStagingStore(), 'a.ts', 'x', 'y');
    expect(unstageFile(store, 'nope.ts')).toBe(store);
  });

  it('clearStaging trả store rỗng (đĩa chưa bao giờ bị đụng — không cần restore)', () => {
    let store = stageFile(emptyStagingStore(), 'a.ts', 'x', 'y');
    store = clearStaging(store);
    expect(stagingCount(store)).toBe(0);
  });
});

describe('stagingStats', () => {
  it('đếm ± dòng và số file mới', () => {
    let store = stageFile(emptyStagingStore(), 'a.ts', 'line1\nline2\nline3', 'line1\nline2x\nline3\nline4');
    store = stageFile(store, 'new.ts', null, 'only');
    const stats = stagingStats(store);
    expect(stats.files).toBe(2);
    expect(stats.newFiles).toBe(1);
    expect(stats.addedLines).toBeGreaterThan(0);
    expect(stats.removedLines).toBeGreaterThan(0);
  });

  it('file mới tính toàn bộ dòng là add', () => {
    const store = stageFile(emptyStagingStore(), 'new.ts', null, 'a\nb\nc');
    const diff = stagedFileDiff(store['new.ts']);
    expect(diff.every((l) => l.type === 'add')).toBe(true);
  });
});

describe('serialize / parse', () => {
  it('round-trip giữ nguyên dữ kiện', () => {
    let store = stageFile(emptyStagingStore(), 'a.ts', 'old', 'new content');
    store = stageFile(store, 'new.ts', null, 'brand new');
    const parsed = parseStaging(serializeStaging(store));
    expect(parsed['a.ts']).toMatchObject({ original: 'old', content: 'new content' });
    expect(parsed['new.ts']).toMatchObject({ original: null, content: 'brand new' });
  });

  it('input rác → store rỗng, không ném', () => {
    expect(parseStaging(undefined)).toEqual({});
    expect(parseStaging(42)).toEqual({});
    expect(parseStaging('không phải json')).toEqual({});
    expect(parseStaging('{"object":true}')).toEqual({});
  });

  it('bỏ file sai shape thay vì sập cả batch', () => {
    const raw = JSON.stringify([
      { path: 'ok.ts', original: 'o', content: 'c', stagedAt: 1 },
      { path: '', content: 'no path' },
      { content: 'no path key' },
      { path: 'no-content.ts', original: 'o' },
    ]);
    const parsed = parseStaging(raw);
    expect(Object.keys(parsed)).toEqual(['ok.ts']);
  });

  it('trần 50 file — dư bị bỏ', () => {
    let store = emptyStagingStore();
    for (let i = 0; i < 60; i++) {
      store = stageFile(store, `f${i}.ts`, null, 'x');
    }
    const parsed = parseStaging(serializeStaging(store));
    expect(Object.keys(parsed).length).toBeLessThanOrEqual(50);
  });
});

describe('STAGING_KV_KEY', () => {
  it('key ổn định — đổi key làm mất staging của user đang dùng', () => {
    expect(STAGING_KV_KEY).toBe('staging:current');
  });
});
