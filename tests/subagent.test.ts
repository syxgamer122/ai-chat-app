/**
 * Tests for Subagent Delegation system.
 *
 * Covers:
 * - System prompt generation (buildSubagentSystemPrompt)
 * - Constants validation
 * - Result type structure
 * - No recursive delegation (delegate excluded from subagent tools)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSubagentSystemPrompt,
  executeDelegate,
  SCOUT_DENIED_CLIENT_TOOLS,
  SUBAGENT_MAX_PARALLEL_TASKS,
  SUBAGENT_PARALLEL_CONCURRENCY,
  SUBAGENT_RESULT_PREVIEW_CHARS,
  SUBAGENT_DEFAULT_MAX_TURNS,
  SUBAGENT_ABSOLUTE_MAX_TURNS,
  SUBAGENT_DEFAULT_TIMEOUT_SECS,
  type SubagentResult,
  type DelegateExecuteDeps,
} from '@/lib/subagent';
import {
  consumeSubagentSpawns,
  SUBAGENT_SPAWNS_PER_BUCKET,
  resetSubagentBudgetForTests,
} from '@/lib/subagent-budget';
import { runEmulatedLoop } from '@/lib/emulated-agent';
import { buildSubagentParentBrief } from '@/lib/context-compaction';
import type { BudgetMessageLike } from '@/lib/context-budget';

// runEmulatedLoop là điểm mock duy nhất: executeDelegate/runSubagent chạy thật,
// chỉ chặn vòng lặp LLM để test fan-out/filter/brief không gọi mạng.
vi.mock('@/lib/emulated-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/emulated-agent')>();
  return { ...actual, runEmulatedLoop: vi.fn() };
});

beforeEach(() => {
  vi.mocked(runEmulatedLoop).mockReset();
});

type LoopOpts = Parameters<typeof runEmulatedLoop>[0];

/** Mock loop trả text ngay — đủ cho đường 'done' của runSubagent. */
function mockLoopText(text: string) {
  vi.mocked(runEmulatedLoop).mockImplementation(async (opts) => {
    opts.onTextDelta(text);
    return { status: 'done', roundsUsed: 1, totalCalls: 0 };
  });
}

function makeDeps(over: Partial<DelegateExecuteDeps> = {}): DelegateExecuteDeps {
  return {
    model: {} as never,
    systemBase: 'base system',
    serverTools: {} as never,
    clientToolNames: new Set(['fs_read', 'fs_write', 'fs_edit', 'shell_run']),
    ...over,
  };
}

/** Chờ điều kiện bằng polling ngắn — tránh sleep cứng dễ flaky. */
async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

describe('subagent constants', () => {
  it('default max turns is reasonable', () => {
    expect(SUBAGENT_DEFAULT_MAX_TURNS).toBe(10);
  });

  it('absolute max turns caps at 25 (Goose default)', () => {
    expect(SUBAGENT_ABSOLUTE_MAX_TURNS).toBe(25);
  });

  it('default timeout is 5 minutes', () => {
    expect(SUBAGENT_DEFAULT_TIMEOUT_SECS).toBe(300);
  });

  it('default <= absolute max', () => {
    expect(SUBAGENT_DEFAULT_MAX_TURNS).toBeLessThanOrEqual(SUBAGENT_ABSOLUTE_MAX_TURNS);
  });
});

/* ------------------------------------------------------------------ */
/* System prompt builder                                               */
/* ------------------------------------------------------------------ */

