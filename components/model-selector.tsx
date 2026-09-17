'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Brain,
  Check,
  ChevronDown,
  Eye,
  FileText,
  Search,
  Star,
} from 'lucide-react';
import { useAnchoredPanel } from '@/lib/hooks/use-anchored-panel';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { isRetiredMediaOption } from '@/lib/media-models';
import {
  buildPickerSections,
  buildRenderLayout,
  fmtCtx,
  type ModelCapability,
  type ModelFavorite,
  type ModelOption,
  type RecentModel,
  type RenderRow,
} from '@/lib/model-meta';

export type { ModelOption, ModelFavorite, RecentModel } from '@/lib/model-meta';

function capsTitleText(caps?: ModelCapability[]): string {
  if (!caps?.length) return '';
  const words: string[] = [];
  if (caps.includes('vision')) words.push('xem ảnh');
  if (caps.includes('pdf')) words.push('đọc PDF');
  if (caps.includes('reasoning')) words.push('suy luận');
  return words.join(', ');
}

/** title chuẩn của một option: đầy đủ id + ctx + caps; hover mới đọc hết được id dài. */
function optionTitle(m: ModelOption): string {
  return [
    m.id,
    m.ctx !== undefined && !m.media ? `${fmtCtx(m.ctx)} token` : undefined,
    capsTitleText(m.caps),
  ]
    .filter(Boolean)
    .join(' · ');
}

export interface ModelSelectorProps {
  models: ModelOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Provider đang active: Gần đây/Yêu thích chỉ hiện mục cùng provider. */
  providerId: string;
  /** true khi danh sách là catalog built-in (mới có section Đề xuất). */
  builtinCatalog: boolean;
  favorites: ModelFavorite[];
  recents: RecentModel[];
  onToggleFavorite: (id: string) => void;
}

