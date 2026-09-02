'use client';

import React, { useEffect, useRef, useState } from 'react';
import { db, addMemory, deleteMemory, MAX_MEMORIES, MAX_MEMORY_CHARS, type PromptTemplate } from '@/lib/db';
import { useAppStore, SERVER_PROVIDER_ID, ALL_TOOL_CATEGORIES, TOOL_CATEGORY_LABELS, isPermissionOverride, type PermissionOverride } from '@/lib/store';
import { exportJson, exportMarkdown, importBackup, type ImportMode } from '@/lib/backup';
import { X, Download, Upload, Loader2, ShieldAlert, Pencil, Trash2 } from 'lucide-react';
import { useInstallPrompt } from '@/lib/use-install-prompt';
import { VyenMark } from '@/components/vyen-logo';
import { ProviderManager } from '@/components/provider-manager';
import { UsageStats } from '@/components/usage-stats';
import { McpSettingsPanel } from '@/components/mcp/mcp-settings-panel';
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
/* ------------------ Ghi nhớ dài hạn (memory) ------------------ */

function MemoriesSection() {
  const memories = useLiveQuery(() => db.memories.orderBy('createdAt').reverse().toArray(), [], []);

  const [newText, setNewText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!newText.trim()) return;
    try {
      const created = await addMemory(newText);
      if (!created) {
        setError('Ghi nhớ trùng nội dung đã có hoặc rỗng.');
        return;
      }
      setError(null);
      setNewText('');
    } catch (e) {
      console.error('[memory]', e);
      setError('Không lưu được ghi nhớ.');
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-zinc-800">Ghi nhớ dài hạn</h3>
      <p className="text-xs leading-relaxed text-zinc-600">
        Các fact ngắn model tự tra qua công cụ <code className="claude-inline-code">memory_search</code> khi
        liên quan (sở thích, thông tin cá nhân, quy ước...). Lưu trong máy bạn, tối đa{' '}
        {MAX_MEMORIES} mục.
      </p>

      {(memories ?? []).length === 0 && (
        <p className="rounded-lg bg-surface-muted/60 px-2.5 py-2 text-[11px] italic text-zinc-500">
          Chưa có ghi nhớ nào.
        </p>
      )}

      {(memories ?? []).map((m) => (
        <div
          key={m.id}
          className="group flex items-start justify-between gap-2 rounded-lg border border-zinc-200 bg-surface-muted/60 px-2.5 py-2"
        >
          <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-zinc-700">{m.text}</div>
          <button
            type="button"
            onClick={() => {
              void deleteMemory(m.id);
            }}
            aria-label="Xóa ghi nhớ"
            className="flex-shrink-0 rounded p-1 text-zinc-500 opacity-70 transition-colors hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 dark:hover:bg-red-500/10 dark:hover:text-red-400"
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}

      <div className="space-y-2 rounded-xl border border-dashed border-zinc-300 p-2.5">
        <textarea
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          rows={2}
          maxLength={MAX_MEMORY_CHARS}
          className="field-sm resize-none text-xs"
          placeholder='Ví dụ: "Tôi thích trả lời ngắn gọn, code dùng TypeScript"'
          aria-label="Nội dung ghi nhớ mới"
        />
        {error && <p className="text-[11px] text-red-600">{error}</p>}
        <button type="button" onClick={() => void add()} disabled={!newText.trim()} className="btn-secondary w-full justify-center">
          Thêm ghi nhớ
        </button>
      </div>
    </div>
  );
}

function InstallSection() {  const { canInstall, installed, isIOS, install } = useInstallPrompt();

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
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-zinc-800">Ứng dụng</h3>
      {installed ? (
        <div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-surface-raised p-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-surface-muted ring-1 ring-zinc-900/5">
            <VyenMark size={20} />
          </div>
          <p className="text-xs text-zinc-600">
            <strong className="font-semibold">Vyen</strong> đang chạy bản đã cài lên thiết bị —
            hoạt động offline và mở như app thật.
          </p>
        </div>
      ) : canInstall ? (
        <button
          type="button"
          onClick={handleInstall}
          disabled={installing}
          className="btn-primary w-full bg-gradient-to-r from-brand to-brand-accent hover:from-brand-hover hover:to-brand-accent"
        >
          {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Cài Vyen lên thiết bị
        </button>
      ) : isIOS ? (
        <p className="text-xs leading-relaxed text-zinc-600">
          Trên iPhone/iPad: bấm nút <strong>Chia sẻ</strong> trong Safari →
          &ldquo;Thêm vào Màn hình chính&rdquo; để dùng như ứng dụng.
        </p>
      ) : (
        <p className="text-xs leading-relaxed text-zinc-600">
          Cài app: trên Android/Chrome mở menu ⋮ → &ldquo;Cài đặt ứng dụng&rdquo;;
          trên máy tính mở biểu tượng install trên thanh địa chỉ.
        </p>
      )}
    </div>
  );
}

type SettingsTab = 'chung' | 'provider' | 'stats' | 'prompts' | 'memory' | 'data' | 'app';

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'chung', label: 'Chung' },
  { id: 'provider', label: 'Nhà cung cấp' },
  { id: 'stats', label: 'Thống kê' },
  { id: 'prompts', label: 'Prompt' },
  { id: 'memory', label: 'Ghi nhớ' },
  { id: 'data', label: 'Dữ liệu' },
  { id: 'app', label: 'Ứng dụng' },
];

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* ------------------ Thư viện prompt ------------------ */

