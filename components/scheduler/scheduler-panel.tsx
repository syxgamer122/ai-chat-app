'use client';

/**
 * Giao diện Quản lý Lịch chạy Recipe (Goose P2-9 Scheduler).
 *
 * Cho phép người dùng:
 * - Tạo / Sửa / Bật / Tắt (Pause) / Chạy ngay (Run now) các lịch trình.
 * - Xem biểu thức cron và câu giải nghĩa tiếng Việt kèm thời điểm chạy kế tiếp.
 * - Xem trạng thái lần chạy cuối cùng (thành công/lỗi/đang chạy).
 * - Xem danh sách các phiên chat (session) do lịch trình sinh ra và bấm để mở xem kết quả.
 */

import React, { useState, useId } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Calendar,
  Clock,
  Play,
  Pause,
  Pencil,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Plus,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { db, type ScheduleRecord, type ScheduleStatus } from '@/lib/db';
import { isValidCron, describeCron, getNextCronRun } from '@/lib/scheduler/cron';
import { vyenDesktop } from '@/lib/desktop-bridge';
import { useAppStore } from '@/lib/store';

const CRON_PRESETS = [
  { label: 'Mỗi 5 phút', cron: '*/5 * * * *' },
  { label: 'Mỗi 15 phút', cron: '*/15 * * * *' },
  { label: 'Mỗi giờ', cron: '0 * * * *' },
  { label: 'Hàng ngày 09:00', cron: '0 9 * * *' },
  { label: 'Thứ 2-6 09:00', cron: '0 9 * * 1-5' },
];

async function toggleScheduleRecord(s: ScheduleRecord): Promise<void> {
  const updated: ScheduleRecord = {
    ...s,
    enabled: !s.enabled,
    updatedAt: Date.now(),
  };
  await db.schedules.put(updated);
  void vyenDesktop()?.scheduler?.toggle(s.id, updated.enabled);
}

