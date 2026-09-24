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
- **Menu lệnh "/"**: gõ `/` trong ô nhập để chèn lệnh hệ thống (`/plan`, `/mode`, `/summarize`, `/recipe`, `/skills`, `/memory`, `/tools`, `/cost`) hoặc **recipe** (icon chef-hat) — chọn recipe sẽ mở panel Recipes thay vì chèn text. Lọc không phân biệt dấu. Quản lý lệnh tuỳ biến trong Settings → Mở rộng.
  > Thư viện prompt mẫu của bản web chat cũ (5 mẫu "Dịch Trung - Việt", "Sửa lỗi chính tả"... cùng mục "Skills cũ" trong Cài đặt) **đã được gỡ** ở schema v18 — đó là rác của một trợ lý chat đa dụng, không thuộc coding agent.
- **Recipes**: workflow đóng gói tái sử dụng — tham số, tool policy, model settings, kiểm chứng shell + retry, structured output JSON, sub-recipe. Lưu trong Dexie hoặc file `.vyen/recipes/*.yaml` trong workspace; chia sẻ qua liên kết `?recipe=` (chỉ mở preview, không tự chạy). Chạy headless: `npx tsx bin/vyen.ts run --recipe fix-tests.yaml --params path=src --output json` — exit code ≠ 0 khi checks còn fail (dùng CI được).
- **Skills (SKILL.md)**: kỹ năng dạng file trong `.vyen/skills/` của workspace và `~/.vyen/skills/` (desktop). Agent chỉ thấy bảng chỉ mục (tên + mô tả); nội dung nạp khi agent gọi `skill_load` — tiết kiệm token. Quản lý + tạo mới trong Settings → Skills.
- **`.vyenhints`**: ngữ cảnh dự án nạp tự động vào system prompt (fallback `AGENTS.md`, trần 8.000 ký tự), chip "hints loaded" trên UI bấm xem nguyên văn.
- **Bộ nhớ có cấu trúc**: `remember_memory` / `retrieve_memories` / `remove_memory_category` / `remove_specific_memory` — fact dài hạn theo category + tags + scope local/global (tối đa 2.000 ký tự/entry). Chỉ inject chỉ mục vào prompt (trần 4.000 ký tự); mirror ra `.vyen/memory/<category>.md` + `~/.vyen/memory/` để đọc/sửa tay; quản lý trong Settings → Ghi nhớ.
- **Lead/Worker routing**: model mạnh chạy vài lượt đầu (lập kế hoạch) rồi model rẻ thực thi; tool lỗi liên tiếp / build-test fail / bạn phàn nàn ("sai rồi", "làm lại"…) thì tự quay lại model mạnh `fallbackTurns` lượt. Lỗi 429/5xx của gateway và việc bạn TỪ CHỐI phê duyệt không tính là thất bại. Vai trò từng lượt hiện badge `lead`/`worker` dưới câu trả lời; cấu hình trong Settings → Routing. Lệnh `/plan <mục tiêu>` lập kế hoạch bằng planner model ở chế độ chỉ-đọc, duyệt xong bấm "Duyệt & thực hiện" để chuyển sang Act.
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
- **Staging sandbox** : `fs_edit`/`fs_write` ghi vào bộ đệm thay vì đĩa — agent vẫn tự thấy kết quả sửa của mình (`fs_read` đọc overlay trước), bạn review cả batch (diff từng file, thống kê ± dòng) rồi **Apply tất cả** (tạo checkpoint rồi mới ghi đĩa) hoặc reject từng file. Chưa Apply thì đĩa chưa bao giờ bị đụng.
- **Goal loop**: đặt mục tiêu (vd "sửa cho test pass"), agent tự chạy tiếp từng lượt cho tới khi phát marker hoàn thành `<goal-complete>` — mặc định 5 lượt, tối đa 10, tự dừng sớm khi nhận ra không tiến triển (3 câu trả lời y hệt nhau).

### Shell & Git (bản desktop)

