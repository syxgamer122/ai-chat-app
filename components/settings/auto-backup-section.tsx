'use client';

/**
 * Settings → Tự động sao lưu
 *
 * Chu kỳ sao lưu và thư mục đích (File System Access API).
 *
 * (Tách ra từ components/settings-dialog.tsx — file đó từng dài 1.668 dòng.)
 */

import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import {
  backupNow,
  chooseBackupDirectory,
  clearBackupDirectory,
  getAutoBackupDirName,
  getBackupIntervalDays,
  isFileSystemAccessSupported,
  getLastBackupAt,
  setBackupIntervalDays,
} from '@/lib/auto-backup';

export function AutoBackupSection() {
  const [intervalDays, setIntervalDays] = useState(() => getBackupIntervalDays());
  const [dirName, setDirName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fsSupported] = useState(() => isFileSystemAccessSupported());

  const refreshDir = () => {
    void getAutoBackupDirName().then(setDirName);
  };
  useEffect(refreshDir, []);

  const formatLast = () => {
    const ts = getLastBackupAt();
    return ts ? new Date(ts).toLocaleString('vi-VN') : 'chưa bao giờ';
  };
  const [lastBackup, setLastBackup] = useState(formatLast);

  const handleChoose = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const name = await chooseBackupDirectory();
      setDirName(name);
      setMessage(name ? `Sẽ tự động ghi file vào thư mục "${name}".` : null);
    } catch {
      setMessage('Không chọn được thư mục.');
    } finally {
      setBusy(false);
    }
  };

  const handleBackupNow = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await backupNow('prefer-folder');
      if (result.ok) {
        setLastBackup(formatLast());
        setMessage(result.mode === 'folder' ? 'Đã ghi file vào thư mục đã chọn.' : 'Đã xuất file .json (kiểm tra mục Tải xuống).');
      } else {
        setMessage(result.message ?? 'Sao lưu thất bại.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <h4 className="field-label text-[15px]">Tự động sao lưu</h4>
      <div>
        <label htmlFor="backup-interval" className="mb-1.5 block text-xs font-medium text-text-muted">
          Chu kỳ nhắc / tự động
        </label>
        <select
          id="backup-interval"
          value={intervalDays}
          onChange={(e) => {
            const days = Number(e.target.value);
            setIntervalDays(days);
            setBackupIntervalDays(days);
          }}
          className="field"
        >
          <option value={1}>Mỗi ngày</option>
          <option value={3}>Mỗi 3 ngày</option>
          <option value={7}>Mỗi tuần</option>
          <option value={14}>Mỗi 2 tuần</option>
          <option value={30}>Mỗi tháng</option>
        </select>
      </div>

      {fsSupported && (
        <div className="space-y-2">
          {dirName ? (
            <div className="flex items-center justify-between gap-2 border border-border-hairline bg-surface-raised px-3 py-2 text-xs text-text-primary">
              <span className="min-w-0 truncate">📁 {dirName}</span>
              <button
                type="button"
                onClick={() => {
                  void clearBackupDirectory().then(() => {
                    setDirName(null);
                    setMessage('Đã gỡ thư mục tự động — quay lại chế độ nhắc + tải file.');
                  });
                }}
                className="flex-shrink-0 px-1.5 py-0.5 text-text-muted transition-colors hover:bg-[#e8704f]/10 hover:text-status-error"
              >
                Gỡ
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleChoose}
              disabled={busy}
              className="btn-secondary w-full"
            >
              Chọn thư mục lưu tự động…
            </button>
          )}
          <p className="text-[11px] leading-relaxed text-text-muted">
            Desktop Chrome/Edge: đến kỳ app tự ghi file <code className="claude-inline-code">.json</code> vào
            thư mục này, không cần bấm gì.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={handleBackupNow}
        disabled={busy}
        className="btn-secondary w-full"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        Sao lưu ngay
      </button>
      <p className="text-[11px] text-text-muted">Lần sao lưu cuối: {lastBackup}</p>
      {message && <p className="notice-warn" role="status">{message}</p>}
    </div>
  );
}