describe('buildSubagentSystemPrompt', () => {
  const baseSystem = 'You are Vyen, an AI coding assistant.';
  const instructions = 'Refactor the auth module to use JWT tokens.';

  it('includes base system prompt', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 10);
    expect(result).toContain(baseSystem);
  });

  it('includes task instructions', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 10);
    expect(result).toContain(instructions);
  });

  it('includes max turns limit', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 15);
    expect(result).toContain('15');
    expect(result).toContain('MAXIMUM');
  });

  it('explicitly forbids delegate tool (no recursion)', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 10);
    expect(result).toContain('CANNOT call `delegate`');
    expect(result).toContain('NO Delegation');
  });

  it('includes subagent role definition', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 10);
    expect(result).toContain('SPECIALIZED SUBAGENT');
    expect(result).toContain('Independence');
    expect(result).toContain('Bounded Operation');
  });

  it('includes tool efficiency rules', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 10);
    expect(result).toContain('Tool Efficiency');
    expect(result).toContain('minimum tools');
  });

  it('includes completion guidance', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 10);
    expect(result).toContain('Clear Completion');
    expect(result).toContain('summarize');
  });

  it('handles empty instructions gracefully', () => {
    const result = buildSubagentSystemPrompt(baseSystem, '', 10);
    expect(result).toContain(baseSystem);
    expect(result).toContain('SPECIALIZED SUBAGENT');
  });

  it('handles long instructions without truncation', () => {
    const longInstructions = 'A'.repeat(5000);
    const result = buildSubagentSystemPrompt(baseSystem, longInstructions, 10);
    expect(result).toContain(longInstructions);
  });
});

/* ------------------------------------------------------------------ */
/* Result type structure                                                 */
/* ------------------------------------------------------------------ */

describe('SubagentResult type', () => {
  it('done result has required fields', () => {
    const result: SubagentResult = {
      result: 'Task completed successfully.',
      turnsUsed: 3,
      toolCalls: 5,
      status: 'done',
      runId: 'run-1',
      mode: 'worker',
      startedAt: 0,
      durationMs: 100,
    };
    expect(result.status).toBe('done');
    expect(result.result).toBeTruthy();
    expect(result.turnsUsed).toBeGreaterThan(0);
  });

  it('error result includes error message', () => {
    const result: SubagentResult = {
      result: '',
      turnsUsed: 0,
      toolCalls: 0,
      status: 'error',
      runId: 'run-2',
      mode: 'worker',
      startedAt: 0,
      durationMs: 0,
      error: 'Model API timeout',
    };
    expect(result.status).toBe('error');
    expect(result.error).toBeDefined();
  });

  it('max-turns result indicates truncation', () => {
    const result: SubagentResult = {
      result: 'Partial results...',
      turnsUsed: 25,
      toolCalls: 40,
      status: 'max-turns',
      runId: 'run-3',
      mode: 'worker',
      startedAt: 0,
      durationMs: 0,
    };
    expect(result.status).toBe('max-turns');
    expect(result.turnsUsed).toBe(SUBAGENT_ABSOLUTE_MAX_TURNS);
  });

  it('aborted result for cancellation', () => {
    const result: SubagentResult = {
      result: '(subagent aborted)',
      turnsUsed: 2,
      toolCalls: 3,
      status: 'aborted',
      runId: 'run-4',
      mode: 'worker',
      startedAt: 0,
      durationMs: 0,
    };
    expect(result.status).toBe('aborted');
  });
});


/* ------------------------------------------------------------------ */
/* executeDelegate — đường đơn + batch song song + scout + brief         */
/* ------------------------------------------------------------------ */

describe('executeDelegate — đường đơn (backward compatible)', () => {
  it('trả SubagentResult JSON như cũ, kèm metadata mới', async () => {
    mockLoopText('kết quả đơn');
    const out = JSON.parse(
      await executeDelegate({ instructions: 'một task duy nhất đủ dài để chạy' }, makeDeps()),
    ) as SubagentResult;
    expect(out.status).toBe('done');
    expect(out.result).toBe('kết quả đơn');
    expect(out.runId).toBeTruthy();
    expect(out.mode).toBe('worker');
    expect(typeof out.startedAt).toBe('number');
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('từ chối payload chứa CẢ instructions và tasks', async () => {
    const out = JSON.parse(
      await executeDelegate(
        {
          instructions: 'instructions cấp trên đủ dài',
          tasks: [{ instructions: 'task bên trong cũng đủ dài' }],
        },
        makeDeps(),
      ),
    ) as { status: string; error?: string };
    expect(out.status).toBe('error');
    expect(runEmulatedLoop).not.toHaveBeenCalled();
  });

  it('từ chối khi thiếu cả hai', async () => {
    const out = JSON.parse(await executeDelegate({}, makeDeps())) as { status: string };
    expect(out.status).toBe('error');
    expect(runEmulatedLoop).not.toHaveBeenCalled();
  });

  it('context brief gắn khối ngữ cảnh cha vào system; fresh không gọi builder', async () => {
    mockLoopText('ok');
    const getParentBrief = vi.fn(() => 'Người dùng đang làm tính năng đăng nhập.');
    await executeDelegate(
      { instructions: 'task cần hiểu bối cảnh phiên cha', context: 'brief' },
      makeDeps({ getParentBrief }),
    );
    expect(getParentBrief).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runEmulatedLoop).mock.calls[0][0].system).toContain('tính năng đăng nhập');

    const getParentBrief2 = vi.fn(() => 'không bao giờ được gọi');
    await executeDelegate(
      { instructions: 'task đường thường fresh context' },
      makeDeps({ getParentBrief: getParentBrief2 }),
    );
    expect(getParentBrief2).not.toHaveBeenCalled();
  });
});

