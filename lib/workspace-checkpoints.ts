/**
 * Workspace checkpoint — snapshot nội dung file TRƯỚC khi agent coding ghi
 * (fs_write/fs_edit đã qua diff-approval), cho phép hoàn tác 1 lượt sửa.
 *
 * Thiết kế port từ numasec/src/snapshot (git shadow worktree) về mô hình
 * browser local-first (Dexie, không có git):
 * - 1 snapshot / LƯỢT agent (turn): mọi file bị đụng trong cùng response
 *   gom về một bản ghi — first-wins per path (giữ trạng thái SỚM NHẤT).
 * - Rollback = ghi lại content cũ; file chưa tồn tại trước đó → XOÁ đi.
 * - Snapshot thiếu dữ liệu (file quá lớn/lỗi đọc) → incomplete → CHẶN
 *   rollback. numasec bỏ-im-lặng vì có git che; ở đây không có nên phải
 *   thắt chặt: restore nửa vời còn nguy hiểm hơn không restore.
 *
 * Hàm thuần (capture/undo-target/prune/plan) tách khỏi Dexie để unit-test
 * trong node như phần còn lại của lib/.
 */

import { db, type WorkspaceSnapshot, type WsSnapshotFile } from '@/lib/db';

/** Trần ký tự mỗi file đưa vào snapshot (text ≈ bytes với UTF-8 ASCII code). */
export const WS_MAX_FILE_BYTES = 512_000;
/** Trần số file mỗi turn — model fanning ra chục file là dấu hiệu mất kiểm soát. */
export const WS_MAX_FILES_PER_SNAPSHOT = 12;
/** Trần snapshot lưu mỗi chat — cũ nhất bị prune (ưu tiên bản đã undone). */
export const WS_MAX_SNAPSHOTS_PER_CHAT = 20;

/* ------------------------------------------------------------------ */
/* Capture trong turn                                                  */
/* ------------------------------------------------------------------ */

export type CaptureInput =
  | { status: 'ok'; path: string; content: string }
  | { status: 'missing'; path: string }
  | { status: 'too-large'; path: string }
  | { status: 'error'; path: string };

export interface TurnCapture {
  id: string;
  chatId: string;
  createdAt: number;
  files: WsSnapshotFile[];
  incomplete: boolean;
}

export function newTurnCapture(chatId: string, now: number = Date.now()): TurnCapture {
  return {
    id: newSnapshotId(now),
    chatId,
    createdAt: now,
    files: [],
    incomplete: false,
  };
}

