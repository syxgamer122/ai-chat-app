import type { StoredMessage } from './db';

/* ------------------------------------------------------------------ */
/* Public Types                                                       */
/* ------------------------------------------------------------------ */

export interface SiblingResult {
  siblings: StoredMessage[];
  currentIndex: number;
  total: number;
}

/* ------------------------------------------------------------------ */
/* Internal Helpers                                                    */
/* ------------------------------------------------------------------ */

function compareSiblingOrder(
  a: StoredMessage,
  b: StoredMessage,
): number {
  const branchOrderA =
    typeof a.branchOrder === 'number'
      ? a.branchOrder
      : Number.MAX_SAFE_INTEGER;

  const branchOrderB =
    typeof b.branchOrder === 'number'
      ? b.branchOrder
      : Number.MAX_SAFE_INTEGER;

  if (branchOrderA !== branchOrderB) {
    return branchOrderA - branchOrderB;
  }

  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }

  return a.id.localeCompare(b.id);
}

function sortSiblings(
  messages: StoredMessage[],
): StoredMessage[] {
  return [...messages].sort(compareSiblingOrder);
}

function findFallbackLeaf(
  allMessages: StoredMessage[],
): StoredMessage | undefined {
  if (allMessages.length === 0) {
    return undefined;
  }

  return [...allMessages].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return b.createdAt - a.createdAt;
    }

    if (a.seq !== b.seq) {
      return b.seq - a.seq;
    }

    return b.id.localeCompare(a.id);
  })[0];
}

/* ------------------------------------------------------------------ */
/* reconstructActiveThread                                            */
/* ------------------------------------------------------------------ */

export function reconstructActiveThread(
  allMessages: StoredMessage[],
  activeLeafId?: string,
): StoredMessage[] {
  if (allMessages.length === 0) {
    return [];
  }

  const byId = new Map<string, StoredMessage>();

  for (const message of allMessages) {
    byId.set(message.id, message);
  }

  let current =
    (activeLeafId
      ? byId.get(activeLeafId)
      : undefined) ??
    findFallbackLeaf(allMessages);

  if (!current) {
    return [];
  }

  const reversedPath: StoredMessage[] = [];
  const visited = new Set<string>();

  while (current) {
    if (visited.has(current.id)) {
      console.warn(
        `[tree-utils] Phát hiện cycle tại message '${current.id}'.`,
      );
      break;
    }

    visited.add(current.id);
    reversedPath.push(current);

    if (current.parentId === null) {
      break;
    }

    const parent = byId.get(current.parentId);

    if (!parent) {
      console.warn(
        `[tree-utils] Không tìm thấy parent '${current.parentId}' ` +
          `của message '${current.id}'.`,
      );
      break;
    }

    current = parent;
  }

  return reversedPath.reverse();
}

/* ------------------------------------------------------------------ */
/* getSiblings                                                        */
/* ------------------------------------------------------------------ */

export function getSiblings(
  allMessages: StoredMessage[],
  targetMessageId: string,
): SiblingResult {
  const target = allMessages.find(
    (message) => message.id === targetMessageId,
  );

  if (!target) {
    return {
      siblings: [],
      currentIndex: -1,
      total: 0,
    };
  }

  const siblings = sortSiblings(
    allMessages.filter(
      (message) =>
        message.chatId === target.chatId &&
        message.parentId === target.parentId,
    ),
  );

  const currentIndex = siblings.findIndex(
    (message) => message.id === targetMessageId,
  );

  return {
    siblings,
    currentIndex,
    total: siblings.length,
  };
}

/* ------------------------------------------------------------------ */
/* findDeepestLeafId                                                  */
/* ------------------------------------------------------------------ */

export function findDeepestLeafId(
  allMessages: StoredMessage[],
  startNodeId: string,
): string | undefined {
  const startNode = allMessages.find(
    (message) => message.id === startNodeId,
  );

  if (!startNode) {
    return undefined;
  }

  const childrenByParent = new Map<
    string,
    StoredMessage[]
  >();

  for (const message of allMessages) {
    if (message.parentId === null) {
      continue;
    }

    const children =
      childrenByParent.get(message.parentId) ?? [];

    children.push(message);
    childrenByParent.set(message.parentId, children);
  }

  for (const [parentId, children] of childrenByParent) {
    childrenByParent.set(
      parentId,
      sortSiblings(children),
    );
  }

  let deepestLeafId = startNode.id;
  let deepestDepth = 0;

  const visited = new Set<string>();

  function visit(
    nodeId: string,
    depth: number,
  ): void {
    if (visited.has(nodeId)) {
      console.warn(
        `[tree-utils] Phát hiện cycle khi tìm leaf tại '${nodeId}'.`,
      );
      return;
    }

    visited.add(nodeId);

    const children =
      childrenByParent.get(nodeId) ?? [];

    if (children.length === 0) {
      if (depth > deepestDepth) {
        deepestDepth = depth;
        deepestLeafId = nodeId;
      }

      return;
    }

    for (const child of children) {
      visit(child.id, depth + 1);
    }
  }

  visit(startNode.id, 0);

  return deepestLeafId;
}

/* ------------------------------------------------------------------ */
/* Optional Helpers                                                    */
/* ------------------------------------------------------------------ */

export function getChildren(
  allMessages: StoredMessage[],
  parentId: string | null,
): StoredMessage[] {
  return sortSiblings(
    allMessages.filter(
      (message) => message.parentId === parentId,
    ),
  );
}

export function isLeaf(
  allMessages: StoredMessage[],
  messageId: string,
): boolean {
  return !allMessages.some(
    (message) => message.parentId === messageId,
  );
}
