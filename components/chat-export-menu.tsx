'use client';

import React, { useEffect, useRef, useState } from 'react';
import { exportJson, exportMarkdown } from '@/lib/backup';
import { Download, FileJson, FileText, Loader2 } from 'lucide-react';

export function ChatExportMenu({ chatId }: { chatId: string | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!chatId) return null;

  const handle = async (format: 'json' | 'md') => {
    setOpen(false);
    setBusy(true);
    try {
      if (format === 'json') await exportJson([chatId]);
      else await exportMarkdown([chatId]);
    } catch (err) {
      console.error('[chat export]', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title="Xuất cuộc trò chuyện"
        aria-haspopup="menu"
        aria-expanded={open}
        className="p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 rounded-xl transition disabled:opacity-50"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 w-48 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl py-1 z-50"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handle('json')}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 transition"
          >
            <FileJson size={13} /> Xuất .json (đầy đủ cây)
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handle('md')}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 transition"
          >
            <FileText size={13} /> Xuất .md (nhánh đang xem)
          </button>
        </div>
      )}
    </div>
  );
}
