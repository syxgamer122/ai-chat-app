/**
 * Subagent Delegation — Goose-style lightweight subagent as emulated loop fork.
 *
 * Design principles (from Goose subagent_handler.rs + subagent_system.md):
 * 1. Context isolation: subagent gets FRESH message array (no parent history) —
 *    hoặc context 'brief' nhận một khối tóm tắt tất định của phiên cha
 *    (deps.getParentBrief, dựng bởi buildSubagentParentBrief) chứ không phải
 *    transcript nguyên bản.
 * 2. No recursive spawning: subagent CANNOT call delegate (enforced by excluding
 *    'delegate' from its tool set)
 * 3. Bounded execution: max_turns cap (default 10, max 25)
 * 4. Same safety layers: guarded(), doom-loop detection, path-guard all apply
 * 5. Result extraction: last assistant text = subagent's answer
 *
 * Fan-out song song (tương tự runs.all của pi-subagents): args.tasks chạy 1-4
 * subagent CÙNG LÚC qua runPool (cap SUBAGENT_PARALLEL_CONCURRENCY), kết quả
 * giữ đúng thứ tự đầu vào. Mode 'scout' là denylist tool ghi, KHÔNG phải
 * sandbox: git_add/git_commit vẫn gọi được.
 *
 * Execution model: Fork runEmulatedLoop() with isolated messages + reduced tools.
 * Runs SERVER-side inside the chat route (needs LLM access). Client tools
 * (fs_*, shell, git) reach the user's machine via the annotation relay in
 * lib/subagent-relay.ts — pass `resolveClientTool` to enable them.
 */

import { randomUUID } from 'node:crypto';
import { runPool } from '@/lib/orchestrator/scheduler';
import type { LanguageModel } from 'ai';
import {
  runEmulatedLoop,
  type EmulatedLoopOptions,
  type EmulatedLoopResult,
} from '@/lib/emulated-agent';
import { consumeSubagentSpawns, SUBAGENT_SPAWNS_PER_BUCKET } from '@/lib/subagent-budget';
import { BUDGET_TTL_MS } from '@/lib/tool-call-budget';
import type { AgentToolSet } from '@/lib/agent-tools';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const SUBAGENT_DEFAULT_MAX_TURNS = 10;
export const SUBAGENT_ABSOLUTE_MAX_TURNS = 25;
export const SUBAGENT_DEFAULT_TIMEOUT_SECS = 300; // 5 minutes
/** Trần số task trong một lần delegate song song. */
export const SUBAGENT_MAX_PARALLEL_TASKS = 4;
/** Số subagent chạy cùng lúc thật sự trong một lần fan-out. */
export const SUBAGENT_PARALLEL_CONCURRENCY = 3;

/**
 * Tool client bị cấm ở chế độ scout. Danh sách này cố ý KHÔNG gồm
 * git_add/git_commit: scout là chế độ "chỉ đọc file" theo denylist, không
 * phải sandbox chống ghi tuyệt đối — muốn chặn git phải qua permission layer.
 */
export const SCOUT_DENIED_CLIENT_TOOLS: ReadonlySet<string> = new Set([
  'fs_write',
  'fs_edit',
  'shell_run',
]);

export type SubagentMode = 'scout' | 'worker';
export type SubagentContextMode = 'fresh' | 'brief';

/** Một task trong lô song song. */
export interface DelegateTaskInput {
  instructions: string;
  max_turns?: number;
  timeout_secs?: number;
  mode?: SubagentMode;
}

/** Args của tool delegate — cả đường emulated lẫn native đều về đây. */
export interface DelegateCallArgs {
  instructions?: string;
  /** Có mặt thì KHÔNG dùng instructions (hai hình thức loại trừ nhau). */
  tasks?: DelegateTaskInput[];
  max_turns?: number;
  timeout_secs?: number;
  mode?: SubagentMode;
  context?: SubagentContextMode;
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface SubagentOptions {
  /** Task instructions for the subagent. */
  instructions: string;
  /** Max turns (rounds) the subagent can use. Default 10, max 25. */
  maxTurns?: number;
  /** Timeout in seconds. Default 300 (5 min). */
  timeoutSecs?: number;
  /** Model to use (same as parent by default). */
  model: LanguageModel;
  /** System prompt base (workspace context, persona, etc.) — WITHOUT delegation guidance. */
  systemBase: string;
  /** Server tools available (web_search, memory, etc.). */
  serverTools: AgentToolSet;
  /** Client tool names available (fs_*, shell_run, git_*). NO 'delegate'. */
  clientToolNames: ReadonlySet<string>;
  /** Callback for client tool calls (same as parent's onClientToolCall). */
  onClientToolCall?: (call: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }) => void;
  /**
   * Relay tool client xuống renderer (lib/subagent-relay.ts). Có callback này
   * subagent mới dùng ĐƯỢC fs, shell, git — không có thì chỉ còn server tools.
   */
  resolveClientTool?: (call: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }) => Promise<string>;
  /** Abort signal from parent. */
  abortSignal?: AbortSignal;
  /** Temperature override. */
  temperature?: number;
  /** Max tokens override. */
  maxTokens?: number;
  /** scout = lọc tool ghi + prompt chỉ-đọc; worker = đầy đủ (mặc định). */
  mode?: SubagentMode;
  /** Khối tóm tắt phiên cha (context 'brief'). Rỗng/undefined = không gắn. */
  parentBrief?: string;
  /** Progress callback for streaming annotations to UI. */
  onProgress?: (phase: 'start' | 'progress' | 'done', detail: Record<string, unknown>) => void;
}