- **`shell_run`**: chạy lệnh trong workspace (cmd.exe/sh) sau khi bạn duyệt, timeout mặc định 120s (tối đa 600s). Output vượt 2000 dòng hoặc 50KB bị cắt giữ phần cuối (chứa lỗi), bản full lưu vào temp file kèm `savedTo` — agent đọc lại được bằng chính `fs_read` (ngoại lệ duy nhất ngoài workspace, chỉ file do app ghi trong phiên hiện tại).
- **Auto-debug**: lệnh test/build/lint thất bại trả kèm `retryGuidance` hướng dẫn agent sửa rồi chạy lại — tối đa 3 lần thử, dừng khi không tiến triển; lệnh destructive không bao giờ tự retry.
- **Bộ tool git**: `git_status` / `git_diff` / `git_log` đọc tự do, `git_add` xem như an toàn (không cần duyệt riêng), `git_commit` phải duyệt message trước khi tạo commit.

### Tự chủ & bảo mật key (bản desktop)

- **Không cần key của server**: mọi route LLM (chat, tiêu đề, nén ngữ cảnh, orchestrator, vision) chạy hoàn toàn với Nhà cung cấp của bạn (BYOK) — sau khi cấu hình provider trong Cài đặt, bản desktop không phụ thuộc biến môi trường nào. Key pool/chain của server chỉ còn vai trò cho chế độ demo web.
- **LLM fetch qua Web/bridge**: bản desktop (launcher Edge/Chrome `--app`) gọi gateway trực tiếp từ Web (không gắn header Origin lạ) nên các gateway chặn origin của trình duyệt thường không còn là rào cản (đang dùng cho tạo ảnh; response buffer, trần 10MB/300s, header qua allowlist).
- **Kho key mã hoá opt-in**: bật "Lưu API key mã hoá" trong Cài đặt → Nhà cung cấp để key nằm trong Credential Manager của hệ điều hành (safeStorage — DPAPI/Keychain/libsecret); IndexedDB chỉ giữ con trỏ `@secure:`, key thật không bao giờ ghi plaintext. Vault lỗi/thiếu → từ chối lưu mã hoá rõ ràng, không lặng lẽ hạ cấp.

### MCP & Tool Router

- Trong bản desktop, thêm MCP server (stdio/SSE/streamable-http) tại Settings; tool của server hiện diện trong model dạng `mcp__<server>__<tool>`. Mỗi lần gọi đi qua hộp thoại phê duyệt **4 cấp**: Cho phép lần này / Luôn cho phép (nhớ cho phiên làm việc) / Từ chối lần này / Luôn từ chối. Hỗ trợ **whitelist `available_tools`** cho từng server để giảm bớt token ngữ cảnh và khoanh vùng công cụ cho phép. Ảnh do MCP trả về cũng được mô tả qua pipeline vision (tối đa 4 ảnh mỗi kết quả).
- **Tool Router**: Giải quyết triệt để vấn đề trần cứng 100 tool khi kết nối nhiều server MCP (~200+ tools):
  - Lập chỉ mục `name + description + parameters` của toàn bộ công cụ (cả native và MCP).
  - Thuật toán xếp hạng cục bộ **BM25** (tách từ identifier camelCase/snake_case + fold dấu tiếng Việt) tự động chọn **top-30** công cụ liên quan nhất tới câu hỏi của người dùng vào ngữ cảnh.
  - Cung cấp 2 meta-tools:
    - `tools_search(query, limit)`: Tìm kiếm công cụ trong danh mục đầy đủ.
    - `tools_load(names)`: Nạp động các công cụ được chỉ định vào bộ công cụ hoạt động của phiên làm việc.
- **Code Mode (Thực thi JS gọi MCP on-demand)**:
  - Cung cấp công cụ `run_code(code)` cho phép LLM viết mã JavaScript thực thi trực tiếp trong môi trường sandbox Node.js của bridge.
  - Tự động inject `mcp.call(serverId, toolName, args)` để model điều phối kịch bản gọi nhiều tool MCP và xử lý dữ liệu phức tạp mà không cần nhiều lượt LLM round-trip.
  - Output cắt ngắn tối đa 24.000 ký tự (quy chuẩn Vyen), tuân thủ kiểm duyệt an toàn, tắt mặc định (bật trong Cài đặt → Công cụ).

### Phân quyền công cụ & 4 chế độ chuẩn

