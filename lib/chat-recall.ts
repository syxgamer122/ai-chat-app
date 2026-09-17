/**
 * ChatRecall — Tra cứu full-text trên toàn bộ lịch sử trò chuyện (P2-8).
 *
 * Tái sử dụng engine tokenize và foldText (chuẩn tiếng Việt không dấu/có dấu)
 * từ lib/search-utils.ts và searchChats từ lib/chat-search.ts.
 * Cung cấp cả đường chạy Dexie (trên browser/bridge) lẫn pure in-memory matcher
 * để unit test chạy tức thì không phụ thuộc IndexedDB.
 */

import { searchChats, type ChatSearchResult } from '@/lib/chat-search';
import { parseQueryTerms, foldText } from '@/lib/search-utils';

export interface ChatRecallItem {
  sessionId: string;
  title: string;
  snippet: string;
  matchedAt: string;
  score: number;
  workspacePath?: string;
}

export interface ChatRecallOptions {
  limit?: number;
  signal?: AbortSignal;
  searchFn?: (query: string, opts?: { signal?: AbortSignal }) => Promise<ChatSearchResult[]>;
}

export interface MemorySearchChat {
  id: string;
  title: string;
  updatedAt?: number;
  createdAt?: number;
  workspacePath?: string;
  messages?: Array<{ role: string; content: string }>;
}

/**
 * Tra cứu lịch sử hội thoại từ Dexie qua searchChats.
 * Trả về danh sách tối đa `limit` kết quả phù hợp nhất.
 */
export async function recallChatSessions(
  query: string,
  limit: number = 5,
  options: ChatRecallOptions = {},
): Promise<ChatRecallItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const maxResults = Math.max(1, Math.min(limit, 20));
  const search = options.searchFn ?? searchChats;

  const rawResults = await search(trimmed, { signal: options.signal });
  if (!rawResults || !rawResults.length) return [];

  const items: ChatRecallItem[] = [];

  for (const res of rawResults.slice(0, maxResults)) {
    let snippet = '';
    if (res.snippets && res.snippets.length > 0) {
      snippet = res.snippets[0].map((seg) => seg.text).join('').trim();
    }
    if (!snippet) {
      snippet = res.chat.title;
    }

    const dateMs = res.chat.updatedAt || res.chat.createdAt;
    const matchedAt = new Date(dateMs).toISOString();

    items.push({
      sessionId: res.chat.id,
      title: res.chat.title,
      snippet,
      matchedAt,
      score: res.score,
      ...(res.chat.workspacePath ? { workspacePath: res.chat.workspacePath } : {}),
    });
  }

  return items;
}

/**
 * Pure matcher cho danh sách chat trong bộ nhớ (dùng cho test hoặc CLI offline).
 * Hỗ trợ so khớp query tiếng Việt có dấu và không dấu hoàn chỉnh.
 */
export function recallFromMemoryList(
  chats: MemorySearchChat[],
  query: string,
  limit: number = 5,
): ChatRecallItem[] {
  const terms = parseQueryTerms(query);
  if (!terms.length) return [];

  interface ScoredChat {
    chat: MemorySearchChat;
    score: number;
    snippet: string;
  }

  const scored: ScoredChat[] = [];

  for (const c of chats) {
    let score = 0;
    let bestSnippet = '';

    // So khớp tiêu đề (+5 điểm mỗi term)
    const foldedTitle = foldText(c.title);
    for (const term of terms) {
      if (foldedTitle.includes(term)) {
        score += 5;
        if (!bestSnippet) bestSnippet = c.title;
      }
    }

    // So khớp tin nhắn (+1 điểm mỗi term)
    if (c.messages) {
      for (const m of c.messages) {
        const foldedContent = foldText(m.content);
        for (const term of terms) {
          if (foldedContent.includes(term)) {
            score += 1;
            if (!bestSnippet) {
              const idx = foldedContent.indexOf(term);
              const start = Math.max(0, idx - 40);
              const end = Math.min(m.content.length, idx + term.length + 80);
              bestSnippet =
                (start > 0 ? '...' : '') +
                m.content.slice(start, end).trim() +
                (end < m.content.length ? '...' : '');
            }
          }
        }
      }
    }

    if (score > 0) {
      scored.push({
        chat: c,
        score,
        snippet: bestSnippet || c.title,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, Math.max(1, Math.min(limit, 20))).map((s) => ({
    sessionId: s.chat.id,
    title: s.chat.title,
    snippet: s.snippet,
    matchedAt: new Date(s.chat.updatedAt || s.chat.createdAt || Date.now()).toISOString(),
    score: s.score,
    ...(s.chat.workspacePath ? { workspacePath: s.chat.workspacePath } : {}),
  }));
}
