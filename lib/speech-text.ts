/**
 * Chuyển markdown của tin nhắn assistant thành văn bản "nói được" cho TTS
 * (Web Speech Synthesis). Mục tiêu: giọng đọc nghe như người nói, không đọc
 * ký tự rác — code block, công thức toán, URL, ký hiệu markdown đều loại bỏ.
 *
 * Hàm thuần, không đụng DOM/window — test được ở môi trường node.
 */

/** Trần ký tự đưa vào speechSynthesis (Chrome bắt đầu trục trặc với chuỗi rất dài). */
export const SPEECH_TEXT_MAX_CHARS = 30_000;

export function stripMarkdownForSpeech(raw: string): string {
  if (!raw) return '';
  let t = raw;

  // 1. Fenced code block — đọc code thành lời là vô nghĩa, bỏ toàn bộ.
  //    Cho phép thiếu fence đóng (tin nhắn đang stream bị cắt giữa chừng).
  t = t.replace(/```[\s\S]*?(?:```|$)/g, ' ');

  // 2. Công thức toán: display math + \( \) \[ \] bỏ hẳn; $inline$ giữ nội dung
  //    đơn giản nếu không chứa cấu trúc LaTeX phức tạp (backslash, ^, _).
  t = t.replace(/\$\$[\s\S]*?\$\$/g, ' ');
  t = t.replace(/\\\[[\s\S]*?\\\]/g, ' ');
  t = t.replace(/\\\([\s\S]*?\\\)/g, ' ');

  // 3. Ảnh bỏ; link giữ chữ, vứt URL.
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = t.replace(/\[([^\]]*)\]\([^)\s]*[^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');

  // 4. Tag HTML còn sót (paste web, <br>...).
  t = t.replace(/<[^>]+>/g, ' ');

  // 5. Ký hiệu cấu trúc markdown.
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');          // heading
  t = t.replace(/^[ \t]{0,3}>[ \t]?/gm, '');               // blockquote
  t = t.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, ' '); // horizontal rule
  t = t.replace(/(\*\*|__)([\s\S]*?)\1/g, '$2');           // bold
  t = t.replace(/(\*|_)([^*_\n]+?)\1/g, '$2');             // italic (chỉ trong 1 dòng)
  t = t.replace(/~~([^~]+)~~/g, '$1');                     // strikethrough
  t = t.replace(/`([^`\n]+)`/g, '$1');                     // inline code → giữ nội dung

  // 6. Danh sách: bullet/task marker thành khoảng trắng; số thứ tự giữ lại.
  t = t.replace(/^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/gm, '');

  // 7. Bảng: bỏ hàng phân cách |---|---|, các cột nối bằng dấu phẩy để đọc
  //    thành "A, B, C" thay vì đọc ký tự pipe.
  t = t.replace(/^[ \t]*\|?[ \t]*:?-{2,}.*$/gm, '');
  t = t.replace(/\|/g, ', ');

  // 8. Dọn URL trần (không bọc trong link markdown): đọc "https dot slash..."
  //    là nhiễu — cắt luôn.
  t = t.replace(/\bhttps?:\/\/\S+/gi, ' ');

  // 9. Gọn whitespace: xuống dòng thành space (speechSynthesis ngắt câu theo
  //    dấu câu chứ không theo newline), gộp space liền kề.
  t = t.replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();

  if (t.length > SPEECH_TEXT_MAX_CHARS) {
    // Cắt tại khoảng trắng gần nhất để không đứt giữa từ.
    const cut = t.lastIndexOf(' ', SPEECH_TEXT_MAX_CHARS);
    t = t.slice(0, cut > 0 ? cut : SPEECH_TEXT_MAX_CHARS).trimEnd();
  }
  return t;
}

/**
 * Chia text thành mảng đoạn ≤ maxChars, đứt tại ranh giới câu/dấu phẩy/space.
 * Vì sao: Chrome có bug ngắt phát âm sau ~15 giây với utterance dài; queue
 * nhiều utterance ngắn vừa né bug vừa cho phép hiển thị tiến trình sau này.
 */
export function chunkSpeechText(text: string, maxChars = 180): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > maxChars) {
    let cut = -1;
    for (const re of [
      /[.!?…](\s|$)/g, // cuối câu — ưu tiên
      /[,;:](\s|$)/g, // mệnh đề
    ]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let best = -1;
      while ((m = re.exec(rest)) !== null) {
        if (m.index >= maxChars) break;
        best = m.index + m[0].length;
      }
      if (best > 0) {
        cut = best;
        break;
      }
    }
    if (cut <= 0) {
      cut = rest.lastIndexOf(' ', maxChars);
      if (cut <= 0) cut = maxChars;
    }
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
