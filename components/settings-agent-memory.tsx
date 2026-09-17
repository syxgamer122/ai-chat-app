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
  resolveWorkspaceKey,
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
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-800">Bộ nhớ có cấu trúc</h3>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={async () => {
              const r = await importMirrorEdits(categoryFilter || categories[0] || 'default');
              setNotice(r.applied ? `Đã áp ${r.applied} thay đổi từ file mirror.` : 'File mirror không có thay đổi mới.');
              await reload();
            }}
            className="border border-zinc-300 px-2 py-1 text-[11px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
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
            className="flex items-center gap-1 border border-zinc-300 px-2 py-1 text-[11px] text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Download size={11} aria-hidden="true" /> Export JSON
          </button>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-zinc-600">
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
          <li key={r.id} className="border border-zinc-200 px-2.5 py-2 text-xs dark:border-zinc-800">
            <div className="flex items-start gap-2">
              <span className="flex-none font-mono text-[10.5px] text-zinc-500">
                {r.category}
                <span className="ml-1 text-zinc-400">{r.scope === 'global' ? '· toàn cục' : '· local'}</span>
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
                  <span className="block whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">{r.data}</span>
                )}
                {r.tags.length > 0 && (
                  <span className="mt-0.5 block text-[10.5px] text-zinc-400">{r.tags.join(', ')}</span>
                )}
              </span>
              <span className="flex flex-none items-center gap-1">
                {editingId === r.id ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void saveEdit(r)}
                      className="border border-zinc-300 px-1.5 py-0.5 text-[10.5px] dark:border-zinc-700"
                    >
                      Lưu
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="border border-zinc-300 px-1.5 py-0.5 text-[10.5px] dark:border-zinc-700"
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
                      className="border border-zinc-300 px-1.5 py-0.5 text-[10.5px] dark:border-zinc-700"
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
                      className="border border-zinc-300 px-1.5 py-0.5 text-[10.5px] text-red-600 dark:border-zinc-700"
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
          <li className="text-xs text-zinc-500">
            {records.length === 0
              ? 'Chưa có bộ nhớ cấu trúc. Agent ghi qua tool remember_memory, hoặc bạn thêm từ phiên chat.'
              : 'Không entry nào khớp bộ lọc hiện tại.'}
          </li>
        )}
      </ul>

      {categories.length > 0 && (
        <div className="flex items-center gap-2 border-t border-zinc-200 pt-2 dark:border-zinc-800">
          <button
            type="button"
            onClick={async () => {
              const target = categoryFilter || normalizeCategory(categories[0] ?? '');
              const removed = await removeMemoryCategory(target);
              setNotice(`Đã xoá ${removed} entry thuộc "${target}".`);
              await reload();
            }}
            className="border border-red-300 px-2 py-1 text-[11px] text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950"
          >
            Xoá cả category &quot;{categoryFilter || categories[0]}&quot;
          </button>
        </div>
      )}

      {notice && <p role="status" className="text-[11px] text-sky-700 dark:text-sky-300">{notice}</p>}
    </div>
  );
}
