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
  /** Blob lưu trực tiếp trong IndexedDB. Không data URL, không blob: URL. */
  blob?: Blob;
  /** File nằm ở remote storage (http/https) — khi đó không có blob. */
  remoteUrl?: string;
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
  /** Annotation từ data stream (requestId, attempt, key, model...). */
  annotations?: Array<Record<string, unknown>>;
}

/** Mẫu prompt cho thư viện "/" trong composer. */
export interface PromptTemplate {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

/** Nhà cung cấp API (provider preset) — chuẩn OpenAI-compatible. */
export interface ProviderPresetRecord {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  createdAt: number;
  updatedAt: number;
  models?: Array<{ id: string; name?: string; contextLength?: number }>;
  modelsFetchedAt?: number;
}

/** KV chung: directory handle auto-backup, flags seed... */
export interface KVEntry {
  key: string;
  value: unknown;
}

function newAttachmentId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `att-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Chuẩn hoá trước khi persist: tự sinh id/size nếu thiếu.
 * Bỏ (không throw) attachment không có Blob hay remote URL hợp lệ —
 * một record lỗi không được làm sập toàn bộ lượt ghi.
 */
function sanitizeAttachments(list?: StoredAttachment[]): StoredAttachment[] | undefined {
  if (!list?.length) return list;
  const cleaned: StoredAttachment[] = [];
  for (const a of list) {
    const { blob, id, name, contentType, size, remoteUrl } = a as StoredAttachment & {
      url?: string;
    };
    if (!(blob instanceof Blob) && !/^https?:\/\//i.test(remoteUrl ?? '')) {
      console.warn(`[db] Bỏ attachment "${name}" — không có Blob/remote URL hợp lệ.`);
      continue;
    }
    cleaned.push({
      id: id || newAttachmentId(),
      name,
      contentType,
      size: size ?? blob?.size ?? 0,
      ...(blob instanceof Blob ? { blob } : {}),
      ...(remoteUrl ? { remoteUrl } : {}),
    });
  }
  return cleaned.length ? cleaned : undefined;
}

export class ChatAppDatabase extends Dexie {
  chats!: Table<ChatSession, string>;
  messages!: Table<StoredMessage, string>;
  prompts!: Table<PromptTemplate, string>;
  kv!: Table<KVEntry, string>;
  providers!: Table<ProviderPresetRecord, string>;

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
      .upgrade(async (tx) => {        const counters = new Map<string, number>();
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
            delete (c as unknown as Record<string, unknown>).activeLease;
          });
      });

    // v5: bỏ bảng leases (hệ thống stream lease đã được gỡ hoàn toàn).
    // Table thiếu trong schema mới sẽ bị Dexie tự động xoá.
    this.version(5).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
    });

    // v6: thư viện prompt ("/") + bảng KV (lưu directory handle auto-backup, flags).
    this.version(6).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
      prompts: 'id, updatedAt',
      kv: 'key',
    });

    // v7: provider presets — nhiều nhà cung cấp API OpenAI-compatible.
    this.version(7).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
      prompts: 'id, updatedAt',
      kv: 'key',
      providers: 'id, updatedAt',
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

/** Cascade delete: messages + attachments của cả chat. */
export async function deleteChatCascade(chatId: string): Promise<void> {
  await db.transaction('rw', db.messages, db.chats, async () => {
    await db.messages.where('chatId').equals(chatId).delete();
    await db.chats.delete(chatId);
  });
}