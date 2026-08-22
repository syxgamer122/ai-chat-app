import Dexie, { type Table } from 'dexie';
import { tokenize } from '@/lib/search-utils';

/* ------------------------------------------------------------------ */
/* Domain Types                                                       */
/* ------------------------------------------------------------------ */

export type StoredMessageRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'data';

export type StoredMessageFinishReason =
  | 'stop'
  | 'abort'
  | 'error';

/**
 * Trạng thái lưu trữ tùy chọn.
 *
 * Có thể dùng ở các phase sau để phân biệt:
 * - assistant đang stream;
 * - assistant bị Stop;
 * - assistant kết thúc bình thường;
 * - assistant lỗi.
 */
export type StoredMessageStatus =
  | 'complete'
  | 'streaming'
  | 'aborted'
  | 'error';

/* ------------------------------------------------------------------ */
/* Chat Session                                                       */
/* ------------------------------------------------------------------ */

export interface ChatSession {
  id: string;
  title: string;

  /**
   * IndexedDB không index boolean ổn định theo cách mong muốn.
   * Vì vậy dự án hiện tại dùng 0 | 1.
   */
  pinned: 0 | 1;

  createdAt: number;
  updatedAt: number;

  /**
   * Node lá đang được chọn để dựng Active Thread.
   *
   * - Nếu chat chưa có message: có thể không tồn tại.
   * - Nếu chat đã có message: trỏ tới một StoredMessage hợp lệ.
   *
   * Dùng optional đúng theo yêu cầu tương thích dữ liệu cũ.
   */
  activeLeafId?: string;

  /**
   * Các field dưới đây là tùy chọn nhưng hữu ích cho đồng bộ đa tab
   * ở Giai đoạn 4.
   */
  revision?: number;
  lastWriterId?: string;
  activeLease?: any | null;
}

/* ------------------------------------------------------------------ */
/* Attachments                                                        */
/* ------------------------------------------------------------------ */

export interface StoredAttachment {
  name: string;
  contentType: string;

  /**
   * Ưu tiên Blob vì:
   * - tránh tăng kích thước khoảng 33% như base64;
   * - không cần decode thủ công;
   * - phù hợp với IndexedDB.
   */
  blob?: Blob;

  /**
   * Fallback cho dữ liệu cũ hoặc remote URL.
   *
   * Không nên lưu blob: URL lâu dài vì blob: URL chỉ có hiệu lực
   * trong document hiện tại.
   */
  url?: string;
}

/* ------------------------------------------------------------------ */
/* Stored Message                                                     */
/* ------------------------------------------------------------------ */

export interface StoredMessage {
  /**
   * Bắt buộc trùng với id của message trong useChat.
   */
  id: string;

  chatId: string;

  role: StoredMessageRole;

  content: string;

  /**
   * Quan hệ cha trong cây message.
   *
   * - null: root message.
   * - string: id của message cha.
   *
   * Các message có cùng parentId trong cùng chat là siblings.
   */
  parentId: string | null;

  /**
   * seq được giữ lại để:
   * - tương thích với schema v2;
   * - phục vụ migration;
   * - debug/export;
   * - tạo thứ tự ổn định ban đầu.
   *
   * Sau khi branching hoạt động, KHÔNG dùng seq để tái tạo
   * active thread. Active thread phải được dựng bằng parentId.
   */
  seq: number;

  createdAt: number;

  attachments?: StoredAttachment[];

  /**
   * Lý do kết thúc stream.
   */
  finishReason?: StoredMessageFinishReason;

  /**
   * Trạng thái tùy chọn.
   */
  status?: StoredMessageStatus;

  /**
   * Thứ tự của node trong nhóm siblings.
   *
   * Ví dụ, hai assistant cùng parent:
   *
   * assistant-1.branchOrder = 0
   * assistant-2.branchOrder = 1
   *
   * Field này giúp Branch Switcher có thứ tự ổn định.
   */
  branchOrder?: number;

  /**
   * Tie-breaker khi hai tab cùng sinh một branchOrder.
   */
  branchTieBreaker?: string;

  /**
   * Id của stream phục vụ recovery và lease synchronization.
   */
  streamId?: string;

  siblingIndex?: number;
  siblingCount?: number;
  toolInvocations?: any[];

  /** Index tìm kiếm (multiEntry) — được sinh tự động, không set thủ công. */
  tokens?: string[];
}

/* ------------------------------------------------------------------ */
/* Migration Helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Kiểu dữ liệu message chưa được chuẩn hóa từ các version cũ.
 *
 * Dùng any có kiểm soát trong migration vì IndexedDB chứa dữ liệu
 * runtime không được TypeScript kiểm tra.
 */
