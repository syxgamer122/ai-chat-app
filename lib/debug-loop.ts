/**
 * Auto-debug loop state tracker — bounded retry với no-progress detection.
 *
 * Port mô hình Plandex `plandex debug` (MIT) về mô hình client-side của KODA:
 * KHÔNG xây outer loop riêng (rủi ro infinite loop). Thay vào đó track state
 * để enhanced shell_run result hướng dẫn model tự retry an toàn.
 *
 * Thuần function, không Dexie/React — test được trong node.
 */

/** Trần số lần retry tối đa cho một lệnh debug. */
export const AUTO_DEBUG_MAX_ATTEMPTS_DEFAULT = 3;
export const AUTO_DEBUG_MAX_ATTEMPTS_LIMIT = 5;

/**
 * Số lần liên tiếp cùng exit code + output tương tự thì coi là "no progress"
 * → dừng retry dù chưa đạt max attempts. Tránh burn token vô ích.
 */
export const NO_PROGRESS_THRESHOLD = 3;

/**
 * Regex nhận diện lệnh an toàn để auto-retry. Chỉ test/build/lint/typecheck
 * được phép retry tự động; lệnh destructive (rm, drop, delete...) KHÔNG bao giờ.
 */
export const SAFE_DEBUG_COMMAND_RE =
  /\b(npm\s+(run\s+)?(test|build|lint|typecheck|check)|yarn\s+(test|build|lint|typecheck)|pnpm\s+(test|build|lint|typecheck|check)|bun\s+(test|build|lint|typecheck)|cargo\s+(test|build|check|clippy)|go\s+(test|build|vet)|pytest|python\s+-m\s+pytest|tsc(\s+--noEmit)?|eslint|prettier\s+--check|vitest|jest|mocha|phpunit|mvn\s+test|gradle\s+test)\b/i;

/** Regex chặn lệnh destructive — KHÔNG BAO GIỜ auto-retry. */
export const DESTRUCTIVE_COMMAND_RE =
  /\b(rm\s+-rf?|rmdir|del\s+\/[qs]|drop\s+(table|database)|delete\s+from|truncate|format|mkfs|dd\s+if=|chmod\s+-R\s+777|curl.*\|\s*(ba)?sh|wget.*\|\s*(ba)?sh)\b/i;

export interface DebugSession {
  /** Lệnh đang debug (normalized). */
  command: string;
  /** Số lần đã thử (bao gồm lần đầu). */
  attempts: number;
  /** Exit codes của các lần thử gần nhất (cho no-progress detection). */
  recentExitCodes: number[];
  /** Hash đơn giản của stderr gần nhất (so sánh nhanh no-progress). */
  recentStderrHashes: string[];
  /** Timestamp lần thử cuối. */
  lastAttemptAt: number;
}

export type DebugStore = Record<string, DebugSession>;

export function emptyDebugStore(): DebugStore {
  return {};
}

/** Normalize command để làm key: trim + lowercase + collapse whitespace. */
export function normalizeDebugCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Simple hash cho no-progress detection. Module-private, chỉ dùng nội bộ. */
function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < Math.min(text.length, 2000); i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return String(h);
}

/** Kiểm tra lệnh có an toàn để auto-retry không. */
export function isSafeDebugCommand(command: string): boolean {
  if (DESTRUCTIVE_COMMAND_RE.test(command)) return false;
  return SAFE_DEBUG_COMMAND_RE.test(command);
}

export interface RecordAttemptResult {
  /** Session sau khi ghi nhận. */
  session: DebugSession;
  /** true nếu nên dừng retry (đạt max hoặc no-progress). */
  shouldStop: boolean;
  /** Lý do dừng (nếu có). */
  stopReason?: 'max_attempts' | 'no_progress';
}

/**
 * Ghi nhận một lần thử lệnh debug. Trả session mới + cờ shouldStop.
 * Immutable — trả store mới.
 */
