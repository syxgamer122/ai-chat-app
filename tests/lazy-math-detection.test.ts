/**
 * KaTeX (~263KB chunk) chỉ nạp khi nội dung THỰC SỰ có công thức toán.
 * Regex dưới đây quyết định điều đó — sai một chiều thì công thức không
 * render, sai chiều kia thì tải thừa.
 *
 * Phải khớp CHÍNH XÁC `MATH_HINT_RE` trong components/markdown-renderer.tsx.
 */

import { describe, expect, it } from 'vitest';

const MATH_HINT_RE = /\$[^$\n]+\$|\$\$|\\\(|\\\[|\\begin\{/;

describe('MATH_HINT_RE — nhận diện công thức', () => {
  it.each([
    ['inline $…$', 'Ta có $E = mc^2$ nhé'],
    ['block $$…$$', 'Công thức:\n$$\\int_0^1 x\\,dx$$'],
    ['inline \\(…\\)', 'Giá trị \\(a+b\\) ở đây'],
    ['block \\[…\\]', 'Xét \\[x^2 + y^2\\] rồi'],
    ['môi trường \\begin{}', '\\begin{align} a &= b \\end{align}'],
    ['nhiều biến inline', 'Nghiệm $x_1$ và $x_2$'],
  ])('bắt được: %s', (_label, input) => {
    expect(MATH_HINT_RE.test(input)).toBe(true);
  });

  it.each([
    ['văn bản thường', 'Chào bạn, hôm nay thế nào?'],
    ['inline code', 'Dùng `const a = 1;` nhé'],
    ['code fence', '```js\nconst x = 5;\n```'],
    ['URL có $', 'Xem tại https://a.com/b$c'],
    ['rỗng', ''],
  ])('KHÔNG nạp KaTeX cho: %s', (_label, input) => {
    expect(MATH_HINT_RE.test(input)).toBe(false);
  });

  /* Dương tính giả ĐÃ BIẾT và chấp nhận được: hai ký hiệu tiền tệ trên cùng
     một dòng trông giống cặp `$…$`. Hậu quả duy nhất là tải thừa chunk KaTeX;
     nội dung KHÔNG bị đổi vì remark-math mới là bên quyết định đâu là công
     thức. Ghi lại ở đây để lần sau không ai tưởng là lỗi mới. */
  it('dương tính giả đã biết: hai ký hiệu tiền tệ cùng dòng', () => {
    expect(MATH_HINT_RE.test('Giá 100$ và 200$ khác nhau')).toBe(true);
  });

  it('một ký hiệu tiền tệ đơn lẻ thì không kích hoạt', () => {
    expect(MATH_HINT_RE.test('Giá 100$ thôi')).toBe(false);
  });
});
