'use client';

import React, { useEffect, useRef, useState } from 'react';
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
  const ref = useRef<HTMLDivElement>(null);
  const current = models.find((m) => m.id === value) ?? models[0];

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200 disabled:opacity-50"
      >
        <Sparkles size={13} className="text-[#c96442]" />
        <span className="max-w-[160px] truncate">{current?.label ?? 'Model'}</span>
        <ChevronDown size={13} className="text-zinc-500" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-50 mb-2 w-64 max-h-72 overflow-y-auto rounded-xl border border-zinc-800 bg-[#1a1a1d] p-1 shadow-xl no-scrollbar"
        >
          {models.map((m) => {
            const active = m.id === current?.id;
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-zinc-800/80"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] text-zinc-200">{m.label}</span>
                  {m.hint && (
                    <span className="truncate text-[11px] text-zinc-500">{m.hint}</span>
                  )}
                </span>
                {active && <Check size={14} className="flex-shrink-0 text-[#c96442]" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