- **4 chế độ hoạt động**:
  - `Manual` (`always`): Luôn hỏi trước khi chạy bất kỳ tool nào (an toàn tối đa).
  - `Smart` (`smart`): Tự động duyệt các tool chỉ đọc và lệnh shell an toàn (`npm test`, `git status`...), yêu cầu xác nhận khi ghi/sửa hoặc chạy lệnh destructive.
  - `Autonomous` (`never`): Tự động duyệt tất cả các tool, ngoại trừ các lệnh luôn-chặn (hard safety backstop: `rm -rf /`, `format C:`, `mkfs`...).
  - `Chat Only` (`chat_only`): Vô hiệu hóa hoàn toàn toàn bộ công cụ (kể cả `fs_read`), dùng cho viết lách, giải thích và phân tích thuần túy.
- **Bảng phân quyền chi tiết per-tool**: Bảng trong Cài đặt cho phép gán quyền `auto` (Tự duyệt), `ask` (Luôn hỏi), `deny` (Chặn), hoặc `default` (theo policy) cho từng công cụ độc lập thuộc 8 nhóm (`fs`, `shell`, `git`, `mcp`, `web`, `plan`, `delegate`, `memory`), hỗ trợ tìm kiếm và nút Đặt lại mặc định. Lưu trữ đồng bộ Zustand persist + Dexie v14 (`toolPermissions`). Tool bị đặt `deny` lập tức trả lỗi `denied by policy`, không mở modal duyệt.

### Cấu trúc Cài đặt (Settings)

Hệ thống Cài đặt được tổ chức lại theo 6 nhóm chức năng trực quan, hỗ trợ tìm kiếm tức thì và phím tắt điều hướng chuẩn APG:

1. **Giao diện & trải nghiệm (`appearance`)**: Cấu hình tham số mô hình (temperature, system prompt), phong cách nhập liệu (Enter để gửi, Steering/Follow-up), nén ngữ cảnh tự động, hiệu ứng chuyển động và tần suất vẽ lại (throttle).
2. **Model & Nhà cung cấp (`providers`)**: Quản lý API key cá nhân (BYOK), kho key mã hoá OS (`safeStorage`), endpoint nhà cung cấp, vision model, access code và routing thông minh (Lead/Worker).
3. **Quyền & An toàn (`safety`)**: Chế độ phê duyệt (hợp nhất 1 nguồn sự thật: Manual / Smart / Autonomous / Chat Only), Staging Sandbox, bảng phân quyền chi tiết per-tool (thu gọn), Code Mode (`run_code`) và đường tool giả lập.
4. **Mở rộng (`extensions`)**: Cấu hình máy chủ MCP (`stdio`/`SSE`), Skills trên đĩa (`.vyen/skills/`) và quản lý lệnh slash tuỳ biến.
5. **Bộ nhớ (`memory`)**: Hợp nhất luồng quản lý ký ức 3 giai đoạn: Đề xuất đang chờ duyệt (Reviewer Gate) → Ký ức đã duyệt → Bộ nhớ chủ động có cấu trúc (`agent-memory`).
6. **Dữ liệu & Tự động hoá (`data`)**: Tự động sao lưu (nhắc định kỳ hoặc ghi file ngầm FSA), sao lưu & phục hồi (JSON/Markdown), thống kê token và scheduler lịch chạy.

### Session Management & ChatRecall

- **Gắn phiên với thư mục làm việc**: Tự động liên kết `workspacePath` vào metadata phiên chat (`db.chats`). Khi mở lại phiên cũ từ Sidebar hoặc URL (`/?chatId=...`), giao diện hiển thị banner thông minh đề nghị kết nối lại đúng thư mục dự án tương ứng.
- **Đổi tên linh hoạt (Rename)**: Đổi tên phiên trực tiếp trên Sidebar (hỗ trợ double-click để sửa inline hoặc chọn qua menu hành động), và trong giao diện CLI qua lệnh slash `/rename <tên mới>`.
- **Tiếp tục phiên làm việc (Resume)**:
  - **UI**: Mỗi phiên trong Sidebar có nút "Tiếp tục (Resume)" và menu "Mở cửa sổ mới" tạo luồng làm việc độc lập.
  - **CLI**: Tiếp tục phiên gần nhất qua `npm run cli -- session -r` hoặc theo tên/ID qua `npm run cli -- session -r --name <tên>`. Tự động lưu tiến trình sau mỗi lượt hội thoại vào `.vyen/sessions/` (hoặc `~/.vyen/sessions/`).
