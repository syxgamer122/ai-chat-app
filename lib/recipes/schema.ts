/**
 * Recipe Schema — đóng gói workflow tái sử dụng (port mô hình Goose recipe).
 *
 * Recipe ≠ prompt mẫu: ngoài text nó gói cả tham số, tool policy, model
 * settings, success-check + retry, structured output và sub-recipe — một
 * workflow chạy lại được y hệt và chia sẻ được qua link.
 *
 * Zod là nguồn sự thật duy nhất; mọi nơi (Dexie, share link, CLI, UI form)
 * đều parse qua schema này. Thuần function, test được trong node.
 */

import { z } from 'zod';

export const RECIPE_SCHEMA_VERSION = '1.0.0' as const;

/** Trần kích thước chung — đồng bộ với các tầng gửi lên /api/chat. */
export const RECIPE_LIMITS = {
  titleChars: 120,
  descriptionChars: 2_000,
  instructionsChars: 12_000,
  promptChars: 12_000,
  maxActivities: 10,
  activityChars: 200,
  maxParameters: 16,
  keyChars: 40,
  descriptionFieldChars: 500,
  maxOptions: 12,
  optionChars: 200,
  maxTools: 50,
  toolNameChars: 200,
  maxMcp: 10,
  maxRetries: 5,
  maxChecks: 5,
  commandChars: 4_000,
  onFailureChars: 4_000,
  maxSubRecipes: 8,
  valuesEntries: 16,
} as const;

const ParameterSchema = z.object({
  key: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Chỉ chữ cái, số, _ ; không bắt đầu bằng số')
    .max(RECIPE_LIMITS.keyChars),
  input_type: z.enum(['string', 'number', 'boolean', 'select']),
  requirement: z.enum(['required', 'optional', 'user_prompt']),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string().min(1).max(RECIPE_LIMITS.optionChars)).max(RECIPE_LIMITS.maxOptions).optional(),
  description: z.string().max(RECIPE_LIMITS.descriptionFieldChars).optional(),
});

const SettingsSchema = z.object({
  provider: z.string().max(200).optional(),
  model: z.string().max(120).optional(),
  reasoningLevel: z.enum(['low', 'medium', 'high', 'max']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  autoPilot: z.boolean().optional(),
});

const RetrySchema = z.object({
  /** Số lần CHẠY LẠI tối đa sau lần chạy đầu (tổng tối đa = 1 + max_retries). */
  max_retries: z.number().int().min(0).max(RECIPE_LIMITS.maxRetries),
  timeout_seconds: z.number().int().min(5).max(600).optional(),
  checks: z
    .array(
      z.object({
        type: z.literal('shell'),
        command: z.string().min(1).max(RECIPE_LIMITS.commandChars),
      }),
    )
    .max(RECIPE_LIMITS.maxChecks),
  on_failure: z.string().max(RECIPE_LIMITS.onFailureChars).optional(),
});

/**
 * Sub-recipe: inline giữ dạng record thô (KHÔNG đệ quy schema tĩnh — circular
 * inference); nội dung inline được parse đệ quy bằng chính RecipeSchema ở
 * THỜI ĐIỂM DÙNG (lib/recipes). superRefine vẫn chặn inline lồng sub_recipes.
 */
const SubRecipeSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/).max(60),
  /** Đường dẫn tới file recipe khác trong workspace (tương đối, .yaml/.json). */
  path: z.string().min(1).max(500).optional(),
  /** Hoặc recipe nhúng nguyên văn (object). path và inline loại trừ nhau. */
  inline: z.record(z.unknown()).optional(),
  values: z.record(z.string()).optional(),
  mode: z.enum(['sequential', 'parallel']).optional(),
  /** 'summary' (mặc định): subagent tự tóm tắt ≤ 2000 ký tự để không phình
   *  context agent chính. 'full': trả nguyên văn output. */
  return_mode: z.enum(['full', 'summary']).optional(),
});

