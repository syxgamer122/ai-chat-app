/**
 * Engine điều phối + pool đồng thời — test bằng dependency giả, không chạm mạng.
 */

import { describe, expect, it } from 'vitest';
import { orchestrate, type OrchestratorDeps, type OrchestratorEvent } from '@/lib/orchestrator/engine';
import { delay, runPool, withTimeout } from '@/lib/orchestrator/scheduler';

function baseDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    plan: async () => ({
      goal: 'Mục tiêu test',
      axes: [
        { name: 'góc', values: ['a', 'b'] },
        { name: 'sâu', values: ['ngắn', 'dài'] },
      ],
      subtasks: [],
      criteria: ['đúng trọng tâm'],
    }),
    run: async (ctx) => ({ output: `kết quả ${ctx.cell.key}` }),
    judge: async (_goal, _criteria, output) => (output.endsWith('dài') ? 0.9 : 0.4),
    synthesize: async (_goal, candidates) => `TỔNG HỢP(${candidates.length})`,
    ...overrides,
  };
}

function collect(events: OrchestratorEvent[]) {
  return {
    types: events.map((e) => e.type),
    phases: events.filter((e): e is Extract<OrchestratorEvent, { type: 'phase' }> => e.type === 'phase').map((e) => e.phase),
    errors: events.filter((e): e is Extract<OrchestratorEvent, { type: 'error' }> => e.type === 'error').map((e) => e.message),
  };
}

describe('orchestrate — đường vui', () => {
  it('plan → 4 ô → chấm → xếp hạng → tổng hợp', async () => {
    const events: OrchestratorEvent[] = [];
    const result = await orchestrate('Mục tiêu', undefined, { ...baseDeps(), onEvent: (e) => events.push(e) });

    expect(result.grid.cells).toHaveLength(4);
    expect(result.records).toHaveLength(4);
    expect(result.stats.ok).toBe(4);
    expect(result.answer).toBe('TỔNG HỢP(3)'); // SYNTHESIS_TOP_K = 3
    expect(result.aborted).toBe(false);

    const { types } = collect(events);
    expect(types).toContain('plan');
    expect(types).toContain('rank');
    expect(types).toContain('answer');
    expect(types).toContain('done');
  });

  it('ồn định thứ tự record theo cellIndex dù worker xong lệch thứ tự', async () => {
    const result = await orchestrate('Mục tiêu', undefined, {
      ...baseDeps({
        run: async (ctx) => {
          // Ô đầu chậm nhất — xong CUỐI cùng (120ms để ổn định dưới tải CPU cao).
          await delay(ctx.cell.index === 0 ? 120 : 0);
          return { output: `kết quả ${ctx.cell.index}` };
        },
      }),
      concurrency: 4,
    });

    /* Bất biến THẬT SỰ ở đây không phải "đứng yên theo cellIndex" — engine trả
       về bản ĐÃ XẾP HẠNG (điểm cao nhất trước) để panel vẽ luôn, nên thứ tự
       index không được bảo toàn. Điều phải đúng là: hoàn thành lệch thứ tự
       không làm mất/nhầm record nào, và ô chậm bị đẩy xuống cuối. */
    expect(result.records.map((r) => r.cellIndex).slice().sort()).toEqual([0, 1, 2, 3]);
    // Ô 0 chậm nhất → tốc độ kém nhất → không thể đứng đầu khi chất lượng bằng nhau.
    expect(result.records.at(-1)?.cellIndex).toBe(0);
    expect(result.records.at(-1)?.speed).toBe(0);
  });

  it('sinh đúng heatmap 2 trục và group-by cho mỗi trục', async () => {
    const result = await orchestrate('Mục tiêu', undefined, baseDeps());
    expect(result.heatmap).not.toBeNull();
    expect(result.heatmap?.xAxis).toBe('sâu');
    expect(result.heatmap?.yAxis).toBe('góc');
    expect(result.groups.map((g) => g.axis)).toEqual(['góc', 'sâu']);
    expect(result.groups[0].groups).toHaveLength(2);
  });

  it('không gọi synthesize khi chỉ có một ứng viên', async () => {
    let calls = 0;
    const result = await orchestrate('Mục tiêu', undefined, {
      plan: async () => ({ goal: 'x', axes: [{ name: 'a', values: ['1'] }], subtasks: [], criteria: [] }),
      run: async () => ({ output: 'duy nhất' }),
      synthesize: async () => {
        calls += 1;
        return 'không dùng';
      },
    });
    expect(calls).toBe(0);
    expect(result.answer).toBe('duy nhất');
  });
});

