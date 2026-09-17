/**
 * Condenser — nén ngữ cảnh có policy cho Vyen.
 *
 * Kiến trúc: condenser là một pipeline CÓ POLICY — trước mỗi
 * lượt LLM, condenser quyết định giữ/collapse từng vùng sự kiện. Vyen đang có
 * compaction (tóm tắt LLM + state tích lũy) nhưng chỉ kích hoạt theo ngưỡng
 * token và tóm tắt phần ĐẦU hội thoại — tức là bỏ phí thông tin ngay cả khi
 * vẫn còn dư ngân sách, và không biết "chỉ nén phần vô giá trị".
 *
 * Port những cải tiến đáng giá nhất (không thay thế compaction sẵn có):
 *
 * 1. RecentEventsProtection — N sự kiện cuối LUÔN được giữ nguyên văn, kể cả
 *    khi policy áp lên toàn stream.
 * 2. CoalescedObservationCondenser — gom các observation TRÙNG LẶP (cùng
 *    tool, kết quả gần giống nhau) thành 1 dòng tóm tắt. Cách này dùng
 *    điều này cho output dài của bash; Vyen dùng cho tool result trần 24k.
 * 3. AmortizedForgettingCondenser — khi vượt ngưỡng, bỏ dần các event cũ
 *    NHƯNG vẫn giữ bản tóm tắt dòng đầu mỗi khối bị bỏ (không mất dấu vết).
 *
 * Đầu ra của condenser là danh sách "regions" (giữ nguyên / đã nén) mà caller
 * chuyển thành tin nhắn context — KHÔNG đụng route, KHÔNG tốn LLM.
 */

import type { AgentRuntimeEvent } from '@/lib/agent-runtime/event-stream';
import { getEventStream } from '@/lib/agent-runtime/event-stream';

/* ------------------------------------------------------------------ */
/* Kiểu                                                                */
/* ------------------------------------------------------------------ */

export type CondenserRegion =
  | { kind: 'kept'; events: readonly AgentRuntimeEvent[] }
  | {
      kind: 'coalesced';
      /** Tool bị gom — các obs trong nhóm cùng toolName. */
      toolName: string;
      count: number;
      /** Payload của obs ĐẦU TIÊN trong nhóm (tham chiếu). */
      firstPayload: string;
      /** Hash chung của nhóm. */
      contentHash: string;
      /** Số event bị gom (để đếm token tiết kiệm được). */
      originalCount: number;
    }
  | {
      kind: 'forgotten';
      count: number;
      /** Tóm tắt 1 dòng cho các event bị quên (dòng đầu mỗi loại). */
      summary: string;
    };

export interface CondenserResult {
  regions: CondenserRegion[];
  /** Số event gốc đầu vào. */
  totalEvents: number;
  /** Số event còn được đại diện nguyên văn. */
  keptEvents: number;
  /** Ước lượng ký tự tiết kiệm được (payload gốc − payload sau nén). */
  savedChars: number;
}

/* ------------------------------------------------------------------ */
/* Cấu hình                                                            */
/* ------------------------------------------------------------------ */

/** Số event CUỐI luôn giữ nguyên văn (RecentEventsProtection). */
export const CONDENSER_RECENT_KEEP = 8;

/**
 * Ngưỡng kích hoạt quên (AmortizedForgetting): số event vượt quá này thì
 * vùng ĐẦU được fold thành 1 dòng tóm tắt, giữ phần gần nhất nguyên văn.
 */
export const CONDENSER_FORGET_THRESHOLD = 24;

/** Số obs trùng liên tiếp tối thiểu để gom (dưới ngưỡng thì cứ giữ). */
export const CONDENSER_COALESCE_MIN_RUN = 2;

/** Trần ký tự khi viết dòng tóm tắt cho region. */
const REGION_SUMMARY_CAP = 240;

/* ------------------------------------------------------------------ */
/* Tiện ích nội bộ                                                     */
/* ------------------------------------------------------------------ */