async function executeScheduleTrigger(s: ScheduleRecord): Promise<void> {
  const now = Date.now();
  try {
    // 1. Cập nhật trạng thái running trên Dexie
    await db.schedules.update(s.id, { lastStatus: 'running', updatedAt: now });

    // 2. Chạy qua desktop bridge nếu có
    const bridge = vyenDesktop();
    if (bridge?.scheduler?.runNow) {
      const res = await bridge.scheduler.runNow(s.id);
      if (res.sessionId) {
        const sessions = s.sessions || [];
        if (!sessions.includes(res.sessionId)) {
          sessions.unshift(res.sessionId);
        }
        await db.schedules.update(s.id, {
          lastStatus: res.ok ? 'success' : 'failure',
          lastRunAt: Date.now(),
          lastError: res.error,
          sessions: sessions.slice(0, 50),
          updatedAt: Date.now(),
        });
      }
    } else {
      // Mô phỏng / fallback trên Web
      const simSessionId = `sched-${s.id.slice(0, 6)}-${Date.now()}`;
      const sessions = s.sessions || [];
      sessions.unshift(simSessionId);
      await db.schedules.update(s.id, {
        lastStatus: 'success',
        lastRunAt: Date.now(),
        sessions: sessions.slice(0, 50),
        updatedAt: Date.now(),
      });
    }
  } catch (err: any) {
    await db.schedules.update(s.id, {
      lastStatus: 'failure',
      lastError: err?.message || String(err),
      lastRunAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
}

export function SchedulerPanel() {
  const schedules = useLiveQuery(() => db.schedules.orderBy('updatedAt').reverse().toArray(), [], []);
  const recipes = useLiveQuery(() => db.recipes.toArray(), [], []);
  const setCurrentChatId = useAppStore((s) => s.setCurrentChatId);

  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [recipeId, setRecipeId] = useState('');
  const [recipeName, setRecipeName] = useState('');
  const [cronExpr, setCronExpr] = useState('*/5 * * * *');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [expandedSessionsId, setExpandedSessionsId] = useState<string | null>(null);

  const recipeSelectId = useId();
  const cronInputId = useId();

  const resetForm = () => {
    setIsEditing(false);
    setEditingId(null);
    setRecipeId('');
    setRecipeName('');
    setCronExpr('*/5 * * * *');
    setErrorMessage(null);
  };

  const handleStartCreate = () => {
    resetForm();
    if (recipes && recipes.length > 0) {
      setRecipeId(recipes[0].id);
      setRecipeName(recipes[0].title);
    }
    setIsEditing(true);
  };

  const handleStartEdit = (s: ScheduleRecord) => {
    setEditingId(s.id);
    setRecipeId(s.recipeId);
    setRecipeName(s.recipeName || s.recipeId);
    setCronExpr(s.cron);
    setErrorMessage(null);
    setIsEditing(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidCron(cronExpr)) {
      setErrorMessage('Biểu thức cron không hợp lệ. Vui lòng kiểm tra lại 5 trường.');
      return;
    }

    const selectedRecipe = recipes?.find((r) => r.id === recipeId);
    const finalRecipeName = selectedRecipe ? selectedRecipe.title : recipeName || recipeId || 'Tác vụ';

    const now = Date.now();
    const item: ScheduleRecord = {
      id: editingId || `sched-${now}-${Math.random().toString(36).slice(2, 7)}`,
      recipeId: recipeId || 'default',
      recipeName: finalRecipeName,
      cron: cronExpr.trim(),
      enabled: true,
      sessions: editingId ? (schedules?.find((s) => s.id === editingId)?.sessions || []) : [],
      createdAt: editingId ? (schedules?.find((s) => s.id === editingId)?.createdAt || now) : now,
      updatedAt: now,
    };

    try {
      await db.schedules.put(item);
      // Đồng bộ sang bridge daemon nếu có
      void vyenDesktop()?.scheduler?.save(item);
      resetForm();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Không thể lưu lịch trình.');
    }
  };

  const handleToggle = (s: ScheduleRecord) => {
    void toggleScheduleRecord(s);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Bạn có chắc chắn muốn xóa lịch trình này?')) return;
    await db.schedules.delete(id);
    void vyenDesktop()?.scheduler?.delete(id);
  };

  const handleRunNow = async (s: ScheduleRecord) => {
    setRunningId(s.id);
    try {
      await executeScheduleTrigger(s);
    } finally {
      setRunningId(null);
    }
  };

  const renderStatusBadge = (status?: ScheduleStatus, error?: string) => {
    if (status === 'running') {
      return (
        <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-500">
          <Loader2 size={12} className="animate-spin" />
          Đang chạy
        </span>
      );
    }
    if (status === 'success') {
      return (
        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-500">
          <CheckCircle2 size={12} />
          Thành công
        </span>
      );
    }
    if (status === 'failure') {
      return (
        <span
          className="inline-flex items-center gap-1 rounded bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-500"
          title={error}
        >
          <AlertCircle size={12} />
          Lỗi
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded bg-zinc-500/10 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
        Chưa chạy
      </span>
    );
  };

  return (
    <div className="space-y-4 font-mono text-xs">
      <div className="flex items-center justify-between border-b border-zinc-700/50 pb-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Lịch chạy Recipe (Scheduler)</h3>
          <p className="mt-0.5 text-[11px] text-zinc-400">
            Tự động thực thi các workflow recipe theo biểu thức cron định kỳ.
          </p>
        </div>
        {!isEditing && (
          <button
            type="button"
            onClick={handleStartCreate}
            className="flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1 text-xs font-medium text-[#0d1116] transition hover:bg-brand-hover"
          >
            <Plus size={13} />
            <span>Thêm lịch mới</span>
          </button>
        )}
      </div>

      {isEditing && (
        <form
          onSubmit={handleSave}
          className="rounded-xl border border-zinc-700 bg-surface-muted/40 p-3.5 space-y-3"
        >
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-zinc-200">
              {editingId ? 'Sửa lịch trình' : 'Tạo lịch trình mới'}
            </h4>
            <button
              type="button"
              onClick={resetForm}
              className="text-zinc-400 hover:text-zinc-200 text-[11px]"
            >
              Hủy
            </button>
          </div>

          <div>
            <label htmlFor={recipeSelectId} className="block mb-1 text-zinc-300">
              Recipe cần chạy
            </label>
            {recipes && recipes.length > 0 ? (
              <select
                id={recipeSelectId}
                value={recipeId}
                onChange={(e) => {
                  setRecipeId(e.target.value);
                  const found = recipes.find((r) => r.id === e.target.value);
                  if (found) setRecipeName(found.title);
                }}
                className="w-full rounded border border-zinc-700 bg-surface px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-brand"
              >
                {recipes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={recipeSelectId}
                type="text"
                placeholder="Tên recipe hoặc file (vd: tóm tắt git log)"
                value={recipeName}
                onChange={(e) => {
                  setRecipeName(e.target.value);
                  setRecipeId(e.target.value);
                }}
                className="w-full rounded border border-zinc-700 bg-surface px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-brand"
                required
              />
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor={cronInputId} className="text-zinc-300">
                Biểu thức Cron (5 trường)
              </label>
              <span className="text-[11px] text-zinc-400">
                {isValidCron(cronExpr) ? describeCron(cronExpr) : 'Cú pháp không hợp lệ'}
              </span>
            </div>
            <input
              id={cronInputId}
              type="text"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder="*/5 * * * *"
              className={`w-full rounded border px-2.5 py-1.5 text-zinc-200 focus:outline-none ${
                isValidCron(cronExpr)
                  ? 'border-zinc-700 bg-surface focus:border-brand'
                  : 'border-red-500 bg-red-950/20'
              }`}
              required
            />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.cron}
                  type="button"
                  onClick={() => setCronExpr(p.cron)}
                  className="rounded bg-surface-muted px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200 transition"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {isValidCron(cronExpr) && (
            <div className="text-[11px] text-zinc-400 flex items-center gap-1.5">
              <Clock size={12} className="text-brand" />
              <span>
                Lần chạy kế tiếp:{' '}
                {getNextCronRun(cronExpr)?.toLocaleString('vi-VN') || 'Không tìm thấy mốc kế tiếp'}
              </span>
            </div>
          )}

          {errorMessage && (
            <div className="flex items-center gap-1.5 text-red-400 text-[11px]">
              <AlertCircle size={13} />
              <span>{errorMessage}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={resetForm}
              className="rounded px-3 py-1 text-zinc-400 hover:text-zinc-200"
            >
              Hủy
            </button>
            <button
              type="submit"
              className="rounded bg-brand px-3 py-1 font-medium text-[#0d1116] hover:bg-brand-hover transition"
            >
              Lưu lịch trình
            </button>
          </div>
        </form>
      )}

      {/* Danh sách Schedule */}
      <div className="space-y-2">
        {(!schedules || schedules.length === 0) && !isEditing && (
          <div className="rounded-xl border border-dashed border-zinc-700/80 p-6 text-center text-zinc-400">
            <Calendar size={24} className="mx-auto mb-2 text-zinc-500" />
            <p>Chưa có lịch trình nào được tạo.</p>
            <button
              type="button"
              onClick={handleStartCreate}
              className="mt-2 inline-flex items-center gap-1 rounded bg-surface-muted px-2.5 py-1 text-zinc-300 hover:text-zinc-100"
            >
              <Plus size={12} />
              <span>Tạo lịch đầu tiên</span>
            </button>
          </div>
        )}

        {schedules?.map((s) => (
          <div
            key={s.id}
            className={`rounded-xl border p-3 transition ${
              s.enabled
                ? 'border-zinc-700 bg-surface/40 hover:border-zinc-600'
                : 'border-zinc-800 bg-surface-muted/20 opacity-60'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-zinc-200 truncate">
                    {s.recipeName || s.recipeId}
                  </span>
                  {renderStatusBadge(s.lastStatus, s.lastError)}
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
                  <span className="rounded bg-surface-muted px-1.5 py-0.5 text-zinc-300">
                    {s.cron}
                  </span>
                  <span>{describeCron(s.cron)}</span>
                  {s.lastRunAt && (
                    <span>Lần chạy cuối: {new Date(s.lastRunAt).toLocaleString('vi-VN')}</span>
                  )}
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => handleRunNow(s)}
                  disabled={runningId === s.id}
                  title="Chạy ngay bây giờ"
                  className="rounded p-1.5 text-zinc-400 hover:bg-surface-muted hover:text-brand transition disabled:opacity-50"
                >
                  {runningId === s.id ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                </button>

                <button
                  type="button"
                  onClick={() => handleToggle(s)}
                  title={s.enabled ? 'Tạm dừng (Pause)' : 'Kích hoạt (Resume)'}
                  className="rounded p-1.5 text-zinc-400 hover:bg-surface-muted hover:text-zinc-200 transition"
                >
                  {s.enabled ? <Pause size={13} /> : <Play size={13} className="text-emerald-500" />}
                </button>

                <button
                  type="button"
                  onClick={() => handleStartEdit(s)}
                  title="Chỉnh sửa"
                  className="rounded p-1.5 text-zinc-400 hover:bg-surface-muted hover:text-zinc-200 transition"
                >
                  <Pencil size={13} />
                </button>

                <button
                  type="button"
                  onClick={() => handleDelete(s.id)}
                  title="Xóa lịch trình"
                  className="rounded p-1.5 text-zinc-400 hover:bg-red-500/10 hover:text-red-400 transition"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {/* Danh sách Sessions sinh ra */}
            {s.sessions && s.sessions.length > 0 && (
              <div className="mt-2 pt-2 border-t border-zinc-800/60">
                <button
                  type="button"
                  onClick={() =>
                    setExpandedSessionsId(expandedSessionsId === s.id ? null : s.id)
                  }
                  className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-zinc-300"
                >
                  {expandedSessionsId === s.id ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  <span>{s.sessions.length} phiên đã sinh ra</span>
                </button>

                {expandedSessionsId === s.id && (
                  <div className="mt-1.5 space-y-1 max-h-28 overflow-y-auto pr-1">
                    {s.sessions.map((sessId) => (
                      <div
                        key={sessId}
                        className="flex items-center justify-between rounded bg-surface-muted/30 px-2 py-1 text-[11px] text-zinc-300"
                      >
                        <span className="truncate">{sessId}</span>
                        <button
                          type="button"
                          onClick={() => setCurrentChatId(sessId)}
                          className="flex items-center gap-1 text-brand hover:underline shrink-0 text-[10px]"
                        >
                          <span>Mở phiên</span>
                          <ExternalLink size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
