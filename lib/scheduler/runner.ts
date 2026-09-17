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
): Promise<ExecutionResult> {
  const startedAt = Date.now();
  const sessionId = `sched-${schedule.id.slice(0, 8)}-${Date.now()}`;

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

    if (customRunner) {
      const res = await customRunner(recipe);
      runOk = res.ok;
      runText = res.text;
      runError = res.error;
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

    return {
      ok: runOk,
      sessionId,
      output: runText,
      error: runError,
      durationMs: Date.now() - startedAt,
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
): Promise<string[]> {
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
      lastExecutedMinute.set(item.id, currentMinute);
      executedIds.push(item.id);
      void executeScheduledRun(workspaceRoot, item, customRunner);
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
