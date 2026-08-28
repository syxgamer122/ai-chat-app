/**
 * Ngân sách gọi tool sống XUYÊN các request của cùng một hội thoại.
 *
 * Vấn đề đã sửa: guarded() trong agent-tools.ts giữ bộ đếm và log dedupe
 * trong closure của buildAgentTools — mỗi request tạo bộ tool mới nên bộ đếm
 * reset về 0. Với agent coding, mỗi lần client thực thi fs_* xong là useChat
 * resubmit → request mới → trần "8 call mỗi lượt" thực chất là "8 call mỗi
 * request" (tối đa 8 resubmit × 8 = 64), và dedupe không chặn được vòng lặp
 * fs_list → fs_list lặp lại qua các resubmit.
 *
 * Giải pháp: bucket theo conversationId, TTL tự dọn. Bộ nhớ tiến trình là đủ
 * — mất bucket khi restart chỉ có nghĩa là lượt đó được cấp ngân sách mới,
 * không phải lỗi bảo mật.
 */

import { MAX_TOOL_CALLS_PER_TURN, DOOM_LOOP_THRESHOLD } from '@/lib/tool-limits';

/** Bucket hết hạn sau khoảng này kể từ lần chạm cuối. */
export const BUDGET_TTL_MS = 10 * 60_000;

/** Trần số bucket giữ đồng thời — chặn rò rỉ bộ nhớ khi nhiều hội thoại. */
const MAX_BUCKETS = 500;

/**
 * Số chữ ký call gần nhất giữ lại để phát hiện vòng lặp. Đủ lớn để bắt
 * chuỗi lặp A→B→A→B mà dedupe call-trùng không thấy (mỗi call trùng chỉ
 * xuất hiện 1-2 lần trong window), đủ nhỏ để không phình bucket.
 */
const DOOM_LOOP_WINDOW = 12;

export interface ToolCallBudget {
  /** Tổng số call đã dùng, cộng dồn qua mọi request của hội thoại. */
  totalCalls: number;
  /** key `${tool}:${args}` → số lần đã gọi. */
  callCounts: Map<string, number>;
  /** Host đã có nguồn gốc hợp lệ, tích lũy qua các lượt (provenance). */
  knownHosts: Set<string>;
  /**
   * Chữ ký N lần gọi gần nhất (cũ → mới). Dùng cho doom-loop detector:
   * đếm số lần lặp LIÊN TIẾP ở đuôi, khác với callCounts vốn đếm tổng.
   */
  recentSignatures: string[];
  touchedAt: number;
}

const buckets = new Map<string, ToolCallBudget>();

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.touchedAt > BUDGET_TTL_MS) buckets.delete(key);
  }
  if (buckets.size <= MAX_BUCKETS) return;
  // Vẫn quá đông sau khi dọn hạn → bỏ những bucket cũ nhất.
  const sorted = [...buckets.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  for (const [key] of sorted.slice(0, buckets.size - MAX_BUCKETS)) buckets.delete(key);
}

/**
 * Lấy (hoặc tạo) bucket của hội thoại. `conversationId` rỗng/thiếu → trả
 * bucket dùng-một-lần, tức hành vi cũ theo từng request (không hồi quy khi
 * client không gửi id).
 */
export function getToolCallBudget(conversationId?: string | null): ToolCallBudget {
  const now = Date.now();
  if (!conversationId) {
    return { totalCalls: 0, callCounts: new Map(), knownHosts: new Set(), recentSignatures: [], touchedAt: now };
  }
  sweep(now);
  const existing = buckets.get(conversationId);
  if (existing) {
    existing.touchedAt = now;
    return existing;
  }
  const fresh: ToolCallBudget = {
    totalCalls: 0,
    callCounts: new Map(),
    knownHosts: new Set(),
    recentSignatures: [],
    touchedAt: now,
  };
  buckets.set(conversationId, fresh);
  return fresh;
}

/* ------------------------------------------------------------------ */
/* Doom-loop detector (port doom_loop.rs của evot)                      */
/* ------------------------------------------------------------------ */

export interface DoomLoopResult {
  /** true khi cùng một chữ ký call lặp DOOM_LOOP_THRESHOLD lần liên tiếp. */
  triggered: boolean;
  /** Số lần lặp liên tiếp tính cả call hiện tại. */
  counted: number;
}

/**
 * Kiểm tra vòng lặp doom cho một call MỚI. KHÔNG ghi vào recentSignatures khi
 * trigger — detector giữ ở đúng mép ngưỡng để lần sau vẫn báo, cho tới khi
 * model thực sự đổi hướng (call khác sẽ push signature mới, reset chuỗi).
 *
 * Chữ ký = `stableKey(name, args)` từ agent-tools.ts. Dedupe thuần (callCounts)
 * đã chặn call trùng THỨ HAI; doom-loop xử lý ca lặp liên tục từ thứ ba trở
 * lên bằng steering message mạnh hơn.
 */
export function checkDoomLoop(budget: ToolCallBudget, signature: string): DoomLoopResult {
  const recent = budget.recentSignatures;
  let counted = 1;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i] !== signature) break;
    counted += 1;
  }

  if (counted >= DOOM_LOOP_THRESHOLD) {
    return { triggered: true, counted };
  }

  recent.push(signature);
  if (recent.length > DOOM_LOOP_WINDOW) {
    recent.splice(0, recent.length - DOOM_LOOP_WINDOW);
  }
  return { triggered: false, counted };
}

/**
 * Đặt lại ngân sách khi người dùng gửi tin nhắn MỚI (không phải resubmit của
 * tool). Một lượt hội thoại mới xứng đáng có đủ trần call; nếu không, hội
 * thoại dài sẽ cạn ngân sách vĩnh viễn.
 */
export function resetToolCallBudget(conversationId?: string | null): void {
  if (!conversationId) return;
  const bucket = buckets.get(conversationId);
  if (!bucket) return;
  bucket.totalCalls = 0;
  bucket.callCounts.clear();
  bucket.recentSignatures.length = 0;
  bucket.touchedAt = Date.now();
  // knownHosts CỐ Ý giữ lại: URL người dùng dán ở lượt trước vẫn là nguồn
  // hợp lệ cho web_fetch ở lượt sau.
}

/** Chỉ dùng trong test. */
export function __clearAllToolCallBudgets(): void {
  buckets.clear();
}

export { MAX_TOOL_CALLS_PER_TURN };
