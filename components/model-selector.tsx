'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, Sparkles } from 'lucide-react';

export interface ModelOption {
  id: string;
  label: string;
  hint?: string;
}

/* ------------------------------------------------------------------ */
/* Nhóm model theo hãng / loại                                         */
/* ------------------------------------------------------------------ */

interface ModelGroup {
  key: string;
  label: string;
  test: RegExp;
}

/** Thứ tự hiển thị: hãng lớn trước, media cuối, "Khác" luôn cuối cùng. */
const GROUPS: ModelGroup[] = [
  { key: 'gpt', label: 'OpenAI · GPT', test: /(^|[^a-z0-9])(gpt|chatgpt|codex|o[134]($|[^a-z0-9]))/i },
  { key: 'claude', label: 'Anthropic · Claude', test: /claude|anthropic/i },
  { key: 'gemini', label: 'Google · Gemini', test: /gemini|gemma/i },
  { key: 'qwen', label: 'Alibaba · Qwen', test: /qwen/i },
  { key: 'deepseek', label: 'DeepSeek', test: /deepseek/i },
  { key: 'grok', label: 'xAI · Grok', test: /grok/i },
  { key: 'kimi', label: 'Moonshot · Kimi', test: /kimi/i },
  { key: 'glm', label: 'Zhipu · GLM', test: /glm/i },
  { key: 'minimax', label: 'MiniMax', test: /minimax/i },
  { key: 'image', label: '🎨 Tạo ảnh', test: /image|t2i|flux|dall|imagen|sdxl|stable-diffusion|seedream|imggen/i },
  { key: 'video', label: '🎬 Tạo video', test: /video|t2v|kling|seedance|sora|veo|hailuo|vidu|jimeng/i },
];

function detectGroupKey(m: ModelOption): string {
  const s = `${m.id} ${m.label}`;
  // Media ưu tiên trước hãng — "qwen-image" thuộc nhóm Tạo ảnh, không phải Qwen.
  for (const g of GROUPS) {
    if ((g.key === 'image' || g.key === 'video') && g.test.test(s)) return g.key;
  }
  for (const g of GROUPS) {
    if (g.key !== 'image' && g.key !== 'video' && g.test.test(s)) return g.key;
  }
  return 'other';
}

