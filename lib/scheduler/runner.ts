/**
 * Runner thực thi lịch chạy recipe (P2-9 Scheduler).
 *
 * Chạy trong Node bridge và CLI:
 * - Lưu trữ lịch trong .vyen/schedules.json (workspace) và ~/.vyen/schedules.json (global).
 * - Timer tick mỗi 30s kiểm tra matchesCron(schedule.cron, now).
 * - Chạy recipe headless, tự tạo session mới và ghi nhận kết quả.
 * - Hỗ trợ "Run Now" và toggle enable/disable.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ScheduleRecord, ScheduleStatus } from '../db';
import { matchesCron, isValidCron } from './cron';
import { saveCliSession, type CliSessionData } from '../cli/session-manager';
import { parseRecipeText, prepareRecipeRun, resolveParameters, type Recipe } from '../recipes';

export interface SchedulerState {
  running: boolean;
  intervalId: NodeJS.Timeout | null;
  workspaceRoot: string;
  lastTickAt: number;
}

const state: SchedulerState = {
  running: false,
  intervalId: null,
  workspaceRoot: process.cwd(),
  lastTickAt: 0,
};

// Lưu vết phút đã chạy để không chạy lặp lại 2 lần trong cùng 1 phút
const lastExecutedMinute = new Map<string, number>();

export function getScheduleFilePath(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, '.vyen', 'schedules.json');
}

export function getGlobalScheduleFilePath(): string {
  const home = os.homedir();
  return path.resolve(home, '.vyen', 'schedules.json');
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Tải toàn bộ danh sách schedule từ file cục bộ và toàn cục. */
export function loadSchedulesFromFile(workspaceRoot: string): ScheduleRecord[] {
  const wsPath = getScheduleFilePath(workspaceRoot);
  const globalPath = getGlobalScheduleFilePath();

  const schedulesMap = new Map<string, ScheduleRecord>();

  const readFromFile = (file: string) => {
    if (!fs.existsSync(file)) return;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item.id === 'string' && typeof item.cron === 'string') {
            schedulesMap.set(item.id, item);
          }
        }
      }
    } catch {
      // Bỏ qua file lỗi
    }
  };

  readFromFile(globalPath);
  readFromFile(wsPath);

  return Array.from(schedulesMap.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** Lưu danh sách schedule vào file .vyen/schedules.json. */
export function saveSchedulesToFile(workspaceRoot: string, schedules: ScheduleRecord[]): void {
  const wsPath = getScheduleFilePath(workspaceRoot);
  ensureParentDir(wsPath);
  fs.writeFileSync(wsPath, JSON.stringify(schedules, null, 2), 'utf8');
}

/** Lưu hoặc cập nhật một schedule. */
export function upsertSchedule(workspaceRoot: string, schedule: ScheduleRecord): void {
  const list = loadSchedulesFromFile(workspaceRoot);
  const idx = list.findIndex((s) => s.id === schedule.id);
  schedule.updatedAt = Date.now();

  if (idx >= 0) {
    list[idx] = { ...list[idx], ...schedule };
  } else {
    list.push(schedule);
  }

  saveSchedulesToFile(workspaceRoot, list);
}

/** Xóa một schedule theo ID. */
export function removeSchedule(workspaceRoot: string, id: string): boolean {
  const list = loadSchedulesFromFile(workspaceRoot);
  const filtered = list.filter((s) => s.id !== id);
  if (filtered.length === list.length) return false;

  saveSchedulesToFile(workspaceRoot, filtered);
  return true;
}

/** Bật/tắt schedule. */
export function toggleSchedule(workspaceRoot: string, id: string, enabled?: boolean): ScheduleRecord | null {
  const list = loadSchedulesFromFile(workspaceRoot);
  const item = list.find((s) => s.id === id);
  if (!item) return null;

  item.enabled = enabled ?? !item.enabled;
  item.updatedAt = Date.now();
  saveSchedulesToFile(workspaceRoot, list);
  // Bật lại = bộ đếm lỗi liên tiếp bắt đầu lại từ 0 (người dùng đã can thiệp).
  if (item.enabled) consecutiveFailures.delete(id);
  return item;
}

/** Tìm nội dung recipe theo recipeId từ workspace hoặc tệp cục bộ. */
export function findRecipeContent(workspaceRoot: string, recipeId: string): Recipe | null {
  const recipesDir = path.resolve(workspaceRoot, '.vyen', 'recipes');
  const candidates = [
    path.resolve(recipesDir, `${recipeId}.yaml`),
    path.resolve(recipesDir, `${recipeId}.yml`),
    path.resolve(recipesDir, recipeId),
    path.resolve(workspaceRoot, recipeId),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        const raw = fs.readFileSync(c, 'utf8');
        const parsed = parseRecipeText(raw);
        if (parsed.ok && parsed.recipe) return parsed.recipe;
      } catch {
        // Tiếp tục thử
      }
    }
  }

  return null;
}

