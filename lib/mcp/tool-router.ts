/**
 * Tool Router — Giải quyết trần 100 tool MCP (Port từ Goose & Hermes).
 *
 * Khi hệ thống kết nối nhiều MCP server (~200+ tools), việc gửi toàn bộ schema
 * vào mỗi request gây lãng phí token, vượt rate limit hoặc trần API của LLM gateway.
 *
 * Tool Router giải quyết bằng:
 * 1. Lập chỉ mục `name + description + parameters` của toàn bộ công cụ.
 * 2. Xếp hạng cục bộ bằng BM25 (hỗ trợ tách từ identifier và fold dấu tiếng Việt).
 * 3. Chỉ đưa top-K (mặc định 30) công cụ phù hợp nhất vào mỗi lượt chat.
 * 4. Luôn cung cấp 2 meta-tools:
 *    - `tools_search(query, limit)`: Tìm kiếm công cụ trong chỉ mục.
 *    - `tools_load(names[])`: Nạp động công cụ vào phiên làm việc.
 */

import { z } from 'zod';
import { tool } from 'ai';
import { foldText } from '@/lib/search-utils';
import type { McpToolInfo } from '@/lib/mcp/tool-mapper';

export const ROUTER_DEFAULT_TOP_K = 30;
export const ROUTER_ACTIVATION_THRESHOLD = 30;

/** Danh sách các tool cốt lõi được ưu tiên giữ trong active tools nếu có mặt. */
export const DEFAULT_CORE_TOOLS: ReadonlySet<string> = new Set([
  'fs_read',
  'fs_edit',
  'fs_write',
  'shell_run',
  'git_status',
  'git_diff',
  'web_search',
  'plan_create',
  'plan_update',
  'remember_memory',
  'retrieve_memories',
]);

export interface ToolIndexEntry {
  name: string;
  description: string;
  category?: string;
  parametersSummary?: string;
  isCore?: boolean;
  mcpServerId?: string;
  rawInputSchema?: Record<string, unknown>;
}

export interface ToolSearchResult {
  name: string;
  description: string;
  category?: string;
  parametersSummary: string;
  score: number;
  isLoaded?: boolean;
}

export interface SelectActiveToolsOptions {
  topK?: number;
  loadedNames?: Iterable<string>;
  coreNames?: Iterable<string>;
  threshold?: number;
}

export interface ActiveToolsSelection {
  activeToolNames: string[];
  isRouted: boolean;
  totalIndexed: number;
  selectedCount: number;
  hasMetaTools: boolean;
}

/* ------------------------------------------------------------------ */
/* Tokenization & BM25 Ranking                                        */
/* ------------------------------------------------------------------ */

/**
 * Tách từ thông minh:
 * - Fold dấu tiếng Việt (thành không dấu lowercase).
 * - Tách camelCase, PascalCase, snake_case, kebab-case và dấu phân cách.
 * - Lọc bỏ token quá ngắn (<2 ký tự).
 */
export function tokenizeToolText(text: string): string[] {
  if (!text) return [];
  // Tách theo ranh giới identifier: camelCase / PascalCase trước khi foldText lowercase
  const splitWords = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const normalized = foldText(splitWords);
  const words = normalized
    .replace(/[^a-z0-9_]/g, ' ')
    .split(/[_\s]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);

  return words;
}

/** Tóm tắt tham số từ schema JSON */
export function summarizeSchemaProperties(schema?: Record<string, unknown>): string {
  if (!schema || typeof schema !== 'object') return '';
  const properties = schema.properties as Record<string, { type?: string; description?: string }> | undefined;
  if (!properties || typeof properties !== 'object') return '';
  const requiredList = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  const parts = Object.entries(properties).map(([propName, propDef]) => {
    const isReq = requiredList.includes(propName);
    const typeStr = propDef?.type ? String(propDef.type) : 'any';
    return `${propName}${isReq ? '' : '?'}: ${typeStr}`;
  });

  return parts.join(', ');
}

/**
 * Lập chỉ mục công cụ từ danh sách native tools và MCP tools.
 */
