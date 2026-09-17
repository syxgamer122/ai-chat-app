/**
 * Retry state machine cho recipe — bounded, an toàn, KHÔNG chạy shell.
 *
 * Triết lý tái dùng lib/debug-loop.ts: không xây outer loop mù
 * quáng; mọi quyết định "chạy lại hay dừng" là HÀM THUẦN nhận kết quả check
 * rồi trả action — UI/CLI chịu trách nhiệm chạy lệnh (qua shell_run có
 * phê duyệt như mọi lệnh khác).
 *
 * Luật: lần chạy đầu = attempt 1; tối đa thêm `max_retries` lần chạy lại
 * (tổng 1 + max_retries). Check destructive → không bao giờ auto-retry.
 */

import { DESTRUCTIVE_COMMAND_RE } from '@/lib/debug-loop';
import type { Recipe } from './schema';

export interface RetryCheckOutcome {
  command: string;
  exitCode: number | null;
  ok: boolean;
  /** Vài dòng output cuối (đưa vào prompt cho attempt kế). */
  tail?: string;
}

export interface RetryState {
  /** Lần đang chạy (1 = lần đầu). */
  attempt: number;
  /** max_retries của recipe (số lần CHẠY LẠI sau lần đầu). */
  maxRetries: number;
}

export type RetryAction =
  | { action: 'pass'; attemptsUsed: number }
  | { action: 'retry'; nextAttempt: number; failurePrompt: string; remaining: number }
  | { action: 'stop'; reason: 'max_retries' | 'destructive_check' | 'no_checks'; attemptsUsed: number };

/** Toàn bộ check pass ⟺ không có check nào fail. */
export function evaluateChecks(outcomes: readonly RetryCheckOutcome[]): boolean {
  return outcomes.length > 0 && outcomes.every((o) => o.ok);
}

/** Lệnh destructive không bao giờ được auto-retry (hàng rào debug-loop). */
export function isRetryableCommand(command: string): boolean {
  return !DESTRUCTIVE_COMMAND_RE.test(command);
}

function defaultFailurePrompt(failed: readonly RetryCheckOutcome[], attempt: number, maxTotal: number): string {
  const lines = failed.map(
    (f) => `- \`${f.command}\` exit=${f.exitCode ?? '?'}${f.tail ? `\n${f.tail.slice(0, 1_500)}` : ''}`,
  );
  return [
    `[RECIPE RETRY ${attempt}/${maxTotal}] Lần chạy trước CHƯA ĐẠT — các kiểm chứng thất bại:`,
    lines.join('\n'),
    'Hãy phân tích nguyên nhân gốc rễ từ output ở trên, sửa code, rồi hoàn thành lại toàn bộ yêu cầu ban đầu.',
    'KHÔNG lặp lại đúng cách làm đã fail — đổi hướng tiếp cận cho phần gây lỗi.',
  ].join('\n\n');
}

/**
 * Quyết định hành động kế tiếp sau khi agent tuyên bố xong và checks đã chạy.
 * `checksBlocked` = true khi có lệnh check bị chặn phê duyệt (user deny) —
 * coi như fail nhưng KHÔNG auto-retry vì ta không biết trạng thái thật.
 */
export function nextRetryAction(args: {
  recipe: Pick<Recipe, 'retry' | 'title'>;
  state: RetryState;
  outcomes: readonly RetryCheckOutcome[];
  values?: Record<string, string | number | boolean>;
  checksBlocked?: boolean;
}): RetryAction {
  const { recipe, state, outcomes } = args;
  const retryCfg = recipe.retry;
  const maxTotal = 1 + state.maxRetries;

  if (!retryCfg || retryCfg.checks.length === 0) {
    // Recipe không khai báo check: tin lời agent, coi như pass.
    return { action: 'pass', attemptsUsed: state.attempt };
  }

  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) {
    return { action: 'pass', attemptsUsed: state.attempt };
  }

  // Lệnh destructive fail → dừng hẳn, không tự chạy lại (an toàn).
  if (failed.some((f) => !isRetryableCommand(f.command))) {
    return { action: 'stop', reason: 'destructive_check', attemptsUsed: state.attempt };
  }
  if (args.checksBlocked) {
    return { action: 'stop', reason: 'max_retries', attemptsUsed: state.attempt };
  }

  if (state.attempt >= maxTotal) {
    return { action: 'stop', reason: 'max_retries', attemptsUsed: state.attempt };
  }

  const rendered = retryCfg.on_failure
    ? `${retryCfg.on_failure}\n\n${defaultFailurePrompt(failed, state.attempt, maxTotal)}`
    : defaultFailurePrompt(failed, state.attempt, maxTotal);

  return {
    action: 'retry',
    nextAttempt: state.attempt + 1,
    remaining: maxTotal - state.attempt,
    failurePrompt: rendered,
  };
}

/** Khối chú thích JSON-strict chèn vào lượt CUỐI khi recipe có json_schema. */
export function structuredOutputDirective(schemaJson: string): string {
  return (
    '[STRUCTURED OUTPUT] Ở phản hồi CUỐI CÙNG (sau khi mọi kiểm chứng đã pass), ' +
    'trả MỘT khối JSON duy nhất tuân thủ schema sau (bọc trong ```json), không ' +
    'viết gì khác ngoài khối JSON và tối đa 2 câu giải thích ngắn TRƯỚC khối:\n' +
    '```json\n' +
    schemaJson +
    '\n```'
  );
}
