import Dexie, { type Table } from 'dexie';
import { tokenize } from '@/lib/search-utils';

/**
 * IndexedDB KHÔNG index được `null`. Message gốc phải mang sentinel này,
 * nếu không sẽ biến mất khỏi [chatId+parentId] và làm sập cấp phát branchOrder.
 * `null` chỉ tồn tại ở tầng domain; DB luôn thấy string.
 */
export const ROOT_KEY = '__ROOT__';

export function toParentKey(parentId: string | null | undefined): string {
  return parentId == null || parentId === ROOT_KEY ? ROOT_KEY : parentId;
}
export function fromParentKey(key: string | null | undefined): string | null {
  return key == null || key === ROOT_KEY ? null : key;
}

export type StoredMessageRole = 'user' | 'assistant' | 'system' | 'data';
export type StoredMessageFinishReason = 'stop' | 'abort' | 'error';
export type StoredMessageStatus = 'complete' | 'streaming' | 'aborted' | 'error';

export interface StreamLease {
  chatId: string;
  messageId: string;
  writerId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface ChatSession {
  id: string;
  title: string;
  titleTokens?: string[];
  pinned: 0 | 1;
  createdAt: number;
  updatedAt: number;
  activeLeafId?: string;
  /** key = parentId đã chuẩn hóa (ROOT_KEY cho gốc), value = childId được chọn */
  branchSelection?: Record<string, string>;
  revision?: number;
  lastWriterId?: string;
}

export interface StoredAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  /** BẮT BUỘC Blob. Không data URL, không blob: URL. */
  blob: Blob;
}

export interface StoredMessage {
  id: string;
  chatId: string;
  role: StoredMessageRole;
  content: string;
  /** Luôn là string trong DB. Dùng fromParentKey() khi đọc ra domain. */
  parentId: string;
  seq: number;
  branchOrder: number;
  branchTieBreaker: string;
  createdAt: number;
  attachments?: StoredAttachment[];
  finishReason?: StoredMessageFinishReason;
  status?: StoredMessageStatus;
  tokens?: string[];
}

/** Loại bỏ mọi URL tạm / data URL trước khi persist. */
function sanitizeAttachments(list?: StoredAttachment[]): StoredAttachment[] | undefined {
  if (!list?.length) return list;
  return list.map((a) => {
    const { blob, id, name, contentType, size } = a as StoredAttachment & { url?: string };
    if (!(blob instanceof Blob)) {
      throw new Error(`[db] Attachment "${name}" thiếu Blob — không được persist URL/base64.`);
    }
    return { id, name, contentType, size: size ?? blob.size, blob };
  });
}

export class ChatAppDatabase extends Dexie {
  chats!: Table<ChatSession, string>;
  messages!: Table<StoredMessage, string>;
  leases!: Table<StreamLease, string>;