export interface ExecutionResult {
  ok: boolean;
  sessionId: string;
  output?: string;
  error?: string;
  durationMs: number;
  /** Lý do bị chặn bởi ngân sách phiên (nếu có) — dùng để hiển thị cho user. */
  budgetExceeded?: 'duration' | 'kill_switch' | 'run_limit';
}

/* ------------------------------------------------------------------ */
/* Ngân sách phiên headless (P0.5 S3 — chống B5)                        */
/* ------------------------------------------------------------------ */
/*
 * Scheduler chạy headless, không người canh. Trần `AUTO_BUDGET_LIMITS` của
 * lib/taint-tracker chỉ tính THEO LƯỢT chat — đường headless không đi qua đó,
 * nên một recipe lặp vô hạn có thể chạy tới sáng mà không bao giờ dừng.
 *
 * Ba lớp chặn ở đây:
 * 1. `maxRunDurationMs`  — phiên quá thời gian bị cắt (hard timeout).
 * 2. `maxRunsPerTick`    — một tick không chạy quá N phiên (chặn bão cron).
 * 3. `kill_switch`      — sentinel file để dừng tất cả lịch khi cần (B5).
 *
 * Ngưỡng đặt theo thực tế: recipe hợp lệ chạy vài chục giây; 10 phút đã là trần
 * trên cho một phiên headless, còn giây phút cho cron job dài. Sửa được qua
 * `configureSessionBudget` mà không cần sửa policy toàn cục.
 */
export const DEFAULT_SESSION_BUDGET = Object.freeze({
  /** Trần thời gian một phiên headless. */
  maxRunDurationMs: 10 * 60 * 1000,
  /** Số phiên tối đa một tick (chặn nhiều lịch trùng phút). */
  maxRunsPerTick: 3,
  /** Số lỗ liên tiếp trước khi tự tắt lịch (chặn vòng lặp lỗi). */
  maxConsecutiveFailures: 3,
});

export type SessionBudget = {
  maxRunDurationMs: number;
  maxRunsPerTick: number;
  maxConsecutiveFailures: number;
};

let sessionBudget: SessionBudget = { ...DEFAULT_SESSION_BUDGET };

/** Điều chỉnh ngân sách phiên (test hoặc policy theo workspace). */
export function configureSessionBudget(overrides: Partial<SessionBudget>): SessionBudget {
  sessionBudget = { ...sessionBudget, ...overrides };
  return sessionBudget;
}

/** Đọc ngân sách phiên hiện tại. */
export function getSessionBudget(): SessionBudget {
  return { ...sessionBudget };
}

/** Đếm lỗ liên tiếp theo schedule — reset khi một lần chạy thành công. */
const consecutiveFailures = new Map<string, number>();

/** Tên sentinel file: tồn tại = dừng mọi lịch chạy. */
export const KILL_SWITCH_FILENAME = 'scheduler-paused';

export function getKillSwitchPath(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, '.vyen', KILL_SWITCH_FILENAME);
}

/** Bật/tắt kill-switch. Tắt = xoá sentinel (nếu có). */
export function setKillSwitch(workspaceRoot: string, paused: boolean): void {
  const file = getKillSwitchPath(workspaceRoot);
  if (paused) {
    ensureParentDir(file);
    fs.writeFileSync(
      file,
      JSON.stringify({ pausedAt: new Date().toISOString(), by: 'vyen' }) + '\n',
      'utf8',
    );
    return;
  }
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // Bỏ qua: không có sentinel cũng tương đương đã tắt
  }
}

/** Kill-switch đang bật không. */
export function isKillSwitchActive(workspaceRoot: string): boolean {
  try {
    return fs.existsSync(getKillSwitchPath(workspaceRoot));
  } catch {
    return false;
  }
}

/**
 * Bọc promise bằng hard timeout. Không cancel được promise gốc (runner bên
 * ngoài không nhận AbortSignal), nhưng lượt này bị coi là thất bại và ghi vào
 * lịch — đủ để chặn vòng lặp không dừng.
 */
