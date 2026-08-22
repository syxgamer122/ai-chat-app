'use client';

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Pencil,
  RefreshCw,
} from 'lucide-react';
import { MarkdownRenderer } from '@/components/markdown-renderer';

export interface MessageRowProps {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  siblingIndex: number;
  siblingCount: number;
  onSwitchBranch: (direction: -1 | 1) => void;
  onEdit?: () => void;
  onRegenerate?: () => void;
  sanitizeContent: (v: unknown) => string;
  /** Bật render Markdown cho tin nhắn user (mặc định: tắt). */
  renderUserMarkdown?: boolean;
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
      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
    >
      {children}
    </button>
  );
}

const BranchNav = memo(function BranchNav({
  index,
  total,
  onSwitch,
}: {
  index: number;
  total: number;
  onSwitch: (d: -1 | 1) => void;
}) {
  if (total <= 1) return null;
  return (
    <div className="flex items-center gap-0.5 text-[11px] text-zinc-500">
      <button
        type="button"
        onClick={() => onSwitch(-1)}
        disabled={index <= 0}
        aria-label="Nhánh trước"
        className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
      >
        <ChevronLeft size={13} />
      </button>
      <span className="tabular-nums" aria-live="off">
        {index + 1}/{total}
      </span>
      <button
        type="button"
        onClick={() => onSwitch(1)}
        disabled={index >= total - 1}
        aria-label="Nhánh sau"
        className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
      >
        <ChevronRight size={13} />
      </button>
    </div>
  );
});

export const MessageRow = memo(function MessageRow({
  role,
  content,
  isStreaming,
  siblingIndex,
  siblingCount,
  onSwitchBranch,
  onEdit,
  onRegenerate,
  sanitizeContent,
  renderUserMarkdown = false,
}: MessageRowProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const safe = sanitizeContent(content);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(safe);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('[MessageRow:copy]', err);
    }
  }, [safe]);

  /* ---------------------------- USER ---------------------------- */
  if (role === 'user') {
    return (
      <div className="group flex w-full justify-end px-4" data-role="user">
        <div className="flex max-w-[85%] flex-col items-end gap-1 sm:max-w-[75%]">
          <div className="rounded-2xl bg-[#2b2b30] px-4 py-2.5 text-[15px] leading-relaxed text-zinc-100">
            {renderUserMarkdown ? (
              <MarkdownRenderer content={safe} isStreaming={false} />
            ) : (
              <div className="whitespace-pre-wrap break-words">{safe}</div>
            )}
          </div>
          <div className="msg-actions flex items-center gap-1">
            <BranchNav
              index={siblingIndex}
              total={siblingCount}
              onSwitch={onSwitchBranch}
            />
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

  /* -------------------------- ASSISTANT ------------------------- */
  return (
    <div className="group flex w-full gap-3 px-4" data-role="assistant">
      <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[#c96442] text-[11px] font-semibold text-white">
        AI
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={`claude-prose ${isStreaming ? 'streaming-caret' : ''}`}
          aria-busy={isStreaming ? 'true' : 'false'}
          aria-live={isStreaming ? 'polite' : 'off'}
        >
          <MarkdownRenderer content={safe} isStreaming={!!isStreaming} />
        </div>

        {/* Branch nav luôn hiện (kể cả khi stream) để không giật layout. */}
        <div className="msg-actions mt-1.5 flex min-h-7 items-center gap-1">
          {!isStreaming && (
            <>
              <IconBtn label="Sao chép" onClick={copy}>
                {copied ? (
                  <Check size={13} className="text-emerald-400" />
                ) : (
                  <Copy size={13} />
                )}
              </IconBtn>
              {onRegenerate && (
                <IconBtn label="Tạo lại nhánh mới" onClick={onRegenerate}>
                  <RefreshCw size={13} />
                </IconBtn>
              )}
            </>
          )}
          <BranchNav
            index={siblingIndex}
            total={siblingCount}
            onSwitch={onSwitchBranch}
          />
        </div>
      </div>
    </div>
  );
});

MessageRow.displayName = 'MessageRow';