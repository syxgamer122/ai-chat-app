import { describe, it, expect } from 'vitest';
import {
  isValidCron,
  parseCron,
  matchesCron,
  getNextCronRun,
  describeCron,
  normalizeCronExpression,
} from '@/lib/scheduler/cron';

describe('Scheduler Cron Engine (P2-9)', () => {
  describe('isValidCron & parseCron', () => {
    it('nhận diện các biểu thức cron hợp lệ', () => {
      expect(isValidCron('* * * * *')).toBe(true);
      expect(isValidCron('*/5 * * * *')).toBe(true);
      expect(isValidCron('0 9 * * 1-5')).toBe(true);
      expect(isValidCron('15,45 10,14 1 1-6 *')).toBe(true);
      expect(isValidCron('@hourly')).toBe(true);
      expect(isValidCron('@daily')).toBe(true);
      expect(isValidCron('@weekly')).toBe(true);
    });

    it('từ chối các biểu thức không hợp lệ', () => {
      expect(isValidCron('')).toBe(false);
      expect(isValidCron('* * *')).toBe(false);
      expect(isValidCron('60 * * * *')).toBe(false);
      expect(isValidCron('* 24 * * *')).toBe(false);
      expect(isValidCron('* * 32 * *')).toBe(false);
      expect(isValidCron('* * * 13 *')).toBe(false);
      expect(isValidCron('* * * * 8')).toBe(false);
      expect(isValidCron('*/0 * * * *')).toBe(false);
      expect(isValidCron('5-2 * * * *')).toBe(false);
    });

    it('normalizeCronExpression chuyển đổi đúng alias', () => {
      expect(normalizeCronExpression('@hourly')).toBe('0 * * * *');
      expect(normalizeCronExpression('@daily')).toBe('0 0 * * *');
      expect(normalizeCronExpression('@weekly')).toBe('0 0 * * 0');
    });
  });

  describe('matchesCron', () => {
    it('khớp chính xác phút và giờ', () => {
      // 2026-09-13 14:30 (Chủ Nhật, ngày 13, tháng 9)
      const d = new Date(2026, 8, 13, 14, 30, 0); // tháng 9 là index 8

      expect(matchesCron('* * * * *', d)).toBe(true);
      expect(matchesCron('*/5 * * * *', d)).toBe(true);
      expect(matchesCron('*/15 * * * *', d)).toBe(true);
      expect(matchesCron('30 14 * * *', d)).toBe(true);
      expect(matchesCron('30 14 13 9 0', d)).toBe(true); // 0 là Chủ Nhật

      // Không khớp
      expect(matchesCron('*/20 * * * *', d)).toBe(false);
      expect(matchesCron('0 * * * *', d)).toBe(false);
      expect(matchesCron('30 15 * * *', d)).toBe(false);
      expect(matchesCron('30 14 * * 1', d)).toBe(false); // 1 là Thứ Hai
    });
  });

  describe('getNextCronRun', () => {
    it('tính toán thời điểm chạy tiếp theo chính xác', () => {
      const from = new Date(2026, 8, 13, 10, 12, 0); // 10:12

      // Chạy mỗi 5 phút -> tiếp theo là 10:15
      const next5 = getNextCronRun('*/5 * * * *', from);
      expect(next5).toBeDefined();
      expect(next5?.getHours()).toBe(10);
      expect(next5?.getMinutes()).toBe(15);

      // Chạy hàng giờ vào phút 0 -> tiếp theo là 11:00
      const nextHour = getNextCronRun('0 * * * *', from);
      expect(nextHour).toBeDefined();
      expect(nextHour?.getHours()).toBe(11);
      expect(nextHour?.getMinutes()).toBe(0);

      // Hàng ngày lúc 09:00 -> tiếp theo là 09:00 ngày hôm sau
      const nextDaily = getNextCronRun('0 9 * * *', from);
      expect(nextDaily).toBeDefined();
      expect(nextDaily?.getDate()).toBe(14);
      expect(nextDaily?.getHours()).toBe(9);
      expect(nextDaily?.getMinutes()).toBe(0);
    });
  });

  describe('describeCron', () => {
    it('tạo mô tả tiếng Việt dễ hiểu', () => {
      expect(describeCron('* * * * *')).toBe('Chạy mỗi phút');
      expect(describeCron('*/5 * * * *')).toBe('Chạy mỗi 5 phút');
      expect(describeCron('*/15 * * * *')).toBe('Chạy mỗi 15 phút');
      expect(describeCron('0 * * * *')).toBe('Chạy mỗi giờ vào phút 0');
      expect(describeCron('0 9 * * *')).toBe('Hàng ngày lúc 09:00');
      expect(describeCron('30 14 * * 1-5')).toBe('Thứ Hai đến Thứ Sáu lúc 14:30');
      expect(describeCron('0 0 * * 0')).toBe('Chủ Nhật hàng tuần lúc 00:00');
      expect(describeCron('@hourly')).toBe('Chạy mỗi giờ vào phút 0');
      expect(describeCron('@daily')).toBe('Hàng ngày lúc 00:00');
    });
  });
});