- **Tìm kiếm toàn cục `chat_recall(query, limit)`**: Công cụ client cho phép mô hình AI tra cứu toàn bộ lịch sử các phiên thảo luận trong Dexie. Sử dụng bộ phân tích từ khóa tiếng Việt không dấu/có dấu (foldText) để trích xuất ngữ cảnh liên quan và trả về đoạn snippet phù hợp nhất (ví dụ: "tìm hội thoại tuần trước về React hooks").

### Scheduler: Chạy Recipe Theo Lịch Cron

- **Biểu thức Cron tiêu chuẩn**: Hỗ trợ 5 trường cron (`phút giờ ngày tháng thứ`), bước nhảy `*/n`, khoảng, danh sách và alias (`@hourly`, `@daily`, `@weekly`). Tự động giải nghĩa bằng câu tiếng Việt và hiển thị mốc chạy tiếp theo.
- **Thực thi ngầm qua Node bridge & CLI**: Bộ timer tick mỗi 30 giây chạy headless, tự động tạo chat session mới chứa kết quả thực thi và liên kết danh sách `sessions[]` vào lịch trình.
- **Bảng Dexie `schedules` (v16)**: Lưu trữ `id, recipeId, cron, enabled, lastRunAt, lastStatus, sessions[]`, hỗ trợ đồng bộ hai chiều giữa Web UI và bridge daemon (`.vyen/schedules.json`).
- **Giao diện Scheduler trực quan**: Tab riêng trong Cài đặt và panel quản trị — hỗ trợ Tạo / Sửa / Tạm dừng (Pause) / Kích hoạt (Resume) / Chạy ngay (Run now), xem lịch sử các session do lịch trình sinh ra và click để mở trực tiếp xem kết quả.
- **Lệnh CLI `vyen schedule`**:
  - `vyen schedule list`: Liệt kê các lịch trình và trạng thái lần chạy gần nhất.
  - `vyen schedule run <id>`: Chạy ngay lập tức một lịch trình.
  - `vyen schedule daemon`: Chạy tiến trình scheduler daemon (tick mỗi 30s) trong terminal.

### Zero-Mem: Bộ nhớ Không Tiêu hao Token (Port sarsvankelsion/zero-mem)

- **Zero-Token Memory Operations**: Loại bỏ hoàn toàn các lượt gọi LLM tốn kém để tóm tắt hoặc tổ chức bộ nhớ. Toàn bộ chu trình trích xuất thực thể, liên kết đồ thị, và xếp hạng truy xuất diễn ra bằng thuật toán nội bộ nhanh dưới 2ms và tiêu tốn **0 token**.
- **Raw Trace Source of Record**: Bảo tồn nguyên văn toàn bộ chuỗi nhật ký hội thoại và kết quả tool dưới dạng nguồn chân lý bất biến (append-only), chống biến dạng hoặc mất mát thông tin do tóm tắt.
- **Kiến trúc Dual-View**:
  - **Entity-Context Graph**: Đồ thị quan hệ định hướng với trọng số giữa các thực thể code (files, functions, classes, interfaces, diagnostics, tools, concepts) với thuật toán lan truyền kích hoạt (spreading activation).
  - **Temporal Hierarchy & Exponential Decay**: Phân cấp Phiên -> Episode (Milestone/Task) -> Lượt; áp dụng suy giảm thời gian hàm mũ và điểm thưởng liên tục cho episode đang hoạt động (+25%).
- **Deterministic Multi-Stage Retrieval**:
  - Xếp hạng từ vựng BM25 tiếng Việt và mã nguồn + Lan truyền năng lượng đồ thị + Suy giảm thời gian.
  - Đóng gói theo ngân sách token và format thẻ `<zero-mem-evidence>` tự động nhúng vào ngữ cảnh nhắc lệnh.
