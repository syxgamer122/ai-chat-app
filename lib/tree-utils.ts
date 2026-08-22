import type { StoredMessage } from './db';

/**
 * Khóa sentinel đại diện "cấp root" trong BranchSelection.
 * Dùng ký tự NUL để không bao giờ trùng với id thật do Dexie/crypto sinh ra.
 */
export const ROOT_KEY = '\u0000root';

export interface TreeIndex {
  byId: Map<string, StoredMessage>;
  /** key === null nghĩa là cấp root. */
  children: Map<string | null, StoredMessage[]>;
  /** Cha *hiệu dụng*: orphan (cha đã bị xoá) được quy về null. */
  parentOf: Map<string, string | null>;
  /** Các node bị mất cha — hữu ích để UI cảnh báo dữ liệu khuyết. */
  orphans: Set<string>;
}

function rawParentId(m: StoredMessage): string | null {
  if (m.parentId == null || m.parentId === '__ROOT__' || m.parentId === ROOT_KEY) return null;
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

export function sortSiblings(messages: StoredMessage[]): StoredMessage[] {
  return [...messages].sort(compareSiblingOrder);
}

function chatIdOf(m: StoredMessage): string | undefined {
  return (m.chatId ?? (m as unknown as { conversationId?: string }).conversationId) || undefined;
}

export function buildTreeIndex(
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

export function getTreeIndex(
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

export type BranchSelection = Record<string, string>;

/**
 * Đi xuống theo selection; mặc định chọn sibling cuối cùng.
 * Đây là ĐỊNH NGHĨA DUY NHẤT của "nhánh đang hoạt động".
 */
export function findLeafFrom(
  indexOrMessages: TreeIndex | StoredMessage[],
  fromNodeId: string,
  selection: BranchSelection = {},
): string {
  const index = resolveIndex(indexOrMessages);
  if (!index.byId.has(fromNodeId)) return fromNodeId;

  let cursor = fromNodeId;
  const visited = new Set<string>();

  while (!visited.has(cursor)) {
    visited.add(cursor);
    const kids = index.children.get(cursor);
    if (!kids || kids.length === 0) return cursor;

    const preferredId = selection[cursor];
    const preferred = preferredId ? kids.find((k) => k.id === preferredId) : undefined;
    const next = preferred ?? kids[kids.length - 1];
    if (visited.has(next.id)) return cursor;
    cursor = next.id;
  }
  return cursor;
}

/** Root đang hoạt động: theo selection[ROOT_KEY], mặc định root cuối cùng. */
export function findActiveRootId(
  indexOrMessages: TreeIndex | StoredMessage[],
  selection: BranchSelection = {},
): string | undefined {
  const index = resolveIndex(indexOrMessages);
  const roots = index.children.get(null) ?? [];
  if (roots.length === 0) return undefined;
  const preferredId = selection[ROOT_KEY];
  const preferred = preferredId ? roots.find((r) => r.id === preferredId) : undefined;
  return (preferred ?? roots[roots.length - 1]).id;
}

/**
 * Fallback leaf dùng CÙNG quy tắc với findLeafFrom (sửa B3):
 * root hoạt động → đi xuống con cuối/con đã chọn.
 */
export function findFallbackLeafId(
  indexOrMessages: TreeIndex | StoredMessage[],
  selection: BranchSelection = {},
): string | undefined {
  const index = resolveIndex(indexOrMessages);
  const rootId = findActiveRootId(index, selection);
  if (!rootId) return undefined;
  return findLeafFrom(index, rootId, selection);
}

export function reconstructThread(
  indexOrMessages: TreeIndex | StoredMessage[],
  activeLeafId?: string | null,
  selection: BranchSelection = {},
): ThreadResult {
  const index = resolveIndex(indexOrMessages);
  if (index.byId.size === 0) {
    return { messages: [], broken: false, usedFallback: false };
  }

  let usedFallback = false;
  let startId = activeLeafId ?? undefined;
  if (!startId || !index.byId.has(startId)) {
    startId = findFallbackLeafId(index, selection);
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
 * nhờ vậy orphan vẫn hiện đúng badge nhánh (sửa B2).
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

/** Tiện cho UI: chỉ số 1-based, total. */
export function getBranchInfo(
  indexOrMessages: TreeIndex | StoredMessage[],
  nodeId: string,
): { index: number; total: number } {
  const { currentIndex, total } = getSiblings(indexOrMessages, undefined, nodeId);
  return { index: currentIndex + 1, total };
}

/** Bỏ các key trỏ tới node không còn tồn tại (sửa B5). */
export function pruneSelection(
  indexOrMessages: TreeIndex | StoredMessage[],
  selection: BranchSelection,
): BranchSelection {
  const index = resolveIndex(indexOrMessages);
  const out: BranchSelection = {};
  for (const [parent, child] of Object.entries(selection)) {
    if (!index.byId.has(child)) continue;
    if (parent === ROOT_KEY || index.byId.has(parent)) out[parent] = child;
  }
  return out;
}

export function switchBranch(
  indexOrMessages: TreeIndex | StoredMessage[],
  nodeId: string,
  direction: -1 | 1,
  selection: BranchSelection = {},
): { leafId: string; selection: BranchSelection } | null {
  const index = resolveIndex(indexOrMessages);
  const node = index.byId.get(nodeId);
  if (!node) return null;

  const parentKey = index.parentOf.get(nodeId) ?? null;
  const { siblings, currentIndex } = getSiblings(index, parentKey, nodeId);
  if (currentIndex < 0 || siblings.length <= 1) return null;

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= siblings.length) return null;

  const target = siblings[nextIndex];
  const nextSelection: BranchSelection = { ...selection };
  nextSelection[parentKey === null ? ROOT_KEY : parentKey] = target.id;

  const pruned = pruneSelection(index, nextSelection);
  return { leafId: findLeafFrom(index, target.id, pruned), selection: pruned };
}

/** Encode toàn bộ đường đi hiện tại, bao gồm cả lựa chọn root (sửa B1). */
export function selectionFromThread(messages: StoredMessage[]): BranchSelection {
  const sel: BranchSelection = {};
  if (messages.length === 0) return sel;
  sel[ROOT_KEY] = messages[0].id;
  for (let i = 1; i < messages.length; i += 1) {
    sel[messages[i - 1].id] = messages[i].id;
  }
  return sel;
}

export function reconstructActiveThreadSafe(
  allMessages: StoredMessage[],
  leafId: string | null | undefined,
  selection: BranchSelection = {},
  conversationId?: string,
): ThreadResult {
  return reconstructThread(getTreeIndex(allMessages, conversationId), leafId, selection);
}

/** @deprecated dùng getTreeIndex + reconstructThread */
export function reconstructActiveThread(
  allMessages: StoredMessage[],
  activeLeafId?: string,
): StoredMessage[] {
  return reconstructThread(getTreeIndex(allMessages), activeLeafId).messages;
}

/** @deprecated dùng getTreeIndex + findLeafFrom */
export function findDeepestLeafId(allMessages: StoredMessage[], fromNodeId: string): string {
  return findLeafFrom(getTreeIndex(allMessages), fromNodeId);
}