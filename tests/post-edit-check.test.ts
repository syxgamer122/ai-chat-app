/**
 * Tests cho post-edit-check: detect allow-list / throttle 60s / merge result.
 * Module thuần — chạy node, không mock IPC.
 */
import { describe, it, expect } from 'vitest';
import {
  acquirePostEditSlot,
  attachPostEditCheck,
  detectPostEditCommands,
  emptyPostEditThrottle,
  POST_EDIT_CHECK_OUTPUT_CHARS,
  POST_EDIT_MAX_COMMANDS,
} from '../lib/post-edit-check';

describe('detectPostEditCommands', () => {
  it('chọn typecheck trước lint, tối đa 2 lệnh', () => {
    const out = detectPostEditCommands({
      scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'next build', test: 'vitest' },
    });
    expect(out.map((c) => c.name)).toEqual(['typecheck', 'lint']);
    expect(out[0].command).toBe('npm run typecheck --silent');
  });

  it('không có script khớp → rỗng; build/test không bao giờ được chọn', () => {
    expect(detectPostEditCommands({ scripts: { build: 'next build', dev: 'next dev' } })).toEqual([]);
    expect(detectPostEditCommands({ scripts: { test: 'vitest' } })).toEqual([]);
  });

  it('allow-list khớp CHÍNH XÁC tên — lint:fix / eslint-config không tính', () => {
    expect(detectPostEditCommands({ scripts: { 'lint:fix': 'eslint . --fix' } })).toEqual([]);
    expect(detectPostEditCommands({ scripts: { eslint_config: 'x' } })).toEqual([]);
    expect(detectPostEditCommands({ scripts: { lint: 'eslint .' } })).toHaveLength(1);
  });

  it('pkgJson thiếu/hỏng → rỗng, không ném', () => {
    expect(detectPostEditCommands(undefined)).toEqual([]);
    expect(detectPostEditCommands(null)).toEqual([]);
    expect(detectPostEditCommands({})).toEqual([]);
    expect(detectPostEditCommands({ scripts: 'not-an-object' })).toEqual([]);
    expect(detectPostEditCommands({ scripts: { lint: 42 } })).toEqual([]);
  });

  it('trần POST_EDIT_MAX_COMMANDS dù có nhiều script khớp', () => {
    const out = detectPostEditCommands({
      scripts: { typecheck: 'tsc', tsc: 'tsc2', lint: 'eslint', eslint: 'eslint2', check: 'check' },
    });
    expect(out).toHaveLength(POST_EDIT_MAX_COMMANDS);
  });
});

describe('acquirePostEditSlot', () => {
  it('chiếm slot lần đầu, chặn trong 60s, mở lại đúng mốc', () => {
    const state = emptyPostEditThrottle();
    const t0 = 1_000_000;
    expect(acquirePostEditSlot(state, 'chat-a', t0)).toBe(true);
    expect(acquirePostEditSlot(state, 'chat-a', t0 + 59_999)).toBe(false);
    expect(acquirePostEditSlot(state, 'chat-a', t0 + 60_000)).toBe(true);
  });

  it('độc lập giữa các hội thoại', () => {
    const state = emptyPostEditThrottle();
    const t0 = 1_000_000;
    expect(acquirePostEditSlot(state, 'chat-a', t0)).toBe(true);
    expect(acquirePostEditSlot(state, 'chat-b', t0)).toBe(true);
  });

  it('conversationKey rỗng không bao giờ chạy', () => {
    const state = emptyPostEditThrottle();
    expect(acquirePostEditSlot(state, '', 1_000_000)).toBe(false);
  });
});

describe('attachPostEditCheck', () => {
  it('gắn postEditCheck, giữ nguyên mọi field có sẵn', () => {
    const base = JSON.stringify({ applied: true, blocks: 2, strategies: ['exact'] });
    const out = JSON.parse(
      attachPostEditCheck(base, [{ command: 'npm run typecheck --silent', exitCode: 2, ok: false, output: 'error TS2322' }]),
    ) as Record<string, unknown>;
    expect(out.applied).toBe(true);
    expect(out.blocks).toBe(2);
    const checks = out.postEditCheck as Array<{ command: string; ok: boolean; output: string }>;
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(false);
    expect(checks[0].output).toContain('TS2322');
  });

  it('output cắt ở trần POST_EDIT_CHECK_OUTPUT_CHARS', () => {
    const out = JSON.parse(
      attachPostEditCheck('{"applied": true}', [
        { command: 'npm run lint --silent', exitCode: 0, ok: true, output: 'x'.repeat(5000) },
      ]),
    ) as { postEditCheck: Array<{ output: string }> };
    expect(out.postEditCheck[0].output.length).toBe(POST_EDIT_CHECK_OUTPUT_CHARS + 6); // + '…[cắt]'
    expect(out.postEditCheck[0].output.endsWith('…[cắt]')).toBe(true);
  });

  it('outcomes rỗng → result nguyên văn; JSON hỏng → result nguyên văn', () => {
    expect(attachPostEditCheck('{"applied": true}', [])).toBe('{"applied": true}');
    expect(attachPostEditCheck('không phải json', [
      { command: 'x', exitCode: 0, ok: true, output: '' },
    ])).toBe('không phải json');
  });
});
