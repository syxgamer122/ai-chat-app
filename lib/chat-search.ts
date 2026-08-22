import { db, type ChatSession, type StoredMessage } from '@/lib/db';
import {
  buildHighlightSegments,
  buildSnippet,
  foldText,
  parseQueryTerms,
  type SnippetSegment,
} from '@/lib/search-utils';

export interface ChatSearchHit {
  messageId: string;
  role: StoredMessage['role'];
  createdAt: number;
  snippet: SnippetSegment[];
}

export interface ChatSearchResult {
  chat: ChatSession;
  titleMatch: boolean;
  titleSegments: SnippetSegment[];
  hits: ChatSearchHit[];
  totalHits: number;
  score: number;
}

const CANDIDATE_LIMIT = 600;      // trần cho truy vấn index
const SCAN_LIMIT = 300;           // trần cho lớp quét dự phòng
const SCAN_MAX_MESSAGES = 20_000; // trên mức này, không quét nữa
const MAX_RESULT_CHATS = 40;
const MAX_HITS_PER_CHAT = 3;

/** Cache nội dung đã fold, tránh fold lại mỗi lần gõ. */
const foldCache = new Map<string, string>();
const FOLD_CACHE_MAX = 3000;

function foldedContent(msg: StoredMessage): string {
  const key = `${msg.id}:${msg.content?.length ?? 0}`;
  const cached = foldCache.get(key);
  if (cached !== undefined) return cached;
  const folded = foldText(msg.content ?? '');
  if (foldCache.size >= FOLD_CACHE_MAX) foldCache.clear();
  foldCache.set(key, folded);
  return folded;
}

let messageCountCache: { value: number; at: number } | null = null;
async function cheapMessageCount(): Promise<number> {
  const now = Date.now();
  if (messageCountCache && now - messageCountCache.at < 30_000) {
    return messageCountCache.value;
  }
  const value = await db.messages.count();
  messageCountCache = { value, at: now };
  return value;
}

function matchesAllTerms(folded: string, terms: string[]): boolean {
  return terms.every((t) => folded.includes(t));
}

/**
 * Tìm kiếm kết hợp: tiêu đề chat (RAM) + nội dung tin nhắn (IndexedDB).
 * `chats` truyền từ useLiveQuery để không phải đọc lại bảng chats.
 */
export async function searchChats(
  rawQuery: string,
  chats: ChatSession[],
): Promise<ChatSearchResult[]> {
  const terms = parseQueryTerms(rawQuery);
  if (terms.length === 0) return [];

  const chatMap = new Map(chats.map((c) => [c.id, c]));

  /* ---------- 1. Khớp tiêu đề (đồng bộ, cực nhanh) ---------- */
  const titleMatched = new Set<string>();
  for (const chat of chats) {
    if (matchesAllTerms(foldText(chat.title ?? ''), terms)) titleMatched.add(chat.id);
  }

  /* ---------- 2. Ứng viên từ index *tokens ---------- */
  const anchor = terms[0]; // dài nhất
  let candidates: StoredMessage[] = [];

  if (anchor.length >= 2) {
    try {
      candidates = await db.messages
        .where('tokens')
        .startsWith(anchor)
        .distinct()
        .limit(CANDIDATE_LIMIT)
        .toArray();
    } catch (err) {
      console.error('[chat-search] token index query failed', err);
    }
  }

  const verified = candidates.filter((m) => matchesAllTerms(foldedContent(m), terms));

  /* ---------- 3. Lớp quét dự phòng (gõ giữa từ, token cũ) ---------- */
  const chatsFromIndex = new Set(verified.map((m) => m.chatId));
  const needScan = chatsFromIndex.size < 5 || anchor.length < 2;

  if (needScan && (await cheapMessageCount()) <= SCAN_MAX_MESSAGES) {
    const seen = new Set(verified.map((m) => m.id));
    try {
      const scanned = await db.messages
        .orderBy('createdAt')
        .reverse()
        .filter((m) => !seen.has(m.id) && matchesAllTerms(foldedContent(m), terms))
        .limit(SCAN_LIMIT)
        .toArray();
      verified.push(...scanned);
    } catch (err) {
      console.error('[chat-search] fallback scan failed', err);
    }
  }

  /* ---------- 4. Gom theo chat + tạo snippet ---------- */
  const grouped = new Map<string, { hits: ChatSearchHit[]; total: number }>();

  for (const msg of verified) {
    if (!chatMap.has(msg.chatId)) continue; // chat đã bị xoá
    let bucket = grouped.get(msg.chatId);
    if (!bucket) {
      bucket = { hits: [], total: 0 };
      grouped.set(msg.chatId, bucket);
    }
    bucket.total += 1;
    if (bucket.hits.length < MAX_HITS_PER_CHAT) {
      const snippet = buildSnippet(msg.content ?? '', terms);
      if (snippet) {
        bucket.hits.push({
          messageId: msg.id,
          role: msg.role,
          createdAt: msg.createdAt,
          snippet,
        });
      }
    }
  }

  /* ---------- 5. Hợp nhất + tính điểm ---------- */
  const results: ChatSearchResult[] = [];
  const chatIds = new Set<string>([...titleMatched, ...grouped.keys()]);

  for (const id of chatIds) {
    const chat = chatMap.get(id);
    if (!chat) continue;
    const bucket = grouped.get(id);
    const titleMatch = titleMatched.has(id);

    results.push({
      chat,
      titleMatch,
      titleSegments: buildHighlightSegments(chat.title ?? '', terms),
      hits: bucket?.hits.sort((a, b) => a.createdAt - b.createdAt) ?? [],
      totalHits: bucket?.total ?? 0,
      score:
        (titleMatch ? 1000 : 0) +
        (chat.pinned ? 200 : 0) +
        Math.min(bucket?.total ?? 0, 20) * 10,
    });
  }

  results.sort(
    (a, b) => b.score - a.score || b.chat.updatedAt - a.chat.updatedAt,
  );

  return results.slice(0, MAX_RESULT_CHATS);
}