describe('orchestrate — đường hỏng', () => {
  it('planner hỏng vẫn chạy với lưới mặc định', async () => {
    const events: OrchestratorEvent[] = [];
    const result = await orchestrate('Mục tiêu', undefined, {
      ...baseDeps({ plan: async () => { throw new Error('planner chết'); } }),
      maxRuns: 4,
      onEvent: (e) => events.push(e),
    });
    expect(result.records).toHaveLength(4);
    expect(result.stats.ok).toBe(4);
    expect(collect(events).errors.some((m) => m.includes('Planner lỗi'))).toBe(true);
  });

  it('không có planner → lưới mặc định, không lỗi', async () => {
    const events: OrchestratorEvent[] = [];
    const result = await orchestrate('Mục tiêu', undefined, {
      run: async () => ({ output: 'ok' }),
      maxRuns: 6,
      onEvent: (e) => events.push(e),
    });
    expect(result.grid.cells).toHaveLength(6);
    expect(result.stats.ok).toBe(6);
    expect(collect(events).errors).toEqual([]);
  });

  it('một ô lỗi không làm chết các ô khác', async () => {
    const result = await orchestrate('Mục tiêu', undefined, {
      ...baseDeps({
        run: async (ctx) => {
          if (ctx.cell.index === 1) throw new Error('ô 1 hỏng');
          return { output: 'tốt' };
        },
      }),
    });
    expect(result.stats.ok).toBe(3);
    expect(result.stats.failed).toBe(1);
    expect(result.records.find((r) => r.cellIndex === 1)?.error).toBe('ô 1 hỏng');
    expect(result.answer).toBe('TỔNG HỢP(3)');
  });

  it('judge hỏng → chất lượng trung tính, kết quả vẫn còn', async () => {
    const result = await orchestrate('Mục tiêu', undefined, {
      ...baseDeps({ judge: async () => { throw new Error('judge chết'); } }),
    });
    expect(result.stats.ok).toBe(4);
    expect(result.records.every((r) => r.quality === null)).toBe(true);
    expect(result.answer).toContain('TỔNG HỢP');
  });

  it('mọi ô hỏng → answer rỗng kèm thông báo, không throw', async () => {
    const events: OrchestratorEvent[] = [];
    const result = await orchestrate('Mục tiêu', undefined, {
      ...baseDeps({ run: async () => { throw new Error('upstream 500'); } }),
      /* "500" được phân loại là lỗi TẠM THỜI nên sẽ bị thử lại — tắt thời gian
         chờ để test chạy tức thì (vẫn đi đủ 3 lần thử, chỉ không ngủ). */
      retry: { baseMs: 0, maxMs: 0, jitter: 0 },
      onEvent: (e) => events.push(e),
    });
    expect(result.answer).toBe('');
    expect(result.stats.ok).toBe(0);
    expect(collect(events).errors.some((m) => m.includes('Mọi cấu hình đều thất bại'))).toBe(true);
  });

  it('tổng hợp hỏng → lùi về kết quả tốt nhất', async () => {
    const events: OrchestratorEvent[] = [];
    const result = await orchestrate('Mục tiêu', undefined, {
      ...baseDeps({ synthesize: async () => { throw new Error('synth chết'); } }),
      onEvent: (e) => events.push(e),
    });
    expect(result.answer).toMatch(/^kết quả /);
    expect(collect(events).errors.some((m) => m.includes('Tổng hợp lỗi'))).toBe(true);
  });
});

