/**
 * EventStream — tầng sự kiện dùng chung cho Vyen.
 *
 * EventStream là source of truth: MỌI thứ xảy ra trong một
 * phiên agent (message, action, observation, error) là một Event append-only
 * trong stream. Lợi ích mà mô hình "cây message" của Vyen chưa có:
 *
 * 1. Replay/pause/resume chính xác — chạy lại từ sự kiện N là đủ, không cần
 *    dựng lại từ IndexedDB projection.
 * 2. Audit hoàn chỉnh — cả tool error lẫn lỗi hệ thống đều nằm trong dòng
 *    thời gian, không bị nuốt vào console.
 * 3. Đếm lượt/detect lỗi theo stream thay vì heuristics rải rác.
 *
 * Thiết kế thuần function + store phi-tiện ích (như goal-loop/debug-loop của
 * Vyen): không Dexie, không React — test được trong node. Store bản quyền
 * thuộc conversation-scoped bucket có TTL tự dọn.
 */

/* ------------------------------------------------------------------ */
/* Kiểu sự kiện                                                        */
/* ------------------------------------------------------------------ */

/** Loại sự kiện — tương ứng Action/Observation, giản lược. */
export type AgentRuntimeEventType =
  /** Message người dùng (nguyên văn đã gửi). */
  | 'user_message'
  /** Message assistant (text cuối lượt). */
  | 'assistant_message'
  /** Agent gọi tool (action). */
  | 'agent_action'
  /** Kết quả tool trả về (observation). */
  | 'agent_observation'
  /** Lỗi tool/lỗi runtime — thường bị nuốt, ở đây giữ lại trong stream. */
  | 'agent_error'
  /** Sự kiện hệ thống (bắt đầu goal, đổi policy, checkpoint...). */
  | 'system_event';

/**
 * Danh sách type hợp lệ ở runtime — dùng cho validate khi import trajectory và
 * cho UI lọc theo loại event (union type không tồn tại lúc chạy).
 */
export const AGENT_RUNTIME_EVENT_TYPES: readonly AgentRuntimeEventType[] = Object.freeze([
  'user_message',
  'assistant_message',
  'agent_action',
  'agent_observation',
  'agent_error',
  'system_event',
]);

export interface AgentRuntimeEvent {
  /** Số thứ tự toàn cục trong stream — bắt đầu từ 0, tăng 1 mỗi event. */
  readonly id: number;
  readonly type: AgentRuntimeEventType;
  /** Thời điểm (ms epoch). */
  readonly ts: number;
  /** Nội dung chính — text cho message, JSON string cho action/observation. */
  readonly payload: string;
  /** Tên tool khi type là action/observation/error của tool. */
  readonly toolName?: string;
  /** Nhãn nguồn: 'user' | 'model' | 'tool' | 'system'. */
  readonly source: 'user' | 'model' | 'tool' | 'system';
  /**
   * Ấn dấu nội dung để phát hiện lặp vô nghĩa không phụ thuộc format.
   * Do store tự tính khi append.
   */
  readonly contentHash: string;
}

/* ------------------------------------------------------------------ */
/* Cấu hình                                                            */
/* ------------------------------------------------------------------ */

/** Trần sự kiện giữ trong bộ nhớ mỗi stream — bảo vệ RAM client. */
export const EVENT_STREAM_MAX_EVENTS = 2_000;

/** TTL bucket stream — sau khoảng này không hoạt động thì dọn. */
export const EVENT_STREAM_TTL_MS = 30 * 60_000;

/** Trần số bucket giữ đồng thời — chặn rò rỉ bộ nhớ (mẫu goal-loop). */
const MAX_STREAM_BUCKETS = 200;

/** Trần ký tự mỗi payload — cắt giữ phần ĐẦU (metadata hay ở đầu output). */
export const EVENT_PAYLOAD_CHAR_CAP = 8_000;

/* ------------------------------------------------------------------ */
/* Hash — ổn định trong phiên, tương tự goal-loop                       */
/* ------------------------------------------------------------------ */

/**
 * Hash nội dung đơn giản. Chuẩn hoá nhẹ: collapse whitespace — để 2 câu trả
 * lời chỉ khác xuống dòng vẫn được coi là lặp.
 */
export function hashEventPayload(text: string): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < Math.min(normalized.length, 2000); i += 1) {
    h = ((h << 5) - h + normalized.charCodeAt(i)) | 0;
  }
  return String(h);
}

/* ------------------------------------------------------------------ */
/* Store — conversation-scoped, TTL tự dọn (mẫu goal-loop)              */
/* ------------------------------------------------------------------ */

interface StreamBucket {
  events: AgentRuntimeEvent[];
  nextId: number;
  touchedAt: number;
}

const buckets = new Map<string, StreamBucket>();

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.touchedAt > EVENT_STREAM_TTL_MS) buckets.delete(key);
  }
  if (buckets.size <= MAX_STREAM_BUCKETS) return;
  const sorted = [...buckets.entries()].sort((a, b) => event_idOf(a[1]) - event_idOf(b[1]));
  for (const [key] of sorted.slice(0, buckets.size - MAX_STREAM_BUCKETS)) buckets.delete(key);
}

/** Thứ tự bucket cho eviction: theo touchedAt tăng dần. */
function event_idOf(bucket: StreamBucket): number {
  return bucket.touchedAt;
}

