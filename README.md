# Vyen — AI Innovations

Ứng dụng chat AI local-first với cây hội thoại phân nhánh (branching), chạy hoàn toàn phía client — lịch sử chat lưu trong **IndexedDB** của trình duyệt, không cần server database. Ngoài chat, Vyen còn là **coding agent**: kết nối thư mục dự án trên máy bạn để agent đọc/tìm/sửa file, chạy shell + git (bản desktop), nối MCP server, giao việc cho subagent — mọi thay đổi đều đi qua phê duyệt của bạn.

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
- **Voice input**: bấm nút mic trong ô nhập, nói tiếng Việt — chữ hiện realtime, chạy 100% client (Web Speech API).
- **Agent coding trong trình duyệt**: bấm 📁 kết nối thư mục làm việc (File System Access API — Chrome/Edge), agent liệt kê/đọc/tìm/sửa file trực tiếp trên máy bạn; **ghi file luôn qua modal diff phê duyệt** (duyệt mới ghi đĩa). fs_* tools chạy client-side (`onToolCall` + auto-resubmit), server không bao giờ chạm vào file.
- **Tìm kiếm web**: bật nút 🌐 trong composer — lượt gửi kế tiếp tự tra cứu DuckDuckGo/SearXNG (top nguồn + đọc nguyên văn tối đa 2 trang), chèn vào ngữ cảnh kèm yêu cầu trích dẫn link. Dán URL trực tiếp trong tin nhắn sẽ được ưu tiên đọc nguyên trang. Proxy qua `/api/web` có chắn SSRF từng hop redirect.
- **Thư viện prompt "/"**: gõ `/` trong ô nhập để chèn prompt mẫu (có sẵn 5 mẫu tiếng Việt, thêm/sửa/xoá trong Settings; filter không phân biệt dấu — gõ "tom tat" ra "Tóm tắt").
- **Auto-backup**: nhắc định kỳ theo chu kỳ tuỳ chọn; desktop Chrome/Edge chọn được thư mục để app **tự ghi file .json ngầm** khi đến kỳ (File System Access API).
- **PWA cài lên thiết bị**: Android/Chrome bấm "Cài đặt ứng dụng" hoặc nút trong Settings; iOS Safari → Chia sẻ → Thêm vào Màn hình chính. Có trang offline khi mất mạng.
- **32 model chat** (GPT/Claude/DeepSeek/Gemini/MiniMax/Grok/Qwen/Kimi) qua gateway tương thích OpenAI, kèm 5 model sinh ảnh/video riêng.

## Agent coding

Vyen đọc tự do nhưng ghi có kỷ luật: mọi thao tác ghi file / chạy lệnh / commit đều hiện diff hoặc lệnh cụ thể để bạn phê duyệt trước khi chạm đĩa.

### Workspace & công cụ file

- **Kết nối workspace**: bấm 📁 trên trình duyệt (File System Access API — Chrome/Edge) hoặc mở thư mục trong bản desktop/CLI. Agent dùng bộ tool `fs_list` / `fs_read` / `fs_search` / `fs_edit` / `fs_write` chạy ngay trên máy bạn — server không bao giờ chạm vào file.
- **Đọc thông minh**: `fs_read` trả tối đa 24.000 ký tự, đọc tiếp bằng `start_line`/`line_count`; `fs_search` tìm chuỗi/regex toàn workspace (bỏ qua node_modules/.git/dist/.next...) trả tối đa 30 dòng kèm `file:dòng`. Ảnh trong workspace (.png/.jpg/.webp/.heic/.heif) được mô tả bằng model vision của Nhà cung cấp đang bật (qua `/api/vision` — BYOK như mọi route LLM, chọn model trong Cài đặt → Nhà cung cấp) — agent "nhìn thấy" screenshot/diagram thay vì nhận bytes rác.
- **Sửa có kỷ luật**: `fs_edit` dùng khối SEARCH/REPLACE phải khớp nguyên văn và duy nhất, **bắt buộc đọc file trước khi sửa** (tool từ chối nếu chưa đọc); `fs_write` bị chặn ghi đè cả file >200 dòng — buộc sửa cục bộ. Mọi ghi file luôn qua **modal diff phê duyệt**.

### Duyệt & tự động hóa