export function ModelSelector({
  models,
  value,
  onChange,
  disabled,
}: {
  models: ModelOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const currentIndex = Math.max(
    0,
    models.findIndex((m) => m.id === value),
  );
  const current = models[currentIndex];

  /** Danh sách hiển thị (đã lọc theo ô tìm kiếm) — thứ tự = thứ tự render. */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => `${m.id} ${m.label}`.toLowerCase().includes(q));
  }, [models, query]);

  /** Nhóm hiển thị: mảng [group, options] theo thứ tự GROUPS, "Khác" cuối. */
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byKey = new Map<string, ModelOption[]>();
    for (const m of visible) {
      const key = q ? 'search' : detectGroupKey(m);
      const arr = byKey.get(key);
      if (arr) arr.push(m);
      else byKey.set(key, [m]);
    }
    const ordered: Array<{ key: string; label: string; items: ModelOption[] }> = [];
    if (q) {
      ordered.push({ key: 'search', label: `Kết quả (${visible.length})`, items: visible });
      return ordered;
    }
    for (const g of GROUPS) {
      const items = byKey.get(g.key);
      if (items?.length) ordered.push({ key: g.key, label: g.label, items });
    }
    const other = byKey.get('other');
    if (other?.length) ordered.push({ key: 'other', label: 'Khác', items: other });
    return ordered;
  }, [visible, query]);

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    setQuery('');
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    setCursor(currentIndex);

    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, currentIndex, close]);

  useEffect(() => {
    if (open) {
      // Focus ô tìm kiếm để gõ lọc ngay; arrow keys vẫn điều hướng list.
      setQuery('');
      searchRef.current?.focus();
    }
  }, [open]);

  // Đóng dropdown nếu bị disable giữa lúc đang mở (ví dụ stream bắt đầu).
  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, cursor]);

  /** Chia các nhóm thành 2 cột cân đối theo số model (luôn 2 cột, kể cả mobile). */
  const { columns, ordered, renderIndex } = useMemo(() => {
    const cols: Array<typeof grouped> = [[], []];
    let counts = [0, 0];
    for (const g of grouped) {
      const target = counts[0] <= counts[1] ? 0 : 1;
      cols[target].push(g);
      counts[target] += g.items.length;
    }
    // Thứ tự render thực tế (cột trái hết rồi cột phải) — cursor/commit theo đây.
    const order: ModelOption[] = [];
    const index = new Map<string, number>();
    for (const col of cols) for (const g of col) for (const m of g.items) {
      index.set(m.id, order.length);
      order.push(m);
    }
    return { columns: cols, ordered: order, renderIndex: index };
  }, [grouped]);

  const commit = useCallback(
    (index: number) => {
      const target = ordered[index];
      if (target) onChange(target.id);
      close();
    },
    [ordered, onChange, close],
  );

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (visible.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % visible.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + visible.length) % visible.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setCursor(visible.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commit(cursor);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || models.length === 0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-700 disabled:opacity-50"
      >
        <Sparkles size={13} className="text-[#0A7E8C]" />
        <span className="max-w-[160px] truncate">{current?.label ?? 'Model'}</span>
        <ChevronDown size={13} className="text-zinc-500" />
      </button>

      {open && (
        <div
          className="absolute bottom-full right-0 z-50 mb-2 w-[min(620px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-zinc-200 bg-[#FFFFFF] shadow-2xl"
        >
          {/* Ô tìm kiếm — lọc nhanh khi danh sách dài (OrcaRouter 190+ model). */}
          <div className="border-b border-zinc-100 p-2">
            <div className="flex items-center gap-2 rounded-lg bg-zinc-100/80 px-2.5 py-1.5">
              <Search size={13} className="shrink-0 text-zinc-400" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                placeholder={`Tìm trong ${models.length} model… (vd: claude, gpt, qwen)`}
                className="w-full bg-transparent text-[13px] text-zinc-700 outline-none placeholder:text-zinc-400"
              />
            </div>
          </div>

          <div
            id={listId}
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            aria-activedescendant={`${listId}-opt-${cursor}`}
            onKeyDown={onListKeyDown}
            className="max-h-[min(480px,70vh)] overflow-y-auto overscroll-contain p-1.5 outline-none"
          >
            {visible.length === 0 && (
              <p className="px-2.5 py-4 text-center text-[13px] text-zinc-400">
                Không có model nào khớp “{query}”.
              </p>
            )}
            <div className="grid grid-cols-2 gap-x-2">
              {columns.map((col, ci) => (
                <div key={ci} className="min-w-0">
                  {col.map((g) => (
                    <div key={g.key} className="mb-1.5">
                      <p className="sticky top-0 z-10 bg-[#FFFFFF]/95 px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                        {g.label}
                      </p>
                      {g.items.map((m) => {
                        const idx = renderIndex.get(m.id) ?? 0;
                        const active = m.id === current?.id;
                        const focused = idx === cursor;
                        return (
                          <div
                            key={m.id}
                            id={`${listId}-opt-${idx}`}
                            data-idx={idx}
                            role="option"
                            aria-selected={active}
                            onClick={() => commit(idx)}
                            onPointerEnter={() => setCursor(idx)}
                            className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left ${
                              focused ? 'bg-zinc-200/80' : 'hover:bg-zinc-100'
                            }`}
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate text-[13px] text-zinc-700">{m.label}</span>
                              {m.hint && (
                                <span className="truncate text-[11px] text-zinc-400">{m.hint}</span>
                              )}
                            </span>
                            {active && <Check size={14} className="flex-shrink-0 text-[#0A7E8C]" />}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
