/**
 * CRUD + mirror file cho AgentMemory (P1-4) — chạy CLIENT (Dexie của user).
 * Mirror: mỗi category một file `.vyen/memory/<category>.md` (local) và
 * `~/.vyen/memory/<category>.md` (global, desktop bridge) để người dùng đọc/
 * sửa tay. File là BẢN PHẢN ÁNH: nguồn sự thật là Dexie; ghi mới/hasil xoá
 * sync ngay, sửa tay file sẽ được áp dụng ở lần sync tiếp theo.
 */

import { db } from '@/lib/db';
import { desktopFsWrite, desktopFsRead, isDesktopAvailable } from '@/lib/desktop-fs';
import { requireWorkspace, fsWrite, fsRead } from '@/lib/fs-access';
import { isVyenDesktop, vyenDesktop } from '@/lib/desktop-bridge';
import {
  validateMemoryInput,
  renderMemoryMarkdown,
  normalizeCategory,
  memoriesForWorkspace,
  AGENT_MEMORY_LIMITS,
  type AgentMemoryRecord,
} from '@/lib/memory/agent-memory';

function newMemoryId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `amem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Async: lấy workspaceKey bền (desktop hỏi bridge, web đọc cache FSA). */
export async function resolveWorkspaceKey(): Promise<string> {
  try {
    if (isVyenDesktop()) {
      const bridge = vyenDesktop();
      const info = await bridge?.workspace.get();
      if (info?.path) {
        const name = info.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? info.path;
        return name.slice(0, 80);
      }
      return 'default';
    }
    if (isDesktopAvailable()) {
      const { desktopGetWorkspaceInfo } = await import('@/lib/desktop-fs');
      const info = await desktopGetWorkspaceInfo();
      return info.name ?? 'default';
    }
    const { getWorkspaceInfo } = await import('@/lib/fs-access');
    const info = getWorkspaceInfo();
    return info.name ?? 'default';
  } catch {
    return 'default';
  }
}

export async function listAgentMemories(): Promise<AgentMemoryRecord[]> {
  try {
    return await db.agentMemories.orderBy('createdAt').reverse().toArray();
  } catch {
    return [];
  }
}

export interface RememberResult {
  ok: boolean;
  record?: AgentMemoryRecord;
  error?: string;
  mirrored?: boolean;
}

/** Ghi memory + sync mirror file ngay (best-effort — lỗi file không chặn ghi). */
export async function rememberAgentMemory(input: {
  category: unknown;
  data: unknown;
  tags?: unknown;
  is_global?: unknown;
}): Promise<RememberResult> {
  const workspaceKey = await resolveWorkspaceKey();
  const validated = validateMemoryInput({ ...input, workspaceKey });
  if (!validated.ok || !validated.record) {
    return { ok: false, error: validated.error ?? 'Dữ liệu không hợp lệ.' };
  }
  const now = Date.now();
  const record: AgentMemoryRecord = { ...validated.record, id: newMemoryId(), createdAt: now, updatedAt: now };

  // Trần số entry: cũ nhất của CÙNG scope bị loại.
  const sameScope = await db.agentMemories.where('scope').equals(record.scope).toArray();
  if (sameScope.length >= AGENT_MEMORY_LIMITS.maxEntries) {
    const oldest = sameScope.sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) await db.agentMemories.delete(oldest.id);
  }

  await db.agentMemories.put(record);
  const mirrored = await syncCategoryMirror(record.category).catch(() => false);
  return { ok: true, record, mirrored: mirrored === true };
}

export async function removeMemoryCategory(category: string): Promise<number> {
  const cat = normalizeCategory(category);
  const rows = await db.agentMemories.where('category').equals(cat).toArray();
  await db.agentMemories.bulkDelete(rows.map((r) => r.id));
  // Mirror rỗng = xoá nội dung file.
  await syncCategoryMirror(cat).catch(() => false);
  return rows.length;
}

export async function removeSpecificMemory(id: string): Promise<AgentMemoryRecord | null> {
  const record = await db.agentMemories.get(id);
  if (!record) return null;
  await db.agentMemories.delete(id);
  await syncCategoryMirror(record.category).catch(() => false);
  return record;
}

/* ------------------------------ mirror file ------------------------------ */

async function writeMirrorFile(path: string, content: string): Promise<boolean> {
  if (isVyenDesktop()) {
    await desktopFsWrite(path, content);
    return true;
  }
  const ws = await requireWorkspace();
  if (!ws.ok) return false;
  await fsWrite(ws.deps, path, content);
  return true;
}

/** Sync file mirror một category: gom local → .vyen/memory, global → ~/.vyen. */
export async function syncCategoryMirror(category: string): Promise<boolean> {
  const rows = await db.agentMemories.where('category').equals(category).toArray();
  let ok = true;

  const local = rows.filter((r) => r.scope === 'local');
  try {
    await writeMirrorFile(`.vyen/memory/${category}.md`, renderMemoryMarkdown(category, local));
  } catch {
    ok = false;
  }

  const bridge = isVyenDesktop() ? vyenDesktop() : null;
  if (bridge?.memory) {
    try {
      await bridge.memory.writeGlobal(category, renderMemoryMarkdown(category, rows.filter((r) => r.scope === 'global')));
    } catch {
      /* bridge cũ không có lệnh — bỏ qua */
    }
  }
  return ok;
}

/** Đọc lại file mirror người dùng sửa tay → áp vào Dexie (id trong comment HTML). */
export async function importMirrorEdits(category: string): Promise<{ applied: number }> {
  let text: string | null = null;
  try {
    if (isVyenDesktop()) {
      text = String((await desktopFsRead(`.vyen/memory/${category}.md`) as unknown as { content?: string }).content ?? '');
    } else {
      const ws = await requireWorkspace();
      if (ws.ok) {
        text = String((await fsRead(ws.deps, `.vyen/memory/${category}.md`) as unknown as { content?: string }).content ?? '');
      }
    }
  } catch {
    return { applied: 0 };
  }
  if (!text) return { applied: 0 };

  const parsed = parseMemoryMarkdown(text);
  const existing = await db.agentMemories.where('category').equals(category).toArray();
  const byId = new Map(existing.map((r) => [r.id, r]));
  let applied = 0;
  const now = Date.now();
  for (const entry of parsed) {
    if (entry.id && byId.has(entry.id)) {
      const current = byId.get(entry.id)!;
      if (current.data !== entry.data || current.tags.join(',') !== entry.tags.join(',')) {
        await db.agentMemories.update(entry.id, { data: entry.data, tags: entry.tags, updatedAt: now });
        applied++;
      }
    } else if (!entry.id) {
      const workspaceKey = await resolveWorkspaceKey();
      await db.agentMemories.put({
        id: newMemoryId(),
        category,
        data: entry.data,
        tags: entry.tags,
        scope: 'local',
        workspaceKey,
        createdAt: now,
        updatedAt: now,
      });
      applied++;
    }
  }
  return { applied };
}

export function parseMemoryMarkdown(text: string): Array<{ id: string | null; data: string; tags: string[] }> {
  const out: Array<{ id: string | null; data: string; tags: string[] }> = [];
  const lines = text.split('\n');
  let id: string | null = null;
  let tags: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const data = buffer.join('\n').trim();
    if (data) out.push({ id, data, tags });
    id = null;
    tags = [];
    buffer = [];
  };
  for (const line of lines) {
    const idMatch = /^<!-- id: (.+?) -->$/.exec(line.trim());
    if (idMatch) {
      id = idMatch[1]!;
      continue;
    }
    if (line.startsWith('## ')) {
      flush();
      const tagLine = line.slice(3);
      tags = tagLine.split('·').slice(2).join('·').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
      continue;
    }
    if (line.startsWith('# ') || line.startsWith('>')) continue;
    buffer.push(line);
  }
  flush();
  return out;
}

/** Index gửi lên server mỗi lượt — scope-aware. */
export async function buildInjectableIndex(workspaceKey: string): Promise<string> {
  const all = await listAgentMemories();
  const scoped = memoriesForWorkspace(all, workspaceKey);
  const { buildMemoryIndexBlock } = await import('@/lib/memory/agent-memory');
  return buildMemoryIndexBlock(scoped).block;
}
