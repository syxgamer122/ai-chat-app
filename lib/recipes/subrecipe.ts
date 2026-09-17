/**
 * Sub-recipes: mỗi sub-recipe của session trở thành MỘT tool
 * `subrecipe__<name>` với JSON schema sinh từ `parameters` của nó, cộng một
 * tool `subrecipe__batch` chạy nhiều sub-recipe song song (runPool cap 3 —
 * Promise.allSettled semantics đã có sẵn ở orchestrator/scheduler).
 *
 * Chặn đệ quy: schema đã cấm sub-recipe chứa sub_recipes; tầng thực thi cũng
 * KHÔNG cấp `delegate` + không cấp subrecipe__* cho subagent (leaf worker).
 *
 * File thuần: mọi phụ thuộc (LLM, relay, fs) được inject.
 */

import { z } from 'zod';
import { parseRecipeText } from './parse';
import { RecipeSchema, type Recipe, type RecipeParameter } from './schema';

export const SUBRECIPE_TOOL_PREFIX = 'subrecipe__';
export const SUBRECIPE_BATCH_TOOL = 'subrecipe__batch';
/** Trần ký tự kết quả ở chế độ summary. */
export const SUBRECIPE_SUMMARY_CHARS = 2_000;
/** Số sub-recipe chạy đồng thời tối đa (khớp SUBAGENT_PARALLEL_CONCURRENCY). */
export const SUBRECIPE_PARALLEL_CONCURRENCY = 3;

export function subRecipeToolName(name: string): string {
  return `${SUBRECIPE_TOOL_PREFIX}${name}`;
}

export interface ResolvedSubRecipe {
  name: string;
  recipe: Recipe;
  mode: 'sequential' | 'parallel';
  returnMode: 'full' | 'summary';
  /** Giá trị tham số gán CỨNG từ recipe cha — model không đè được. */
  fixedValues: Record<string, string>;
}

export interface SubRecipeStartInput {
  name: string;
  path?: string;
  inline?: unknown;
  values?: Record<string, string>;
  mode?: 'sequential' | 'parallel';
  return_mode?: 'full' | 'summary';
}

/**
 * Resolve danh sách sub_recipes lúc bắt đầu run (CLIENT-side trước khi gửi
 * body): inline parse trực tiếp; path đọc qua adapter readFile. Recipe con
 * chứa sub_recipes → lỗi (chống đệ quy). Trả cả lô; entry hỏng nằm trong errors.
 */
