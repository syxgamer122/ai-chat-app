/**
 * Bộ phân tích và đánh giá biểu thức Cron thuần TypeScript (Goose P2-9).
 *
 * Hỗ trợ cú pháp 5 trường tiêu chuẩn:
 *   minute (0-59)  hour (0-23)  dayOfMonth (1-31)  month (1-12)  dayOfWeek (0-6, 0=CN)
 *
 * Hỗ trợ:
 * - Dấu hoa thị (*), bước nhảy (* / n), khoảng (n-m), danh sách (a,b,c).
 * - Shortcuts: @hourly, @daily, @midnight, @weekly, @monthly, @yearly.
 * - Khớp thời gian thực matchesCron(cron, date).
 * - Tính toán lần chạy kế tiếp getNextCronRun(cron, fromDate).
 * - Mô tả câu tiếng Việt dễ hiểu describeCron(cron).
 */

export interface ParsedCron {
  raw: string;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

const CRON_ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
] as const;

/** Phân tích 1 trường cron thành tập hợp các số nguyên hợp lệ. */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const result = new Set<number>();
  const parts = field.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) return null;

    // 1. Dạng bước nhảy: */step hoặc range/step
    if (trimmed.includes('/')) {
      const [rangePart, stepPart] = trimmed.split('/');
      const step = Number.parseInt(stepPart, 10);
      if (Number.isNaN(step) || step <= 0) return null;

      let start = min;
      let end = max;

      if (rangePart !== '*') {
        if (rangePart.includes('-')) {
          const [rStart, rEnd] = rangePart.split('-').map((v) => Number.parseInt(v, 10));
          if (Number.isNaN(rStart) || Number.isNaN(rEnd) || rStart < min || rEnd > max || rStart > rEnd) {
            return null;
          }
          start = rStart;
          end = rEnd;
        } else {
          const rStart = Number.parseInt(rangePart, 10);
          if (Number.isNaN(rStart) || rStart < min || rStart > max) return null;
          start = rStart;
        }
      }

      for (let i = start; i <= end; i += step) {
        result.add(i);
      }
      continue;
    }

    // 2. Dạng wildcard: *
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) {
        result.add(i);
      }
      continue;
    }

    // 3. Dạng khoảng: a-b
    if (trimmed.includes('-')) {
      const [rStart, rEnd] = trimmed.split('-').map((v) => Number.parseInt(v, 10));
      if (Number.isNaN(rStart) || Number.isNaN(rEnd) || rStart < min || rEnd > max || rStart > rEnd) {
        return null;
      }
      for (let i = rStart; i <= rEnd; i++) {
        result.add(i);
      }
      continue;
    }

    // 4. Số đơn lẻ
    const num = Number.parseInt(trimmed, 10);
    if (Number.isNaN(num)) return null;

    // Cho phép 7 là Chủ nhật (tương đương 0) ở trường dayOfWeek
    if (min === 0 && max === 6 && num === 7) {
      result.add(0);
      continue;
    }

    if (num < min || num > max) return null;
    result.add(num);
  }

  return result.size > 0 ? result : null;
}

/** Chuẩn hóa alias thành chuỗi cron 5 trường tiêu chuẩn. */
export function normalizeCronExpression(expr: string): string {
  const trimmed = expr.trim();
  const lower = trimmed.toLowerCase();
  if (lower in CRON_ALIASES) {
    return CRON_ALIASES[lower];
  }
  return trimmed;
}

/** Kiểm tra cú pháp biểu thức Cron có hợp lệ hay không. */
export function isValidCron(cron: string): boolean {
  return parseCron(cron) !== null;
}

/** Phân tích biểu thức Cron. Trả về null nếu cú pháp sai. */
export function parseCron(expr: string): ParsedCron | null {
  const normalized = normalizeCronExpression(expr);
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) return null;

  const minutes = parseField(fields[0], FIELD_RANGES[0].min, FIELD_RANGES[0].max);
  if (!minutes) return null;

  const hours = parseField(fields[1], FIELD_RANGES[1].min, FIELD_RANGES[1].max);
  if (!hours) return null;

  const daysOfMonth = parseField(fields[2], FIELD_RANGES[2].min, FIELD_RANGES[2].max);
  if (!daysOfMonth) return null;

  const months = parseField(fields[3], FIELD_RANGES[3].min, FIELD_RANGES[3].max);
  if (!months) return null;

  const daysOfWeek = parseField(fields[4], FIELD_RANGES[4].min, FIELD_RANGES[4].max);
  if (!daysOfWeek) return null;

  return {
    raw: expr,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
  };
}

