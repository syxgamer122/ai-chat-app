/**
 * NGUỒN SỰ THẬT DUY NHẤT cho mọi trần liên quan tới vòng đời tool.
 *
 * Trước đây các trần này nằm rải rác và không dẫn xuất từ nhau:
 *   - route.ts        maxSteps: 8        (server, native)
 *   - chat-interface  maxSteps: 48       (client, resubmit fs_*)
 *   - agent-tools     MAX_TOOL_CALLS_PER_TURN: 32
 *   - emulated-agent  10 rounds × 3 calls, result 6.000 ký tự
 *   - context-budget  TOOL_RESULT_ESTIMATE_CHARS: 24.000
 *   - fs-access       MAX_READ_CHARS: 24.000
 *
 * Hệ quả: đường native để lọt tool result 24k vào context còn đường emulated
 * cắt còn 6k (lệch 4 lần cho cùng một tác vụ), và ước lượng ngân sách dùng
 * một con số thứ ba. File này buộc chúng dẫn xuất từ một gốc chung.
 */

/* ------------------------------------------------------------------ */
/* Kích thước kết quả                                                  */
/* ------------------------------------------------------------------ */

/**
 * Trần ký tự (JSON đã serialize) cho MỘT kết quả tool khi đưa vào ngữ cảnh
 * model. Áp cho CẢ hai đường native và emulated — trước đây chỉ emulated có.
 * Bằng đúng MAX_READ_CHARS của fs_read để một lần đọc file đầy trần không bị
 * cắt thêm lần nữa.
 */
export const TOOL_RESULT_MAX_CHARS = 24_000;

/**
 * Tỷ lệ giữ phần ĐẦU khi middle-truncate. Đầu thường là metadata/khai báo,
 * đuôi thường chứa kết luận — giữ cả hai, bỏ ruột.
 */
export const TOOL_RESULT_HEAD_RATIO = 0.7;
export const TOOL_RESULT_TAIL_RATIO = 0.25;

/**
 * Middle-truncate một kết quả tool đã serialize. Dùng chung cho native lẫn
 * emulated để hai đường nhận CÙNG lượng thông tin.
 */
export function truncateToolResult(
  serialized: string,
  maxChars: number = TOOL_RESULT_MAX_CHARS,
): string {
  if (serialized.length <= maxChars) return serialized;
  const head = serialized.slice(0, Math.floor(maxChars * TOOL_RESULT_HEAD_RATIO));
  const tail = serialized.slice(-Math.floor(maxChars * TOOL_RESULT_TAIL_RATIO));
  return `${head}\n...[đã cắt bớt ${serialized.length - head.length - tail.length} ký tự ở giữa]...\n${tail}`;
}

/** Serialize + cắt trần trong một bước. Không bao giờ ném. */
export function serializeToolResult(
  result: unknown,
  maxChars: number = TOOL_RESULT_MAX_CHARS,
): string {
  let raw: string;
  try {
    raw = JSON.stringify(result) ?? 'null';
  } catch {
    raw = '"[kết quả không serialize được]"';
  }
  return truncateToolResult(raw, maxChars);
}

/* ------------------------------------------------------------------ */
/* Số lần gọi                                                          */
/* ------------------------------------------------------------------ */

/**
 * Trần số lần gọi tool SERVER trong một lượt chat (tính xuyên các resubmit
 * của client tool — xem tool-call-budget.ts). Tác vụ agent thật (tìm web +
 * đọc file + sửa + xác nhận) dễ vượt 8 call; dedupe call-trùng và note hướng
 * dẫn tổng hợp vẫn giữ nguyên nên tăng trần không mở đường vòng lặp vô hạn.
 */
export const MAX_TOOL_CALLS_PER_TURN = 32;

/**
 * Số step tối đa của một request /api/chat phía server (native function
 * calling). Mỗi step = một vòng model↔tool.
 */
export const SERVER_MAX_STEPS = 8;

/**
 * Số lần useChat tự resubmit sau khi client thực thi fs_*. Phải LỚN HƠN
 * SERVER_MAX_STEPS vì mỗi resubmit là một request server mới; đây là trần
 * của cả phiên agent coding phía trình duyệt. Mỗi call fs_* hoặc shell tốn 1
 * step — task nặng (refactor 10+ file: đọc, sửa, chạy shell, đọc lại xác
 * nhận) cần 30-50 call nên trần 48. Vẫn có dedupe call-trùng + budget server
 * chặn vòng lặp nên tăng trần không mở đường vòng lặp vô hạn.
 */
export const CLIENT_MAX_STEPS = 48;

/** Đường emulated: số vòng model↔tool. Round cuối bị ép trả prose. */
export const EMU_MAX_ROUNDS = 10;
/** Đường emulated: số tool call tối đa parse được trong MỘT phản hồi. */
export const EMU_MAX_CALLS_PER_ROUND = 5;

/**
 * Ngưỡng doom-loop: cùng một (tool, args) xuất hiện bao nhiêu lần LIÊN TIẾP
 * thì trả steering message thay vì kết quả tool. evot dùng 3 — ngưỡng này đủ
 * để bắt vòng lặp thật (model không nhận được gì mới sau 2 lần gọi) mà không
 * cản trở tác vụ lặp hợp lý (user có thể muốn đọc lại file sau khi sửa).
 */
export const DOOM_LOOP_THRESHOLD = 3;

/* ------------------------------------------------------------------ */
/* Ước lượng ngân sách                                                 */
/* ------------------------------------------------------------------ */

/**
 * Trần ký tự khi ƯỚC LƯỢNG token của một tool result. Bằng trần thật để
 * ContextMeter không báo thấp hơn lượng thực sự gửi đi.
 */
export const TOOL_RESULT_ESTIMATE_CHARS = TOOL_RESULT_MAX_CHARS;