export async function resolveSubRecipesAtStart(
  inputs: readonly SubRecipeStartInput[],
  readFile: (path: string) => Promise<string>,
  opts: { baseDir?: string } = {},
): Promise<{ resolved: ResolvedSubRecipe[]; errors: Array<{ name: string; error: string }> }> {
  const resolved: ResolvedSubRecipe[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const input of inputs) {
    try {
      let recipe: Recipe | null = null;
      if (input.path) {
        const full = opts.baseDir ? joinPosix(opts.baseDir, input.path) : input.path;
        const text = await readFile(full);
        const parsed = parseRecipeText(text);
        if (!parsed.ok || !parsed.recipe) {
          throw new Error(parsed.error ?? 'schema không hợp lệ');
        }
        recipe = parsed.recipe;
      } else if (input.inline && typeof input.inline === 'object') {
        const parsed = RecipeSchema.safeParse(input.inline);
        if (!parsed.success) {
          throw new Error('inline không phải recipe hợp lệ');
        }
        recipe = parsed.data;
      } else {
        throw new Error('thiếu path hoặc inline');
      }
      if (recipe.sub_recipes?.length) {
        throw new Error('sub-recipe chứa sub_recipes (đệ quy bị cấm)');
      }
      resolved.push({
        name: input.name,
        recipe,
        mode: input.mode ?? 'parallel',
        returnMode: input.return_mode ?? 'summary',
        fixedValues: { ...(input.values ?? {}) },
      });
    } catch (err) {
      errors.push({ name: input.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { resolved, errors };
}

function joinPosix(base: string, rel: string): string {
  if (!base) return rel;
  return `${base.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`;
}

/* ---------------- zod mapping ---------------- */

function zodOfParameter(p: RecipeParameter): z.ZodTypeAny {
  switch (p.input_type) {
    case 'number':
      return z.number().describe(p.description ?? 'giá trị số');
    case 'boolean':
      return z.boolean().describe(p.description ?? 'true/false');
    case 'select':
      return (p.options && p.options.length > 0 ? z.enum(p.options as [string, ...string[]]) : z.string()).describe(
        p.description ?? 'chọn một giá trị',
      );
    default:
      return z.string().max(2_000).describe(p.description ?? 'giá trị text');
  }
}

/**
 * Zod schema cho tool của một sub-recipe: tham số fixed bị LOẠI khỏi schema
 * (model không truyền nữa — giá trị gắn cứng khi chạy), required → bắt buộc.
 */
export function buildSubRecipeParameters(
  parameters: readonly RecipeParameter[] | undefined,
  fixedValues: Record<string, string>,
): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of parameters ?? []) {
    if (p.key in fixedValues) continue;
    const base = zodOfParameter(p);
    shape[p.key] = p.requirement === 'required' ? base : base.optional();
  }
  return z.object(shape);
}

/** Mô tả tool hiển thị cho model. */
export function buildSubRecipeToolDescription(sub: ResolvedSubRecipe): string {
  const params = (sub.recipe.parameters ?? [])
    .filter((p) => !(p.key in sub.fixedValues))
    .map((p) => `${p.key}${p.requirement === 'required' ? '' : '?'}`)
    .join(', ');
  return (
    `Chạy sub-recipe "${sub.recipe.title}": ${sub.recipe.description.slice(0, 200)}` +
    (params ? ` Tham số: ${params}.` : '') +
    (Object.keys(sub.fixedValues).length
      ? ` (giá trị gắn sẵn: ${Object.entries(sub.fixedValues).map(([k, v]) => `${k}=${v}`).join(', ')})`
      : '') +
    ` Trả về ${sub.returnMode === 'summary' ? `tóm tắt ≤ ${SUBRECIPE_SUMMARY_CHARS} ký tự` : 'toàn bộ output'}.`
  );
}

/** Khối system mô tả bộ tool sub-recipe + hướng dẫn dùng batch song song. */
export function buildSubRecipeSystemBlock(subs: readonly ResolvedSubRecipe[]): string {
  if (!subs.length) return '';
  const lines = [
    '[SUB-RECIPES] Workflow này có các sub-recipe — mỗi cái là một tool chạy trong subagent context riêng:',
    ...subs.map(
      (s) =>
        `- ${subRecipeToolName(s.name)}: ${s.recipe.title}${s.mode === 'sequential' ? ' (gọi tuần tự, đợi cái trước xong)' : ''}`,
    ),
    `Dùng ${SUBRECIPE_BATCH_TOOL} để chạy NHIỀU sub-recipe SONG SONG (tối đa ${SUBRECIPE_PARALLEL_CONCURRENCY} cùng lúc) — ` +
      'danh sách calls giữ nguyên tên + args như tool đơn. Sub-recipe độc lập nên ưu tiên batch.',
    'Kết quả mỗi sub-recipe là JSON {status, result, turnsUsed, toolCalls}; status "failed"/"max-turns" → tự quyết làm lại hoặc làm phần thiếu trực tiếp.',
  ];
  return lines.join('\n');
}

/* ---------------- batch planning (thuần, test được) ---------------- */

export interface SubRecipeBatchCall {
  name: string;
  args?: Record<string, unknown>;
}

export type SubRecipeBatchPlan =
  | { ok: true; entries: Array<{ sub: ResolvedSubRecipe; args: Record<string, unknown> }> }
  | { ok: false; error: string };

/**
 * Validate batch calls: tên phải thuộc danh sách, không trùng (mỗi sub-recipe
 * chạy 1 lần trong batch), args là object thô (zod từng tool parse sau).
 */
export function planSubRecipeBatch(
  calls: readonly SubRecipeBatchCall[],
  subs: readonly ResolvedSubRecipe[],
): SubRecipeBatchPlan {
  if (!calls.length) return { ok: false, error: 'Batch rỗng — truyền ít nhất một call {name, args}.' };
  const byName = new Map(subs.map((s) => [s.name, s]));
  const seen = new Set<string>();
  const entries: Array<{ sub: ResolvedSubRecipe; args: Record<string, unknown> }> = [];
  for (const c of calls) {
    const sub = byName.get(c.name);
    if (!sub) {
      return { ok: false, error: `Sub-recipe "${c.name}" không thuộc workflow này. Hợp lệ: ${[...byName.keys()].join(', ')}.` };
    }
    if (seen.has(c.name)) {
      return { ok: false, error: `Sub-recipe "${c.name}" xuất hiện hai lần trong batch — mỗi cái chỉ chạy một lần.` };
    }
    seen.add(c.name);
    const args =
      c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? (c.args as Record<string, unknown>) : {};
    entries.push({ sub, args });
  }
  return { ok: true, entries };
}

/** Ép kết quả theo return_mode: summary cắt trần + ghi chú; full giữ nguyên. */
export function formatSubRecipeResult(
  text: string,
  returnMode: 'full' | 'summary',
  cap: number = SUBRECIPE_SUMMARY_CHARS,
): string {
  const trimmed = text.trim();
  if (returnMode === 'full' || trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap)}\n…[tóm tắt đã cắt ở ${cap} ký tự — gọi lại tool với return_mode "full" nếu cần nguyên văn]`;
}

/** Prompt cho subagent sub-recipe: system + first message + chỉ dẫn tóm tắt. */
export function buildSubRecipeInstructions(
  systemAppend: string,
  firstUserMessage: string,
  returnMode: 'full' | 'summary',
): string {
  const blocks = [systemAppend, firstUserMessage].filter((b) => b.trim().length > 0).join('\n\n---\n\n');
  if (returnMode === 'summary') {
    return (
      `${blocks}\n\n[KẾT QUẢ] Khi hoàn thành, KẾT THÚC bằng một tóm tắt không quá ${SUBRECIPE_SUMMARY_CHARS} ký tự: ` +
      'việc đã làm, kết quả chính, số liệu/test liên quan. Đừng dán nguyên log dài.'
    );
  }
  return `${blocks}\n\n[KẾT QUẢ] Trả kết quả đầy đủ.`;
}