- **Bộ công cụ Zero-Mem**:
  - `zeromem_query(query, max_results, mode, episode_id)`: Truy xuất ngữ cảnh chính xác cao.
  - `zeromem_log(content, role, tool_name, episode_id)`: Ghi nhận trace và tự động trích xuất thực thể đồ thị.
  - `zeromem_inspect(target, entity_id)`: Kiểm tra hàng xóm quan hệ trên đồ thị hoặc cây episodes.
  - `zeromem_stats()`: Đo lường footprint bộ nhớ và số token LLM đã tiết kiệm được.
- **Lưu trữ bền vững**: Schema Dexie v18 với 3 bảng `zeromemTraces`, `zeromemEntities`, `zeromemRelations`. Ghi qua `lib/zeromem/persistence.ts` (chỉ chạy ở trình duyệt — `lib/zeromem/store.ts` giữ runtime-agnostic để CLI headless dùng được); nạp lại bằng cách replay trace nên đồ thị tái dựng y hệt nguồn.

### Sarsed-Code: Harness Lập trình Tự hành & Sửa lỗi Khép kín (Port sarsvankelsion/sarsed-code)

- **AST Code Skeletonizer (Nén ngữ cảnh 80-90%)**:
  - Trích xuất khung xương cấu trúc mã nguồn cho đa ngôn ngữ (TypeScript, JavaScript, Python, Go, Rust).
  - Giữ nguyên vẹn 100% imports, exports, interface, type definition, function signature và docstrings; thu gọn phần thân cài đặt `{ ... }` thành comment `/* implementation ... */`.
  - Cho phép agent khảo sát toàn diện các module hàng nghìn dòng mà chỉ tốn vài trăm token prompt.
- **Chỉ mục Ký hiệu & Call Hierarchy Workspace**:
  - Lập chỉ mục định nghĩa hàm, lớp, interface, kiểu dữ liệu toàn bộ workspace.
  - Truy vết tham chiếu chéo (cross-file references) và phân tích cây phân cấp gọi hàm (call hierarchy).
- **Sarsed Transactional Semantic Patcher**:
  - Vá mã nguồn đa khối (multi-hunk) giao dịch nguyên tử: hoặc toàn bộ các khối patch thành công, hoặc rollback hoàn toàn về trạng thái sạch ban đầu.
  - Tự động căn chỉnh thụt lề (Indentation Auto-Alignment) và nhận diện tab/spaces.
  - Bảo toàn line ending gốc (CRLF/LF) và hỗ trợ line-hint định vị khối.
- **Bộ phân tích Chẩn đoán Đa công cụ (Diagnostic Engine)**:
  - Phân tích cú pháp đầu ra stdout/stderr từ `tsc`, `eslint`, `vitest`, `mypy/python`, `cargo/rust` thành đối tượng `CodeDiagnostic` có cấu trúc.
  - Tương thích đường dẫn Windows drive-letter.
- **Vòng lặp Tự sửa Khép kín SARS (Sense-Analyze-Refactor-Synthesize)**:
  - **Sense**: Tự động chạy lệnh kiểm chứng sau mỗi lần sửa mã.
  - **Analyze**: Bắt vết chẩn đoán lỗi trên các dòng bị ảnh hưởng.
  - **Refactor**: Đề xuất khối patch sửa lỗi đích danh theo dòng và mã lỗi.
  - **Synthesize**: Áp dụng patch và kiểm chứng lại trước khi báo cáo hoàn thành.
- **Bộ công cụ Sarsed**:
  - `code_skeleton(file_path, content, preserve_comments)`
  - `code_symbols(query, kind, file_path)`
  - `code_patch(file_path, hunks, atomic)`
  - `code_verify(command, raw_output, touched_files)`

### Làm việc quy mô lớn

