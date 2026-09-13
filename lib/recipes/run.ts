/**
 * Recipe → chat pipeline: dựng các mảnh để feed vào luồng /api/chat HIỆN CÓ
 * (không tạo route mới): systemAppend đi qua body.recipe, firstUserMessage là
 * user message bình thường, toolPolicy lọc tool client ở route, settings do
 * client áp lên lượt gửi.
 *
 * Thuần function — không Dexie, không fetch.
 */

import type {
  Recipe,
  RecipeParamValues,
  RecipeParameter,
  RecipeSettings,
} from './schema';
import { renderTemplate } from './render';
import { structuredOutputDirective } from './retry';

export interface ResolvedParameters {
  values: RecipeParamValues;
  /** Tham số required chưa có giá trị (form phải bắt nhập trước khi Run). */
  missing: string[];
  /** Tham số user_prompt cần HỎI người dùng lúc Run (không dùng default). */
  needsPrompt: string[];
}

/**
 * Resolve tham số: required phải có (provided hoặc default), optional lấy
 * default rồi mới '', user_prompt luôn chờ người dùng nhập lúc Run.
 */
export function resolveParameters(
  recipe: Pick<Recipe, 'parameters'>,
  provided: RecipeParamValues,
): ResolvedParameters {
  const values: RecipeParamValues = {};
  const missing: string[] = [];
  const needsPrompt: string[] = [];

  for (const p of recipe.parameters ?? []) {
    if (p.requirement === 'user_prompt') {
      if (p.key in provided && provided[p.key] !== '') {
        values[p.key] = provided[p.key];
      } else {
        needsPrompt.push(p.key);
      }
      continue;
    }
    if (p.key in provided && provided[p.key] !== '') {
      values[p.key] = provided[p.key];
    } else if (p.default !== undefined) {
      values[p.key] = p.default;
    } else if (p.requirement === 'required') {
      missing.push(p.key);
    }
    // optional không default → rỗng ({{#if}} sẽ bỏ khối).
    else values[p.key] = '';
  }
  return { values, missing, needsPrompt };
}

export interface RecipeToolPolicy {
  allow: string[];
  deny: string[];
}

export interface PreparedRecipeRun {
  /** Khối system bổ sung — gửi qua body.recipe.instructions. */
  systemAppend: string;
  /** User message mở đầu hội thoại. */
  firstUserMessage: string;
  toolPolicy: RecipeToolPolicy;
  /** Tên MCP server cần bật (route/UI đối chiếu với server đang kết nối). */
  mcpServers: string[];
  settings: Partial<RecipeSettings>;
  values: RecipeParamValues;
}

export interface PrepareRunOptions {
  /** Thư mục chứa file recipe trong workspace (cho {{ recipe_dir }}). */
  recipeDir?: string;
  /** Chỉ thị JSON-strict có cần kèm (recipe có json_schema) không. */
  includeStructuredDirective?: boolean;
}

/** Dùng description làm prompt mở đầu khi recipe không khai báo prompt. */
function fallbackFirstMessage(recipe: Recipe): string {
  const lines = [`# ${recipe.title}`, '', recipe.description];
  if (recipe.activities?.length) {
    lines.push('', 'Việc có thể làm:', ...recipe.activities.map((a) => `- ${a}`));
  }
  lines.push('', 'Hãy thực hiện workflow này theo instructions đã cấp ở trên.');
  return lines.join('\n');
}

/**
 * Dựng toàn bộ mảnh chạy recipe. Các chuỗi template đều được render one-pass
 * (xem render.ts) — giá trị tham số không bao giờ được eval lại.
 */
export function prepareRecipeRun(
  recipe: Recipe,
  values: RecipeParamValues,
  opts: PrepareRunOptions = {},
): PreparedRecipeRun {
  const vars: RecipeParamValues = { ...values };
  if (opts.recipeDir !== undefined && !('recipe_dir' in vars)) {
    vars.recipe_dir = opts.recipeDir;
  }

  const instructionBlocks: string[] = [];
  if (recipe.instructions?.trim()) {
    instructionBlocks.push(renderTemplate(recipe.instructions, vars));
  }

  const firstUserMessage = recipe.prompt?.trim()
    ? renderTemplate(recipe.prompt, vars)
    : fallbackFirstMessage(recipe);

  let systemAppend = '';
  if (instructionBlocks.length) {
    systemAppend = `[RECIPE: ${recipe.title}]\n${instructionBlocks.join('\n\n')}`;
  }

  if (opts.includeStructuredDirective && recipe.response?.json_schema) {
    const directive = structuredOutputDirective(JSON.stringify(recipe.response.json_schema));
    systemAppend = systemAppend ? `${systemAppend}\n\n${directive}` : directive;
  }

  return {
    systemAppend,
    firstUserMessage,
    toolPolicy: {
      allow: recipe.tools?.allow ?? [],
      deny: recipe.tools?.deny ?? [],
    },
    mcpServers: recipe.mcp ?? [],
    settings: pickSettings(recipe.settings),
    values: vars,
  };
}

/** Chỉ giữ các field có giá trị — tránh override settings toàn rỗng. */
export function pickSettings(s: RecipeSettings | undefined): Partial<RecipeSettings> {
  if (!s) return {};
  const out: Partial<RecipeSettings> = {};
  for (const key of ['provider', 'model', 'reasoningLevel', 'temperature', 'autoPilot'] as const) {
    const v = s[key];
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

/** Danh sách tham số cần hỏi theo thứ tự khai báo — cho form UI. */
export function parametersNeedingInput(
  parameters: readonly RecipeParameter[] | undefined,
): RecipeParameter[] {
  return (parameters ?? []).filter((p) => p.requirement !== 'optional' || p.default === undefined);
}

/**
 * Bọc giá trị tham số vào user message khi requirement = user_prompt —
 * người dùng nhập lúc Run, giá trị được dán rõ ràng vào tin nhắn để agent
 * thấy như một phần yêu cầu.
 */
export function appendUserPromptAnswers(
  message: string,
  answers: Record<string, string | number | boolean>,
): string {
  const entries = Object.entries(answers).filter(([, v]) => String(v).trim() !== '');
  if (!entries.length) return message;
  const lines = entries.map(([k, v]) => `- ${k}: ${String(v)}`);
  return `${message}\n\n[Tham số]\n${lines.join('\n')}`;
}
