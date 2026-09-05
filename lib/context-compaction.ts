/**
 * Điều phối compaction phía client — tách khỏi chat-interface.tsx để test được.
 *
 * Luồng: ước lượng token của projection nhánh active → vượt ngưỡng thì gọi
 * /api/compact với phần cũ (text-only) → lưu marker vào ChatSession.compaction
 * → các request /api/chat sau kèm `contextSummary` + `compactBoundaryId`, server
 * tự lọc tin trước boundary và chèn summary vào đầu system.
 */

import type { Message } from 'ai/react';
import { getModelConfig, ALLOWED_MODEL_IDS } from '@/lib/models';
import {
  COMPACT_MESSAGE_CHAR_CAP,
  FALLBACK_CONTEXT_WINDOW,
  type BudgetMessageLike,
} from '@/lib/context-budget';

export interface ProviderModelLite {
  id: string;
  name?: string;
  contextLength?: number;
}

export interface CompactionMarker {
  upToId: string;
  summary: string;
  compactedCount: number;
  createdAt: number;
  /**
   * State tích lũy qua các lần nén (port `CompactionState` của evot).
   * Không có trường này = bản nén cũ trước khi nâng cấp — coi như rỗng.
   * Field không index → mở rộng không cần bump Dexie schema.
   */
  state?: CompactionState;
}

/* ------------------------------------------------------------------ */
/* State tích lũy qua các lần nén                                      */
/* ------------------------------------------------------------------ */

/**
 * Dữ kiện sống sót qua mọi lần nén: file đã chạm, yêu cầu đã nêu, thế hệ.
 *
 * VÌ SAO CẦN: LLM summarizer mỗi lần chạy độc lập — nếu chỉ đưa transcript
 * mới, nó KHÔNG biết file nào đã sửa ở lần nén trước. Kết quả: sau 2-3 lần
 * nén, model mất sạch dấu vết công việc. State tích lũy giữ những dữ kiện
 * này vĩnh viễn (trong giới hạn trần), bất kể LLM có nhớ hay không.
 *
 * Port từ `compaction/memory.rs` + `types.rs` của evot (Apache-2.0), giản lược
 * cho mô hình client-side: không có env_discoveries (không chạy bash), không
 * có decisions (khó trích tin cậy từ prose tiếng Việt).
 */
export interface CompactionState {
  /** File đã đọc (chỉ đọc, chưa từng bị ghi/sửa). */
  filesRead: string[];
  /** File đã ghi mới hoặc ghi đè. */
  filesWritten: string[];
  /** File đã sửa cục bộ (fs_edit). */
  filesEdited: string[];
  /** Yêu cầu người dùng đã nêu (gần nhất được ưu tiên khi vượt trần). */
  completedRequests: string[];
  /** Số lần nén đã trải qua — để debug và hiển thị UI. */
  generation: number;
}

export const COMPACTION_STATE_LIMITS = {
  maxFilesPerGroup: 20,
  maxRequests: 15,
  requestChars: 200,
} as const;

export function emptyCompactionState(): CompactionState {
  return {
    filesRead: [],
    filesWritten: [],
    filesEdited: [],
    completedRequests: [],
    generation: 0,
  };
}

/**
 * Hợp nhất state của lần nén TRƯỚC với dữ liệu trích từ phần bị nén HIỆN TẠI.
 *
 * Nguyên tắc:
 * - File: union, rồi loại trừ chéo (file đã sửa/ghi thì không còn ở nhóm đọc).
 * - Requests: nối rồi giữ N cái GẦN NHẤT (yêu cầu mới liên quan hơn yêu cầu cũ).
 * - Generation: luôn +1.
 */
export function mergeCompactionState(
  prev: CompactionState | undefined,
  currentFileOps: FileOpsSummary,
  currentRequests: string[],
): CompactionState {
  const p = prev ?? emptyCompactionState();
  const lim = COMPACTION_STATE_LIMITS;

  /* Union file, rồi loại trừ chéo: edited/written thắng read. */
  const editedSet = new Set([...p.filesEdited, ...currentFileOps.edited]);
  const writtenSet = new Set([...p.filesWritten, ...currentFileOps.written]);
  const readSet = new Set([...p.filesRead, ...currentFileOps.read]);
  for (const f of editedSet) readSet.delete(f);
  for (const f of writtenSet) readSet.delete(f);

  /* Requests: nối, dedupe nguyên văn, giữ gần nhất. */
  const seenReq = new Set<string>();
  const mergedRequests: string[] = [];
  for (const r of [...p.completedRequests, ...currentRequests]) {
    if (!r || seenReq.has(r)) continue;
    seenReq.add(r);
    mergedRequests.push(r);
  }

  return {
    filesRead: [...readSet].sort().slice(-lim.maxFilesPerGroup),
    filesWritten: [...writtenSet].sort().slice(-lim.maxFilesPerGroup),
    filesEdited: [...editedSet].sort().slice(-lim.maxFilesPerGroup),
    completedRequests: mergedRequests.slice(-lim.maxRequests),
    generation: p.generation + 1,
  };
}