- **Subagent delegate**: agent chính giao task độc lập cho subagent chạy với context riêng (không thấy lịch sử chat), không thể đệ quy (subagent không có `delegate`), giới hạn mặc định 10 turns (tối đa 25). Subagent vẫn dùng được tool trên máy bạn (fs/shell/git/MCP) nhờ relay: server phát annotation xuống renderer, renderer thực thi rồi POST kết quả về `/api/chat/subagent-relay`. Hoạt động cả đường native function-calling lẫn emulated.
- **Sub-recipes**: session chạy recipe có `sub_recipes` thì mỗi sub-recipe trở thành một tool `subrecipe__<name>` (schema sinh từ parameters, giá trị gắn cứng không đè được) + tool `subrecipe__batch` chạy nhiều cái **song song cap 3** (kết quả JSON từng lane hiển thị card subagent, Stop hủy được cả lô). `return_mode`: `summary` (mặc định, ≤ 2.000 ký tự) hoặc `full`. Sub-recipe là leaf worker — không delegate, không lồng sub-recipe (chống đệ quy).
- **Nhãn nguồn orchestrator (còn lại sau khi gỡ sweep)**: `OrchestratorBadge` vẫn render khi message có annotation `orchestratorAdopted` (đọc qua `getOrchestratorAdoptedAnnotation`). Panel sweep, route `/api/orchestrate` và bộ engine/grid/metrics của orchestrator **đã được gỡ**. <!-- docs-check:ignore --> — hiện không còn producer nào ghi annotation này, phần còn sống của `lib/orchestrator/` chỉ là `scheduler.ts` (pool giới hạn đồng thời).
- **Plan & checklist**: task lớn được phân rã bằng `plan_create`/`plan_update`; UI hiện checklist tiến độ (Chờ/Đang làm/Xong/Lỗi/Bỏ qua) kèm progress bar. **Plan Mode** khoá agent ở chế độ khảo sát — chỉ đọc/liệt kê/tìm và hỏi làm rõ, tool ghi bị vô hiệu cho tới khi bạn chuyển sang Act.
- **Self-improvement lessons**: agent tự lưu bài học sau khi sửa bug khó / phát hiện pattern hay bằng `lesson_save` (3 loại: rule / pattern / gotcha, tối đa 400 ký tự); các bài học được inject vào system prompt của các phiên sau.

### Kiểm soát ngữ cảnh & model

- **Compaction**: hội thoại dài tự nén qua `/api/compact` — phần cũ thay bằng summary, dữ kiện quan trọng (file đã chạm, yêu cầu đã nêu) sống sót qua nhiều lần nén.
- **Lead/Worker routing**: state machine tính lại từ toàn bộ lịch sử mỗi lượt (không lưu state riêng — sống sót qua reload), client chỉ override field `model` của request như đường media/recipe; server không cần biết. `/plan` chạy planner model đúng một lượt rồi nhả về routing thường.
- **Thanh trượt suy luận**: 4 mức low/medium/high/max; mức nào khả dụng đọc từ metadata `/v1/models` (chuẩn OpenRouter) nên model không hỗ trợ không nhận tham số rác.
- **Ngân sách tool**: tối đa 32 lần gọi tool mỗi lượt (đếm theo hội thoại, không reset khi client resubmit), tự chặn gọi trùng tham số và phát hiện doom-loop để bảo model đổi hướng; kết quả tool bị cắt ở 24.000 ký tự.
- **Sinh ảnh/video**: nút trong ô nhập gọi thẳng nhà cung cấp để tạo ảnh hoặc video ngay trong khung chat, tự fallback qua server khi nhà cung cấp chặn CORS.
- **Emulated tool-calling**: model không hỗ trợ function calling vẫn dùng được toàn bộ tool — schema render thành text trong system prompt, model trả khối `<tool_call>` JSON, server parse + thực thi + vòng lặp (trần 10 vòng, 5 call/vòng, chống model tự bịa kết quả tool).

## Tech stack

| Tầng | Công nghệ |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| UI | React 19, Tailwind CSS, lucide-react |
| Trạng thái | Zustand (persist localStorage) |
| Lưu trữ | Dexie (IndexedDB) — schema 19 phiên bản có migration |
| AI | AI SDK (`ai` + `@ai-sdk/openai`), stream qua API routes Node.js |
| Virtualization | @tanstack/react-virtual |
| Desktop | Launcher Edge/Chrome `--app` vào Next.js local (`npm run app:fast`, cửa sổ riêng, ~35MB RAM) |
| MCP | `@modelcontextprotocol/sdk` (client chạy trong bridge Node.js của desktop/CLI, phê duyệt 4 cấp) |

