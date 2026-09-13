/**
 * Memory Recall & Reviewer Gate — Chọn lọc, xếp hạng và gate kiểm duyệt ký ức (Oh My Hermes port).
 *
 * Nguyên tắc:
 * 1. Không bao giờ ghi status: 'active' ngầm: agent chỉ đề xuất candidate (pending).
 * 2. Chỉ record đã duyệt (active/reference) mới được đưa vào Recall Pack.
 * 3. Xếp hạng: score = scopeMatch*3 + keywordOverlap*2 + confirmCount*1.5 + freshness - ageDecay.
 * 4. Giải quyết xung đột: ưu tiên scope hẹp hơn hoặc bản duyệt mới hơn.
 * 5. Tuân thủ ngân sách token chặt chẽ (cắt và ghi rõ droppedIds).
 */

import type {
  MemoryRecord,
  MemoryScope,
  RecallPack,
  RecallPackItem,
  RecallConflict,
} from '@/lib/memory/types';

/**
 * Đề xuất một ký ức mới (agent chỉ có quyền tạo candidate pending).
 */
export function proposeMemory(input: {
  text: string;
  scope: MemoryScope;
  kind?: MemoryRecord['kind'];
  provenance: MemoryRecord['provenance'];
  now?: number;
}): MemoryRecord {
  const now = input.now ?? Date.now();
  const trimmed = input.text.trim().slice(0, 400);

  let h = 0;
  for (let i = 0; i < trimmed.length; i++) {
    h = ((h << 5) - h + trimmed.charCodeAt(i)) | 0;
  }
  const digest = `mem-${(h >>> 0).toString(16)}`;

  return {
    id: `cand-${now}-${Math.random().toString(36).slice(2, 7)}`,
    scope: input.scope,
    kind: input.kind ?? 'pattern',
    text: trimmed,
    provenance: input.provenance,
    status: 'pending',
    confirmCount: 1,
    createdAt: now,
    digest,
  };
}

/**
 * Reviewer gate: User phê duyệt, hoãn hoặc từ chối candidate.
 */
export function reviewMemory(
  record: MemoryRecord,
  action: 'remember' | 'refuse' | 'defer',
  options?: { reason?: string; now?: number },
): MemoryRecord {
  const now = options?.now ?? Date.now();

  if (action === 'refuse') {
    if (!options?.reason || !options.reason.trim()) {
      throw new Error('Từ chối ký ức bắt buộc phải có lý do cụ thể.');
    }
    return {
      ...record,
      status: 'refused',
      reason: options.reason.trim(),
    };
  }

  if (action === 'defer') {
    return {
      ...record,
      status: 'pending',
      reason: options?.reason?.trim() || 'Hoãn xem xét',
      reviewDueAt: new Date(now + 7 * 86400_000).toISOString(),
    };
  }

  // remember
  return {
    ...record,
    status: 'active',
    confirmCount: record.confirmCount + 1,
    lastUsedAt: new Date(now).toISOString(),
    reviewDueAt: new Date(now + 30 * 86400_000).toISOString(),
  };
}

/**
 * Tính điểm trùng lặp từ khóa giữa nội dung ký ức và task.
 */
function computeKeywordOverlap(text: string, taskText: string): number {
  const textWords = new Set(
    text.toLowerCase().split(/\W+/).filter((w) => w.length > 2),
  );
  const taskWords = taskText.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  let matches = 0;
  for (const w of taskWords) {
    if (textWords.has(w)) matches++;
  }
  return Math.min(10, matches);
}

/**
 * Xây dựng Recall Pack cho ngữ cảnh phiên làm việc.
 */
