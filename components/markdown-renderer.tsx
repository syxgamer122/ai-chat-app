import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Check, Copy } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

export const MarkdownRenderer = memo(({ content }: { content: string }) => {
  // Tiền xử lý để đảm bảo hỗ trợ cả format \(...\) và \[...\] mà nhiều model hay xuất ra
  const processedContent = content
    .replace(/\\\((.*?)\\\)/g, '$$$1$$') // Convert \( ... \) to $ ... $
    .replace(/\\\[(.*?)\\\]/gs, '$$$$$1$$$$'); // Convert \[ ... \] to $$ ... $$

  return (
    <ReactMarkdown
      className="prose prose-invert prose-p:leading-relaxed prose-pre:p-0 max-w-none w-full"
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        code({ node, inline, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || '');
          const [copied, setCopied] = React.useState(false);

          const onCopy = () => {
            navigator.clipboard.writeText(String(children).replace(/\n$/, ''));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          };

          if (!inline && match) {
            return (
              <div className="relative group rounded-md overflow-hidden my-4 border border-zinc-800 shadow-md">
                <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 text-xs text-zinc-400 font-mono">
                  <span>{match[1]}</span>
                  <button onClick={onCopy} className="hover:text-zinc-100 transition-colors" aria-label="Copy code">
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
                <SyntaxHighlighter
                  {...props}
                  style={vscDarkPlus}
                  language={match[1]}
                  PreTag="div"
                  customStyle={{ margin: 0, padding: '1rem', background: '#09090b', fontSize: '13px' }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              </div>
            );
          }
          return <code className="bg-zinc-800/50 rounded px-1.5 py-0.5 text-[13px] font-mono text-indigo-400" {...props}>{children}</code>;
        },
        p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">{children}</a>,
      }}
    >
      {processedContent}
    </ReactMarkdown>
  );
});

MarkdownRenderer.displayName = 'MarkdownRenderer';