- **Auto-pilot** (nút trong ô nhập, bấm để xoay chính sách): `always` luôn hỏi; `smart` tự duyệt thao tác chỉ-đọc và lệnh an toàn (npm test/lint, git status...); `never` tự duyệt gần như mọi thứ. Lệnh destructive (`rm -rf /`, `mkfs`, `shutdown`...) **luôn bị chặn tự duyệt** — bắt hiện xác nhận kể cả ở chế độ tự động nhất. Có thể ghi đè riêng từng nhóm tool (fs/shell/git/...) thành auto/ask/deny.
- **Staging sandbox** (kiểu Plandex): `fs_edit`/`fs_write` ghi vào bộ đệm thay vì đĩa — agent vẫn tự thấy kết quả sửa của mình (`fs_read` đọc overlay trước), bạn review cả batch (diff từng file, thống kê ± dòng) rồi **Apply tất cả** (tạo checkpoint rồi mới ghi đĩa) hoặc reject từng file. Chưa Apply thì đĩa chưa bao giờ bị đụng.
- **Goal loop**: đặt mục tiêu (vd "sửa cho test pass"), agent tự chạy tiếp từng lượt cho tới khi phát marker hoàn thành `<goal-complete>` — mặc định 5 lượt, tối đa 10, tự dừng sớm khi nhận ra không tiến triển (3 câu trả lời y hệt nhau).

### Shell & Git (bản desktop)

- **`shell_run`**: chạy lệnh trong workspace (cmd.exe/sh) sau khi bạn duyệt, timeout mặc định 120s (tối đa 600s). Output vượt 2000 dòng hoặc 50KB bị cắt giữ phần cuối (chứa lỗi), bản full lưu vào temp file kèm `savedTo` — agent đọc lại được bằng chính `fs_read` (ngoại lệ duy nhất ngoài workspace, chỉ file do app ghi trong phiên hiện tại; kiểu Goose).
- **Auto-debug**: lệnh test/build/lint thất bại trả kèm `retryGuidance` hướng dẫn agent sửa rồi chạy lại — tối đa 3 lần thử, dừng khi không tiến triển; lệnh destructive không bao giờ tự retry.
- **Bộ tool git**: `git_status` / `git_diff` / `git_log` đọc tự do, `git_add` xem như an toàn (không cần duyệt riêng), `git_commit` phải duyệt message trước khi tạo commit.

### Tự chủ & bảo mật key (bản desktop)

- **Không cần key của server**: mọi route LLM (chat, tiêu đề, nén ngữ cảnh, orchestrator, vision) chạy hoàn toàn với Nhà cung cấp của bạn (BYOK) — sau khi cấu hình provider trong Cài đặt, bản desktop không phụ thuộc biến môi trường nào. Key pool/chain của server chỉ còn vai trò cho chế độ demo web.
- **LLM fetch qua Web/bridge**: bản desktop (launcher Edge/Chrome `--app`) gọi gateway trực tiếp từ Web (không gắn header Origin lạ) nên các gateway chặn origin của trình duyệt thường không còn là rào cản (đang dùng cho tạo ảnh; response buffer, trần 10MB/300s, header qua allowlist).
- **Kho key mã hoá opt-in**: bật "Lưu API key mã hoá" trong Cài đặt → Nhà cung cấp để key nằm trong Credential Manager của hệ điều hành (safeStorage — DPAPI/Keychain/libsecret); IndexedDB chỉ giữ con trỏ `@secure:`, key thật không bao giờ ghi plaintext. Vault lỗi/thiếu → từ chối lưu mã hoá rõ ràng, không lặng lẽ hạ cấp.

### MCP

- Trong bản desktop, thêm MCP server (stdio/SSE/streamable-http) tại Settings; tool của server hiện diện trong model dạng `mcp__<server>__<tool>` (trần 100 tool mỗi request). Mỗi lần gọi đi qua hộp thoại phê duyệt **4 cấp**: Cho phép lần này / Luôn cho phép (nhớ cho phiên làm việc) / Từ chối lần này / Luôn từ chối. Ảnh do MCP trả về cũng được mô tả qua pipeline vision (tối đa 4 ảnh mỗi kết quả).

### Làm việc quy mô lớn

