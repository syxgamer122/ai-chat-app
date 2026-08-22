'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Sparkles } from 'lucide-react';

export interface ModelOption {
  id: string;
  label: string;
  hint?: string;
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
  const [cursor, setCursor] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const currentIndex = Math.max(
    0,
    models.findIndex((m) => m.id === value),
  );
  const current = models[currentIndex];

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
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
      listRef.current?.focus();
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

  const commit = useCallback(
    (index: number) => {
      const target = models[index];
      if (target) onChange(target.id);
      close();
    },
    [models, onChange, close],
  );

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (models.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % models.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + models.length) % models.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setCursor(models.length - 1);
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
        className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200 disabled:opacity-50"
      >
        <Sparkles size={13} className="text-[#c96442]" />
        <span className="max-w-[160px] truncate">{current?.label ?? 'Model'}</span>
        <ChevronDown size={13} className="text-zinc-500" />
      </button>

      {open && (
        <div
          id={listId}
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={`${listId}-opt-${cursor}`}
          onKeyDown={onListKeyDown}
          className="no-scrollbar absolute bottom-full left-0 z-50 mb-2 max-h-72 w-64 overflow-y-auto rounded-xl border border-zinc-800 bg-[#1a1a1d] p-1 shadow-xl outline-none"
        >
          {models.map((m, idx) => {
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
                className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left ${
                  focused ? 'bg-zinc-800/80' : ''
                }`}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] text-zinc-200">{m.label}</span>
                  {m.hint && (
                    <span className="truncate text-[11px] text-zinc-500">{m.hint}</span>
                  )}
                </span>
                {active && <Check size={14} className="flex-shrink-0 text-[#c96442]" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}