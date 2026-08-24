import { db, type ChatSession, type StoredMessage } from '@/lib/db';
import { tokenize, type SnippetSegment, buildSnippet } from '@/lib/search-utils';

export interface ChatSearchResult {
  chat: ChatSession;
  titleSegments?: SnippetSegment[];
  snippets?: SnippetSegment[][];
  extraHits?: number;
  score: number;
}

const MAX_CHATS = 40;
const MAX_HITS_PER_CHAT = 3;
const YIELD_EVERY = 200;

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

export async function searchChats(
  query: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ChatSearchResult[]> {
  const { signal } = opts;
  const terms = tokenize(query).filter(Boolean);
  if (!terms.length) return [];

  interface Bucket {
    hits: StoredMessage[];
    /** id đã gặp — 1 message khớp N term vẫn chỉ chiếm 1 slot snippet. */
    hitIds: Set<string>;
    /** Số message khớp (đếm theo term, không đếm title). */
    msgHits: number;
    /** Điểm từ tiêu đề (+5/term) — tách khỏi msgHits để đếm "còn lại" đúng. */
    titleHits: number;
  }

  const perChat = new Map<string, Bucket>();
  let scanned = 0;

  for (const term of terms) {
    assertNotAborted(signal);
    const upper = term.slice(0, -1) + String.fromCharCode(term.charCodeAt(term.length - 1) + 1);

    await db.messages
      .where('tokens')
      .between(term, upper, true, false)
      .until(() => signal?.aborted === true)
      .each((m) => {
        // Multi-entry index: 1 message chứa cả "hoa" lẫn "hoat" được yield
        // 2 lần cho term "hoa" — phải dedupe để snippet không lặp.
        const bucket = perChat.get(m.chatId) ?? {
          hits: [],
          hitIds: new Set<string>(),
          msgHits: 0,
          titleHits: 0,
        };
        if (!bucket.hitIds.has(m.id)) {
          bucket.hitIds.add(m.id);
          if (bucket.hits.length < MAX_HITS_PER_CHAT) bucket.hits.push(m);
        }
        bucket.msgHits += 1;
        perChat.set(m.chatId, bucket);
        if (++scanned % YIELD_EVERY === 0) assertNotAborted(signal);
      });

    await db.chats
      .where('titleTokens')
      .between(term, upper, true, false)
      .until(() => signal?.aborted === true)
      .each((c) => {
        const bucket = perChat.get(c.id) ?? {
          hits: [],
          hitIds: new Set<string>(),
          msgHits: 0,
          titleHits: 0,
        };
        bucket.titleHits += 5;
        perChat.set(c.id, bucket);
      });
  }

  assertNotAborted(signal);

  const ranked = [...perChat.entries()]
    .sort((a, b) => b[1].msgHits + b[1].titleHits - (a[1].msgHits + a[1].titleHits))
    .slice(0, MAX_CHATS);
  const chats = await db.chats.bulkGet(ranked.map(([id]) => id));
  assertNotAborted(signal);

  return ranked
    .map(([, bucket], i): ChatSearchResult | null => {
      const chat = chats[i];
      if (!chat) return null;
      const result: ChatSearchResult = {
        chat,
        score: bucket.msgHits + bucket.titleHits,
        snippets: bucket.hits
          .map((h) => buildSnippet(h.content, terms))
          .filter((s): s is SnippetSegment[] => s !== null),
        // Số message DUY NHẤT khớp — dùng cho "+N kết quả khác".
        extraHits: Math.max(0, bucket.hitIds.size - bucket.hits.length),
      };
      const titleSegments = buildSnippet(chat.title, terms);
      if (titleSegments) result.titleSegments = titleSegments;
      return result;
    })
    .filter((r): r is ChatSearchResult => r !== null);
}