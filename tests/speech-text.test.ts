import { describe, expect, it } from 'vitest';
import {
  chunkSpeechText,
  stripMarkdownForSpeech,
  SPEECH_TEXT_MAX_CHARS,
} from '@/lib/speech-text';
import { detectSpeechLang, pickVoice } from '@/lib/use-tts';

describe('stripMarkdownForSpeech', () => {
  it('giữ văn bản thường nguyên vẹn', () => {
    expect(stripMarkdownForSpeech('Xin chào, đây là câu trả lời.')).toBe(
      'Xin chào, đây là câu trả lời.',
    );
  });

  it('bỏ fenced code block kể cả khi thiếu fence đóng (đang stream)', () => {
    const md = 'Trước code\n```js\nconst x = 1;\nconsole.log(x);\n```\nSau code';
    expect(stripMarkdownForSpeech(md)).toBe('Trước code Sau code');

    const streaming = 'Đang trả lời:\n```python\nprint("chưa đóng")';
    expect(stripMarkdownForSpeech(streaming)).toBe('Đang trả lời:');
  });

  it('bỏ công thức display math và \\[..\\], \\(..\\)', () => {
    expect(stripMarkdownForSpeech('Công thức: $$E = mc^2$$ xong.')).toBe('Công thức: xong.');
    expect(stripMarkdownForSpeech('Khối \\[a+b\\] và nội suy \\(c\\)')).toBe('Khối và nội suy');
  });

  it('link giữ chữ vứt URL, ảnh bỏ hẳn', () => {
    expect(stripMarkdownForSpeech('[tài liệu](https://example.com/a) nhé')).toBe('tài liệu nhé');
    expect(stripMarkdownForSpeech('ảnh ![mô tả](https://x.com/i.png) đây')).toBe('ảnh đây');
  });

  it('URL trần bị cắt', () => {
    expect(stripMarkdownForSpeech('Xem https://example.com/very/long/path?q=1 chi tiết')).toBe(
      'Xem chi tiết',
    );
  });

  it('gỡ ký hiệu heading/bold/italic/quote/list nhưng giữ chữ', () => {
    const md = [
      '## Tiêu đề',
      '> Trích dẫn',
      '- Gạch đầu dòng',
      '*[Nhấn mạnh]* và **in đậm** với `code`',
    ].join('\n');
    const out = stripMarkdownForSpeech(md);
    expect(out).toContain('Tiêu đề');
    expect(out).toContain('Trích dẫn');
    expect(out).toContain('Gạch đầu dòng');
    expect(out).toContain('Nhấn mạnh');
    expect(out).toContain('in đậm');
    expect(out).toContain('code');
    expect(out).not.toMatch(/[#>*_`]/);
  });

  it('bảng: hàng phân cách biến mất, các cột đọc thành chuỗi phẩy', () => {
    const table = '| Tên | Tuổi |\n| --- | --- |\n| An | 30 |';
    const out = stripMarkdownForSpeech(table);
    expect(out).not.toContain('-');
    expect(out).not.toContain('|');
    expect(out).toContain('Tên , Tuổi');
    expect(out).toContain('An , 30');
  });

  it('cắt chuỗi dài tại khoảng trắng gần trần nhất', () => {
    const word = 'ab '.repeat(SPEECH_TEXT_MAX_CHARS); // dài gấp đôi trần
    const out = stripMarkdownForSpeech(word);
    expect(out.length).toBeLessThanOrEqual(SPEECH_TEXT_MAX_CHARS);
    expect(out.endsWith('ab')).toBe(true);
  });
});

describe('chunkSpeechText', () => {
  it('text ngắn trả đúng 1 chunk', () => {
    expect(chunkSpeechText('Ngắn gọn.')).toEqual(['Ngắn gọn.']);
    expect(chunkSpeechText('   ')).toEqual([]);
  });

  it('text dài đứt tại dấu câu, không vượt maxChars quá xa', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Câu thứ ${i} này có độ dài vừa phải.`).join(' ');
    const chunks = chunkSpeechText(text, 80);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100); // cho phép lố nhẹ vì đứt theo câu
      expect(c.trim()).toBe(c);
    }
    // Ghép lại vẫn đủ nội dung
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain('Câu thứ 9');
  });

  it('chuỗi không dấu câu vẫn chia được tại space', () => {
    const chunks = chunkSpeechText('x'.repeat(50) + ' ' + 'y'.repeat(50), 60);
    expect(chunks).toHaveLength(2);
  });
});

describe('detectSpeechLang + pickVoice', () => {
  it('nhận diện tiếng Việt qua tỷ lệ ký tự có dấu', () => {
    expect(detectSpeechLang('Xin chào Việt Nam hữu nghị')).toBe('vi-VN');
    expect(detectSpeechLang('Hello world, this is English')).toBe('en-US');
  });

  it('pickVoice ưu tiên đúng lang → cùng gốc → default', () => {
    const mkVoice = (lang: string, def = false): SpeechSynthesisVoice =>
      ({ lang, default: def, localService: true, name: lang, voiceURI: lang } as SpeechSynthesisVoice);
    const enGb = mkVoice('en-GB');
    const vi = mkVoice('vi-VN');
    const def = mkVoice('en-US', true);
    const voices = [enGb, vi, def];

    expect(pickVoice(voices, 'vi-VN')).toBe(vi);
    expect(pickVoice(voices, 'en-GB')).toBe(enGb);
    // Không có khớp → default
    expect(pickVoice([def], 'ja-JP')).toBe(def);
    expect(pickVoice([], 'vi-VN')).toBeNull();
  });
});
