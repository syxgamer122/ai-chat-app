'use client';

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Check, Copy } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThrottledValue } from '@/lib/use-throttled-value';

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS: any[] = [
  [rehypeKatex, { throwOnError: false, errorColor: '#71717a', strict: false }],
];

/* ------------------------------------------------------------------ */
/* Tiền xử lý: chỉ tác động NGOÀI code                                 */
/* ------------------------------------------------------------------ */

/** split() với capture group -> phần tử index lẻ chính là code, giữ nguyên. */
const CODE_MASK = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

function outsideCode(raw: string, fn: (chunk: string) => string): string {
  return raw
    .split(CODE_MASK)
    .map((chunk, i) => (i % 2 === 1 ? chunk : fn(chunk)))
    .join('');
}

function normalizeLatex(s: string): string {
  return s
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `\n\n$$\n${body.trim()}\n$$\n\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body.trim()}$`);
}

/**
 * Heuristic tiền tệ: dòng chỉ có ĐÚNG 1 dấu $ và ngay sau là chữ số
 * -> gần như chắc chắn là giá tiền, escape để remark-math không bắt.
 * Không dùng lookbehind (Safari cũ không hỗ trợ).
 */
function escapeCurrency(s: string): string {
  return s
    .split('\n')
    .map((line) => ((line.match(/\$/g) ?? []).length === 1 ? line.replace(/\$(?=\d)/, '\\$') : line))
    .join('\n');
}

function stabilize(raw: string, isStreaming: boolean): string {
  let out = raw;

  if ((out.match(/```/g)?.length ?? 0) % 2 === 1) out += '\n```';
  if ((out.match(/~~~/g)?.length ?? 0) % 2 === 1) out += '\n~~~';

  if (isStreaming) {
    // $$ lẻ -> bỏ tạm để KaTeX không nhấp nháy đỏ.
    if ((out.match(/\$\$/g)?.length ?? 0) % 2 === 1) {
      const i = out.lastIndexOf('$$');
      out = out.slice(0, i) + out.slice(i + 2);
    }
    // $ đơn lẻ ở cuối -> cắt nốt (inline math chưa đóng).
    const singles = out.replace(/\$\$/g, '').match(/\$/g)?.length ?? 0;
    if (singles % 2 === 1) {
      const i = out.lastIndexOf('$');
      out = out.slice(0, i) + out.slice(i + 1);
    }
  }

  return out;
}

function preprocess(raw: string, isStreaming: boolean): string {
  // stabilize TRƯỚC để fence được đóng -> mask code mới chính xác.
  const stable = stabilize(raw, isStreaming);
  return outsideCode(stable, (chunk) => escapeCurrency(normalizeLatex(chunk)));
}

/* ------------------------------------------------------------------ */
/* Code block                                                          */
/* ------------------------------------------------------------------ */

const CodeBlock = memo(function CodeBlock({
  language,
  value,
  isStreaming,
}: {
  language: string;
  value: string;
  isStreaming: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (t.current) clearTimeout(t.current);
      t.current = setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('[CodeBlock] copy failed:', err);
    }
  }, [value]);

  return (
    <div className="relative group/code rounded-md overflow-hidden my-4 border border-zinc-800 shadow-md">
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 text-xs text-zinc-400 font-mono">
        <span>{language || 'text'}</span>
        <button type="button" onClick={onCopy} className="hover:text-zinc-100 transition-colors" aria-label="Copy code">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      {isStreaming ? (
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

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  isStreaming = false,
  throttleMs = 150,
}: {
  content: string;
  isStreaming?: boolean;
  throttleMs?: number;
}) {
  const throttled = useThrottledValue(content ?? '', throttleMs, isStreaming);

  const source = useMemo(() => {
    try {
      return preprocess(throttled, isStreaming);
    } catch (err) {
      console.error('[MarkdownRenderer] preprocess failed:', err);
      return throttled;
    }
  }, [throttled, isStreaming]);

  const components = useMemo(
    () => ({
      /* Fenced code: xử lý ở tầng `pre`, đọc thẳng từ hast -> không đoán inline. */
      pre({ node, children }: any) {
        const codeNode = node?.children?.find((c: any) => c.tagName === 'code');
        if (!codeNode) return <pre className="overflow-x-auto">{children}</pre>;

        const cls = Array.isArray(codeNode.properties?.className)
          ? codeNode.properties.className.join(' ')
          : String(codeNode.properties?.className ?? '');
        const lang = /language-([\w+#-]+)/.exec(cls)?.[1] ?? '';
        const value = (codeNode.children ?? [])
          .map((c: any) => c.value ?? '')
          .join('')
          .replace(/\n$/, '');

        return <CodeBlock language={lang} value={value} isStreaming={isStreaming} />;
      },

      /* Tới đây chỉ còn inline code. */
      code({ children }: any) {
        return (
          <code className="bg-zinc-800/50 rounded px-1.5 py-0.5 text-[13px] font-mono text-indigo-400 break-words">
            {children}
          </code>
        );
      },

      p: ({ children }: any) => <p className="mb-4 last:mb-0">{children}</p>,

      a: ({ href, children }: any) => (
        <a href={href} target="_blank" rel="noreferrer noopener" className="text-indigo-400 hover:underline break-words">
          {children}
        </a>
      ),

      /* Bảng GFM tràn ngang trên mobile -> bọc scroll container. */
      table: ({ children }: any) => (
        <div className="my-4 w-full overflow-x-auto">
          <table className="w-full text-sm">{children}</table>
        </div>
      ),

      img: ({ src, alt }: any) => (
        <img src={src} alt={alt ?? ''} loading="lazy" className="rounded-xl max-w-full h-auto" />
      ),
    }),
    [isStreaming],
  );

  return (
    <div className="prose prose-invert prose-p:leading-relaxed prose-pre:p-0 max-w-none w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
});

MarkdownRenderer.displayName = 'MarkdownRenderer';