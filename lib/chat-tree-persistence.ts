/*
 * Logic persistence cho cây hội thoại — tách khỏi chat-interface.tsx.
 * Toàn bộ hàm thuần (không React), dễ unit-test độc lập.
 */
import type { Message } from 'ai/react';
import { toParentKey, fromParentKey, type StoredMessage, type StoredAttachment } from '@/lib/db';
import { reconstructActiveThread } from '@/lib/tree-utils';
import { toPersistableText } from '@/lib/message-text';

export const CONTINUE_PROMPT =
  'Câu trả lời trước bị ngắt giữa chừng. Hãy viết tiếp CHÍNH XÁC từ chỗ bị cắt, ' +
  'không lặp lại phần đã viết, không mở đầu lại, giữ nguyên định dạng LaTeX.';

/** Nội dung lưu/hiển thị luôn phải là string sạch. */
export function sanitizeContent(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'object') return toPersistableText(raw as any);
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/(?:\r?\n[ \t]*(?:\[object [A-Za-z]+\]|undefined|null|NaN)[ \t]*)+[\s]*$/g, '')
    .replace(/(\$\$|\\\]|\\\)|>)[ \t]*(?:\[object [A-Za-z]+\]|undefined|null|NaN)+[\s]*$/g, '$1')
    .replace(/[\s\u200B]+$/, '');
}

/** Backend gắn annotation type:'finish' — dùng để biết tin nhắn có bị cắt hay không. */
export function getFinishInfo(m: Message): { truncated: boolean; message?: string } {
  const ann = (m.annotations as any[] | undefined) ?? [];
  const finish = ann.find((a) => a && a.type === 'finish');
  return { truncated: Boolean(finish?.truncated), message: finish?.message };
}

const attachmentCache = new WeakMap<object, StoredAttachment | null>();

