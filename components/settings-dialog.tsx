'use client';

import React, { useRef, useState } from 'react';
import { db } from '@/lib/db';
import { useAppStore } from '@/lib/store';
import { AVAILABLE_MODELS } from '@/lib/models';
import { exportJson, exportMarkdown, importBackup, type ImportMode } from '@/lib/backup';
import { X, Download, Upload, Loader2, ShieldAlert } from 'lucide-react';

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; message?: string };

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const updatePerf = useAppStore((s) => s.updatePerf);

  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const run = async (label: string, task: () => Promise<void>) => {
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
        'Chế độ GHI ĐÈ sẽ xoá toàn bộ lịch sử chat hiện tại trước khi nạp tệp. Tiếp tục?',
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
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cài đặt hệ thống"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-200"
    >
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-lg p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6 pb-3 border-b border-zinc-800">
          <h2 className="text-xl font-medium text-zinc-100">Cài đặt ứng dụng</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng cài đặt"
            className="p-1 text-zinc-500 hover:text-zinc-300 rounded-lg transition"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-5">
          {/* Model */}
          <div>
            <label className="text-sm font-medium text-zinc-300 mb-1.5 block">AI Model</label>
            <select
              value={settings.model}
              onChange={(e) => updateSettings({ model: e.target.value })}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-2.5 text-sm text-zinc-200 outline-none focus:border-indigo-500 transition"
            >
              {AVAILABLE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          {/* Temperature */}
          <div>
            <div className="flex justify-between text-sm mb-1.5">
              <span className="text-zinc-300 font-medium">Temperature: {settings.temperature}</span>
            </div>
            <input
              type="range" min="0" max="1" step="0.05"
              value={settings.temperature}
              onChange={(e) => updateSettings({ temperature: parseFloat(e.target.value) })}
              className="w-full accent-indigo-500"
            />
          </div>

          {/* API key */}
          <div>
            <label className="text-sm font-medium text-zinc-300 mb-1.5 block">
              OpenAI API Key (Tùy chọn)
            </label>
            <input
              type="password"
              value={settings.apiKey || ''}
              onChange={(e) => updateSettings({ apiKey: e.target.value })}
              placeholder="sk-..."
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-2.5 text-sm text-zinc-200 outline-none focus:border-indigo-500 transition font-mono"
            />
          </div>

          {/* Access code */}
          <div>
            <label className="text-sm font-medium text-zinc-300 mb-1.5 block">
              Mã truy cập (Access Code)
            </label>
            <input
              type="password"
              value={settings.accessCode || ''}
              onChange={(e) => updateSettings({ accessCode: e.target.value })}
              placeholder="Nhập mã truy cập..."
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-2.5 text-sm text-zinc-200 outline-none focus:border-indigo-500 transition font-mono"
            />
          </div>

          {/* System prompt */}
          <div>
            <label className="text-sm font-medium text-zinc-300 mb-1.5 block">System Prompt</label>
            <textarea
              value={settings.systemPrompt}
              onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
              rows={3}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-2.5 text-sm text-zinc-200 outline-none focus:border-indigo-500 transition resize-none"
            />
          </div>

          {/* Perf */}
          <div className="pt-2 border-t border-zinc-800/80 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-300 font-medium">Hiệu ứng Animation</span>
              <input
                type="checkbox"
                checked={settings.perf?.animations ?? true}
                onChange={(e) => updatePerf({ animations: e.target.checked })}
                className="rounded accent-indigo-500 w-4 h-4"
              />
            </div>
          </div>

          {/* ------------------ Sao lưu & Phục hồi ------------------ */}
          <div className="pt-4 border-t border-zinc-800 space-y-3">
            <h3 className="text-sm font-semibold text-zinc-200">Sao lưu & Phục hồi</h3>
            <p className="text-xs text-zinc-500 leading-relaxed">
              Bản <code className="text-zinc-400">.json</code> lưu đầy đủ cây phân nhánh và tệp kèm —
              dùng để phục hồi. Bản <code className="text-zinc-400">.md</code> chỉ xuất nhánh đang
              xem, dùng để đọc hoặc in.
            </p>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => run('Đang xuất JSON…', () => exportJson())}
                className="flex items-center justify-center gap-2 py-2.5 px-3 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 rounded-xl text-sm font-medium transition disabled:opacity-50"
              >
                <Download size={14} /> Xuất tất cả .json
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => run('Đang xuất Markdown…', () => exportMarkdown())}
                className="flex items-center justify-center gap-2 py-2.5 px-3 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 rounded-xl text-sm font-medium transition disabled:opacity-50"
              >
                <Download size={14} /> Xuất tất cả .md
              </button>
            </div>

            <div>
              <label className="text-xs font-medium text-zinc-400 mb-1.5 block">
                Cách xử lý khi nạp lại
              </label>
              <select
                value={importMode}
                onChange={(e) => setImportMode(e.target.value as ImportMode)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-2.5 text-sm text-zinc-200 outline-none focus:border-indigo-500 transition"
              >
                <option value="merge">Gộp — bỏ qua đoạn chat đã tồn tại (an toàn)</option>
                <option value="duplicate">Nhân bản — luôn tạo bản mới với ID mới</option>
                <option value="overwrite">Ghi đè — xoá sạch rồi nạp lại</option>
              </select>
            </div>

            <button
              type="button"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-medium transition disabled:opacity-50"
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
                    ? 'text-red-400'
                    : status.kind === 'ok'
                      ? 'text-emerald-400'
                      : 'text-zinc-500'
                }`}
                role="status"
              >
                {status.message}
              </p>
            )}
          </div>

          {/* Danger zone */}
          <div className="pt-4 border-t border-zinc-800">
            <div className="flex items-start gap-2 mb-2 text-xs text-zinc-500">
              <ShieldAlert size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
              <span>Hãy xuất bản sao lưu .json trước khi thực hiện hành động này.</span>
            </div>
            <button
              type="button"
              onClick={async () => {
                if (
                  window.confirm(
                    'CẢNH BÁO: Hành động này sẽ xoá toàn bộ lịch sử chat và cài đặt. Bạn có chắc chắn không?',
                  )
                ) {
                  await db.delete();
                  localStorage.clear();
                  window.location.reload();
                }
              }}
              className="w-full py-2.5 px-4 bg-red-950/40 hover:bg-red-900/60 text-red-400 border border-red-900/50 rounded-xl text-sm font-medium transition"
            >
              Xoá toàn bộ dữ liệu ứng dụng
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
