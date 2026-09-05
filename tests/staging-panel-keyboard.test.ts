import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * StagingPanel không có bài test DOM (suite chạy environment: 'node', không có
 * jsdom trong deps), nên hai bài dưới đây soi source như tests/design-system.test.ts.
 * Chúng chặn đúng một regression: bắt Escape bằng onKeyDown trên container thì
 * phím chết ngay khi user click vào vùng diff (không focusable) và focus rơi về
 * document.body, lúc đó dialog không còn đóng được bằng bàn phím (R-32).
 */
describe('components/staging-panel.tsx: Escape đóng dialog bất kể focus đang ở đâu (R-32)', () => {
  const code = fs.readFileSync(path.resolve(__dirname, '../components/staging-panel.tsx'), 'utf8');

  it('nghe keydown ở tầng document và tháo listener khi đóng panel', () => {
    expect(code).toMatch(/document\.addEventListener\(\s*'keydown'/);
    expect(code).toMatch(/document\.removeEventListener\(\s*'keydown'/);
    expect(code).toMatch(/'Escape'/);
  });

  it('không xử lý Escape trong bất kỳ onKeyDown nào của JSX', () => {
    // Chỉ soi handler JSX thật (`onKeyDown={`), không soi chữ onKeyDown trong comment.
    const escapeInsideJsxHandler = /onKeyDown=\{[\s\S]{0,300}?['"]Escape['"]/;
    expect(escapeInsideJsxHandler.test(code)).toBe(false);
  });
});