export function recordDebugAttempt(
  store: DebugStore,
  command: string,
  exitCode: number | null,
  stderrSnippet: string,
  maxAttempts: number = AUTO_DEBUG_MAX_ATTEMPTS_DEFAULT,
): { store: DebugStore; result: RecordAttemptResult } {
  const key = normalizeDebugCommand(command);
  const capped = Math.min(maxAttempts, AUTO_DEBUG_MAX_ATTEMPTS_LIMIT);
  const existing = store[key];

  const session: DebugSession = {
    command: key,
    attempts: (existing?.attempts ?? 0) + 1,
    recentExitCodes: [...(existing?.recentExitCodes ?? []), exitCode ?? -1].slice(-NO_PROGRESS_THRESHOLD),
    recentStderrHashes: [...(existing?.recentStderrHashes ?? []), simpleHash(stderrSnippet)].slice(-NO_PROGRESS_THRESHOLD),
    lastAttemptAt: Date.now(),
  };

  let shouldStop = false;
  let stopReason: RecordAttemptResult['stopReason'];

  if (session.attempts >= capped) {
    shouldStop = true;
    stopReason = 'max_attempts';
  } else if (
    session.recentExitCodes.length >= NO_PROGRESS_THRESHOLD &&
    session.recentExitCodes.every((c) => c === session.recentExitCodes[0]) &&
    session.recentStderrHashes.every((h) => h === session.recentStderrHashes[0])
  ) {
    shouldStop = true;
    stopReason = 'no_progress';
  }

  return {
    store: { ...store, [key]: session },
    result: { session, shouldStop, stopReason },
  };
}

/** Xóa session debug cho một lệnh (khi thành công hoặc user reset). */
export function clearDebugSession(store: DebugStore, command: string): DebugStore {
  const key = normalizeDebugCommand(command);
  if (!(key in store)) return store;
  const next = { ...store };
  delete next[key];
  return next;
}

/** Lấy session hiện tại cho một lệnh. Module-private, chỉ dùng trong tests. */
function getDebugSession(store: DebugStore, command: string): DebugSession | undefined {
  return store[normalizeDebugCommand(command)];
}

/**
 * Build retry guidance string để chèn vào shell_run result khi fail.
 * Hướng dẫn model sửa và retry thay vì bỏ cuộc.
 */
export function buildRetryGuidance(
  command: string,
  exitCode: number | null,
  attempt: number,
  maxAttempts: number,
  stopReason?: 'max_attempts' | 'no_progress',
): string {
  if (stopReason === 'max_attempts') {
    return (
      `[AUTO-DEBUG STOP] Lệnh "${command}" đã thất bại ${attempt} lần liên tiếp. ` +
      'Đã đạt giới hạn retry. DỪNG retry và báo người dùng rằng vấn đề cần xem xét thủ công. ' +
      'Tóm tắt các lỗi đã gặp và đề xuất hướng xử lý.'
    );
  }
  if (stopReason === 'no_progress') {
    return (
      `[AUTO-DEBUG STOP] Lệnh "${command}" thất bại ${attempt} lần với CÙNG MỘT LỖI. ` +
      'Không có tiến triển — DỪNG retry. Phân tích nguyên nhân gốc rễ và đề xuất cách tiếp cận KHÁC ' +
      '(thay vì sửa cùng một chỗ).'
    );
  }
  const remaining = maxAttempts - attempt;
  return (
    `[AUTO-DEBUG] Lệnh "${command}" thất bại (exit code ${exitCode ?? 'unknown'}, ` +
    `lần thử ${attempt}/${maxAttempts}, còn ${remaining} lần). ` +
    'Phân tích lỗi ở trên, sửa code cho đúng, rồi chạy LẠI CHÍNH LỆNH NÀY để kiểm chứng. ' +
    'Đừng bỏ cuộc — hãy thử sửa và verify.'
  );
}