function PromptLibrarySection() {
  const prompts = useLiveQuery(() => db.prompts.orderBy('updatedAt').reverse().toArray(), [], []);

  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newMode, setNewMode] = useState<'insert' | 'skill'>('insert');
  const [newDescription, setNewDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editMode, setEditMode] = useState<'insert' | 'skill'>('insert');
  const [editDescription, setEditDescription] = useState('');

  const addPrompt = async () => {
    try {
      await savePrompt({
        title: newTitle,
        content: newContent,
        mode: newMode,
        description: newDescription,
      });
      setNewTitle('');
      setNewContent('');
      setNewDescription('');
      setNewMode('insert');
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Không lưu được prompt.');
    }
  };

  const startEdit = (p: PromptTemplate) => {
    setEditingId(p.id);
    setEditTitle(p.title);
    setEditContent(p.content);
    setEditMode(p.mode ?? 'insert');
    setEditDescription(p.description ?? '');
  };

  const saveEdit = async () => {
    if (!editingId) return;
    try {
      await savePrompt({
        id: editingId,
        title: editTitle,
        content: editContent,
        mode: editMode,
        description: editDescription,
      });
      setEditingId(null);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Không lưu được prompt.');
    }
  };

  /** Cặp field chung cho form thêm/sửa: mode + mô tả khi nào dùng. */
  const modeFields = (
    mode: 'insert' | 'skill',
    setMode: (m: 'insert' | 'skill') => void,
    desc: string,
    setDesc: (v: string) => void,
  ) => (
    <>
      <div className="flex gap-1" role="radiogroup" aria-label="Kiểu prompt">
        {(
          [
            { v: 'insert', label: 'Chèn qua "/"' },
            { v: 'skill', label: 'Skill tự kích hoạt' },
          ] as const
        ).map((opt) => (
          <button
            key={opt.v}
            type="button"
            role="radio"
            aria-checked={mode === opt.v}
            onClick={() => setMode(opt.v)}
            className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
              mode === opt.v
                ? 'bg-brand text-white'
                : 'border border-zinc-300 text-zinc-600 hover:text-zinc-900'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {mode === 'skill' && (
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          className="field-sm"
          placeholder='Khi nào dùng — vd: "soạn email công việc, viết đơn từ"'
          aria-label="Mô tả khi nào dùng skill"
        />
      )}
    </>
  );

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-zinc-800">Thư viện prompt</h3>
      <p className="text-xs leading-relaxed text-zinc-600">
        Gõ <code className="claude-inline-code">/</code> trong ô nhập để chèn nhanh.{' '}
        <strong>Skill</strong> khác: không chèn — tự bật khi tin nhắn khớp mô tả.
      </p>

      {(prompts ?? []).map((p) =>
        editingId === p.id ? (
          <div key={p.id} className="space-y-2 rounded-xl border border-zinc-300 bg-surface-muted p-2.5">
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="field-sm"
              placeholder="Tên prompt"
              aria-label="Tên prompt"
            />
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={4}
              className="field-sm resize-y text-xs"
              placeholder="Nội dung prompt"
              aria-label="Nội dung prompt"
            />
            {modeFields(editMode, setEditMode, editDescription, setEditDescription)}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={saveEdit}
                className="rounded-lg bg-brand px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-brand-hover"
              >
                Lưu
              </button>
              <button
                type="button"
                onClick={() => setEditingId(null)}
                className="rounded-lg px-3 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
              >
                Hủy
              </button>
            </div>
          </div>
        ) : (
          <div
            key={p.id}
            className="group flex items-start justify-between gap-2 rounded-lg border border-zinc-200 bg-surface-muted/60 px-2.5 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-zinc-800">
                {p.title}
                {p.mode === 'skill' && (
                  <span className="ml-1.5 rounded bg-brand/10 px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-wide text-brand">
                    Skill
                  </span>
                )}
              </div>
              {p.mode === 'skill' && p.description && (
                <div className="mt-0.5 line-clamp-1 text-[11px] italic text-zinc-500">
                  Khi nào dùng: {p.description}
                </div>
              )}
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-zinc-600">
                {p.content.replace(/\n+/g, ' ')}
              </div>
            </div>
            <div className="flex flex-shrink-0 gap-1 opacity-70 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={() => startEdit(p)}
                aria-label={`Sửa ${p.title}`}
                className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-200/60 dark:hover:text-zinc-100"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Xóa prompt "${p.title}"?`)) void deletePrompt(p.id);
                }}
                aria-label={`Xóa ${p.title}`}
                className="rounded p-1 text-zinc-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ),
      )}

      <div className="space-y-2 rounded-xl border border-dashed border-zinc-300 p-2.5">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          className="field-sm"
          placeholder="Tên prompt mới (vd: Viết email)"
          aria-label="Tên prompt mới"
        />
        <textarea
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          rows={3}
          className="field-sm resize-y text-xs"
          placeholder="Nội dung prompt"
          aria-label="Nội dung prompt mới"
        />
        {modeFields(newMode, setNewMode, newDescription, setNewDescription)}
        <button
          type="button"
          onClick={addPrompt}
          className="w-full rounded-lg bg-zinc-100 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-200"
        >
          + Thêm prompt
        </button>
        {error && <p className="notice-error">{error}</p>}
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
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-zinc-800">Tự động sao lưu</h3>
      <div>
        <label htmlFor="backup-interval" className="mb-1.5 block text-xs font-medium text-zinc-600">
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
            <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-300 bg-surface-muted px-3 py-2 text-xs text-zinc-700">
              <span className="min-w-0 truncate">📁 {dirName}</span>
              <button
                type="button"
                onClick={() => {
                  void clearBackupDirectory().then(() => {
                    setDirName(null);
                    setMessage('Đã gỡ thư mục tự động — quay lại chế độ nhắc + tải file.');
                  });
                }}
                className="flex-shrink-0 rounded px-1.5 py-0.5 text-zinc-600 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
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
          <p className="text-[11px] leading-relaxed text-zinc-600">
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
      <p className="text-[11px] text-zinc-600">Lần sao lưu cuối: {lastBackup}</p>
      {message && <p className="notice-warn" role="status">{message}</p>}
    </div>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const updatePerf = useAppStore((s) => s.updatePerf);
  const activeProviderId = useAppStore((s) => s.activeProviderId);
  const [tab, setTab] = useState<SettingsTab>('chung');
  const show = (t: SettingsTab) => tab === t;

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

  /** Tablist: mũi trái/phải để đổi tab theo khuyến nghị WAI-ARIA. */
  const onTabKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = SETTINGS_TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % SETTINGS_TABS.length
        : (i - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    setTab(SETTINGS_TABS[next].id);
    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-zinc-900/50 p-4 backdrop-blur-sm"
    >
      {/*
        role="dialog" phải nằm trên chính hộp thoại, không phải lớp phủ: nếu đặt
        ở lớp phủ thì screen reader coi cả nền mờ là nội dung dialog.
      */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
        className="flex max-h-[90dvh] w-full max-w-lg animate-pop-in flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-2xl focus:outline-none"
      >
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3.5 sm:px-6">
          <h2 id="settings-dialog-title" className="text-base font-semibold text-zinc-900">
            Cài đặt ứng dụng
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng cài đặt"
            className="icon-btn-sm"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-shrink-0 px-5 pt-4 sm:px-6">
          <div
            className="no-scrollbar flex gap-1 overflow-x-auto rounded-xl bg-surface-raised p-1 ring-1 ring-zinc-200"
            role="tablist"
            aria-label="Nhóm cài đặt"
          >
            {SETTINGS_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`settings-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`settings-panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
                onKeyDown={onTabKeyDown}
                className={`flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  tab === t.id
                    ? 'bg-brand text-white shadow-sm'
                    : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div
          role="tabpanel"
          id={`settings-panel-${tab}`}
          aria-labelledby={`settings-tab-${tab}`}
          className="settings-panel min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6"
        >
          {show('chung') && (
            <>
              <div className="space-y-4">
                <div>
                  <label htmlFor="temperature" className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium text-zinc-700">Temperature</span>
                    <span className="font-mono text-xs tabular-nums text-zinc-600">
                      {settings.temperature.toFixed(2)}
                    </span>
                  </label>
                  <input
                    id="temperature"
                    type="range" min="0" max="1" step="0.05"
                    value={settings.temperature}
                    onChange={(e) => updateSettings({ temperature: parseFloat(e.target.value) })}
                    className="w-full accent-brand"
                  />
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                    Thấp = trả lời ổn định, sát dữ kiện. Cao = sáng tạo, biến thiên nhiều hơn.
                  </p>
                </div>

                <div>
                  <label htmlFor="system-prompt" className="mb-1.5 block text-sm font-medium text-zinc-700">
                    System Prompt
                  </label>
                  <textarea
                    id="system-prompt"
                    value={settings.systemPrompt}
                    onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
                    rows={4}
                    className="field resize-y"
                  />
                </div>

                <label htmlFor="agent-tools-toggle" className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-zinc-700">
                      Cho phép AI dùng công cụ
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-600">
                      Bật: AI tự tra web, đọc và sửa file trong thư mục bạn kết nối (agent coding).
                      Tắt: chat thuần — AI chỉ trả lời bằng kiến thức sẵn có, không gọi công cụ nào.
                    </span>
                  </span>
                  <input
                    id="agent-tools-toggle"
                    type="checkbox"
                    checked={settings.agentTools ?? true}
                    onChange={(e) => updateSettings({ agentTools: e.target.checked })}
                    className="mt-0.5 h-4 w-4 flex-shrink-0 rounded accent-brand"
                  />
                </label>

                {(settings.agentTools ?? true) && (
                  <label
                    htmlFor="force-emulated-tools"
                    className="flex items-start justify-between gap-3 border-l-2 border-zinc-200 pl-3"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-zinc-700">
                        Đường tool giả lập (gateway không hỗ trợ tools)
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-600">
                        Bật khi model cố gọi công cụ nhưng JSON hiện ra dạng chữ trong câu trả lời
                        (gateway âm thầm bỏ qua tham số tools). Tool sẽ chạy qua protocol text thay vì
                        function calling gốc.
                      </span>
                    </span>
                    <input
                      id="force-emulated-tools"
                      type="checkbox"
                      checked={settings.forceEmulatedTools ?? false}
                      onChange={(e) => updateSettings({ forceEmulatedTools: e.target.checked })}
                      className="mt-0.5 h-4 w-4 flex-shrink-0 rounded accent-brand"
                    />
                  </label>
                )}

                {(settings.agentTools ?? true) && (
                  <label
                    htmlFor="staging-sandbox-toggle"
                    className="flex items-start justify-between gap-3 border-l-2 border-zinc-200 pl-3"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-zinc-700">
                        Staging Sandbox (review batch trước khi ghi đĩa)
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-600">
                        Agent ghi thay đổi vào bộ đệm thay vì đĩa. Bạn review toàn bộ diff rồi bấm
                        Apply để ghi thật hoặc Reject để hủy. Đĩa không bị đụng cho tới khi Apply.
                        Tắt → hành vi cũ: phê duyệt từng edit qua diff modal, ghi đĩa ngay.
                      </span>
                    </span>
                    <input
                      id="staging-sandbox-toggle"
                      type="checkbox"
                      checked={settings.stagingSandbox ?? true}
                      onChange={(e) => updateSettings({ stagingSandbox: e.target.checked })}
                      className="mt-0.5 h-4 w-4 flex-shrink-0 rounded accent-brand"
                    />
                  </label>
                )}

                {/* Auto-pilot Mode */}
                {(settings.agentTools ?? true) && (
                  <>
                    <label htmlFor="auto-pilot-toggle" className="flex items-start justify-between gap-3 border-l-2 border-zinc-200 pl-3">
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-zinc-700">
                          Auto-pilot Mode
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-600">
                          Agent chạy nhiều bước liên tiếp không cần duyệt từng bước.
                          Kết hợp với Staging Sandbox để an toàn hơn.
                        </span>
                      </span>
                      <input
                        id="auto-pilot-toggle"
                        type="checkbox"
                        checked={settings.autoPilot ?? false}
                        onChange={(e) => updateSettings({ autoPilot: e.target.checked })}
                        className="mt-0.5 h-4 w-4 flex-shrink-0 rounded accent-brand"
                      />
                    </label>

                    {(settings.autoPilot ?? false) && (
                      <div className="border-l-2 border-zinc-200 pl-3">
                        <label htmlFor="approval-policy" className="block text-sm font-medium text-zinc-700 mb-1">
                          Approval Policy
                        </label>
                        <select
                          id="approval-policy"
                          value={settings.approvalPolicy ?? 'smart'}
                          onChange={(e) => updateSettings({ approvalPolicy: e.target.value as 'always' | 'smart' | 'never' })}
                          className="field w-full max-w-xs"
                        >
                          <option value="smart">Smart — tự duyệt read + safe commands, hỏi khi ghi/destructive</option>
                          <option value="never">Never ask (YOLO) — tự duyệt tất cả trừ lệnh nguy hiểm</option>
                          <option value="always">Always ask — luôn hỏi (như tắt auto-pilot)</option>
                        </select>
                        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                          {(settings.approvalPolicy ?? 'smart') === 'smart' && '✅ Read-only tools và safe commands (npm test, git status...) tự động duyệt. Write/destructive vẫn hỏi.'}
                          {(settings.approvalPolicy ?? 'smart') === 'never' && '⚡ Tất cả tool calls tự động duyệt TRỪ lệnh luôn-chặn (rm -rf /, mkfs, shutdown...). Dùng với Staging Sandbox.'}
                          {(settings.approvalPolicy ?? 'smart') === 'always' && '🔒 Luôn hỏi trước khi chạy bất kỳ tool nào. Tương đương tắt auto-pilot.'}
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Per-Tool Permission Overrides */}
              {(settings.agentTools ?? true) && (settings.autoPilot ?? false) && (
                <div className="space-y-3 border-l-2 border-zinc-200 pl-3">
                  <h3 className="text-sm font-semibold text-zinc-700">Per-Tool Permissions</h3>
                  <p className="text-[11px] leading-relaxed text-zinc-500">
                    Override auto-approve behavior per tool category. &quot;Default&quot; follows the approval policy above.
                  </p>
                  <div className="space-y-1.5">
                    {ALL_TOOL_CATEGORIES.map((cat) => {
                      const info = TOOL_CATEGORY_LABELS[cat];
                      const current = settings.toolPermissions?.[cat] ?? 'default';
                      return (
                        <div key={cat} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                          <span className="min-w-0 flex-1 text-xs text-zinc-700">
                            <span className="mr-1.5">{info.icon}</span>
                            <span className="font-medium">{info.label}</span>
                            <span className="ml-1 text-[10px] text-zinc-400">({info.tools})</span>
                          </span>
                          <select
                            value={current}
                            onChange={(e) => {
                              const val = e.target.value as PermissionOverride;
                              updateSettings({ toolPermissions: { ...settings.toolPermissions, [cat]: val } });
                            }}
                            className="field-sm w-28 text-[11px]"
                          >
                            <option value="default">Default</option>
                            <option value="auto">Auto-approve</option>
                            <option value="ask">Always ask</option>
                            <option value="deny">Block</option>
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <McpSettingsPanel />

              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-zinc-800">Nhập &amp; hiệu năng</h3>

                <label htmlFor="send-on-enter" className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-zinc-700">
                      Enter để gửi tin nhắn
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-600">
                      Tắt thì Enter xuống dòng, gửi bằng Ctrl/⌘ + Enter.
                    </span>
                  </span>
                  <input
                    id="send-on-enter"
                    type="checkbox"
                    checked={settings.sendOnEnter}
                    onChange={(e) => updateSettings({ sendOnEnter: e.target.checked })}
                    className="mt-0.5 h-4 w-4 flex-shrink-0 rounded accent-brand"
                  />
                </label>

                <label htmlFor="auto-compact-toggle" className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-zinc-700">
                      Nén hội thoại tự động
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-600">
                      Khi hội thoại gần trần ngữ cảnh của model, tự tóm tắt phần cũ và chỉ gửi
                      tóm tắt + tin mới lên AI. Luôn có nút &ldquo;Nén bây giờ&rdquo; ở header.
                    </span>
                  </span>
                  <input
                    id="auto-compact-toggle"
                    type="checkbox"
                    checked={settings.autoCompact}
                    onChange={(e) => updateSettings({ autoCompact: e.target.checked })}
                    className="mt-0.5 h-4 w-4 flex-shrink-0 rounded accent-brand"
                  />
                </label>

                <label htmlFor="anim-toggle" className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-zinc-700">
                      Hiệu ứng chuyển động
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-600">
                      Tắt để giảm chuyển động trên máy yếu. Hệ thống cũng tự tôn trọng thiết lập
                      &ldquo;giảm chuyển động&rdquo; của thiết bị.
                    </span>
                  </span>
                  <input
                    id="anim-toggle"
                    type="checkbox"
                    checked={settings.perf?.animations ?? true}
                    onChange={(e) => updatePerf({ animations: e.target.checked })}
                    className="mt-0.5 h-4 w-4 flex-shrink-0 rounded accent-brand"
                  />
                </label>

                <div>
                  <label htmlFor="throttle-ms" className="mb-1.5 block text-sm font-medium text-zinc-700">
                    Tần suất vẽ lại khi AI đang trả lời
                  </label>
                  <select
                    id="throttle-ms"
                    value={settings.perf?.throttleMs ?? 150}
                    onChange={(e) => updatePerf({ throttleMs: Number(e.target.value) })}
                    className="field"
                  >
                    <option value={80}>Mượt nhất — 80ms (máy khỏe)</option>
                    <option value={150}>Cân bằng — 150ms (mặc định)</option>
                    <option value={250}>Tiết kiệm — 250ms</option>
                    <option value={400}>Nhẹ nhất — 400ms (máy yếu)</option>
                  </select>
                </div>
              </div>
            </>
          )}

          {show('provider') && (
            <>
              {activeProviderId === SERVER_PROVIDER_ID && (
                <div>
                  <label htmlFor="server-api-key" className="mb-1.5 block text-sm font-medium text-zinc-700">
                    API Key — chỉ cho Máy chủ mặc định
                  </label>
                  <input
                    id="server-api-key"
                    type="password"
                    value={settings.apiKey || ''}
                    onChange={(e) => updateSettings({ apiKey: e.target.value })}
                    placeholder="sk-..."
                    className="field font-mono"
                  />
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                    Chỉ lưu trong phiên này, không ghi vào bộ nhớ máy.
                  </p>
                </div>
              )}

              <div>
                <h3 className="mb-1.5 text-sm font-semibold text-zinc-800">Nhà cung cấp API</h3>
                <p className="mb-2 text-[11px] leading-relaxed text-zinc-600">
                  Lưu nhiều nhà cung cấp chuẩn OpenAI-compatible, tải danh sách model và chuyển
                  nhanh mà không cần cấu hình lại server.
                </p>
                <ul className="mb-2.5 list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-zinc-600">
                  <li>
                    <strong className="font-medium text-zinc-800">OpenRouter:</strong> key free tại{' '}
                    <a
                      href="https://openrouter.ai/keys"
                      target="_blank"
                      rel="noreferrer noopener nofollow"
                      className="text-brand underline-offset-2 hover:underline"
                    >
                      openrouter.ai/keys
                    </a>{' '}
                    — chọn model đuôi <code className="claude-inline-code">:free</code> (50 lượt/ngày;
                    nạp $10 một lần duy nhất → 1.000 lượt/ngày free vĩnh viễn).
                  </li>
                  <li>
                    <strong className="font-medium text-zinc-800">airforce:</strong> key free tại{' '}
                    <a
                      href="https://api.airforce/signup"
                      target="_blank"
                      rel="noreferrer noopener nofollow"
                      className="text-brand underline-offset-2 hover:underline"
                    >
                      api.airforce/signup
                    </a>{' '}
                    — 1.000 lượt/ngày, 1 lượt/phút, model cơ bản.
                  </li>
                </ul>
                <ProviderManager />
              </div>

              <div>
                <label htmlFor="access-code" className="mb-1.5 block text-sm font-medium text-zinc-700">
                  Mã truy cập (Access Code)
                </label>
                <input
                  id="access-code"
                  type="password"
                  value={settings.accessCode || ''}
                  onChange={(e) => updateSettings({ accessCode: e.target.value })}
                  placeholder="Nhập mã truy cập..."
                  className="field font-mono"
                />
              </div>
            </>
          )}

          {show('stats') && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-zinc-800">Thống kê token sử dụng</h3>
              <UsageStats />
            </div>
          )}

          {show('prompts') && <PromptLibrarySection />}

          {show('memory') && <MemoriesSection />}

          {show('app') && <InstallSection />}

          {show('data') && (
            <>
              <AutoBackupSection />

              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-zinc-800">Sao lưu &amp; Phục hồi</h3>
                <p className="text-xs leading-relaxed text-zinc-600">
                  Bản <code className="claude-inline-code">.json</code> lưu đầy đủ cây phân nhánh và tệp kèm —
                  dùng để phục hồi. Bản <code className="claude-inline-code">.md</code> chỉ xuất nhánh đang
                  xem, dùng để đọc hoặc in.
                </p>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run('Đang xuất JSON…', () => exportJson())}
                    className="btn-secondary"
                  >
                    <Download size={14} /> Xuất tất cả .json
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run('Đang xuất Markdown…', () => exportMarkdown())}
                    className="btn-secondary"
                  >
                    <Download size={14} /> Xuất tất cả .md
                  </button>
                </div>

                <div>
                  <label htmlFor="import-mode" className="mb-1.5 block text-xs font-medium text-zinc-600">
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
                        ? 'text-red-700 dark:text-red-400'
                        : status.kind === 'ok'
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-zinc-600'
                    }`}
                    role="status"
                  >
                    {status.message}
                  </p>
                )}
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold text-red-700 dark:text-red-400">Vùng nguy hiểm</h3>
                <div className="mb-2 flex items-start gap-2 text-xs text-zinc-600">
                  <ShieldAlert size={14} className="mt-0.5 flex-shrink-0 text-red-600 dark:text-red-400" />
                  <span>Hãy xuất bản sao lưu .json trước khi thực hiện hành động này.</span>
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
                        // Tab khác đang giữ IndexedDB mở → delete bị chặn vĩnh viễn.
                        // Trước đây lỗi này nuốt lặng lẽ: bấm nút không có gì xảy ra.
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
                  className="w-full rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700 transition hover:bg-red-100 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
                >
                  Xóa toàn bộ dữ liệu ứng dụng
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
