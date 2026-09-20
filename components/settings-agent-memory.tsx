'use client';

/**
 * Settings → Ghi nhớ: mục "Bộ nhớ có cấu trúc" (P1-4) — xem/sửa/xoá entry,
 * filter theo category/tag/scope, export JSON. Bổ sung cho hệ reviewer-gate
 * (candidates) đang có ở cùng tab.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import {
  listAgentMemories,
  removeMemoryCategory,
  removeSpecificMemory,
  syncCategoryMirror,
  importMirrorEdits,
} from '@/lib/memory/agent-memory-client';
import { db } from '@/lib/db';
import type { AgentMemoryRecord } from '@/lib/memory/agent-memory';
import { normalizeCategory } from '@/lib/memory/agent-memory';

export function AgentMemorySection() {
  const [records, setRecords] = useState<AgentMemoryRecord[]>([]);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const reload = useCallback(async () => {
    setRecords(await listAgentMemories());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const categories = useMemo(
    () => [...new Set(records.map((r) => r.category))].sort(),
    [records],
  );
  const tags = useMemo(
    () => [...new Set(records.flatMap((r) => r.tags))].sort(),
    [records],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter((r) => {
      if (categoryFilter && r.category !== categoryFilter) return false;
      if (tagFilter && !r.tags.includes(tagFilter)) return false;
      if (q && !`${r.category} ${r.data} ${r.tags.join(' ')}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [records, categoryFilter, tagFilter, query]);

  const saveEdit = async (record: AgentMemoryRecord) => {
    const data = draft.trim().slice(0, 2_000);
    if (data.length < 4) {
      setNotice('Nội dung quá ngắn (tối thiểu 4 ký tự).');
      return;
    }
    const now = new Date().getTime();
    await db.agentMemories.update(record.id, { data, updatedAt: now });
    await syncCategoryMirror(record.category).catch(() => false);
    setEditingId(null);
    await reload();
  };

  return (
    <div className="space-y-3 font-mono">
      <div>
        <div className="flex items-center justify-between gap-2">
          <h4 className="field-label text-[15px]">Sổ tay có cấu trúc (bạn tự viết)</h4>
          <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={async () => {
              const r = await importMirrorEdits(categoryFilter || categories[0] || 'default');
              setNotice(r.applied ? `Đã áp ${r.applied} thay đổi từ file mirror.` : 'File mirror không có thay đổi mới.');
              await reload();
            }}
            className="rounded-none border border-border-hairline bg-surface-raised px-2 py-1 text-[11px] text-text-primary hover:bg-panel-bg"
          >
            Đọc lại file mirror
          </button>
          <button
            type="button"
            onClick={() => {
              const workspace = records.length;
              const payload = JSON.stringify({ exportedAt: new Date().toISOString(), count: workspace, records }, null, 2);
              const blob = new Blob([payload], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'vyen-agent-memories.json';
              a.click();
              URL.revokeObjectURL(url);
            }}
            disabled={!records.length}
            className="flex items-center gap-1 rounded-none border border-border-hairline bg-surface-raised px-2 py-1 text-[11px] text-text-primary hover:bg-panel-bg disabled:opacity-40"
          >
            <Download size={11} aria-hidden="true" /> Export JSON
          </button>
        </div>
      </div>

        <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
          Khác mục &ldquo;Duyệt đề xuất ghi nhớ&rdquo; ở trên: entry ở đây do <strong className="font-semibold text-text-primary">bạn</strong>{' '}
          tự tạo nên không qua bước duyệt.
        </p>
      </div>

      <p className="text-xs leading-relaxed text-text-muted">
        {records.length} entry · mỗi entry tối đa 2.000 ký tự. Scope <em>toàn cục</em> dùng cho mọi dự án;{' '}
        <em>local</em> chỉ workspace hiện tại. Desktop mirror ra{' '}
        <code className="claude-inline-code">.vyen/memory/&lt;category&gt;.md</code> và{' '}
        <code className="claude-inline-code">~/.vyen/memory/</code> để sửa tay.
      </p>

      <div className="grid grid-cols-3 gap-2">
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label="Lọc theo category"
          className="claude-input text-xs"
        >
          <option value="">Mọi category</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          aria-label="Lọc theo tag"
          className="claude-input text-xs"
        >
          <option value="">Mọi tag</option>
          {tags.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="tìm trong nội dung…"
          aria-label="Tìm trong bộ nhớ"
          className="claude-input text-xs"
        />
      </div>

      <ul className="space-y-1.5">
        {filtered.map((r) => (
          <li key={r.id} className="border border-border-hairline bg-surface-raised px-2.5 py-2 text-xs">
            <div className="flex items-start gap-2">
              <span className="flex-none font-mono text-[10.5px] text-text-muted">
                {r.category}
                <span className="ml-1 text-[#757d89]">{r.scope === 'global' ? '· toàn cục' : '· local'}</span>
              </span>
              <span className="min-w-0 flex-1">
                {editingId === r.id ? (
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-label={`Sửa memory ${r.id}`}
                    rows={3}
                    className="claude-input w-full text-xs"
                  />
                ) : (
                  <span className="block whitespace-pre-wrap text-text-primary">{r.data}</span>
                )}
                {r.tags.length > 0 && (
                  <span className="mt-0.5 block text-[10.5px] text-[#757d89]">{r.tags.join(', ')}</span>
                )}
              </span>
              <span className="flex flex-none items-center gap-1">
                {editingId === r.id ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void saveEdit(r)}
                      className="rounded-none border border-border-hairline bg-panel-bg px-1.5 py-0.5 text-[10.5px] text-text-primary"
                    >
                      Lưu
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded-none border border-border-hairline bg-panel-bg px-1.5 py-0.5 text-[10.5px] text-text-primary"
                    >
                      Huỷ
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(r.id);
                        setDraft(r.data);
                      }}
                      className="rounded-none border border-border-hairline bg-panel-bg px-1.5 py-0.5 text-[10.5px] text-text-primary hover:bg-panel-soft"
                    >
                      Sửa
                    </button>
                    <button
                      type="button"
                      aria-label={`Xoá memory ${r.id}`}
                      onClick={async () => {
                        await removeSpecificMemory(r.id);
                        await reload();
                      }}
                      className="rounded-none border border-border-hairline bg-panel-bg px-1.5 py-0.5 text-[10.5px] text-status-error hover:bg-[#e8704f]/10"
                    >
                      <Trash2 size={10} aria-hidden="true" />
                    </button>
                  </>
                )}
              </span>
            </div>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="text-xs text-text-muted">
            {records.length === 0
              ? 'Chưa có bộ nhớ cấu trúc. Agent ghi qua tool remember_memory, hoặc bạn thêm từ phiên chat.'
              : 'Không entry nào khớp bộ lọc hiện tại.'}
          </li>
        )}
      </ul>

      {categories.length > 0 && (
        <div className="flex items-center gap-2 border-t border-border-hairline pt-2">
          <button
            type="button"
            onClick={async () => {
              const target = categoryFilter || normalizeCategory(categories[0] ?? '');
              const removed = await removeMemoryCategory(target);
              setNotice(`Đã xoá ${removed} entry thuộc "${target}".`);
              await reload();
            }}
            className="rounded-none border border-status-error/40 bg-surface-raised px-2 py-1 text-[11px] text-status-error hover:bg-[#e8704f]/10"
          >
            Xoá cả category &quot;{categoryFilter || categories[0]}&quot;
          </button>
        </div>
      )}

      {notice && <p role="status" className="text-[11px] text-accent-steel">{notice}</p>}
    </div>
  );
}
