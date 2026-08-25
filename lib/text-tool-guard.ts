/**
 * Text-channel tool-call guard — dọn markup "model tự gọi tool bằng chữ"
 * trước khi hiển thị/lưu.
 *
 * Hiện tượng thật (emutools ghi nhận làm regression fixture): kể cả KHÔNG
 * gửi field `tools`, một số model đã bị fine-tune với tool channel vẫn nhả
 * markup vào kênh text — từ dạng chuẩn `<tool_call>{...}</tool_call>` đến
 * markup vendor nguyên bản như `<｜｜DSML｜｜invoke name="Read">` của
 * DeepSeek. Không có lớp này, user nhìn thấy rác XML thay vì câu trả lời.
 *
 * Thiết kế bảo thủ để không nuốt nội dung chính đáng:
 * - Chỉ strip tag NẰM ĐỨNG RIÊNG DÒNG (^ với optional whitespace) — lời văn
 *   bình thường nhắc "<tool_call>" giữa câu không bị đụng tới.
 * - Bỏ qua phần nằm TRONG code fence ``` ``` — người ta hay dạy/ví dụ về
 *   format này trong markdown block.
 * - Xử lý cả tag KHÔNG CÓ ĐÓNG (stream bị stop-sequence cắt) — cắt đuôi từ
   opener trở đi; chạy theo từng lần render nên đang stream cũng sạch.
 */

/** Alias tag mở được emutools + thực tế chấp nhận. */
const TAG_ALIASES = 'tool_call|tool-call|toolcall|function_call|function-call|tool_use|tooluse|invoke';

/** Khối ĐÓNG đủ: <alias ...> ... </alias> — đứng riêng dòng, lazy tới close đầu tiên. */
const CLOSED_BLOCK_RE = new RegExp(
  `^[ \\t]*<(?:${TAG_ALIASES})\\b[^>]*>[\\s\\S]*?<\\/(?:${TAG_ALIASES})>[ \\t]*(?=\\n|$)`,
  'gim',
);

/** Opener KHÔNG có close phía sau (đuôi bị cắt) — cắt từ đó tới hết đoạn. */
const UNCLOSED_TAIL_RE = new RegExp(
  `^[ \\t]*<(?:${TAG_ALIASES}|\\uFF5C\\uFF5CDSML\\uFF5C\\uFF5C[a-z_]+)\\b[^>]*>(?![\\s\\S]*?<\\/(?:${TAG_ALIASES}|\\uFF5C\\uFF5CDSML\\uFF5C\\uFF5C[a-z_]+)>)`,
  'im',
);

/** Markup vendor DeepSeek DSML (fullwidth ｜ sentinels). */
const DSML_BLOCK_RE =
  /<\uFF5C\uFF5CDSML\uFF5C\uFF5C(?:tool_calls|invoke|parameter)\b[^>]*>[\s\S]*?<\/\uFF5C\uFF5CDSML\uFF5C\uFF5C[a-z_]+>[ \t]*(?=\n|$)/gim;
const DSML_UNCLOSED_RE = /<\uFF5C\uFF5CDSML\uFF5C\uFF5C(?:tool_calls|invoke|parameter)\b[^>]*>(?![\s\S]*?<\/\uFF5C\uFF5CDSML\uFF5C\uFF5C[a-z_]+>)/i;

/** Dòng close mồ côi (opener đã bị cắt ở lượt trước) — gồm cả họ DSML. */
const ORPHAN_CLOSE_RE = new RegExp(
  `^[ \\t]*<\\/(?:${TAG_ALIASES}|\\uFF5C\\uFF5CDSML\\uFF5C\\uFF5C[a-z_]+)>[ \\t]*\\n?`,
  'gim',
);

export interface StripResult {
  /** Text đã làm sạch. */
  text: string;
  /** Số khối/tag bị loại — dùng cho log/debug, không đưa lên UI. */
  stripped: number;
}

/**
 * Strip markup tool-call ngoài code fence. Thuần string in/out — chạy được
 * cả lúc stream (mỗi frame render gọi lại trên nội dung hiện tại).
 */
export function stripEmulatedToolMarkup(input: string): StripResult {
  const raw = input ?? '';
  let stripped = 0;

  // Tách code fence ra khỏi vùng xử lý: nội dung trong fence là ví dụ minh
  // họa của NGƯỜI DÙNG/MODEL viết chủ đích — tuyệt đối không đụng.
  const parts = raw.split(/(```[\s\S]*?(?:```|$)|```$|~~~[\s\S]*?(?:~~~|$)|~~~$)/g);
  const cleaned = parts.map((part) => {
    if (!part || part.startsWith('```') || part.startsWith('~~~')) return part;
    let segment = part;

    const cutWith = (re: RegExp | null, tailRe: RegExp | null) => {
      if (re) {
        segment = segment.replace(re, () => {
          stripped += 1;
          return '';
        });
      }
      if (tailRe) {
        const m = tailRe.exec(segment);
        if (m && m.index !== undefined) {
          // Chỉ coi là đuôi tool-call khi opener đứng ở ranh giới dòng hợp lệ.
          const before = segment.slice(Math.max(0, m.index - 1), m.index);
          if (m.index === 0 || before === '\n' || before === '\r' || before === ' ') {
            segment = segment.slice(0, m.index).replace(/\s*$/, '');
            stripped += 1;
          }
        }
        tailRe.lastIndex = 0;
      }
    };

    cutWith(CLOSED_BLOCK_RE, UNCLOSED_TAIL_RE);
    cutWith(DSML_BLOCK_RE, DSML_UNCLOSED_RE);
    segment = segment.replace(ORPHAN_CLOSE_RE, '');

    return segment;
  });

  return { text: cleaned.join(''), stripped };
}
