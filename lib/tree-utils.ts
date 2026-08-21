import type { StoredMessage } from './db';

/* ------------------------------------------------------------------ */
/* Public Types                                                       */
/* ------------------------------------------------------------------ */

export interface SiblingResult {
  /**
   * Các node có cùng parentId với target message.
   *
   * Thứ tự được chuẩn hóa theo:
   * 1. branchOrder;
   * 2. createdAt;
   * 3. id.
   */
  siblings: StoredMessage[];

  /**
   * Index zero-based của target trong siblings.
   *
   * Ví dụ:
   * - phiên bản đầu tiên: 0
   * - phiên bản thứ hai: 1
   */
  currentIndex: number;

  /**
   * Tổng số siblings/versions.
   */
  total: number;
}

/* ------------------------------------------------------------------ */
/* Internal Helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * So sánh hai StoredMessage để tạo thứ tự branch ổn định.
 *
 * branchOrder được ưu tiên vì đây là thứ tự version trong cùng nhóm.
 * createdAt và id là fallback để kết quả deterministic kể cả khi
 * branchOrder chưa tồn tại trong dữ liệu cũ.
 */
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

/**
 * Trả về bản copy đã được sort.
 *
 * Không mutate array gốc và không mutate StoredMessage.
 */
function sortSiblings(
  messages: StoredMessage[],
): StoredMessage[] {
  return [...messages].sort(compareSiblingOrder);
}

/**
 * Lấy leaf fallback khi activeLeafId không tồn tại hoặc không hợp lệ.
 *
 * Ưu tiên:
 * 1. createdAt mới hơn;
 * 2. seq lớn hơn;
 * 3. id lớn hơn.
 *
 * Đây chỉ là fallback. Trong trạng thái bình thường, caller nên truyền
 * activeLeafId rõ ràng từ ChatSession.
 */
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

/**
 * Tái tạo active thread từ root tới active leaf.
 *
 * Ví dụ cây:
 *
 * u1
 * ├── a1
 * │   └── u2
 * └── a1-alt
 *     └── u2-alt
 *
 * reconstructActiveThread(allMessages, 'u2')
 * => [u1, a1, u2]
 *
 * reconstructActiveThread(allMessages, 'u2-alt')
 * => [u1, a1-alt, u2-alt]
 *
 * Độ phức tạp:
 * - tạo Map theo id: O(n)
 * - duyệt từ leaf lên root: O(h)
 *
 * Trong đó:
 * - n = tổng số message trong chat;
 * - h = chiều cao của active branch.
 */
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

  /**
   * Ưu tiên activeLeafId được truyền vào.
   * Nếu không tìm thấy, fallback về message mới nhất.
   */
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
    /**
     * Bảo vệ chống dữ liệu lỗi tạo thành cycle:
     *
     * A.parentId = B.id
     * B.parentId = A.id
     *
     * Nếu không có visited, vòng lặp sẽ không bao giờ kết thúc.
     */
    if (visited.has(current.id)) {
      console.warn(
        `[tree-utils] Phát hiện cycle tại message '${current.id}'.`,
      );
      break;
    }

    visited.add(current.id);
    reversedPath.push(current);

    /**
     * parentId === null nghĩa là đã tới root.
     */
    if (current.parentId === null) {
      break;
    }

    const parent = byId.get(current.parentId);

    /**
     * Nếu parent bị thiếu, trả về phần chain hợp lệ đã tìm được.
     * Không throw để tránh làm crash toàn bộ giao diện chat.
     */
    if (!parent) {
      console.warn(
        `[tree-utils] Không tìm thấy parent '${current.parentId}' ` +
          `của message '${current.id}'.`,
      );
      break;
    }

    current = parent;
  }

  /**
   * Vì quá trình duyệt đi từ leaf lên root nên cần reverse.
   */
  return reversedPath.reverse();
}

/* ------------------------------------------------------------------ */
/* getSiblings                                                        */
/* ------------------------------------------------------------------ */

/**
 * Lấy các node siblings của một message.
 *
 * Hai message được xem là siblings khi:
 *
 * - cùng chatId;
 * - cùng parentId.
 *
 * Root messages cũng là siblings nếu cả hai có:
 *
 * parentId === null
 *
 * Ví dụ:
 *
 * u1
 * ├── a1
 * └── a1-alt
 *
 * getSiblings(allMessages, 'a1-alt') trả về:
 *
 * {
 *   siblings: [a1, a1-alt],
 *   currentIndex: 1,
 *   total: 2
 * }
 */
export function getSiblings(
  allMessages: StoredMessage[],
  targetMessageId: string,
): SiblingResult {
  const target = allMessages.find(
    (message) => message.id === targetMessageId,
  );

  /**
   * Target không tồn tại.
   *
   * Trả về kết quả rỗng thay vì throw vì có thể xảy ra khi:
   * - tab khác vừa xóa chat;
   * - UI đang chuyển branch;
   * - dữ liệu đang được hydrate;
   * - message đã bị loại khỏi projection hiện tại.
   */
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

/**
 * Tìm node lá sâu nhất trong subtree bắt đầu tại startNodeId.
 *
 * Ví dụ:
 *
 * u1
 * ├── a1
 * │   └── u2
 * └── a1-alt
 *     └── u2-alt
 *
 * findDeepestLeafId(allMessages, 'a1-alt')
 * => 'u2-alt'
 *
 * Nếu startNodeId bản thân đã là leaf:
 *
 * findDeepestLeafId(allMessages, 'u2-alt')
 * => 'u2-alt'
 *
 * Khi có nhiều leaf cùng độ sâu, thứ tự ưu tiên là:
 *
 * 1. branchOrder;
 * 2. createdAt;
 * 3. id.
 */
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

  /**
   * Index children theo parentId để tránh phải filter toàn bộ
   * danh sách ở mỗi lần đệ quy.
   */
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

  /**
   * Chuẩn hóa thứ tự children của từng parent.
   */
  for (const [parentId, children] of childrenByParent) {
    childrenByParent.set(
      parentId,
      sortSiblings(children),
    );
  }

  let deepestLeafId = startNode.id;
  let deepestDepth = 0;

  /**
   * Bảo vệ chống cycle trong dữ liệu.
   */
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

    /**
     * Không có children => node hiện tại là leaf.
     */
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
/* Optional Utility Functions                                         */
/* ------------------------------------------------------------------ */

/**
 * Lấy danh sách children trực tiếp của một parent.
 *
 * Hàm này không bắt buộc cho Giai đoạn 1,
 * nhưng hữu ích cho các phase UI và branch navigation sau này.
 */
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

/**
 * Kiểm tra một node có phải leaf hay không.
 */
export function isLeaf(
  allMessages: StoredMessage[],
  messageId: string,
): boolean {
  return !allMessages.some(
    (message) => message.parentId === messageId,
  );
}