type LegacyMessageRecord = {
  id: string;
  chatId: string;
  role?: StoredMessageRole;
  content?: string;
  seq?: number;
  createdAt?: number;
  parentId?: string | null;
  attachments?: StoredAttachment[];
  experimental_attachments?: unknown;
  finishReason?: StoredMessageFinishReason;
  status?: StoredMessageStatus;
  branchOrder?: number;
};

/**
 * Chuẩn hóa pinned của dữ liệu cũ.
 */
function normalizePinned(value: unknown): 0 | 1 {
  return value ? 1 : 0;
}

/**
 * Chuẩn hóa createdAt.
 */
function normalizeCreatedAt(
  value: unknown,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback;
}

/**
 * Sắp xếp message cũ theo thứ tự tuyến tính.
 *
 * Với dữ liệu v2:
 * - seq là tiêu chí chính;
 * - createdAt là fallback;
 * - id là tie-breaker cuối cùng.
 */
function sortLegacyMessages(
  rows: LegacyMessageRecord[],
): LegacyMessageRecord[] {
  return [...rows].sort((a, b) => {
    const seqA =
      typeof a.seq === 'number'
        ? a.seq
        : Number.MAX_SAFE_INTEGER;

    const seqB =
      typeof b.seq === 'number'
        ? b.seq
        : Number.MAX_SAFE_INTEGER;

    if (seqA !== seqB) {
      return seqA - seqB;
    }

    const createdAtA =
      typeof a.createdAt === 'number'
        ? a.createdAt
        : 0;

    const createdAtB =
      typeof b.createdAt === 'number'
        ? b.createdAt
        : 0;

    if (createdAtA !== createdAtB) {
      return createdAtA - createdAtB;
    }

    return String(a.id).localeCompare(String(b.id));
  });
}

/* ------------------------------------------------------------------ */
/* Database                                                           */
/* ------------------------------------------------------------------ */

export class ChatDatabase extends Dexie {
  chats!: Table<ChatSession, string>;
  messages!: Table<StoredMessage, string>;

