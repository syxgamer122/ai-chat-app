/**
 * Structured output cho recipe: trích JSON từ câu trả lời cuối, validate theo
 * json_schema khai báo trong recipe, và định dạng MỘT DÒNG duy nhất để CI
 * parse được (acceptance: `--output json` in JSON hợp schema).
 *
 * Validator là tập con JSON Schema đủ dùng cho output của model:
 * type / required / properties / items / enum — không dùng thêm keyword nào
 * (mọi keyword lạ bị bỏ qua, không throw).
 */

export interface JsonSchemaLike {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
  enum?: unknown[];
}

export interface StructuredExtract {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Trích JSON từ text model: ưu tiên fenced ```json, rồi khối {...}/[...]
 * CÂN BẰNG ĐẦU TIÊN (đếm ngoặc, bỏ qua ngoặc trong chuỗi).
 */
export function extractJsonPayload(text: string): StructuredExtract {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text.trim());

  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (direct !== undefined) return { ok: true, value: direct };
    const balanced = extractFirstBalanced(candidate);
    if (balanced !== null) {
      const parsed = tryParse(balanced);
      if (parsed !== undefined) return { ok: true, value: parsed };
    }
  }
  return { ok: false, error: 'Không tìm thấy khối JSON hợp lệ trong câu trả lời.' };
}

function tryParse(s: string): unknown | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Tìm chuỗi con {...} hoặc [...] đầu tiên có ngoặc cân bằng. */
function extractFirstBalanced(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface SchemaValidation {
  ok: boolean;
  errors: string[];
}

/** Validate giá trị đã parse theo tập con JSON Schema. */
export function validateAgainstJsonSchema(value: unknown, schema: JsonSchemaLike, path = ''): SchemaValidation {
  const errors: string[] = [];
  walk(value, schema, path, errors);
  return { ok: errors.length === 0, errors };
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function walk(value: unknown, schema: JsonSchemaLike, path: string, errors: string[]): void {
  const at = (p: string) => (path ? `${path}.${p}` : p);

  if (schema.type) {
    const actual = typeOf(value);
    // integer là number; number chấp nhận cả integer.
    const matches =
      schema.type === actual ||
      (schema.type === 'number' && actual === 'integer');
    if (!matches) {
      errors.push(`${path || '(gốc)'}: cần ${schema.type}, nhận ${actual}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path || '(gốc)'}: giá trị không nằm trong enum`);
  }
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) {
        errors.push(`${at(key)}: thiếu field bắt buộc`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj && obj[key] !== undefined) {
        walk(obj[key], sub, at(key), errors);
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (schema.items) walk(value[i], schema.items, `${at(String(i))}`, errors);
    }
  }
}

export interface StructuredResultLine {
  recipe: string;
  ok: boolean;
  data?: unknown;
  errors?: string[];
}

/**
 * Định dạng kết quả structured MỘT DÒNG (không xuống dòng) — CI đọc bằng
 * jq được ngay. OK: {"recipe":...,"ok":true,"data":{...}}
 */
export function formatStructuredLine(input: StructuredResultLine): string {
  const payload:
    | { recipe: string; ok: true; data: unknown }
    | { recipe: string; ok: false; errors: string[] } =
    input.ok
      ? { recipe: input.recipe, ok: true, data: input.data ?? null }
      : { recipe: input.recipe, ok: false, errors: input.errors ?? ['unknown'] };
  return JSON.stringify(payload);
}

/**
 * Pipeline đầy đủ: text model → JSON → validate schema → { ok, value | errors }.
 */
export function processStructuredOutput(
  finalText: string,
  jsonSchema: JsonSchemaLike | undefined,
): { ok: boolean; value?: unknown; errors: string[] } {
  const extracted = extractJsonPayload(finalText);
  if (!extracted.ok) return { ok: false, errors: [extracted.error ?? 'Không trích được JSON.'] };
  if (!jsonSchema) return { ok: true, value: extracted.value, errors: [] };
  const validation = validateAgainstJsonSchema(extracted.value, jsonSchema);
  return {
    ok: validation.ok,
    ...(validation.ok ? { value: extracted.value } : {}),
    errors: validation.errors,
  };
}
