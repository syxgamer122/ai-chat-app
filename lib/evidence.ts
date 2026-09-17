/**
 * Evidence Ladder — bậc thang bằng chứng 4 cấp độ.
 *
 * Phân biệt rạch ròi giữa lời nói của model và bằng chứng thực tế:
 * - prepared: "Plan · not run" — kế hoạch đã sẵn, chưa chạy gì
 * - running: "Code · running" — executor đang chạy và đang được quan sát
 * - reported_done: "Code · reported done" — model/lệnh nói xong, CHƯA AI KIỂM CHỨNG
 * - verified: "Test · verified" — test/CI thật sự pass (có VerificationReceipt exitCode=0 & qua completion gate)
 * - blocked / failed: bị chặn có lý do hoặc thất bại terminal.
 */

import type { VerificationReceipt } from '@/lib/verification';
import { evaluateCompletionIntegrity } from '@/lib/completion-gate';

export type EvidenceLevel =
  | 'prepared'
  | 'running'
  | 'reported_done'
  | 'verified'
  | 'blocked'
  | 'failed';

export interface EvidenceHistoryEntry {
  level: EvidenceLevel;
  timestamp: number;
  note?: string;
}

export interface EvidenceState {
  level: EvidenceLevel;
  receipt?: VerificationReceipt;
  blockedReason?: string;
  failureReason?: string;
  integrityViolations?: string[];
  history: EvidenceHistoryEntry[];
}

export function createInitialEvidence(level: EvidenceLevel = 'prepared'): EvidenceState {
  return {
    level,
    history: [{ level, timestamp: Date.now() }],
  };
}

/**
 * Chuyển trạng thái bằng chứng theo quy tắc nghiêm ngặt:
 * Không bao giờ nhảy lên 'verified' nếu không có VerificationReceipt pass và qua được Completion Gate!
 */
export function transitionEvidence(
  current: EvidenceState,
  target: EvidenceLevel,
  context?: {
    receipt?: VerificationReceipt;
    diff?: string;
    blockedReason?: string;
    failureReason?: string;
    note?: string;
    timestamp?: number;
  },
): { state: EvidenceState; error?: string } {
  const now = context?.timestamp ?? Date.now();

  // 1. Nếu đích đến là 'verified'
  if (target === 'verified') {
    if (!context?.receipt) {
      // Thiếu receipt -> chỉ được nâng lên 'reported_done'
      const fallbackState: EvidenceState = {
        ...current,
        level: 'reported_done',
        history: [
          ...current.history,
          {
            level: 'reported_done',
            timestamp: now,
            note: 'Model báo xong nhưng chưa có biên nhận kiểm thử thực tế',
          },
        ],
      };
      return {
        state: fallbackState,
        error: 'Thiếu VerificationReceipt: không thể xác minh khi chưa chạy test thực tế.',
      };
    }

    if (context.receipt.exitCode !== 0) {
      // Lệnh kiểm thử trả về lỗi
      const failedState: EvidenceState = {
        ...current,
        level: 'failed',
        receipt: context.receipt,
        failureReason: `Lệnh kiểm thử thất bại với exit code ${context.receipt.exitCode}`,
        history: [
          ...current.history,
          {
            level: 'failed',
            timestamp: now,
            note: `Kiểm thử không đạt: ${context.receipt.command}`,
          },
        ],
      };
      return {
        state: failedState,
        error: `Kiểm thử thất bại (exit code ${context.receipt.exitCode}).`,
      };
    }

    // Kiểm tra tính liêm chính của code / diff qua Completion Gate
    if (context.diff) {
      const gateResult = evaluateCompletionIntegrity(context.diff);
      if (!gateResult.ok) {
        const fallbackState: EvidenceState = {
          ...current,
          level: 'reported_done',
          receipt: context.receipt,
          integrityViolations: gateResult.violations,
          history: [
            ...current.history,
            {
              level: 'reported_done',
              timestamp: now,
              note: `Bị chặn bởi Completion Gate: ${gateResult.violations.join('; ')}`,
            },
          ],
        };
        return {
          state: fallbackState,
          error: `Completion Gate từ chối xác minh: ${gateResult.violations.join('; ')}`,
        };
      }
    }

    // Đạt đủ mọi tiêu chuẩn -> verified
    const verifiedState: EvidenceState = {
      ...current,
      level: 'verified',
      receipt: context.receipt,
      integrityViolations: undefined,
      history: [
        ...current.history,
        {
          level: 'verified',
          timestamp: now,
          note: context.note || `Đã kiểm chứng thành công bằng: ${context.receipt.command}`,
        },
      ],
    };
    return { state: verifiedState };
  }

  // 2. Chuyển sang các trạng thái khác
  const nextState: EvidenceState = {
    ...current,
    level: target,
    receipt: context?.receipt ?? current.receipt,
    blockedReason: target === 'blocked' ? context?.blockedReason : undefined,
    failureReason: target === 'failed' ? context?.failureReason : undefined,
    history: [
      ...current.history,
      {
        level: target,
        timestamp: now,
        note: context?.note || (target === 'blocked' ? context?.blockedReason : undefined),
      },
    ],
  };

  return { state: nextState };
}

/**
 * Trả về nhãn định dạng chuẩn hiển thị trên UI badge.
 */
export function describeEvidence(level: EvidenceLevel): {
  stage: string;
  cert: string;
  badgeText: string;
  variant: 'default' | 'running' | 'warning' | 'success' | 'danger';
} {
  switch (level) {
    case 'prepared':
      return {
        stage: 'Plan',
        cert: 'not run',
        badgeText: 'Plan · not run',
        variant: 'default',
      };
    case 'running':
      return {
        stage: 'Code',
        cert: 'running',
        badgeText: 'Code · running',
        variant: 'running',
      };
    case 'reported_done':
      return {
        stage: 'Code',
        cert: 'reported done',
        badgeText: 'Code · reported done',
        variant: 'warning',
      };
    case 'verified':
      return {
        stage: 'Test',
        cert: 'verified',
        badgeText: 'Test · verified',
        variant: 'success',
      };
    case 'blocked':
      return {
        stage: 'Blocked',
        cert: 'blocked',
        badgeText: 'Blocked',
        variant: 'danger',
      };
    case 'failed':
      return {
        stage: 'Failed',
        cert: 'failed',
        badgeText: 'Failed',
        variant: 'danger',
      };
  }
}