describe('orchestrate — huỷ', () => {
  it('huỷ trước khi chạy → không gọi worker nào', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await orchestrate('Mục tiêu', undefined, {
      ...baseDeps({ run: async () => { calls += 1; return { output: 'x' }; } }),
      signal: controller.signal,
    });
    expect(calls).toBe(0);
    expect(result.aborted).toBe(true);
    expect(result.records).toHaveLength(0);
  });

  it('huỷ giữa chừng → giữ kết quả đã xong, ô chưa chạy bị đánh dấu aborted', async () => {
    const controller = new AbortController();
    const result = await orchestrate('Mục tiêu', undefined, {
      ...baseDeps({
        concurrency: 1,
        run: async (ctx) => {
          if (ctx.cell.index === 0) controller.abort();
          return { output: `ok ${ctx.cell.index}` };
        },
      }),
      maxRuns: 4,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.stats.ok).toBe(1);
    expect(result.stats.aborted).toBe(3);
    expect(result.answer).toBe('');
  });
});

/* ------------------------------------------------------------------ */

describe('runPool', () => {
  it('giữ thứ tự đầu ra khớp đầu vào bất kể thứ tự hoàn thành', async () => {
    const out = await runPool({
      items: [40, 0, 20, 10],
      limit: 4,
      worker: async (ms) => {
        await delay(ms);
        return ms;
      },
    });
    expect(out.map((o) => (o.ok ? o.value : null))).toEqual([40, 0, 20, 10]);
  });

  it('không vượt quá giới hạn đồng thời', async () => {
    let running = 0;
    let peak = 0;
    await runPool({
      items: Array.from({ length: 12 }, (_, i) => i),
      limit: 3,
      worker: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await delay(5);
        running -= 1;
      },
    });
    expect(peak).toBe(3);
  });

  it('lỗi được gom vào outcome, không reject cả pool', async () => {
    const out = await runPool<number, number>({
      items: [1, 2, 3],
      limit: 1,
      worker: async (n) => {
        if (n === 2) throw new Error(`hỏng ${n}`);
        return n;
      },
    });
    expect(out[0]).toEqual({ ok: true, value: 1 });
    expect(out[1]).toMatchObject({ ok: false, aborted: false, error: 'hỏng 2' });
    expect(out[2]).toEqual({ ok: true, value: 3 });
  });

  it('abort: ô chưa chạy thành aborted, ô đã chạy giữ kết quả', async () => {
    const controller = new AbortController();
    const out = await runPool<number, number>({
      items: [1, 2, 3, 4, 5],
      limit: 1,
      signal: controller.signal,
      worker: async (n) => {
        if (n === 2) controller.abort();
        await delay(2);
        return n;
      },
    });
    expect(out[0]).toEqual({ ok: true, value: 1 });
    expect(out[1]).toEqual({ ok: true, value: 2 });
    expect(out.slice(2).every((o) => !o.ok && o.aborted)).toBe(true);
  });

  it('danh sách rỗng → mảng rỗng, không treo', async () => {
    await expect(runPool({ items: [], limit: 3, worker: async () => 1 })).resolves.toEqual([]);
  });

  it('onSettled nhận đúng bộ đếm tiến độ', async () => {
    const seen: number[] = [];
    await runPool({
      items: [1, 2, 3],
      limit: 1,
      worker: async (n) => n,
      onSettled: (_o, _i, done, total) => seen.push(done / total),
    });
    expect(seen).toEqual([1 / 3, 2 / 3, 1]);
  });
});

describe('withTimeout', () => {
  it('trả kết quả khi xong trước hạn', async () => {
    await expect(withTimeout(Promise.resolve('xong'), 1_000)).resolves.toBe('xong');
  });

  it('reject khi quá hạn', async () => {
    await expect(withTimeout(delay(200).then(() => 'muộn'), 10, 'trễ quá')).rejects.toThrow('trễ quá');
  });

  it('ms <= 0 → vô hiệu hoá trần', async () => {
    await expect(withTimeout(delay(10).then(() => 'ok'), 0)).resolves.toBe('ok');
  });
});
