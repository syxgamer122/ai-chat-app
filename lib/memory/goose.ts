/**
 * Structured Memory (port Goose remember/retrieve/remove) — bộ nhớ dài hạn
 * CÓ CẤU TRÚC: category + tags + scope (local theo workspace / global).
 *
 * Khác hệ reviewer-gate (memoryCandidates/memoryRecords — quy trình duyệt),
 * hệ này là kho ghi NHANH do agent tự ghi qua tool, giới hạn 2.000 ký tự/
 * entry, inject theo NGÂN SÁCH: chỉ index (category + số lượng) + toàn bộ
 * memory global ngắn; vượt trần thì agent phải retrieve_memories.
 *
 * Thuần function — Dexie/fs inject bên ngoài.
 */

export const GOOSE_MEMORY_LIMITS = {
  /** Trần ký tự mỗi entry (spec: nâng từ 400 lên 2.000). */
  dataChars: 2_000,
  /** Trần TỔNG ký tự khối inject vào system prompt. */
  injectChars: 4_000,
  /** Trần số entry mỗi bảng. */
  maxEntries: 500,
  categoryChars: 60,
  maxTags: 8,
  tagChars: 40,
  /** Số kết quả tối đa mỗi lần retrieve. */
  retrieveLimit: 8,
} as const;

export type GooseMemoryScope = 'local' | 'global';

export interface AgentMemoryRecord {
  id: string;
  category: string;
  data: string;
  tags: string[];
  scope: GooseMemoryScope;
  /** Workspace mà memory local thuộc về (scope=global dùng '*'). */
  workspaceKey: string;
  createdAt: number;
  updatedAt: number;
}

export function normalizeCategory(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, GOOSE_MEMORY_LIMITS.categoryChars);
}

export function normalizeTags(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const t of raw) {
    const clean = t.trim().toLowerCase().slice(0, GOOSE_MEMORY_LIMITS.tagChars);
    if (clean) seen.add(clean);
    if (seen.size >= GOOSE_MEMORY_LIMITS.maxTags) break;
  }
  return [...seen];
}

export interface ValidatedMemory {
  ok: boolean;
  record?: Omit<AgentMemoryRecord, 'id' | 'createdAt' | 'updatedAt'>;
  error?: string;
}

/** Validate payload của remember_memory — thuần, test được. */
export function validateMemoryInput(input: {
  category: unknown;
  data: unknown;
  tags?: unknown;
  is_global?: unknown;
  workspaceKey: string;
}): ValidatedMemory {
  const category = normalizeCategory(String(input.category ?? ''));
  if (!category) return { ok: false, error: 'Thiếu category (nhóm ghi nhớ).' };
  const data = String(input.data ?? '').trim().slice(0, GOOSE_MEMORY_LIMITS.dataChars);
  if (data.length < 4) {
    return { ok: false, error: `data quá ngắn (tối thiểu 4 ký tự, trần ${GOOSE_MEMORY_LIMITS.dataChars}).` };
  }
  const tags = normalizeTags(Array.isArray(input.tags) ? (input.tags.filter((t) => typeof t === 'string') as string[]) : []);
  const scope: GooseMemoryScope = input.is_global === true ? 'global' : 'local';
  return {
    ok: true,
    record: {
      category,
      data,
      tags,
      scope,
      workspaceKey: scope === 'global' ? '*' : input.workspaceKey,
    },
  };
}

/**
 * Lọc memory theo scope: global luôn vào; local chỉ khi trùng workspaceKey.
 */
export function memoriesForWorkspace(
  records: readonly AgentMemoryRecord[],
  workspaceKey: string,
): AgentMemoryRecord[] {
  return records.filter((r) => r.scope === 'global' || r.workspaceKey === workspaceKey);
}

export interface MemoryIndexBlock {
  block: string;
  /** true khi vượt trần → chỉ đưa index, agent phải retrieve_memories. */
  truncated: boolean;
  injectedCount: number;
  totalCount: number;
}

/**
 * Dựng khối inject: danh sách category + số lượng + TOÀN BỘ memory global
 * NGẮN; tổng vượt `injectChars` thì cắt về index-only. Thứ tự: category tên
 * tăng dần; trong category, mới nhất trước.
 */
