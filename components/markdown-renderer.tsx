'use client';

import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Check, Copy } from 'lucide-react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThrottledValue } from '@/lib/use-throttled-value';
import { preprocessMarkdown } from '@/lib/markdown-preprocess';

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

const LANGS: Array<[string, any]> = [
  ['typescript', ts], ['ts', ts], ['javascript', js], ['js', js],
  ['jsx', jsx], ['tsx', tsx], ['python', python], ['py', python],
  ['bash', bash], ['sh', bash], ['shell', bash], ['json', json],
  ['css', css], ['html', markup], ['xml', markup], ['markup', markup],
  ['sql', sql], ['markdown', markdown], ['md', markdown],
  ['yaml', yaml], ['yml', yaml], ['go', go], ['rust', rust], ['rs', rust],
  ['cpp', cpp], ['c', c], ['java', java], ['csharp', csharp], ['cs', csharp],
];
for (const [name, mod] of LANGS) SyntaxHighlighter.registerLanguage(name, mod);

/**
 * Macro mặc định. KaTeX GHI vào object macros khi gặp \gdef của user,
 * nên object này chỉ được dùng làm khuôn để clone — tuyệt đối không truyền
 * trực tiếp cho rehype-katex (sửa C1).
 */
const KATEX_MACRO_TEMPLATE: Record<string, string> = {
  '\\R': '\\mathbb{R}',
  '\\N': '\\mathbb{N}',
  '\\Z': '\\mathbb{Z}',
  '\\Q': '\\mathbb{Q}',
  '\\C': '\\mathbb{C}',
  '\\vec': '\\overrightarrow',
};

const REMARK_PLUGINS: any[] = [remarkGfm, [remarkMath, { singleDollarTextMath: true }]];

/* -------------------------------------------------------------------------- */
/* Thông báo ảnh load xong — MessageList lắng nghe để ghim đáy.               */
/* Việc đo lại chiều cao dòng do ResizeObserver của chính virtualizer đảm nhiệm. */
/* -------------------------------------------------------------------------- */

function emitImageLoaded(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('chat:image-loaded'));
}

/* -------------------------------------------------------------------------- */
/* Error boundary có khả năng phục hồi (sửa C2)                                */
/* -------------------------------------------------------------------------- */

interface BoundaryProps {
  children: React.ReactNode;
  fallbackText: string;
  /** Đổi giá trị này để reset trạng thái lỗi (dùng chính nội dung markdown). */
  resetKey: unknown;
}
interface BoundaryState {
  failed: boolean;
  lastKey: unknown;
}

class MarkdownErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false, lastKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    if (props.resetKey !== state.lastKey) {
      return { failed: false, lastKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: unknown) {
    console.error('[MarkdownRenderer] render crashed:', error);
  }

  render() {
    if (this.state.failed) {
      return (
        <pre className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-zinc-600">
          {this.props.fallbackText}
        </pre>
      );
    }
    return this.props.children as React.ReactElement;
  }
}

/* -------------------------------------------------------------------------- */
/* Code block                                                                  */
/* -------------------------------------------------------------------------- */