/** Chỉ dùng trong test. */
export function __clearAllEventStreams(): void {
  buckets.clear();
}

/**
 * Lấy toàn bộ events của hội thoại (bản sao readonly). Stream chưa có → [].
 */
export function getEventStream(conversationId: string | null | undefined): readonly AgentRuntimeEvent[] {
  if (!conversationId) return [];
  const bucket = buckets.get(conversationId);
  if (!bucket) return [];
  bucket.touchedAt = Date.now();
  // Bản sao nông: caller mutate kết quả không ảnh hưởng stream nội bộ.
  return bucket.events.slice();
}

/** Sự kiện cuối cùng (undefined nếu stream rỗng). */
export function getLastEvent(
  conversationId: string | null | undefined,
): AgentRuntimeEvent | undefined {
  const events = getEventStream(conversationId);
  return events.length ? events[events.length - 1] : undefined;
}

/** Tổng số event hiện có (kể cả đã bị cắt trần). */
export function getEventCount(conversationId: string | null | undefined): number {
  return getEventStream(conversationId).length;
}

/**
 * Thêm một sự kiện vào stream. Trả về event đã ghi (readonly cho caller).
 * `conversationId` rỗng → trả event với id -1 và KHÔNG lưu (stream vô danh).
 */
export function appendEvent(
  conversationId: string | null | undefined,
  input: {
    type: AgentRuntimeEventType;
    payload: string;
    source?: AgentRuntimeEvent['source'];
    toolName?: string;
    ts?: number;
  },
): AgentRuntimeEvent {
  const ts = input.ts ?? Date.now();
  const payload = clipPayload(input.payload ?? '');
  const base = {
    type: input.type,
    ts,
    payload,
    toolName: input.toolName,
    source: input.source ?? 'system',
    contentHash: hashEventPayload(payload),
  };

  if (!conversationId) {
    // Stream vô danh: vẫn trả event hợp lệ để caller không null-check.
    return Object.freeze({ id: -1, ...base });
  }

  sweep(ts);
  let bucket = buckets.get(conversationId);
  if (!bucket) {
    bucket = { events: [], nextId: 0, touchedAt: ts };
    buckets.set(conversationId, bucket);
  }
  bucket.touchedAt = ts;

  // Freeze để caller không mutate được event dùng chung giữa các lần đọc.
  const event: AgentRuntimeEvent = Object.freeze({ id: bucket.nextId, ...base });
  bucket.nextId += 1;
  bucket.events.push(event);
  if (bucket.events.length > EVENT_STREAM_MAX_EVENTS) {
    // Cắt giữ phần MỚI nhất — đúng nghĩa stream trượt.
    bucket.events.splice(0, bucket.events.length - EVENT_STREAM_MAX_EVENTS);
  }
  return event;
}

/** Clip payload theo trần ký tự. */
function clipPayload(payload: string): string {
  if (payload.length <= EVENT_PAYLOAD_CHAR_CAP) return payload;
  return `${payload.slice(0, EVENT_PAYLOAD_CHAR_CAP)}…[cắt]`;
}

/* ------------------------------------------------------------------ */
/* Truy vấn — phục vụ StuckDetector / audit UI                          */
/* ------------------------------------------------------------------ */

/** Lấy N sự kiện cuối, theo thứ tự cũ → mới. */
export function getRecentEvents(
  conversationId: string | null | undefined,
  n: number,
): readonly AgentRuntimeEvent[] {
  const events = getEventStream(conversationId);
  return events.slice(Math.max(0, events.length - n));
}

/** Đếm sự kiện theo type (phục vụ UI thống kê và StuckDetector). */
export function countEventsByType(
  conversationId: string | null | undefined,
): Partial<Record<AgentRuntimeEventType, number>> {
  const counts: Partial<Record<AgentRuntimeEventType, number>> = {};
  for (const e of getEventStream(conversationId)) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Serialize stream ra markdown audit — người dùng bấm xem nguyên văn được.
 * Ngắn gọn: mỗi dòng là một event, trần ký tự cho payload hiển thị.
 */
export function formatEventStreamAudit(
  conversationId: string | null | undefined,
  options?: { maxEvents?: number; payloadChars?: number },
): string {
  const maxEvents = options?.maxEvents ?? 50;
  const payloadChars = options?.payloadChars ?? 200;
  const events = getEventStream(conversationId).slice(-maxEvents);
  if (!events.length) return '(stream trống)';

  const lines: string[] = [];
  for (const e of events) {
    const label =
      e.type === 'user_message'
        ? 'USER'
        : e.type === 'assistant_message'
          ? 'MODEL'
          : e.type === 'agent_action'
            ? `TOOL►${e.toolName ?? '?'}`
            : e.type === 'agent_observation'
              ? `RESULT◄${e.toolName ?? '?'}`
              : e.type === 'agent_error'
                ? `ERROR•${e.toolName ?? 'system'}`
                : 'SYSTEM';
    const brief = e.payload.replace(/\s+/g, ' ').trim();
    const clipped = brief.length > payloadChars ? `${brief.slice(0, payloadChars)}…` : brief;
    lines.push(`#${e.id} [${label}] ${clipped}`);
  }
  return lines.join('\n');
}
