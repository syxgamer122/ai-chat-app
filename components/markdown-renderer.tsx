'use client';

import React, { memo, useCallback, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Check, Copy } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThrottledValue } from '@/lib/use-throttled-value';

/* Khai báo NGOÀI component: tránh tạo array mới mỗi render -> tránh
   việc react-markdown khởi tạo lại toàn bộ pipeline plugin. */
const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS: any[] = [
  [rehypeKatex, { throwOnError: false, errorColor: '#71717a', strict: false }],
];

/* ------------------------------------------------------------------ */
/* Tiền xử lý LaTeX                                                    */
/* ------------------------------------------------------------------ */

/**
 * Chuyển \( \) và \[ \] sang $ $ / $$ $$.
 * Dùng replacer dạng function để tránh cạm bẫy "$$" là ký tự escape
 * trong chuỗi thay thế của String.replace (bug rất khó thấy).
 */
function normalizeLatex(raw: string): string {
  return raw
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `\n\n$$\n${body.trim()}\n$$\n\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body.trim()}$`);
}

/**
 * Giữ cấu trúc Markdown hợp lệ giữa lúc stream để cây AST không "nhảy".
 * - fence ``` lẻ  -> đóng tạm
 * - $$ lẻ (khi stream) -> bỏ tạm cái cuối, tránh KaTeX báo lỗi nhấp nháy
 */
function stabilize(raw: string, isStreaming: boolean): string {
  let out = raw;

  const fences = out.match(/```/g)?.length ?? 0;
  if (fences % 2 === 1) out += '\n```';

  if (isStreaming) {
    const blocks = out.match(/\$\$/g)?.length ?? 0;
    if (blocks % 2 === 1) {
      const i = out.lastIndexOf('$$');
      out = out.slice(0, i) + out.slice(i + 2);
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Code block                                                          */
/* ------------------------------------------------------------------ */

interface CodeBlockProps {
  language: string;
  value: string;
  isStreaming: boolean;
}

const CodeBlock = memo(function CodeBlock({ language, value, isStreaming }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('[CodeBlock] copy failed:', err);
    }
  }, [value]);

  return (
    <div className="relative group rounded-md overflow-hidden my-4 border border-zinc-800 shadow-md">
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 text-xs text-zinc-400 font-mono">
        <span>{language || 'text'}</span>
        <button
          type="button"
          onClick={onCopy}
          className="hover:text-zinc-100 transition-colors"
          aria-label="Copy code"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      {isStreaming ? (
        /* CHẾ ĐỘ NHẸ: không tokenize, chỉ đổ text thuần. */
        <pre className="m-0 p-4 overflow-x-auto bg-[#09090b] text-[13px] leading-relaxed font-mono text-zinc-300">
          <code>{value}</code>
        </pre>
      ) : (
        <SyntaxHighlighter
          style={vscDarkPlus}
          language={language || 'text'}
          PreTag="div"
          customStyle={{ margin: 0, padding: '1rem', background: '#09090b', fontSize: '13px' }}
        >
          {value}
        </SyntaxHighlighter>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

interface MarkdownRendererProps {
  content: string;
  /** true khi tin nhắn này đang được stream */
  isStreaming?: boolean;
  /** cửa sổ gom render, ms */
  throttleMs?: number;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  isStreaming = false,
  throttleMs = 150,
}: MarkdownRendererProps) {
  const throttled = useThrottledValue(content ?? '', throttleMs, isStreaming);

  const source = useMemo(() => {
    try {
      return stabilize(normalizeLatex(throttled), isStreaming);
    } catch (err) {
      // Không bao giờ để lỗi regex làm trắng tin nhắn.
      console.error('[MarkdownRenderer] preprocess failed:', err);
      return throttled;
    }
  }, [throttled, isStreaming]);

  const components = useMemo(
    () => ({
      code({ className, children, ...props }: any) {
        const match = /language-(\w+)/.exec(className || '');
        const value = String(children ?? '').replace(/\n$/, '');

        /* react-markdown v9 bỏ prop `inline`; tự suy luận để tương thích v8 + v9. */
        const inline: boolean =
          props.inline ?? (!className && !value.includes('\n'));

        if (!inline) {
          return (
            <CodeBlock
              language={match?.[1] ?? ''}
              value={value}
              isStreaming={isStreaming}
            />
          );
        }

        return (
          <code className="bg-zinc-800/50 rounded px-1.5 py-0.5 text-[13px] font-mono text-indigo-400">
            {children}
          </code>
        );
      },
      p: ({ children }: any) => <p className="mb-4 last:mb-0">{children}</p>,
      a: ({ href, children }: any) => (
        <a href={href} target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">
          {children}
        </a>
      ),
    }),
    [isStreaming],
  );

  return (
    <div className="prose prose-invert prose-p:leading-relaxed prose-pre:p-0 max-w-none w-full">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});

MarkdownRenderer.displayName = 'MarkdownRenderer';