/**
 * Dựng khối ngữ cảnh CÓ CẤU TRÚC chèn vào prompt gửi /api/compact.
 *
 * Tách riêng khỏi transcript prose để LLM nhận dữ kiện cứng (file, yêu cầu)
 * dưới dạng danh sách rõ ràng thay vì phải mò từ văn bản tóm tắt một dòng.
 * Khi có previousState, liệt kê cả dữ kiện TÍCH LŨY từ các lần nén trước —
 * đây là thứ LLM summarizer đơn lẻ không bao giờ tự biết.
 */
export function formatCompactContextBlock(
  fileOps: FileOpsSummary,
  requests: string[],
  splitTurnPrefixText?: string,
  previousState?: CompactionState,
): string {
  const sections: string[] = [];

  if (previousState && previousState.generation > 0) {
    const lines: string[] = [`[Dữ kiện tích lũy từ ${previousState.generation} lần nén trước]`];
    const allModified = [...previousState.filesEdited, ...previousState.filesWritten];
    if (allModified.length) {
      lines.push(`File đã sửa/ghi (tích lũy): ${allModified.join(', ')}`);
    }
    if (previousState.filesRead.length) {
      lines.push(`File đã đọc (tích lũy): ${previousState.filesRead.join(', ')}`);
    }
    if (previousState.completedRequests.length) {
      lines.push(
        `Yêu cầu đã nêu (tích lũy):\n${previousState.completedRequests.map((r) => `- ${r}`).join('\n')}`,
      );
    }
    if (lines.length > 1) sections.push(lines.join('\n'));
  }

  const curLines: string[] = ['[Dữ kiện trích từ phần bị nén HIỆN TẠI]'];
  if (fileOps.edited.length) curLines.push(`File vừa SỬA: ${fileOps.edited.join(', ')}`);
  if (fileOps.written.length) curLines.push(`File vừa GHI: ${fileOps.written.join(', ')}`);
  if (fileOps.read.length) curLines.push(`File vừa ĐỌC: ${fileOps.read.join(', ')}`);
  if (requests.length) {
    curLines.push(`Yêu cầu người dùng trong phần bị nén:\n${requests.map((r) => `- ${r}`).join('\n')}`);
  }
  if (splitTurnPrefixText) {
    curLines.push(`Lượt đang dở (phần đầu đã bị lược): ${splitTurnPrefixText}`);
  }
  if (curLines.length > 1) sections.push(curLines.join('\n'));

  if (!sections.length) return '';
  return sections.join('\n\n');
}

/**
 * Context window thực tế của model đang chọn, ưu tiên theo độ tin cậy:
 * 1. metadata `contextLength` gateway tự khai báo (/v1/models của provider
 *    override — crax trả số liệu chuẩn từng model);
 * 2. config built-in của app cho model nằm trong danh sách chính thức;
 * 3. fallback bảo thủ 32k — nén sớm còn hơn tràn.
 */
export function resolveContextWindow(
  modelId: string | undefined | null,
  providerModels: readonly ProviderModelLite[] | undefined,
): number {
  const meta = providerModels?.find((m) => m.id === modelId);
  if (meta && typeof meta.contextLength === 'number' && meta.contextLength > 0) {
    return meta.contextLength;
  }
  if (modelId && ALLOWED_MODEL_IDS.has(modelId)) {
    return getModelConfig(modelId).contextWindowTokens;
  }
  return FALLBACK_CONTEXT_WINDOW;
}

/** Marker chỉ có giá trị khi ranh giới vẫn nằm trên nhánh đang mở. */
export function findActiveCompaction(
  marker: CompactionMarker | undefined,
  messages: readonly Pick<Message, 'id'>[],
): CompactionMarker | undefined {
  if (!marker || !marker.upToId) return undefined;
  return messages.some((m) => m.id === marker.upToId) ? marker : undefined;
}

