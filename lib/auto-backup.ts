import { db } from '@/lib/db';
import { createBackup } from '@/lib/backup';

/**
 * Auto-backup im lặng:
 * - Desktop Chrome/Edge: người dùng chọn 1 thư mục (File System Access API),
 *   handle lưu trong IndexedDB; đến kỳ thì ghi file .json ngầm không cần tương tác.
 * - Nền tảng khác: nhắc định kỳ bằng banner → bấm là xuất file download.
 */

const LAST_BACKUP_KEY = 'ai-chat-last-backup-at';
const SNOOZE_KEY = 'ai-chat-backup-snoozed-at';
const INTERVAL_KEY = 'ai-chat-backup-interval-days';
const DIR_HANDLE_KEY = 'backup-dir-handle';

export const DEFAULT_BACKUP_INTERVAL_DAYS = 7;

export const MIN_INTERVAL_DAYS = 1;
export const MAX_INTERVAL_DAYS = 90;

interface DirectoryPickerLike {
  name: string;
  queryPermission: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  getFileHandle: (
    name: string,
    o?: { create?: boolean },
  ) => Promise<{
    createWritable: () => Promise<{
      write: (data: string | BufferSource | Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
}

export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'showDirectoryPicker' in window &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
      'function'
  );
}

// ------------------------- Cài đặt (localStorage) -------------------------

export function getBackupIntervalDays(): number {
  if (typeof window === 'undefined') return DEFAULT_BACKUP_INTERVAL_DAYS;
  const raw = Number(window.localStorage.getItem(INTERVAL_KEY));
  if (!Number.isFinite(raw) || raw < MIN_INTERVAL_DAYS || raw > MAX_INTERVAL_DAYS) {
    return DEFAULT_BACKUP_INTERVAL_DAYS;
  }
  return Math.floor(raw);
}

export function setBackupIntervalDays(days: number): void {
  const clamped = Math.min(Math.max(Math.floor(days), MIN_INTERVAL_DAYS), MAX_INTERVAL_DAYS);
  window.localStorage.setItem(INTERVAL_KEY, String(clamped));
}

export function getLastBackupAt(): number | null {
  if (typeof window === 'undefined') return null;
  const raw = Number(window.localStorage.getItem(LAST_BACKUP_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

export function setLastBackupAt(ts = Date.now()): void {
  window.localStorage.setItem(LAST_BACKUP_KEY, String(ts));
  window.localStorage.removeItem(SNOOZE_KEY);
}

function getSnoozedAt(): number | null {
  const raw = Number(window.localStorage.getItem(SNOOZE_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

export function snoozeBackupReminder(days = 1): void {
  window.localStorage.setItem(SNOOZE_KEY, String(Date.now() + days * 86_400_000));
}

/** Pure — dễ test. */
export function isBackupDue(
  lastBackupAt: number | null,
  intervalDays: number,
  now = Date.now(),
): boolean {
  if (lastBackupAt === null || lastBackupAt <= 0) return true;
  return now - lastBackupAt >= intervalDays * 86_400_000;
}

/** Đến hạn VÀ không đang bị tạm hoãn. */
export function shouldShowReminder(now = Date.now()): boolean {
  if (!isBackupDue(getLastBackupAt(), getBackupIntervalDays(), now)) return false;
  const snoozed = getSnoozedAt();
  return !(snoozed !== null && snoozed > now);
}

// --------------------- Thư mục tự động (FSA - desktop) ---------------------

async function getStoredDirHandle(): Promise<DirectoryPickerLike | null> {
  const entry = await db.kv.get(DIR_HANDLE_KEY);
  return (entry?.value as DirectoryPickerLike | undefined) ?? null;
}

export async function getAutoBackupDirName(): Promise<string | null> {
  const handle = await getStoredDirHandle();
  return handle?.name ?? null;
}

/** Mở picker chọn thư mục (cần user gesture) và ghi handle vào DB. */
export async function chooseBackupDirectory(): Promise<string | null> {
  const picker = (window as unknown as {
    showDirectoryPicker: (o?: { mode?: string }) => Promise<DirectoryPickerLike>;
  }).showDirectoryPicker;
  const handle = await picker({ mode: 'readwrite' });
  await db.kv.put({ key: DIR_HANDLE_KEY, value: handle });
  return handle.name;
}

export async function clearBackupDirectory(): Promise<void> {
  await db.kv.delete(DIR_HANDLE_KEY);
}

async function writeBackupToDir(
  handle: DirectoryPickerLike,
): Promise<'written' | 'need-permission' | 'failed'> {
  try {
    const state = await handle.queryPermission({ mode: 'readwrite' });
    if (state !== 'granted') return 'need-permission';

    const backup = await createBackup();
    if (backup.chats.length === 0) return 'failed';

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const fileHandle = await handle.getFileHandle(`ai-chat-backup-${stamp}.json`, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(backup, null, 2));
    await writable.close();
    return 'written';
  } catch (err) {
    console.warn('[auto-backup] ghi file thất bại:', err);
    return 'failed';
  }
}

/**
 * Cố gắng backup ngầm vào thư mục đã chọn (gọi khi app mở).
 * Chỉ thành công khi permission đã được cấp trước đó — không hiện popup.
 */
export async function trySilentAutoBackup(now = Date.now()): Promise<boolean> {
  if (!isBackupDue(getLastBackupAt(), getBackupIntervalDays(), now)) return false;
  const handle = await getStoredDirHandle();
  if (!handle) return false;
  const result = await writeBackupToDir(handle);
  if (result === 'written') {
    setLastBackupAt(now);
    return true;
  }
  return false;
}

export interface BackupNowResult {
  ok: boolean;
  /** Đường đi đã dùng: ghi file ngầm hay download. */
  mode: 'folder' | 'download' | 'none';
  message?: string;
}

/** Backup ngay: ưu tiên thư mục đã chọn, không có thì download file. */
export async function backupNow(mode: 'prefer-folder' | 'download' = 'prefer-folder'): Promise<BackupNowResult> {
  if (mode === 'prefer-folder') {
    const handle = await getStoredDirHandle();
    if (handle) {
      let state: PermissionState = 'prompt';
      try {
        state = await handle.queryPermission({ mode: 'readwrite' });
        if (state !== 'granted') {
          state = await handle.requestPermission({ mode: 'readwrite' });
        }
      } catch {
        state = 'denied';
      }
      if (state === 'granted') {
        const result = await writeBackupToDir(handle);
        if (result === 'written') {
          setLastBackupAt();
          return { ok: true, mode: 'folder' };
        }
      }
    }
  }

  try {
    const { exportJson } = await import('@/lib/backup');
    await exportJson();
    setLastBackupAt();
    return { ok: true, mode: 'download' };
  } catch (err) {
    return { ok: false, mode: 'none', message: String((err as Error)?.message ?? err) };
  }
}