export function buildToolIndex(
  nativeToolDefs: Record<string, { description?: string }>,
  mcpTools: McpToolInfo[] = [],
  customEntries: ToolIndexEntry[] = [],
): ToolIndexEntry[] {
  const index: ToolIndexEntry[] = [];
  const seen = new Set<string>();

  // 1. Native tools
  for (const [name, def] of Object.entries(nativeToolDefs)) {
    if (seen.has(name)) continue;
    seen.add(name);
    index.push({
      name,
      description: def?.description || '',
      isCore: DEFAULT_CORE_TOOLS.has(name),
    });
  }

  // 2. MCP tools
  for (const t of mcpTools) {
    if (!t?.name || !t?.serverId) continue;
    const fullName = `mcp__${t.serverId}__${t.name}`;
    if (seen.has(fullName)) continue;
    seen.add(fullName);

    const schemaObj = t.inputSchema as Record<string, unknown> | undefined;
    index.push({
      name: fullName,
      description: t.description || `MCP tool "${t.name}" from server "${t.serverId}"`,
      category: 'mcp',
      mcpServerId: t.serverId,
      parametersSummary: summarizeSchemaProperties(schemaObj),
      rawInputSchema: schemaObj,
    });
  }

  // 3. Custom entries (recipes, subrecipes, plugins)
  for (const entry of customEntries) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    index.push(entry);
  }

  return index;
}

/**
 * Tính điểm BM25 giữa query và tập hợp documents.
 */
export function rankToolsWithBM25(
  index: ToolIndexEntry[],
  query: string,
): Array<{ entry: ToolIndexEntry; score: number }> {
  const queryTokens = tokenizeToolText(query);
  if (!queryTokens.length || !index.length) {
    return index.map((entry) => ({ entry, score: 0 }));
  }

  const N = index.length;
  const k1 = 1.2;
  const b = 0.75;

  // Lập token profile cho từng tool: name tokens (boost x3) và desc tokens
  const docProfiles = index.map((entry) => {
    const nameTokens = tokenizeToolText(entry.name);
    const descTokens = tokenizeToolText(entry.description);
    const paramTokens = tokenizeToolText(entry.parametersSummary || '');

    const tokenCounts = new Map<string, number>();
    for (const t of nameTokens) {
      tokenCounts.set(t, (tokenCounts.get(t) || 0) + 3); // Name boost x3
    }
    for (const t of descTokens) {
      tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);
    }
    for (const t of paramTokens) {
      tokenCounts.set(t, (tokenCounts.get(t) || 0) + 0.5);
    }

    const docLen = nameTokens.length * 3 + descTokens.length + paramTokens.length * 0.5;
    return { entry, tokenCounts, docLen };
  });

  const totalLen = docProfiles.reduce((sum, d) => sum + d.docLen, 0);
  const avgdl = totalLen / (N || 1) || 1;

  // Tính Document Frequency (DF) cho từng query token
  const df = new Map<string, number>();
  for (const q of queryTokens) {
    let count = 0;
    for (const d of docProfiles) {
      if (d.tokenCounts.has(q)) count++;
    }
    df.set(q, count);
  }

  // Tính điểm BM25 cho từng document
  const results = docProfiles.map(({ entry, tokenCounts, docLen }) => {
    let score = 0;
    for (const q of queryTokens) {
      const docFreq = df.get(q) || 0;
      if (docFreq === 0) continue;

      // BM25 IDF
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      const tf = tokenCounts.get(q) || 0;

      if (tf > 0) {
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (docLen / avgdl));
        score += idf * (numerator / denominator);
      }
    }

    return { entry, score };
  });

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Tìm kiếm công cụ trong chỉ mục (thực thi thân tool `tools_search`).
 */
export function searchTools(
  index: ToolIndexEntry[],
  query: string,
  limit = 10,
  loadedNames: Iterable<string> = [],
): ToolSearchResult[] {
  const loadedSet = new Set(loadedNames);
  const ranked = rankToolsWithBM25(index, query);

  // Lấy danh sách có điểm > 0, hoặc trả limit tools nếu query rỗng
  const filtered = query.trim()
    ? ranked.filter((r) => r.score > 0)
    : ranked;

  return filtered.slice(0, Math.max(1, limit)).map(({ entry, score }) => ({
    name: entry.name,
    description: entry.description,
    category: entry.category,
    parametersSummary: entry.parametersSummary || '(không có thông tin tham số)',
    score: Math.round(score * 100) / 100,
    isLoaded: loadedSet.has(entry.name),
  }));
}