/**
 * Kiểm tra xem thời điểm cụ thể (date) có khớp với biểu thức cron hay không.
 * So khớp ở độ chính xác phút (bỏ qua giây và mili-giây).
 */
export function matchesCron(expr: string, date: Date = new Date()): boolean {
  const parsed = parseCron(expr);
  if (!parsed) return false;

  const m = date.getMinutes();
  const h = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay(); // 0 = CN, 1 = T2, ...

  return (
    parsed.minutes.has(m) &&
    parsed.hours.has(h) &&
    parsed.daysOfMonth.has(dom) &&
    parsed.months.has(mon) &&
    parsed.daysOfWeek.has(dow)
  );
}

/**
 * Tính toán thời điểm chạy tiếp theo của biểu thức cron từ mốc `fromDate`.
 * Tìm kiếm theo từng phút trong tối đa `maxDays` ngày (mặc định 31 ngày).
 */
export function getNextCronRun(
  expr: string,
  fromDate: Date = new Date(),
  maxDays: number = 31,
): Date | null {
  const parsed = parseCron(expr);
  if (!parsed) return null;

  // Bắt đầu từ phút tiếp theo (làm tròn lên phút chẵn)
  const current = new Date(fromDate.getTime());
  current.setSeconds(0, 0);
  current.setMinutes(current.getMinutes() + 1);

  const maxLimit = fromDate.getTime() + maxDays * 24 * 60 * 60 * 1000;

  while (current.getTime() <= maxLimit) {
    const mon = current.getMonth() + 1;
    if (!parsed.months.has(mon)) {
      // Nhảy sang tháng tiếp theo
      current.setMonth(current.getMonth() + 1, 1);
      current.setHours(0, 0, 0, 0);
      continue;
    }

    const dom = current.getDate();
    const dow = current.getDay();
    if (!parsed.daysOfMonth.has(dom) || !parsed.daysOfWeek.has(dow)) {
      // Nhảy sang ngày tiếp theo
      current.setDate(current.getDate() + 1);
      current.setHours(0, 0, 0, 0);
      continue;
    }

    const h = current.getHours();
    if (!parsed.hours.has(h)) {
      // Nhảy sang giờ tiếp theo
      current.setHours(current.getHours() + 1, 0, 0, 0);
      continue;
    }

    const m = current.getMinutes();
    if (parsed.minutes.has(m)) {
      return new Date(current.getTime());
    }

    current.setMinutes(current.getMinutes() + 1);
  }

  return null;
}

/**
 * Tạo câu mô tả tiếng Việt dễ hiểu từ biểu thức cron.
 */
export function describeCron(expr: string): string {
  const normalized = normalizeCronExpression(expr);
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    return `Biểu thức cron không hợp lệ: "${expr}"`;
  }

  const [min, hour, dom, mon, dow] = parts;

  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'Chạy mỗi phút';
  }

  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const step = min.slice(2);
    return `Chạy mỗi ${step} phút`;
  }

  if (min === '0' && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    const step = hour.slice(2);
    return `Chạy mỗi ${step} giờ vào phút 0`;
  }

  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'Chạy mỗi giờ vào phút 0';
  }

  const pad = (n: string) => n.padStart(2, '0');

  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const timeStr = `${pad(hour)}:${pad(min)}`;
    if (dom === '*' && mon === '*' && dow === '*') {
      return `Hàng ngày lúc ${timeStr}`;
    }
    if (dom === '*' && mon === '*' && dow === '1-5') {
      return `Thứ Hai đến Thứ Sáu lúc ${timeStr}`;
    }
    if (dom === '*' && mon === '*' && dow === '0') {
      return `Chủ Nhật hàng tuần lúc ${timeStr}`;
    }
    if (dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) {
      const days = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
      return `${days[Number.parseInt(dow, 10)]} hàng tuần lúc ${timeStr}`;
    }
    if (dom === '1' && mon === '*' && dow === '*') {
      return `Ngày đầu tiên mỗi tháng lúc ${timeStr}`;
    }
  }

  return `Lịch cron: ${normalized}`;
}
