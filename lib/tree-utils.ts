import type { StoredMessage } from './db';

/**
 * Sentinel cũ của cây (thời BranchSelection). Chấp nhận thêm khi đọc để không
 * mất dữ liệu legacy; sentinel chính thức hiện nay là '__ROOT__' (lib/db.ts).
 */
const LEGACY_ROOT_KEY = '\u0000root';

interface TreeIndex {
  byId: Map<string, StoredMessage>;
  /** key === null nghĩa là cấp root. */
  children: Map<string | null, StoredMessage[]>;
  /** Cha *hiệu dụng*: orphan (cha đã bị xoá) được quy về null. */
  parentOf: Map<string, string | null>;
  /** Các node bị mất cha — hữu ích để UI cảnh báo dữ liệu khuyết. */
  orphans: Set<string>;
}

function rawParentId(m: StoredMessage): string | null {
  if (m.parentId == null || m.parentId === '__ROOT__' || m.parentId === LEGACY_ROOT_KEY) return null;
  return m.parentId;
}

/** So sánh nhị phân, deterministic trên mọi runtime — thay cho localeCompare. */
function cmpId(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareSiblingOrder(a: StoredMessage, b: StoredMessage): number {
  const oa = typeof a.branchOrder === 'number' ? a.branchOrder : Number.MAX_SAFE_INTEGER;
  const ob = typeof b.branchOrder === 'number' ? b.branchOrder : Number.MAX_SAFE_INTEGER;
  if (oa !== ob) return oa - ob;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  const sa = typeof a.seq === 'number' ? a.seq : -1;
  const sb = typeof b.seq === 'number' ? b.seq : -1;
  if (sa !== sb) return sa - sb;
  return cmpId(a.branchTieBreaker ?? a.id, b.branchTieBreaker ?? b.id);
}

function sortSiblings(messages: StoredMessage[]): StoredMessage[] {
  return [...messages].sort(compareSiblingOrder);
}

function chatIdOf(m: StoredMessage): string | undefined {
  return (m.chatId ?? (m as unknown as { conversationId?: string }).conversationId) || undefined;
}

function buildTreeIndex(
  allMessages: StoredMessage[],
  conversationId?: string,
): TreeIndex {
  const scoped = conversationId
    ? allMessages.filter((m) => chatIdOf(m) === conversationId)
    : allMessages;

  const byId = new Map<string, StoredMessage>();
  for (const m of scoped) byId.set(m.id, m);

  const parentOf = new Map<string, string | null>();
  const orphans = new Set<string>();
  const children = new Map<string | null, StoredMessage[]>();

  for (const m of scoped) {
    const raw = rawParentId(m);
    const detached = raw !== null && !byId.has(raw);
    if (detached) orphans.add(m.id);
    const effective = detached ? null : raw;

    parentOf.set(m.id, effective);
    const list = children.get(effective);
    if (list) list.push(m);
    else children.set(effective, [m]);
  }

  for (const [key, list] of children) children.set(key, sortSiblings(list));

  return { byId, children, parentOf, orphans };
}

/* -------------------------------------------------------------------------- */
/* Facade có cache — tránh build lại index mỗi render                          */
/* -------------------------------------------------------------------------- */

const indexCache = new WeakMap<StoredMessage[], Map<string, TreeIndex>>();

function getTreeIndex(
  allMessages: StoredMessage[],
  conversationId?: string,
): TreeIndex {
  let perScope = indexCache.get(allMessages);
  if (!perScope) {
    perScope = new Map();
    indexCache.set(allMessages, perScope);
  }
  const key = conversationId ?? '*';
  const hit = perScope.get(key);
  if (hit) return hit;
  const built = buildTreeIndex(allMessages, conversationId);
  perScope.set(key, built);
  return built;
}

function resolveIndex(indexOrMessages: TreeIndex | StoredMessage[], conversationId?: string): TreeIndex {
  if (Array.isArray(indexOrMessages)) {
    return getTreeIndex(indexOrMessages, conversationId);
  }
  return indexOrMessages;
}

/* -------------------------------------------------------------------------- */
/* Thread reconstruction                                                       */
/* -------------------------------------------------------------------------- */

export interface ThreadResult {
  messages: StoredMessage[];
  /** true chỉ khi cấu trúc thực sự hỏng (cycle / node biến mất giữa lúc đọc). */
  broken: boolean;
  brokenNodeId?: string;
  usedFallback: boolean;
  /** Node gốc của thread là orphan (cha đã bị xoá) — dữ liệu khuyết nhưng đọc được. */
  detachedRootId?: string;
}

/**
 * Đi xuống từ node, luôn chọn sibling cuối cùng.
 * Đây là ĐỊNH NGHĨA của "nhánh đang hoạt động" khi thiếu activeLeafId.
 */
function findLeafFrom(
  indexOrMessages: TreeIndex | StoredMessage[],
  fromNodeId: string,
): string {
  const index = resolveIndex(indexOrMessages);
  if (!index.byId.has(fromNodeId)) return fromNodeId;

  let cursor = fromNodeId;
  const visited = new Set<string>();

  while (!visited.has(cursor)) {
    visited.add(cursor);
    const kids = index.children.get(cursor);
    if (!kids || kids.length === 0) return cursor;

    const next = kids[kids.length - 1];
    if (visited.has(next.id)) return cursor;
    cursor = next.id;
  }
  return cursor;
}

/** Root cuối cùng (mới nhất) — điểm xuất phát của fallback thread. */
function findActiveRootId(index: TreeIndex): string | undefined {
  const roots = index.children.get(null) ?? [];
  if (roots.length === 0) return undefined;
  return roots[roots.length - 1].id;
}

function findFallbackLeafId(index: TreeIndex): string | undefined {
  const rootId = findActiveRootId(index);
  if (!rootId) return undefined;
  return findLeafFrom(index, rootId);
}

function reconstructThread(
  indexOrMessages: TreeIndex | StoredMessage[],
  activeLeafId?: string | null,
): ThreadResult {
  const index = resolveIndex(indexOrMessages);
  if (index.byId.size === 0) {
    return { messages: [], broken: false, usedFallback: false };
  }

  let usedFallback = false;
  let startId = activeLeafId ?? undefined;
  if (!startId || !index.byId.has(startId)) {
    startId = findFallbackLeafId(index);
    usedFallback = true;
  }
  if (!startId) return { messages: [], broken: true, usedFallback: true };

  const reversed: StoredMessage[] = [];
  const visited = new Set<string>();
  let cursor: string | null = startId;
  let broken = false;
  let brokenNodeId: string | undefined;
  let detachedRootId: string | undefined;

  while (cursor != null) {
    if (visited.has(cursor)) {
      broken = true;
      brokenNodeId = cursor;
      break;
    }
    visited.add(cursor);

    const node = index.byId.get(cursor);
    if (!node) {
      broken = true;
      brokenNodeId = cursor;
      break;
    }
    reversed.push(node);

    if (index.orphans.has(cursor)) detachedRootId = cursor;
    cursor = index.parentOf.get(cursor) ?? null;
  }

  return { messages: reversed.reverse(), broken, brokenNodeId, usedFallback, detachedRootId };
}

/* -------------------------------------------------------------------------- */
/* Siblings & branch switching                                                 */
/* -------------------------------------------------------------------------- */

export interface SiblingResult {
  siblings: StoredMessage[];
  currentIndex: number;
  total: number;
}

/**
 * parentId là tùy chọn và chỉ dùng làm gợi ý — nguồn chân lý là index.parentOf,
 * nhờ vậy orphan vẫn hiện đúng badge nhánh.
 */
export function getSiblings(
  indexOrMessages: TreeIndex | StoredMessage[],
  parentIdHintOrCurrentId?: string | null,
  currentIdOrNothing?: string,
): SiblingResult {
  const index = resolveIndex(indexOrMessages);
  const currentId = currentIdOrNothing ?? (parentIdHintOrCurrentId as string);
  const _parentIdHint = currentIdOrNothing ? parentIdHintOrCurrentId : undefined;

  const key = index.parentOf.has(currentId)
    ? (index.parentOf.get(currentId) as string | null)
    : (_parentIdHint ?? null);
  const siblings = index.children.get(key) ?? [];
  return {
    siblings,
    currentIndex: siblings.findIndex((m) => m.id === currentId),
    total: siblings.length,
  };
}

export function reconstructActiveThreadSafe(
  allMessages: StoredMessage[],
  leafId: string | null | undefined,
  conversationId?: string,
): ThreadResult {
  return reconstructThread(getTreeIndex(allMessages, conversationId), leafId);
}

export function reconstructActiveThread(
  allMessages: StoredMessage[],
  activeLeafId?: string,
): StoredMessage[] {
  return reconstructThread(getTreeIndex(allMessages), activeLeafId).messages;
}

export function findDeepestLeafId(allMessages: StoredMessage[], fromNodeId: string): string {
  return findLeafFrom(getTreeIndex(allMessages), fromNodeId);
}
