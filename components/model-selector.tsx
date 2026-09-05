'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useMediaQuery } from '@/lib/hooks/use-media-query';

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

  const current = useMemo(
    () => models.find((m) => m.id === value),
    [models, value],
  );

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
  }, [open, close]);

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

  /**
   * Chia nhóm thành 2 cột cân đối theo số model. Trên mobile chỉ render 1 cột
   * (grid-cols-1) nên dồn hết vào cột đầu để thứ tự đọc không bị nhảy.
   */
  const isNarrow = !useMediaQuery('(min-width: 640px)');

  const { columns, ordered, renderIndex } = useMemo(() => {
    const colCount = isNarrow ? 1 : 2;
    const cols: Array<typeof grouped> = Array.from({ length: colCount }, () => []);
    const counts = new Array(colCount).fill(0);
    for (const g of grouped) {
      // Đưa vào cột đang "nhẹ" nhất để hai bên cao xấp xỉ nhau.
      let target = 0;
      for (let i = 1; i < colCount; i++) if (counts[i] < counts[target]) target = i;
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
  }, [grouped, isNarrow]);

  /**
   * Mở dropdown / đổi model đang chọn: con trỏ phải theo THỨ TỪ RENDER
   * (nhóm + 2 cột), không phải index trong mảng `models` prop — hai thứ tự
   * khác nhau nên dùng nhầm sẽ highlight sai và Enter commit model khác.
   */
  useEffect(() => {
    if (!open) return;
    setCursor(renderIndex.get(value) ?? 0);
  }, [open, value, renderIndex]);

  const commit = useCallback(
    (index: number) => {
      const target = ordered[index];
      if (target) onChange(target.id);
      close();
    },
    [ordered, onChange, close],
  );

  /**
   * Điều hướng bàn phím. Handler đặt trên wrapper của cả panel (không phải chỉ
   * riêng list) vì focus nằm ở ô tìm kiếm — là node em của list, nên keydown
   * trên list không bao giờ bắt được.
   */
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (ordered.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % ordered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + ordered.length) % ordered.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setCursor(ordered.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(cursor);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative min-w-0">
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
        aria-label={`Model: ${current?.label ?? 'chưa chọn'}`}
        className="relative flex h-8 max-w-full items-center gap-1.5 rounded-none border border-[#495059] bg-[#161d27] px-2.5 font-mono text-[12px] font-medium text-[#ebe7e4] transition-colors after:absolute after:-inset-[6px] after:content-[''] hover:border-[#757d89] hover:bg-[#212730] disabled:opacity-40"
      >
        <span className="hidden sm:inline-block h-1.5 w-1.5 rounded-full bg-[#6a9fcc] flex-none" />
        <span className="min-w-0 max-w-[30vw] truncate sm:max-w-[160px]">{current?.label ?? 'Model'}</span>
        <ChevronDown size={12} className="flex-none text-[#9fa4ab]" />
      </button>

      {open && (
        <div
          onKeyDown={onPanelKeyDown}
          className="surface-panel absolute bottom-full left-1/2 z-50 mb-2 w-[min(620px,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)] -translate-x-1/2 animate-slide-up overflow-hidden rounded-none border border-[#495059] bg-[#212730]"
        >
          {/* Ô tìm kiếm */}
          <div className="border-b border-[#495059] p-2">
            <div className="flex items-center gap-2 rounded-none border border-[#495059] bg-[#0d1116] px-2.5 py-1.5">
              <Search size={12} aria-hidden="true" className="shrink-0 text-[#9fa4ab]" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                aria-label="Tìm model"
                placeholder={`$ /model (${models.length} available)...`}
                className="w-full bg-transparent font-mono text-[12px] text-[#ebe7e4] outline-none placeholder:text-[#9fa4ab]"
              />
            </div>
          </div>

          <div
            id={listId}
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            aria-label="Danh sách model"
            aria-activedescendant={`${listId}-opt-${cursor}`}
            className="max-h-[min(480px,60vh)] overflow-y-auto overscroll-contain p-1.5 outline-none font-mono"
          >
            {visible.length === 0 && (
              <p className="px-2.5 py-4 text-center text-xs text-[#9fa4ab]">
                Không có model nào khớp “{query}”.
              </p>
            )}
            <div className="grid grid-cols-1 gap-x-2 sm:grid-cols-2">
              {columns.map((col, ci) => (
                <div key={ci} className="min-w-0">
                  {col.map((g) => (
                    <div key={g.key} className="mb-1.5">
                      <p className="sticky top-0 z-10 bg-[#161d27]/95 px-2 pb-1 pt-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-wide text-[#6a9fcc]">
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
                            className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-none px-2 py-1.5 text-left transition-colors ${
                              active
                                ? 'pi-active-indicator bg-[#252f3d] text-[#ebe7e4]'
                                : focused
                                  ? 'bg-[#252f3d] text-[#ebe7e4]'
                                  : 'hover:bg-[#161d27] text-[#ebe7e4]'
                            }`}
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate text-xs font-mono">{m.label}</span>
                              {m.hint && (
                                <span className="truncate text-[10px] text-[#9fa4ab]">{m.hint}</span>
                              )}
                            </span>
                            {active && <Check size={13} className="flex-shrink-0 text-[#6a9fcc]" />}
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