function newSnapshotId(now: number): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `ws-${now}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Nhận kết quả đọc "trước khi ghi" vào turn đang mở. FIRST-WINS per path:
 * agent sửa A hai lần trong một turn thì rollback phải trả A về trạng thái
 * TRƯỚC lần sửa đầu, không phải giữa hai lần.
 */
export function captureFile(turn: TurnCapture, input: CaptureInput): void {
  if (turn.files.some((f) => f.path === input.path)) return;

  /* Trần số file mỗi snapshot: hằng số này TỪNG được khai báo nhưng không nơi
     nào áp, nên một lượt agent sửa hàng chục file sẽ nhồi cả đống nội dung
     vào một record IndexedDB. Vượt trần thì đánh dấu incomplete — rollback bị
     CHẶN, đúng nguyên tắc "restore nửa vời nguy hiểm hơn không restore".
     (Trần BYTE mỗi file đã được áp ở fsReadFull → status 'too-large'.) */
  if (turn.files.length >= WS_MAX_FILES_PER_SNAPSHOT) {
    turn.incomplete = true;
    return;
  }

  if (input.status === 'ok') {
    turn.files.push({ path: input.path, content: input.content, existedBefore: true });
    return;
  }
  if (input.status === 'missing') {
    // File agent tạo mới — rollback sẽ XÓA nó đi.
    turn.files.push({ path: input.path, content: '', existedBefore: false });
    return;
  }
  // too-large / error: không có dữ liệu trước đó → chặn rollback cả turn.
  turn.incomplete = true;
}

/** Đóng turn → bản ghi hoàn chỉnh để put vào DB (dùng id cấp từ đầu turn). */
export function captureToSnapshot(turn: TurnCapture): WorkspaceSnapshot {
  return {
    id: turn.id,
    chatId: turn.chatId,
    createdAt: turn.createdAt,
    files: [...turn.files],
    ...(turn.incomplete ? { incomplete: true } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Undo target & prune — thuần                                         */
/* ------------------------------------------------------------------ */

function byRecencyDesc(a: WorkspaceSnapshot, b: WorkspaceSnapshot): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Snapshot có thể hoàn tác = MỚI NHẤT trong số các bản active (chưa undone),
 * ĐỦ dữ liệu (!incomplete) và có ít nhất 1 file. LIFO: muốn undo bản cũ hơn
 * phải undo các bản mới hơn trước — nếu không state đĩa sẽ bị đè sai thứ tự.
 * Bản incomplete KHÔNG chặn LIFO (nó không restorable, nhưng cũng không đổi
 * đĩa theo cách ta biết được) — chỉ là lịch sử.
 */
export function getUndoTarget(snapshots: WorkspaceSnapshot[]): WorkspaceSnapshot | null {
  const candidates = snapshots
    .filter((s) => !s.undoneAt && !s.incomplete && s.files.length > 0)
    .sort(byRecencyDesc);
  return candidates[0] ?? null;
}

/**
 * Kế hoạch prune: giữ tối đa `max` bản MỚI NHẤT mỗi chat. Ưu tiên xoá bản đã
 * undone (vô giá trị vận hành) trước, rồi tới cũ nhất. Trả về danh sách id cần delete.
 */
export function prunePlan(
  allIncludingNew: WorkspaceSnapshot[],
  max: number = WS_MAX_SNAPSHOTS_PER_CHAT,
): string[] {
  if (allIncludingNew.length <= max) return [];
  const sorted = [...allIncludingNew].sort((a, b) => {
    const au = a.undoneAt ? 1 : 0;
    const bu = b.undoneAt ? 1 : 0;
    if (au !== bu) return bu - au; // undone (flag=1) đứng TRƯỚC
    return -byRecencyDesc(a, b); // cùng trạng thái → cũ nhất trước
  });
  return sorted.slice(0, allIncludingNew.length - max).map((s) => s.id);
}

export type RestoreOp =
  | { action: 'write'; path: string; content: string }
  | { action: 'delete'; path: string };

/** Kế hoạch thao tác đĩa cho 1 snapshot: existedBefore=false → delete. */
export function planRestore(snapshot: WorkspaceSnapshot): RestoreOp[] {
  return snapshot.files.map((f) =>
    f.existedBefore
      ? { action: 'write' as const, path: f.path, content: f.content }
      : { action: 'delete' as const, path: f.path },
  );
}

/* ------------------------------------------------------------------ */
/* Tầng DB mỏng                                                        */
/* ------------------------------------------------------------------ */

export async function listSnapshots(chatId: string): Promise<WorkspaceSnapshot[]> {
  try {
    return await db.wsSnapshots.where('chatId').equals(chatId).toArray();
  } catch {
    return [];
  }
}

/** Put snapshot của turn + prune trần ngay trong cùng transaction. */
export async function saveTurnCapture(turn: TurnCapture): Promise<WorkspaceSnapshot | null> {
  if (turn.files.length === 0) return null;
  const snapshot = captureToSnapshot(turn);
  try {
    await db.transaction('rw', db.wsSnapshots, async () => {
      await db.wsSnapshots.put(snapshot);
      const all = await db.wsSnapshots.where('chatId').equals(snapshot.chatId).toArray();
      const staleIds = prunePlan(all);
      if (staleIds.length) await db.wsSnapshots.bulkDelete(staleIds);
    });
    return snapshot;
  } catch {
    // Snapshot thất bại không được làm chết lượt ghi file — agent vẫn ghi,
    // chỉ là lần này không có điểm hoàn tác.
    return null;
  }
}

export async function markSnapshotUndone(id: string): Promise<void> {
  await db.wsSnapshots.update(id, { undoneAt: Date.now() });
}