function clip(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function payloadChars(events: readonly AgentRuntimeEvent[]): number {
  let total = 0;
  for (const e of events) total += e.payload.length;
  return total;
}

/** Gom các obs TRÙNG LẶP liên tiếp (cùng tool + cùng hash) thành region. */
function coalesceRuns(events: readonly AgentRuntimeEvent[]): CondenserRegion[] {
  const regions: CondenserRegion[] = [];
  let run: AgentRuntimeEvent[] = [];

  const flush = (): void => {
    if (run.length >= CONDENSER_COALESCE_MIN_RUN) {
      regions.push({
        kind: 'coalesced',
        toolName: run[0].toolName ?? 'tool',
        count: run.length,
        firstPayload: run[0].payload,
        contentHash: run[0].contentHash,
        originalCount: run.length,
      });
    } else if (run.length) {
      regions.push({ kind: 'kept', events: [...run] });
    }
    run = [];
  };

  for (const e of events) {
    const isCoalescible = e.type === 'agent_observation' && e.toolName;
    if (
      isCoalescible &&
      run.length &&
      run[0].type === e.type &&
      run[0].toolName === e.toolName &&
      run[0].contentHash === e.contentHash
    ) {
      run.push(e);
    } else {
      flush();
      run = isCoalescible ? [e] : [];
      if (!isCoalescible) regions.push({ kind: 'kept', events: [e] });
    }
  }
  flush();
  return regions;
}

/** Dựng dòng tóm tắt cho vùng bị quên — mỗi loại event một con số. */
function summarizeForgotten(events: readonly AgentRuntimeEvent[]): string {
  const byType = new Map<string, { count: number; sample?: AgentRuntimeEvent }>();
  for (const e of events) {
    const key = e.type;
    const cur = byType.get(key) ?? { count: 0 };
    cur.count += 1;
    if (!cur.sample) cur.sample = e;
    byType.set(key, cur);
  }
  const labels: Record<string, string> = {
    user_message: 'tin nhắn người dùng',
    assistant_message: 'câu trả lời assistant',
    agent_action: 'lần gọi tool',
    agent_observation: 'kết quả tool',
    agent_error: 'lỗi tool',
    system_event: 'sự kiện hệ thống',
  };
  const lines: string[] = [];
  for (const [type, info] of byType) {
    const sample = info.sample?.payload ? ` (vd: ${clip(info.sample.payload, 120)})` : '';
    lines.push(`- ${info.count} ${labels[type] ?? type}${sample}`);
  }
  return clip(lines.join('\n'), REGION_SUMMARY_CAP);
}

/* ------------------------------------------------------------------ */
/* API chính                                                           */
/* ------------------------------------------------------------------ */

/**
 * Chạy condenser trên toàn bộ event stream của hội thoại. Wrapper thuận tiện
 * — kết quả tương đương condense(getEventStream(conversationId)).
 */
export function condenseForConversation(
  conversationId: string | null | undefined,
): CondenserResult {
  return condense(getEventStream(conversationId));
}

/**
 * Chạy condenser trên một mảng events — THUẦN, test được mà không cần store.
 *
 * Pipeline theo thứ tự:
 * 1. Nếu tổng ≤ CONDENSER_FORGET_THRESHOLD: chỉ coalesce obs trùng lặp.
 * 2. Nếu vượt: fold vùng ĐẦU (trừ CONDENSER_RECENT_KEEP cuối) thành region
 *    `forgotten` kèm tóm tắt, rồi coalesce phần còn lại.
 */
export function condense(events: readonly AgentRuntimeEvent[]): CondenserResult {
  if (!events.length) {
    return { regions: [], totalEvents: 0, keptEvents: 0, savedChars: 0 };
  }

  const originalChars = payloadChars(events);
  let regions: CondenserRegion[] = [];
  let forgottenCount = 0;
  let forgottenSummary = '';

  if (events.length > CONDENSER_FORGET_THRESHOLD) {
    const keepFrom = Math.max(0, events.length - CONDENSER_RECENT_KEEP);
    const forgotten = events.slice(0, keepFrom);
    const rest = events.slice(keepFrom);
    forgottenCount = forgotten.length;
    forgottenSummary = summarizeForgotten(forgotten);
    regions.push({
      kind: 'forgotten',
      count: forgotten.length,
      summary: forgottenSummary,
    });
    regions = [...regions, ...coalesceRuns(rest)];
  } else {
    regions = coalesceRuns(events);
  }

  // Đếm số event còn nguyên văn và ký tự tiết kiệm.
  let keptEvents = 0;
  let condensedChars = 0;
  for (const region of regions) {
    if (region.kind === 'kept') {
      keptEvents += region.events.length;
      condensedChars += payloadChars(region.events);
    } else if (region.kind === 'coalesced') {
      keptEvents += 0; // obs gom không còn nguyên văn
      condensedChars += region.firstPayload.length + 80; // + dòng mô tả
    } else {
      condensedChars += region.summary.length;
    }
  }

  return {
    regions,
    totalEvents: events.length,
    keptEvents,
    savedChars: Math.max(0, originalChars - condensedChars),
  };
}

/**
 * Render kết quả condenser thành khối context chèn được vào prompt (text
 * thuần, không cần LLM). Dùng khi caller muốn tự dựng ngữ cảnh từ stream
 * thay vì gửi nguyên transcript.
 */
export function renderCondensedContext(result: CondenserResult): string {
  const lines: string[] = [];
  for (const region of result.regions) {
    if (region.kind === 'kept') {
      for (const e of region.events) {
        const who =
          e.source === 'user' ? 'USER' : e.source === 'model' ? 'MODEL' : e.source === 'tool' ? 'TOOL' : 'SYS';
        lines.push(`${who}: ${clip(e.payload, 400)}`);
      }
    } else if (region.kind === 'coalesced') {
      lines.push(
        `[${region.count} kết quả "${region.toolName}" trùng lặp — giữ 1 mẫu]: ${clip(region.firstPayload, 200)}`,
      );
    } else {
      lines.push(`[${region.count} sự kiện cũ đã nén]: ${region.summary}`);
    }
  }
  return lines.join('\n');
}