## Chạy dự án

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (type-check bật)
npm run start
npm test         # unit tests (vitest)
npm run lint     # eslint
npm run typecheck  # tsc --noEmit

# Bản desktop (launcher Edge/Chrome --app nhẹ — không Electron/Tauri)
npm run app        # mặc định: mở cửa sổ app Edge/Chrome --app vào Next.js local
npm run app:fast   # alias của app — đường mở nhanh, kết nối lại server đang chạy nếu có
npm run desktop    # alias của app
npm run cli        # CLI: npx tsx bin/vyen.ts cli
npm run teamwork   # Teamwork multi-agent engine (headless): npx tsx bin/teamwork.ts
# Desktop tự chủ: chỉ cần cấu hình Nhà cung cấp trong app — không cần .env.local
```

## Biến môi trường (`.env.local`)

Bảng dưới là **các biến mà code thật sự đọc** — kiểm chứng bằng `npm run docs:check`. Không biến nào bắt buộc: bản desktop/CLI tự chủ sau khi cấu hình Nhà cung cấp trong app.

**Gateway & CLI headless**

| Biến | Mô tả |
|---|---|
| `OPENAI_API_KEY` | Key gateway kiểu OpenAI cho CLI headless (đầu chuỗi dự phòng trong `lib/cli/interactive-agent.ts`); người dùng có provider riêng trong Cài đặt thì không cần |
| `ANTHROPIC_API_KEY` | Key dự phòng kế tiếp trong chuỗi của CLI |
| `OPENROUTER_API_KEY` | Như trên, đồng thời tự chọn `https://openrouter.ai/api/v1` làm baseUrl khi chưa đặt `VYEN_BASE_URL` |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `DEEPSEEK_API_KEY` | Key dự phòng của CLI; mỗi key tự gắn baseUrl của nhà cung cấp đó |
| `VYEN_API_KEY` | Key chung của Vyen, đứng cuối chuỗi dự phòng |
| `VYEN_BASE_URL` | Base URL tường minh cho CLI (ưu tiên cao nhất) |
| `VYEN_MODEL` | Ép model cho CLI |
| `VYEN_MOCK_AGENT` | `1` = chạy agent giả, không gọi mạng |
| `MODEL_ALIAS_MAP` | JSON map tên model nội bộ → tên thật trên gateway, không cần deploy lại |
| `TITLE_MODEL_CHAIN` | Chuỗi model dự phòng sinh tiêu đề khi không có provider active, mặc định `gpt-5-4-nano,gpt-4o-mini,gpt-5-6-terra,deepseek-v4-flash`; có provider active thì model người dùng đang chọn được ưu tiên trước |
| `COMPACT_MODEL_CHAIN` | Tương tự, cho `/api/compact` |
| `CHAT_DEBUG_ERRORS` | `true` để kèm body lỗi upstream vào message |
| `CHAT_STREAM_BUDGET_MS` | Ngân sách stream của `/api/chat`, mặc định `270000` (4,5 phút) |

**Tìm kiếm web** — đặt một trong các biến này để tra cứu đáng tin (hai endpoint scrape của DuckDuckGo nay trả 403):

| Biến | Mô tả |
|---|---|
| `TINYFISH_API_KEY` | Search API (có bản miễn phí) |
| `SEARXNG_URL` | Instance SearXNG tự host; nhận nhiều instance cách nhau `,` |
| `BRAVE_SEARCH_KEY` | Brave Search API |
| `TAVILY_API_KEY` | Tavily API |

**Bảo vệ route**

| Biến | Mô tả |
|---|---|
| `ACCESS_CODE` | Yêu cầu mã truy cập (Bearer) khi gọi route LLM/web |
| `ALLOWED_ORIGIN_HOSTS` | Host origin phụ được chấp nhận, cách nhau `,` |
| `TRUSTED_PROXY_HOPS` | Số hop proxy tin cậy khi đọc `x-forwarded-for`, mặc định `1`; chạy trực tiếp không qua proxy thì đặt `0` |
| `TRUST_PROXY_IP_HEADERS` | `1` = tin thêm các header IP phụ do proxy gửi |

**Desktop launcher**