describe('executeDelegate — fan-out song song (tasks)', () => {
  it('chạy tối đa SUBAGENT_PARALLEL_CONCURRENCY lane và giữ thứ tự kết quả', async () => {
    const total = SUBAGENT_MAX_PARALLEL_TASKS; // 4 task, cap 3 lane
    let active = 0;
    let maxActive = 0;
    const started: string[] = [];
    const release: Array<() => void> = [];
    const gates = Array.from({ length: total }, () => new Promise<void>((r) => release.push(r)));

    vi.mocked(runEmulatedLoop).mockImplementation(async (opts) => {
      const idx = /task-(\d)/.exec(String((opts.messages[0] as { content: string }).content))?.[1] ?? '?';
      started.push(idx);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gates[Number(idx)];
      active -= 1;
      opts.onTextDelta(`kq-${idx}`);
      return { status: 'done', roundsUsed: 1, totalCalls: 0 };
    });

    const pending = executeDelegate(
      { tasks: ['0', '1', '2', '3'].map((i) => ({ instructions: `Viết báo cáo task-${i} đầy đủ chi tiết` })) },
      makeDeps(),
    );

    await waitFor(() => active === 3);
    expect(started).toHaveLength(3);
    release[0]();
    await waitFor(() => started.length === 4); // task còn lại chiếm lane vừa trống
    expect(maxActive).toBe(SUBAGENT_PARALLEL_CONCURRENCY);
    release[1]();
    release[2]();
    release[3]();

    const out = JSON.parse(await pending) as SubagentResult[];
    expect(out.map((r) => r.result)).toEqual(['kq-0', 'kq-1', 'kq-2', 'kq-3']);
    expect(out.every((r) => r.status === 'done')).toBe(true);
  });

  it('abort: task chưa kịp chạy không được spawn, mọi lane báo aborted', async () => {
    const controller = new AbortController();
    let started = 0;
    const release: Array<() => void> = [];
    const gates = Array.from({ length: 3 }, () => new Promise<void>((r) => release.push(r)));

    vi.mocked(runEmulatedLoop).mockImplementation(async (opts) => {
      started += 1;
      await gates[started - 1];
      opts.onTextDelta('x');
      return { status: 'done', roundsUsed: 1, totalCalls: 0 };
    });

    const pending = executeDelegate(
      { tasks: ['a', 'b', 'c', 'd'].map((i) => ({ instructions: `task ${i} đủ dài để hợp lệ` })) },
      makeDeps({ abortSignal: controller.signal }),
    );

    await waitFor(() => started === 3);
    controller.abort();
    release.forEach((r) => r()); // lanes đang chạy thoát; runSubagent tự chốt aborted

    const out = JSON.parse(await pending) as SubagentResult[];
    expect(started).toBe(3);
    expect(out).toHaveLength(4);
    expect(out.every((r) => r.status === 'aborted')).toBe(true);
  });

  it('từ chối lô khi một task thiếu brief (không spawn gì cả)', async () => {
    const out = JSON.parse(
      await executeDelegate(
        { tasks: [{ instructions: 'task đầu tiên đủ dài để hợp lệ' }, { instructions: 'ngắn' }] },
        makeDeps(),
      ),
    ) as { status: string; error?: string };
    expect(out.status).toBe('error');
    expect(out.error).toContain('Task 2');
    expect(runEmulatedLoop).not.toHaveBeenCalled();
  });

  it('annotation batch gắn taskIndex/taskTotal cho từng lane', async () => {
    mockLoopText('ok');
    const events: Array<Record<string, unknown>> = [];
    await executeDelegate(
      {
        tasks: [
          { instructions: 'task một đủ dài để hợp lệ' },
          { instructions: 'task hai cũng đủ dài nè' },
        ],
      },
      makeDeps({ onProgress: (phase, detail) => events.push({ phase, ...detail }) }),
    );
    const starts = events.filter((e) => e.phase === 'start');
    expect(starts).toHaveLength(2);
    expect(starts.map((e) => e.taskIndex).sort()).toEqual([0, 1]);
    expect(starts.every((e) => e.taskTotal === 2)).toBe(true);
    expect(starts.every((e) => typeof e.runId === 'string' && (e.runId as string).length > 0)).toBe(true);
  });
});

