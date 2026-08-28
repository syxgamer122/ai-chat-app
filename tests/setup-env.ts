/**
 * Dọn biến môi trường trước MỖI file test.
 *
 * Vấn đề: `lib/web-backend.ts` chọn engine tìm kiếm theo env hiện diện —
 * có TINYFISH_API_KEY thì TinyFish chạy trước DuckDuckGo. Máy dev thường
 * có sẵn key thật trong env của Windows hoặc `.env.local`, nên test chạy
 * xanh trên CI (không key) và đỏ trên máy local (có key). Test như vậy vô
 * giá trị.
 *
 * File này chạy trước mỗi test file (`setupFiles` trong vitest.config.ts)
 * nên cũng chặn được rò rỉ chéo: `tinyfish-engine.test.ts` gán
 * `TINYFISH_API_KEY` trong beforeEach của nó, và vitest mặc định dùng pool
 * threads — process.env được chia sẻ giữa các file chạy trong cùng worker.
 * Dọn ở đây thì file chạy sau luôn bắt đầu từ trạng thái sạch.
 *
 * Test nào CẦN key thì tự gán trong chính file đó (xem tinyfish-engine.test.ts).
 */

const SEARCH_BACKEND_ENV_VARS = [
  'TINYFISH_API_KEY',
  'SEARXNG_URL',
  'BRAVE_SEARCH_KEY',
  'TAVILY_API_KEY',
] as const;

for (const name of SEARCH_BACKEND_ENV_VARS) {
  delete process.env[name];
}
