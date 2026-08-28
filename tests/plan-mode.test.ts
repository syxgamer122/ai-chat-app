/**
 * Plan/Act mode + normalizePathKey tests.
 */

import { describe, expect, it } from 'vitest';
import { isAgentMode } from '@/lib/store';
import { normalizePathKey } from '@/lib/path-utils';

describe('isAgentMode', () => {
  it('chấp nhận plan và act', () => {
    expect(isAgentMode('plan')).toBe(true);
    expect(isAgentMode('act')).toBe(true);
  });

  it('từ chối giá trị khác', () => {
    expect(isAgentMode('')).toBe(false);
    expect(isAgentMode(undefined)).toBe(false);
    expect(isAgentMode(null)).toBe(false);
    expect(isAgentMode('PLAN')).toBe(false);
    expect(isAgentMode(42)).toBe(false);
  });
});

describe('normalizePathKey — single source of truth cho path normalization', () => {
  it('strip ./ và trailing slash, lowercase', () => {
    expect(normalizePathKey('./src/app.ts')).toBe('src/app.ts');
    expect(normalizePathKey('src/app.ts/')).toBe('src/app.ts');
    expect(normalizePathKey('./src/app.ts/')).toBe('src/app.ts');
  });

  it('lowercase', () => {
    expect(normalizePathKey('SRC/App.TS')).toBe('src/app.ts');
  });

  it('giữ nguyên path sạch', () => {
    expect(normalizePathKey('src/app.ts')).toBe('src/app.ts');
  });
});
