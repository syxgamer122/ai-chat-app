import type { ChatSession } from '@/lib/db';

export type DateGroupKey =
  | 'pinned' | 'today' | 'yesterday' | 'last7' | 'last30' | 'older';

export interface DateGroup {
  key: DateGroupKey;
  label: string;
  chats: ChatSession[];
}

const LABELS: Record<DateGroupKey, string> = {
  pinned: 'Đã ghim',
  today: 'Hôm nay',
  yesterday: 'Hôm qua',
  last7: '7 ngày trước',
  last30: '30 ngày trước',
  older: 'Cũ hơn',
};

const ORDER: DateGroupKey[] = ['pinned', 'today', 'yesterday', 'last7', 'last30', 'older'];

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY = 86_400_000;

/** Gom chat thành các nhóm thời gian; nhóm rỗng bị loại bỏ. */
export function groupChatsByDate(
  chats: ChatSession[] | undefined,
  now: number = Date.now(),
): DateGroup[] {
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY;
  const last7Start = todayStart - 6 * DAY;
  const last30Start = todayStart - 29 * DAY;

  const buckets = new Map<DateGroupKey, ChatSession[]>(
    ORDER.map((k) => [k, [] as ChatSession[]]),
  );

  for (const chat of chats ?? []) {
    if (chat.pinned) {
      buckets.get('pinned')!.push(chat);
      continue;
    }
    const ts = chat.updatedAt ?? chat.createdAt ?? 0;
    if (ts >= todayStart) buckets.get('today')!.push(chat);
    else if (ts >= yesterdayStart) buckets.get('yesterday')!.push(chat);
    else if (ts >= last7Start) buckets.get('last7')!.push(chat);
    else if (ts >= last30Start) buckets.get('last30')!.push(chat);
    else buckets.get('older')!.push(chat);
  }

  return ORDER.map((key) => ({
    key,
    label: LABELS[key],
    chats: (buckets.get(key) ?? []).sort(
      (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    ),
  })).filter((g) => g.chats.length > 0);
}
