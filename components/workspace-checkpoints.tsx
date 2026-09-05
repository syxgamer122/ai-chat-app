'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { History, Loader2, Undo2 } from 'lucide-react';
import { db, type WorkspaceSnapshot, type WsSnapshotFile } from '@/lib/db';
import {
  getUndoTarget,
  markSnapshotUndone,
  planRestore,
  type RestoreOp,
} from '@/lib/workspace-checkpoints';
import { fsDelete, fsReadFull, fsWrite, requireWorkspace } from '@/lib/fs-access';
import { lineDiff, renderUnifiedDiff } from '@/lib/naive-diff';

/**
 * Thanh "Hoàn tác thay đổi của AI" + modal xác nhận.
 *
 * Chỉ bản MỚI NHẤT chưa undone của chat là restorable (LIFO — xem
 * getUndoTarget). Preview diff đọc file HIỆN TẠI trên đĩa so với nội dung
 * trước khi agent ghi; đọc lỗi/to lớn thì hiện badge thay vì chặn restore.
 */

interface Props {
  chatId: string | null;
  /** Đang stream/tạo media — khoá nút để không đua tay với agent. */
  busy?: boolean;
  onNotice?: (msg: string, durationMs?: number) => void;
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; text: string; adds: number; dels: number }
  | { status: 'unavailable'; note: string };