- **Subagent delegate**: agent chính giao task độc lập cho subagent chạy với context riêng (không thấy lịch sử chat), không thể đệ quy (subagent không có `delegate`), giới hạn mặc định 10 turns (tối đa 25). Subagent vẫn dùng được tool trên máy bạn (fs/shell/git/MCP) nhờ relay: server phát annotation xuống renderer, renderer thực thi rồi POST kết quả về `/api/chat/subagent-relay`. Hoạt động cả đường native function-calling lẫn emulated.
- **Orchestrator sweep**: mở panel orchestrator, nhập mục tiêu — hệ thống tự phân rã thành lưới N cấu hình chạy song song (bấm Dừng là thật sự ngưng tiêu token), chấm điểm xếp hạng từng bản, vẽ heatmap theo trục và tổng hợp một đáp án cuối. Bấm **"Thêm vào hội thoại"** để ghi đáp án vào hội thoại như một message assistant (có gắn nhãn nguồn orchestrator).
- **Plan & checklist**: task lớn được phân rã bằng `plan_create`/`plan_update`; UI hiện checklist tiến độ (Chờ/Đang làm/Xong/Lỗi/Bỏ qua) kèm progress bar. **Plan Mode** khoá agent ở chế độ khảo sát — chỉ đọc/liệt kê/tìm và hỏi làm rõ, tool ghi bị vô hiệu cho tới khi bạn chuyển sang Act.
- **Self-improvement lessons**: agent tự lưu bài học sau khi sửa bug khó / phát hiện pattern hay bằng `lesson_save` (3 loại: rule / pattern / gotcha, tối đa 400 ký tự); các bài học được inject vào system prompt của các phiên sau.

### Kiểm soát ngữ cảnh & model

- **Compaction**: hội thoại dài tự nén qua `/api/compact` — phần cũ thay bằng summary, dữ kiện quan trọng (file đã chạm, yêu cầu đã nêu) sống sót qua nhiều lần nén.
- **Thanh trượt suy luận**: 4 mức low/medium/high/max; mức nào khả dụng đọc từ metadata `/v1/models` (chuẩn OpenRouter) nên model không hỗ trợ không nhận tham số rác.
- **Ngân sách tool**: tối đa 32 lần gọi tool mỗi lượt (đếm theo hội thoại, không reset khi client resubmit), tự chặn gọi trùng tham số và phát hiện doom-loop để bảo model đổi hướng; kết quả tool bị cắt ở 24.000 ký tự.
- **Sinh ảnh/video**: nút trong ô nhập gọi thẳng gateway để tạo ảnh hoặc video ngay trong khung chat, tự fallback qua server khi gateway chặn CORS. Trên bản desktop (launcher Edge/Chrome), tạo ảnh gọi gateway trực tiếp từ Web nên gateway chặn origin kiểu crax vẫn gọi được.
- **Emulated tool-calling**: model không hỗ trợ function calling vẫn dùng được toàn bộ tool — schema render thành text trong system prompt, model trả khối `<tool_call>` JSON, server parse + thực thi + vòng lặp (trần 10 vòng, 5 call/vòng, chống model tự bịa kết quả tool).

## Tech stack

| Tầng | Công nghệ |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| UI | React 19, Tailwind CSS, lucide-react |
| Trạng thái | Zustand (persist localStorage) |
| Lưu trữ | Dexie (IndexedDB) — schema 5 phiên bản có migration |
| AI | AI SDK (`ai` + `@ai-sdk/openai`), stream qua API routes Node.js |
| Virtualization | @tanstack/react-virtual |
| Desktop | Launcher Edge/Chrome `--app` vào Next.js local (cửa sổ riêng, ~35MB RAM) |
| MCP | `@modelcontextprotocol/sdk` (client chạy trong bridge Node.js của desktop/CLI, phê duyệt 4 cấp) |

## Chạy dự án

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (type-check bật)
npm run start
npm test         # unit tests (vitest)
npm run lint     # eslint

# Bản desktop (launcher Edge/Chrome --app nhẹ — không Electron/Tauri)
npm run app        # mặc định: mở cửa sổ app Edge/Chrome --app vào Next.js local
npm run desktop    # alias của app
npm run cli        # CLI: npx tsx bin/vyen.ts cli
# Desktop tự chủ: chỉ cần cấu hình Nhà cung cấp trong app — không cần .env.local
```

## Biến môi trường (`.env.local`)

| Biến | Bắt buộc | Mô tả |
|---|---|---|
| `OPENAI_API_KEY` | — | API key cho gateway ở CHẾ ĐỘ DEMO web (người dùng có provider riêng thì không cần) |
| `OPENAI_API_KEYS` | — | Nhiều key cách nhau bởi `,` `;` hoặc xuống dòng — bật failover pool |
| `OPENAI_BASE_URL` | — | Gateway tương thích OpenAI (vd `https://anticode.vn/v1`) |
| `ACCESS_CODE` | — | Yêu cầu mã truy cập (Bearer) khi gọi `/api/chat` và `/api/title` |
| `ALLOWED_ORIGIN_HOSTS` | — | Host origin phụ được chấp nhận, cách nhau `,` |
| `DIAG_SECRET` | — | Bật `/api/diag` (mặc định **khóa 403**); gọi: `curl -H "x-diag-secret: ..." /api/diag` |
| `MODEL_ALIAS_MAP` | — | JSON map tên model nội bộ → tên thật trên gateway, không cần deploy lại |
| `TITLE_MODEL_CHAIN` | — | Chuỗi model dự phòng sinh tiêu đề khi không có provider active, mặc định `gpt-5-4-nano,gpt-4o-mini,gpt-5-6-terra,deepseek-v4-flash`; có provider active thì model người dùng đang chọn được ưu tiên trước (tương tự `COMPACT_MODEL_CHAIN`, `ORCHESTRATE_MODEL_CHAIN`) |
| `CHAT_DEBUG_ERRORS` | — | `true` để kèm body lỗi upstream vào message |

