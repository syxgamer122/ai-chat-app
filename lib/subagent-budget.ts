/**
 * Ngân sách spawn subagent theo hội thoại — tương đương maxSubagentSpawnsPerRun
 * của pi-subagents nhưng đặt ở mức bucket conversation.
 *
 * Vì sao cần: delegate KHÔNG đi qua guarded() của buildAgentTools (đường
 * emulated xử lý inline qua onDelegateCall; đường native là server tool riêng
 * ngoài bộ tool guarded) nên doom-loop detector và MAX_TOOL_CALLS_PER_TURN
 * không đếm được spawn. Model yếu có thể loop delegate với instructions khác
 * nhau (né signature trùng) — mỗi spawn là một vòng LLM đa-turn, đốt token
 * key BYOK free thật. 12 spawn/bucket đã hào phóng (pi cho 64 nhưng đó là CLI
 * desktop mạnh).
 *
 * consumeSubagentSpawns là check-and-consume ĐỒNG BỘ (JS single-threaded nên
 * atomic): gọi đúng một lần cho mỗi lô child sắp khởi chạy, TRƯỚC khi spawn.
 * Bucket chỉ sống trong process — mất khi restart chỉ nghĩa là hội thoại được
 * cấp lại suất, không phải lỗi bảo mật (cùng tradeoff với tool-call-budget).
 */

import { BUDGET_TTL_MS } from '@/lib/tool-call-budget';

export const SUBAGENT_SPAWNS_PER_BUCKET = 12;

/** Trần số bucket giữ đồng thời — chặn rò rỉ bộ nhớ khi nhiều hội thoại. */
const MAX_BUCKETS = 500;

interface SpawnBucket {
  used: number;
  touchedAt: number;
}

const buckets = new Map<string, SpawnBucket>();

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.touchedAt > BUDGET_TTL_MS) buckets.delete(key);
  }
  if (buckets.size <= MAX_BUCKETS) return;
  const sorted = [...buckets.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  for (const [key] of sorted.slice(0, buckets.size - MAX_BUCKETS)) buckets.delete(key);
}

export interface SpawnGrant {
  /** Số suất thực sự cấp — min(want, còn lại). 0 = hết ngân sách. */
  granted: number;
  /** Số suất còn lại trong bucket sau khi cấp. */
  remaining: number;
}

/**
 * Cấp `want` suất cho hội thoại. Không có `conversationId` → luôn cấp đủ và
 * KHÔNG tạo bucket (giữ hành vi cũ). Không bao giờ vượt cap ngay cả khi want
 * lớn hơn số suất còn lại — cấp một phần, caller tự xử lý phần thiếu.
 */
export function consumeSubagentSpawns(
  conversationId: string | undefined,
  want: number,
): SpawnGrant {
  const safeWant = Math.max(0, Math.floor(want));
  if (!conversationId || safeWant === 0) {
    return { granted: safeWant, remaining: SUBAGENT_SPAWNS_PER_BUCKET };
  }
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(conversationId) ?? { used: 0, touchedAt: now };
  const remaining = Math.max(0, SUBAGENT_SPAWNS_PER_BUCKET - bucket.used);
  const granted = Math.min(safeWant, remaining);
  bucket.used += granted;
  bucket.touchedAt = now;
  buckets.set(conversationId, bucket);
  return { granted, remaining: SUBAGENT_SPAWNS_PER_BUCKET - bucket.used };
}

/* ---- chỉ dùng trong test ---- */
export function subagentBucketUsed(conversationId: string): number {
  return buckets.get(conversationId)?.used ?? 0;
}

export function resetSubagentBudgetForTests(): void {
  buckets.clear();
}
