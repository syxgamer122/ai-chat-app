/**
 * Thực thi sub-recipe trên SERVER (chạy trong /api/chat): mỗi sub-recipe là
 * một tool có execute thật; batch tool chạy nhiều cái song song qua runPool
 * (cap SUBRECIPE_PARALLEL_CONCURRENCY, semantics allSettled). Subagent là
 * LEAF WORKER: không delegate, không subrecipe__* (chống đệ quy).
 *
 * Trạng thái stream về UI qua annotation {subagent: {...}} — cùng shape với
 * delegate hiện có nên components/subagent-card.tsx hiển thị luôn.
 */

import { tool, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import { runPool } from '@/lib/orchestrator/scheduler';
import { runSubagent, type SubagentOptions, type SubagentResult } from '@/lib/subagent';
import { consumeSubagentSpawns, SUBAGENT_SPAWNS_PER_BUCKET } from '@/lib/subagent-budget';
import type { AgentToolSet } from '@/lib/agent-tools';
import { prepareRecipeRun } from './run';
import {
  SUBRECIPE_BATCH_TOOL,
  SUBRECIPE_PARALLEL_CONCURRENCY,
  buildSubRecipeInstructions,
  buildSubRecipeParameters,
  buildSubRecipeToolDescription,
  formatSubRecipeResult,
  planSubRecipeBatch,
  subRecipeToolName,
  type ResolvedSubRecipe,
  type SubRecipeBatchCall,
} from './subrecipe';
import type { Recipe } from './schema';

export interface SubRecipeExecDeps {
  model: LanguageModel;
  systemBase: string;
  serverTools: AgentToolSet;
  clientToolNames: ReadonlySet<string>;
  abortSignal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  resolveClientTool?: SubagentOptions['resolveClientTool'];
  conversationId?: string;
  onProgress?: SubagentOptions['onProgress'];
}

function spawnBudgetError(): string {
  return `Đã hết ngân sách subagent (${SUBAGENT_SPAWNS_PER_BUCKET} lần) — tự làm phần việc còn lại trực tiếp.`;
}

/** Áp tool policy của SUB-recipe lên bản sao client tool names. */
function clientToolsFor(sub: ResolvedSubRecipe, base: ReadonlySet<string>): ReadonlySet<string> {
  const deny = new Set(sub.recipe.tools?.deny ?? []);
  const allow =
    sub.recipe.tools?.allow && sub.recipe.tools.allow.length > 0 ? new Set(sub.recipe.tools.allow) : null;
  const out = new Set<string>();
  for (const name of base) {
    if (deny.has(name)) continue;
    if (allow && !allow.has(name)) continue;
    out.add(name);
  }
  return out;
}

async function runOneSubRecipe(
  sub: ResolvedSubRecipe,
  args: Record<string, unknown>,
  deps: SubRecipeExecDeps,
): Promise<SubagentResult> {
  const values: Record<string, string | number | boolean> = {};
  // fixedValues thắng args — model không đè được giá trị recipe cha gán cứng.
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') values[k] = v;
  }
  for (const [k, v] of Object.entries(sub.fixedValues)) values[k] = v;

  const prepared = prepareRecipeRun(sub.recipe, values, { includeStructuredDirective: false });
  const instructions = buildSubRecipeInstructions(
    prepared.systemAppend,
    prepared.firstUserMessage,
    sub.returnMode,
  );

  const wrappedProgress: SubagentOptions['onProgress'] | undefined = deps.onProgress
    ? (phase, detail) => deps.onProgress?.(phase, { ...detail, task: `subrecipe:${sub.name}` })
    : undefined;

  const result = await runSubagent({
    instructions,
    maxTurns: 10,
    model: deps.model,
    systemBase: deps.systemBase,
    serverTools: deps.serverTools,
    clientToolNames: clientToolsFor(sub, deps.clientToolNames),
    mode: 'worker',
    resolveClientTool: deps.resolveClientTool,
    abortSignal: deps.abortSignal,
    ...(deps.temperature !== undefined ? { temperature: deps.temperature } : {}),
    ...(deps.maxTokens ? { maxTokens: deps.maxTokens } : {}),
    onProgress: wrappedProgress,
  });

  return { ...result, result: formatSubRecipeResult(result.result, sub.returnMode) };
}

