'use client';

import React, { memo, useState, useEffect, useRef } from 'react';
import { Square, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { MarkdownRenderer } from '@/components/markdown-renderer';

export interface StreamBubbleProps {
  content: string;
  reasoning?: string;
  isStreaming: boolean;
  onStop?: () => void;
  role?: 'assistant' | 'user';
}

function StreamThinkingBlock({
  reasoning,
  isStreaming,
}: {
  reasoning: string;
  isStreaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  const lines = reasoning.trim().split('\n').filter(Boolean);
  const preview = lines[lines.length - 1] || 'thinking...';

  return (
    <div className="my-2 rounded-none border border-border-hairline bg-surface-raised p-2 text-xs font-mono">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline justify-between gap-2 text-left text-[11px] text-accent-steel hover:text-text-primary"
      >
        <span className="flex min-w-0 items-baseline gap-1.5 italic">
          <span className="font-semibold not-italic">thinking</span>
          {isStreaming && <span className="terminal-cursor not-italic" aria-hidden="true" />}
          {!open && <span className="truncate text-text-muted">· {preview}</span>}
        </span>
        <span className="flex-shrink-0 text-[10px] text-text-muted flex items-center gap-1">
          [{open ? 'hide' : 'expand'}]
          {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </span>
      </button>
      {open && (
        <div className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap border-l border-border-hairline pl-2.5 font-mono text-[11.5px] italic leading-relaxed text-text-muted">
          {reasoning}
        </div>
      )}
    </div>
  );
}

export const StreamBubble = memo(function StreamBubble({
  content,
  reasoning = '',
  isStreaming,
  onStop,
  role = 'assistant',
}: StreamBubbleProps) {
  const [handoffActive, setHandoffActive] = useState(false);
  const prevStreamingRef = useRef(isStreaming);

  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming && content) {
      setHandoffActive(true);
      const timer = setTimeout(() => {
        setHandoffActive(false);
      }, 100);
      return () => clearTimeout(timer);
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, content]);

  if (!isStreaming && !handoffActive && !content && !reasoning) {
    return null;
  }
  if (!isStreaming && !handoffActive) {
    return null;
  }

  return (
    <div
      data-testid="stream-bubble"
      aria-live="polite"
      className={`sticky bottom-0 z-10 w-full px-4 py-3 bg-surface-ground/95 backdrop-blur-sm border-t border-border-hairline transition-opacity duration-100 ${
        handoffActive && !isStreaming ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <div className="mx-auto max-w-4xl space-y-2">
        <div className="flex items-center justify-between text-xs text-text-muted">
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-accent-steel">
            <Sparkles size={12} className={isStreaming ? 'animate-pulse text-accent-brass' : ''} />
            <span className="uppercase tracking-wider font-semibold">{role}</span>
            {isStreaming && <span className="text-[10px] text-text-muted font-normal">(streaming...)</span>}
          </div>

          {isStreaming && onStop && (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono border border-border-hairline hover:border-accent-steel bg-surface-raised hover:bg-panel-soft text-text-muted hover:text-text-primary transition-colors"
              title="Dừng sinh phản hồi"
            >
              <Square size={10} className="fill-current" />
              <span>Dừng</span>
            </button>
          )}
        </div>

        {reasoning && (
          <StreamThinkingBlock reasoning={reasoning} isStreaming={isStreaming} />
        )}

        <div className="relative text-sm text-text-primary leading-relaxed">
          {content ? (
            <MarkdownRenderer content={content} />
          ) : (
            isStreaming && (
              <div className="flex items-center gap-2 text-xs font-mono text-text-muted py-1 italic">
                <span className="terminal-cursor not-italic" aria-hidden="true" />
                <span>Đang chờ phản hồi từ model...</span>
              </div>
            )
          )}
          {isStreaming && content && (
            <span className="inline-block terminal-cursor ml-0.5 align-middle" aria-hidden="true" />
          )}
        </div>
      </div>
    </div>
  );
});