describe('executeDelegate — mode scout', () => {
  it('lọc đúng denylist trên bản sao, set gốc không bị đụng', async () => {
    mockLoopText('phát hiện');
    const clientTools = new Set(['fs_read', 'fs_write', 'fs_edit', 'shell_run']);
    const out = JSON.parse(
      await executeDelegate(
        { instructions: 'Khảo sát kiến trúc auth của repo này', mode: 'scout' },
        makeDeps({ clientToolNames: clientTools }),
      ),
    ) as SubagentResult;
    expect(out.mode).toBe('scout');
    const opts = vi.mocked(runEmulatedLoop).mock.calls[0][0] as LoopOpts;
    expect(opts.clientTools?.has('fs_read')).toBe(true);
    expect(opts.clientTools?.has('fs_write')).toBe(false);
    expect(opts.clientTools?.has('fs_edit')).toBe(false);
    expect(opts.clientTools?.has('shell_run')).toBe(false);
    expect(clientTools.has('fs_write')).toBe(true);
    expect(opts.system).toContain('CHỈ ĐỌC');
  });

  it('SCOUT_DENIED_CLIENT_TOOLS đúng ba tool ghi trực tiếp', () => {
    expect([...SCOUT_DENIED_CLIENT_TOOLS].sort()).toEqual(['fs_edit', 'fs_write', 'shell_run']);
  });

  it('mode per-task đè mode cấp lô (task không khai báo thì kế thừa lô)', async () => {
    mockLoopText('x');
    await executeDelegate(
      {
        tasks: [
          { instructions: 'task scout khảo sát trước', mode: 'scout' },
          { instructions: 'task worker sửa lỗi sau' },
        ],
      },
      makeDeps(),
    );
    const calls = vi.mocked(runEmulatedLoop).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].clientTools?.has('fs_write')).toBe(false);
    expect(calls[1][0].clientTools?.has('fs_write')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* buildSubagentParentBrief — ngữ cảnh cha tất định, không LLM           */
/* ------------------------------------------------------------------ */

describe('buildSubagentParentBrief', () => {
  it('trích yêu cầu user, file ops và kết luận gần nhất', () => {
    const messages = [
      { role: 'user', content: 'Hãy làm trang login cho app' },
      {
        role: 'assistant',
        content: 'Đang làm...',
        toolInvocations: [
          { state: 'result', toolName: 'fs_edit', args: { path: 'app/login/page.tsx' } },
          { state: 'result', toolName: 'fs_read', args: { path: 'lib/auth.ts' } },
        ],
      },
      { role: 'assistant', content: 'Đã hoàn thành phần backend xác thực.' },
    ] as unknown as BudgetMessageLike[];

    const brief = buildSubagentParentBrief(messages);
    expect(brief).toContain('trang login');
    expect(brief).toContain('app/login/page.tsx');
    expect(brief).toContain('lib/auth.ts');
    expect(brief).toContain('backend xác thực');
  });

  it('trả rỗng khi không trích được gì — caller bỏ qua việc gắn', () => {
    expect(buildSubagentParentBrief([])).toBe('');
    expect(buildSubagentParentBrief([{ role: 'system', content: 'chỉ hệ thống' }])).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* Ngân sách spawn theo conversation + result preview annotation         */
/* ------------------------------------------------------------------ */

describe('subagent budget — consumeSubagentSpawns', () => {
  beforeEach(() => {
    resetSubagentBudgetForTests();
  });

  it('cấp đủ cap rồi chặn; hội thoại khác độc lập', () => {
    for (let i = 0; i < SUBAGENT_SPAWNS_PER_BUCKET; i++) {
      expect(consumeSubagentSpawns('conv-a', 1).granted).toBe(1);
    }
    expect(consumeSubagentSpawns('conv-a', 1).granted).toBe(0);
    expect(consumeSubagentSpawns('conv-b', 1).granted).toBe(1);
  });

  it('cấp một phần khi want lớn hơn số suất còn lại', () => {
    consumeSubagentSpawns('conv-c', SUBAGENT_SPAWNS_PER_BUCKET - 2);
    const grant = consumeSubagentSpawns('conv-c', 5);
    expect(grant.granted).toBe(2);
    expect(grant.remaining).toBe(0);
  });

  it('hết TTL thì bucket được cấp lại (giả lập đồng hồ)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-05T10:00:00Z'));
      consumeSubagentSpawns('conv-ttl', SUBAGENT_SPAWNS_PER_BUCKET);
      expect(consumeSubagentSpawns('conv-ttl', 1).granted).toBe(0);
      vi.setSystemTime(new Date('2026-09-05T10:10:01Z')); // > BUDGET_TTL_MS
      expect(consumeSubagentSpawns('conv-ttl', 1).granted).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('thiếu conversationId thì luôn cấp đủ, không bị cap', () => {
    expect(consumeSubagentSpawns(undefined, 100).granted).toBe(100);
    expect(consumeSubagentSpawns('', 100).granted).toBe(100);
  });
});

describe('executeDelegate — ngân sách spawn', () => {
  beforeEach(() => {
    resetSubagentBudgetForTests();
  });

  it('đường đơn: hết ngân sách → error JSON, không spawn', async () => {
    consumeSubagentSpawns('conv-x', SUBAGENT_SPAWNS_PER_BUCKET);
    const out = JSON.parse(
      await executeDelegate(
        { instructions: 'task đủ dài để hợp lệ nè' },
        makeDeps({ conversationId: 'conv-x' }),
      ),
    ) as { status: string; error?: string };
    expect(out.status).toBe('error');
    expect(out.error).toContain('ngân sách');
    expect(runEmulatedLoop).not.toHaveBeenCalled();
  });

  it('batch sát cap: phần được cấp chạy, phần vượt error đúng vị trí', async () => {
    mockLoopText('ok');
    consumeSubagentSpawns('conv-y', SUBAGENT_SPAWNS_PER_BUCKET - 1); // còn 1 suất
    const out = JSON.parse(
      await executeDelegate(
        {
          tasks: [
            { instructions: 'task một đủ dài để chạy được' },
            { instructions: 'task hai cũng đủ dài vậy đó' },
          ],
        },
        makeDeps({ conversationId: 'conv-y' }),
      ),
    ) as SubagentResult[];
    expect(out).toHaveLength(2);
    expect(out[0].status).toBe('done');
    expect(out[0].result).toBe('ok');
    expect(out[1].status).toBe('error');
    expect(out[1].error).toContain('ngân sách');
    expect(vi.mocked(runEmulatedLoop)).toHaveBeenCalledTimes(1);
  });

  it('không có conversationId thì không đếm — chạy tự do như cũ', async () => {
    mockLoopText('ok');
    for (let i = 0; i < 15; i++) {
      const out = JSON.parse(
        await executeDelegate({ instructions: `task lặp thứ ${i} đủ dài hợp lệ` }, makeDeps()),
      ) as SubagentResult;
      expect(out.status).toBe('done');
    }
  });
});

describe('done annotation — result preview', () => {
  it('gắn preview đúng trần SUBAGENT_RESULT_PREVIEW_CHARS', async () => {
    mockLoopText('k'.repeat(600));
    const events: Array<Record<string, unknown>> = [];
    await executeDelegate(
      { instructions: 'task đơn đủ dài để hợp lệ nhé' },
      makeDeps({ onProgress: (phase, detail) => events.push({ phase, ...detail }) }),
    );
    const done = events.find((e) => e.phase === 'done');
    expect(typeof done?.result).toBe('string');
    expect((done?.result as string).length).toBe(SUBAGENT_RESULT_PREVIEW_CHARS);
  });
});