  constructor() {
    super('ai_chat_app_db');

    this.version(1).stores({
      chats: 'id, createdAt, updatedAt, pinned',
      messages: 'id, chatId, role, createdAt, seq, parentId',
    });

    this.version(2).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId',
      messages:
        'id, chatId, role, createdAt, seq, parentId, [chatId+parentId], [chatId+createdAt]',
    });

    this.version(3).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId',
      messages:
        'id, chatId, role, createdAt, seq, parentId, [chatId+parentId], [chatId+createdAt], *tokens',
    });

    this.version(4)
      .stores({
        chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
        messages:
          'id, chatId, role, createdAt, seq, parentId, ' +
          '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
          '[chatId+parentId+branchOrder], *tokens',
        leases: 'chatId, expiresAt, writerId',
      })
      .upgrade(async (tx) => {
        const counters = new Map<string, number>();
        await tx
          .table<StoredMessage>('messages')
          .toCollection()
          .modify((m) => {
            const legacy = m as StoredMessage & { parentId: string | null };
            m.parentId = toParentKey(legacy.parentId);
            if (typeof m.branchTieBreaker !== 'string') m.branchTieBreaker = m.id;
            if (!Array.isArray(m.tokens) || m.tokens.length === 0) {
              m.tokens = tokenize(m.content || '');
            }
            if (typeof m.branchOrder !== 'number') {
              const bucket = `${m.chatId}::${m.parentId}`;
              const next = counters.get(bucket) ?? 0;
              m.branchOrder = next;
              counters.set(bucket, next + 1);
            }
          });

        await tx
          .table<ChatSession>('chats')
          .toCollection()
          .modify((c) => {
            if (!Array.isArray(c.titleTokens) || c.titleTokens.length === 0) {
              c.titleTokens = tokenize(c.title || '');
            }
            delete (c as Record<string, unknown>).activeLease;
          });
      });

    this.messages.hook('creating', (_primKey, obj) => {
      obj.parentId = toParentKey(obj.parentId as string | null);
      if (typeof obj.branchTieBreaker !== 'string') obj.branchTieBreaker = obj.id;
      if (typeof obj.branchOrder !== 'number') obj.branchOrder = 0;
      obj.attachments = sanitizeAttachments(obj.attachments);
      if (obj.status !== 'streaming' && (!obj.tokens || obj.tokens.length === 0)) {
        obj.tokens = tokenize(obj.content || '');
      }
    });

    this.messages.hook('updating', (mods: Partial<StoredMessage>, _primKey, obj) => {
      const patch: Partial<StoredMessage> = {};

      const nextStatus = ('status' in mods ? mods.status : obj.status) ?? 'complete';
      const nextContent = ('content' in mods ? mods.content : obj.content) ?? '';
      const contentChanged = 'content' in mods && typeof mods.content === 'string';
      const leftStreaming = obj.status === 'streaming' && nextStatus !== 'streaming';

      if ((contentChanged || leftStreaming) && nextStatus !== 'streaming') {
        patch.tokens = tokenize(nextContent);
      }
      if ('parentId' in mods) {
        patch.parentId = toParentKey(mods.parentId as unknown as string | null);
      }
      if ('attachments' in mods) {
        patch.attachments = sanitizeAttachments(mods.attachments);
      }
      return Object.keys(patch).length ? { ...mods, ...patch } : mods;
    });

    this.chats.hook('creating', (_primKey, obj) => {
      obj.titleTokens = tokenize(obj.title || '');
    });
    this.chats.hook('updating', (mods: Partial<ChatSession>) => {
      if ('title' in mods && typeof mods.title === 'string') {
        return { ...mods, titleTokens: tokenize(mods.title) };
      }
      return mods;
    });

    this.on('blocked', () => {
      console.warn('[db] Upgrade bị chặn bởi tab khác đang mở phiên bản cũ.');
    });
    this.on('versionchange', () => {
      this.close();
      if (typeof window !== 'undefined') window.location.reload();
    });
  }
}

export const db = new ChatAppDatabase();

/* ------------------------------------------------------------------ */
/* Allocator ATOMIC — mọi lệnh chèn message PHẢI đi qua đây            */
/* ------------------------------------------------------------------ */

export interface AppendMessageInput
  extends Omit<StoredMessage, 'parentId' | 'seq' | 'branchOrder' | 'branchTieBreaker' | 'createdAt'> {
  parentId: string | null;
  createdAt?: number;
}

export async function appendMessage(input: AppendMessageInput): Promise<StoredMessage> {
  const parentKey = toParentKey(input.parentId);

  return db.transaction('rw', db.messages, db.chats, async () => {
    const lastSibling = await db.messages
      .where('[chatId+parentId+branchOrder]')
      .between(
        [input.chatId, parentKey, Dexie.minKey],
        [input.chatId, parentKey, Dexie.maxKey],
      )
      .last();

    const lastInChat = await db.messages
      .where('[chatId+seq]')
      .between([input.chatId, Dexie.minKey], [input.chatId, Dexie.maxKey])
      .last();

    const record: StoredMessage = {
      ...input,
      parentId: parentKey,
      seq: (lastInChat?.seq ?? -1) + 1,
      branchOrder: (lastSibling?.branchOrder ?? -1) + 1,
      branchTieBreaker: input.id,
      createdAt: input.createdAt ?? Date.now(),
      attachments: sanitizeAttachments(input.attachments),
    };

    await db.messages.add(record);
    await db.chats.update(input.chatId, {
      updatedAt: record.createdAt,
      activeLeafId: record.id,
    });
    return record;
  });
}

/** Ghi chunk stream: CHỈ field content. Không bao giờ put cả record. */
export function patchStreamingContent(messageId: string, content: string): Promise<number> {
  return db.messages.update(messageId, { content });
}

export async function finalizeMessage(
  messageId: string,
  content: string,
  finishReason: StoredMessageFinishReason,
): Promise<void> {
  await db.messages.update(messageId, {
    content,
    finishReason,
    status:
      finishReason === 'stop' ? 'complete' : finishReason === 'abort' ? 'aborted' : 'error',
  });
}

/** Cascade delete: messages + attachments + lease + ObjectURL. */
export async function deleteChatCascade(
  chatId: string,
  revokeObjectUrls?: (chatId: string) => void,
): Promise<void> {
  await db.transaction('rw', db.messages, db.chats, db.leases, async () => {
    await db.messages.where('chatId').equals(chatId).delete();
    await db.leases.where('chatId').equals(chatId).delete();
    await db.chats.delete(chatId);
  });
  revokeObjectUrls?.(chatId);
}

export { Dexie };