  constructor() {
    super('AIChatDB');

    /* -------------------------------------------------------------- */
    /* Version 1                                                      */
    /* -------------------------------------------------------------- */

    this.version(1).stores({
      chats: 'id, title, pinned, updatedAt',
      messages: 'id, chatId, createdAt',
    });

    /* -------------------------------------------------------------- */
    /* Version 2                                                      */
    /* -------------------------------------------------------------- */

    this.version(2)
      .stores({
        chats: 'id, pinned, updatedAt',
        messages: 'id, chatId, [chatId+seq], createdAt',
      })
      .upgrade(async (tx) => {
        const chatsTable = tx.table('chats');
        const messagesTable = tx.table('messages');

        /**
         * Nâng cấp pinned của chat cũ.
         */
        await chatsTable.toCollection().modify((chat: any) => {
          chat.pinned = normalizePinned(chat.pinned);
        });

        /**
         * Đọc toàn bộ message một lần.
         *
         * Không await update() trong vòng lặp từng record vì cách đó
         * dễ làm transaction bị inactive khi số lượng message lớn.
         */
        const rawRows =
          (await messagesTable.toArray()) as LegacyMessageRecord[];

        const messagesByChat = new Map<
          string,
          LegacyMessageRecord[]
        >();

        for (const row of rawRows) {
          const group =
            messagesByChat.get(row.chatId) ?? [];

          group.push(row);
          messagesByChat.set(row.chatId, group);
        }

        const baseTime = Date.now();

        /**
         * Tính toàn bộ dữ liệu cần cập nhật trong memory trước.
         */
        const messageUpdates: LegacyMessageRecord[] = [];

        for (const group of messagesByChat.values()) {
          const sorted = sortLegacyMessages(group);

          for (let index = 0; index < sorted.length; index++) {
            const row = sorted[index];

            messageUpdates.push({
              ...row,
              seq: index,
              createdAt: normalizeCreatedAt(
                row.createdAt,
                baseTime + index,
              ),
              attachments:
                row.attachments ??
                (row.experimental_attachments as
                  | StoredAttachment[]
                  | undefined),
            });
          }
        }

        /**
         * Ghi một lần bằng bulkPut thay vì update từng row.
         */
        if (messageUpdates.length > 0) {
          await messagesTable.bulkPut(messageUpdates);
        }
      });

    /* -------------------------------------------------------------- */
    /* Version 3 — Message Tree                                      */
    /* -------------------------------------------------------------- */

    this.version(3)
      .stores({
        /**
         * activeLeafId và revision được index để có thể truy vấn/
         * theo dõi thay đổi thuận tiện hơn.
         */
        chats:
          'id, title, pinned, updatedAt, activeLeafId, revision',

        /**
         * Các index quan trọng:
         *
         * - id: primary key
         * - chatId: lấy toàn bộ message trong một chat
         * - parentId: tìm các node con theo cha
         * - createdAt: sắp xếp thời gian
         * - seq: tương thích dữ liệu cũ
         * - [chatId+seq]: tương thích code cũ và migration
         * - [chatId+parentId]: có thể dùng để query siblings
         */
        messages: [
          'id',
          'chatId',
          'parentId',
          'createdAt',
          'seq',
          '[chatId+seq]',
          '[chatId+parentId]',
        ].join(','),
      })
      .upgrade(async (tx) => {
        const chatsTable = tx.table('chats');
        const messagesTable = tx.table('messages');

        /**
         * Đọc toàn bộ dữ liệu cần thiết trước.
         *
         * Sau bước này, phần xử lý cây diễn ra trong memory.
         * Điều này giúp tránh pattern nguy hiểm:
         *
         * for (...) {
         *   await table.update(...)
         * }
         *
         * Pattern trên có thể gây TransactionInactiveError trong
         * một số tình huống/browser khi transaction bị auto-commit.
         */
        const rawMessages =
          (await messagesTable.toArray()) as LegacyMessageRecord[];

        const rawChats =
          (await chatsTable.toArray()) as Array<
            ChatSession & Record<string, unknown>
          >;

        const messagesByChat = new Map<
          string,
          LegacyMessageRecord[]
        >();

        for (const row of rawMessages) {
          const group =
            messagesByChat.get(row.chatId) ?? [];

          group.push(row);
          messagesByChat.set(row.chatId, group);
        }

        const chatById = new Map<
          string,
          ChatSession & Record<string, unknown>
        >();

        for (const chat of rawChats) {
          chatById.set(chat.id, chat);
        }

        const baseTime = Date.now();

        /**
         * Tính trước toàn bộ message cần ghi.
         */
        const messageUpdates: StoredMessage[] = [];

        /**
         * Tính trước toàn bộ chat cần ghi.
         */
        const chatUpdates: ChatSession[] = [];

        for (const [chatId, group] of messagesByChat) {
          const sorted = sortLegacyMessages(group);

          let previousMessageId: string | null = null;

          for (let index = 0; index < sorted.length; index++) {
            const row = sorted[index];

            /**
             * Dữ liệu v2 là tuyến tính, nên migration v2 -> v3
             * chuyển thành một chain duy nhất:
             *
             * message[0].parentId = null
             * message[1].parentId = message[0].id
             * message[2].parentId = message[1].id
             * ...
             */
            const parentId =
              typeof row.parentId === 'string' ||
              row.parentId === null
                ? row.parentId
                : previousMessageId;

            const normalizedRow: StoredMessage = {
              id: row.id,
              chatId,
              role: row.role ?? 'user',
              content:
                typeof row.content === 'string'
                  ? row.content
                  : '',
              parentId,
              seq:
                typeof row.seq === 'number'
                  ? row.seq
                  : index,
              createdAt: normalizeCreatedAt(
                row.createdAt,
                baseTime + index,
              ),
              attachments:
                row.attachments ??
                (row.experimental_attachments as
                  | StoredAttachment[]
                  | undefined),
              finishReason:
                row.finishReason ?? 'stop',
              status:
                row.status ?? 'complete',
              branchOrder:
                typeof row.branchOrder === 'number'
                  ? row.branchOrder
                  : 0,
            };

            messageUpdates.push(normalizedRow);
            previousMessageId = normalizedRow.id;
          }

          /**
           * Message cuối cùng của chain được chọn làm active leaf
           * cho chat cũ.
           */
          const lastMessage = sorted[sorted.length - 1];
          const chat = chatById.get(chatId);

          if (chat) {
            const lastMessageId =
              lastMessage?.id;

            const activeLeafId =
              typeof chat.activeLeafId === 'string'
                ? chat.activeLeafId
                : lastMessageId;

            chatUpdates.push({
              id: chat.id,
              title:
                typeof chat.title === 'string'
                  ? chat.title
                  : 'New Chat',
              pinned: normalizePinned(chat.pinned),
              createdAt: normalizeCreatedAt(
                chat.createdAt,
                baseTime,
              ),
              updatedAt: normalizeCreatedAt(
                chat.updatedAt,
                baseTime,
              ),
              ...(activeLeafId
                ? { activeLeafId }
                : {}),
              revision:
                typeof chat.revision === 'number'
                  ? chat.revision
                  : 1,
              lastWriterId:
                typeof chat.lastWriterId === 'string'
                  ? chat.lastWriterId
                  : undefined,
            });
          }
        }

        /**
         * Xử lý chat không có message.
         *
         * Các chat rỗng vẫn cần được chuẩn hóa pinned/revision,
         * nhưng không gán activeLeafId.
         */
        for (const chat of rawChats) {
          const alreadyUpdated = chatUpdates.some(
            (item) => item.id === chat.id,
          );

          if (alreadyUpdated) continue;

          chatUpdates.push({
            id: chat.id,
            title:
              typeof chat.title === 'string'
                ? chat.title
                : 'New Chat',
            pinned: normalizePinned(chat.pinned),
            createdAt: normalizeCreatedAt(
              chat.createdAt,
              baseTime,
            ),
            updatedAt: normalizeCreatedAt(
              chat.updatedAt,
              baseTime,
            ),
            ...(typeof chat.activeLeafId === 'string'
              ? {
                  activeLeafId: chat.activeLeafId,
                }
              : {}),
            revision:
              typeof chat.revision === 'number'
                ? chat.revision
                : 1,
            lastWriterId:
              typeof chat.lastWriterId === 'string'
                ? chat.lastWriterId
                : undefined,
          });
        }

        /**
         * Ghi theo batch.
         *
         * Không update từng record trong vòng lặp.
         */
        if (messageUpdates.length > 0) {
          await messagesTable.bulkPut(messageUpdates);
        }

        if (chatUpdates.length > 0) {
          await chatsTable.bulkPut(chatUpdates);
        }
      });

    /* -------------------------------------------------------------- */
    /* Version 4 — Search Index (*tokens)                             */
    /* -------------------------------------------------------------- */

    this.version(4)
      .stores({
        chats:
          'id, title, pinned, updatedAt, activeLeafId, revision',
        messages: [
          'id',
          'chatId',
          'parentId',
          'createdAt',
          'seq',
          '*tokens',
          '[chatId+seq]',
          '[chatId+parentId]',
          '[chatId+createdAt]',
        ].join(','),
      })
      .upgrade(async (tx) => {
        const messagesTable = tx.table('messages');
        const rawMessages =
          (await messagesTable.toArray()) as StoredMessage[];

        const messageUpdates: StoredMessage[] = [];
        for (const msg of rawMessages) {
          messageUpdates.push({
            ...msg,
            tokens: tokenize(msg.content ?? ''),
          });
        }

        if (messageUpdates.length > 0) {
          await messagesTable.bulkPut(messageUpdates);
        }
      });

    this.registerSearchHooks();
  }

