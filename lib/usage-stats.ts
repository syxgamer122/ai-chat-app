/**
 * Thống kê token sử dụng — thuần hàm, không phụ thuộc DB để test được.
 * Dữ liệu nguồn: annotation `{ usage: { promptTokens, completionTokens },
 * model }` trên message assistant (được ghi tại onFinish từ phiên bản này).
 */

export interface UsageRow {
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** epoch ms — dùng createdAt của message nếu annotation không có ts. */
  ts: number;
}

export interface ModelUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  messages: number;
}

export interface DayUsage {
  /** YYYY-MM-DD theo giờ địa phương */
  day: string;
  promptTokens: number;
  completionTokens: number;
}

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  messages: number;
  byModel: ModelUsage[];
  byDay: DayUsage[];
}

/** Rút usage từ 1 message DB (role assistant, annotations là mảng tuỳ ý). */
export function extractUsage(
  msg: { role?: string; createdAt?: number; annotations?: unknown },
): UsageRow | null {
  if (msg.role !== 'assistant') return null;
  const anns = Array.isArray(msg.annotations) ? (msg.annotations as Array<Record<string, unknown>>) : [];
  for (const ann of anns) {
    const u = ann?.usage as { promptTokens?: unknown; completionTokens?: unknown } | undefined;
    const pt = Number(u?.promptTokens ?? 0) || 0;
    const ct = Number(u?.completionTokens ?? 0) || 0;
    if (pt <= 0 && ct <= 0) continue;
    const model =
      (typeof ann.model === 'string' && ann.model) ||
      ([...anns].reverse().find((a) => typeof a?.model === 'string')?.model as string) ||
      'không rõ';
    return { model, promptTokens: pt, completionTokens: ct, ts: msg.createdAt ?? 0 };
  }
  return null;
}

function localDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Gộp usage theo model + theo ngày, giới hạn `days` ngày gần nhất (0 = tất cả). */
export function aggregateUsage(rows: UsageRow[], days = 0): UsageSummary {
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : -Infinity;
  const byModel = new Map<string, ModelUsage>();
  const byDay = new Map<string, DayUsage>();

  for (const r of rows) {
    if (r.ts < cutoff) continue;
    const m = byModel.get(r.model) ?? { model: r.model, promptTokens: 0, completionTokens: 0, messages: 0 };
    m.promptTokens += r.promptTokens;
    m.completionTokens += r.completionTokens;
    m.messages += 1;
    byModel.set(r.model, m);

    const day = localDay(r.ts);
    const d = byDay.get(day) ?? { day, promptTokens: 0, completionTokens: 0 };
    d.promptTokens += r.promptTokens;
    d.completionTokens += r.completionTokens;
    byDay.set(day, d);
  }

  return {
    promptTokens: [...byModel.values()].reduce((s, m) => s + m.promptTokens, 0),
    completionTokens: [...byModel.values()].reduce((s, m) => s + m.completionTokens, 0),
    messages: [...byModel.values()].reduce((s, m) => s + m.messages, 0),
    byModel: [...byModel.values()].sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens)),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