export function WorkspaceCheckpointBar({ chatId, busy = false, onNotice }: Props) {
  const snapshots = useLiveQuery(
    (): Promise<WorkspaceSnapshot[]> =>
      chatId ? db.wsSnapshots.where('chatId').equals(chatId).toArray() : Promise.resolve([]),
    [chatId],
  );
  const target = useMemo<WorkspaceSnapshot | null>(
    () => (snapshots ? getUndoTarget(snapshots) : null),
    [snapshots],
  );

  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [previews, setPreviews] = useState<Map<string, PreviewState>>(new Map());

  // Đổi target/chat → xoá cache preview (nội dung đĩa có thể đã khác).
  useEffect(() => {
    setPreviews(new Map());
    setOpen(false);
  }, [target?.id, chatId]);

  const ops = useMemo<RestoreOp[]>(() => (target ? planRestore(target) : []), [target]);

  const loadPreview = useCallback(
    async (file: WsSnapshotFile) => {
      if (!target) return;
      setPreviews((prev) => new Map(prev).set(file.path, { status: 'loading' }));
      try {
        const ws = await requireWorkspace();
        if (!ws.ok) {
          setPreviews((prev) =>
            new Map(prev).set(file.path, { status: 'unavailable', note: ws.error }),
          );
          return;
        }
        const current = await fsReadFull(ws.deps, file.path, 200_000);
        if (current.status === 'ok') {
          const d = renderUnifiedDiff(lineDiff(current.content, file.content), {
            maxChars: 4_000,
            contextLines: 1,
          });
          setPreviews((prev) =>
            new Map(prev).set(file.path, {
              status: 'ready',
              text: d.text,
              adds: d.adds,
              dels: d.dels,
            }),
          );
        } else if (current.status === 'missing') {
          // File hiện tại đã biến mất — restore sẽ tạo lại từ content cũ.
          const d = renderUnifiedDiff(lineDiff('', file.content), { maxChars: 4_000 });
          setPreviews((prev) =>
            new Map(prev).set(file.path, {
              status: 'ready',
              text: d.text || '(file rỗng)',
              adds: d.adds,
              dels: d.dels,
            }),
          );
        } else {
          setPreviews((prev) =>
            new Map(prev).set(file.path, {
              status: 'unavailable',
              note:
                current.status === 'too-large'
                  ? `File quá lớn để xem trước (${Math.round(current.size / 1024)}KB)`
                  : current.message,
            }),
          );
        }
      } catch (e) {
        setPreviews((prev) =>
          new Map(prev).set(file.path, {
            status: 'unavailable',
            note: e instanceof Error ? e.message.slice(0, 120) : 'Lỗi đọc file.',
          }),
        );
      }
    },
    [target],
  );

  /**
   * Thực thi rollback. Bán-an toàn: lỗi giữa chừng thì các file TRƯỚC đó đã
   * được ghi lại đúng nội dung cũ (thứ tự ops độc lập nhau), snapshot GIỮ
   * nguyên trạng active để user thử lại — chỉ đánh dấu undone khi đủ 100%.
   */
  const performRestore = useCallback(async () => {
    if (!target || running) return;
    setRunning(true);
    try {
      const ws = await requireWorkspace();
      if (!ws.ok) {
        onNotice?.(ws.error);
        return;
      }
      const failed: string[] = [];
      for (const op of ops) {
        try {
          if (op.action === 'write') await fsWrite(ws.deps, op.path, op.content);
          else await fsDelete(ws.deps, op.path);
        } catch {
          failed.push(op.path);
        }
      }
      if (failed.length > 0) {
        onNotice?.(`Hoàn tác chưa xong — lỗi ở ${failed.length} file: ${failed.join(', ')}`);
        return;
      }
      await markSnapshotUndone(target.id);
      onNotice?.(
        `Đã hoàn tác ${ops.length} thay đổi của AI về trạng thái trước lượt sửa.`,
        5000,
      );
      setOpen(false);
    } finally {
      setRunning(false);
    }
  }, [target, ops, running, onNotice]);

  if (!chatId || !target) return null;

  return (
    <>
      <div className="flex justify-center pb-1">
        <button
          type="button"
          disabled={busy || running}
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-full border border-[#495059] bg-[#161d27] px-3 py-1 font-mono text-[11px] text-[#6a9fcc] transition-colors hover:border-[#757d89] hover:bg-[#212730] hover:text-[#ebe7e4] disabled:opacity-40"
          title="Khôi phục các file agent vừa sửa về trạng thái trước đó"
        >
          <History size={12} className="text-[#6a9fcc]" aria-hidden />
          <span>$ undo · {ops.length} changes</span>
        </button>
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Hoàn tác thay đổi của AI"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
          onClick={() => {
            if (!running) setOpen(false);
          }}
        >
          <div
            className="pi-frame relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-none border border-[#495059] bg-[#212730] font-mono"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="pi-corner-tl" />
            <span className="pi-corner-tr" />
            <span className="pi-corner-bl" />
            <span className="pi-corner-br" />

            <div className="border-b border-[#495059] bg-[#161d27] px-4 py-3">
              <div className="flex items-center gap-2 font-pixel text-[16px] font-semibold text-[#ebe7e4] [image-rendering:pixelated]">
                <span className="font-bold text-[#6a9fcc]">$</span>
                <span className="text-[#6a9fcc]">undo</span>
                <span>· Khôi phục {ops.length} file về trước lượt sửa của AI</span>
              </div>
              <div className="mt-0.5 text-[11px] text-[#9fa4ab]">
                Lượt sửa lúc {new Date(target.createdAt).toLocaleString('vi-VN')}
              </div>
            </div>

            <div className="flex-1 overflow-auto p-3">
              <ul className="flex flex-col gap-2">
                {target.files.map((f) => {
                  const pv = previews.get(f.path) ?? { status: 'idle' as const };
                  return (
                    <li
                      key={f.path}
                      className="rounded-none border border-[#495059] bg-[#161d27] px-3 py-2"
                    >
                      <details
                        onToggle={(e) => {
                          const el = e.currentTarget;
                          if (el.open && pv.status === 'idle') void loadPreview(f);
                        }}
                      >
                        <summary className="cursor-pointer select-none font-mono text-[12px] text-[#ebe7e4]">
                          <span
                            className={`mr-2 rounded-none px-1.5 py-0.5 font-mono text-[10px] ${
                              f.existedBefore
                                ? 'border border-[#6a9fcc]/30 bg-[#6a9fcc]/10 text-[#6a9fcc]'
                                : 'border border-[#e8704f]/30 bg-[#e8704f]/10 text-[#e8704f]'
                            }`}
                          >
                            {f.existedBefore ? 'restore' : 'delete new'}
                          </span>
                          {f.path}
                        </summary>
                        {pv.status === 'idle' && (
                          <p className="mt-2 text-[11px] text-[#9fa4ab]">Mở để xem diff…</p>
                        )}
                        {pv.status === 'loading' && (
                          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-[#6a9fcc]">
                            <Loader2 size={11} className="animate-spin" /> Đang đọc file hiện tại…
                          </p>
                        )}
                        {pv.status === 'unavailable' && (
                          <p className="mt-2 text-[11px] text-[#e8704f]">{pv.note}</p>
                        )}
                        {pv.status === 'ready' && (
                          <>
                            <p className="mt-2 text-[11px] text-[#9fa4ab]">
                              <span className="text-[#5db87a]">+{pv.adds}</span>{' '}
                              <span className="text-[#e8704f]">-{pv.dels}</span> — nội dung sẽ khôi phục:
                            </p>
                            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-none border border-[#495059] bg-[#0d1116] p-2 font-mono text-[11px] leading-relaxed text-[#ebe7e4]">
                              {pv.text}
                            </pre>
                          </>
                        )}
                      </details>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-[#495059] bg-[#161d27] px-4 py-2.5">
              <span className="text-[11px] text-[#9fa4ab]">
                $ Esc to cancel
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={running}
                  onClick={() => setOpen(false)}
                  className="rounded-none border border-[#495059] bg-[#252f3d] px-3 py-1.5 text-xs text-[#ebe7e4] transition-colors hover:border-[#757d89] disabled:opacity-50"
                >
                  Để nguyên
                </button>
                <button
                  type="button"
                  disabled={running || busy}
                  onClick={() => void performRestore()}
                  className="flex items-center gap-1.5 rounded-none bg-[#6a9fcc] px-3.5 py-1.5 text-xs font-semibold text-[#0d1116] transition-colors hover:bg-[#6a9fcc]/85 disabled:opacity-60"
                >
                  {running ? (
                    <Loader2 size={13} className="animate-spin" aria-hidden />
                  ) : (
                    <Undo2 size={13} aria-hidden />
                  )}
                  {running ? 'Đang khôi phục…' : 'Khôi phục'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
