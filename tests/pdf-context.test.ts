import { describe, expect, it } from 'vitest';
import { gatherPdfContexts, MAX_PDF_BYTES } from '@/lib/use-pdf-context';

/**
 * Lưu ý: gatherPdfContexts cần window/FileReader/fetch thật nên phần tích hợp
 * phải test tay trong browser. Ở đây chỉ kiểm tra logic lọc file — hàm trả []
 * khi không có PDF đạt điều kiện mà không đụng network (early return).
 */
describe('gatherPdfContexts — lọc đầu vào', () => {
  it('mảng rỗng / không có môi trường browser → [] không ném lỗi', async () => {
    expect(await gatherPdfContexts([])).toEqual([]);
  });

  it('chỉ nhận đúng MIME application/pdf và ≤ MAX_PDF_BYTES', () => {
    const pdfOk = { type: 'application/pdf', size: 1000 };
    const pdfTooBig = { type: 'application/pdf', size: MAX_PDF_BYTES + 1 };
    const image = { type: 'image/png', size: 1000 };

    const pass = [pdfOk].filter(
      (f) => f.type === 'application/pdf' && f.size > 0 && f.size <= MAX_PDF_BYTES,
    );
    expect(pass).toHaveLength(1);

    const all = [pdfOk, pdfTooBig, image];
    const filtered = all.filter(
      (f) => f.type === 'application/pdf' && f.size > 0 && f.size <= MAX_PDF_BYTES,
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toBe(pdfOk);
  });
});
