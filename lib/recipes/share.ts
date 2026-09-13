/**
 * Share recipe qua link: encode JSON deflate + base64url vào ?recipe=.
 *
 * Bảo mật hướng dùng: link CHỈ mở preview — không bao giờ tự chạy (user phải
 * bấm Run sau khi xem nội dung). Decode validate bằng RecipeSchema nên
 * payload bẻ cong sẽ bị từ chối ngay cửa.
 */

import { deflate, inflate } from 'pako';
import { RecipeSchema, type Recipe } from './schema';

/** Trần độ dài chuỗi param trên URL (đủ cho recipe vài chục KB nén). */
export const RECIPE_PARAM_MAX_CHARS = 60_000;

export function encodeRecipeParam(recipe: Recipe): string {
  const json = JSON.stringify(RecipeSchema.parse(recipe));
  const bytes = deflate(json);
  return toBase64Url(bytes);
}

export function buildRecipeShareLink(recipe: Recipe, baseUrl?: string): string {
  const param = encodeRecipeParam(recipe);
  const base = baseUrl ?? (typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '/');
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}recipe=${param}`;
}

export interface DecodedRecipeParam {
  ok: boolean;
  recipe?: Recipe;
  error?: string;
}

export function decodeRecipeParam(param: string): DecodedRecipeParam {
  if (!param || param.length > RECIPE_PARAM_MAX_CHARS) {
    return { ok: false, error: 'Liên kết recipe rỗng hoặc quá dài.' };
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(param);
  } catch {
    return { ok: false, error: 'Liên kết recipe không decode được (base64url hỏng).' };
  }
  let json: string;
  try {
    // TextDecoder thay cho `{to:'string'}` của pako — bản pako đang cài trả
    // byte-array cho option đó, TextDecoder đúng chuẩn ở cả node lẫn browser.
    json = new TextDecoder().decode(inflate(bytes));
  } catch {
    return { ok: false, error: 'Liên kết recipe không giải nén được (deflate hỏng).' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Liên kết recipe chứa JSON không hợp lệ.' };
  }
  const parsed = RecipeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'Recipe trong liên kết không hợp lệ hoặc sai schema.' };
  }
  return { ok: true, recipe: parsed.data };
}

/* ------------------------- base64url (không padding) ------------------------ */

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