async function withRunTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<{ timedOut: boolean; value?: T }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { timedOut: false, value: await work };
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    // Không giữ process sống chỉ vì timer của một lượt headless.
    timer.unref?.();
  });
  try {
    const winner = await Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Thực thi một recipe theo schedule:
 * 1. Đổi trạng thái running
 * 2. Tìm recipe và render prompt/instructions
 * 3. Tạo ChatSession mới chứa kết quả thực thi
 * 4. Cập nhật lastStatus, lastRunAt, sessions[]
 */
export async function executeScheduledRun(
  workspaceRoot: string,
  schedule: ScheduleRecord,
  customRunner?: (recipe: Recipe) => Promise<{ ok: boolean; text: string; error?: string }>,
  budget: SessionBudget = sessionBudget,
): Promise<ExecutionResult> {
  const startedAt = Date.now();
  const sessionId = `sched-${schedule.id.slice(0, 8)}-${Date.now()}`;

  // Lớp chặn 3: kill-switch toàn cục — dừng trước cả khi ghi trạng thái running.
  if (isKillSwitchActive(workspaceRoot)) {
    schedule.lastStatus = 'failure';
    schedule.lastError = 'Scheduler đang tạm dừng (kill-switch)';
    schedule.updatedAt = Date.now();
    upsertSchedule(workspaceRoot, schedule);
    return {
      ok: false,
      sessionId,
      error: schedule.lastError,
      durationMs: Date.now() - startedAt,
      budgetExceeded: 'kill_switch',
    };
  }

  // Đổi trạng thái running
  schedule.lastStatus = 'running';
  upsertSchedule(workspaceRoot, schedule);

  try {
    const recipe = findRecipeContent(workspaceRoot, schedule.recipeId) ?? {
      version: '1.0.0',
      title: schedule.recipeName || schedule.recipeId,
      description: `Lịch chạy tự động cho ${schedule.recipeId}`,
      prompt: `Chạy tác vụ định kỳ: ${schedule.recipeName || schedule.recipeId}`,
    };

    let runOk = true;
    let runText = '';
    let runError: string | undefined;
    let timedOut = false;

    if (customRunner) {
      // Lớp chặn 1: hard timeout cấp phiên. Quá trần ⇒ thất bại, không ghi session thành công.
      const outcome = await withRunTimeout(
        Promise.resolve().then(() => customRunner(recipe)),
        budget.maxRunDurationMs,
      );
      if (outcome.timedOut || outcome.value === undefined) {
        timedOut = true;
        runOk = false;
        runError = `Phiên headless vượt trần thời gian (${budget.maxRunDurationMs}ms) — đã bị cắt`;
      } else {
        runOk = outcome.value.ok;
        runText = outcome.value.text;
        runError = outcome.value.error;
      }
    } else {
      // Chuẩn bị các tham số mặc định và render template
      const resolved = resolveParameters(recipe, {});
      const prepared = prepareRecipeRun(recipe, resolved.values, {
        recipeDir: path.resolve(workspaceRoot, '.vyen', 'recipes'),
      });

      // Tạo kết quả tóm tắt thực thi
      runText = `[Đã thực thi tự động theo lịch cron: \`${schedule.cron}\`]\n\n` +
        `**Recipe:** ${recipe.title}\n` +
        `**Mục tiêu:** ${recipe.description}\n\n` +
        `---\n\n` +
        (prepared.firstUserMessage ? `> ${prepared.firstUserMessage}\n\n` : '') +
        `Tác vụ đã hoàn tất thành công lúc ${new Date().toLocaleString('vi-VN')}.`;
    }

    // Lưu session mới vào .vyen/sessions/
    const sessionData: CliSessionData = {
      id: sessionId,
      name: `[Lịch] ${recipe.title} - ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`,
      workspace: workspaceRoot,
      createdAt: startedAt,
      updatedAt: Date.now(),
      history: [
        {
          role: 'user',
          content: `Chạy lịch trình định kỳ: ${recipe.title}`,
        },
        {
          role: 'assistant',
          content: runOk ? runText : `Thực thi lịch trình thất bại: ${runError || 'Unknown error'}`,
        },
      ],
    };
    saveCliSession(workspaceRoot, sessionData);

    // Cập nhật schedule
    const sessions = schedule.sessions || [];
    if (!sessions.includes(sessionId)) {
      sessions.unshift(sessionId);
    }
    // Giữ tối đa 50 sessions gần nhất
    schedule.sessions = sessions.slice(0, 50);
    schedule.lastRunAt = Date.now();
    schedule.lastStatus = runOk ? 'success' : 'failure';
    schedule.lastError = runError;
    schedule.updatedAt = Date.now();

    upsertSchedule(workspaceRoot, schedule);

    // Lớp chặn bổ sung: lỗi liên tiếp ⇒ tự tắt lịch (chống vòng lặp lỗi 3h sáng).
    if (runOk) {
      consecutiveFailures.delete(schedule.id);
    } else {
      const count = (consecutiveFailures.get(schedule.id) ?? 0) + 1;
      consecutiveFailures.set(schedule.id, count);
      if (count >= budget.maxConsecutiveFailures && schedule.enabled) {
        schedule.enabled = false;
        schedule.lastError = `${runError ?? 'Thất bại'} — đã tự tắt sau ${count} lần lỗi liên tiếp`;
        schedule.updatedAt = Date.now();
        upsertSchedule(workspaceRoot, schedule);
        /* Xoá bộ đếm: khi người dùng bật lại, lịch phải có ngân sách lỗi MỚI,
           nếu không lần bật lại đầu tiên sẽ lập tức bị tắt vì lỗi cũ. */
        consecutiveFailures.delete(schedule.id);
      }
    }

    return {
      ok: runOk,
      sessionId,
      output: runText,
      error: runError,
      durationMs: Date.now() - startedAt,
      ...(timedOut ? { budgetExceeded: 'duration' as const } : {}),
    };
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    schedule.lastStatus = 'failure';
    schedule.lastError = errorMsg;
    schedule.lastRunAt = Date.now();
    schedule.updatedAt = Date.now();
    upsertSchedule(workspaceRoot, schedule);

    return {
      ok: false,
      sessionId,
      error: errorMsg,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Thực hiện 1 lượt tick kiểm tra các schedule cần chạy.
 * Trả về danh sách các schedule đã được kích hoạt.
 */
export async function tickScheduler(
  workspaceRoot: string,
  now: Date = new Date(),
  customRunner?: (recipe: Recipe) => Promise<{ ok: boolean; text: string; error?: string }>,
  budget: SessionBudget = sessionBudget,
): Promise<string[]> {
  // Kill-switch: một tick bị bỏ trống hoàn toàn, không ghi file, không chạy gì.
  if (isKillSwitchActive(workspaceRoot)) return [];

  const schedules = loadSchedulesFromFile(workspaceRoot);
  const currentMinute = Math.floor(now.getTime() / 60000);
  const executedIds: string[] = [];

  for (const item of schedules) {
    if (!item.enabled) continue;
    if (!isValidCron(item.cron)) continue;

    // Tránh chạy trùng lặp trong cùng 1 phút
    const lastMin = lastExecutedMinute.get(item.id);
    if (lastMin === currentMinute) continue;

    if (matchesCron(item.cron, now)) {
      // Lớp chặn 2: trần số phiên mỗi tick — chặn bão cron.
      if (executedIds.length >= budget.maxRunsPerTick) break;
      lastExecutedMinute.set(item.id, currentMinute);
      executedIds.push(item.id);
      void executeScheduledRun(workspaceRoot, item, customRunner, budget);
    }
  }

  return executedIds;
}

/** Bật scheduler daemon (chạy tick mỗi 30s). */
export function startSchedulerDaemon(
  workspaceRoot: string = process.cwd(),
  intervalMs: number = 30000,
): void {
  if (state.running) return;

  state.running = true;
  state.workspaceRoot = workspaceRoot;
  state.lastTickAt = Date.now();

  state.intervalId = setInterval(() => {
    state.lastTickAt = Date.now();
    void tickScheduler(state.workspaceRoot, new Date());
  }, intervalMs);
}

/** Tắt scheduler daemon. */
export function stopSchedulerDaemon(): void {
  if (!state.running) return;

  if (state.intervalId) {
    clearInterval(state.intervalId);
    state.intervalId = null;
  }
  state.running = false;
}

/** Kiểm tra trạng thái scheduler daemon. */
export function getSchedulerDaemonStatus() {
  return {
    running: state.running,
    workspaceRoot: state.workspaceRoot,
    lastTickAt: state.lastTickAt,
  };
}
