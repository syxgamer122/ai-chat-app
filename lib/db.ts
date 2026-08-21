import Dexie, { type Table } from 'dexie';
import { Message } from 'ai';

export interface ChatSession {
  id: string;
  title: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage extends Message {
  chatId: string;
}

export class ChatDatabase extends Dexie {
  chats!: Table<ChatSession, string>;
  messages!: Table<ChatMessage, string>;

  constructor() {
    super('AIChatDB');
    this.version(1).stores({
      chats: 'id, title, pinned, updatedAt',
      messages: 'id, chatId, createdAt'
    });
  }
}

export const db = new ChatDatabase();
