'use client';

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Check, Copy } from 'lucide-react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThrottledValue } from '@/lib/use-throttled-value';

// Register essential languages for fast bundle and light weight
import ts from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import js from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';

SyntaxHighlighter.registerLanguage('typescript', ts);
SyntaxHighlighter.registerLanguage('ts', ts);
SyntaxHighlighter.registerLanguage('javascript', js);
SyntaxHighlighter.registerLanguage('js', js);
SyntaxHighlighter.registerLanguage('jsx', jsx);
SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('py', python);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('sh', bash);
SyntaxHighlighter.registerLanguage('shell', bash);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('html', markup);
SyntaxHighlighter.registerLanguage('xml', markup);
SyntaxHighlighter.registerLanguage('markup', markup);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('md', markdown);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('yml', yaml);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('rs', rust);
SyntaxHighlighter.registerLanguage('cpp', cpp);
SyntaxHighlighter.registerLanguage('c', c);
SyntaxHighlighter.registerLanguage('java', java);
SyntaxHighlighter.registerLanguage('csharp', csharp);
SyntaxHighlighter.registerLanguage('cs', csharp);

// Tắt singleDollarTextMath để chống xung đột với ký tự tiền tệ $20, $50
const REMARK_PLUGINS: any[] = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];
const REHYPE_PLUGINS: any[] = [
  [rehypeKatex, { throwOnError: false, errorColor: '#71717a', strict: false }],
];

/* ------------------------------------------------------------------ */
/* Tiền xử lý: chỉ tác động NGOÀI code                                 */
/* ------------------------------------------------------------------ */

const CODE_MASK = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

function outsideCode(raw: string, fn: (chunk: string) => string): string {
  return raw
    .split(CODE_MASK)
    .map((chunk, i) => (i % 2 === 1 ? chunk : fn(chunk)))
    .join('');
}

/** Lưới an toàn cuối: dọn token rác dính ở cuối nội dung do backend/proxy sinh ra. */
const TRAILING_GARBAGE = /(?:\s*(?:undefined|\[object Object\]))+\s*$/;
function stripArtifacts(s: string): string {
  return s.replace(TRAILING_GARBAGE, '');
}

function normalizeLatex(s: string): string {
  return s
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `\n\n$$\n${body.trim()}\n$$\n\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$$${body.trim()}$$`);
}

/** $x$ -> $$x$$ chỉ khi nội dung "trông như" toán, để không phá $20, $50. */
const MATHY = /[\\^_]|\\frac|\\vec|\\sqrt|\\overrightarrow/;
function promoteSingleDollar(chunk: string): string {
  return chunk.replace(
    /(?<![$\d\w])\$(?!\s|\$)([^\n$]{1,300}?)(?<!\s)\$(?![$\d])/g,
    (m, body: string) => (MATHY.test(body) ? `$$${body}$$` : m),
  );
}

/**
 * Cắt bỏ phần công thức chưa đóng khi đang stream.
 * Bản cũ chỉ xoá dấu $$ lẻ nên phần thân LaTeX bị lộ ra dưới dạng văn bản thô
 * (\frac{1}{2}...). Ở đây ta cắt hẳn phần đuôi — tick sau nó sẽ xuất hiện lại đầy đủ.
 */
function stabilize(raw: string, isStreaming: boolean): string {
  let out = raw;

  if ((out.match(/```/g)?.length ?? 0) % 2 === 1) out += '\n```';
  if ((out.match(/~~~/g)?.length ?? 0) % 2 === 1) out += '\n~~~';

  if (!isStreaming) return out;

  const count = (re: RegExp) => out.match(re)?.length ?? 0;

  if (count(/\\\[/g) > count(/\\\]/g)) out = out.slice(0, out.lastIndexOf('\\['));
  if (count(/\\\(/g) > count(/\\\)/g)) out = out.slice(0, out.lastIndexOf('\\('));
  if (count(/\$\$/g) % 2 === 1) out = out.slice(0, out.lastIndexOf('$$'));

  // Backslash treo lơ lửng ở cuối chunk khiến KaTeX/remark-math nhấp nháy đỏ.
  out = out.replace(/\\+$/, '');

  return out;
}

function preprocess(raw: string, isStreaming: boolean): string {
  const stable = stabilize(stripArtifacts(raw), isStreaming);
  return outsideCode(stable, (chunk) => promoteSingleDollar(normalizeLatex(chunk)));
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
      t.current = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('[CodeBlock] copy failed:', err);
    }
  }, [value]);

  return (
    <div className="claude-code-block my-4">
      <div className="flex items-center justify-between border-b border-zinc-800/80 bg-[#141417] px-3 py-1.5">
        <span className="text-[11px] font-medium text-zinc-500 font-mono">{language || 'text'}</span>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-200 transition-colors"
          aria-label="Copy code"
        >
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          <span>{copied ? 'Đã chép' : 'Copy'}</span>
        </button>
      </div>

      {isStreaming ? (
        <pre className="m-0 p-3.5 overflow-x-auto bg-[#0d0d10] text-[13px] leading-relaxed font-mono text-zinc-300">
          <code>{value}</code>
        </pre>
      ) : (
        <SyntaxHighlighter
          style={vscDarkPlus}
          language={language || 'text'}
          PreTag="div"
          customStyle={{ margin: 0, padding: '0.9rem 1rem', background: '#0d0d10', fontSize: '13px', lineHeight: '1.6' }}
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
  content: unknown;
  isStreaming?: boolean;
  throttleMs?: number;
}) {
  // Chốt chặn cuối: content có thể là undefined/null/object nếu tầng trên rò lỗi.
  const safeContent = typeof content === 'string' ? content : '';
  const throttled = useThrottledValue(safeContent, throttleMs, isStreaming);

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

      code({ children }: any) {
        return (
          <code className="bg-[#1e1e22] border border-[#2a2a30] rounded px-1.5 py-0.5 text-[13px] font-mono text-[#e6b8a5] break-words">
            {children}
          </code>
        );
      },

      p: ({ children }: any) => <p className="mb-3.5 last:mb-0">{children}</p>,

      a: ({ href, children }: any) => (
        <a href={href} target="_blank" rel="noreferrer noopener" className="text-[#d98a6c] hover:underline underline-offset-2 break-words">
          {children}
        </a>
      ),

      table: ({ children }: any) => (
        <div className="my-4 w-full overflow-x-auto">
          <table className="w-full text-sm">{children}</table>
        </div>
      ),

      img({ src, alt }: any) {
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt ?? ''}
            loading="eager"
            decoding="async"
            className="my-3 max-h-72 w-auto max-w-full rounded-lg border border-zinc-800 object-contain"
            onLoad={() => {
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('chat:image-loaded'));
              }
            }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        );
      },
    }),
    [isStreaming],
  );

  return (
    <div className="w-full break-words [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
});

MarkdownRenderer.displayName = 'MarkdownRenderer';