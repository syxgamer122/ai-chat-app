/**
 * Fanout Retry Classifier & Replay Safety Probe.
 *
 * Hai câu hỏi bắt buộc trước khi retry:
 * 1. Lỗi có phải transient không?
 *    - Rate limit, 429, overload, 5xx, socket reset = transient.
 *    - Exit code non-zero của test LÀ CÂU TRẢ LỜI CỦA UNIT = terminal (cấm retry!).
 * 2. Unit có replay-safe không?
 *    - Probe kiểm tra worktree / staging overlay: nếu đã có file bị ghi hoặc sửa đổi,
 *      tuyệt đối KHÔNG chạy lại ("tôi không chắc" thì fail closed!).
 */

export interface ErrorClassification {
  isTransient: boolean;
  category: 'rate_limit' | 'transport' | 'test_failure' | 'permission' | 'unknown_terminal';
  reason: string;
}

export function classifyFailure(err: unknown, exitCode?: number): ErrorClassification {
  // 1. Kiểm tra exit code từ lệnh kiểm thử / script thực thi
  if (exitCode !== undefined && exitCode !== 0) {
    return {
      isTransient: false,
      category: 'test_failure',
      reason: `Tiến trình kết thúc với mã lỗi non-zero (${exitCode}) — đây là kết quả của bài kiểm thử, không phải lỗi tạm thời.`,
    };
  }

  const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase();

  // 2. Lỗi rate limit / 429
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return {
      isTransient: true,
      category: 'rate_limit',
      reason: 'Bị giới hạn tốc độ upstream (HTTP 429 / Rate Limit).',
    };
  }

  // 3. Lỗi transport / socket / 5xx
  if (
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('etimedout') ||
    msg.includes('fetch failed')
  ) {
    return {
      isTransient: true,
      category: 'transport',
      reason: 'Lỗi đường truyền mạng hoặc máy chủ upstream quá tải.',
    };
  }

  // 4. Lỗi quyền hạn
  if (msg.includes('eacces') || msg.includes('permission denied') || msg.includes('unauthorized')) {
    return {
      isTransient: false,
      category: 'permission',
      reason: 'Lỗi quyền truy cập ranh giới.',
    };
  }

  return {
    isTransient: false,
    category: 'unknown_terminal',
    reason: `Lỗi không xác định: ${msg}`,
  };
}

export interface ReplayProbeState {
  filesModified: number;
  bytesWritten: number;
  gitStatusDirty?: boolean;
}

export function probeReplaySafety(state: ReplayProbeState): {
  replaySafe: boolean;
  reason: string;
} {
  if (state.filesModified > 0 || state.bytesWritten > 0 || state.gitStatusDirty) {
    return {
      replaySafe: false,
      reason: `Phát hiện side effect (${state.filesModified} files modified, ${state.bytesWritten} bytes written) — chặn replay để bảo vệ tính toàn vẹn.`,
    };
  }

  return {
    replaySafe: true,
    reason: 'Trạng thái sạch, chưa quan sát thấy tác dụng phụ ghi đĩa.',
  };
}

/**
 * Tính thời gian backoff có jitter để tránh N unit cùng retry một lúc khi đụng rate-limit.
 * Công thức: min(2s * 2^(attempt-1), 30s) * (0.75 + random * 0.25)
 */
export function computeBackoffMs(
  attempt: number,
  baseMs = 2000,
  maxMs = 30000,
  randomFactor?: number,
): number {
  const safeAttempt = Math.max(1, attempt);
  const rawBackoff = Math.min(baseMs * Math.pow(2, safeAttempt - 1), maxMs);
  const factor = randomFactor !== undefined ? randomFactor : 0.75 + Math.random() * 0.25;
  return Math.floor(rawBackoff * factor);
}
