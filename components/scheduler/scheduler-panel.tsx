'use client';

/**
 * Giao diện Quản lý Lịch chạy Recipe (P2-9 Scheduler).
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
  // (giữ nguyên phần thân hàm bên dưới)
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
  /*
   * Kill-switch toàn cục (S3/B5): dừng mọi lịch headless. Không có state này,
   * mọi "trần ngân sách" chỉ chạy được khi scheduler đang bật — cần một nút
   * dừng khẩn cấp để người dùng cắt ngay khi nghi lịch đang làm hỏng việc.
   * Sentinel file do bridge quản lý (`.vyen/scheduler-paused`).
   */
  const [killSwitchOn, setKillSwitchOn] = useState(false);
  const [killSwitchBusy, setKillSwitchBusy] = useState(false);
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
        <span className="inline-flex items-center gap-1 rounded-none border border-status-warning/30 bg-[#e8993a]/15 px-2 py-0.5 text-[11px] font-medium text-status-warning">
          <Loader2 size={12} className="animate-spin" />
          Đang chạy
        </span>
      );
    }
    if (status === 'success') {
      return (
        <span className="inline-flex items-center gap-1 rounded-none border border-status-success/30 bg-[#5db87a]/15 px-2 py-0.5 text-[11px] font-medium text-status-success">
          <CheckCircle2 size={12} />
          Thành công
        </span>
      );
    }
    if (status === 'failure') {
      return (
        <span
          className="inline-flex items-center gap-1 rounded-none border border-status-error/30 bg-[#e8704f]/15 px-2 py-0.5 text-[11px] font-medium text-status-error"
          title={error}
        >
          <AlertCircle size={12} />
          Lỗi
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-none border border-border-hairline/40 bg-panel-bg px-2 py-0.5 text-[11px] font-medium text-text-muted">
        Chưa chạy
      </span>
    );
  };

  return (
    <div className="space-y-4 font-mono text-xs">
      <div className="flex items-center justify-between border-b border-border-hairline pb-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Lịch chạy Recipe (Scheduler)</h3>
          <p className="mt-0.5 text-[11px] text-text-muted">
            Tự động thực thi các workflow recipe theo biểu thức cron định kỳ.
          </p>
        </div>
        {!isEditing && (
          <button
            type="button"
            onClick={handleStartCreate}
            className="flex items-center gap-1.5 rounded-none bg-[#6a9fcc] px-2.5 py-1 text-xs font-semibold text-[#0d1116] transition hover:bg-[#6a9fcc]/85"
          >
            <Plus size={13} />
            <span>Thêm lịch mới</span>
          </button>
        )}
      </div>

      {/*
       * Dừng khẩn cấp toàn bộ lịch. Khi BẬT, mọi tick bị bỏ trống và
       * `executeScheduledRun` từ chối ở cửa — kể cả lệnh "Run now" thủ công.
       */}
      <div className="flex items-center justify-between gap-3 border border-border-hairline bg-surface-raised px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-text-primary">
            {killSwitchOn ? <AlertCircle size={13} className="text-status-error" /> : <CheckCircle2 size={13} />}
            <span>{killSwitchOn ? 'Scheduler đang tạm dừng' : 'Scheduler đang hoạt động'}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-text-muted">
            {killSwitchOn
              ? 'Không lịch nào chạy, kể cả Run now. Bật lại để tiếp tục cron.'
              : 'Có thể dừng khẩn cấp mọi lịch khi nghi một job đang chạy lỗi.'}
          </p>
        </div>
        <button
          type="button"
          disabled={killSwitchBusy}
          aria-pressed={killSwitchOn}
          onClick={async () => {
            const bridge = vyenDesktop();
            if (!bridge?.scheduler?.setKillSwitch) return;
            setKillSwitchBusy(true);
            try {
              const next = !killSwitchOn;
              const res = await bridge.scheduler.setKillSwitch(next);
              setKillSwitchOn(Boolean(res?.paused ?? next));
            } catch {
              // Bridge lỗi: giữ trạng thái cũ, không giả vờ đã bật/tắt.
            } finally {
              setKillSwitchBusy(false);
            }
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-none border border-border-hairline px-2.5 py-1 text-xs font-semibold text-text-primary transition hover:bg-surface-overlay disabled:opacity-50"
        >
          {killSwitchBusy ? <Loader2 size={13} className="animate-spin" /> : killSwitchOn ? <Play size={13} /> : <Pause size={13} />}
          <span>{killSwitchOn ? 'Tiếp tục' : 'Dừng khẩn cấp'}</span>
        </button>
      </div>

      {isEditing && (
        <form
          onSubmit={handleSave}
          className="rounded-none border border-border-hairline bg-surface-raised p-3.5 space-y-3"
        >
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-text-primary">
              {editingId ? 'Sửa lịch trình' : 'Tạo lịch trình mới'}
            </h4>
            <button
              type="button"
              onClick={resetForm}
              className="text-text-muted hover:text-text-primary text-[11px]"
            >
              Hủy
            </button>
          </div>

          <div>
            <label htmlFor={recipeSelectId} className="block mb-1 text-text-primary">
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
                className="w-full rounded-none border border-border-hairline bg-bg-deep px-2.5 py-1.5 text-text-primary focus:outline-none focus:border-accent-steel"
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
                className="w-full rounded-none border border-border-hairline bg-bg-deep px-2.5 py-1.5 text-text-primary focus:outline-none focus:border-accent-steel"
                required
              />
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor={cronInputId} className="text-text-primary">
                Biểu thức Cron (5 trường)
              </label>
              <span className="text-[11px] text-text-muted">
                {isValidCron(cronExpr) ? describeCron(cronExpr) : 'Cú pháp không hợp lệ'}
              </span>
            </div>
            <input
              id={cronInputId}
              type="text"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder="*/5 * * * *"
              className={`w-full rounded-none border px-2.5 py-1.5 text-text-primary focus:outline-none ${
                isValidCron(cronExpr)
                  ? 'border-border-hairline bg-bg-deep focus:border-accent-steel'
                  : 'border-status-error bg-[#e8704f]/10'
              }`}
              required
            />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.cron}
                  type="button"
                  onClick={() => setCronExpr(p.cron)}
                  className="rounded-none border border-border-hairline bg-panel-bg px-2 py-0.5 text-[10px] text-text-muted hover:text-text-primary hover:bg-panel-soft transition"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {isValidCron(cronExpr) && (
            <div className="text-[11px] text-text-muted flex items-center gap-1.5">
              <Clock size={12} className="text-accent-steel" />
              <span>
                Lần chạy kế tiếp:{' '}
                {getNextCronRun(cronExpr)?.toLocaleString('vi-VN') || 'Không tìm thấy mốc kế tiếp'}
              </span>
            </div>
          )}

          {errorMessage && (
            <div className="flex items-center gap-1.5 text-status-error text-[11px]">
              <AlertCircle size={13} />
              <span>{errorMessage}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={resetForm}
              className="rounded-none border border-border-hairline bg-panel-bg px-3 py-1 text-text-muted hover:text-text-primary hover:bg-panel-soft"
            >
              Hủy
            </button>
            <button
              type="submit"
              className="rounded-none bg-[#6a9fcc] px-3 py-1 font-semibold text-[#0d1116] hover:bg-[#6a9fcc]/85 transition"
            >
              Lưu lịch trình
            </button>
          </div>
        </form>
      )}

      {/* Danh sách Schedule */}
      <div className="space-y-2">
        {(!schedules || schedules.length === 0) && !isEditing && (
          <div className="rounded-none border border-dashed border-border-hairline bg-surface-raised p-6 text-center text-text-muted">
            <Calendar size={24} className="mx-auto mb-2 text-[#757d89]" />
            <p>Chưa có lịch trình nào được tạo.</p>
            <button
              type="button"
              onClick={handleStartCreate}
              className="mt-2 inline-flex items-center gap-1 rounded-none border border-border-hairline bg-panel-bg px-2.5 py-1 text-text-primary hover:bg-panel-soft"
            >
              <Plus size={12} />
              <span>Tạo lịch đầu tiên</span>
            </button>
          </div>
        )}

        {schedules?.map((s) => (
          <div
            key={s.id}
            className={`rounded-none border p-3 transition ${
              s.enabled
                ? 'border-border-hairline bg-surface-raised hover:border-border-hover'
                : 'border-border-hairline/40 bg-surface-raised/40 opacity-60'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-text-primary truncate">
                    {s.recipeName || s.recipeId}
                  </span>
                  {renderStatusBadge(s.lastStatus, s.lastError)}
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
                  <span className="rounded-none border border-border-hairline bg-panel-bg px-1.5 py-0.5 text-text-primary">
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
                  className="rounded-none border border-border-hairline bg-panel-bg p-1.5 text-text-muted hover:bg-panel-soft hover:text-accent-steel transition disabled:opacity-50"
                >
                  {runningId === s.id ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                </button>

                <button
                  type="button"
                  onClick={() => handleToggle(s)}
                  title={s.enabled ? 'Tạm dừng (Pause)' : 'Kích hoạt (Resume)'}
                  className="rounded-none border border-border-hairline bg-panel-bg p-1.5 text-text-muted hover:bg-panel-soft hover:text-text-primary transition"
                >
                  {s.enabled ? <Pause size={13} /> : <Play size={13} className="text-status-success" />}
                </button>

                <button
                  type="button"
                  onClick={() => handleStartEdit(s)}
                  title="Chỉnh sửa"
                  className="rounded-none border border-border-hairline bg-panel-bg p-1.5 text-text-muted hover:bg-panel-soft hover:text-text-primary transition"
                >
                  <Pencil size={13} />
                </button>

                <button
                  type="button"
                  onClick={() => handleDelete(s.id)}
                  title="Xóa lịch trình"
                  className="rounded-none border border-border-hairline bg-panel-bg p-1.5 text-text-muted hover:bg-[#e8704f]/10 hover:text-status-error transition"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {/* Danh sách Sessions sinh ra */}
            {s.sessions && s.sessions.length > 0 && (
              <div className="mt-2 pt-2 border-t border-border-hairline">
                <button
                  type="button"
                  onClick={() =>
                    setExpandedSessionsId(expandedSessionsId === s.id ? null : s.id)
                  }
                  className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary"
                >
                  {expandedSessionsId === s.id ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  <span>{s.sessions.length} phiên đã sinh ra</span>
                </button>

                {expandedSessionsId === s.id && (
                  <div className="mt-1.5 space-y-1 max-h-28 overflow-y-auto pr-1">
                    {s.sessions.map((sessId) => (
                      <div
                        key={sessId}
                        className="flex items-center justify-between rounded-none border border-border-hairline/50 bg-panel-bg px-2 py-1 text-[11px] text-text-primary"
                      >
                        <span className="truncate">{sessId}</span>
                        <button
                          type="button"
                          onClick={() => setCurrentChatId(sessId)}
                          className="flex items-center gap-1 text-accent-steel hover:underline shrink-0 text-[10px]"
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