const MAX_HIGHLIGHT_CHARS = 20_000;

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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('[CodeBlock] copy failed:', err);
    }
  }, [value]);

  const highlight = !isStreaming && value.length <= MAX_HIGHLIGHT_CHARS;

  return (
    <div className="claude-code-block my-4">
      {/* Thanh công cụ nằm trên nền tối → dùng border/chữ sáng cho đủ tương phản. */}
      <div className="flex items-center justify-between border-b border-white/10 bg-surface-code-header px-3 py-1.5">
        <span className="font-mono text-[11px] font-medium text-zinc-400">
          {language || 'text'}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
          aria-label={copied ? 'Đã chép đoạn mã' : 'Chép đoạn mã'}
        >
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          <span>{copied ? 'Đã chép' : 'Chép'}</span>
        </button>
      </div>

      {highlight ? (
        <SyntaxHighlighter
          style={vscDarkPlus}
          language={language || 'text'}
          PreTag="pre"
          CodeTag="code"
          customStyle={{
            margin: 0,
            padding: '0.9rem 1rem',
            background: 'rgb(var(--surface-code))',
            fontSize: '13px',
            lineHeight: '1.6',
          }}
          codeTagProps={{ style: { fontSize: '13px', lineHeight: '1.6' } }}
        >
          {value}
        </SyntaxHighlighter>
      ) : (
        <pre className="m-0 overflow-x-auto bg-surface-code px-4 py-[0.9rem] font-mono text-[13px] leading-[1.6] text-zinc-300">
          <code>{value}</code>
        </pre>
      )}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* Renderer                                                                    */
/* -------------------------------------------------------------------------- */

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  isStreaming = false,
  throttleMs = 120,
}: {
  content: unknown;
  isStreaming?: boolean;
  throttleMs?: number;
}) {
  const safeContent = typeof content === 'string' ? content : '';
  const throttled = useThrottledValue(safeContent, throttleMs, isStreaming);

  /* Sửa C4: khi đã dừng stream, luôn dùng giá trị đầy đủ — không phụ thuộc
     vào việc hook có flush hay không. */
  const effective = isStreaming ? throttled : safeContent;

  const source = useMemo(() => {
    try {
      return preprocessMarkdown(effective, isStreaming);
    } catch (err) {
      console.error('[MarkdownRenderer] preprocess failed:', err);
      return effective;
    }
  }, [effective, isStreaming]);

  /* Sửa C1: mỗi instance có bản macros riêng, KaTeX ghi \gdef vào đây thì
     cũng không ảnh hưởng tin nhắn khác. */
  const rehypePlugins = useMemo<any[]>(
    () => [
      [
        rehypeKatex,
        {
          throwOnError: false,
          errorColor: '#a1a1aa',
          strict: 'ignore',
          trust: false,
          maxSize: 60,
          maxExpand: 1000,
          globalGroup: false,
          macros: { ...KATEX_MACRO_TEMPLATE },
          output: 'htmlAndMathml', // sửa C5: giữ MathML cho screen reader
        },
      ],
    ],
    [],
  );

  const streamingRef = useRef(isStreaming);
  streamingRef.current = isStreaming;

  const components = useMemo(
    () => ({
      pre({ node, children }: any) {
        const codeNode = node?.children?.find((c: any) => c.tagName === 'code');
        if (!codeNode) return <pre className="overflow-x-auto">{children}</pre>;

        const cls = Array.isArray(codeNode.properties?.className)
          ? codeNode.properties.className.join(' ')
          : String(codeNode.properties?.className ?? '');
        const lang = /language-([\w+#.-]+)/.exec(cls)?.[1] ?? '';
        const value = (codeNode.children ?? [])
          .map((c: any) => c.value ?? '')
          .join('')
          .replace(/\n$/, '');

        return <CodeBlock language={lang} value={value} isStreaming={streamingRef.current} />;
      },

      code({ children, className }: any) {
        if (typeof className === 'string' && className.includes('language-')) {
          return <code className={className}>{children}</code>;
        }
        return <code className="claude-inline-code">{children}</code>;
      },

      p: ({ children }: any) => <p className="mb-3.5 last:mb-0">{children}</p>,

      a: ({ href, children }: any) => {
        // Link video do AI tạo (qwen-video...) — phát trực tiếp trong chat.
        if (typeof href === 'string' && /\.(?:mp4|webm)(?:[?#]|$)/i.test(href)) {
          return (
            <video
              src={href}
              controls
              preload="metadata"
              className="my-2 max-h-[480px] w-auto max-w-full rounded-xl border border-zinc-200 bg-black shadow-sm"
              onLoadedMetadata={emitImageLoaded}
            />
          );
        }
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener nofollow"
            className="break-words text-brand underline-offset-2 hover:underline"
          >
            {children}
          </a>
        );
      },

      table: ({ children }: any) => (
        <div className="my-4 w-full overflow-x-auto">
          <table className="claude-table w-full text-sm">{children}</table>
        </div>
      ),

      img({ src, alt }: any) {
        // Một số nguồn/model trả video dưới dạng markdown img ![](…mp4) — phát thẳng.
        if (typeof src === 'string' && /\.(?:mp4|webm)(?:[?#]|$)/i.test(src)) {
          return (
            <video
              src={src}
              controls
              preload="metadata"
              className="my-2 max-h-[480px] w-auto max-w-full rounded-xl border border-zinc-200 bg-black shadow-sm"
              onLoadedMetadata={emitImageLoaded}
            />
          );
        }
        return (
          <a
            href={typeof src === 'string' ? src : '#'}
            target="_blank"
            rel="noreferrer noopener nofollow"
            className="my-2 block w-fit max-w-full"
            title="Mở ảnh gốc"
          >
            <img
              src={typeof src === 'string' ? src : ''}
              alt={alt ?? 'Ảnh do AI tạo'}
              loading="lazy"
              decoding="async"
              className="max-h-[420px] w-auto max-w-full rounded-xl border border-zinc-200 bg-white object-contain shadow-sm"
              onLoad={emitImageLoaded}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
                emitImageLoaded();
              }}
            />
          </a>
        );
      },
    }),
    [],
  );

  return (
    <div className="claude-md-root w-full break-words">
      <MarkdownErrorBoundary fallbackText={safeContent} resetKey={source}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={rehypePlugins}
          components={components}
        >
          {source}
        </ReactMarkdown>
      </MarkdownErrorBoundary>
    </div>
  );
});

MarkdownRenderer.displayName = 'MarkdownRenderer';