export const RecipeSchema = z
  .object({
    version: z.literal(RECIPE_SCHEMA_VERSION),
    title: z.string().min(1).max(RECIPE_LIMITS.titleChars),
    description: z.string().min(1).max(RECIPE_LIMITS.descriptionChars),
    instructions: z.string().max(RECIPE_LIMITS.instructionsChars).optional(),
    prompt: z.string().max(RECIPE_LIMITS.promptChars).optional(),
    activities: z.array(z.string().min(1).max(RECIPE_LIMITS.activityChars)).max(RECIPE_LIMITS.maxActivities).optional(),
    parameters: z.array(ParameterSchema).max(RECIPE_LIMITS.maxParameters).optional(),
    tools: z
      .object({
        allow: z.array(z.string().min(1).max(RECIPE_LIMITS.toolNameChars)).max(RECIPE_LIMITS.maxTools).optional(),
        deny: z.array(z.string().min(1).max(RECIPE_LIMITS.toolNameChars)).max(RECIPE_LIMITS.maxTools).optional(),
      })
      .optional(),
    mcp: z.array(z.string().min(1).max(120)).max(RECIPE_LIMITS.maxMcp).optional(),
    settings: SettingsSchema.optional(),
    response: z
      .object({
        /** JSON Schema (bản object thô) mô tả output mong muốn. */
        json_schema: z.record(z.unknown()).optional(),
      })
      .optional(),
    retry: RetrySchema.optional(),
    sub_recipes: z.array(SubRecipeSchema).max(RECIPE_LIMITS.maxSubRecipes).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    // instructions hoặc prompt phải có ít nhất một — recipe trống text là vô nghĩa.
    const hasInstructions = typeof r.instructions === 'string' && r.instructions.trim().length > 0;
    const hasPrompt = typeof r.prompt === 'string' && r.prompt.trim().length > 0;
    if (!hasInstructions && !hasPrompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instructions'],
        message: 'Recipe cần `instructions` hoặc `prompt` (ít nhất một field khác rỗng).',
      });
    }
    // select bắt buộc có options; default (nếu có) phải nằm trong options.
    for (const [i, p] of (r.parameters ?? []).entries()) {
      if (p.input_type === 'select') {
        if (!p.options || p.options.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['parameters', i, 'options'],
            message: `Tham số select "${p.key}" phải có danh sách options (≥1).`,
          });
        } else if (typeof p.default === 'string' && !p.options.includes(p.default)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['parameters', i, 'default'],
            message: `Default "${p.default}" không nằm trong options của "${p.key}".`,
          });
        }
      }
      if (p.default !== undefined) {
        const t = typeof p.default;
        const mismatch =
          (p.input_type === 'string' && t !== 'string') ||
          (p.input_type === 'number' && t !== 'number') ||
          (p.input_type === 'boolean' && t !== 'boolean') ||
          (p.input_type === 'select' && t !== 'string');
        if (mismatch) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['parameters', i, 'default'],
            message: `Default của "${p.key}" phải là ${p.input_type}.`,
          });
        }
      }
    }
    // key tham số không trùng nhau.
    const keys = new Set<string>();
    for (const [i, p] of (r.parameters ?? []).entries()) {
      if (keys.has(p.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parameters', i, 'key'],
          message: `Tham số "${p.key}" bị khai báo hai lần.`,
        });
      }
      keys.add(p.key);
    }
    // sub-recipe: path XOR inline; recipe nhúng KHÔNG được chứa sub_recipes
    // (chặn đệ quy vô hạn ngay từ schema).
    for (const [i, s] of (r.sub_recipes ?? []).entries()) {
      if (!s.path && !s.inline) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sub_recipes', i],
          message: `Sub-recipe "${s.name}" cần path hoặc inline.`,
        });
      }
      if (s.path && s.inline) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sub_recipes', i],
          message: `Sub-recipe "${s.name}" chỉ dùng MỘT trong path/inline.`,
        });
      }
      const nested = (s.inline as Record<string, unknown> | undefined)?.sub_recipes;
      if (Array.isArray(nested) && nested.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sub_recipes', i, 'inline', 'sub_recipes'],
          message: `Sub-recipe lồng nhau không được chứa sub_recipes tiếp (chống đệ quy).`,
        });
      }
    }
  });

export type Recipe = z.infer<typeof RecipeSchema>;
export type RecipeParameter = z.infer<typeof ParameterSchema>;
export type RecipeSettings = z.infer<typeof SettingsSchema>;
export type RecipeRetry = z.infer<typeof RetrySchema>;
export type RecipeSubRecipe = z.infer<typeof SubRecipeSchema>;

/** Giá trị tham số đã resolve (string hoá cho render, number/boolean giữ nguyên). */
export type RecipeParamValues = Record<string, string | number | boolean>;

export interface RecipeParseResult {
  ok: boolean;
  recipe?: Recipe;
  /** Thông điệp lỗi đã định dạng (kèm đường dẫn field) — hiện thẳng trong UI. */
  error?: string;
}

/** Format zod error thành chuỗi ngắn gọn tiếng Việt, có path. */
export function formatRecipeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`)
    .join(' · ');
}

/** Parse object thô (từ YAML/JSON đã decode) qua schema, kèm lỗi định dạng. */
export function parseRecipeObject(raw: unknown): RecipeParseResult {
  const parsed = RecipeSchema.safeParse(raw);
  if (parsed.success) return { ok: true, recipe: parsed.data };
  return { ok: false, error: formatRecipeIssues(parsed.error) };
}
