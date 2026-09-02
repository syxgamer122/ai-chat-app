/**
 * MCP Tool Mapper — cầu giữa MCP protocol và Vercel AI SDK.
 *
 * Ba việc, ba lý do tồn tại riêng biệt:
 *  1. Đặt tên tool (`mcpToolKey`): MCP cho phép tên tool là BẤT KỲ chuỗi nào,
 *     còn gateway OpenAI-compatible chỉ nhận `^[A-Za-z0-9_-]{1,64}$`. Không
 *     chuẩn hoá thì một server đặt tên "read file" làm gateway từ chối CẢ gói
 *     tools và agent mất sạch khả năng gọi tool.
 *  2. Chuyển JSON Schema → Zod (`jsonSchemaToZod`): AI SDK cần Zod.
 *  3. Dựng tool KHÔNG CÓ execute (`mapMcpTools`): MCP chạy trong Electron
 *     main, trong khi mô hình được gọi từ route Next.js — server không có
 *     đường sang IPC nên chỉ được khai báo tool, việc thực thi thuộc về
 *     renderer (giống hệt fs_* và shell_run).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { truncateToolResult } from '@/lib/tool-limits';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Canonical shape — desktop-bridge.ts alias lại thành KodaMcpToolInfo. */
export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON Schema như MCP server công bố. */
  inputSchema: Record<string, unknown>;
  serverId: string;
  serverName: string;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content: McpContentBlock[];
  /** Tool chạy xong và TỰ báo lỗi nghiệp vụ (khác lỗi giao thức). */
  isError?: boolean;
  /** Bị policy "luôn từ chối" hoặc người dùng bấm từ chối. */
  denied?: boolean;
}

/* ------------------------------------------------------------------ */
/* Tên tool                                                            */
/* ------------------------------------------------------------------ */

export const MCP_TOOL_PREFIX = 'mcp';

/**
 * Trần độ dài tên function của gateway OpenAI-compatible.
 * Vượt qua bị cắt hoặc bị từ chối tuỳ gateway — cắt ở đây để có kiểm soát.
 */
const MAX_TOOL_NAME_LENGTH = 64;

/** Trần số tool MCP đưa vào một request (bảo vệ ngữ cảnh + payload). */
export const MAX_MCP_TOOLS = 100;

/** Trần mô tả tool — mô tả dài ăn token của mọi request mà không có ích. */
const MAX_DESCRIPTION_CHARS = 1000;

