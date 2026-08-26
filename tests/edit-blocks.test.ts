import { describe, expect, it } from 'vitest';
import { findSimilarLines, parseEditBlocks, replaceMostSimilarChunk } from '@/lib/edit-blocks';

const FILE = `import { a } from './a';

function main() {
  console.log("hi");
  return 1;
}

main();
`;

describe('parseEditBlocks — parser khoan dung', () => {
  it('khối chuẩn + tên file ở dòng trước', () => {
    const r = parseEditBlocks(
      'Sửa file main.ts:\n```ts\n<<<<<<< SEARCH\n  return 1;\n=======\n  return 42;\n>>>>>>> REPLACE\n```',
    );
    expect(r.error).toBeUndefined();
    expect(r.blocks[0].filename).toContain('main.ts');
    expect(r.blocks[0].search).toContain('return 1;');
    expect(r.blocks[0].replace).toContain('return 42;');
  });

  it('marker 5-9 ký tự + thiếu > cuối HEAD đều ăn', () => {
    for (const head of ['<<<<<<< SEARCH', '<<<<< SEARCH', '<<<<<<< SEARCH>']) {
      const r = parseEditBlocks(`x.ts\n${head}\nA\n=======\nB\n>>>>>>> REPLACE`);
      expect(r.blocks).toHaveLength(1);
    }
  });

  it('nhiều khối cùng file → tên carry-over', () => {
    const r = parseEditBlocks(
      'a.ts\n<<<<<<< SEARCH\n1\n=======\n2\n>>>>>>> REPLACE\n\n<<<<<<< SEARCH\n3\n=======\n4\n>>>>>>> REPLACE',
    );
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[1].filename).toBe('a.ts');
  });

  it('shell fence KHÔNG phải editblock → bỏ qua', () => {
    const r = parseEditBlocks('```bash\nls -la\n```\n\nb.ts\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE');
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].filename).toBe('b.ts');
  });

  it('thiếu tên file + không có lịch sử → error có hướng dẫn', () => {
    const r = parseEditBlocks('<<<<<<< SEARCH\nA\n=======\nB\n>>>>>>> REPLACE');
    expect(r.error).toContain('tên file');
  });

  it('thiếu ======= → error', () => {
    const r = parseEditBlocks('a.ts\n<<<<<<< SEARCH\nA\n');
    expect(r.error).toContain('=======');
  });
});

describe('replaceMostSimilarChunk — chuỗi fallback của aider', () => {
  it('exact match (indent đúng nguyên văn)', () => {
    const r = replaceMostSimilarChunk(FILE, '  return 1;', '  return 42;');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('return 42;');
    expect(r.strategy).toBe('exact');
  });

  it('không indent → nhánh whitespace bù prefix (vẫn ok)', () => {
    const r = replaceMostSimilarChunk(FILE, 'return 1;', 'return 42;');
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe('whitespace');
    expect(r.text).toContain('  return 42;');
  });

  it('indent ĐỀU khác nhau → bù lại prefix', () => {
    // Model viết không indent, file có 2 space — phải tự bù.
    const r = replaceMostSimilarChunk(FILE, 'console.log("hi");\nreturn 1;', 'console.log("hello");\nreturn 2;');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('  console.log("hello");');
    expect(r.text).toContain('  return 2;');
  });

  it('dòng trắng đầu khối thừa (khối ≥3 dòng, phần sau thẳng hàng) → bỏ và khớp', () => {
    const r = replaceMostSimilarChunk(
      FILE,
      '\nfunction main() {\n  console.log("hi");\n',
      'function main() {\n  console.log("hello");\n',
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain('console.log("hello");');
    expect(r.text).not.toContain('"hi");');
  });

  it('elision "..." — thay đoạn giữa (CẢ HAI vế phải có ...)', () => {
    const part = '  console.log("hi");\n...\n  return 1;';
    const replace = '  console.log("hi");\n...\n  return 42;';
    const r = replaceMostSimilarChunk(FILE, part, replace);
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe('dotdotdots');
    expect(r.text).toContain('return 42;');
    expect(r.text).toContain('main();'); // phần ngoài khối còn nguyên
  });

  it('SEARCH không có (đuôi không khớp) → ok:false + hint chứa đoạn giống nhất', () => {
    const r = replaceMostSimilarChunk(
      FILE,
      'console.log("hi");\nreturn 1;\nextra tail line;',
      'return 0;',
    );
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
    expect(r.hint).toContain('return 1;');
  });

  it('fuzzy TẮT mặc định (quyết định của aider — nguy hiểm)', () => {
    const r = replaceMostSimilarChunk(FILE, 'totally different text\nno match at all', 'x');
    expect(r.ok).toBe(false);
  });
});

describe('findSimilarLines', () => {
  it('tìm cửa sổ trùng nhiều dòng nhất', () => {
    const hint = findSimilarLines('console.log("hi");\nreturn 1;', FILE);
    expect(hint).toContain('console.log');
    expect(hint).toContain('return 1;');
  });

  it('file không có gì giống → null', () => {
    expect(findSimilarLines('zzzz\nyyyy', FILE)).toBeNull();
  });
});
