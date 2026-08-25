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

/**
 * Đóng gói phần cũ gửi lên /api/compact: CHỈ text — ảnh/pdf thay bằng ghi chú,
 * mỗi tin trần theo COMPACT_MESSAGE_CHAR_CAP. Tóm tắt không cần pixel; giữ
 * payload nhỏ để nhanh và rẻ.
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

    text = text.trim();
    if (!text) continue;

    out.push({
      role: message.role,
      content:
        text.length > COMPACT_MESSAGE_CHAR_CAP
          ? `${text.slice(0, COMPACT_MESSAGE_CHAR_CAP)}…`
          : text,
    });
  }
  return out;
}
