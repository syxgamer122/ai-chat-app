'use client';

import React, { memo, useState, useCallback } from 'react';
import {
  ArrowLeftRight,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  Copy,
  FileCode,
  FileEdit,
  FilePlus,
  FileText,
  Folder,
  Loader2,
  Search,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';
import { SubagentCard, getSubagentAnnotations } from '@/components/subagent-card';

interface ToolEvent {
  id: string;
  name: string;
  /** true = đã có kết quả; false = đang chạy. */
  done: boolean;
  args: string;
  summary: string;
  isError?: boolean;
}

interface ToolInvocationLike {
  toolCallId?: string;
  state?: string;
  result?: unknown;
}

/** Gộp annotation tool + toolInvocations thành chuỗi sự kiện theo id.
 *  Export để test thuần (repo không có hạ tầng render DOM). */
export function collectToolEvents(
  annotations: Array<Record<string, unknown>> | undefined,
  toolInvocations: ToolInvocationLike[] | undefined,
): ToolEvent[] {
  if (!annotations?.length && !toolInvocations?.length) return [];
  const order: string[] = [];
  const byId = new Map<string, ToolEvent>();
  const push = (key: string) => {
    if (!byId.has(key)) {
      byId.set(key, { id: key, name: '', done: false, args: '', summary: '' });
      order.push(key);
    }
    return byId.get(key)!;
  };

  for (const ann of annotations ?? []) {
    const tool = ann?.tool as Record<string, unknown> | undefined;
    if (!tool || typeof tool !== 'object') continue;
    const id = String(tool.id ?? '');
    const key = id || `${String(tool.name)}:${order.length}`;
    const ev = push(key);
    ev.name = String(tool.name ?? ev.name ?? '');
    if (tool.phase === 'start') {
      ev.args = typeof tool.args === 'string' ? tool.args : '';
      ev.done = false;
    } else if (tool.phase === 'done') {
      ev.summary = typeof tool.summary === 'string' ? tool.summary : '';
      ev.done = true;
      if (tool.error || tool.isError) ev.isError = true;
    }
  }

  for (const inv of toolInvocations ?? []) {
    if (!inv?.toolCallId) continue;
    const ev = push(String(inv.toolCallId));
    if (inv.state === 'result') {
      ev.done = true;
      if (typeof inv.result === 'string' && !ev.summary) {
        ev.summary = inv.result;
      }
    }
  }

  return order.map((k) => byId.get(k)!).filter((ev) => ev.name);
}

const TOOL_META: Record<string, { label: string; Icon: React.ElementType; color?: string }> = {
  // Core agent tools
  read: { label: 'read', Icon: FileText },
  write: { label: 'write', Icon: FilePlus },
  edit: { label: 'edit', Icon: FileEdit },
  bash: { label: 'bash', Icon: Terminal },
  run_command: { label: 'bash', Icon: Terminal },
  shell: { label: 'shell', Icon: Terminal },

  // Filesystem
  fs_readFile: { label: 'read', Icon: FileText },
  fs_writeFile: { label: 'write', Icon: FilePlus },
  fs_editFile: { label: 'edit', Icon: FileEdit },
  fs_listDir: { label: 'ls', Icon: Folder },
  list_dir: { label: 'ls', Icon: Folder },
  read_file: { label: 'read', Icon: FileText },
  write_to_file: { label: 'write', Icon: FilePlus },
  replace_file_content: { label: 'edit', Icon: FileEdit },

  // Web & search
  web_search: { label: 'search', Icon: Search },
  search_web: { label: 'search', Icon: Search },
  web_fetch: { label: 'fetch', Icon: FileCode },
  read_url_content: { label: 'fetch', Icon: FileCode },

  // Utilities
  weather: { label: 'weather', Icon: Cloud },
  exchange_rates: { label: 'exchange', Icon: ArrowLeftRight },
  memory_search: { label: 'memory', Icon: Brain },
};

function formatToolDetail(text: string) {
  if (!text) return null;
  // If text contains JSON string, extract relevant field
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.path || parsed.filePath || parsed.targetFile) {
        return parsed.path || parsed.filePath || parsed.targetFile;
      }
      if (parsed.command || parsed.cmd) {
        return parsed.command || parsed.cmd;
      }
      if (parsed.query) {
        return parsed.query;
      }
      if (parsed.url) {
        return parsed.url;
      }
    } catch {
      // ignore
    }
  }
  return text;
}

