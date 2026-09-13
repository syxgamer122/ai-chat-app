/**
 * Recipe CRUD trên Dexie (bảng `recipes`, schema v12) + discovery từ
 * workspace `.vyen/recipes/*.yaml|json`.
 *
 * Discovery nhận adapter fs (list + read text) để chạy được cả trên web
 * (File System Access API) lẫn desktop (bridge IPC) mà lib vẫn test trong
 * node bằng adapter giả.
 */

import { parse as parseYaml } from 'yaml';
import { db, type RecipeRecord } from '@/lib/db';
import { parseRecipeText, type RecipeFormat } from './parse';
import { RecipeSchema, type Recipe } from './schema';

function newRecipeId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `rcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export interface SaveRecipeInput {
  recipe: Recipe;
  format?: RecipeFormat;
  source?: RecipeRecord['source'];
  /** Cập nhật bản ghi hiện có (import lại đè). */
  id?: string;
}

/** Lưu recipe: serialize + validate trước khi ghi, tự sinh id/updatedAt. */
export async function saveRecipe(input: SaveRecipeInput): Promise<RecipeRecord> {
  const { serializeRecipe } = await import('./parse');
  const format = input.format ?? 'yaml';
  const content = serializeRecipe(input.recipe, format);
  const now = Date.now();
  const existing = input.id ? await db.recipes.get(input.id) : undefined;
  const record: RecipeRecord = {
    id: existing?.id ?? newRecipeId(),
    title: input.recipe.title,
    format,
    content,
    source: input.source ?? existing?.source ?? 'local',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.recipes.put(record);
  return record;
}

export async function listRecipes(): Promise<RecipeRecord[]> {
  try {
    return await db.recipes.orderBy('updatedAt').reverse().toArray();
  } catch {
    return [];
  }
}

export async function getRecipe(id: string): Promise<RecipeRecord | undefined> {
  return db.recipes.get(id);
}

/**
 * Đọc lại Recipe từ record Dexie (content yaml/json). Record hỏng (DB bị sửa
 * tay) trả null thay vì throw — UI lọc bỏ, không sập panel.
 */
export function readRecipeRecord(record: RecipeRecord): Recipe | null {
  try {
    const raw: unknown =
      record.format === 'json' ? JSON.parse(record.content) : parseYaml(record.content);
    return RecipeSchema.parse(raw);
  } catch {
    return null;
  }
}

export async function deleteRecipe(id: string): Promise<void> {
  await db.recipes.delete(id);
}

/** Import từ text (yaml/json) — parse + validate rồi lưu với source 'imported'. */
export async function importRecipeText(
  text: string,
  source: RecipeRecord['source'] = 'imported',
): Promise<{ ok: true; record: RecipeRecord } | { ok: false; error: string }> {
  const parsed = parseRecipeText(text);
  if (!parsed.ok || !parsed.recipe) {
    return { ok: false, error: parsed.error ?? 'Recipe không hợp lệ.' };
  }
  const record = await saveRecipe({
    recipe: parsed.recipe,
    format: parsed.format ?? 'yaml',
    source,
  });
  return { ok: true, record };
}

/* --------------------- Discovery từ workspace --------------------- */

/** Adapter fs tối thiểu để quét .vyen/recipes — web và desktop cùng shape. */
export interface RecipeFsAdapter {
  /** Trả đường dẫn tương đối của file trong .vyen/recipes (vd 'a.yaml'). */
  listRecipeFiles(): Promise<string[]>;
  readText(relPath: string): Promise<string>;
}

export interface DiscoveredRecipe {
  path: string;
  recipe: Recipe;
}

const RECIPE_FILE_RE = /\.(ya?ml|json)$/i;

/**
 * Quét thư mục `.vyen/recipes` qua adapter: trả recipe hợp lệ kèm path;
 * file hỏng bị bỏ qua kèm lỗi để UI cảnh báo mà không chặn cả lô.
 */
export async function discoverWorkspaceRecipes(
  adapter: RecipeFsAdapter,
): Promise<{ recipes: DiscoveredRecipe[]; errors: Array<{ path: string; error: string }> }> {
  const files: string[] = [];
  try {
    files.push(...(await adapter.listRecipeFiles()));
  } catch {
    return { recipes: [], errors: [] };
  }
  const recipes: DiscoveredRecipe[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  for (const file of files) {
    if (!RECIPE_FILE_RE.test(file)) continue;
    try {
      const text = await adapter.readText(file);
      const parsed = parseRecipeText(text);
      if (parsed.ok && parsed.recipe) recipes.push({ path: file, recipe: parsed.recipe });
      else errors.push({ path: file, error: parsed.error ?? 'schema không hợp lệ' });
    } catch (err) {
      errors.push({ path: file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { recipes, errors };
}
