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

  const perChat = new Map<string, { hits: StoredMessage[]; score: number }>();
  let scanned = 0;

  for (const term of terms) {
    assertNotAborted(signal);
    const upper = term.slice(0, -1) + String.fromCharCode(term.charCodeAt(term.length - 1) + 1);

    await db.messages
      .where('tokens')
      .between(term, upper, true, false)
      .until(() => signal?.aborted === true)
      .each((m) => {
        const bucket = perChat.get(m.chatId) ?? { hits: [], score: 0 };
        if (bucket.hits.length < MAX_HITS_PER_CHAT) bucket.hits.push(m);
        bucket.score += 1;
        perChat.set(m.chatId, bucket);
        if (++scanned % YIELD_EVERY === 0) assertNotAborted(signal);
      });

    await db.chats
      .where('titleTokens')
      .between(term, upper, true, false)
      .until(() => signal?.aborted === true)
      .each((c) => {
        const bucket = perChat.get(c.id) ?? { hits: [], score: 0 };
        bucket.score += 5;
        perChat.set(c.id, bucket);
      });
  }

  assertNotAborted(signal);

  const ranked = [...perChat.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, MAX_CHATS);
  const chats = await db.chats.bulkGet(ranked.map(([id]) => id));
  assertNotAborted(signal);

  return ranked
    .map(([, bucket], i) => {
      const chat = chats[i];
      if (!chat) return null;
      return {
        chat,
        score: bucket.score,
        titleSegments: buildSnippet(chat.title, terms) ?? undefined,
        snippets: bucket.hits
          .map((h) => buildSnippet(h.content, terms))
          .filter((s): s is SnippetSegment[] => s !== null),
        extraHits: Math.max(0, bucket.score - bucket.hits.length),
      } satisfies ChatSearchResult;
    })
    .filter((r): r is ChatSearchResult => r !== null);
}