export interface SubagentResult {
  /** The subagent's final answer/text. */
  result: string;
  /** Number of rounds used. */
  turnsUsed: number;
  /** Total tool calls made. */
  toolCalls: number;
  /** Whether the subagent completed normally or was cut off. */
  status: 'done' | 'max-turns' | 'aborted' | 'error';
  /** Định danh lần chạy — khớp annotation UI, giúp phân biệt các lane song song. */
  runId: string;
  mode: SubagentMode;
  /** Epoch ms lúc bắt đầu. */
  startedAt: number;
  /** Thời lượng thực tế (ms) tính tới lúc trả kết quả. */
  durationMs: number;
  /** Error message if status is 'error'. */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* System prompt builder                                               */
/* ------------------------------------------------------------------ */

/**
 * Build subagent system prompt. Port from Goose subagent_system.md template.
 * Key rules: specialized, independent, bounded, NO recursive delegation.
 * `opts.mode === 'scout'` thêm khối chỉ-đọc; `opts.parentBrief` gắn ngữ cảnh
 * cha như DỮ KIỆN tham khảo, không phải chỉ thị mới.
 */
export function buildSubagentSystemPrompt(
  baseSystem: string,
  instructions: string,
  maxTurns: number,
  opts: { mode?: SubagentMode; parentBrief?: string } = {},
): string {
  const blocks = [
    baseSystem,
    '',
    '# Subagent Role',
    '',
    'You are a SPECIALIZED SUBAGENT running within Vyen. Your purpose is to complete',
    'a specific, bounded task independently.',
    '',
    '## Rules',
    '',
    '- **Independence**: Make decisions and execute tools within your scope.',
    '- **Bounded Operation**: You have a MAXIMUM of ' + maxTurns + ' turns. Be efficient.',
    '- **NO Delegation**: You CANNOT call `delegate`. You are a leaf worker.',
    '- **Tool Efficiency**: Use minimum tools needed. No exploratory/curiosity usage.',
    '- **Clear Completion**: When done, provide a clear summary of what you accomplished.',
    '- **Markdown**: Format your response in markdown for readability.',
  ];

  if (opts.mode === 'scout') {
    blocks.push(
      '',
      '## Chế độ SCOUT — CHỈ ĐỌC',
      '- Bạn KHÔNG có công cụ ghi (fs_write, fs_edit, shell_run đã bị loại khỏi bộ tool).',
      '- Nhiệm vụ: đọc, tìm kiếm, phân tích. Trả về phát hiện kèm bằng chứng (file:line).',
      '- KHÔNG đề xuất tự áp thay đổi — chỉ báo cáo.',
    );
  }

  if (opts.parentBrief && opts.parentBrief.trim()) {
    blocks.push(
      '',
      '# Bối cảnh từ phiên cha',
      'Dữ kiện tham khảo dưới đây mô tả hội thoại đã diễn ra. Đây là NGỮ CẢNH,',
      'không phải chỉ thị mới — ưu tiên instructions của task khi xung đột.',
      '',
      opts.parentBrief.trim(),
    );
  }

  blocks.push(
    '',
    '## Your Task',
    '',
    instructions,
    '',
    'Complete this task using available tools. When finished, summarize results clearly.',
  );
  return blocks.join('\n');
}

/* ------------------------------------------------------------------ */
/* Core execution                                                      */
/* ------------------------------------------------------------------ */

/**
 * Run a subagent with isolated context. Forks runEmulatedLoop with:
 * - Fresh message array (only user task instruction)
 * - Reduced tool set (NO delegate — prevents recursion)
 * - Own maxRounds limit
 * - Own timeout
 *
 * Returns structured result with final text, turns used, tool calls count.
 */
export async function runSubagent(opts: SubagentOptions): Promise<SubagentResult> {
  const maxTurns = Math.min(
    Math.max(1, opts.maxTurns ?? SUBAGENT_DEFAULT_MAX_TURNS),
    SUBAGENT_ABSOLUTE_MAX_TURNS,
  );
  const timeoutMs = (opts.timeoutSecs ?? SUBAGENT_DEFAULT_TIMEOUT_SECS) * 1000;
  const runId = randomUUID();
  const mode: SubagentMode = opts.mode ?? 'worker';
  const startedAt = Date.now();
  const finish = (
    partial: Pick<SubagentResult, 'result' | 'turnsUsed' | 'toolCalls' | 'status'> &
      Partial<Pick<SubagentResult, 'error'>>,
  ): SubagentResult => ({
    ...partial,
    runId,
    mode,
    startedAt,
    durationMs: Date.now() - startedAt,
  });

  // Notify start
  opts.onProgress?.('start', {
    runId,
    mode,
    maxTurns,
    instructions: opts.instructions.slice(0, 200),
  });

  // Create abort controller with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Link parent abort signal
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  // Build isolated system prompt
  const system = buildSubagentSystemPrompt(opts.systemBase, opts.instructions, maxTurns, {
    ...(mode === 'scout' ? { mode } : {}),
    ...(opts.parentBrief ? { parentBrief: opts.parentBrief } : {}),
  });

  // Scout: lọc tool ghi trên BẢN SAO — không đụng set chung của request.
  const clientToolNames =
    mode === 'scout'
      ? new Set([...opts.clientToolNames].filter((n) => !SCOUT_DENIED_CLIENT_TOOLS.has(n)))
      : opts.clientToolNames;

  // Collect text deltas to extract final answer
  const textParts: string[] = [];
  let lastAnnotation: Record<string, unknown> | null = null;

  try {
    const loopOpts: EmulatedLoopOptions = {
      model: opts.model,
      // ISOLATED messages — only the task instruction, no parent history
      messages: [
        { role: 'user', content: opts.instructions },
      ],
      system,
      tools: opts.serverTools,
      clientTools: clientToolNames, // Already excludes 'delegate'
      onClientToolCall: opts.onClientToolCall,
      resolveClientTool: opts.resolveClientTool,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      abortSignal: controller.signal,
      maxRounds: maxTurns,
      onTextDelta: (delta) => {
        textParts.push(delta);
        opts.onProgress?.('progress', { type: 'text', length: delta.length });
      },
      onReasoningLine: (line) => {
        opts.onProgress?.('progress', { type: 'reasoning', preview: line.slice(0, 100) });
      },
      onAnnotation: (payload) => {
        lastAnnotation = payload;
        opts.onProgress?.('progress', { type: 'tool', annotation: payload });
      },
    };

    const loopResult: EmulatedLoopResult = await runEmulatedLoop(loopOpts);

    clearTimeout(timeoutId);

    const resultText = textParts.join('').trim();

    if (controller.signal.aborted && opts.abortSignal?.aborted) {
      return finish({
        result: resultText || '(subagent aborted by parent)',
        turnsUsed: loopResult.roundsUsed,
        toolCalls: loopResult.totalCalls,
        status: 'aborted',
      });
    }

    if (loopResult.roundsUsed >= maxTurns && loopResult.status === 'done') {
      // Hit max turns but completed — might be truncated
      opts.onProgress?.('done', {
        runId,
        turnsUsed: loopResult.roundsUsed,
        toolCalls: loopResult.totalCalls,
        hitMaxTurns: true,
        result: resultText.slice(0, SUBAGENT_RESULT_PREVIEW_CHARS),
      });
      return finish({
        result: resultText || '(subagent reached max turns without final answer)',
        turnsUsed: loopResult.roundsUsed,
        toolCalls: loopResult.totalCalls,
        status: 'max-turns',
      });
    }

    opts.onProgress?.('done', {
      runId,
      turnsUsed: loopResult.roundsUsed,
      toolCalls: loopResult.totalCalls,
      result: resultText.slice(0, SUBAGENT_RESULT_PREVIEW_CHARS),
    });

    return finish({
      result: resultText || '(subagent completed with no text output)',
      turnsUsed: loopResult.roundsUsed,
      toolCalls: loopResult.totalCalls,
      status: 'done',
    });
  } catch (err) {
    clearTimeout(timeoutId);

    if (controller.signal.aborted) {
      return finish({
        result: textParts.join('').trim() || '(subagent timed out or aborted)',
        turnsUsed: 0,
        toolCalls: 0,
        status: 'aborted',
      });
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    opts.onProgress?.('done', { runId, error: errorMsg });
    return finish({
      result: '',
      turnsUsed: 0,
      toolCalls: 0,
      status: 'error',
      error: errorMsg,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Shared execute — dùng cho CẢ hai đường (emulated + native)          */
/* ------------------------------------------------------------------ */

export interface DelegateExecuteDeps {
  model: LanguageModel;
  systemBase: string;
  serverTools: AgentToolSet;
  clientToolNames: ReadonlySet<string>;
  abortSignal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  resolveClientTool?: SubagentOptions['resolveClientTool'];
  onProgress?: SubagentOptions['onProgress'];
  /**
   * Dựng khối ngữ cảnh phiên cha cho context 'brief'. LAZY — chỉ chạy khi
   * model chọn 'brief'; caller truyền closure, không truyền chuỗi dựng sẵn.
   */
  getParentBrief?: () => string | undefined;
  /**
   * Id hội thoại — chìa khóa ngân sách spawn (lib/subagent-budget.ts).
   * Thiếu thì delegate chạy không bị đếm, giữ hành vi cũ.
   */
  conversationId?: string;
}

/** Nhãn lane trong annotation khi chạy batch — UI dùng để tách thẻ theo task. */
export interface SubagentTaskMeta {
  taskIndex?: number;
  taskTotal?: number;
}

function spawnBudgetErrorText(): string {
  return (
    `Đã hết ngân sách subagent cho hội thoại này (${SUBAGENT_SPAWNS_PER_BUCKET} lần trong ` +
    `${Math.round(BUDGET_TTL_MS / 60_000)} phút). Hãy tự làm phần việc còn lại trực tiếp, ` +
    'hoặc chờ người dùng rồi mới delegate tiếp.'
  );
}

/** Trần ký tự của result preview trong annotation — card UI đọc field này. */
export const SUBAGENT_RESULT_PREVIEW_CHARS = 400;

/**
 * Thân thực thi của tool delegate — gọi từ onDelegateCall (đường emulated)
 * lẫn execute của server-tool (đường native). Trả JSON string: một
 * SubagentResult (đường đơn) hoặc SubagentResult[] (batch tasks).
 *
 * Luôn LỌC 'delegate' khỏi clientToolNames dù caller truyền gì — chống đệ
 * quy ở đúng tầng này (route hay truyền nhầm set đầy đủ).
 */
export async function executeDelegate(
  args: DelegateCallArgs,
  deps: DelegateExecuteDeps,
): Promise<string> {
  const hasInstructions =
    typeof args.instructions === 'string' && args.instructions.trim().length > 0;
  // native path truyền nguyên args của model vào — phần tử tasks là JSON thô,
  // chưa qua validate, nên đọc qua unknown rồi kiểm tra từng field.
  const rawTasks: unknown[] = Array.isArray(args.tasks) ? (args.tasks as unknown[]) : [];

  if (hasInstructions && rawTasks.length > 0) {
    return JSON.stringify({
      status: 'error',
      error:
        'Chỉ dùng MỘT trong hai: instructions (một task) hoặc tasks (nhiều task song song).',
    });
  }
  if (!hasInstructions && rawTasks.length === 0) {
    return JSON.stringify({
      status: 'error',
      error: 'Thiếu instructions (một task) hoặc tasks (1-4 task song song).',
    });
  }

  const mode: SubagentMode = args.mode === 'scout' ? 'scout' : 'worker';
  const parentBrief = args.context === 'brief' ? deps.getParentBrief?.() : undefined;

  if (rawTasks.length === 0) {
    const instructions = String(args.instructions ?? '');
    if (instructions.trim().length < 10) {
      return JSON.stringify({
        status: 'error',
        error: 'instructions quá ngắn — viết brief đầy đủ (tối thiểu 10 ký tự) cho subagent.',
      });
    }
    const grant = consumeSubagentSpawns(deps.conversationId, 1);
    if (grant.granted < 1) {
      return JSON.stringify({ status: 'error', error: spawnBudgetErrorText() });
    }
    const subResult = await runSubagent({
      instructions,
      maxTurns: typeof args.max_turns === 'number' ? args.max_turns : undefined,
      timeoutSecs: typeof args.timeout_secs === 'number' ? args.timeout_secs : undefined,
      model: deps.model,
      systemBase: deps.systemBase,
      serverTools: deps.serverTools,
      clientToolNames: new Set([...deps.clientToolNames].filter((n) => n !== 'delegate')),
      mode,
      ...(parentBrief ? { parentBrief } : {}),
      resolveClientTool: deps.resolveClientTool,
      abortSignal: deps.abortSignal,
      ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
      ...(deps.maxTokens ? { maxTokens: deps.maxTokens } : {}),
      onProgress: deps.onProgress,
    });
    return JSON.stringify(subResult);
  }

  /* Batch: validate thô trước khi spawn — một task hỏng brief không được
     phép nuốt cả lượt chạy của các task còn lại. */
  const tasks: DelegateTaskInput[] = [];
  for (let i = 0; i < rawTasks.length && i < SUBAGENT_MAX_PARALLEL_TASKS; i++) {
    const raw = (rawTasks[i] ?? {}) as Record<string, unknown>;
    const instructions = typeof raw.instructions === 'string' ? raw.instructions : '';
    if (instructions.trim().length < 10) {
      return JSON.stringify({
        status: 'error',
        error: `Task ${i + 1}: instructions quá ngắn — viết brief đầy đủ (tối thiểu 10 ký tự).`,
      });
    }
    tasks.push({
      instructions,
      ...(typeof raw.max_turns === 'number' ? { max_turns: raw.max_turns } : {}),
      ...(typeof raw.timeout_secs === 'number' ? { timeout_secs: raw.timeout_secs } : {}),
      ...(raw.mode === 'scout' || raw.mode === 'worker' ? { mode: raw.mode } : {}),
    });
  }

  /* Ngân sách spawn consume MỘT lần cho cả lô TRƯỚC khi spawn — cấp một phần
     nếu bucket sắp cạn; task vượt phần cấp nhận error entry, giữ đúng vị trí
     trong mảng kết quả. */
  const grant = consumeSubagentSpawns(deps.conversationId, tasks.length);
  const runnable = grant.granted >= tasks.length ? tasks : tasks.slice(0, grant.granted);

  // Gắn nhãn lane vào mọi annotation để UI không trộn trạng thái các task.
  const withTaskMeta = (index: number): SubagentOptions['onProgress'] | undefined =>
    deps.onProgress
      ? (phase, detail) =>
          deps.onProgress?.(phase, { ...detail, taskIndex: index, taskTotal: runnable.length })
      : undefined;

  const outcomes = await runPool<DelegateTaskInput, SubagentResult>({
    items: runnable,
    limit: SUBAGENT_PARALLEL_CONCURRENCY,
    signal: deps.abortSignal,
    worker: (task, index) =>
      runSubagent({
        instructions: task.instructions,
        maxTurns: task.max_turns ?? (typeof args.max_turns === 'number' ? args.max_turns : undefined),
        timeoutSecs:
          task.timeout_secs ?? (typeof args.timeout_secs === 'number' ? args.timeout_secs : undefined),
        model: deps.model,
        systemBase: deps.systemBase,
        serverTools: deps.serverTools,
        clientToolNames: new Set([...deps.clientToolNames].filter((n) => n !== 'delegate')),
        mode: task.mode ?? mode,
        ...(parentBrief ? { parentBrief } : {}),
        resolveClientTool: deps.resolveClientTool,
        abortSignal: deps.abortSignal,
        ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
        ...(deps.maxTokens ? { maxTokens: deps.maxTokens } : {}),
        onProgress: withTaskMeta(index),
      }),
  });

  /* runSubagent tự bắt mọi lỗi nên ok:false chỉ còn một nguyên nhân: task
     chưa kịp chạy bị huỷ (runPool trả 'Đã huỷ'). */
  const results: SubagentResult[] = outcomes.map((o) =>
    o.ok
      ? o.value
      : {
          result: '',
          turnsUsed: 0,
          toolCalls: 0,
          status: 'aborted',
          runId: '',
          mode,
          startedAt: 0,
          durationMs: 0,
          error: o.error,
        },
  );
  /* Task vượt phần ngân sách cấp: error entry ở đúng vị trí — mảng kết quả
     luôn dài bằng số task gốc, không làm mất kết quả của task đã chạy. */
  for (let i = runnable.length; i < tasks.length; i++) {
    results.push({
      result: '',
      turnsUsed: 0,
      toolCalls: 0,
      status: 'error',
      runId: '',
      mode,
      startedAt: 0,
      durationMs: 0,
      error: spawnBudgetErrorText(),
    });
  }
  return JSON.stringify(results);
}
