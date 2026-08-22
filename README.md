# AI Chat Studio

Ứng dụng chat AI local-first với cây hội thoại phân nhánh (branching), chạy hoàn toàn phía client — lịch sử chat lưu trong **IndexedDB** của trình duyệt, không cần server database.

## Tính năng

- **Cây hội thoại phân nhánh**: mỗi tin nhắn là một node trong cây; chỉnh sửa tin nhắn cũ hoặc "Tạo lại" (regenerate) tạo nhánh mới, chuyển qua lại giữa các biến thể bằng nút mũi tên / phím tắt / cử chỉ swipe trên mobile.
- **Local-first**: toàn bộ dữ liệu trong IndexedDB (Dexie) — mở app là có ngay lịch sử, hoạt động tốt khi offline (trừ lúc gọi API).
- **Đồng bộ đa-tab**: các tab trên cùng trình duyệt tự cập nhật khi tab khác ghi dữ liệu (BroadcastChannel + Lamport revision, fallback localStorage).
- **Tìm kiếm full-text tiếng Việt** có fold dấu (tìm "hoa hau" ra được "Hoa Hậu"), gom nhóm theo ngày.
- **Markdown + LaTeX + code highlight**: KaTeX cho công thức, Prism (18 ngôn ngữ) cho code, ảnh/bảng/GFM.
- **Đính kèm tệp**: ảnh/PDF/text dưới 3MB tổng, lưu blob trong IndexedDB.
- **Backup/Restore**: xuất/nạp toàn bộ cây hội thoại ra `.json` (đầy đủ nhánh + tệp kèm) hoặc `.md` (nhánh đang xem).
- **BYOK**: người dùng tự dán API key riêng trong Settings (không persist), hoặc dùng key pool cấu hình trên server.
- **Failover đa key + đa model**: server tự xoay API key theo health, thử chuỗi model thay thế khi upstream 404.
- **19 model**: GPT/Claude/DeepSeek/Gemini/MiniMax qua gateway tương thích OpenAI.

## Tech stack

| Tầng | Công nghệ |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| UI | React 19, Tailwind CSS, lucide-react |
| Trạng thái | Zustand (persist localStorage) |
| Lưu trữ | Dexie (IndexedDB) — schema 5 phiên bản có migration |
| AI | AI SDK (`ai` + `@ai-sdk/openai`), stream qua Edge runtime |
| Virtualization | @tanstack/react-virtual |

## Chạy dự án

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (type-check bật)
npm run start
npm test         # unit tests (vitest)
```

## Biến môi trường (`.env.local`)

| Biến | Bắt buộc | Mô tả |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | API key chính cho gateway |
| `OPENAI_API_KEYS` | — | Nhiều key cách nhau bởi `,` `;` hoặc xuống dòng — bật failover pool |
| `OPENAI_BASE_URL` | — | Gateway tương thích OpenAI (vd `https://anticode.vn/v1`) |
| `ACCESS_CODE` | — | Yêu cầu mã truy cập (Bearer) khi gọi `/api/chat` và `/api/title` |
| `ALLOWED_ORIGIN_HOSTS` | — | Host origin phụ được chấp nhận, cách nhau `,` |
| `DIAG_SECRET` | — | Bật `/api/diag` (mặc định **khóa 403**); gọi: `curl -H "x-diag-secret: ..." /api/diag` |
| `MODEL_ALIAS_MAP` | — | JSON map tên model nội bộ → tên thật trên gateway, không cần deploy lại |
| `TITLE_MODEL_CHAIN` | — | Chuỗi model sinh tiêu đề, mặc định `gpt-4o-mini,gpt-4.1-mini,gpt-5.6-terra,deepseek-chat` |
| `CHAT_DEBUG_ERRORS` | — | `true` để kèm body lỗi upstream vào message |

## Kiến trúc

```
app/api/chat    — stream chat: same-origin + access-code + rate-limit →
                  key pool failover → model chain fallback → data stream
                  (heartbeat 10s, idle 60s, budget 270s)
app/api/title   — sinh tiêu đề, chống prompt-injection, heuristic fallback
app/api/diag    — chẩn đoán upstream (khóa mặc định, secret qua header)

lib/db.ts                   — Dexie schema + hooks (tokenize, sanitize) +
                              appendMessage (allocator nguyên tử seq/branchOrder)
lib/chat-tree-persistence.ts — reconcileActiveMessages: đồng bộ projection
                              đang xem ↔ cây trong DB (fork reservation, diff)
lib/tree-utils.ts           — dựng index cây, reconstruct thread, siblings
lib/tree-validation.ts      — kiểm tra chuỗi leaf→root (sentinel '__ROOT__')
lib/tree-repair.ts          — tự sửa activeLeafId hỏng + broadcast
lib/chat-broadcast.ts       — kênh sự kiện đa-tab (Lamport + fallback storage)
lib/api-keys.ts             — health/cooldown/quarantine key pool
lib/backup.ts               — export/import JSON & Markdown

components/chat-interface.tsx   — orchestrator (hydration, persist queue,
                                  edit/regenerate, branch switch, shortcuts)
components/chat/message-list    — virtualized list + chiến lược scroll/pin
components/chat/message-item    — hàng tin nhắn (edit, branch, attachments)
components/chat/chat-header     — tiêu đề, xuất/nhập, xoá
```

### Mô hình cây

Message gốc mang `parentId = '__ROOT__'` (IndexedDB không index được `null`). `branchOrder` là số thứ tự sibling, `branchTieBreaker` (= id) đảm bảo thứ tự ổn định. Mọi lệnh chèn message mới đi qua `db.appendMessage` — cấp `seq`/`branchOrder` nguyên tử trong transaction nên hai tab không đè nhau.

## Ghi chú triển khai (Vercel)

- Routes API chạy Edge runtime; lưu ý Next 16 đang deprecate Edge — cân nhắc chuyển `nodejs` runtime trong tương lai.
- Rate limit in-memory per-isolate: chỉ là lớp chống spam nhẹ, cần Upstash Redis nếu muốn chính xác toàn cục.
- Origin cho phép: `localhost`, `127.0.0.1`, `[::1]` + các host Vercel tự động; thêm domain riêng qua `ALLOWED_ORIGIN_HOSTS`.
