'use client';

import React, { useEffect, useRef, useState } from 'react';
import { db, type PromptTemplate } from '@/lib/db';
import { useAppStore } from '@/lib/store';
import { AVAILABLE_MODELS } from '@/lib/models';
import { exportJson, exportMarkdown, importBackup, type ImportMode } from '@/lib/backup';
import { X, Download, Upload, Loader2, ShieldAlert } from 'lucide-react';
import { useInstallPrompt } from '@/lib/use-install-prompt';
import { ProviderManager } from '@/components/provider-manager';
import { UsageStats } from '@/components/usage-stats';
import { useLiveQuery } from 'dexie-react-hooks';
import { savePrompt, deletePrompt } from '@/lib/prompt-library';
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

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; message?: string };

/**
 * PWA: nút cài đặt lên thiết bị (Chrome/Edge/Android);
 * iOS hiện hướng dẫn "Thêm vào Màn hình chính".
 */
function InstallSection() {
  const { canInstall, installed, isIOS, install } = useInstallPrompt();

  const [installing, setInstalling] = useState(false);
  const handleInstall = async () => {
    setInstalling(true);
    try {
      await install();
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="pt-4 border-t border-zinc-200 space-y-2">
      <h3 className="text-sm font-semibold text-zinc-700">Ứng dụng</h3>
      {installed ? (
        <p className="text-xs text-zinc-500">Bạn đang dùng bản đã cài lên thiết bị.</p>
      ) : canInstall ? (
        <button
          type="button"
          onClick={handleInstall}
          disabled={installing}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-[#0A7E8C] hover:bg-[#086E7A] text-white rounded-xl text-sm font-medium transition disabled:opacity-50"
        >
          {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Cài đặt lên thiết bị
        </button>
      ) : isIOS ? (
        <p className="text-xs text-zinc-500 leading-relaxed">
          Trên iPhone/iPad: bấm nút <strong>Chia sẻ</strong> trong Safari →
          &ldquo;Thêm vào Màn hình chính&rdquo; để dùng như ứng dụng.
        </p>
      ) : (
        <p className="text-xs text-zinc-500 leading-relaxed">
          Cài app: trên Android/Chrome mở menu ⋮ → &ldquo;Cài đặt ứng dụng&rdquo;;
          trên máy tính mở biểu tượng install trên thanh địa chỉ.
        </p>
      )}
    </div>
  );
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* ------------------ Thư viện prompt ------------------ */

function PromptLibrarySection() {
  const prompts = useLiveQuery(() => db.prompts.orderBy('updatedAt').reverse().toArray(), [], []);

  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');

  const addPrompt = async () => {
    try {
      await savePrompt({ title: newTitle, content: newContent });
      setNewTitle('');
      setNewContent('');
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Không lưu được prompt.');
    }
  };

  const startEdit = (p: PromptTemplate) => {
    setEditingId(p.id);
    setEditTitle(p.title);
    setEditContent(p.content);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    try {
      await savePrompt({ id: editingId, title: editTitle, content: editContent });
      setEditingId(null);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Không lưu được prompt.');
    }
  };

  return (
    <div className="pt-4 border-t border-zinc-200 space-y-3">
      <h3 className="text-sm font-semibold text-zinc-700">Thư viện prompt</h3>
      <p className="text-xs text-zinc-500 leading-relaxed">
        Gõ <code className="text-zinc-500">/</code> trong ô nhập tin nhắn để chèn nhanh.
      </p>

      {(prompts ?? []).map((p) =>
        editingId === p.id ? (
          <div key={p.id} className="space-y-2 rounded-xl border border-zinc-300 bg-zinc-100/60 p-2.5">
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-800 outline-none focus:border-[#0A7E8C]"
              placeholder="Tên prompt"
            />
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={4}
              className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-600 outline-none focus:border-[#0A7E8C]"
              placeholder="Nội dung prompt"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={saveEdit}
                className="rounded-lg bg-[#0A7E8C] px-3 py-1 text-xs font-medium text-white hover:bg-[#086E7A]"
              >
                Lưu
              </button>
              <button
                type="button"
                onClick={() => setEditingId(null)}
                className="rounded-lg px-3 py-1 text-xs text-zinc-500 hover:text-zinc-700"
              >
                Huỷ
              </button>
            </div>
          </div>
        ) : (
          <div
            key={p.id}
            className="group flex items-start justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-100/40 px-2.5 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-zinc-700">{p.title}</div>
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-zinc-500">
                {p.content.replace(/\n+/g, ' ')}
              </div>
            </div>
            <div className="flex flex-shrink-0 gap-1 opacity-60 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={() => startEdit(p)}
                aria-label={`Sửa ${p.title}`}
                className="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Xoá prompt "${p.title}"?`)) void deletePrompt(p.id);
                }}
                aria-label={`Xoá ${p.title}`}
                className="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-red-400"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
              </button>
            </div>
          </div>
        ),
      )}

      <div className="space-y-2 rounded-xl border border-dashed border-zinc-300 p-2.5">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          className="w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-800 outline-none focus:border-[#0A7E8C]"
          placeholder="Tên prompt mới (vd: Viết email)"
        />
        <textarea
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          rows={3}
          className="w-full resize-y rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-600 outline-none focus:border-[#0A7E8C]"
          placeholder="Nội dung prompt"
        />
        <button
          type="button"
          onClick={addPrompt}
          className="w-full rounded-lg bg-zinc-200 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-300"
        >
          + Thêm prompt
        </button>
        {error && <p className="text-[11px] text-amber-400">{error}</p>}
      </div>
    </div>
  );
}

/* ------------------ Tự động sao lưu ------------------ */

function AutoBackupSection() {
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
    <div className="pt-4 border-t border-zinc-200 space-y-3">
      <h3 className="text-sm font-semibold text-zinc-700">Tự động sao lưu</h3>
      <div>
        <label className="text-xs font-medium text-zinc-500 mb-1.5 block">
          Chu kỳ nhắc / tự động
        </label>
        <select
          value={intervalDays}
          onChange={(e) => {
            const days = Number(e.target.value);
            setIntervalDays(days);
            setBackupIntervalDays(days);
          }}
          className="w-full bg-white border border-zinc-200 rounded-xl p-2.5 text-sm text-zinc-700 outline-none focus:border-[#0A7E8C] transition"
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
            <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-300 bg-zinc-100/60 px-3 py-2 text-xs text-zinc-600">
              <span className="min-w-0 truncate">📁 {dirName}</span>
              <button
                type="button"
                onClick={() => {
                  void clearBackupDirectory().then(() => {
                    setDirName(null);
                    setMessage('Đã gỡ thư mục tự động — quay lại chế độ nhắc + tải file.');
                  });
                }}
                className="flex-shrink-0 text-zinc-500 hover:text-red-400"
              >
                Gỡ
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleChoose}
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-3 bg-white hover:bg-zinc-200 border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium transition disabled:opacity-50"
            >
              Chọn thư mục lưu tự động…
            </button>
          )}
          <p className="text-[11px] leading-relaxed text-zinc-500">
            Desktop Chrome/Edge: đến kỳ app tự ghi file <code>.json</code> vào thư mục này,
            không cần bấm gì.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={handleBackupNow}
        disabled={busy}
        className="w-full flex items-center justify-center gap-2 py-2.5 px-3 bg-white hover:bg-zinc-200 border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium transition disabled:opacity-50"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        Sao lưu ngay
      </button>
      <p className="text-[11px] text-zinc-500">Lần sao lưu cuối: {lastBackup}</p>
      {message && <p className="text-[11px] text-amber-400">{message}</p>}
    </div>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const updatePerf = useAppStore((s) => s.updatePerf);

  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /* Focus trap: focus đầu vào khi mở, giữ Tab trong dialog, trả focus khi đóng. */
  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? panel)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;

      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    panel?.addEventListener('keydown', onKeyDown);
    return () => {
      panel?.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

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
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-[#F7F9FC] border border-zinc-200 rounded-2xl w-full max-w-lg p-6 shadow-2xl max-h-[90vh] overflow-y-auto focus:outline-none"
      >
        <div className="flex items-center justify-between mb-6 pb-3 border-b border-zinc-200">
          <h2 className="text-xl font-medium text-zinc-800">Cài đặt ứng dụng</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng cài đặt"
            className="p-1 text-zinc-500 hover:text-zinc-600 rounded-lg transition"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-5">
          {/* Model */}
          <div>
            <label className="text-sm font-medium text-zinc-600 mb-1.5 block">AI Model</label>
            <select
              value={settings.model}
              onChange={(e) => updateSettings({ model: e.target.value })}
              className="w-full bg-white border border-zinc-200 rounded-xl p-2.5 text-sm text-zinc-700 outline-none focus:border-[#0A7E8C] transition"
            >
              {AVAILABLE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          {/* Temperature */}
          <div>
            <div className="flex justify-between text-sm mb-1.5">
              <span className="text-zinc-600 font-medium">Temperature: {settings.temperature}</span>
            </div>
            <input
              type="range" min="0" max="1" step="0.05"
              value={settings.temperature}
              onChange={(e) => updateSettings({ temperature: parseFloat(e.target.value) })}
              className="w-full accent-[#0A7E8C]"
            />
          </div>

          {/* API key */}
          <div>
            <label className="text-sm font-medium text-zinc-600 mb-1.5 block">
              OpenAI API Key (Tùy chọn)
            </label>
            <input
              type="password"
              value={settings.apiKey || ''}
              onChange={(e) => updateSettings({ apiKey: e.target.value })}
              placeholder="sk-..."
              className="w-full bg-white border border-zinc-200 rounded-xl p-2.5 text-sm text-zinc-700 outline-none focus:border-[#0A7E8C] transition font-mono"
            />
          </div>

          {/* Nhà cung cấp API */}
          <div>
            <label className="text-sm font-medium text-zinc-600 mb-1.5 block">
              Nhà cung cấp API
            </label>
            <p className="mb-2 text-[11px] text-zinc-500">
              Lưu nhiều nhà cung cấp chuẩn OpenAI-compatible, tải danh sách model và chuyển
              nhanh mà không cần cấu hình lại server.
            </p>
            <ProviderManager />
          </div>

          {/* Thống kê token */}
          <div>
            <label className="text-sm font-medium text-zinc-600 mb-1.5 block">
              Thống kê token sử dụng
            </label>
            <UsageStats />
          </div>

          {/* Access code */}
          <div>
            <label className="text-sm font-medium text-zinc-600 mb-1.5 block">
              Mã truy cập (Access Code)
            </label>
            <input
              type="password"
              value={settings.accessCode || ''}
              onChange={(e) => updateSettings({ accessCode: e.target.value })}
              placeholder="Nhập mã truy cập..."
              className="w-full bg-white border border-zinc-200 rounded-xl p-2.5 text-sm text-zinc-700 outline-none focus:border-[#0A7E8C] transition font-mono"
            />
          </div>

          {/* System prompt */}
          <div>
            <label className="text-sm font-medium text-zinc-600 mb-1.5 block">System Prompt</label>
            <textarea
              value={settings.systemPrompt}
              onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
              rows={3}
              className="w-full bg-white border border-zinc-200 rounded-xl p-2.5 text-sm text-zinc-700 outline-none focus:border-[#0A7E8C] transition resize-none"
            />
          </div>

          {/* Perf */}
          <div className="pt-2 border-t border-zinc-200/80 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-600 font-medium">Hiệu ứng Animation</span>
              <input
                type="checkbox"
                checked={settings.perf?.animations ?? true}
                onChange={(e) => updatePerf({ animations: e.target.checked })}
                className="rounded accent-[#0A7E8C] w-4 h-4"
              />
            </div>
          </div>

          {/* ------------------ Thư viện prompt ------------------ */}
          <PromptLibrarySection />

          {/* ------------------ Ứng dụng (PWA) ------------------ */}
          <InstallSection />

          {/* ------------------ Tự động sao lưu ------------------ */}
          <AutoBackupSection />

          {/* ------------------ Sao lưu & Phục hồi ------------------ */}
          <div className="pt-4 border-t border-zinc-200 space-y-3">
            <h3 className="text-sm font-semibold text-zinc-700">Sao lưu & Phục hồi</h3>
            <p className="text-xs text-zinc-500 leading-relaxed">
              Bản <code className="text-zinc-500">.json</code> lưu đầy đủ cây phân nhánh và tệp kèm —
              dùng để phục hồi. Bản <code className="text-zinc-500">.md</code> chỉ xuất nhánh đang
              xem, dùng để đọc hoặc in.
            </p>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => run('Đang xuất JSON…', () => exportJson())}
                className="flex items-center justify-center gap-2 py-2.5 px-3 bg-white hover:bg-zinc-200 border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium transition disabled:opacity-50"
              >
                <Download size={14} /> Xuất tất cả .json
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => run('Đang xuất Markdown…', () => exportMarkdown())}
                className="flex items-center justify-center gap-2 py-2.5 px-3 bg-white hover:bg-zinc-200 border border-zinc-200 text-zinc-700 rounded-xl text-sm font-medium transition disabled:opacity-50"
              >
                <Download size={14} /> Xuất tất cả .md
              </button>
            </div>

            <div>
              <label className="text-xs font-medium text-zinc-500 mb-1.5 block">
                Cách xử lý khi nạp lại
              </label>
              <select
                value={importMode}
                onChange={(e) => setImportMode(e.target.value as ImportMode)}
                className="w-full bg-white border border-zinc-200 rounded-xl p-2.5 text-sm text-zinc-700 outline-none focus:border-[#0A7E8C] transition"
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
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-[#0A7E8C] hover:bg-[#086E7A] text-white rounded-xl text-sm font-medium transition disabled:opacity-50"
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
          <div className="pt-4 border-t border-zinc-200">
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