function sanitizeToolNamePart(raw: string): string {
  return (raw ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * FNV-1a 32-bit, base36. Chỉ dùng để giữ cho hai tên tool DÀI khác nhau không
 * đụng nhau sau khi cắt — không phải hàm băm mật mã.
 */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Tên tool mà model (và gateway) nhìn thấy: `mcp__<serverId>__<toolName>`.
 *
 * THUẦN VÀ TẤT ĐỊNH — server (route.ts) và renderer (chat-interface) cùng gọi
 * hàm này trên cùng một danh sách, nên hai bên luôn đồng thuận về tên mà
 * không cần truyền kèm mapping. Đổi công thức ở đây là đổi giao thức giữa
 * hai bên, phải đổi cả test.
 */
export function mcpToolKey(serverId: string, toolName: string): string {
  const server = sanitizeToolNamePart(serverId) || 'server';
  const toolNamePart = sanitizeToolNamePart(toolName) || 'tool';
  const key = `${MCP_TOOL_PREFIX}__${server}__${toolNamePart}`;
  if (key.length <= MAX_TOOL_NAME_LENGTH) return key;

  // Cắt + gắn hàm băm của TÊN ĐẦY ĐỦ: cùng một cặp (server, tool) luôn ra
  // cùng một tên, hai tên khác nhau không đụng nhau chỉ vì chung tiền tố.
  const suffix = shortHash(key);
  const budget = Math.max(1, MAX_TOOL_NAME_LENGTH - suffix.length - 1);
  return `${key.slice(0, budget)}_${suffix}`;
}

/** true khi tên tool do model gọi là một tool MCP. */
export function isMcpToolKey(name: string): boolean {
  return name.startsWith(`${MCP_TOOL_PREFIX}__`);
}

/* ------------------------------------------------------------------ */
/* JSON Schema → Zod                                                   */
/* ------------------------------------------------------------------ */

/** Giới hạn lồng nhau — schema tự tham chiếu sẽ bị chặn ở đây thay vì tràn stack. */
const MAX_SCHEMA_DEPTH = 6;

interface SchemaContext {
  root: Record<string, unknown>;
  depth: number;
}

function resolveRef(schema: Record<string, unknown>, ctx: SchemaContext): Record<string, unknown> | null {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return null;
  // Chỉ hỗ trợ $ref nội bộ (#/$defs/X, #/definitions/X) — $ref ra ngoài tệp
  // (URL) không thể giải ở đây và rơi về z.any().
  const match = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (!match) return null;
  const defs = (ctx.root.$defs ?? ctx.root.definitions) as Record<string, unknown> | undefined;
  const target = defs?.[match[1]];
  return target && typeof target === 'object' ? (target as Record<string, unknown>) : null;
}

/** Gộp các nhánh allOf thành MỘT schema object (trường hợp gặp trong thực tế). */
function mergeAllOf(schema: Record<string, unknown>, ctx: SchemaContext): Record<string, unknown> | null {
  const branches = schema.allOf;
  if (!Array.isArray(branches) || branches.length === 0) return null;

  const properties: Record<string, unknown> = {};
  const required = new Set<string>();

  for (const branch of branches) {
    if (!branch || typeof branch !== 'object') return null;
    const resolved = resolveRef(branch as Record<string, unknown>, ctx) ?? (branch as Record<string, unknown>);
    if (resolved.allOf || resolved.anyOf || resolved.oneOf || resolved.$ref) return null;
    const branchProps = resolved.properties as Record<string, unknown> | undefined;
    if (branchProps && typeof branchProps === 'object') Object.assign(properties, branchProps);
    if (Array.isArray(resolved.required)) {
      for (const key of resolved.required) if (typeof key === 'string') required.add(key);
    }
  }

  return { type: 'object', properties, required: Array.from(required) };
}

/**
 * `anyOf`/`oneOf` thường chỉ là "hoặc null". Nhánh đó xử lý được; mọi dạng
 * union khác rơi về z.any() vì gateway OpenAI-compatible không mô tả tốt
 * union và zod union hay làm gateway từ chối payload.
 */
function unwrapNullableUnion(schema: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    const nonNull = branches.filter(
      (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type !== 'null',
    );
    const hasNull = branches.some(
      (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'null',
    );
    if (hasNull && nonNull.length === 1) return nonNull[0] as Record<string, unknown>;
  }
  return null;
}

/**
 * Convert JSON Schema object sang Zod schema.
 * Không hỗ trợ được thì rơi về `z.any()` — model vẫn gọi được tool, chỉ mất
 * lớp validate kiểu. An toàn hơn là từ chối tool vì schema lạ.
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  return toZod(schema, { root: schema ?? {}, depth: 0 });
}

function toZod(schema: Record<string, unknown>, ctx: SchemaContext): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.any();
  if (ctx.depth > MAX_SCHEMA_DEPTH) return z.any();

  const refTarget = resolveRef(schema, ctx);
  if (refTarget) {
    return toZod(refTarget, { root: ctx.root, depth: ctx.depth + 1 });
  }

  const mergedAllOf = mergeAllOf(schema, ctx);
  if (mergedAllOf) {
    return toZod(mergedAllOf, { root: ctx.root, depth: ctx.depth + 1 });
  }

  const nullable = unwrapNullableUnion(schema);
  if (nullable) {
    return toZod(nullable, { root: ctx.root, depth: ctx.depth + 1 }).nullable();
  }

  const desc = typeof schema.description === 'string' ? schema.description : undefined;
  const next: SchemaContext = { root: ctx.root, depth: ctx.depth + 1 };
  let zodType = buildByType(schema, next);

  if (schema.nullable === true && typeof (zodType as { nullable?: unknown }).nullable === 'function') {
    zodType = (zodType as z.ZodTypeAny & { nullable: () => z.ZodTypeAny }).nullable();
  }

  return desc ? zodType.describe(desc) : zodType;
}

function buildByType(schema: Record<string, unknown>, ctx: SchemaContext): z.ZodTypeAny {
  // enum đứng TRƯỚC type: nhiều server chỉ khai `enum` mà không khai `type`.
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((v): v is string => typeof v === 'string');
    if (values.length > 0 && values.length === schema.enum.length) {
      return z.enum(values as [string, ...string[]]);
    }
    // enum hỗn hợp kiểu → không ép được, giữ lỏng.
    return z.any();
  }

  const type = schema.type as string | undefined;

  switch (type) {
    case 'string': {
      let s = z.string();
      if (typeof schema.minLength === 'number') s = s.min(schema.minLength);
      if (typeof schema.maxLength === 'number') s = s.max(schema.maxLength);
      if (typeof schema.pattern === 'string') {
        try {
          s = s.regex(new RegExp(schema.pattern));
        } catch {
          // Regex không hợp lệ trong schema của bên thứ ba: bỏ ràng buộc,
          // giữ kiểu string. Ném ở đây sẽ làm mất cả tool.
        }
      }
      return s;
    }

    case 'number':
    case 'integer': {
      let n = z.number();
      if (typeof schema.minimum === 'number') n = n.min(schema.minimum);
      if (typeof schema.maximum === 'number') n = n.max(schema.maximum);
      if (type === 'integer') n = n.int();
      return n;
    }

    case 'boolean':
      return z.boolean();

    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      let arr = z.array(items ? toZod(items, ctx) : z.any());
      if (typeof schema.minItems === 'number') arr = arr.min(schema.minItems);
      if (typeof schema.maxItems === 'number') arr = arr.max(schema.maxItems);
      return arr;
    }

    case 'object':
      return buildObject(schema, ctx);

    default:
      // Thiếu `type` nhưng có `properties` → cứ coi là object (phổ biến ở
      // schema sinh tự động từ TypeScript).
      if (schema.properties && typeof schema.properties === 'object') {
        return buildObject(schema, ctx);
      }
      return z.any();
  }
}

function buildObject(schema: Record<string, unknown>, ctx: SchemaContext): z.ZodTypeAny {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === 'string')
    : [];

  if (!properties || Object.keys(properties).length === 0) {
    // Object rỗng vẫn phải là ZodObject: AI SDK gửi `parameters` lên gateway,
    // và một object không có thuộc tính phải thành `{}` chứ không phải
    // kiểu tự do (z.record) hay bao bọc thêm một lớp.
    return z.object({});
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    const field = toZod(propSchema, ctx);
    shape[key] = required.includes(key) ? field : field.optional();
  }
  return z.object(shape);
}

/**
 * `parameters` cho AI SDK: LUÔN là ZodObject.
 *
 * Spec MCP quy định Tool.inputSchema có type "object", nên đây là dạng đúng.
 * Chỉ khi server khai báo sai (type không phải object) mới bọc vào `{value}`
 * để gateway không từ chối payload.
 */
export function mcpParameters(inputSchema: Record<string, unknown>): z.ZodObject<z.ZodRawShape> {
  const type = inputSchema?.type;
  if (type && type !== 'object') {
    return z.object({ value: jsonSchemaToZod(inputSchema) });
  }
  const built = jsonSchemaToZod(inputSchema ?? {});
  return built instanceof z.ZodObject
    ? (built as z.ZodObject<z.ZodRawShape>)
    : z.object({});
}

/* ------------------------------------------------------------------ */
/* Kết quả MCP → text cho model                                        */
/* ------------------------------------------------------------------ */

/**
 * Ghép các khối content của MCP thành text.
 * Ảnh/nội dung nhị phân không đưa vào ngữ cảnh — chỉ để lại dòng ghi chú để
 * model biết là có nội dung bị bỏ qua (thay vì im lặng mất dữ liệu).
 */
export function mcpContentToText(content: McpContentBlock[]): string {
  const parts: string[] = [];
  for (const item of content ?? []) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
      continue;
    }

    if (item.type === 'resource') {
      const resource = item.resource as Record<string, unknown> | undefined;
      const text = resource?.text;
      if (typeof text === 'string') {
        parts.push(text);
      } else if (resource?.blob) {
        const uri = typeof resource.uri === 'string' ? resource.uri : 'resource';
        parts.push(`[tài nguyên nhị phân: ${uri} — không đưa vào ngữ cảnh]`);
      }
      continue;
    }

    if (item.type === 'image') {
      const mime = typeof item.mimeType === 'string' ? item.mimeType : 'image';
      parts.push(`[ảnh ${mime} — Koda chưa đưa ảnh từ MCP vào ngữ cảnh]`);
      continue;
    }

    // Loại content khác (audio, resource_link...): serialize để không mất trắng.
    try {
      parts.push(JSON.stringify(item));
    } catch {
      // Không serialize được thì bỏ qua khối này.
    }
  }
  return parts.join('\n').trim();
}

/**
 * Chuỗi kết quả đưa cho model.
 * - Thành công: text thuần (đã cắt trần chung của Koda).
 * - Tool tự báo lỗi: JSON có `error` — cùng shape với cách fs_* và shell_run báo
 *   lỗi, để model học một quy ước duy nhất.
 * - Bị từ chối: kèm `denied: true` + chỉ thị không gọi lại (nếu không, model
 *   rất dễ gọi lại y hệt và kẹt ở đó cho tới hết lượt).
 */
export function formatMcpResultForModel(
  result: McpCallResult,
  toolName: string,
): string {
  const text = mcpContentToText(result?.content ?? []);

  if (result?.denied) {
    return truncateToolResult(
      JSON.stringify({
        error: text || `Người dùng từ chối gọi tool "${toolName}".`,
        denied: true,
      }),
    );
  }

  if (result?.isError) {
    return truncateToolResult(
      JSON.stringify({ error: text || `Tool "${toolName}" báo lỗi không kèm nội dung.` }),
    );
  }

  return truncateToolResult(text || '(tool trả về rỗng)');
}

/* ------------------------------------------------------------------ */
/* Map tools                                                           */
/* ------------------------------------------------------------------ */

export interface McpToolDefs {
  /** key (đã chuẩn hoá) → tool KHÔNG CÓ execute (client sẽ thực thi). */
  defs: Record<string, ReturnType<typeof tool>>;
  /** Tập key — route dùng để quyết định forward tool-call sang renderer. */
  keys: Set<string>;
  /** key → (serverId, toolName) gốc, để renderer gọi đúng IPC. */
  index: Map<string, { serverId: string; toolName: string }>;
  /** Số tool bị bỏ vì trùng tên hoặc vượt trần. */
  skipped: number;
}

/**
 * Dựng bộ tool MCP cho AI SDK.
 *
 * KHÔNG truyền `execute`: server không có đường sang MCP (chạy trong Electron
 * main). Tool vì thế chỉ là KHAI BÁO — model gọi thì stream kết thúc bằng
 * 'tool-calls', route forward sang renderer, renderer gọi IPC rồi resubmit
 * kết quả. Đúng một đường đi, giống hệt fs_*.
 */
export function mapMcpTools(
  tools: McpToolInfo[],
  maxTools: number = MAX_MCP_TOOLS,
): McpToolDefs {
  const defs: Record<string, ReturnType<typeof tool>> = {};
  const keys = new Set<string>();
  const index = new Map<string, { serverId: string; toolName: string }>();
  let skipped = 0;

  for (const mcpTool of tools ?? []) {
    if (keys.size >= maxTools) {
      skipped += 1;
      continue;
    }
    if (!mcpTool?.name || !mcpTool?.serverId) {
      skipped += 1;
      continue;
    }

    const key = mcpToolKey(mcpTool.serverId, mcpTool.name);
    // Trùng tên (hai server cùng tool, hoặc đụng nhau sau khi chuẩn hoá):
    // giữ cái đến trước. Thứ tự đầu vào ổn định nên hai bên (server/renderer)
    // tự chọn cùng một tool mà không cần truyền gì thêm.
    if (keys.has(key)) {
      skipped += 1;
      continue;
    }

    try {
      const description = `[${mcpTool.serverName || mcpTool.serverId}] ${mcpTool.description ?? ''}`
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_DESCRIPTION_CHARS);

      defs[key] = tool({
        description: description || `MCP tool ${mcpTool.name}`,
        parameters: mcpParameters(mcpTool.inputSchema ?? {}),
      });
      keys.add(key);
      index.set(key, { serverId: mcpTool.serverId, toolName: mcpTool.name });
    } catch {
      // Schema quá lạ → bỏ tool này, giữ những tool còn lại.
      skipped += 1;
    }
  }

  return { defs, keys, index, skipped };
}