export function ModelSelector({
  models,
  value,
  onChange,
  disabled,
  providerId,
  builtinCatalog,
  favorites,
  recents,
  onToggleFavorite,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const current = useMemo(() => models.find((m) => m.id === value), [models, value]);
  const selectableModels = useMemo(() => models.filter((m) => !isRetiredMediaOption(m)), [models]);
  const retiredSelection = Boolean(current && isRetiredMediaOption(current));
  const selectionLabel = retiredSelection ? 'Chọn model lập trình/chat' : current?.label ?? 'Model';

  const favoriteIds = useMemo(
    () =>
      new Set(
        favorites.filter((f) => f.providerId === providerId).map((f) => f.id),
      ),
    [favorites, providerId],
  );

  const sections = useMemo(
    () =>
      buildPickerSections(selectableModels, {
        favorites,
        recents,
        currentId: value,
        providerId,
        isBuiltinCatalog: builtinCatalog,
        query,
      }),
    [selectableModels, favorites, recents, value, providerId, builtinCatalog, query],
  );

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    setQuery('');
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  /*
   * Panel render qua portal + position:fixed (xem use-anchored-panel cho
   * recipe chung): mở XUỐNG từ mép dưới trigger, rộng 620, kẹp trong viewport,
   * đóng khi cuộn/pointerdown ngoài panel.
   */
  const { pos, panelRef } = useAnchoredPanel({
    open,
    triggerRef,
    width: 620,
    align: 'left',
    withMaxHeight: true,
    close,
  });

  // Escape trả focus về trigger và xóa query (close()); dismissal theo
  // click/cuộn ngoài panel do hook lo bằng close(false).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
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
    if (disabled && open) {
      setQuery('');
      setOpen(false);
    }
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, cursor]);

  /** 1 cột trên mobile (<640px) để dồn hết vào cột đọc liên tục. */
  const isNarrow = !useMediaQuery('(min-width: 640px)');

  // Có query: mọi mục sập vào một section Kết quả, cho chạy một cột
  // full-width thay vì chia đôi grid rồi bỏ trống nửa phải trên desktop.
  const singleColumn = isNarrow || query.trim() !== '';

  const { quickSections, columns, ordered, renderIndex } = useMemo(
    () => buildRenderLayout(sections, singleColumn ? 1 : 2),
    [sections, singleColumn],
  );

  // Mở dropdown / đổi model đang chọn: con trỏ neo theo thứ tự render. Chỉ
  // hai sự kiện đó được re-anchor; renderIndex đổi danh tính (Shift+Enter
  // yêu thích dựng lại sections) không được giật con trỏ khỏi hàng user
  // đang đứng.
  const prevAnchorRef = useRef({ open: false, value });
  useEffect(() => {
    const prev = prevAnchorRef.current;
    prevAnchorRef.current = { open, value };
    if (!open) return;
    if (prev.open && prev.value === value) return;
    setCursor(renderIndex.get(value) ?? 0);
  }, [open, value, renderIndex]);

  /*
   * Phần còn lại của neo con trỏ: renderIndex đổi DAN TÍNH khi panel đang mở
   * (Shift+Enter yêu thích dựng lại sections, đổi breakpoint cột) khiến cùng
   * một con số cursor trỏ sang model khác. Giữ nguyên model đang highlight:
   * ghi id model dưới con trỏ theo layout CŨ, tra lại index của id đó trong
   * layout MỚI. Đổi query thì bỏ qua, handler input đã chủ động đưa cursor
   * về đầu danh sách kết quả, remap đè lên sẽ đẩy cursor giữa danh sách.
   */
  const prevLayoutRef = useRef({ ordered, renderIndex, open, value, query });
  useEffect(() => {
    const prev = prevLayoutRef.current;
    prevLayoutRef.current = { ordered, renderIndex, open, value, query };
    if (!open || !prev.open) return;
    if (value !== prev.value || query !== prev.query) return;
    if (renderIndex === prev.renderIndex) return;
    const id = prev.ordered[cursor]?.id;
    if (id === undefined) return;
    const next = renderIndex.get(id);
    if (next !== undefined && next !== cursor) setCursor(next);
  }, [open, value, query, renderIndex, ordered, cursor]);

  const commit = useCallback(
    (index: number) => {
      const target = ordered[index];
      if (target) onChange(target.id);
      close();
    },
    [ordered, onChange, close],
  );

  /**
   * Điều hướng bàn phím. Handler đặt trên panel (không chỉ list) vì focus
   * nằm ở ô tìm kiếm, là node em của list trong cùng panel.
   */
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    // Không có kết quả: (c + 1) % 0 = NaN phá cursor, nên bỏ hết; Enter/Escape
    // rơi về nút "Xóa tìm kiếm" và doc-level Escape listener.
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
    } else if (e.key === 'Enter' && e.shiftKey) {
      // Yêu thích dòng con trỏ: menu giữ nguyên, con trỏ giữ nguyên.
      e.preventDefault();
      const target = ordered[cursor];
      if (target) onToggleFavorite(target.id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(cursor);
    } else if (e.key === 'Tab') {
      // Đóng qua Tab cũng phải xoá query: lần mở sau effect anchor chạy với
      // layout chưa lọc, query cũ còn sót sẽ neo con trỏ sai dòng một nhịp.
      setQuery('');
      setOpen(false);
    }
  };

  const renderRow = (row: RenderRow, keyPrefix: string) => {
    const { m, idx } = row;
    const active = m.id === current?.id;
    const focused = idx === cursor;
    const favorited = favoriteIds.has(m.id);
    return (
      <div
        key={`${keyPrefix}-${m.id}`}
        id={`${listId}-opt-${idx}`}
        data-idx={idx}
        role="option"
        aria-selected={active}
        title={optionTitle(m)}
        onClick={() => commit(idx)}
        onPointerEnter={() => setCursor(idx)}
        className={`group relative flex min-h-11 cursor-pointer flex-col justify-center rounded-none px-2 py-1 text-left transition-colors ${
          active
            ? 'pi-active-indicator bg-[#252f3d] text-[#ebe7e4]'
            : focused
              ? 'bg-[#252f3d] text-[#ebe7e4]'
              : 'hover:bg-[#161d27] text-[#ebe7e4]'
        }`}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-xs font-mono">{m.label}</span>
          <span className="flex flex-none items-center gap-1 text-[#9fa4ab]" aria-hidden="true">
            {m.caps?.includes('vision') && <Eye size={12} className="flex-none" />}
            {m.caps?.includes('pdf') && <FileText size={12} className="flex-none" />}
            {m.caps?.includes('reasoning') && <Brain size={12} className="flex-none" />}
          </span>
          <span className="min-w-1 flex-1" aria-hidden="true" />
          {m.ctx !== undefined && !m.media && (
            <span className="flex-none text-[10.5px] tabular-nums text-[#9fa4ab]">
              {fmtCtx(m.ctx)}
            </span>
          )}
          <button
            type="button"
            /* Chỉ là phím tắt cho chuột; người dùng bàn phím có Shift+Enter,
               screen reader bỏ qua nút này (aria-hidden) để không phá ngữ
               pháp listbox. */
            aria-hidden="true"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(m.id);
            }}
            title={favorited ? 'Bỏ yêu thích' : 'Yêu thích'}
            /* Vùng chạm 40px (24px + inset 8px mỗi cạnh), lọt vừa trong hàng
               min-h-11 (44px) nên không đụng sao của hàng kế bên. */
            className={`relative flex h-6 w-6 flex-none items-center justify-center rounded-none transition-colors after:absolute after:-inset-2 after:content-[''] ${
              favorited
                ? 'text-[#6a9fcc]'
                : 'text-[#9fa4ab] opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100'
            }`}
          >
            <Star size={13} className={favorited ? 'fill-[#6a9fcc]' : ''} aria-hidden="true" />
          </button>
          {active && <Check size={13} className="flex-shrink-0 text-[#6a9fcc]" aria-hidden="true" />}
        </div>
        {m.hint && <p className="mt-0.5 truncate text-[10px] leading-tight text-[#9fa4ab]">{m.hint}</p>}
      </div>
    );
  };

  const triggerTitle = retiredSelection
    ? 'Tính năng tạo ảnh/video đã ngừng hoạt động. Vui lòng chọn model lập trình/chat để tiếp tục.'
    : current
    ? [
        current.id,
        current.ctx !== undefined && !current.media ? `${fmtCtx(current.ctx)} token` : undefined,
        capsTitleText(current.caps),
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined;

  return (
    <div ref={wrapRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || models.length === 0}
        onClick={() => {
          if (open) setQuery('');
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Model: ${selectionLabel}`}
        title={triggerTitle}
        className="relative flex h-8 max-w-full items-center gap-1.5 rounded-none border border-[#495059] bg-[#161d27] px-2.5 font-mono text-[12px] font-medium text-[#ebe7e4] transition-colors after:absolute after:-inset-[6px] after:content-[''] hover:border-[#757d89] hover:bg-[#212730] disabled:opacity-40"
      >
        <span className="min-w-0 max-w-[30vw] truncate sm:max-w-[160px]">{selectionLabel}</span>
        <ChevronDown size={12} className="flex-none text-[#9fa4ab]" aria-hidden="true" />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            onKeyDown={onPanelKeyDown}
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
            }}
            className="surface-panel z-50 flex animate-pop-in flex-col overflow-hidden rounded-none border border-[#495059] bg-[#212730]"
          >
            {/* Ô tìm kiếm + số lượng model */}
            <div className="flex flex-none items-center gap-2 border-b border-[#495059] p-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-none border border-[#495059] bg-[#0d1116] px-2.5 py-1.5 transition-colors focus-within:border-[#6a9fcc]">
                <Search size={12} aria-hidden="true" className="shrink-0 text-[#9fa4ab]" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setCursor(0);
                  }}
                  aria-label="Tìm model"
                  placeholder="Tìm model: tên hoặc id"
                  className="w-full bg-transparent font-mono text-[12px] text-[#ebe7e4] outline-none placeholder:text-[#9fa4ab]"
                />
              </div>
              <span className="flex-none text-[10.5px] tabular-nums text-[#9fa4ab]">
                {selectableModels.length} model
              </span>
            </div>

            <div
              id={listId}
              ref={listRef}
              role="listbox"
              tabIndex={-1}
              aria-label="Danh sách model"
              aria-activedescendant={`${listId}-opt-${cursor}`}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 outline-none font-mono"
            >
              {ordered.length === 0 && (
                <div className="flex flex-col items-center gap-2 px-2.5 py-6 text-center">
                  <p className="text-xs text-[#9fa4ab]">Không có model nào khớp “{query}”.</p>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      searchRef.current?.focus();
                    }}
                    className="rounded-none border border-[#495059] bg-[#161d27] px-2.5 py-1 text-[11px] text-[#ebe7e4] transition-colors hover:border-[#757d89] hover:bg-[#212730]"
                  >
                    Xóa tìm kiếm
                  </button>
                </div>
              )}
              {quickSections.map((s) => (
                <div key={s.key} className="mb-1.5">
                  <p className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[#6a9fcc]">
                    {s.label}
                  </p>
                  {s.rows.map((row) => renderRow(row, s.key))}
                </div>
              ))}
              <div className={`grid grid-cols-1 gap-x-2 ${singleColumn ? '' : 'sm:grid-cols-2'}`}>
                {columns.map((col, ci) => (
                  <div key={ci} className="min-w-0">
                    {col.map((g) => (
                      <div key={g.key} className="mb-1.5">
                        <p className="sticky top-0 z-10 bg-[#161d27]/95 px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[#6a9fcc]">
                          {g.label}
                        </p>
                        {g.rows.map((row) => renderRow(row, g.key))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex-none border-t border-[#495059] px-2.5 py-1.5">
              <p className="hidden text-[10px] text-[#9fa4ab] sm:block">
                ↑↓ di chuyển · Enter chọn · Shift+Enter yêu thích · Esc
              </p>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