## Kiến trúc

```
app/api/chat    — TRUNG TÂM điều phối: same-origin + access-code + rate-limit →
                  key pool failover → model chain fallback → data stream
                  (heartbeat 10s, idle 90s, budget 270s). Ghép server tools
                  (web/weather/memory), khai báo client tools (fs_*/shell/git/
                  plan/lesson/delegate) cho model gọi, chạy delegate + subagent
                  relay phía server, và loop emulated tool-calling khi model
                  không hỗ trợ function calling
app/api/chat/subagent-relay — POST kết quả tool client mà renderer thực thi
                  hộ subagent đang chạy server-side
app/api/orchestrate — SSE orchestrator sweep: plan → spawn N agent song song →
                  ranking + heatmap → synthesize
app/api/vision   — mô tả ảnh workspace / ảnh MCP thành text bằng model
                  vision của provider active (BYOK — client gửi headers
                  provider + model vision đã chọn)
app/api/compact  — nén hội thoại dài thành summary có state tích lũy
app/api/title    — sinh tiêu đề, chống prompt-injection, heuristic fallback
app/api/web      — proxy tra cứu web: DuckDuckGo lite→html + đọc trang
                  (SSRF guard từng hop redirect, trần 1.5MB/12s mỗi trang)
app/api/diag     — chẩn đoán upstream (khóa mặc định, secret qua header)

app/api/bridge   — cầu nối desktop: endpoint local-only + token, chuyển tiếp
                  fs/shell/git/MCP xuống Node bridge server của launcher
scripts/launch-desktop.cjs — launcher mặc định: mở cửa sổ Edge/Chrome --app
                  vào Next.js local (tự start dev server nếu chưa chạy)
bin/vyen.ts       — CLI Vyen (`npm run cli` / `npm run vyen`)

lib/             — logic agent thuần, test được trong node:
                  agent-tools (server + client tool defs), emulated-agent,
                  subagent + subagent-relay, orchestrator/ (engine, grid,
                  metrics, scheduler), auto-pilot (phê duyệt), staging,
                  goal-loop, debug-loop, lessons, plan (subtask-plan),
                  mcp/ (tool-mapper, bridge, image-content), fs-vision,
                  context-compaction, reasoning-capability

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
                                  + thực thi client tools (onToolCall),
                                  auto-pilot, goal loop, staging
components/chat/message-list    — virtualized list + chiến lược scroll/pin
components/chat/message-item    — hàng tin nhắn (edit, branch, attachments)
components/chat/chat-header     — tiêu đề, xuất/nhập, xoá
components/{diff-confirm,shell-confirm,plan-panel,staging-panel,
             subagent-card,workspace-checkpoints} — UI phê duyệt + tiến độ agent
components/orchestrator/        — panel sweep: thẻ từng cell + heatmap
components/mcp/                 — settings MCP + hộp thoại phê duyệt 4 cấp
```

### Mô hình cây

Message gốc mang `parentId = '__ROOT__'` (IndexedDB không index được `null`). `branchOrder` là số thứ tự sibling, `branchTieBreaker` (= id) đảm bảo thứ tự ổn định. Mọi lệnh chèn message mới đi qua `db.appendMessage` — cấp `seq`/`branchOrder` nguyên tử trong transaction nên hai tab không đè nhau.

## Ghi chú triển khai

- Routes API khai báo tường minh `export const runtime = 'nodejs'` — đã rời Edge trước khi Next 16 deprecate.
- Rate limit in-memory per-isolate: chỉ là lớp chống spam nhẹ, cần Upstash Redis nếu muốn chính xác toàn cục.
- Origin cho phép: `localhost`, `127.0.0.1`, `[::1]`; thêm domain riêng qua `ALLOWED_ORIGIN_HOSTS`.