  /** Tự động đồng bộ `tokens` mỗi khi message được ghi/sửa. */
  private registerSearchHooks() {
    this.messages.hook('creating', (_primKey, obj) => {
      obj.tokens = tokenize(obj.content ?? '');
    });

    this.messages.hook('updating', (modifications, _primKey, obj) => {
      const mods = modifications as Partial<StoredMessage>;
      const nextStatus = 'status' in mods ? mods.status : obj.status;

      if (typeof mods.content === 'string') {
        // Đang stream: hoãn tokenize để không tốn CPU theo từng chunk
        if (nextStatus === 'streaming') return undefined;
        return { tokens: tokenize(mods.content) };
      }

      // Vừa kết thúc stream mà content không nằm trong mods → tokenize lần cuối
      if (obj.status === 'streaming' && nextStatus && nextStatus !== 'streaming') {
        return { tokens: tokenize(obj.content ?? '') };
      }

      return undefined;
    });
  }
}

/* ------------------------------------------------------------------ */
/* Singleton Database Instance                                        */
/* ------------------------------------------------------------------ */

export const db = new ChatDatabase();

/**
 * Gọi tuỳ chọn sau khi stream kết thúc nếu luồng ghi của bạn KHÔNG set `status`.
 * An toàn để gọi nhiều lần.
 */
export async function finalizeMessageTokens(messageId: string): Promise<void> {
  const msg = await db.messages.get(messageId);
  if (!msg) return;
  await db.messages.update(messageId, { tokens: tokenize(msg.content ?? '') });
}

/**
 * Khi một tab khác nâng cấp database, tab hiện tại phải đóng database
 * và reload để tránh giữ connection cũ.
 */
if (typeof window !== 'undefined') {
  db.on('versionchange', () => {
    db.close();
    window.location.reload();
  });

  db.on('blocked', () => {
    console.warn(
      '[IndexedDB] Database upgrade đang bị chặn bởi một tab khác.',
    );
  });
}

export { Dexie };