/** Tool đơn cho một sub-recipe — model gọi khi cần chạy đúng cái đó. */
export function buildSubRecipeServerTools(
  subs: readonly ResolvedSubRecipe[],
  deps: SubRecipeExecDeps,
): Record<string, ToolSet[string]> {
  if (!subs.length) return {};
  const tools: Record<string, ToolSet[string]> = {};

  for (const sub of subs) {
    tools[subRecipeToolName(sub.name)] = tool({
      description: buildSubRecipeToolDescription(sub),
      parameters: buildSubRecipeParameters(sub.recipe.parameters, sub.fixedValues),
      execute: async (args: unknown) => {
        const grant = consumeSubagentSpawns(deps.conversationId, 1);
        if (grant.granted < 1) return JSON.stringify({ status: 'error', error: spawnBudgetError() });
        const result = await runOneSubRecipe(sub, (args ?? {}) as Record<string, unknown>, deps);
        return JSON.stringify(result);
      },
    });
  }

  tools[SUBRECIPE_BATCH_TOOL] = tool({
    description:
      `Chạy NHIỀU sub-recipe SONG SONG (tối đa ${SUBRECIPE_PARALLEL_CONCURRENCY} cùng lúc, kết quả giữ đúng thứ tự calls). ` +
      'Ưu tiên tool này khi các sub-recipe độc lập nhau.',
    parameters: z.object({
      calls: z
        .array(
          z.object({
            name: z.string().max(60).describe('Tên sub-recipe (không có tiền tố subrecipe__)'),
            args: z.record(z.unknown()).optional().describe('Tham số cho sub-recipe đó'),
          }),
        )
        .min(1)
        .max(8),
    }),
    execute: async (raw: unknown) => {
      const { calls } = raw as { calls: SubRecipeBatchCall[] };
      const plan = planSubRecipeBatch(calls, subs);
      if (!plan.ok) return JSON.stringify({ status: 'error', error: plan.error });

      const grant = consumeSubagentSpawns(deps.conversationId, plan.entries.length);
      const runnable = grant.granted >= plan.entries.length ? plan.entries : plan.entries.slice(0, grant.granted);

      const outcomes = await runPool({
        items: runnable,
        limit: SUBRECIPE_PARALLEL_CONCURRENCY,
        signal: deps.abortSignal,
        worker: (entry, index) =>
          runOneSubRecipe(entry.sub, entry.args, {
            ...deps,
            onProgress: deps.onProgress
              ? (phase, detail) =>
                  deps.onProgress?.(phase, {
                    ...detail,
                    task: `subrecipe:${entry.sub.name}`,
                    taskIndex: index,
                    taskTotal: runnable.length,
                  })
              : undefined,
          }),
      });

      const results: SubagentResult[] = outcomes.map((o) =>
        o.ok
          ? o.value
          : {
              result: '',
              turnsUsed: 0,
              toolCalls: 0,
              status: 'aborted',
              runId: '',
              mode: 'worker',
              startedAt: 0,
              durationMs: 0,
              error: o.error,
            },
      );
      for (let i = runnable.length; i < plan.entries.length; i++) {
        results.push({
          result: '',
          turnsUsed: 0,
          toolCalls: 0,
          status: 'error',
          runId: '',
          mode: 'worker',
          startedAt: 0,
          durationMs: 0,
          error: spawnBudgetError(),
        });
      }
      return JSON.stringify(results);
    },
  });

  return tools;
}

/** Chuẩn hoá payload body.subRecipes của route → ResolvedSubRecipe[]. */
export function toResolvedSubRecipes(
  payload: ReadonlyArray<{
    name: string;
    mode?: 'sequential' | 'parallel';
    returnMode?: 'full' | 'summary';
    fixedValues?: Record<string, string>;
    recipe: Recipe;
  }>,
): ResolvedSubRecipe[] {
  return payload.map((p) => ({
    name: p.name,
    recipe: p.recipe,
    mode: p.mode ?? 'parallel',
    returnMode: p.returnMode ?? 'summary',
    fixedValues: { ...(p.fixedValues ?? {}) },
  }));
}