/** Trần ký tự cho phần tóm tắt args/kết quả của MỘT tool call trong payload nén. */
const TOOL_TRACE_CHAR_CAP = 300;

/**
 * Rút gọn một tool invocation thành một dòng text cho payload nén.
 * Giữ tên tool + tham số chính + dấu hiệu thành/bại — đủ để bản tóm tắt ghi
 * lại "agent đã làm gì với workspace", thứ mà trước đây bị mất trắng.
 */
function describeToolInvocation(
  inv: NonNullable<BudgetMessageLike['toolInvocations']>[number],
): string {
  const name = (inv as { toolName?: unknown }).toolName;
  const toolName = typeof name === 'string' && name ? name : 'tool';

  const brief = (value: unknown): string => {
    if (value == null) return '';
    let raw: string;
    try {
      raw = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
    return raw.length > TOOL_TRACE_CHAR_CAP ? `${raw.slice(0, TOOL_TRACE_CHAR_CAP)}…` : raw;
  };

  const args = brief(inv.args);
  if (inv.state !== 'result') {
    return `[đã gọi ${toolName}${args ? ` ${args}` : ''} — chưa có kết quả]`;
  }
  return `[đã gọi ${toolName}${args ? ` ${args}` : ''} → ${brief(inv.result) || 'xong'}]`;
}

/**
 * Đóng gói phần cũ gửi lên /api/compact: CHỈ text — ảnh/pdf thay bằng ghi chú,
 * mỗi tin trần theo COMPACT_MESSAGE_CHAR_CAP. Tóm tắt không cần pixel; giữ
 * payload nhỏ để nhanh và rẻ.
 *
 * Tool call được rút thành dòng mô tả ngắn thay vì bỏ qua: với agent coding,
 * "đã đọc file nào / sửa gì / tìm thấy gì" là phần ngữ cảnh đáng giá nhất —
 * bỏ nó đi thì sau khi nén model không còn biết mình đã làm những gì.
 */
export function serializeForCompaction(
  messages: readonly BudgetMessageLike[],
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;

    let text =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((p) =>
                p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
                  ? ((p as { text: string }).text as string)
                  : '',
              )
              .join('')
          : '';

    const atts = message.experimental_attachments ?? [];
    const imageCount = atts.filter((a) => (a.contentType ?? '').startsWith('image/')).length;
    const otherCount = atts.length - imageCount;
    if (imageCount) text += `\n[đã đính kèm ${imageCount} ảnh]`;
    if (otherCount) text += `\n[đã đính kèm ${otherCount} file]`;

    /* Dấu vết tool NỐI SAU phần text đã cắt trần, không nằm trong ngân sách
       cắt của prose — mỗi dòng đã tự giới hạn nên tổng vẫn bị chặn. */
    const traces = (message.toolInvocations ?? [])
      .filter((inv) => inv?.state !== 'partial-call')
      .map(describeToolInvocation);

    text = text.trim();
    /* Cắt trần PHẦN PROSE trước rồi mới nối dấu vết tool — nếu nối trước,
       một tin dài sẽ bị cắt đúng chỗ và dấu vết tool vừa thêm biến mất. */
    if (text.length > COMPACT_MESSAGE_CHAR_CAP) {
      text = `${text.slice(0, COMPACT_MESSAGE_CHAR_CAP)}…`;
    }
    if (traces.length) {
      text = text ? `${text}\n${traces.join('\n')}` : traces.join('\n');
    }
    // Tin rỗng hoàn toàn (không prose, không tool) mới bị bỏ.
    if (!text) continue;

    out.push({
      role: message.role,
      content:
        text.length > COMPACT_MESSAGE_CHAR_CAP * 2
          ? `${text.slice(0, COMPACT_MESSAGE_CHAR_CAP * 2)}…`
          : text,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tóm tắt TẤT ĐỊNH (emergency) — không cần LLM                        */
/* ------------------------------------------------------------------ */

/**
 * Port `compaction/emergency.rs` + `memory.rs` của evot (Apache-2.0).
 *
 * VẤN ĐỀ ĐANG SỬA: khi /api/compact thất bại (gateway free bận, mọi model
 * chết, mạng đứt), đường `overflow` lưu marker với `summary: ''` — tức
 * HARD-TRIM: hàng chục tin nhắn bị loại khỏi ngữ cảnh mà không để lại dấu vết
 * nào. Với agent coding đó là mất mát nghiêm trọng nhất có thể: model không
 * còn biết nó đã sửa file nào, người dùng đã yêu cầu gì.
 *
 * Bản tóm tắt tất định không thay thế được LLM về chất lượng văn xuôi, nhưng
 * những dữ kiện đáng giá nhất của một phiên coding đều TRÍCH ĐƯỢC bằng thuật
 * toán: yêu cầu đã nêu, file đã đọc/đã sửa, kết luận cuối. Nó luôn chạy được,
 * không tốn request, và không bao giờ thất bại.
 */

/** Trần ký tự cho từng loại mục — khớp tinh thần ANCHOR/CONCLUSION của evot. */
const EMERGENCY_LIMITS = {
  requestChars: 200,
  maxRequests: 8,
  conclusionChars: 300,
  maxFilesPerGroup: 12,
  totalChars: 4_000,
} as const;

/** Tool nào coi là GHI, tool nào coi là ĐỌC — quyết định nhóm hiển thị. */
const WRITE_TOOLS = new Set(['fs_write', 'fs_edit']);
const READ_TOOLS = new Set(['fs_read', 'fs_list', 'fs_search']);

export interface FileOpsSummary {
  /** Chỉ đọc, chưa từng bị ghi. */
  read: string[];
  written: string[];
  edited: string[];
}

export interface EmergencySummaryInput {
  messages: readonly BudgetMessageLike[];
  /** Tóm tắt của lần nén TRƯỚC — không có LLM để hợp nhất nên giữ nguyên văn. */
  previousSummary?: string;
  /** Ngữ cảnh "lượt đang dở" khi điểm cắt rơi giữa lượt (xem splitTurnStart). */
  splitTurnPrefix?: readonly BudgetMessageLike[];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (part && typeof part === 'object') {
      const t = (part as { text?: unknown }).text;
      if (typeof t === 'string') out += t;
    }
  }
  return out;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Trích các đường dẫn file mà agent đã chạm, phân theo loại thao tác.
 * Một file vừa đọc vừa sửa chỉ hiện ở nhóm "đã sửa" — thông tin mạnh hơn.
 */
export function extractFileOps(messages: readonly BudgetMessageLike[]): FileOpsSummary {
  const read = new Set<string>();
  const written = new Set<string>();
  const edited = new Set<string>();

  for (const message of messages) {
    for (const inv of message.toolInvocations ?? []) {
      if (!inv || inv.state === 'partial-call') continue;
      const name = (inv as { toolName?: unknown }).toolName;
      if (typeof name !== 'string') continue;
      const args = (inv.args ?? {}) as Record<string, unknown>;
      const path = typeof args.path === 'string' ? args.path : undefined;
      if (!path) continue;
      if (name === 'fs_edit') edited.add(path);
      else if (name === 'fs_write') written.add(path);
      else if (READ_TOOLS.has(name)) read.add(path);
    }
  }

  // File đã bị ghi/sửa thì không liệt kê lại ở nhóm chỉ-đọc.
  for (const p of written) read.delete(p);
  for (const p of edited) read.delete(p);

  return {
    read: [...read].sort(),
    written: [...written].sort(),
    edited: [...edited].sort(),
  };
}

/** Các yêu cầu người dùng đã nêu trong phần bị nén — "đã xong, đừng làm lại". */
export function extractUserRequests(messages: readonly BudgetMessageLike[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = clip(textOf(message.content), EMERGENCY_LIMITS.requestChars);
    // Bỏ chính banner tóm tắt của lần nén trước để không lồng vô hạn.
    if (!text || text.startsWith('[Đã nén ngữ cảnh')) continue;
    out.push(text);
  }
  // Giữ những yêu cầu GẦN NHẤT khi vượt trần: chúng liên quan nhất tới hiện tại.
  return out.slice(-EMERGENCY_LIMITS.maxRequests);
}

/** Kết luận cuối của trợ lý — bỏ câu đệm vô nghĩa ("xong", "để tôi xem"). */
const FILLER = new Set([
  'xong',
  'xong.',
  'ok',
  'ok.',
  'được',
  'được.',
  'để tôi xem',
  'để tôi kiểm tra',
  'done',
  'done.',
  'sure',
  'let me check',
]);

export function extractLastConclusion(
  messages: readonly BudgetMessageLike[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const raw = textOf(message.content).trim();
    if (!raw) continue;
    if (FILLER.has(raw.toLowerCase())) continue;
    return clip(raw, EMERGENCY_LIMITS.conclusionChars);
  }
  return undefined;
}

function formatFileGroup(label: string, paths: string[]): string | null {
  if (!paths.length) return null;
  const shown = paths.slice(0, EMERGENCY_LIMITS.maxFilesPerGroup);
  const rest = paths.length - shown.length;
  return `${label}:\n${shown.map((p) => `- ${p}`).join('\n')}${
    rest > 0 ? `\n- …và ${rest} file khác` : ''
  }`;
}

/**
 * Dựng bản tóm tắt tất định cho phần bị nén. LUÔN trả về chuỗi khác rỗng khi
 * có bất kỳ dữ kiện trích được; chỉ trả '' khi phần bị nén hoàn toàn trống
 * rỗng (không text, không tool) — lúc đó hard-trim mới thực sự vô hại.
 */
export function buildEmergencySummary(input: EmergencySummaryInput): string {
  const { messages, previousSummary, splitTurnPrefix } = input;
  const sections: string[] = [`[Đã nén ngữ cảnh: ${messages.length} tin nhắn được thay bằng bản tóm tắt tự động]`];

  if (previousSummary?.trim()) {
    sections.push(`Tóm tắt các lượt nén TRƯỚC đó:\n${previousSummary.trim()}`);
  }

  const requests = extractUserRequests(messages);
  if (requests.length) {
    sections.push(
      `Yêu cầu người dùng đã nêu (ĐỪNG làm lại nếu đã xong):\n${requests
        .map((r) => `- ${r}`)
        .join('\n')}`,
    );
  }

  const ops = extractFileOps(messages);
  const fileSections = [
    formatFileGroup('File đã SỬA', ops.edited),
    formatFileGroup('File đã GHI (tạo/ghi đè)', ops.written),
    formatFileGroup('File đã đọc', ops.read),
  ].filter((s): s is string => s !== null);
  if (fileSections.length) sections.push(fileSections.join('\n'));

  if (splitTurnPrefix?.length) {
    const toolNames = new Set<string>();
    for (const m of splitTurnPrefix) {
      for (const inv of m.toolInvocations ?? []) {
        const name = (inv as { toolName?: unknown }).toolName;
        if (typeof name === 'string') toolNames.add(name);
      }
    }
    const prefixRequest = extractUserRequests(splitTurnPrefix).slice(-1)[0];
    const parts = [
      prefixRequest ? `Người dùng yêu cầu: ${prefixRequest}` : '',
      toolNames.size ? `Công cụ đã dùng: ${[...toolNames].join(', ')}` : '',
    ].filter(Boolean);
    if (parts.length) {
      sections.push(`Lượt HIỆN TẠI đang dở (phần đầu đã bị lược):\n${parts.join('\n')}`);
    }
  }

  const conclusion = extractLastConclusion(messages);
  if (conclusion) sections.push(`Kết luận gần nhất của trợ lý:\n${conclusion}`);

  // Chỉ có banner đầu ⇒ không trích được gì ⇒ để caller hard-trim như cũ.
  if (sections.length === 1) return '';

  const summary = sections.join('\n\n');
  return summary.length > EMERGENCY_LIMITS.totalChars
    ? `${summary.slice(0, EMERGENCY_LIMITS.totalChars)}\n…[tóm tắt bị cắt]`
    : summary;
}

/**
 * Ngữ cảnh phiên cha cho subagent (delegate `context: 'brief'` — tương đương
 * fork-pruned của pi-subagents nhưng TẤT ĐỊNH, không tốn call LLM: tái dùng
 * các bộ trích của compaction). Trả '' khi không trích được gì để caller
 * bỏ qua việc gắn; caller tự quyết định chèn vào system prompt ở đâu.
 */
export function buildSubagentParentBrief(messages: readonly BudgetMessageLike[]): string {
  const sections: string[] = [];

  const requests = extractUserRequests(messages);
  if (requests.length) {
    sections.push(
      `Yêu cầu người dùng đã nêu:\n${requests.map((r) => `- ${r}`).join('\n')}`,
    );
  }

  const ops = extractFileOps(messages);
  const fileSections = [
    formatFileGroup('File đã sửa/ghi', [...ops.edited, ...ops.written]),
    formatFileGroup('File đã đọc', ops.read),
  ].filter((s): s is string => s !== null);
  if (fileSections.length) sections.push(fileSections.join('\n'));

  const conclusion = extractLastConclusion(messages);
  if (conclusion) sections.push(`Kết luận gần nhất của trợ lý:\n${conclusion}`);

  if (!sections.length) return '';
  return sections.join('\n\n');
}