export function buildRecallPack(
  records: MemoryRecord[],
  context: {
    taskText: string;
    scope: MemoryScope;
    budgetTokens?: number;
    now?: number;
  },
): RecallPack {
  const now = context.now ?? Date.now();
  const limitTokens = context.budgetTokens ?? 800;

  // 1. Chỉ lấy ký ức đã duyệt (active hoặc reference)
  const eligible = records.filter((r) => r.status === 'active' || r.status === 'reference');

  // 2. Chấm điểm từng ký ức
  const scoredItems: Array<RecallPackItem & { candidate: MemoryRecord }> = [];

  for (const rec of eligible) {
    // Scope match (1 cho khớp chính xác scope, 0.5 cho project scope trong ngữ cảnh thread)
    let scopeMatch = 0;
    if (rec.scope.kind === context.scope.kind && rec.scope.ref === context.scope.ref) {
      scopeMatch = 1;
    } else if (rec.scope.kind === 'project' && context.scope.kind === 'thread') {
      scopeMatch = 0.5;
    }

    const keywordScore = computeKeywordOverlap(rec.text, context.taskText);
    const confirmScore = rec.confirmCount * 1.5;

    // Freshness & Age decay (tính theo ngày)
    const ageDays = Math.max(0, (now - rec.createdAt) / 86400_000);
    const ageDecay = Math.min(5, ageDays * 0.1);
    const freshness = ageDays < 3 ? 2 : 0;

    const totalScore = scopeMatch * 3 + keywordScore * 2 + confirmScore + freshness - ageDecay;

    scoredItems.push({
      id: rec.id,
      text: rec.text,
      why: `scope:${rec.scope.kind}, keywords:${keywordScore}`,
      score: totalScore,
      candidate: rec,
    });
  }

  // 3. Sắp xếp theo điểm giảm dần
  scoredItems.sort((a, b) => b.score - a.score);

  // 4. Giải quyết xung đột (Dedup & conflict resolution)
  const deduped: Array<RecallPackItem & { candidate: MemoryRecord }> = [];
  const conflicts: RecallConflict[] = [];
  const seenTexts = new Map<string, typeof scoredItems[0]>();

  for (const item of scoredItems) {
    // Đơn giản hóa so sánh trùng lặp nội dung
    const normalized = item.text.replace(/\s+/g, ' ').trim().toLowerCase();
    const existing = seenTexts.get(normalized);

    if (existing) {
      // Xung đột / trùng lặp:
      // Luật: scope hẹp hơn thắng (thread > project > user); nếu bằng scope thì mới hơn thắng
      const itemScopeWeight = item.candidate.scope.kind === 'thread' ? 3 : item.candidate.scope.kind === 'project' ? 2 : 1;
      const existingScopeWeight = existing.candidate.scope.kind === 'thread' ? 3 : existing.candidate.scope.kind === 'project' ? 2 : 1;

      if (itemScopeWeight > existingScopeWeight) {
        // Scope hẹp hơn thắng
        conflicts.push({
          keptId: item.id,
          droppedId: existing.id,
          rule: 'narrower_scope_wins',
        });
        const idx = deduped.findIndex((d) => d.id === existing.id);
        if (idx >= 0) deduped.splice(idx, 1);
        deduped.push(item);
        seenTexts.set(normalized, item);
      } else if (itemScopeWeight < existingScopeWeight) {
        // Scope hẹp hơn của existing thắng
        conflicts.push({
          keptId: existing.id,
          droppedId: item.id,
          rule: 'narrower_scope_wins',
        });
      } else {
        // Cùng scope: bản ghi mới hơn thắng (newer_reviewed_wins)
        const itemTime = item.candidate.createdAt;
        const existingTime = existing.candidate.createdAt;

        if (itemTime > existingTime) {
          conflicts.push({
            keptId: item.id,
            droppedId: existing.id,
            rule: 'newer_reviewed_wins',
          });
          const idx = deduped.findIndex((d) => d.id === existing.id);
          if (idx >= 0) deduped.splice(idx, 1);
          deduped.push(item);
          seenTexts.set(normalized, item);
        } else {
          conflicts.push({
            keptId: existing.id,
            droppedId: item.id,
            rule: 'newer_reviewed_wins',
          });
        }
      }
    } else {
      seenTexts.set(normalized, item);
      deduped.push(item);
    }
  }

  // 5. Cắt theo ngân sách token
  const items: RecallPackItem[] = [];
  const droppedIds: string[] = [];
  let usedTokens = 0;

  for (const item of deduped) {
    // Ước tính token = ký tự / 4
    const itemTokens = Math.max(1, Math.ceil(item.text.length / 4));
    if (usedTokens + itemTokens <= limitTokens) {
      usedTokens += itemTokens;
      items.push({
        id: item.id,
        text: item.text,
        why: item.why,
        score: Number(item.score.toFixed(2)),
      });
    } else {
      droppedIds.push(item.id);
    }
  }

  return {
    items,
    budget: {
      limitTokens,
      usedTokens,
      droppedIds,
    },
    conflicts,
  };
}

/**
 * Định dạng banner hiển thị trên giao diện chat
 */
export function formatRecallBanner(pack: RecallPack): string | null {
  if (!pack.items.length) return null;
  return `🧠 Đã nhớ ${pack.items.length} ghi chú`;
}

/**
 * Định dạng khối ghi nhớ đã duyệt để chèn vào cuối system prompt
 */
export function formatRecalledMemoriesBlock(memories: Array<{ text: string }>): string {
  if (!memories.length) return '';
  const nonLessons = memories.filter((m) => typeof m?.text === 'string' && !m.text.startsWith('[LESSON:'));
  if (!nonLessons.length) return '';
  return `\n[BỘ NHỚ DÀI HẠN ĐÃ DUYỆT (RECALLED MEMORIES)]\n` +
    `Các quy ước/thông tin sau đây đã được người dùng phê duyệt cho phiên này:\n` +
    nonLessons.map((m) => `- ${m.text}`).join('\n') + '\n';
}

/**
 * Tự động chuyển đổi trạng thái tuổi thọ ký ức theo thời gian (active -> reference -> archive).
 */
export function progressMemoryAge(record: MemoryRecord, now: number = Date.now()): MemoryRecord {
  if (record.status !== 'active' && record.status !== 'reference') {
    return record;
  }
  const dueTime = record.reviewDueAt ? new Date(record.reviewDueAt).getTime() : 0;
  if (!dueTime || now < dueTime) {
    return record;
  }
  // Nếu đã quá hạn reviewDueAt:
  if (record.status === 'active') {
    return {
      ...record,
      status: 'reference',
      reviewDueAt: new Date(now + 60 * 86400_000).toISOString(),
    };
  }
  if (record.status === 'reference') {
    return {
      ...record,
      status: 'archive',
    };
  }
  return record;
}
