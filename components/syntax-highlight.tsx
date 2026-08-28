'use client';

/**
 * Phần tô màu cú pháp, TÁCH RIÊNG để nạp động.
 *
 * Vì sao tách: `react-syntax-highlighter` + 18 gói ngôn ngữ Prism được đăng ký
 * ở module scope, nên chỉ cần import `markdown-renderer` là toàn bộ chúng vào
 * chunk khởi động — kể cả với người dùng chưa từng thấy một khối code nào.
 * Đo được KaTeX + Prism nằm trong chunk chính 967KB.
 *
 * Nạp động ở đây AN TOÀN vì `CodeBlock` đã có sẵn nhánh `<pre>` thuần: trong
 * lúc chờ chunk về, code vẫn hiển thị đầy đủ (chỉ chưa có màu), nên không có
 * hiện tượng nháy nội dung hay mất chữ.
 */

import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

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

const LANGS: Array<[string, unknown]> = [
  ['typescript', ts], ['ts', ts], ['javascript', js], ['js', js],
  ['jsx', jsx], ['tsx', tsx], ['python', python], ['py', python],
  ['bash', bash], ['sh', bash], ['shell', bash], ['json', json],
  ['css', css], ['html', markup], ['xml', markup], ['markup', markup],
  ['sql', sql], ['markdown', markdown], ['md', markdown],
  ['yaml', yaml], ['yml', yaml], ['go', go], ['rust', rust], ['rs', rust],
  ['cpp', cpp], ['c', c], ['java', java], ['csharp', csharp], ['cs', csharp],
];
for (const [name, mod] of LANGS) {
  SyntaxHighlighter.registerLanguage(name, mod as never);
}

export default function SyntaxHighlight({
  language,
  value,
}: {
  language: string;
  value: string;
}) {
  return (
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
  );
}
