/**
 * StorageFencing — Phân phối Fencing Token (Epoch-based) chống Split-Brain giữa các Tab.
 *
 * ## Vấn đề xử lý:
 * Khi Tab A (Leader) bị OS Sleep (gập laptop) hoặc gặp đợt Garbage Collection kéo dài > 5s,
 * Tab B (Observer) không nhận được heartbeat và thực hiện forceStealLock().
 * Khi Tab A thức giấc, trước khi nhận được tín hiệu abort hoặc FORCE_YIELD, Tab A có thể
 * cố gắng ghi đè dữ liệu cũ vào Storage.
 *
 * ## Cơ chế phòng vệ:
 * 1. Mỗi khi một Tab claim hoặc steal lock thành công, gọi `StorageFencing.bumpEpoch(chatId)`.
 * 2. Epoch mới (monotonically increasing timestamp) được lưu trữ vào storage (localStorage/Dexie).
 * 3. Mọi thao tác ghi dữ liệu từ AgentRuntimeActor đều phải gọi `StorageFencing.assertValidLeader(chatId)`.
 * 4. Nếu epoch của Tab thấp hơn epoch trong storage, ném `FencingConflictError` và từ chối ghi.
 */

export class FencingConflictError extends Error {
  public readonly chatId: string;
  public readonly currentEpoch: number;
  public readonly storageEpoch: number;

  constructor(chatId: string, currentEpoch: number, storageEpoch: number) {
    super(
      `[FENCING_CONFLICT] Tab hiện tại đã mất quyền Leader (Local Epoch: ${currentEpoch} < Storage Epoch: ${storageEpoch}). ` +
        `Thao tác ghi bị từ chối để chống Split-Brain corruption.`
    );
    this.name = 'FencingConflictError';
    this.chatId = chatId;
    this.currentEpoch = currentEpoch;
    this.storageEpoch = storageEpoch;
  }
}

export class StorageFencing {
  // Epoch hiện tại của tab này cho từng chatId
  private static localEpochs = new Map<string, number>();

  // Bộ nhớ đệm giả lập storage hoặc dùng IndexedDB/localStorage
  private static storageEpochs = new Map<string, number>();

  public static async bumpEpoch(chatId: string): Promise<number> {
    const nextEpoch = Date.now();
    this.storageEpochs.set(chatId, nextEpoch);
    this.localEpochs.set(chatId, nextEpoch);

    // Persist vào localStorage nếu khả dụng
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`vyen:fencing-epoch:${chatId}`, String(nextEpoch));
      } catch {}
    }

    return nextEpoch;
  }

  public static getLocalEpoch(chatId: string): number {
    return this.localEpochs.get(chatId) || 0;
  }

  public static setLocalEpoch(chatId: string, epoch: number): void {
    this.localEpochs.set(chatId, epoch);
  }

  public static async getStorageEpoch(chatId: string): Promise<number> {
    if (typeof localStorage !== 'undefined') {
      try {
        const stored = localStorage.getItem(`vyen:fencing-epoch:${chatId}`);
        if (stored) {
          const parsed = Number(stored);
          if (Number.isFinite(parsed)) {
            const memoryVal = this.storageEpochs.get(chatId) || 0;
            return Math.max(parsed, memoryVal);
          }
        }
      } catch {}
    }
    return this.storageEpochs.get(chatId) || 0;
  }

  public static async assertValidLeader(chatId: string): Promise<void> {
    const local = this.getLocalEpoch(chatId);
    const storage = await this.getStorageEpoch(chatId);

    // Nếu storage có epoch cao hơn local -> tab này là zombie leader cũ
    if (storage > local) {
      throw new FencingConflictError(chatId, local, storage);
    }
  }

  public static reset(chatId?: string): void {
    if (chatId) {
      this.localEpochs.delete(chatId);
      this.storageEpochs.delete(chatId);
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.removeItem(`vyen:fencing-epoch:${chatId}`);
        } catch {}
      }
    } else {
      this.localEpochs.clear();
      this.storageEpochs.clear();
    }
  }
}