| Biến | Mô tả |
|---|---|
| `VYEN_WORKSPACE_ROOT` | Workspace root của phiên desktop/CLI |
| `VYEN_USER_DATA_DIR` | Thư mục dữ liệu riêng của bản desktop (chứa bridge token) |
| `VYEN_BRIDGE_TOKEN` | Token cho `/api/bridge` khi tự chạy server ở chế độ dev |
| `VYEN_LAUNCHER_NO_BROWSER` | `1` = chỉ khởi động server, không mở cửa sổ app |
| `VYEN_USE_NPM` | `1` = buộc launcher dùng `npm` thay vì trình chạy mặc định |
| `DEBUG_VYEN_BRIDGE` | `1` = log chi tiết các lời gọi bridge |

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
app/api/pdf      — trích text PDF (unpdf) phía server cho tài liệu đính kèm
app/api/providers/models — POST { baseUrl, apiKey } → fetch `${baseUrl}/models`
                  phía server (né CORS + chặn Origin của một số gateway)
app/api/server-config — trả capability mặc định của model server-side (metadata tĩnh)
app/api/vision   — mô tả ảnh workspace / ảnh MCP thành text bằng model
                  vision của provider active (BYOK — client gửi headers
                  provider + model vision đã chọn)
app/api/compact  — nén hội thoại dài thành summary có state tích lũy
app/api/title    — sinh tiêu đề, chống prompt-injection, heuristic fallback
app/api/web      — proxy tra cứu web: DuckDuckGo lite→html + đọc trang
                  (SSRF guard từng hop redirect, trần 1.5MB/12s mỗi trang)
app/api/bridge   — cầu nối desktop: endpoint local-only + token, chuyển tiếp
                  fs/shell/git/MCP xuống Node bridge server của launcher
scripts/launch-desktop.cjs — launcher mặc định: mở cửa sổ Edge/Chrome --app
                  vào Next.js local (tự start dev server nếu chưa chạy)
bin/vyen.ts       — CLI Vyen (`npm run cli` / `npm run vyen`)

lib/             — logic agent thuần, test được trong node:
                  agent-tools (server + client tool defs), emulated-agent,
                  subagent + subagent-relay, orchestrator/ (scheduler —
                  runPool giới hạn đồng thời, dùng bởi subagent + sub-recipe),
                  auto-pilot (phê duyệt), staging,
                  goal-loop, debug-loop, lessons, plan (subtask-plan),
                  mcp/ (tool-mapper, bridge, image-content), fs-vision,
                  context-compaction, reasoning-capability,
                  model-routing (lead/worker state machine),
                  recipes/ (schema zod, template one-pass, retry state
                  machine, structured output, share link, sub-recipe tools),
                  skills/ (SKILL.md front-matter + chỉ mục + hints),
                  memory/ (bộ nhớ cấu trúc + mirror markdown)

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
components/recipes/            — panel Recipes (list, form tham số, Run,
                                 Import/Export, share link preview)
components/mcp/                — settings MCP + hộp thoại phê duyệt 4 cấp

.vyen/                          — cấu hình per-workspace do agent/people dùng
                                  đọc/ghi: recipes/ (*.yaml), skills/
                                  (<name>/SKILL.md), memory/ (<category>.md),
                                  hints (.vyenhints ở root workspace)
```

### Mô hình cây

Message gốc mang `parentId = '__ROOT__'` (IndexedDB không index được `null`). `branchOrder` là số thứ tự sibling, `branchTieBreaker` (= id) đảm bảo thứ tự ổn định. Mọi lệnh chèn message mới đi qua `db.appendMessage` — cấp `seq`/`branchOrder` nguyên tử trong transaction nên hai tab không đè nhau.

## Ghi chú triển khai

- Routes API khai báo tường minh `export const runtime = 'nodejs'` — đã rời Edge trước khi Next 16 deprecate.
- Rate limit in-memory per-isolate: chỉ là lớp chống spam nhẹ, cần Upstash Redis nếu muốn chính xác toàn cục.
- Origin cho phép: `localhost`, `127.0.0.1`, `[::1]`; thêm domain riêng qua `ALLOWED_ORIGIN_HOSTS`.