export function buildMemoryIndexBlock(
  records: readonly AgentMemoryRecord[],
  budget: number = GOOSE_MEMORY_LIMITS.injectChars,
): MemoryIndexBlock {
  if (!records.length) {
    return { block: '', truncated: false, injectedCount: 0, totalCount: 0 };
  }
  const byCategory = new Map<string, AgentMemoryRecord[]>();
  for (const r of records) {
    const list = byCategory.get(r.category) ?? [];
    list.push(r);
    byCategory.set(r.category, list);
  }
  for (const list of byCategory.values()) list.sort((a, b) => b.createdAt - a.createdAt);

  const categories = [...byCategory.keys()].sort();
  const headerLines = [
    '[BỘ NHỚ CÓ CẤU TRÚC] Các category đã lưu (category · số entry · tags):',
    ...categories.map((c) => {
      const list = byCategory.get(c)!;
      const tags = [...new Set(list.flatMap((r) => r.tags))].slice(0, 6).join(',');
      return `- ${c} · ${list.length}${tags ? ` · ${tags}` : ''}`;
    }),
    'Muốn đọc nội dung: gọi retrieve_memories(query). Ghi nhớ mới: remember_memory.',
  ];
  const header = headerLines.join('\n');

  // Global ngắn ghé vào sau header cho đến khi cạn ngân sách.
  const shorts: string[] = [];
  let used = header.length;
  let injected = 0;
  let truncated = false;
  for (const cat of categories) {
    for (const r of byCategory.get(cat)!) {
      if (r.scope !== 'global') continue;
      const line = `· [${r.category}] ${r.data.replace(/\s+/g, ' ').slice(0, 300)}`;
      if (used + line.length + 1 > budget) {
        truncated = true;
        break;
      }
      shorts.push(line);
      used += line.length + 1;
      injected++;
    }
    if (truncated) break;
  }

  return {
    block: shorts.length ? `${header}\n${shorts.join('\n')}` : header,
    truncated,
    injectedCount: injected,
    totalCount: records.length,
  };
}

export interface MemoryQuery {
  query?: string;
  category?: string;
  tags?: string[];
  workspaceKey: string;
  limit?: number;
}

/**
 * Tìm kiếm memory: filter category/tags chính xác, full-text theo từ khoá
 * (fold dấu tiếng Việt — tái dùng foldText của search-utils), rank theo số
 * tín hiệu khớp + độ mới. Trả tối đa retrieveLimit.
 */
export function retrieveMatchingMemories(
  records: readonly AgentMemoryRecord[],
  q: MemoryQuery,
  fold: (s: string) => string,
): AgentMemoryRecord[] {
  let pool = memoriesForWorkspace(records, q.workspaceKey);
  const category = q.category ? normalizeCategory(q.category) : '';
  if (category) pool = pool.filter((r) => r.category === category);
  if (q.tags?.length) {
    const want = new Set(q.tags.map((t) => t.toLowerCase()));
    pool = pool.filter((r) => r.tags.some((t) => want.has(t)));
  }
  const query = (q.query ?? '').trim();
  if (!query) {
    return pool.sort((a, b) => b.createdAt - a.createdAt).slice(0, q.limit ?? GOOSE_MEMORY_LIMITS.retrieveLimit);
  }
  const folded = fold(query).toLowerCase();
  const words = folded.split(/[^\p{L}\d]+/u).filter((w) => w.length >= 2);
  const scored = pool.map((r) => {
    const hay = fold(`${r.category} ${r.data} ${r.tags.join(' ')}`).toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += 1;
    if (hay.includes(folded)) score += 2;
    return { r, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.r.createdAt - a.r.createdAt)
    .slice(0, q.limit ?? GOOSE_MEMORY_LIMITS.retrieveLimit)
    .map((s) => s.r);
}

/**
 * Ghép các memory category "lesson" thành chuỗi prefix [LESSON:*] để đưa vào
 * mảng `memories` của body — giữ nguyên đường formatLessonsBlock + matcher
 * hiện có mà KHÔNG phá lesson_save.
 */
export function agentMemoriesAsLessons(
  records: readonly AgentMemoryRecord[],
  workspaceKey: string,
): Array<{ id: string; text: string }> {
  return memoriesForWorkspace(records, workspaceKey)
    .filter((r) => r.category === 'lesson')
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      text: `[LESSON:pattern] ${r.data.slice(0, 400)}`,
    }));
}

/** Render file mirror .vyen/memory/<category>.md —Markdown dễ đọc/sửa tay. */
export function renderMemoryMarkdown(
  category: string,
  records: readonly AgentMemoryRecord[],
): string {
  const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt);
  const lines = [
    `# ${category}`,
    '',
    `> File mirror do Vyen sinh — chỉnh/sửa trực tiếp được; xoá dòng = xoá memory lần sync sau.`,
    '',
  ];
  for (const r of sorted) {
    const date = new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`## ${date} · ${r.scope}${r.tags.length ? ` · ${r.tags.join(', ')}` : ''}`);
    lines.push(`<!-- id: ${r.id} -->`);
    lines.push(r.data);
    lines.push('');
  }
  return lines.join('\n');
}