function ToolChip({ ev }: { ev: ToolEvent }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const meta = TOOL_META[ev.name] ?? { label: ev.name, Icon: Wrench };
  const { Icon } = meta;

  const displayParam = formatToolDetail(ev.args);
  const hasOutput = Boolean(ev.summary && ev.summary.trim());

  const onCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(ev.summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }, [ev.summary]);

  return (
    <div
      className={`my-1 rounded-none border font-mono text-xs ${
        ev.isError
          ? 'border-[#e8704f]/40 bg-[#e8704f]/10'
          : ev.done
            ? 'border-[#495059] bg-[#212730]'
            : 'border-[#6a9fcc] bg-[#212730]'
      }`}
    >
      <button
        type="button"
        onClick={() => hasOutput && setExpanded(!expanded)}
        disabled={!hasOutput}
        aria-expanded={hasOutput ? expanded : undefined}
        className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left ${
          hasOutput ? 'cursor-pointer hover:bg-white/[0.04]' : 'cursor-default'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[#6a9fcc] font-bold text-[11px]">$</span>
          <div className="flex items-center gap-1 font-semibold text-[#ebe7e4]">
            <Icon size={12} className="text-[#6a9fcc]" />
            <span>{meta.label}</span>
          </div>

          {displayParam && (
            <span className="truncate text-[#9fa4ab] text-[11px] max-w-[280px] sm:max-w-[420px]">
              {displayParam}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0 text-[11px]">
          {ev.done ? (
            ev.isError ? (
              <span className="flex items-center gap-1 text-[#e8704f]">
                <XCircle size={12} />
                <span>error</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[#5db87a]">
                <Check size={12} />
                <span>done</span>
              </span>
            )
          ) : (
            <span className="flex items-center gap-1 text-[#e8993a]">
              <Loader2 size={12} className="animate-spin text-[#6a9fcc]" />
              <span>running</span>
            </span>
          )}

          {hasOutput && (
            <span className="ml-1 text-[#9fa4ab]">
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </span>
          )}
        </div>
      </button>

      {expanded && hasOutput && (
        <div className="border-t border-[#495059] bg-[#161d27] px-3 py-2 text-[11.5px] leading-relaxed">
          <div className="flex items-center justify-between pb-1.5 text-[10px] text-[#9fa4ab]">
            <span>OUTPUT</span>
            <button
              type="button"
              onClick={onCopy}
              className="flex items-center gap-1 hover:text-[#ebe7e4]"
            >
              {copied ? <Check size={10} className="text-[#5db87a]" /> : <Copy size={10} />}
              <span>{copied ? 'copied' : 'copy'}</span>
            </button>
          </div>
          <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap font-mono text-[#ebe7e4]">
            {ev.summary.split('\n').map((line, idx) => {
              const isAdded = line.startsWith('+');
              const isRemoved = line.startsWith('-');
              return (
                <div
                  key={idx}
                  className={
                    isAdded
                      ? 'diff-line-added px-1'
                      : isRemoved
                        ? 'diff-line-removed px-1'
                        : ''
                  }
                >
                  {line}
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </div>
  );
}

export const ToolTrace = memo(function ToolTrace({
  annotations,
  toolInvocations,
}: {
  annotations?: Array<Record<string, unknown>>;
  toolInvocations?: ToolInvocationLike[];
}) {
  const events = collectToolEvents(annotations, toolInvocations);
  const subagentAnns = getSubagentAnnotations(annotations);
  if (events.length === 0 && subagentAnns.length === 0) return null;

  return (
    <>
      {subagentAnns.map((ann, i) => (
        <SubagentCard key={i} annotation={ann} />
      ))}
      {events.length > 0 && (
        <div className="my-2 flex flex-col" role="list" aria-label="Tool executions">
          {events.map((ev) => (
            <ToolChip key={ev.id} ev={ev} />
          ))}
        </div>
      )}
    </>
  );
});
