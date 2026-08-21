import Dexie, { type Table } from 'dexie';

export interface ChatSession {
  id: string;
  title: string;
  /** IndexedDB không index được boolean -> dùng 0/1 */
  pinned: 0 | 1;
  createdAt: number;
  updatedAt: number;
}

export interface StoredAttachment {
  name: string;
  contentType: string;
  /** Ưu tiên Blob: nhẹ hơn base64 ~33% và không tốn CPU decode */
  blob?: Blob;
  /** fallback cho dữ liệu cũ đã lưu dạng data URL */
  url?: string;
}

export interface StoredMessage {
  /** BẮT BUỘC trùng id message của useChat */
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system' | 'data';
  content: string;
  /** vị trí tuyệt đối trong hội thoại -> thứ tự ổn định, truncate dễ */
  seq: number;
  createdAt: number;
  attachments?: StoredAttachment[];
  /** 'abort' = người dùng bấm Stop, phần trả lời còn dở */
  finishReason?: 'stop' | 'abort' | 'error';
}

export class ChatDatabase extends Dexie {
  chats!: Table<ChatSession, string>;
  messages!: Table<StoredMessage, string>;

  constructor() {
    super('AIChatDB');

    this.version(1).stores({
      chats: 'id, title, pinned, updatedAt',
      messages: 'id, chatId, createdAt',
    });

    this.version(2)
      .stores({
        chats: 'id, pinned, updatedAt',
        messages: 'id, chatId, [chatId+seq], createdAt',
      })
      .upgrade(async (tx) => {
        await tx.table('chats').toCollection().modify((c: any) => {
          c.pinned = c.pinned ? 1 : 0;
        });

        // Gán seq theo createdAt cho dữ liệu cũ.
        const rows: any[] = await tx.table('messages').toArray();
        const byChat = new Map<string, any[]>();
        rows.forEach((r) => {
          const arr = byChat.get(r.chatId) ?? [];
          arr.push(r);
          byChat.set(r.chatId, arr);
        });
        for (const arr of byChat.values()) {
          arr.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
          await Promise.all(
            arr.map((r, i) =>
              tx.table('messages').update(r.id, {
                seq: i,
                createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
                attachments: r.experimental_attachments ?? r.attachments,
              }),
            ),
          );
        }
      });
  }
}

export const db = new ChatDatabase();

if (typeof window !== 'undefined') {
  db.on('versionchange', () => {
    db.close();
    window.location.reload();
  });
  db.on('blocked', () => {
    console.warn('[IndexedDB] Database operation was blocked by another open tab.');
  });
}

export { Dexie };
