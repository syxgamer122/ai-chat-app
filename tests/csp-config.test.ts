import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

/**
 * A8-CSP regression guard (CRITIQUE_RECONCILIATION §A8/F):
 * next.config.js PHẢI phát hành Content-Security-Policy cho mọi route.
 * Không hard-code giá trị policy ở đây — chỉ chốt rằng header tồn tại và
 * chứa các directive nền, để không ai xoá nhầm khi refactor config.
 */
const require = createRequire(import.meta.url);
/* module.exports = { nextConfig: {...} } — bọc lại để lấy config phẳng. */
const _raw = require('../next.config.js') as Record<string, unknown>;
const config = (_raw.nextConfig ?? _raw) as Record<string, unknown>;

interface HeaderGroup {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

function cspHeaderOf(): string | undefined {
  const headersFn = config.headers as (() => HeaderGroup[]) | undefined;
  expect(headersFn, 'next.config.js phải định nghĩa headers()').toBeTypeOf('function');
  return headersFn!().flatMap((g) => g.headers).find((h) => h.key === 'Content-Security-Policy')?.value;
}

describe('A8-CSP — next.config.js', () => {
  it('phát hành Content-Security-Policy cho mọi route (/:path*)', () => {
    const headersFn = config.headers as () => HeaderGroup[];
    expect(headersFn().some((g) => g.source === '/:path*')).toBe(true);
    expect(cspHeaderOf()).toBeDefined();
  });

  it('policy chứa các directive nền chống XSS', () => {
    const csp = cspHeaderOf()!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    // style-src cho phép inline (KaTeX) nhưng vẫn phải có 'self'.
    expect(csp).toContain("style-src 'self'");
  });

  it('kèm X-Content-Type-Options: nosniff', () => {
    const headersFn = config.headers as () => HeaderGroup[];
    const all = headersFn().flatMap((g) => g.headers);
    expect(all.find((h) => h.key === 'X-Content-Type-Options')?.value).toBe('nosniff');
  });
});
