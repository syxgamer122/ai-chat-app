/**
 * Ép `stream: false` cho các lượt gọi KHÔNG streaming (generateText).
 *
 * VÌ SAO CẦN — lỗi thật đã đo được:
 * Chuẩn OpenAI quy định thiếu trường `stream` thì mặc định là `false`. Gateway
 * crax làm NGƯỢC LẠI: không có `stream` thì nó trả về SSE
 * (`data: {...chunk}`), trong khi `stream: false` tường minh mới trả JSON.
 *
 * AI SDK `generateText` không gửi `stream` (vì mặc định đã là false theo
 * chuẩn), nên nhận về SSE và ném `Invalid JSON response`. Hậu quả: /api/compact
 * luôn trả `all_models_failed`, tức tính năng NÉN NGỮ CẢNH hỏng hoàn toàn —
 * hội thoại dài sẽ tràn context thay vì được nén.
 *
 * Kiểm chứng bằng request thật tới gpt.crax.lol:
 *   không có `stream`     -> body bắt đầu bằng "data: {"   (SSE)
 *   `"stream": false`     -> body bắt đầu bằng "{"          (JSON)
 *
 * Chỉ dùng cho đường generateText. Đường streamText KHÔNG được dùng hàm này.
 */

/**
 * Bọc MỘT `fetch` bất kỳ để thêm `stream: false` vào body JSON của request POST.
 * Body không phải JSON hợp lệ thì để nguyên — không được làm hỏng request lạ.
 *
 * Là factory (không cứng global fetch) vì caller đôi khi phải chèn fetch riêng
 * của mình vào trước: vision-bridge ghép `req.signal` của route để user bấm
 * Stop thì lượt gọi provider dừng theo, test thì nhét mock để hermetic. Trước
 * đây vision-bridge tự copy lại nguyên khối logic này — hai bản dễ lệch nhau
 * khi quirk gateway đổi.
 */
export function createNonStreamingFetch(underlying: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (!init?.body || typeof init.body !== 'string') {
      return underlying(input, init);
    }
    let patched = init.body;
    try {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsed.stream = false;
        patched = JSON.stringify(parsed);
      }
    } catch {
      // Body không phải JSON — gửi nguyên trạng.
      return underlying(input, init);
    }
    return underlying(input, { ...init, body: patched });
  };
}

/**
 * Bản dùng global fetch — call site cũ (title/compact/orchestrate/chat) giữ
 * nguyên. Bọc bằng lambda thay vì truyền `fetch` trực tiếp: một số runtime
 * (undici) ném `Illegal invocation` khi global fetch bị tách khỏi ngữ cảnh.
 */
export const nonStreamingFetch: typeof fetch = createNonStreamingFetch((input, init) =>
  fetch(input, init),
);
