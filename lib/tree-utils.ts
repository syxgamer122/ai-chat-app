import type { StoredMessage } from './db';

/* ------------------------------------------------------------------ */
/* Pure Tree Traversal Utilities for Message Branching                */
/* ------------------------------------------------------------------ */

export interface SiblingInfo {
  siblings: StoredMessage[];
  currentIndex: number;
  total: number;
  prevSiblingId?: string;
  nextSiblingId?: string;
}

/**
 * Sắp xếp các node sibling theo branchOrder hoặc createdAt.
 */
export function sortSiblings(siblings: StoredMessage[]): StoredMessage[] {
  return [...siblings].sort((a, b) => {
    if (typeof a.branchOrder === 'number' && typeof b.branchOrder === 'number') {
      if (a.branchOrder !== b.branchOrder) {
        return a.branchOrder - b.branchOrder;
      }
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Xây dựng bản đồ quan hệ cha - con (parentId -> children[]) trong bộ nhớ.
 */
export function buildChildrenMap(
  allMessages: StoredMessage[],
): Map<string | null, StoredMessage[]> {
  const map = new Map<string | null, StoredMessage[]>();

  for (const m of allMessages) {
    const parentId = m.parentId ?? null;
    const list = map.get(parentId) ?? [];
    list.push(m);
    map.set(parentId, list);
  }

  for (const [key, list] of map.entries()) {
    map.set(key, sortSiblings(list));
  }

  return map;
}

/**
 * Lấy thông tin các node anh chị em (siblings) cùng chia sẻ một parentId.
 */
export function getSiblings(
  allMessages: StoredMessage[],
  targetMessageId: string,
): SiblingInfo {
  const current = allMessages.find((m) => m.id === targetMessageId);
  if (!current) {
    return { siblings: [], currentIndex: 0, total: 0 };
  }

  const parentId = current.parentId ?? null;
  const rawSiblings = allMessages.filter(
    (m) => (m.parentId ?? null) === parentId,
  );

  const sortedSiblings = sortSiblings(rawSiblings);
  const currentIndex = sortedSiblings.findIndex((m) => m.id === targetMessageId);
  const safeIndex = Math.max(0, currentIndex);
  const total = sortedSiblings.length;

  return {
    siblings: sortedSiblings,
    currentIndex: safeIndex,
    total,
    prevSiblingId: safeIndex > 0 ? sortedSiblings[safeIndex - 1]?.id : undefined,
    nextSiblingId: safeIndex < total - 1 ? sortedSiblings[safeIndex + 1]?.id : undefined,
  };
}

/**
 * Tìm node lá (leaf node) sâu nhất bắt đầu từ một node con được chọn.
 * Khi người dùng bấm chuyển nhánh ở một node trung gian, hàm này giúp chọn nhánh con mới nhất đi kèm.
 */
export function findDeepestLeafId(
  allMessages: StoredMessage[],
  startNodeId: string,
): string {
  const childrenMap = buildChildrenMap(allMessages);
  let currentId = startNodeId;

  while (childrenMap.has(currentId)) {
    const children = childrenMap.get(currentId)!;
    if (!children.length) break;
    // Chọn node con mới nhất (ở cuối danh sách đã sort)
    currentId = children[children.length - 1].id;
  }

  return currentId;
}

/**
 * Tái cấu trúc chuỗi tin nhắn đang hoạt động (Active Thread) từ Root tới Leaf.
 *
 * @param allMessages Danh sách toàn bộ message trong một đoạn chat
 * @param activeLeafId ID của node lá đang được chọn trong ChatSession
 * @returns Danh sách tuyến tính Message[] sẵn sàng nạp vào useChat và Virtualizer
 */
export function reconstructActiveThread(
  allMessages: StoredMessage[],
  activeLeafId?: string,
): StoredMessage[] {
  if (!allMessages.length) return [];

  const messageMap = new Map<string, StoredMessage>(
    allMessages.map((m) => [m.id, m]),
  );

  // 1. Trường hợp có activeLeafId hợp lệ: Đi ngược từ leaf -> root bằng parentId
  if (activeLeafId && messageMap.has(activeLeafId)) {
    const thread: StoredMessage[] = [];
    const visited = new Set<string>();
    let curr: StoredMessage | undefined = messageMap.get(activeLeafId);

    while (curr) {
      if (visited.has(curr.id)) {
        // Phòng tránh vòng lặp vô tận nếu dữ liệu bị lỗi cyclic
        console.warn('[TreeUtils] Cyclic parentId detected at message:', curr.id);
        break;
      }
      visited.add(curr.id);
      thread.unshift(curr);
      curr = curr.parentId ? messageMap.get(curr.parentId) : undefined;
    }

    return thread;
  }

  // 2. Fallback: Đi xuôi từ root (parentId === null) và chọn nhánh con mới nhất
  const childrenMap: Map<string | null, StoredMessage[]> = buildChildrenMap(allMessages);
  const thread: StoredMessage[] = [];
  let currentParentId: string | null = null;
  const visited = new Set<string>();

  while (childrenMap.has(currentParentId)) {
    const childrenList: StoredMessage[] | undefined = childrenMap.get(currentParentId);
    if (!childrenList || childrenList.length === 0) break;

    const latestChild: StoredMessage = childrenList[childrenList.length - 1];
    if (visited.has(latestChild.id)) break;

    visited.add(latestChild.id);
    thread.push(latestChild);
    currentParentId = latestChild.id;
  }

  return thread;
}
