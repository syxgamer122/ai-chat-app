'use client';

/**
 * Settings → Ghi nhớ: reviewer gate
 *
 * Duyệt / từ chối / hoãn các đề xuất ghi nhớ do agent tạo.
 *
 * (Tách ra từ components/settings-dialog.tsx — file đó từng dài 1.668 dòng.)
 */

import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertCircle, Ban, Check, Clock, Sparkles, Trash2 } from 'lucide-react';
import { db, MAX_MEMORY_CHARS } from '@/lib/db';
import { proposeCandidate, reviewCandidate, deleteReviewedRecord } from '@/lib/memory/store';
import type { MemoryKind } from '@/lib/memory/types';

export function MemoriesSection() {
  const candidates = useLiveQuery(
    () => db.memoryCandidates?.where('status').equals('pending').reverse().sortBy('createdAt'),
    [],
    [],
  );
  const records = useLiveQuery(
    () => db.memoryRecords?.reverse().sortBy('createdAt'),
    [],
    [],
  );

  const [newText, setNewText] = useState('');
  const [newKind, setNewKind] = useState<MemoryKind>('pattern');
  const [refusePromptId, setRefusePromptId] = useState<string | null>(null);
  const [refuseReason, setRefuseReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handlePropose = async () => {
    if (!newText.trim()) return;
    try {
      await proposeCandidate({
        text: newText.trim(),
        kind: newKind,
        scope: { kind: 'project', ref: 'global' },
        provenance: { threadId: 'settings' },
      });
      setNewText('');
      setError(null);
    } catch (e) {
      console.error('[memory propose]', e);
      setError('Không thể tạo candidate ghi nhớ.');
    }
  };

  const handleReview = async (id: string, action: 'remember' | 'refuse' | 'defer', reason?: string) => {
    try {
      if (action === 'refuse' && !reason?.trim()) {
        setError('Từ chối ghi nhớ bắt buộc phải có lý do cụ thể.');
        return;
      }
      await reviewCandidate(id, action, { reason: reason?.trim() });
      setRefusePromptId(null);
      setRefuseReason('');
      setError(null);
    } catch (e) {
      console.error('[memory review]', e);
      setError(e instanceof Error ? e.message : 'Lỗi khi kiểm duyệt ghi nhớ.');
    }
  };

  const kindIcons: Record<MemoryKind, string> = {
    rule: '📏',
    pattern: '🔧',
    gotcha: '⚠️',
    decision: '💡',
    term: '📖',
  };

  return (
    <div className="space-y-4">
      <div>
        <h4 className="field-label text-[15px]">
          Duyệt đề xuất ghi nhớ (Reviewer Gate)
        </h4>
        <p className="mt-0.5 text-xs leading-relaxed text-text-muted">
          Không ghi nhớ im lặng: Agent chỉ đề xuất candidate. Bạn trực tiếp duyệt (Nhớ / Từ chối / Hoãn).
          Chỉ ký ức đã duyệt mới vào Recall Pack theo ngân sách token.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-1.5 border border-status-error/30 bg-[#e8704f]/10 p-2 text-xs text-status-error">
          <AlertCircle size={14} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* 1. Review Cards for Pending Candidates */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h5 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
            <Clock size={13} className="text-status-warning" />
            <span>Đang chờ duyệt</span>
            <span className="border border-status-warning/30 bg-[#e8993a]/15 px-1.5 py-0.2 text-[10px] font-medium text-status-warning">
              {(candidates ?? []).length}
            </span>
          </h5>
        </div>

        {(candidates ?? []).length === 0 ? (
          <p className="border border-border-hairline/40 bg-surface-raised px-3 py-2 text-[11px] italic text-text-muted">
            Không có ghi nhớ nào đang chờ duyệt.
          </p>
        ) : (
          <div className="space-y-2">
            {(candidates ?? []).map((cand) => (
              <div
                key={cand.id}
                className="border border-status-warning/40 bg-surface-raised p-3 text-xs"
              >
                <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-border-hairline">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs">{kindIcons[cand.kind] || '📌'}</span>
                    <span className="font-semibold uppercase tracking-wider text-[10px] text-text-primary">
                      {cand.kind}
                    </span>
                    <span className="text-[#757d89]">•</span>
                    <span className="text-[10px] text-text-muted">
                      scope: {cand.scope.kind} ({cand.scope.ref})
                    </span>
                  </div>
                  {cand.reviewDueAt && (
                    <span className="text-[10px] text-status-warning">
                      Hạn xét: {new Date(cand.reviewDueAt).toLocaleDateString()}
                    </span>
                  )}
                </div>

                <div className="my-2 leading-relaxed text-text-primary">
                  {cand.text}
                </div>

                {refusePromptId === cand.id ? (
                  <div className="mt-2 space-y-2 border border-status-error/40 bg-surface-raised p-2">
                    <div className="text-[11px] font-medium text-status-error">
                      Nhập lý do từ chối (bắt buộc):
                    </div>
                    <input
                      type="text"
                      value={refuseReason}
                      onChange={(e) => setRefuseReason(e.target.value)}
                      placeholder="Ví dụ: Quy ước này không còn áp dụng / Vi phạm bảo mật"
                      className="field-sm w-full text-xs"
                      autoFocus
                    />
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setRefusePromptId(null);
                          setRefuseReason('');
                        }}
                        className="rounded-none border border-border-hairline bg-panel-bg px-2 py-1 text-xs text-text-primary hover:bg-panel-soft"
                      >
                        Hủy
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleReview(cand.id, 'refuse', refuseReason)}
                        className="rounded-none bg-[#e8704f] px-2.5 py-1 text-xs font-semibold text-[#0d1116] hover:bg-[#e8704f]/85"
                      >
                        Xác nhận từ chối
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-end gap-1.5 pt-1">
                    <button
                      type="button"
                      onClick={() => void handleReview(cand.id, 'defer', 'Hoãn xem xét 7 ngày')}
                      className="inline-flex items-center gap-1 border border-border-hairline bg-panel-bg px-2 py-1 text-[11px] font-medium text-text-primary hover:bg-panel-soft"
                    >
                      <Clock size={11} /> Hoãn
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRefusePromptId(cand.id);
                        setRefuseReason('');
                      }}
                      className="inline-flex items-center gap-1 border border-status-error/40 bg-surface-raised px-2 py-1 text-[11px] font-medium text-status-error hover:bg-[#e8704f]/10"
                    >
                      <Ban size={11} /> Từ chối
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleReview(cand.id, 'remember')}
                      className="inline-flex items-center gap-1 border border-status-success/40 bg-[#5db87a] px-2.5 py-1 text-[11px] font-semibold text-[#0d1116] hover:bg-[#5db87a]/85"
                    >
                      <Check size={11} /> Nhớ
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2. Active & Reviewed Memories */}
      <div className="space-y-2">
        <h5 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
          <Sparkles size={13} className="text-accent-steel" />
          <span>Ký ức đã duyệt</span>
          <span className="border border-accent-steel/30 bg-[#6a9fcc]/15 px-1.5 py-0.2 text-[10px] font-medium text-accent-steel">
            {(records ?? []).length}
          </span>
        </h5>

        {(records ?? []).length === 0 ? (
          <p className="border border-border-hairline/40 bg-surface-raised px-3 py-2 text-[11px] italic text-text-muted">
            Chưa có ký ức nào được kích hoạt.
          </p>
        ) : (
          <div className="max-h-60 space-y-1.5 overflow-y-auto pr-1">
            {(records ?? []).map((rec) => (
              <div
                key={rec.id}
                className="group flex items-start justify-between gap-2 border border-border-hairline bg-surface-raised p-2.5 text-xs"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px]">{kindIcons[rec.kind] || '📌'}</span>
                    <span
                      className={`px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                        rec.status === 'active'
                          ? 'border border-status-success/30 bg-[#5db87a]/15 text-status-success'
                          : rec.status === 'reference'
                            ? 'border border-accent-steel/30 bg-[#6a9fcc]/15 text-accent-steel'
                            : rec.status === 'archive'
                              ? 'border border-border-hairline/40 bg-panel-bg text-text-muted'
                              : 'border border-status-error/30 bg-[#e8704f]/15 text-status-error'
                      }`}
                    >
                      {rec.status}
                    </span>
                    <span className="text-[10px] text-[#757d89]">
                      confirm: {rec.confirmCount}
                    </span>
                    {rec.reviewDueAt && (
                      <span className="text-[10px] text-text-muted">
                        • hạn: {new Date(rec.reviewDueAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <div className="text-text-primary leading-relaxed">{rec.text}</div>
                  {rec.reason && (
                    <div className="text-[10px] text-status-error italic">
                      Lý do: {rec.reason}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void deleteReviewedRecord(rec.id);
                  }}
                  aria-label="Xóa ký ức"
                  className="p-1 text-text-muted opacity-60 transition hover:bg-[#e8704f]/10 hover:text-status-error group-hover:opacity-100"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3. Propose New Memory Card */}
      <div className="space-y-2 border border-dashed border-border-hairline bg-surface-raised p-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-text-primary">
            Thêm đề xuất ghi nhớ mới
          </label>
          <select
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as MemoryKind)}
            className="field-sm text-xs py-0.5"
          >
            <option value="pattern">🔧 Pattern (cách làm tốt)</option>
            <option value="rule">📏 Rule (quy tắc bắt buộc)</option>
            <option value="gotcha">⚠️ Gotcha (cạm bẫy tránh)</option>
            <option value="decision">💡 Decision (quyết định thiết kế)</option>
            <option value="term">📖 Term (thuật ngữ dự án)</option>
          </select>
        </div>

        <textarea
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          rows={2}
          maxLength={MAX_MEMORY_CHARS}
          className="field-sm resize-none text-xs w-full"
          placeholder='Ví dụ: "Luôn chạy test vitest trước khi commit thay đổi"'
          aria-label="Nội dung đề xuất ghi nhớ"
        />

        <button
          type="button"
          onClick={() => void handlePropose()}
          disabled={!newText.trim()}
          className="btn-secondary w-full justify-center text-xs py-1.5"
        >
          Đề xuất ghi nhớ
        </button>
      </div>
    </div>
  );
}

