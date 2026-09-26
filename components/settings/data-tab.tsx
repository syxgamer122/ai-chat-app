'use client';

/**
 * Settings → tab "Dữ liệu & Tự động hoá"
 *
 * Sao lưu / phục hồi, tự động sao lưu định kỳ, thống kê token và vùng nguy hiểm.
 *
 * (Tách ra từ components/settings-dialog.tsx.)
 *
 * KHÁC 5 tab còn lại: tab này nhận 0 prop nhưng mang theo TOÀN BỘ state cục bộ
 * của nó (status, importMode, fileInputRef). Trước đây state đó nằm ở
 * SettingsDialog rồi luồn xuống chỉ để phục vụ duy nhất tab này.
 */

import React, { useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { db } from '@/lib/db';
import { exportJson, exportMarkdown, importBackup, type ImportMode } from '@/lib/backup';
import { Download, Loader2, ShieldAlert, Upload } from 'lucide-react';
import { SectionLoading } from '@/components/settings/section-loading';
import { AutoBackupSection } from '@/components/settings/auto-backup-section';

const UsageStats = dynamic(() => import('@/components/usage-stats').then((m) => m.UsageStats), { ssr: false, loading: SectionLoading });
const SchedulerPanel = dynamic(() => import('@/components/scheduler/scheduler-panel').then((m) => m.SchedulerPanel), { ssr: false, loading: SectionLoading });
const StorageQuotaMeter = dynamic(() => import('@/components/storage-quota-meter').then((m) => m.StorageQuotaMeter), { ssr: false, loading: SectionLoading });

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; message?: string };

export function DataTab() {
  const [importMode, setImportMode] = useState<ImportMode>('merge');
    const [status, setStatus] = useState<Status>({ kind: 'idle' });
    const fileInputRef = useRef<HTMLInputElement>(null);

  const runBackupTask = async (label: string, task: () => Promise<void>) => {
      setStatus({ kind: 'busy', message: label });
      try {
        await task();
        setStatus({ kind: 'ok', message: 'Hoàn tất.' });
      } catch (err: any) {
        console.error('[settings backup]', err);
        setStatus({ kind: 'error', message: err?.message ?? 'Đã xảy ra lỗi.' });
      }
    };

    const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;

      if (importMode === 'overwrite') {
        const ok = window.confirm(
          'Chế độ GHI ĐÈ sẽ xóa toàn bộ lịch sử chat hiện tại trước khi nạp tệp. Tiếp tục?',
        );
        if (!ok) return;
      }

      setStatus({ kind: 'busy', message: 'Đang nạp dữ liệu…' });
      try {
        const stats = await importBackup(file, importMode);
        setStatus({
          kind: 'ok',
          message: `Đã nạp ${stats.chatsAdded} đoạn chat, ${stats.messagesAdded} tin nhắn${
            stats.chatsSkipped ? `, bỏ qua ${stats.chatsSkipped} đoạn đã tồn tại` : ''
          }.`,
        });
      } catch (err: any) {
        console.error('[settings import]', err);
        setStatus({ kind: 'error', message: err?.message ?? 'Không đọc được tệp.' });
      }
    };

    const busy = status.kind === 'busy';

  return (
    <>
      <div className="border-b border-border-hairline pb-2">
        <h3 className="text-sm font-semibold text-text-primary">Dữ liệu &amp; Tự động hoá</h3>
        <p className="mt-0.5 text-[11px] text-text-muted">
          Tự động sao lưu, nhập xuất dữ liệu hội thoại, thống kê token và quản lý lịch chạy tác vụ.
        </p>
      </div>

      <AutoBackupSection />

      <div className="settings-card settings-card-body">
        <h4 className="field-label text-[15px]">Sao lưu &amp; Phục hồi thủ công</h4>
        <p className="text-xs leading-relaxed text-text-muted">
          Bản <code className="claude-inline-code">.json</code> lưu đầy đủ cây phân nhánh và tệp kèm —
          dùng để phục hồi. Bản <code className="claude-inline-code">.md</code> chỉ xuất nhánh đang
          xem, dùng để đọc hoặc in.
        </p>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => runBackupTask('Đang xuất JSON…', () => exportJson())}
            className="btn-secondary"
          >
            <Download size={14} /> Xuất tất cả .json
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => runBackupTask('Đang xuất Markdown…', () => exportMarkdown())}
            className="btn-secondary"
          >
            <Download size={14} /> Xuất tất cả .md
          </button>
        </div>

        <div>
          <label htmlFor="import-mode" className="mb-1.5 block text-xs font-medium text-text-muted">
            Cách xử lý khi nạp lại
          </label>
          <select
            id="import-mode"
            value={importMode}
            onChange={(e) => setImportMode(e.target.value as ImportMode)}
            className="field"
          >
            <option value="merge">Gộp — bỏ qua đoạn chat đã tồn tại (an toàn)</option>
            <option value="duplicate">Nhân bản — luôn tạo bản mới với ID mới</option>
            <option value="overwrite">Ghi đè — xóa sạch rồi nạp lại</option>
          </select>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          className="btn-primary w-full"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          Nạp tệp sao lưu (.json)
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleFile}
          className="hidden"
        />

        {status.kind !== 'idle' && status.message && (
          <p
            className={`text-xs leading-relaxed ${
              status.kind === 'error'
                ? 'text-status-error'
                : status.kind === 'ok'
                  ? 'text-status-success'
                  : 'text-text-muted'
            }`}
            role="status"
          >
            {status.message}
          </p>
        )}
      </div>

      <div className="settings-card settings-card-body">
        <StorageQuotaMeter />
      </div>

      <div className="settings-card settings-card-body">
        <h4 className="field-label text-[15px]">Thống kê tiêu thụ Token</h4>
        <UsageStats />
      </div>

      <div className="settings-card settings-card-body">
        <SchedulerPanel />
      </div>

      <div className="space-y-3 border-t border-status-error/40 pt-4">
        <h4 className="field-label text-[15px] text-status-error">Vùng nguy hiểm</h4>
        <div className="flex items-start gap-2 text-xs text-text-muted">
          <ShieldAlert size={14} className="mt-0.5 flex-shrink-0 text-status-error" />
          <span>Hãy xuất bản sao lưu .json trước khi thực hiện hành động này. Dữ liệu sẽ bị xóa hoàn toàn khỏi máy.</span>
        </div>
        <button
          type="button"
          onClick={async () => {
            if (
              window.confirm(
                'CẢNH BÁO: Hành động này sẽ xóa toàn bộ lịch sử chat và cài đặt. Bạn có chắc chắn không?',
              )
            ) {
              try {
                await db.delete();
              } catch {
                setStatus({
                  kind: 'error',
                  message:
                    'Không xóa được: có tab khác đang mở ứng dụng. Hãy đóng các tab khác rồi thử lại.',
                });
                return;
              }
              localStorage.clear();
              window.location.reload();
            }
          }}
          className="w-full border border-status-error/40 bg-[#e8704f]/15 px-4 py-2.5 text-sm font-semibold text-status-error transition hover:bg-[#e8704f]/25"
        >
          Xóa toàn bộ dữ liệu ứng dụng
        </button>
      </div>
    </>
  );
}
