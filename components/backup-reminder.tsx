'use client';

import { useCallback, useEffect, useState } from 'react';
import { HardDriveDownload, X } from 'lucide-react';
import {
  backupNow,
  shouldShowReminder,
  snoozeBackupReminder,
  trySilentAutoBackup,
} from '@/lib/auto-backup';

/**
 * Hiện banner nhắc sao lưu khi đến kỳ. Nếu người dùng đã cấu hình thư mục
 * tự động (desktop), việc ghi file chạy ngầm ngay khi mở app — banner chỉ
 * xuất hiện khi không ghi được.
 */
export function BackupReminder({ chatCount }: { chatCount: number }) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setVisible(chatCount > 0 && shouldShowReminder());
  }, [chatCount]);

  useEffect(() => {
    let cancelled = false;
    // Cố gắng backup ngầm vào thư mục đã chọn trước khi quyết định hiện banner.
    void trySilentAutoBackup().then((done) => {
      if (cancelled) return;
      if (done) setVisible(false);
      else refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  if (!visible) return null;

  const handleBackup = async () => {
    setBusy(true);
    try {
      const result = await backupNow('prefer-folder');
      if (result.ok) setVisible(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="status" className="notice-warn mx-2 mt-2">
      <div className="flex items-start gap-2">
        <HardDriveDownload size={14} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="leading-relaxed">
            Đã lâu chưa sao lưu dữ liệu. Chat đang lưu trên thiết bị này thôi.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={handleBackup}
              disabled={busy}
              className="rounded-none bg-[#e8993a] px-2.5 py-1 font-medium text-[#0d1116] transition hover:bg-[#e8993a]/85 disabled:opacity-50"
            >
              {busy ? 'Đang sao lưu…' : 'Sao lưu ngay'}
            </button>
            <button
              type="button"
              onClick={() => {
                snoozeBackupReminder();
                setVisible(false);
              }}
              className="rounded-none px-2 py-1 text-[#e8993a] transition hover:bg-[#e8993a]/10"
            >
              Để sau
            </button>
          </div>
        </div>
        <button
          type="button"
          aria-label="Đóng nhắc nhở"
          onClick={() => {
            snoozeBackupReminder();
            setVisible(false);
          }}
          className="-mr-1 -mt-0.5 flex-shrink-0 rounded-none p-0.5 text-[#9fa4ab] transition hover:bg-[#e8993a]/10 hover:text-[#e8993a]"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
