'use client';

import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import dynamic from 'next/dynamic';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { Check, Copy } from 'lucide-react';
import { useThrottledValue } from '@/lib/use-throttled-value';
import { preprocessMarkdown } from '@/lib/markdown-preprocess';

/** Khối code thuần — dùng cho cả nhánh không tô màu lẫn lúc chờ nạp chunk. */
function PlainCode({ value }: { value: string }) {
  return (
    <pre className="m-0 overflow-x-auto bg-surface-code px-4 py-[0.9rem] font-mono text-[13px] leading-[1.6] text-[rgb(212,212,216)]">
      <code>{value}</code>
    </pre>
  );
}

/**
 * Tô màu cú pháp nạp ĐỘNG (xem components/syntax-highlight.tsx): thư viện này
 * cộng 18 gói ngôn ngữ Prism từng nằm trong chunk khởi động, tải cho cả người
 * dùng chưa từng xem khối code nào.
 *
 * An toàn vì trong lúc chunk đang về, `SyntaxHighlightGate` hiện <PlainCode>
 * với ĐÚNG nội dung — người dùng đọc được code ngay, chỉ chưa có màu; không
 * có khoảng trống hay nháy mất chữ.
 */
const SyntaxHighlight = dynamic(() => import('@/components/syntax-highlight'), {
  ssr: false,
  loading: () => null,
});

/**
 * Bọc bản nạp động: hiện code THUẦN cho tới khi chunk highlight sẵn sàng.
 * Không dùng `loading` của next/dynamic vì nó không nhận được `value`.
 */
function SyntaxHighlightGate({ language, value }: { language: string; value: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void import('@/components/syntax-highlight').then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return ready ? <SyntaxHighlight language={language} value={value} /> : <PlainCode value={value} />;
}

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

/* ------------------------------------------------------------------ */
/* KaTeX — nạp theo yêu cầu                                            */
/* ------------------------------------------------------------------ */

/**
 * KaTeX là gói NẶNG NHẤT trong bundle (3.9 MB trên đĩa) nhưng chỉ cần khi tin
 * nhắn thực sự có công thức toán — phần lớn hội thoại thì không.
 *
 * Không dùng `next/dynamic` được vì đây là plugin của unified/rehype, không
 * phải component. Thay vào đó: nhận diện dấu hiệu toán trong nội dung → nếu
 * có thì `import()` module rồi re-render với plugin đã nạp.
 *
 * An toàn: khi chưa nạp xong, `rehypePlugins` rỗng nên `remark-math` vẫn
 * parse ra node `math`/`inlineMath` và ReactMarkdown bỏ qua chúng — công thức
 * hiện dạng chữ thuần trong tích tắc rồi thành công thức. Không mất nội dung.
 */
const MATH_HINT_RE = /\$[^$\n]+\$|\$\$|\\\(|\\\[|\\begin\{/;

let katexModulePromise: Promise<any> | null = null;
let katexModule: any = null;

function loadKatex(): Promise<any> {
  if (katexModule) return Promise.resolve(katexModule);
  if (!katexModulePromise) {
    // CSS của KaTeX (~23.8KB) đi CÙNG chunk JS của rehype-katex: import trong
    // cùng biểu thức dynamic import để webpack gộp vào một chunk tải theo nhu
    // cầu. Trước đây CSS này nằm trong @import đầu globals.css nên mọi người
    // dùng đều trả kể cả khi không bao giờ xem công thức. Vì module này bị
    // message-item import tĩnh (nằm trong chunk khởi động), import CSS tĩnh
    // ở đây sẽ chỉ đẩy vấn đề trở lại CSS chính — phải là dynamic import.
    katexModulePromise = Promise.all([
      import('rehype-katex'),
      import('katex/dist/katex.min.css'),
    ]).then(([m]) => {
      katexModule = m.default ?? m;
      return katexModule;
    });
  }
  return katexModulePromise;
}

/**
 * CDN media của Qwen (cdn.qwenlm.ai) chặn hotlink theo `Referer`: mọi request
 * có Referer khác domain của họ trả 403. Trình duyệt tự gắn Referer của trang
 * (localhost / vercel), nên <img>/<video> bị 403 và KHÔNG hiển thị dù URL đúng.
 * `no-referrer` bỏ hẳn Referer → CDN cho qua (đã kiểm chứng: có Referer=403,
 * không Referer=206). Ảnh assistant tạo phải dùng policy này.
 */
const MEDIA_REFERRER_POLICY = 'no-referrer' as const;

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
      <div className="flex items-center justify-between border-b border-[#495059] bg-[#161d27] px-3 py-1.5">
        <span className="font-mono text-[11px] font-medium text-[#9fa4ab]">
          {language || 'text'}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1 rounded-none px-1 py-0.5 text-[11px] text-[#9fa4ab] transition-colors hover:bg-white/10 hover:text-[#ebe7e4]"
          aria-label={copied ? 'Đã chép đoạn mã' : 'Chép đoạn mã'}
        >
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          <span>{copied ? 'Đã chép' : 'Chép'}</span>
        </button>
      </div>

      {highlight ? (
        <SyntaxHighlightGate language={language} value={value} />
      ) : (
        <PlainCode value={value} />
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

  /* Chỉ nạp KaTeX khi nội dung có dấu hiệu công thức (xem loadKatex).
     `katexModule` là biến module-level nên tin nhắn thứ hai trở đi dùng lại
     ngay, không chờ thêm lần nào. */
  const needsMath = useMemo(() => MATH_HINT_RE.test(source), [source]);
  const [katexReady, setKatexReady] = useState(() => katexModule !== null);

  useEffect(() => {
    if (!needsMath || katexReady) return;
    let alive = true;
    void loadKatex()
      .then(() => {
        if (alive) setKatexReady(true);
      })
      .catch((err) => {
        console.error('[MarkdownRenderer] không nạp được KaTeX:', err);
      });
    return () => {
      alive = false;
    };
  }, [needsMath, katexReady]);

  /* Sửa C1: mỗi instance có bản macros riêng, KaTeX ghi \gdef vào đây thì
     cũng không ảnh hưởng tin nhắn khác. */
  const rehypePlugins = useMemo<any[]>(() => {
    if (!needsMath || !katexReady || !katexModule) return [];
    return [
      [
        katexModule,
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
    ];
  }, [needsMath, katexReady]);

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
        // Referer bị bỏ ở cấp document (layout.tsx `referrer: no-referrer`) —
        // <video> không có thuộc tính referrerPolicy riêng nên phải dựa vào đó.
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
              referrerPolicy={MEDIA_REFERRER_POLICY}
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