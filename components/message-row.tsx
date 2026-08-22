'use client';

import React, { useState } from 'react';
import { Copy, Check, Pencil, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { MarkdownRenderer } from '@/components/markdown-renderer';

export interface MessageRowProps {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  /* Branching — truyền thẳng từ chat-interface, logic không đổi */
  siblingIndex: number;
  siblingCount: number;
  onSwitchBranch: (direction: -1 | 1) => void;
  onEdit?: () => void;
  onRegenerate?: () => void;
  sanitizeContent: (v: unknown) => string;
}

export function MessageRow({
  role,
  content,
  isStreaming,
  siblingIndex,
  siblingCount,
  onSwitchBranch,
  onEdit,
  onRegenerate,
  sanitizeContent,
}: MessageRowProps) {
  const [copied, setCopied] = useState(false);
  const safe = sanitizeContent(content);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(safe);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('[MessageRow:copy]', err);
    }
  };

  const branchNav =
    siblingCount > 1 ? (
      <div className="flex items-center gap-0.5 text-[11px] text-zinc-500">
        <button
          type="button"
          onClick={() => onSwitchBranch(-1)}
          disabled={siblingIndex <= 0}
          aria-label="Nhánh trước"
          className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
        >
          <ChevronLeft size={13} />
        </button>
        <span className="tabular-nums">
          {siblingIndex + 1}/{siblingCount}
        </span>
        <button
          type="button"
          onClick={() => onSwitchBranch(1)}
          disabled={siblingIndex >= siblingCount - 1}
          aria-label="Nhánh sau"
          className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
        >
          <ChevronRight size={13} />
        </button>
      </div>
    ) : null;

  /* ---------- USER ---------- */
  if (role === 'user') {
    return (
      <div className="group flex w-full justify-end px-4">
        <div className="flex max-w-[75%] flex-col items-end gap-1">
          <div className="rounded-2xl bg-[#2b2b30] px-4 py-2.5 text-[15px] leading-relaxed text-zinc-100">
            <MarkdownRenderer content={safe} isStreaming={false} />
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            {branchNav}
            <IconBtn label="Sao chép" onClick={copy}>
              {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
            </IconBtn>
            {onEdit && (
              <IconBtn label="Chỉnh sửa" onClick={onEdit}>
                <Pencil size={13} />
              </IconBtn>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ---------- ASSISTANT ---------- */
  return (
    <div className="group flex w-full gap-3 px-4">
      <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[#c96442] text-[11px] font-semibold text-white">
        AI
      </div>
      <div className="min-w-0 flex-1">
        <div className={`claude-prose ${isStreaming ? 'streaming-caret' : ''}`}>
          <MarkdownRenderer content={safe} isStreaming={!!isStreaming} />
        </div>

        {!isStreaming && (
          <div className="mt-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <IconBtn label="Sao chép" onClick={copy}>
              {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
            </IconBtn>
            {onRegenerate && (
              <IconBtn label="Tạo lại nhánh mới" onClick={onRegenerate}>
                <RefreshCw size={13} />
              </IconBtn>
            )}
            {branchNav}
          </div>
        )}
      </div>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
    >
      {children}
    </button>
  );
}
