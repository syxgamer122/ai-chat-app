/**
 * Memory Store — Tầng lưu trữ Dexie cho bộ nhớ dài hạn có Reviewer Gate.
 *
 * Đảm bảo:
 * 1. Agent chỉ được tạo candidate trong `memoryCandidates` với status 'pending'.
 * 2. Không bao giờ ghi trực tiếp status 'active' vào `memoryRecords` mà không qua reviewMemory.
 * 3. Mọi quyết định duyệt (remember/refuse/defer) đều được lưu vết vào `memoryReviews`.
 */

import { db } from '@/lib/db';
import {
  proposeMemory,
  reviewMemory,
  buildRecallPack,
  progressMemoryAge,
} from '@/lib/memory/recall';
import type {
  MemoryRecord,
  MemoryScope,
  MemoryKind,
  RecallPack,
  MemoryReviewEntry,
} from '@/lib/memory/types';

/**
 * Liệt kê các candidate đang chờ người dùng kiểm duyệt.
 */
export async function listMemoryCandidates(): Promise<MemoryRecord[]> {
  try {
    return await db.memoryCandidates
      .where('status')
      .equals('pending')
      .reverse()
      .sortBy('createdAt');
  } catch {
    return [];
  }
}

/**
 * Liệt kê toàn bộ ký ức đã được kiểm duyệt (active, reference, archive, refused).
 */
export async function listReviewedMemoryRecords(filter?: {
  status?: MemoryRecord['status'];
  scope?: MemoryScope;
}): Promise<MemoryRecord[]> {
  try {
    let collection = db.memoryRecords.toCollection();
    if (filter?.status) {
      collection = db.memoryRecords.where('status').equals(filter.status);
    }
    const all = await collection.reverse().sortBy('createdAt');
    if (filter?.scope) {
      return all.filter(
        (r) => r.scope.kind === filter.scope!.kind && r.scope.ref === filter.scope!.ref,
      );
    }
    return all;
  } catch {
    return [];
  }
}

/**
 * Đề xuất một candidate ghi nhớ mới (luôn ở trạng thái 'pending').
 */
export async function proposeCandidate(input: {
  text: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
  provenance: MemoryRecord['provenance'];
  now?: number;
}): Promise<MemoryRecord> {
  const scope: MemoryScope = input.scope ?? { kind: 'project', ref: 'default' };
  const candidate = proposeMemory({
    text: input.text,
    scope,
    kind: input.kind,
    provenance: input.provenance,
    now: input.now,
  });

  // Kiểm tra trùng lặp digest trong candidate hoặc records đang active
  const existingCand = await db.memoryCandidates.where('digest').equals(candidate.digest).first();
  if (existingCand) {
    return existingCand;
  }
  const existingRecord = await db.memoryRecords.where('digest').equals(candidate.digest).first();
  if (existingRecord) {
    return existingRecord;
  }

  await db.memoryCandidates.put(candidate);
  return candidate;
}

/**
 * Phê duyệt candidate qua Reviewer Gate.
 */
export async function reviewCandidate(
  candidateId: string,
  action: 'remember' | 'refuse' | 'defer',
  options?: { reason?: string; now?: number },
): Promise<MemoryRecord> {
  const candidate = await db.memoryCandidates.get(candidateId);
  if (!candidate) {
    throw new Error(`Không tìm thấy candidate có id "${candidateId}".`);
  }

  const reviewed = reviewMemory(candidate, action, options);
  const now = options?.now ?? Date.now();
  const reviewEntry: MemoryReviewEntry = {
    id: `rev-${now}-${Math.random().toString(36).slice(2, 7)}`,
    candidateId,
    action,
    reason: options?.reason,
    reviewedAt: now,
  };

  await db.transaction('rw', db.memoryCandidates, db.memoryRecords, db.memoryReviews, async () => {
    await db.memoryReviews.add(reviewEntry);

    if (action === 'remember') {
      // Đưa vào memoryRecords, xóa khỏi candidate pending
      await db.memoryRecords.put(reviewed);
      await db.memoryCandidates.delete(candidateId);
    } else if (action === 'refuse') {
      // Đưa vào memoryRecords với trạng thái refused, xóa khỏi pending candidates
      await db.memoryRecords.put(reviewed);
      await db.memoryCandidates.delete(candidateId);
    } else if (action === 'defer') {
      // Cập nhật pending với reviewDueAt mới
      await db.memoryCandidates.put(reviewed);
    }
  });

  return reviewed;
}

/**
 * Xóa một bản ghi ký ức đã duyệt.
 */
export async function deleteReviewedRecord(id: string): Promise<void> {
  await db.memoryRecords.delete(id);
}

/**
 * Xây dựng recall pack từ cơ sở dữ liệu đã duyệt.
 */
export async function queryRecallPack(context: {
  taskText: string;
  scope: MemoryScope;
  budgetTokens?: number;
  now?: number;
}): Promise<RecallPack> {
  try {
    const rawRecords = await db.memoryRecords.toArray();
    const now = context.now ?? Date.now();
    const activeRecords = rawRecords
      .map((r) => progressMemoryAge(r, now))
      .filter((r) => r.status === 'active' || r.status === 'reference');

    return buildRecallPack(activeRecords, context);
  } catch {
    return {
      items: [],
      budget: { limitTokens: context.budgetTokens ?? 800, usedTokens: 0, droppedIds: [] },
      conflicts: [],
    };
  }
}