/**
 * Lựa chọn danh sách công cụ hoạt động (active tools) cho một request:
 * - Nếu tổng số tool <= threshold: trả về toàn bộ (không bật routing).
 * - Nếu vượt threshold:
 *   + Giữ mọi tool trong `loadedNames` (do agent yêu cầu nạp).
 *   + Giữ core tools thiết yếu.
 *   + Lấy thêm các tool có điểm BM25 cao nhất với query hiện tại cho đến topK.
 *   + Bổ sung 2 meta-tools: `tools_search` và `tools_load`.
 */
export function selectActiveTools(
  index: ToolIndexEntry[],
  query: string,
  options: SelectActiveToolsOptions = {},
): ActiveToolsSelection {
  const total = index.length;
  const threshold = options.threshold ?? ROUTER_ACTIVATION_THRESHOLD;
  const topK = options.topK ?? ROUTER_DEFAULT_TOP_K;

  // Nếu số lượng tool không vượt ngưỡng và không có yêu cầu nạp đặc biệt: dùng tất cả
  if (total <= threshold) {
    return {
      activeToolNames: index.map((t) => t.name),
      isRouted: false,
      totalIndexed: total,
      selectedCount: total,
      hasMetaTools: false,
    };
  }

  const loadedSet = new Set(options.loadedNames ?? []);
  const coreSet = new Set(options.coreNames ?? DEFAULT_CORE_TOOLS);

  const selectedNames = new Set<string>();

  // 1. Luôn đưa các tool đã nạp vào
  for (const name of loadedSet) {
    if (index.some((t) => t.name === name)) {
      selectedNames.add(name);
    }
  }

  // 2. Đưa core tools có sẵn vào (tối đa một nửa ngân sách topK để nhường chỗ cho tool liên quan)
  const coreLimit = Math.floor(topK * 0.4);
  let coreCount = 0;
  for (const entry of index) {
    if (coreSet.has(entry.name)) {
      if (coreCount < coreLimit || selectedNames.size < topK) {
        selectedNames.add(entry.name);
        coreCount++;
      }
    }
  }

  // 3. Xếp hạng các tool còn lại theo BM25 và điền vào cho đến khi đạt topK
  const ranked = rankToolsWithBM25(index, query);
  for (const { entry, score } of ranked) {
    if (selectedNames.size >= topK) break;
    if (score > 0 || selectedNames.size < Math.min(topK, 15)) {
      selectedNames.add(entry.name);
    }
  }

  // Luôn bổ sung 2 meta-tools
  selectedNames.add('tools_search');
  selectedNames.add('tools_load');

  return {
    activeToolNames: Array.from(selectedNames),
    isRouted: true,
    totalIndexed: total,
    selectedCount: selectedNames.size,
    hasMetaTools: true,
  };
}

/* ------------------------------------------------------------------ */
/* Meta-tools Defs (AI SDK format)                                    */
/* ------------------------------------------------------------------ */

export const META_TOOL_NAMES = new Set(['tools_search', 'tools_load']);

export const TOOLS_SEARCH_DEF = tool({
  description:
    'Tìm kiếm công cụ trong danh mục đầy đủ (native tools + tất cả MCP servers). ' +
    'Dùng khi bạn cần công cụ giải quyết tác vụ mà chưa thấy trong danh sách hoạt động hiện tại. ' +
    'Trả về tên công cụ, mô tả và tóm tắt tham số.',
  parameters: z.object({
    query: z
      .string()
      .describe('Từ khóa tìm kiếm công cụ (tên, chức năng, công nghệ, ví dụ: "postgres", "github issue", "docker")'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Số lượng kết quả tối đa muốn nhận, mặc định 10'),
  }),
});

export const TOOLS_LOAD_DEF = tool({
  description:
    'Nạp động các công cụ vào bộ công cụ hoạt động của phiên làm việc. ' +
    'Sau khi nạp, công cụ sẽ có mặt để bạn gọi trực tiếp trong các bước/lượt tiếp theo.',
  parameters: z.object({
    names: z
      .array(z.string().min(1))
      .min(1)
      .describe('Danh sách tên công cụ cần nạp (ví dụ: ["mcp__github__create_issue", "mcp__postgres__query"])'),
  }),
});

export const ROUTER_META_TOOL_DEFS = {
  tools_search: TOOLS_SEARCH_DEF,
  tools_load: TOOLS_LOAD_DEF,
} as const;
