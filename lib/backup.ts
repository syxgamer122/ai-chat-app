import { db, type ChatSession, type StoredMessage } from '@/lib/db';
import { tokenize } from '@/lib/search-utils';

export const BACKUP_FORMAT = 'ai-chat-backup';
export const BACKUP_VERSION = 1;

export interface SerializedAttachment {
  name: string;
  contentType: string;
  url?: string;
  /** base64 (không có tiền tố data:) */
  data?: string;
}

export type SerializedMessage = Omit<StoredMessage, 'attachments' | 'tokens'> & {
  attachments?: SerializedAttachment[];
};

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  app: string;
  chats: ChatSession[];
  messages: SerializedMessage[];
}

export type ImportMode = 'merge' | 'duplicate' | 'overwrite';

export interface ImportStats {
  chatsAdded: number;
  chatsSkipped: number;
  messagesAdded: number;
  mode: ImportMode;
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBlob(data: string, contentType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

function safeFileName(text: string, fallback = 'chat'): string {
  const cleaned = (text || fallback)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/^-|-$/g, '');
  return cleaned || fallback;
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ------------------------------------------------------------------ */
/* Export                                                             */
/* ------------------------------------------------------------------ */

async function serializeMessage(
  msg: StoredMessage,
  includeAttachments: boolean,
): Promise<SerializedMessage> {
  const { attachments, tokens, ...rest } = msg;
  if (!attachments?.length) return rest;

  const serialized: SerializedAttachment[] = [];
  for (const att of attachments) {
    const entry: SerializedAttachment = {
      name: att.name,
      contentType: att.contentType,
      url: att.url,
    };
    if (includeAttachments && att.blob && att.blob.size <= MAX_ATTACHMENT_BYTES) {
      try {
        entry.data = await blobToBase64(att.blob);
      } catch (err) {
        console.error('[backup] không encode được attachment', att.name, err);
      }
    }
    serialized.push(entry);
  }
  return { ...rest, attachments: serialized };
}

/** Tạo object backup cho toàn bộ DB, hoặc chỉ các chatId chỉ định. */
export async function createBackup(
  chatIds?: string[],
  options: { includeAttachments?: boolean } = {},
): Promise<BackupFile> {
  const includeAttachments = options.includeAttachments ?? true;

  const chats = chatIds?.length
    ? ((await db.chats.bulkGet(chatIds)).filter(Boolean) as ChatSession[])
    : await db.chats.orderBy('updatedAt').toArray();

  const rawMessages = chatIds?.length
    ? await db.messages.where('chatId').anyOf(chatIds).toArray()
    : await db.messages.toArray();

  rawMessages.sort((a, b) => a.chatId.localeCompare(b.chatId) || a.seq - b.seq);

  const messages: SerializedMessage[] = [];
  for (const msg of rawMessages) {
    messages.push(await serializeMessage(msg, includeAttachments));
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    app: 'ai-chat',
    chats,
    messages,
  };
}

export async function exportJson(chatIds?: string[]): Promise<void> {
  const backup = await createBackup(chatIds);
  const single = chatIds?.length === 1 ? backup.chats[0] : null;
  const name = single
    ? `chat-${safeFileName(single.title)}-${stamp()}.json`
    : `ai-chat-backup-${stamp()}.json`;

  downloadBlob(
    name,
    new Blob([JSON.stringify(backup, null, 2)], {
      type: 'application/json;charset=utf-8',
    }),
  );
}

/* ---------------- Markdown ---------------- */

/** Lấy đường active từ activeLeafId leo lên root; fallback: nhánh sâu nhất. */
export function resolveActivePath(
  chat: ChatSession,
  messages: StoredMessage[],
): StoredMessage[] {
  const byId = new Map(messages.map((m) => [m.id, m]));

  let leaf: StoredMessage | undefined =
    chat.activeLeafId ? byId.get(chat.activeLeafId) : undefined;

  if (!leaf) {
    const childCount = new Map<string, number>();
    for (const m of messages) {
      if (m.parentId) childCount.set(m.parentId, (childCount.get(m.parentId) ?? 0) + 1);
    }
    const leaves = messages.filter((m) => !childCount.has(m.id));
    leaf = leaves.sort((a, b) => b.seq - a.seq)[0];
  }

  const path: StoredMessage[] = [];
  const guard = new Set<string>();
  let cursor: StoredMessage | undefined = leaf;
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }

  return path.reverse();
}

const ROLE_LABEL: Record<string, string> = {
  user: '🧑 Bạn',
  assistant: '🤖 Trợ lý',
  system: '⚙️ System',
  data: '📦 Data',
};

export function chatToMarkdown(
  chat: ChatSession,
  messages: StoredMessage[],
): string {
  const path = resolveActivePath(chat, messages);
  const fmt = (ts: number) => new Date(ts).toLocaleString('vi-VN');

  const lines: string[] = [
    `# ${chat.title || 'Cuộc trò chuyện không tiêu đề'}`,
    '',
    `- **Tạo lúc:** ${fmt(chat.createdAt)}`,
    `- **Cập nhật:** ${fmt(chat.updatedAt)}`,
    `- **Tổng tin nhắn (mọi nhánh):** ${messages.length}`,
    `- **Tin nhắn trên nhánh đang xem:** ${path.length}`,
    '',
    '---',
    '',
  ];

  for (const msg of path) {
    lines.push(`### ${ROLE_LABEL[msg.role] ?? msg.role}`);
    lines.push('');
    lines.push((msg.content ?? '').trim() || '_(trống)_');
    lines.push('');

    if (msg.attachments?.length) {
      lines.push(`**Tệp kèm:** ${msg.attachments.map((a) => a.name).join(', ')}`);
      lines.push('');
    }
    if ((msg.siblingCount ?? 1) > 1) {
      lines.push(
        `> _Tin nhắn này có ${msg.siblingCount} biến thể; đây là biến thể ${(msg.siblingIndex ?? 0) + 1}. Dùng bản .json để lưu đầy đủ mọi nhánh._`,
      );
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

export async function exportMarkdown(chatIds?: string[]): Promise<void> {
  const chats = chatIds?.length
    ? ((await db.chats.bulkGet(chatIds)).filter(Boolean) as ChatSession[])
    : await db.chats.orderBy('updatedAt').reverse().toArray();

  if (chats.length === 0) throw new Error('Không có cuộc trò chuyện nào để xuất.');

  const parts: string[] = [];
  for (const chat of chats) {
    const messages = await db.messages.where('chatId').equals(chat.id).sortBy('seq');
    parts.push(chatToMarkdown(chat, messages));
  }

  const content =
    chats.length === 1
      ? parts[0]
      : `# Sao lưu AI Chat\n\n_Xuất lúc ${new Date().toLocaleString('vi-VN')} — ${chats.length} cuộc trò chuyện._\n\n---\n\n${parts.join('\n\n')}`;

  const name =
    chats.length === 1
      ? `chat-${safeFileName(chats[0].title)}-${stamp()}.md`
      : `ai-chat-backup-${stamp()}.md`;

  downloadBlob(name, new Blob([content], { type: 'text/markdown;charset=utf-8' }));
}

/* ------------------------------------------------------------------ */
/* Import                                                             */
/* ------------------------------------------------------------------ */

function parseBackup(text: string): BackupFile {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Tệp không phải JSON hợp lệ.');
  }
  if (!parsed || parsed.format !== BACKUP_FORMAT) {
    throw new Error('Không đúng định dạng sao lưu của ứng dụng.');
  }
  if (!Array.isArray(parsed.chats) || !Array.isArray(parsed.messages)) {
    throw new Error('Tệp sao lưu thiếu dữ liệu chats/messages.');
  }
  if (parsed.version > BACKUP_VERSION) {
    throw new Error(
      `Tệp được tạo bởi phiên bản mới hơn (v${parsed.version}). Hãy cập nhật ứng dụng.`,
    );
  }
  return parsed as BackupFile;
}

function deserializeMessage(msg: SerializedMessage): StoredMessage {
  const { attachments, ...rest } = msg;
  const restored: StoredMessage = {
    ...rest,
    tokens: tokenize(rest.content ?? ''),
  };

  if (attachments?.length) {
    restored.attachments = attachments.map((att) => ({
      name: att.name,
      contentType: att.contentType,
      url: att.url,
      blob: att.data ? base64ToBlob(att.data, att.contentType) : undefined,
    }));
  }
  return restored;
}

/**
 * Nạp backup vào Dexie, giữ nguyên cấu trúc cây.
 * - merge: bỏ qua chat đã tồn tại (import lại cùng tệp không sinh bản trùng)
 * - duplicate: luôn tạo bản mới với ID mới (remap parentId/activeLeafId)
 * - overwrite: xoá sạch DB rồi nạp lại nguyên trạng
 */
export async function importBackup(
  file: File,
  mode: ImportMode = 'merge',
): Promise<ImportStats> {
  const backup = parseBackup(await file.text());

  const messagesByChat = new Map<string, SerializedMessage[]>();
  for (const msg of backup.messages) {
    const list = messagesByChat.get(msg.chatId);
    if (list) list.push(msg);
    else messagesByChat.set(msg.chatId, [msg]);
  }

  const stats: ImportStats = {
    chatsAdded: 0,
    chatsSkipped: 0,
    messagesAdded: 0,
    mode,
  };

  await db.transaction('rw', db.chats, db.messages, async () => {
    if (mode === 'overwrite') {
      await db.messages.clear();
      await db.chats.clear();
    }

    const existingIds = new Set(
      mode === 'merge' ? await db.chats.toCollection().primaryKeys() : [],
    );

    for (const chat of backup.chats) {
      const sourceMessages = messagesByChat.get(chat.id) ?? [];

      if (mode === 'merge' && existingIds.has(chat.id)) {
        stats.chatsSkipped += 1;
        continue;
      }

      if (mode === 'duplicate') {
        const idMap = new Map<string, string>();
        for (const msg of sourceMessages) idMap.set(msg.id, newId());
        const newChatId = newId();

        const remapped = sourceMessages.map((msg) => {
          const restored = deserializeMessage(msg);
          return {
            ...restored,
            id: idMap.get(msg.id)!,
            chatId: newChatId,
            parentId: msg.parentId ? idMap.get(msg.parentId) ?? null : null,
          } satisfies StoredMessage;
        });

        await db.chats.put({
          ...chat,
          id: newChatId,
          title: `${chat.title} (bản nhập)`,
          activeLeafId: chat.activeLeafId ? idMap.get(chat.activeLeafId) : undefined,
          activeLease: null,
          updatedAt: Date.now(),
        });
        await db.messages.bulkPut(remapped);

        stats.chatsAdded += 1;
        stats.messagesAdded += remapped.length;
        continue;
      }

      // merge (chat mới) hoặc overwrite → giữ nguyên ID
      await db.chats.put({ ...chat, activeLease: null });
      const restored = sourceMessages.map(deserializeMessage);
      await db.messages.bulkPut(restored);

      stats.chatsAdded += 1;
      stats.messagesAdded += restored.length;
    }
  });

  return stats;
}
