import { describe, expect, it } from 'vitest';
import { stripEmulatedToolMarkup } from '@/lib/text-tool-guard';

describe('stripEmulatedToolMarkup — dọn markup tool-call trong kênh text', () => {
  it('khối chuẩn đóng đủ → loại bỏ toàn bộ', () => {
    const raw = 'Để tôi tra nhé.\n<tool_call>\n{"name":"web_search","arguments":{"query":"giá vàng"}}\n</tool_call>\n';
    const r = stripEmuted(raw);
    expect(r.text).toContain('Để tôi tra nhé.');
    expect(r.text).not.toContain('tool_call');
    expect(r.stripped).toBe(1);
  });
  function stripEmuted(s: string) {
    return stripEmulatedToolMarkup(s);
  }

  it('alias + attribute style + XML args đều bị nhận', () => {
    const raw = [
      '<function_call name="Read">',
      '<parameter name="file_path">/etc/hosts</parameter>',
      '</function_call>',
    ].join('\n');
    expect(stripEmulatedToolMarkup(raw).stripped).toBe(1);
    expect(stripEmulatedToolMarkup('<invoke name="x">\n</invoke>').stripped).toBe(1);
  });

  it('tag KHÔNG ĐÓNG (stream bị cắt) → cắt đuôi từ opener', () => {
    const raw = 'Trả lời đầu.\n<tool_call>\n{"name":"web_fetch","arguments":{"url":"https://x';
    const r = stripEmulatedToolMarkup(raw);
    expect(r.text).toBe('Trả lời đầu.');
    expect(r.stripped).toBe(1);
  });

  it('markup vendor DSML fullwidth của DeepSeek → sạch cả khối lẫn đuôi', () => {
    const block = [
      '<｜｜DSML｜｜tool_calls>',
      '<｜｜DSML｜｜invoke name="Read">',
      '<｜｜DSML｜｜parameter name="file_path" string="true">/etc/hosts</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '</｜｜DSML｜｜tool_calls>',
    ].join('\n');
    const r = stripEmulatedToolMarkup(`Xong.\n${block}`);
    expect(r.text).not.toContain('DSML');
    expect(r.stripped).toBeGreaterThanOrEqual(1);

    const unclosed = 'Bắt đầu\n<｜｜DSML｜｜invoke name="Read">';
    expect(stripEmulatedToolMarkup(unclosed).text).toBe('Bắt đầu');
  });

  it('nội dung TRONG code fence được giữ nguyên (ví dụ minh họa hợp lệ)', () => {
    const raw = 'Ví dụ:\n```\n<tool_call>\n{"name":"Ping","arguments":{}}\n</tool_call>\n```\nHết.';
    const r = stripEmulatedToolMarkup(raw);
    expect(r.stripped).toBe(0);
    expect(r.text).toContain('<tool_call>');
  });

  it('lời văn nhắc tag giữa câu không bị đụng tới', () => {
    const raw = 'Bạn có thể dùng <tool_call> để gọi tool, theo docs.';
    const r = stripEmulatedToolMarkup(raw);
    expect(r.stripped).toBe(0);
    expect(r.text).toBe(raw);
  });

  it('nhiều khối + close mồ côi → đếm đúng và dọn hết', () => {
    const raw = [
      '<tool_call>{"name":"a","arguments":{}}</tool_call>',
      'giữa',
      '<tool-call>{"name":"b","arguments":{}}</tool-call>',
      '</toolcall>',
    ].join('\n');
    const r = stripEmulatedToolMarkup(raw);
    expect(r.text.replace(/\n+/g, '\n').trim()).toBe('giữa');
    expect(r.stripped).toBeGreaterThanOrEqual(2);
  });

  it('prose bình thường đi qua nguyên văn', () => {
    const prose = '# Tiêu đề\n\nNội dung **markdown** với `code` và công thức $E=mc^2$.';
    expect(stripEmulatedToolMarkup(prose)).toEqual({ text: prose, stripped: 0 });
  });
});
