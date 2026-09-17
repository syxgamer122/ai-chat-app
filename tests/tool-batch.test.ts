import { describe, expect, it } from 'vitest';
import { executeToolBatch, getToolExecutionMode } from '@/lib/tool-batch';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function item(id: string, name: string, delayMs = 100) {
  return { id, name, args: { delayMs } };
}

async function delayedEcho(args: unknown): Promise<unknown> {
  const ms = Number((args as { delayMs?: number })?.delayMs ?? 100);
  await sleep(ms);
  return { slept: ms };
}

describe('getToolExecutionMode — phân loại chế độ queue', () => {
  it('tool đọc chạy parallel', () => {
    for (const name of ['fs_read', 'fs_list', 'fs_search', 'git_status', 'git_diff', 'git_log', 'web_search', 'web_fetch', 'weather', 'exchange_rates', 'memory_search', 'mcp__server__tool']) {
      expect(getToolExecutionMode(name)).toBe('parallel');
    }
  });

  it('tool ghi/side-effect chạy sequential', () => {
    for (const name of ['fs_edit', 'fs_write', 'shell_run', 'git_add', 'git_commit', 'delegate', 'plan_create', 'plan_update', 'bg_run', 'bg_stop']) {
      expect(getToolExecutionMode(name)).toBe('sequential');
    }
  });
});

describe('executeToolBatch — parallel (P2.1)', () => {
  it('5 fs_read × 100ms → tổng < 250ms (song song thật)', async () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`c${i}`, 'fs_read'));
    const started = Date.now();
    const outcomes = await executeToolBatch(items, { execute: (it) => delayedEcho(it.args) });
    expect(Date.now() - started).toBeLessThan(250);
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });

  it('toolResult giữ đúng thứ tự source dù delay ngẫu nhiên (×20)', async () => {
    for (let iter = 0; iter < 20; iter++) {
      const items = Array.from({ length: 5 }, (_, i) =>
        item(`c${i}`, 'fs_read', 20 + Math.floor(Math.random() * 80)),
      );
      const outcomes = await executeToolBatch(items, {
        execute: async (it) => {
          const ms = Number((it.args as { delayMs?: number })?.delayMs ?? 0);
          await sleep(ms);
          return { id: it.id, ms };
        },
      });
      expect(outcomes.map((o) => o.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    }
  });

  it('onStart bắn tuần tự theo source; onSettled bắn khi từng tool xong', async () => {
    const items = [item('a', 'web_search', 60), item('b', 'weather', 10), item('c', 'web_fetch', 30)];
    const starts: string[] = [];
    const settled: string[] = [];
    const outcomes = await executeToolBatch(items, {
      execute: (it) => delayedEcho(it.args),
      onStart: (it) => starts.push(it.id),
      onSettled: (it) => settled.push(it.id),
    });
    expect(starts).toEqual(['a', 'b', 'c']);
    // Tool nhanh nhất (b) settle trước tool chậm (a).
    expect(settled[0]).toBe('b');
    expect(outcomes.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('lỗi một tool không làm hỏng cả batch', async () => {
    const items = [item('ok1', 'fs_read', 10), item('bad', 'web_search', 10), item('ok2', 'weather', 10)];
    const outcomes = await executeToolBatch(items, {
      execute: async (it) => {
        await sleep(10);
        if (it.id === 'bad') throw new Error('upstream sập');
        return { fine: true };
      },
    });
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    expect(outcomes[1].result).toEqual({ note: 'upstream sập' });
  });
});

describe('executeToolBatch — sequential barrier', () => {
  it('có 1 fs_write trong batch → cả batch chạy tuần tự', async () => {
    const items = [item('r1', 'fs_read', 60), item('w', 'fs_write', 20), item('r2', 'fs_read', 10)];
    const settled: string[] = [];
    const started = Date.now();
    const outcomes = await executeToolBatch(items, {
      execute: (it) => delayedEcho(it.args),
      onSettled: (it) => settled.push(it.id),
    });
    // Tuần tự: 60+20+10 = 90ms trở lên; settle đúng thứ tự source.
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(settled).toEqual(['r1', 'w', 'r2']);
    expect(outcomes.map((o) => o.id)).toEqual(['r1', 'w', 'r2']);
  });
});