async function toStoredAttachment(a: any): Promise<StoredAttachment | null> {
  if (typeof a === 'object' && a !== null && attachmentCache.has(a)) {
    return attachmentCache.get(a)!;
  }

  const name = a.name ?? 'file';
  const contentType = a.contentType ?? '';

  const newId = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `att-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  let stored: StoredAttachment | null = null;

  if (a.blob instanceof Blob) {
    stored = {
      id: newId(),
      name,
      contentType: contentType || a.blob.type,
      size: a.blob.size,
      blob: a.blob,
    };
  } else {
    const url = typeof a.url === 'string' ? a.url : '';

    if (url.startsWith('data:') || url.startsWith('blob:')) {
      try {
        const response = await fetch(url);
        const blob = await response.blob();
        stored = {
          id: newId(),
          name,
          contentType: contentType || blob.type,
          size: blob.size,
          blob,
        };
      } catch {
        // Không fetch được blob tạm — attachment không dùng được.
        stored = null;
      }
    } else if (/^https?:\/\//i.test(url)) {
      stored = {
        id: newId(),
        name,
        contentType,
        size: 0,
        remoteUrl: url,
      };
    }
  }

  if (typeof a === 'object' && a !== null) {
    attachmentCache.set(a, stored);
  }
  return stored;
}

async function getStoredAttachments(
  message: Message,
): Promise<StoredAttachment[] | undefined> {
  const rawAttachments =
    message.experimental_attachments as
      | any[]
      | undefined;

  if (
    !rawAttachments ||
    rawAttachments.length === 0
  ) {
    return undefined;
  }

  const converted = await Promise.all(
    rawAttachments.map(toStoredAttachment),
  );
  const usable = converted.filter(
    (attachment): attachment is StoredAttachment => attachment !== null,
  );
  return usable.length ? usable : undefined;
}

function getMessageCreatedAt(
  message: Message,
  fallback: number,
): number {
  if (typeof message.createdAt === 'number') {
    return message.createdAt;
  }

  if (message.createdAt instanceof Date) {
    return message.createdAt.getTime();
  }

  return fallback;
}

export function revokeObjectUrls(urls: Set<string>) {
  for (const url of urls) {
    URL.revokeObjectURL(url);
  }
  urls.clear();
}

function createAttachmentUrl(attachment: StoredAttachment, urls: Set<string>): string {
  if (attachment.blob) {
    const url = URL.createObjectURL(attachment.blob);
    urls.add(url);
    return url;
  }
  return attachment.remoteUrl ?? '';
}

export function toChatMessage(
  row: StoredMessage,
  objectUrls: Set<string>,
): Message & { status?: StoredMessage['status']; finishReason?: StoredMessage['finishReason'] } {
  return {
    id: row.id,
    role: row.role as Message['role'],
    content: sanitizeContent(row.content),
    status: row.status,
    finishReason: row.finishReason,
    annotations: row.annotations as Message['annotations'],
    experimental_attachments: row.attachments?.map(
      (attachment) => ({
        name: attachment.name,
        contentType: attachment.contentType,
        url: createAttachmentUrl(
          attachment,
          objectUrls,
        ),
      }),
    ) as any,
  };
}

export function getNextBranchOrder(
  allMessages: StoredMessage[],
  parentId: string | null,
): number {
  let maxBranchOrder = -1;

  for (const message of allMessages) {
    if (message.parentId !== parentId) {
      continue;
    }

    const order =
      typeof message.branchOrder === 'number'
        ? message.branchOrder
        : 0;

    if (order > maxBranchOrder) {
      maxBranchOrder = order;
    }
  }

  return maxBranchOrder + 1;
}

export function getNextSequence(
  allMessages: StoredMessage[],
): number {
  let maxSequence = -1;

  for (const message of allMessages) {
    if (
      typeof message.seq === 'number' &&
      Number.isFinite(message.seq) &&
      message.seq > maxSequence
    ) {
      maxSequence = message.seq;
    }
  }

  return maxSequence + 1;
}

export function upsertStoredMessages(
  current: StoredMessage[],
  updates: StoredMessage[],
): StoredMessage[] {
  if (updates.length === 0) {
    return current;
  }

  const updateById = new Map(
    updates.map((message) => [
      message.id,
      message,
    ]),
  );

  const result = current.map(
    (message) =>
      updateById.get(message.id) ?? message,
  );

  const existingIds = new Set(
    current.map((message) => message.id),
  );

  for (const update of updates) {
    if (!existingIds.has(update.id)) {
      result.push(update);
    }
  }

  return result;
}

export function reconstructParentPath(
  allMessages: StoredMessage[],
  parentId: string | null,
): StoredMessage[] {
  if (parentId === null) {
    return [];
  }

  return reconstructActiveThread(
    allMessages,
    parentId,
  );
}

export function getFinalStoredStatus(
  finishReason: StoredMessage['finishReason'],
): StoredMessage['status'] {
  switch (finishReason) {
    case 'abort':
      return 'aborted';

    case 'error':
      return 'error';

    case 'stop':
    default:
      return 'complete';
  }
}

interface ReconcileResult {
  /**
   * Toàn bộ tree sau khi reconcile.
   */
  allRows: StoredMessage[];

  /**
   * Chỉ các row cần ghi vào IndexedDB (row đã tồn tại, nội dung thay đổi).
   */
  changedRows: StoredMessage[];

  /**
   * Row chưa từng có trong DB — PHẢI chèn qua db.appendMessage
   * để seq/branchOrder được cấp nguyên tử trong transaction.
   */
  newRows: StoredMessage[];

  /**
   * Leaf mới nhất của active projection.
   */
  activeLeafId: string | null;

  /**
   * Assistant mới được phát hiện trong lần reconcile này.
   */
  createdAssistantId?: string;
}

function attachmentMetadataSignature(
  attachments:
    | StoredAttachment[]
    | undefined,
): string {
  if (!attachments?.length) {
    return '';
  }

  return attachments
    .map((attachment) =>
      [
        attachment.name,
        attachment.contentType,
        attachment.remoteUrl ?? '',
        attachment.blob?.size ?? 0,
      ].join(':'),
    )
    .join('|');
}

function hasStoredMessageChanged(
  previous: StoredMessage,
  next: StoredMessage,
): boolean {
  return (
    previous.content !== next.content ||
    previous.status !== next.status ||
    previous.finishReason !==
      next.finishReason ||
    attachmentMetadataSignature(
      previous.attachments,
    ) !==
      attachmentMetadataSignature(
        next.attachments,
      )
  );
}

export async function reconcileActiveMessages(
  chatId: string,
  visibleMessages: Message[],
  currentTree: StoredMessage[],
  pendingFork: PendingAssistantFork | null,
  isCurrentlyLoading: boolean,
  finishReason: StoredMessage['finishReason'],
): Promise<ReconcileResult> {
  if (visibleMessages.length === 0) {
    return {
      allRows: currentTree,
      changedRows: [],
      newRows: [],
      activeLeafId: null,
    };
  }

  /**
   * Map toàn bộ tree hiện tại để lookup O(1).
   */
  const rowById = new Map<string, StoredMessage>();

  for (const row of currentTree) {
    rowById.set(row.id, row);
  }

  /**
   * workingRows chứa cả dữ liệu cũ và node mới được phát hiện
   * trong cùng một lượt reconcile.
   */
  const workingRows = [...currentTree];
  const changedRows: StoredMessage[] = [];
  const newRows: StoredMessage[] = [];

  let nextSequence =
    getNextSequence(currentTree);

  let previousVisibleId: string | null = null;
  let createdAssistantId: string | undefined;

  for (
    let index = 0;
    index < visibleMessages.length;
    index++
  ) {
    const message = visibleMessages[index];
    const existing = rowById.get(message.id);

    const isLast =
      index === visibleMessages.length - 1;

    const isStreamingAssistant =
      isCurrentlyLoading &&
      isLast &&
      message.role === 'assistant';

    /**
     * Message đã tồn tại trong tree.
     */
    if (existing) {
      const nextFinishReason:
        StoredMessage['finishReason'] =
        isStreamingAssistant
          ? existing.finishReason
          : isLast &&
              message.role === 'assistant'
            ? finishReason ?? 'stop'
            : existing.finishReason ?? 'stop';

      const nextStatus:
        StoredMessage['status'] =
        isStreamingAssistant
          ? 'streaming'
          : isLast &&
              message.role === 'assistant'
            ? getFinalStoredStatus(
                nextFinishReason,
              )
            : existing.status ?? 'complete';

      const updated: StoredMessage = {
        ...existing,

        /**
         * Content có thể thay đổi từng token trong lúc stream.
         */
        content: sanitizeContent(message.content),

        /**
         * Không thay đổi:
         * - parentId
         * - seq
         * - branchOrder
         */
        finishReason: nextFinishReason,
        status: nextStatus,
        annotations: (message.annotations as any[]) ?? existing.annotations,
      };

      if (
        hasStoredMessageChanged(
          existing,
          updated,
        )
      ) {
        changedRows.push(updated);
        rowById.set(updated.id, updated);

        const existingIndex =
          workingRows.findIndex(
            (row) => row.id === updated.id,
          );

        if (existingIndex >= 0) {
          workingRows[existingIndex] =
            updated;
        }
      }

      previousVisibleId = existing.id;
      continue;
    }

    /**
     * Message mới chưa tồn tại trong cây.
     */
    let parentId: string | null =
      previousVisibleId;

    let branchOrder: number;

    const isPendingForkAssistant =
      message.role === 'assistant' &&
      pendingFork !== null &&
      pendingFork.chatId === chatId &&
      !pendingFork.assistantMessageId &&
      previousVisibleId ===
        pendingFork.parentId;

    if (isPendingForkAssistant) {
      /**
       * Assistant được tạo bởi Edit hoặc Regenerate.
       * Metadata phải lấy từ reservation đã tạo trước reload().
       */
      parentId = pendingFork.parentId;
      branchOrder =
        pendingFork.branchOrder;

      createdAssistantId = message.id;
    } else {
      /**
       * Message bình thường nối vào message trước đó
       * trong active projection.
       */
      branchOrder = getNextBranchOrder(
        workingRows,
        // So sánh trên key đã chuẩn hoá — row trong workingRows luôn mang '__ROOT__' ở cấp gốc.
        toParentKey(parentId),
      );
    }

    const attachments =
      await getStoredAttachments(message);

    const now = Date.now();

    const newRow: StoredMessage = {
      id: message.id,
      chatId,
      role:
        message.role as StoredMessage['role'],
      content: sanitizeContent(message.content),

      parentId: toParentKey(parentId),

      seq: nextSequence++,

      createdAt: getMessageCreatedAt(
        message,
        now + index,
      ),

      attachments,

      branchOrder,

      branchTieBreaker: message.id,

      annotations: (message.annotations as any[]) ?? undefined,

      finishReason:
        isStreamingAssistant
          ? undefined
          : isLast &&
              message.role === 'assistant'
            ? finishReason ?? 'stop'
            : 'stop',

      status:
        isStreamingAssistant
          ? 'streaming'
          : isLast &&
              message.role === 'assistant'
            ? getFinalStoredStatus(
                finishReason ?? 'stop',
              )
            : 'complete',
    };

    workingRows.push(newRow);
    newRows.push(newRow);
    rowById.set(newRow.id, newRow);

    previousVisibleId = newRow.id;
  }

  return {
    allRows: workingRows,
    changedRows,
    newRows,
    activeLeafId:
      visibleMessages[
        visibleMessages.length - 1
      ]?.id ?? null,
    createdAssistantId,
  };
}

type AssistantForkSource =
  | 'edit'
  | 'regenerate';

export interface PendingAssistantFork {
  chatId: string;

  /**
   * User message mà assistant mới sẽ trả lời.
   */
  parentId: string;

  /**
   * Thứ tự assistant mới trong nhóm siblings.
   */
  branchOrder: number;

  source: AssistantForkSource;

  /**
   * Khi useChat tạo assistant thực tế, lưu id tại đây.
   */
  assistantMessageId?: string;

  createdAt: number;
}

