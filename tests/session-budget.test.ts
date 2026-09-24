import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULT_SESSION_BUDGET,
  configureSessionBudget,
  getKillSwitchPath,
  getSessionBudget,
  isKillSwitchActive,
  setKillSwitch,
  executeScheduledRun,
  tickScheduler,
  toggleSchedule,
  loadSchedulesFromFile,
} from '@/lib/scheduler/runner';
import type { ScheduleRecord } from '@/lib/db';
import type { Recipe } from '@/lib/recipes';

describe('Session Budget — ngân sách phiên headless (B5)', { timeout: 15000 }, () => {
  let tmpDir: string;

  const schedule = (overrides: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
    id: 'sched-budget-1',
    recipeId: 'loop',
    recipeName: 'Vòng lặp vô hạn',
    cron: '* * * * *',
    enabled: true,
    sessions: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyen-budget-test-'));
    configureSessionBudget({ ...DEFAULT_SESSION_BUDGET });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('mặc định', () => {
    it('có trần thời gian, trần số phiên mỗi tick và trần lỗi liên tiếp', () => {
      const b = getSessionBudget();
      expect(b.maxRunDurationMs).toBe(10 * 60 * 1000);
      expect(b.maxRunsPerTick).toBe(3);
      expect(b.maxConsecutiveFailures).toBe(3);
    });

    it('configureSessionBudget trả về ngân sách mới và không đổi object mặc định', () => {
      const updated = configureSessionBudget({ maxRunDurationMs: 50 });
      expect(updated.maxRunDurationMs).toBe(50);
      expect(DEFAULT_SESSION_BUDGET.maxRunDurationMs).toBe(10 * 60 * 1000);
    });
  });

  describe('lớp chặn 1 — hard timeout theo phiên', () => {
    it('runner treo vô hạn bị cắt và báo thất bại (không ghi session thành công)', async () => {
      const never = new Promise<{ ok: boolean; text: string }>(() => {
        /* không bao giờ resolve — mô phỏng vòng lặp lỗi 3h sáng */
      });
      const res = await executeScheduledRun(
        tmpDir,
        schedule(),
        () => never,
        { maxRunDurationMs: 60, maxRunsPerTick: 3, maxConsecutiveFailures: 3 },
      );

      expect(res.ok).toBe(false);
      expect(res.budgetExceeded).toBe('duration');
      expect(res.error).toMatch(/vượt trần thời gian/);
      expect(res.durationMs).toBeLessThan(2000);
    });

    it('runner bình thường vẫn chạy và trả kết quả', async () => {
      const res = await executeScheduledRun(
        tmpDir,
        schedule(),
        async () => ({ ok: true, text: 'xong' }),
        { maxRunDurationMs: 2000, maxRunsPerTick: 3, maxConsecutiveFailures: 3 },
      );
      expect(res.ok).toBe(true);
      expect(res.output).toBe('xong');
      expect(res.budgetExceeded).toBeUndefined();
    });

    it('timeout <= 0 thì không áp trần (tắt hẳn thì không cắt)', async () => {
      const res = await executeScheduledRun(
        tmpDir,
        schedule(),
        async () => ({ ok: true, text: 'ok' }),
        { maxRunDurationMs: 0, maxRunsPerTick: 3, maxConsecutiveFailures: 3 },
      );
      expect(res.ok).toBe(true);
    });
  });

  describe('lớp chặn 2 — trần số phiên mỗi tick', () => {
    it('nhiều lịch trùng phút: tick chỉ chạy tối đa N phiên', async () => {
      const ids = ['s1', 's2', 's3', 's4', 's5'];
      for (const id of ids) {
        const s = schedule({ id, cron: '* * * * *' });
        const file = path.join(tmpDir, '.vyen', 'schedules.json');
        const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
        current.push(s);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(current), 'utf8');
      }

      let started = 0;
      const executed = await tickScheduler(
        tmpDir,
        new Date(),
        async () => {
          started += 1;
          return { ok: true, text: 'ok' };
        },
        { maxRunDurationMs: 2000, maxRunsPerTick: 2, maxConsecutiveFailures: 3 },
      );

      expect(executed.length).toBe(2);
      await new Promise((r) => setTimeout(r, 50));
      expect(started).toBe(2);
    });
  });

  describe('lớp chặn 3 — kill-switch toàn cục', () => {
    it('bật thì sentinel tồn tại ở .vyen/, tắt thì xoá', () => {
      expect(isKillSwitchActive(tmpDir)).toBe(false);
      setKillSwitch(tmpDir, true);
      expect(fs.existsSync(getKillSwitchPath(tmpDir))).toBe(true);
      expect(isKillSwitchActive(tmpDir)).toBe(true);
      setKillSwitch(tmpDir, false);
      expect(isKillSwitchActive(tmpDir)).toBe(false);
    });

    it('tick bị bỏ trống hoàn toàn khi kill-switch bật', async () => {
      const file = path.join(tmpDir, '.vyen', 'schedules.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify([schedule({ cron: '* * * * *' })]), 'utf8');
      setKillSwitch(tmpDir, true);

      let ran = false;
      const executed = await tickScheduler(
        tmpDir,
        new Date(),
        async () => {
          ran = true;
          return { ok: true, text: 'xong' };
        },
        { maxRunDurationMs: 2000, maxRunsPerTick: 3, maxConsecutiveFailures: 3 },
      );

      expect(executed).toEqual([]);
      expect(ran).toBe(false);
    });

    it('executeScheduledRun bị chặn ngay, không ghi trạng thái running', async () => {
      setKillSwitch(tmpDir, true);
      let ran = false;
      const res = await executeScheduledRun(
        tmpDir,
        schedule(),
        async () => {
          ran = true;
          return { ok: true, text: 'xong' };
        },
        { maxRunDurationMs: 2000, maxRunsPerTick: 3, maxConsecutiveFailures: 3 },
      );

      expect(ran).toBe(false);
      expect(res.ok).toBe(false);
      expect(res.budgetExceeded).toBe('kill_switch');
      expect(res.error).toMatch(/kill-switch/);
    });
  });

  describe('vòng lặp lỗi — tự tắt lịch', () => {
    it('sau N lần lỗi liên tiếp thì lịch tự tắt, và bật lại được với ngân sách lỗi mới', async () => {
      const s = schedule();
      const budget = { maxRunDurationMs: 2000, maxRunsPerTick: 3, maxConsecutiveFailures: 3 };

      for (let i = 0; i < 3; i++) {
        const res = await executeScheduledRun(tmpDir, s, async () => ({ ok: false, text: '', error: 'lỗi' }), budget);
        expect(res.ok).toBe(false);
      }

      const file = path.join(tmpDir, '.vyen', 'schedules.json');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as ScheduleRecord[];
      expect(saved[0].enabled).toBe(false);
      expect(saved[0].lastError).toMatch(/tự tắt sau 3 lần lỗi liên tiếp/);

      // Bật lại → bộ đếm lỗi phải về 0, nên lần lỗi kế tiếp KHÔNG lập tức tắt.
      const reenabled = toggleSchedule(tmpDir, s.id, true);
      expect(reenabled?.enabled).toBe(true);
      // Nạp lại từ đĩa như tickScheduler thực tế làm (object cũ đã bị mutate
      // sang enabled=false lúc auto-disable).
      const fresh = loadSchedulesFromFile(tmpDir).find((x) => x.id === s.id)!;
      const res = await executeScheduledRun(tmpDir, fresh, async () => ({ ok: false, text: '', error: 'lỗi' }), budget);
      expect(res.ok).toBe(false);
      const after = JSON.parse(fs.readFileSync(file, 'utf8')) as ScheduleRecord[];
      expect(after[0].enabled).toBe(true);
    });

    it('một lần chạy thành công reset bộ đếm lỗi', async () => {
      const s = schedule();
      const budget = { maxRunDurationMs: 2000, maxRunsPerTick: 3, maxConsecutiveFailures: 3 };

      await executeScheduledRun(tmpDir, s, async () => ({ ok: false, text: '', error: 'lỗi' }), budget);
      await executeScheduledRun(tmpDir, s, async () => ({ ok: true, text: 'ok' }), budget);
      const res = await executeScheduledRun(tmpDir, s, async () => ({ ok: false, text: '', error: 'lỗi' }), budget);

      expect(res.ok).toBe(false);
      const file = path.join(tmpDir, '.vyen', 'schedules.json');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as ScheduleRecord[];
      // 2 lỗi sau 1 lần thành công ⇒ chưa đạt trần 3 ⇒ vẫn bật
      expect(saved[0].enabled).toBe(true);
    });
  });

  describe('tương thích ngược', () => {
    it('gọi không truyền budget vẫn dùng ngân sách hiện hành và chạy recipe mặc định', async () => {
      const s = schedule({ recipeId: 'daily-digest' });
      const res = await executeScheduledRun(tmpDir, s);
      expect(res.ok).toBe(true);
      expect(res.output).toContain('định kỳ');
    });

    it('customRunner nhận recipe ĐÃ TRA CỨU (từ .vyen/recipes, không phải object truyền vào)', async () => {
      // Không có file recipe trong workspace ⇒ runner dựng fallback từ schedule.
      const res = await executeScheduledRun(
        tmpDir,
        schedule({ recipeId: 'missing-on-disk', recipeName: 'Fallback' }),
        async (r: Recipe) => ({ ok: true, text: `chạy ${r.title}` }),
        { maxRunDurationMs: 2000, maxRunsPerTick: 3, maxConsecutiveFailures: 3 },
      );
      expect(res.ok).toBe(true);
      expect(res.output).toBe('chạy Fallback');

      // Có file recipe thật ⇒ runner phải dùng đúng recipe đó.
      const recipesDir = path.join(tmpDir, '.vyen', 'recipes');
      fs.mkdirSync(recipesDir, { recursive: true });
      fs.writeFileSync(
        path.join(recipesDir, 'daily-digest.yaml'),
        'version: "1.0.0"\ntitle: Tóm tắt hằng ngày\ndescription: D\nprompt: P\n',
        'utf8',
      );
      const res2 = await executeScheduledRun(
        tmpDir,
        schedule({ recipeId: 'daily-digest' }),
        async (r: Recipe) => ({ ok: true, text: `chạy ${r.title}` }),
        { maxRunDurationMs: 2000, maxRunsPerTick: 3, maxConsecutiveFailures: 3 },
      );
      expect(res2.output).toBe('chạy Tóm tắt hằng ngày');
    });
  });
});
