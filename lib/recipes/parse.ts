/**
 * Parse/serialize recipe từ text (YAML hoặc JSON).
 *
 * JSON nhận nếu chuỗi bắt đầu bằng '{' (sau trim); còn lại coi là YAML
 * (chuẩn Goose dùng YAML cho recipe). Cả hai đường đều đi qua RecipeSchema.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { RecipeSchema, parseRecipeObject, type Recipe, type RecipeParseResult } from './schema';

/** Trần kích thước text recipe chấp nhận đọc (file hoặc share-link decode). */
export const RECIPE_TEXT_MAX_CHARS = 200_000;

export type RecipeFormat = 'yaml' | 'json';

export function detectRecipeFormat(text: string): RecipeFormat {
  return text.trimStart().startsWith('{') ? 'json' : 'yaml';
}

/** Parse text recipe → Recipe. Lỗi YAML/JSON/schema đều ra error định dạng. */
export function parseRecipeText(text: string): RecipeParseResult & { format?: RecipeFormat } {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, error: 'File recipe rỗng.' };
  if (trimmed.length > RECIPE_TEXT_MAX_CHARS) {
    return { ok: false, error: `Recipe vượt trần ${RECIPE_TEXT_MAX_CHARS} ký tự.` };
  }
  const format = detectRecipeFormat(trimmed);
  let raw: unknown;
  try {
    raw = format === 'json' ? JSON.parse(trimmed) : parseYaml(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: `${format.toUpperCase()} không hợp lệ: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = parseRecipeObject(raw);
  return { ...result, format };
}

/** Serialize recipe ra YAML (mặc định) hoặc JSON — dùng cho nút Export. */
export function serializeRecipe(recipe: Recipe, format: RecipeFormat = 'yaml'): string {
  // Đảm bảo object đã qua schema (bỏ field rác) trước khi ghi ra.
  const clean = RecipeSchema.parse(recipe);
  return format === 'json'
    ? `${JSON.stringify(clean, null, 2)}\n`
    : stringifyYaml(clean, { lineWidth: 120 });
}
