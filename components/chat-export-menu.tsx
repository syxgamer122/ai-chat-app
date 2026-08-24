'use client';

import React, { useEffect, useRef, useState } from 'react';
import { exportJson, exportMarkdown } from '@/lib/backup';
import { Download, FileJson, FileText, Loader2 } from 'lucide-react';

export function ChatExportMenu({ chatId }: { chatId: string | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

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

  if (!chatId) return null;

  const run = async (kind: 'json' | 'md') => {
    setBusy(true);
    setExportError(null);
    try {
      if (kind === 'json') await exportJson([chatId]);
      else await exportMarkdown([chatId]);
      setOpen(false);
    } catch (err) {
      console.error('[ChatExportMenu]', err);
      // Không được nuốt lặng lẽ: user sẽ tưởng file đã tải xong và bỏ
      // qua backup thật, trong khi dữ liệu chưa ra khỏi máy.
      setExportError(
        `Xuất thất bại: ${err instanceof Error ? err.message : 'lỗi không rõ'}. Thử lại hoặc chọn định dạng khác.`,
      );
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
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Xuất cuộc trò chuyện này"
        title="Xuất cuộc trò chuyện này"
        className="icon-btn-sm"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
      </button>

      {open && (
        <div
          role="menu"
          className="surface-panel absolute right-0 top-full z-50 mt-1.5 w-60 animate-pop-in p-1"
        >
          {exportError && (
            <p role="alert" className="notice-error mx-1 mb-1 px-2 py-1.5 text-[11px] leading-relaxed">
              {exportError}
            </p>
          )}
          <MenuRow
            icon={<FileJson size={15} className="text-zinc-500" />}
            title="Xuất JSON (đầy đủ nhánh)"
            desc="Bảo toàn toàn bộ cây tin nhắn"
            onClick={() => run('json')}
          />
          <MenuRow
            icon={<FileText size={15} className="text-zinc-500" />}
            title="Xuất Markdown (nhánh active)"
            desc="Dành cho đọc và in ấn"
            onClick={() => run('md')}
          />
        </div>
      )}

      {!open && exportError && (
        <p
          role="alert"
          className="notice-error absolute right-0 top-full z-50 mt-1.5 w-60 px-2.5 py-2 text-[11px] leading-relaxed"
        >
          {exportError}
        </p>
      )}
    </div>
  );
}

function MenuRow({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-zinc-100"
    >
      <span className="mt-0.5">{icon}</span>
      <span className="flex flex-col">
        <span className="text-[13px] font-medium text-zinc-800">{title}</span>
        <span className="text-[11px] text-zinc-500">{desc}</span>
      </span>
    </button>
  );
}
