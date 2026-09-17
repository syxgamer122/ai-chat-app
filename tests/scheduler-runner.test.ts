import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadSchedulesFromFile,
  saveSchedulesToFile,
  upsertSchedule,
  removeSchedule,
  toggleSchedule,
  executeScheduledRun,
  tickScheduler,
} from '@/lib/scheduler/runner';
import type { ScheduleRecord } from '@/lib/db';
import { loadCliSession } from '@/lib/cli/session-manager';

describe('Scheduler Runner Engine (P2-9)', { timeout: 15000 }, () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyen-scheduler-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('lưu, tải, sửa, bật/tắt và xóa schedule trong file workspace', () => {
    const s1: ScheduleRecord = {
      id: 'sched-1',
      recipeId: 'git-log-summary',
      recipeName: 'Tóm tắt git log',
      cron: '*/5 * * * *',
      enabled: true,
      sessions: [],
      createdAt: 1000,
      updatedAt: 1000,
    };

    upsertSchedule(tmpDir, s1);

    const loaded = loadSchedulesFromFile(tmpDir);
    expect(loaded.some((s) => s.id === 'sched-1')).toBe(true);

    // Toggle tắt
    const toggled = toggleSchedule(tmpDir, 'sched-1', false);
    expect(toggled?.enabled).toBe(false);

    // Xóa schedule
    const removed = removeSchedule(tmpDir, 'sched-1');
    expect(removed).toBe(true);
    expect(loadSchedulesFromFile(tmpDir).some((s) => s.id === 'sched-1')).toBe(false);
  });

  it('thực thi executeScheduledRun tạo session mới và ghi nhận kết quả thành công', async () => {
    const s: ScheduleRecord = {
      id: 'sched-test-run',
      recipeId: 'daily-report',
      recipeName: 'Báo cáo hàng ngày',
      cron: '0 9 * * *',
      enabled: true,
      sessions: [],
      createdAt: 1000,
      updatedAt: 1000,
    };

    const result = await executeScheduledRun(tmpDir, s, async (recipe) => {
      return { ok: true, text: `Đã hoàn thành ${recipe.title} không có lỗi.` };
    });

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeDefined();

    // Kiểm tra session đã được lưu vào .vyen/sessions/
    const session = loadCliSession(tmpDir, result.sessionId);
    expect(session).toBeDefined();
    expect(session?.history).toHaveLength(2);
    expect(session?.history[1].content).toContain('Báo cáo hàng ngày');

    // Kiểm tra schedule được cập nhật
    const reloaded = loadSchedulesFromFile(tmpDir).find((item) => item.id === 'sched-test-run');
    expect(reloaded).toBeDefined();
    expect(reloaded?.lastStatus).toBe('success');
    expect(reloaded?.sessions).toContain(result.sessionId);
  });

  it('tickScheduler chỉ kích hoạt các schedule khớp thời gian và enabled', async () => {
    const now = new Date(2026, 8, 13, 10, 15, 0); // 10:15

    const activeSchedule: ScheduleRecord = {
      id: 'sched-active',
      recipeId: 'check-tests',
      recipeName: 'Kiểm tra test',
      cron: '*/5 * * * *', // khớp phút 15
      enabled: true,
      sessions: [],
      createdAt: 1000,
      updatedAt: 1000,
    };

    const disabledSchedule: ScheduleRecord = {
      id: 'sched-disabled',
      recipeId: 'disabled-task',
      cron: '*/5 * * * *',
      enabled: false,
      sessions: [],
      createdAt: 1000,
      updatedAt: 1000,
    };

    const unmatchingSchedule: ScheduleRecord = {
      id: 'sched-unmatched',
      recipeId: 'hourly-task',
      cron: '0 * * * *', // chỉ khớp phút 0
      enabled: true,
      sessions: [],
      createdAt: 1000,
      updatedAt: 1000,
    };

    saveSchedulesToFile(tmpDir, [activeSchedule, disabledSchedule, unmatchingSchedule]);

    const triggered = await tickScheduler(tmpDir, now);
    expect(triggered).toContain('sched-active');
    expect(triggered).not.toContain('sched-disabled');
    expect(triggered).not.toContain('sched-unmatched');

    // Chạy lại trong cùng 1 phút -> không chạy trùng lặp
    const reTriggered = await tickScheduler(tmpDir, now);
    expect(reTriggered).toEqual([]);
  });
});
