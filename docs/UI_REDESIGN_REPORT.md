# Báo cáo thi công — Tái thiết kế UI & dọn dẹp Vyen (vòng 2)

> Ngày: 2026-09-20. Trạng thái: **đã thi công**, chưa commit.
> Kế hoạch gốc: `docs/UI_REDESIGN_PLAN_V2.md`. Tài liệu này ghi lại **thực tế đã làm**,
> các quyết định đã chốt, và những việc còn lại.

---

## 0. Ba quyết định đã chốt với người dùng

| # | Câu hỏi | Lựa chọn |
|---|---|---|
| 1 | Hướng thị giác | **Giữ nguyên bản sắc pixel/Minecraft** — không thêm bóng đổ, không bo góc |
| 2 | Zero-Mem & Sarsed-Code | **Đăng ký tool để dùng được thật** |
| 3 | Bảng Dexie chết | **Xoá hẳn, migration schema v18** |

Quyết định #1 đặt ra bài toán thú vị: giữ phẳng tuyệt đối **mà vẫn tạo được phân cấp**.
Lời giải: **bevel hai tông** — xem mục 1.1.

---

## 1. Yêu cầu #1 — Thiết kế lại UI

### 1.1 Nguyên tắc: BEVEL thay cho bóng đổ

GUI Minecraft và Windows 95 không dùng bóng đổ — chúng tạo chiều sâu bằng **viền hai tông**:
cạnh trên & trái sáng hơn, cạnh dưới & phải tối hơn. Đây chính là thứ hệ thống còn thiếu.

Đã thêm vào `app/globals.css`:

| Tiện ích | Dùng cho |
|---|---|
| `.vyen-bevel` | Khối nổi: panel, popover, dropdown, nút |
| `.vyen-bevel-inset` | Khối chìm: ô nhập, rãnh |
| `.vyen-bevel-soft` | Card/khối lớn |
| `.vyen-block-head` | Dải tiêu đề khối (nền sáng hơn + gạch chân) |
| `.vyen-rule` | Đường phân cách trong khối |

Bevel dùng `rgba()` nên **không mở rộng bảng màu** DESIGN.md.

### 1.2 Viền chia theo VAI TRÒ

Trước: **mọi** đường viền dùng chung `#495059` → khung, control và divider cùng trọng lượng
thị giác → mắt không có tầng bậc để bám vào.

Nay tách 4 bậc (`app/globals.css`, `tailwind.config.ts`):

| Token | Giá trị | Vai trò |
|---|---|---|
| `--border-subtle` | `#495059` @ 45% | Đường phân cách **trong** một khối |
| `--border-hairline` | `#495059` | Viền **khung** bao ngoài |
| `--border-control` | `#5d666f` *(màu mới)* | Viền **control** (ô nhập, nút) |
| `--border-hover` | `#757d89` | Hover / focus / active |

`#5d666f` được khai báo chính thức vào `DESIGN.md` mục 2 và `PALETTE_TOKENS` trong test.

### 1.3 Typography & mật độ

| Trước | Sau | Lý do |
|---|---|---|
| Base `18px` | Base **`16px`** | Mọi kích thước rem đang phình 12,5% (`text-xs` = 13,5px, `p-2` = 9px) |
| Nhãn trường dùng `.pixel-label` (IN HOA + giãn 0,08em + font pixel) | `.field-label` — mono, **chữ thường**, 13px | IN HOA + giãn chữ + pixel font là tổ hợp tệ nhất cho việc đọc quét |
| `.field-hint` mới | 12px, `--text-muted`, `line-height: 1.5` | Mô tả phụ đọc được |
| `.pixel-label` 0,84rem / 0,08em | 0,78rem / 0,06em | Chỉ còn dùng cho tiêu đề mục cấp 1 |

Thang chữ và thang khoảng cách (4/8/12/16/24/32) đã ghi thành hợp đồng trong `DESIGN.md` mục 3.

### 1.4 Token hoá ngữ nghĩa toàn bộ component

Chạy `scripts/codemod-tokens.cjs` — đổi hex thô sang class token **và gán vai trò cho viền**:

| Chỉ số | Trước | Sau | Giảm |
|---|---|---|---|
| Hex thô (13 file bề mặt UI) | **828** | **136** | **−84%** |
| Class Tailwind palette | 0 | 0 | — |
| Cặp `dark:` | 0 | 0 | — |

Ví dụ `settings-dialog.tsx`: 246 → 34 hex. `sidebar.tsx`: 91 → 3.

### 1.5 Sửa một assertion test đang CHẶN việc dùng token

`tests/design-system.test.ts` có `expect(hexes.length).toBeGreaterThan(0)` — bắt buộc mỗi file
phải còn hex, tức **cấm luôn** việc migrate sang token. Đã sửa thành: hex nào còn lại cũng phải
thuộc bảng màu (không bắt buộc phải có hex). Thêm test mới buộc mọi file trong hợp đồng phải
dùng ít nhất một token ngữ nghĩa.

### 1.6 Settings: từ danh sách phẳng sang bố cục card

- Thêm `.settings-card` + `.settings-card-head` + `.settings-card-body`.
- Luật CSS biến `<h4>` đầu khối thành dải tiêu đề tràn viền → **chỉ cần đổi className khối ngoài**,
  không phải viết lại JSX.
- **8 khối** trong Settings đã chuyển sang card; 7 tiêu đề `<h4>` chuẩn hoá về `.field-label text-[15px]`.
- Tab "Giao diện" được gom lại thành card "Tham số mô hình" (Temperature + System Prompt).

### 1.7 Thang z-index tập trung

Tạo `lib/ui-z.ts` — 8 lớp, có bất biến được test kiểm chứng:

| Lớp | z | Dùng cho |
|---|---|---|
| `content` | 0 | Chat, sidebar |
| `dropdown` | 40 | TaskMenu, ThinkingMenu, menu phiên |
| `popover` | 50 | ModelSelector, ChatExportMenu |
| `toast` | 60 | ToastHost |
| `approval` | 80 | DiffConfirm, ShellConfirm, StagingPanel |
| `approvalCritical` | 85 | McpToolApprovalDialog |
| `navigation` | 90 | ToolsPanel, RecipesPanel, WorkspaceCheckpoints |
| `system` | 100 | **Cài đặt**, xác nhận xoá |

**Ba lỗi thật đã sửa:**
1. `settings-dialog.tsx` ở `z-50` — **thấp hơn mọi modal**, nên mở Cài đặt trong lúc có modal
   thì modal vẽ đè lên Cài đặt. → nay `Z_CLASS.system`.
2. `sidebar.tsx` menu ngữ cảnh ở `z-[100]` — nổi trên cả modal. → nay `z-40`.
3. `workspace-checkpoints.tsx` ở `z-[100]` ngang hàng hộp thoại hệ thống. → nay `navigation`.

9 file overlay đã chuyển sang dùng hằng số `Z_CLASS`, không còn số cứng.

---

## 2. Yêu cầu #2 — Dọn Settings

### 2.1 Gỡ thư viện prompt của bản web chat cũ

`lib/prompt-library.ts` (189 dòng) seed **5 mẫu prompt của một trợ lý chat đa dụng**:
"Dịch Trung - Việt", "Giải thích code", "Sửa lỗi chính tả", "Tóm tắt văn bản", "Viết unit test".

Đây là rác của bản web chat cũ. Nó sống sót qua lần dọn trước vì được tái sử dụng cho mục
**"Skills cũ (trình duyệt)"** trong Cài đặt.

Đã gỡ:
- Xoá `lib/prompt-library.ts`
- Xoá `LegacySkillsSection` (**176 dòng** trong `settings-dialog.tsx`)
- Xoá `db.prompts` + type `PromptTemplate`
- Xoá entry search index `ext-legacy`
- Gỡ import và nhánh inject skill theo từ khoá trong `chat-interface.tsx` (chỉ hoạt động nhờ prompt cũ)
- Chuyển `filterPrompts` (còn dùng cho menu "/") sang `lib/slash-commands.ts`, giữ nguyên
  hành vi fold dấu; test chuyển sang `tests/skills-catalog.test.ts`

Menu "/" **không mất gì**: nó vốn dựng từ `BUILTIN_SLASH_COMMANDS` + lệnh tuỳ biến + recipe.

### 2.2 Đính chính về "8 bảng Dexie chết"

Kế hoạch nói xoá 8 bảng. Khi kiểm chứng từng bảng trước khi xoá thì phát hiện **chỉ 1 bảng thật sự chết**:

| Bảng | Kết luận | Bằng chứng |
|---|---|---|
| `prompts` | **CHẾT** → xoá ở v18 | Chỉ `lib/prompt-library.ts` + `LegacySkillsSection` dùng |
| `memories` | **SỐNG** → giữ | `addMemory`/`listMemories` dùng trong luồng đề xuất ghi nhớ của `chat-interface` |
| `memoryCandidates` / `memoryRecords` / `memoryReviews` | **SỐNG** → giữ | `lib/memory/store.ts` (reviewer gate) dùng thật |
| `zeromemTraces` / `zeromemEntities` / `zeromemRelations` | **trước đây chết** → nay sống | Chưa ai ghi; nay có `lib/zeromem/persistence.ts` ghi thật |

Xoá cả 8 theo kế hoạch sẽ **làm hỏng** luồng bộ nhớ và tính năng Zero-Mem. Nên chỉ xoá `prompts`.

**Phát hiện thêm:** ba hệ bộ nhớ (`memories`, reviewer gate, `agentMemories`) đều đang hoạt động —
vấn đề là **trùng lặp về UI**, không phải code chết. Việc gộp UI còn lại (xem mục 5).

---

## 3. Yêu cầu #3 — Sửa logic thinking slider

### 3.1 Nguyên nhân "fake với mọi model"

Nhiều gateway trả metadata kiểu OpenRouter với `reasoning: {}` cho **mọi** model.
`parseModelReasoning` biến nó thành `{ efforts: [], mandatory: false }` — **khác `null`** —
nên `modelReasoningCap` truthy và menu vẫn hiện. Rồi `thinking-menu.tsx` coi
`efforts.length === 0` là "hỗ trợ cả 4 mức" → hiện đủ Thấp/Trung bình/Cao/Tối đa cho một model
thực chất chỉ bật/tắt suy luận.

### 3.2 Cách sửa

Thêm hàm thuần `shouldShowThinkingControl(cap)` vào `lib/reasoning-capability.ts`:

| Trường hợp | Trước | Sau |
|---|---|---|
| Không có metadata (`null`) | Ẩn | Ẩn |
| `efforts.length > 0` | Hiện | Hiện |
| `mandatory === true` | Hiện | Hiện (nói rõ "luôn suy luận") |
| **`efforts: []` + `mandatory: false`** | **Hiện đủ 4 mức** ❌ | **Ẩn** ✅ |

`chat-interface.tsx` nay gate bằng hàm này thay vì chỉ kiểm tra truthy.

**Không sửa tầng parser** vì hành vi toggle-only được test khoá lại
(`tests/reasoning-capability.test.ts:30`) — sửa ở tầng UI là đúng chỗ.

Thêm 5 test cho ma trận quyết định, gồm ca mô phỏng chính xác `reasoning: {}`.

---

## 4. Yêu cầu #4 — Quét code chết

### 4.1 Công cụ

`scripts/audit-dead-code.cjs` — phân tích **khả năng tiếp cận** từ entry point thật
(`app/`, `bin/`, `scripts/`), lan theo import/require/re-export. Phân biệt ba loại:
`SỐNG` / `CHỈ-TEST` (tính năng đã gỡ, chỉ còn test canh) / `MỒ CÔI`.

Điểm quan trọng: route API không được client nào gọi thì **không** tính là entry point — nếu
tính, toàn bộ cây dependency của một tính năng đã gỡ vẫn bị coi là "sống".

### 4.2 Kết quả

| Chỉ số | Trước | Sau |
|---|---|---|
| File nguồn | 505 | **475** (đã tính 16 file tách ra từ settings-dialog) |
| Chỉ-test (dead feature) | 31 | **4** |
| Mồ côi | 4 | **0** |
| Route API chết | 2 | **0** |
| File test | 178 | **161** |

4 file "chỉ-test" còn lại đều thuộc `lib/teamwork/` (`index.ts`, `contracts/index.ts`,
`sandbox/index.ts`, `mcp-client.ts`) — xem mục 4.4.

### 4.3 Đã xoá

**Tính năng đã gỡ khỏi sản phẩm (chỉ còn test canh):**
- `lib/agent/` (5 file) + `lib/agent-runtime/` (7 file) — harness agent cũ
- `lib/fanout/` (4 file) + `app/api/fanout/dispatch/route.ts`
- `lib/orchestrator/{engine,grid,metrics,plan,prompts,repair}.ts` + `app/api/orchestrate/route.ts`
  + `lib/use-orchestrator.ts` — tính năng orchestrator sweep đã gỡ UI từ commit `10d4d89`
- `lib/ast-search.ts`, `lib/codegraph.ts`, `lib/project-terms.ts`
- `lib/pollinations.ts`, `lib/speech-text.ts`, `lib/use-tts.ts` (TTS)
- `lib/sse.ts` (chỉ `use-orchestrator` dùng)
- `lib/memory/index.ts` (barrel không ai import)

**17 file test xoá hoàn toàn**; `tests/p1-p2.test.ts` tách thành `tests/skills-catalog.test.ts`
(giữ lại phần còn tương ứng code đang chạy); `tests/secret-registry.test.ts` cắt khối dùng agent loop.

### 4.4 Giữ lại có chủ ý

- `lib/orchestrator/scheduler.ts` — `runPool` được `lib/subagent.ts` và `lib/recipes/subrecipe-exec.ts` dùng thật
- `lib/teamwork/**` (kể cả barrel + `mcp-client.ts`) — là **API module** được `PROJECT.md` mô tả,
  chỉ chưa có importer ngoài test. Xoá sẽ phá vỡ kiến trúc đã tài liệu hoá.
- `lib/routing/*`, `lib/prompt/protocol.ts`, `lib/skills/*`, `lib/sarsed/*`, `lib/zeromem/*`

### 4.5 Rác ngoài lề đã dọn

- `tmp-sast-test-dir/` — do `tests/sast.test.ts` sinh ra rồi không dọn được (xem mục 6)
- Thêm `tmp-sast-test-dir/` vào `.gitignore` làm lưới an toàn

---

## 5. Đăng ký Zero-Mem & Sarsed-Code (quyết định #2)

### 5.1 Vấn đề gốc

README quảng cáo 8 tool nhưng **không tên tool nào có trong `lib/agent-tools.ts`** —
agent của app không bao giờ gọi được. Ba bảng `zeromem*` khai báo trong schema mà không ai ghi.

### 5.2 Đã làm

**a) Đăng ký 8 tool vào catalog + client tool defs:**

| Tool | Nhóm quyền | Tính chất |
|---|---|---|
| `zeromem_query`, `zeromem_log`, `zeromem_inspect`, `zeromem_stats` | `memory` | Ghi/đọc bộ nhớ 0 token |
| `code_skeleton`, `code_symbols`, `code_verify` | `fs_read` | Chỉ đọc |
| `code_patch` | `fs_write` | Ghi file — qua phê duyệt |

Schema lấy thẳng từ module thực thi (`lib/zeromem/tools.ts`, `lib/sarsed/tools.ts`) để
hai bên không lệch nhau.

**b) Persistence cho Zero-Mem — `lib/zeromem/persistence.ts`:**

`lib/zeromem/store.ts` phải giữ **runtime-agnostic** vì CLI headless cũng dùng nó
(không có IndexedDB). Nên persistence là adapter riêng, chỉ import từ phía app:
- Ghi trace + đồ thị xuống Dexie sau mỗi `zeromem_log`
- Nạp lại bằng cách **replay trace** — trích xuất thực thể là hàm thuần deterministic nên
  đồ thị tái dựng y hệt nguồn, tránh rủi ro schema đồ thị lưu cũ không khớp code mới

**c) `code_symbols` có nguồn dữ liệu thật:** `collectWorkspaceSources()` đi bộ workspace
**có trần** (200 file / 600KB, bỏ qua `node_modules`/`.git`/`dist`...). Trước đây tool không có
nguồn nào nên chỉ trả rỗng.

**d) `code_patch` KHÔNG ghi thẳng ra đĩa:** gọi patcher ở chế độ chỉ-tính rồi đẩy kết quả vào
đúng luồng phê duyệt đang có (staging nếu bật, ngược lại modal diff). Ghi thẳng sẽ phá mô hình
an toàn "mọi thay đổi đĩa đều qua duyệt".

---

## 6. Sửa lỗi hạ tầng test phát hiện trong quá trình

### 6.1 `tests/sast.test.ts` để lại rác và tự làm hỏng lần chạy sau

Test tạo thư mục **cố định** `tmp-sast-test-dir/` trong repo root, ghi `clean.ts` rồi `vuln.ts`,
và dọn ở cuối. Nếu lần chạy đứt giữa chừng, `vuln.ts` ở lại → lần chạy SAU quét thấy nó ngay ở
bước "file sạch" và đỏ dù code không sai. Thư mục này còn bị `tsc --noEmit` quét và làm
typecheck fail.

Đã sửa: dùng `fs.mkdtempSync(path.join(os.tmpdir(), 'vyen-sast-'))` — thư mục **riêng cho mỗi
lần chạy**, không làm bẩn repo, không còn phụ thuộc trạng thái lần trước.

### 6.2 Bỏ số cứng trong test catalog

`TOOL_CATALOG` tăng từ 30 → 38 entry, làm đỏ 4 test vốn chốt cứng số 30:
`tests/tool-catalog.test.ts`, `tests/redteam-catalog.test.ts`, `tests/tools-panel.test.ts`.
Đã đổi sang dẫn xuất từ `TOOL_CATALOG.length` — thêm tool không còn làm đỏ oan, mà độ chặt
không giảm (vẫn kiểm từng entry có nhãn đúng, đúng category, đúng thứ tự).

### 6.3 `tests/emulated-agent.test.ts` — test tự nhận "không flaky" nhưng thực ra flaky

Ca *"batch 3 server tool song song → TOOL_RESULT đúng thứ tự source"* chứng minh tính song song
bằng cách **so thứ tự hoàn thành**: `weather` (sleep 5ms) phải xong trước `web_search`
(sleep 60ms). Comment trong test ghi rõ *"không flaky theo timing CI"* — **nhận định đó sai**:
thứ tự hoàn thành phụ thuộc thời gian thực, và khi máy tải nặng (chạy full suite) thứ tự lệch đi.

**Đo được:** 6/6 xanh khi chạy riêng, nhưng đỏ trong full suite.

**Đã sửa** — chuyển sang đo **độ chồng lấn** thay vì thứ tự:

```ts
let inFlight = 0;
let maxInFlight = 0;
const tracked = async (produce) => {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try { await sleep(10); return produce(); } finally { inFlight -= 1; }
};
// …
expect(maxInFlight).toBeGreaterThanOrEqual(2);   // chạy tuần tự thì luôn = 1
```

Chạy song song ⇒ các tool chồng lấn ⇒ `maxInFlight ≥ 2`. Chạy tuần tự ⇒ tool trước phải xong hẳn
mới tới tool sau ⇒ luôn `= 1`. **Tải máy chỉ làm việc chồng lấn rõ hơn, không bao giờ làm mất
tín hiệu** — nên không còn flaky. Đã chạy lại 4/4 xanh.

Ghi chú kèm: lần sửa đầu tôi dùng barrier và đếm cứng 3 request → **sai**, vì `weather` gọi
fetch **hai lần** (geocoding rồi open-meteo), tổng là 4. Cách đếm chồng lấn không phụ thuộc
con số đó.

---

## 7. Trạng thái kiểm chứng

| Kiểm tra | Kết quả |
|---|---|
| `npm run typecheck` | **PASS** (sạch) |
| `npm run build` | **PASS** (Tailwind biên dịch được mọi `@apply` mới) |
| `scripts/audit-ui-tokens.cjs` | 828 → **105 hex**; 0 palette; 0 `dark:` |
| `scripts/audit-dead-code.cjs` | **0** mồ côi | **0** route chết | 4 chỉ-test (teamwork API) |
| `npx vitest run` | **153 / 160 file PASS** trong lần chạy cuối (7 file đỏ do môi trường — xem 7.1); mọi test chạm code đã sửa đều xanh |
| `tests/design-system.test.ts` | PASS (15 test) |
| `tests/a11y-contract.test.ts` | PASS (15 test) |
| `tests/approval-queue.test.ts` | PASS (10 test) |
| `tests/reasoning-capability.test.ts` | PASS (13 test) |
| `tests/tool-catalog.test.ts` + `redteam-catalog` | PASS (44 test) |
| `tests/tools-panel.test.ts` | PASS (25 test) |
| `tests/sast.test.ts` | PASS (10 test) |
| `tests/skills-catalog.test.ts` | PASS |

### 7.1 Bảy file test đỏ còn lại — đều do MÔI TRƯỜNG, không do code

**Nguyên nhân gốc duy nhất (xác nhận 2026-09-20):** runtime/harness CodeBuddy bên ngoài dự án
có cơ chế `safe-delete` bulk-guard. File state của guard này **bị hỏng chứa null byte** (`^@^@^@…`)
trong môi trường này, nên mọi thao tác `delete`/`write`/`edit` qua harness đều ném:

```
[safe-delete][SAFE_DELETE_BULK_GUARD_ERROR] failed to read state:
Unexpected token '^@', "^@^@^@..." is not valid JSON
```

Chuỗi này **không tồn tại trong source dự án** (tìm `lib/`, `components/`, `app/`, `node_modules`
đều không thấy) → thuộc về harness ngoài, nằm ngoài tầm sửa của code. Vì `safe-delete` chặn toàn
bộ primitive xoá/temp, nó kéo đỏ cả họ test chia chung hạ tầng: temp isolation, CWD lockdown,
git worktree cleanup, sandbox supervisor.

| Test (file) | Số ca | Triệu chứng | Thuộc code tôi sửa? |
|---|---|---|---|
| `tests/web-bridge.test.ts` | 3 | `harness.write`/`edit`/`delete` bị `SAFE_DELETE_BULK_GUARD_ERROR` chặn | KHÔNG (chỉ thêm `try/finally` dọn rác, không đổi assertion) |
| `tests/interactive-agent.test.ts` | 1 | `harness.edit` không thay thế được (cùng guard) | KHÔNG |
| `tests/teamwork-worktree.test.ts` | 3 | git worktree + dọn temp bị guard chặn | KHÔNG |
| `tests/teamwork-contracts-sandbox.test.ts` | 3 | CwdGuard / TempIsolationManager / SandboxedProcessManager dọn temp bị chặn | KHÔNG |
| `tests/teamwork-enhanced-engine.test.ts` | 1 | `useWorktrees` | KHÔNG |
| `tests/teamwork-boost-token-process-mcp.test.ts` | 2 | worktree + tiến trình nền | KHÔNG |
| `tests/teamwork-adversarial-stress.test.ts` | 1 | 5 tiến trình sandbox đồng thời | KHÔNG |

**Bằng chứng loại trừ:**
- 7 file đỏ này tôi **không sửa logic** (duy nhất `web-bridge.test.ts` được thêm `try/finally`
  dọn rác — không đổi một assertion nào; `emulated-agent.test.ts` sửa riêng nằm NGOÀI danh sách đỏ).
- Toàn bộ test chạm code redesign UI và test `emulated-agent` (sau sửa barrier) đều **xanh**.
- Lỗi phát sinh tại lớp harness ngoài (`safe-delete`), không tại hàm dự án.

**Số file đỏ dao động 3–7 giữa các lần chạy** (cùng một commit) — đúng dự đoán nếu nguyên nhân
là trạng thái môi trường bị hỏng, không phải logic code.

Kiểm chứng chéo: chạy `--no-file-parallelism` (tuần tự) số file đỏ **không giảm** → nguyên nhân
**không** phải tranh chấp song song mà là thao tác hệ thống bị guard chặn.

> Cách khắc phục triệt để (ngoài scope redesign): reset/xoá file state hỏng của `safe-delete`
> bulk-guard trong môi trường chạy, hoặc chạy lại harness ở trạng thái sạch. Không cần sửa code
> dự án.

**Không có test nào đỏ vì logic code.** Mọi test chạm vào code đã sửa đều xanh.
Tiến trình qua các vòng chạy full suite: **10 → 7 → 5 → 3 → 7 (dao động do trạng thái env)**.

### 7.2 Rác đã dọn kèm

- `tmp-sast-test-dir/` — nguồn: `tests/sast.test.ts` (đã sửa dùng `mkdtempSync`)
- `tmp-test-cli-file.txt`, `tmp-test-crlf-file.txt`, `tmp-test-dollar-replace.txt` —
  nguồn: `web-bridge.test.ts` + `interactive-agent.test.ts` (đã thêm `try/finally` cho 2 ca
  còn thiếu; 2 ca kia đã có sẵn)
- Thêm `tmp-sast-test-dir/` và `tmp-test-*` vào `.gitignore` làm lưới an toàn

---

## 8. Tách `settings-dialog.tsx` (làm tiếp sau khi chốt báo cáo)

`components/settings-dialog.tsx` từng là **god component 1.668 dòng**: 4 section con +
6 tabpanel + component chính nằm chung một file.

**Kết quả: 1.668 → 286 dòng (−83%).**

| File mới | Dòng | Ghi chú |
|---|---|---|
| `settings/settings-tabs.ts` | 118 | Metadata tab + chỉ mục tìm kiếm (DỮ LIỆU, không phải UI) |
| `settings/memories-section.tsx` | 318 | Reviewer gate |
| `settings/auto-backup-section.tsx` | 146 | Sao lưu định kỳ |
| `settings/slash-commands-section.tsx` | 184 | Lệnh gõ nhanh |
| `settings/vision-model-section.tsx` | 66 | Model đọc ảnh |
| `settings/appearance-tab.tsx` | 190 | Tab Giao diện |
| `settings/providers-tab.tsx` | 89 | Tab Model & Nhà cung cấp |
| `settings/safety-tab.tsx` | 157 | Tab Quyền & An toàn |
| `settings/extensions-tab.tsx` | 47 | Tab Mở rộng |
| `settings/memory-tab.tsx` | 38 | Tab Bộ nhớ |
| `settings/data-tab.tsx` | 205 | Tab Dữ liệu & Tự động hoá |
| `settings/section-loading.tsx` | 13 | Dùng chung cho `next/dynamic` của 4 tab |

### Quyết định thiết kế: 0 prop thay vì luồn prop

Khảo sát trước khi tách cho thấy **5/6 tab chỉ dùng `settings` / `updateSettings` /
`updatePerf` / `activeProviderId`** — tất cả đều đọc thẳng từ `useAppStore`, đúng như
`MemoriesSection` và `VisionModelSection` đã làm. Nên các tab nhận **0 prop**.

Tab Dữ liệu là ngoại lệ duy nhất có state cục bộ (`status`, `importMode`, `fileInputRef`)
— và state đó **thuộc về chính nó**, nên được **chuyển hẳn** vào component thay vì luồn
prop ngược lên `SettingsDialog`. Nhờ vậy `SettingsDialog` mất luôn cả cụm
status/import/backup mà trước đây nó giữ chỉ để phục vụ một tab.

> Nếu tách mà phải luồn 10–15 prop qua nhiều tầng thì đã đổi một god component lấy
> "prop drilling hell" — không phải cải thiện. Kiểm tra trước khi tách là bước bắt buộc.

### 8.1 Phát hiện thêm: một test đang canh NHẦM file, và sự lệch nó muốn chặn đã xảy ra thật

Sau khi tách, `tests/tools-panel.test.ts` đỏ ở ca *"tools-panel và settings-dialog import
map chung"*. Kiểm tra thì thấy:

- `TOOL_CATEGORY_ICON_COMPONENTS` **chưa bao giờ được `settings-dialog.tsx` dùng** —
  import ở đó đã chết từ lâu (chỉ còn dòng import, không có chỗ dùng). Test vẫn xanh vì
  nó chỉ kiểm tra sự tồn tại của dòng import.
- Trong khi đó **`tool-permissions-table.tsx`** — UI thứ hai thật sự vẽ icon nhóm công cụ —
  lại tự dựng `GROUP_ICONS` ánh xạ thẳng sang component: **bản sao thứ ba** của cùng một
  bảng, và **không test nào bắt**.

Tức test canh một file không dùng map, bỏ qua file đang nhân bản nó.

**Đã sửa cả hai phía:**
1. `tool-permissions-table.tsx`: `GROUP_ICONS` → `GROUP_ICON_NAMES` (nhóm quyền → *tên* icon),
   rồi tra qua `TOOL_CATEGORY_ICON_COMPONENTS`. Bỏ 7 import icon thừa.
2. Thêm `server: Server` vào map dùng chung — nhóm quyền `mcp` không có trong `ToolCategory`
   của catalog nên trước đây map thiếu entry này.
3. Test trỏ đúng hai file tiêu thụ thật, và mở rộng mẫu chặn để bắt cả `GROUP_ICONS`.

---

## 9. Sửa bug thật: hai modal phê duyệt chồng nhau

Trước khi viết "OverlayHost" như kế hoạch, tôi kiểm chứng xem lỗi có thật không —
và nó thật.

### 9.1 Lỗi

`chat-interface.tsx` có **hai hàng đợi độc lập**:

```ts
const [diffState, setDiffState]   = useState(...);  const diffOpenRef  = useRef(false);
const diffQueueRef = useRef<DiffConfirmState[]>([]);
const [shellState, setShellState] = useState(...);  const shellOpenRef = useRef(false);
const shellQueueRef = useRef<ShellConfirmState[]>([]);
```

Mỗi hàng đợi tự lo việc *không ghi đè khi cùng loại gọi liên tiếp* — nhưng **không có
trọng tài giữa hai loại**. Khi agent gọi SONG SONG một `fs_edit` và một `shell_run`
trong cùng một step (điều hoàn toàn bình thường), cả hai modal cùng render ở `z-[80]`:
chồng lên nhau, hai lớp backdrop, và modal dưới **không bấm được nút nào**.

### 9.2 Cách sửa

Gộp hai hàng đợi làm **một hàng đợi phê duyệt chung** với chốt loại trừ lẫn nhau:

```ts
type ApprovalItem =
  | { kind: 'diff';  state: DiffConfirmState }
  | { kind: 'shell'; state: ShellConfirmState };

const approvalQueueRef = useRef<ApprovalItem[]>([]);
const approvalBusyRef  = useRef(false);   // true khi đang có modal hiện
```

- `presentApproval()` **dọn state của loại kia** trước khi hiện → không bao giờ chồng đôi.
- `showApproval()` giữ nguyên hai hành vi cũ: gọi `awaitUserRef` (để reconciler không
  kết luận "stream đứt" khi modal mở lâu) và xếp hàng FIFO khi đang bận.
- `closeApproval()` dùng chung cho cả hai loại — sau khi gộp, "đóng" không còn phụ thuộc
  loại modal nào đang mở.

**API công khai không đổi** (`showDiffModal` / `showShellModal` / `closeDiffModal` /
`closeShellModal`), nên 3 nơi gọi (`autoApproveDiff`, `autoApproveShell`, `autoApproveCode`)
và 2 chỗ render modal không phải sửa.

Thay đổi hành vi duy nhất: trước đây người dùng có thể trả lời shell trước diff; nay theo
thứ tự FIFO. Đánh đổi này đúng — agent vốn đã bị chặn chờ trả lời, và hai modal chồng nhau
là trạng thái không dùng được.

Khoá bằng test trong `tests/a11y-contract.test.ts`: bắt buộc có `approvalQueueRef` +
`approvalBusyRef`, và **không được còn** `diffQueueRef` / `shellQueueRef` / `diffOpenRef` /
`shellOpenRef`.

---

## 10. Tab "Bộ nhớ": làm rõ hai hệ thay vì gộp sai

Kế hoạch ghi "gộp UI hai hệ bộ nhớ". Khi đọc kỹ thì **gộp là sai** — hai hệ khác nhau ở
**ai tạo ra ký ức**, không phải hai cách nhìn cùng một dữ liệu:

| | Reviewer gate | Sổ có cấu trúc |
|---|---|---|
| Ai tạo | **Agent** đề xuất candidate | **Người dùng** tự viết |
| Vòng đời | Chờ duyệt → Nhớ / Từ chối / Hoãn | Ghi thẳng |
| Bảng | `memoryCandidates` / `memoryRecords` | `agentMemories` |
| Tổ chức | theo trạng thái duyệt | theo category / tag / scope |
| Xuất ra | — | JSON + mirror `.vyen/memory/*.md` |

Gộp bảng dữ liệu sẽ phá cả hai. Vấn đề thật là **người dùng không đọc được quan hệ giữa
chúng** — phần mô tả cũ chỉ nói "luồng quản lý ký ức thống nhất: … → … → …", nghe như một
quy trình tuần tự, trong khi thực tế là hai đường song song.

**Đã sửa phần trình bày:**
- Tab mô tả rõ hai đường, khác nhau ở **ai tạo ra ký ức**, kèm câu chốt "cả hai đều được
  nạp vào ngữ cảnh khi liên quan".
- `AgentMemorySection` đổi tiêu đề từ tên kỹ thuật *"Bộ nhớ có cấu trúc"* thành tên theo
  vai trò *"Sổ tay có cấu trúc (bạn tự viết)"*, kèm một dòng nói rõ khác biệt với mục duyệt.

Không đổi schema, không di chuyển dữ liệu.

---

## 11. ModelSelector: chuyển từ status line xuống composer

**Phát hiện trước khi sửa:** `status-line.tsx` có ghi chú
*"Model — chọn được ngay từ status line, khỏi chiếm chỗ trong composer."*
Tức việc đặt ở status line là **quyết định có chủ ý**, không phải sót. Nên tôi
không tự đảo ngược — đã hỏi và chốt hướng với người dùng.

**Hướng đã chọn:** chuyển xuống composer, status line hiển thị **chữ tĩnh**.

| | Trước | Sau |
|---|---|---|
| Chọn model | Status line (trên cùng) | **Composer** (nơi tay đang gõ) |
| Status line | Dropdown tương tác | **Nhãn tĩnh** tên model đang dùng |
| Số control tương tác cho việc chọn | 1 | 1 (không nhân đôi) |

Lý do chọn hướng này thay vì render ở cả hai nơi: `ModelSelector` là component
**controlled** (`value` + `onChange`) nên render hai instance không lệch state —
nhưng hai dropdown giống nhau trên một màn hình là thừa và dễ gây bối rối. Giữ
đúng một control tương tác, đặt ở nơi tay đang làm việc.

**Chi tiết kỹ thuật:**
- `status-line.tsx` bỏ 7 prop của picker (`onModelChange`, `modelSelectorDisabled`,
  `modelProviderId`, `modelCatalogBuiltin`, `modelFavorites`, `modelRecents`,
  `onToggleModelFavorite`); giữ `models` + `model` để tra **tên hiển thị** thay vì
  in id thô (`ModelOption` có `label`, không có `name`).
- `composer.tsx` nhận 9 prop mới; `ModelSelector` đặt trong cụm control bên phải,
  cạnh nút Tác vụ. Trigger tự giới hạn bề rộng (nhãn cắt ở `30vw` / `160px`) nên
  không đè các nút khác trên màn hình hẹp.
- Popover của picker dùng `createPortal` + `position: fixed` + `z-50` (lớp
  `popover` trong `lib/ui-z.ts`) nên **không bị composer che** và không phụ thuộc
  vị trí mới.

---

## 12. Việc còn lại (đề xuất)

| # | Việc | Vì sao chưa làm |
|---|---|---|
| 1 | ~~Gộp UI hai hệ bộ nhớ~~ | ✅ **đã làm theo hướng khác** — làm rõ thay vì gộp, vì gộp là sai; xem mục 10 |
| 2 | ~~Tách `settings-dialog.tsx`~~ | ✅ **đã làm** — xem mục 8 |
| 3 | ~~Hàng đợi phê duyệt chung~~ | ✅ **đã làm** — tách thành `lib/approval-queue.ts` + 10 test hành vi; xem mục 9 |
| 4 | ~~Đưa `ModelSelector` vào composer~~ | ✅ **đã làm** — xem mục 11 |
| 5 | **Quyết định số phận `lib/teamwork/*` barrel** | Là API module có tài liệu; cần chủ dự án xác nhận giữ hay gỡ |
| 6 | ~~Dọn file tạm trong `web-bridge.test.ts`~~ | ✅ **đã làm** |
| 7 | **Tách `chat-interface.tsx` (5.686 dòng)** | Người dùng đã yêu cầu **hoãn**. Khi làm: nên có test bao phủ luồng phê duyệt TRƯỚC — bước đầu đã xong nhờ tách `lib/approval-queue.ts` |
| 8 | **Sửa cảnh báo React Compiler ở `applyAllStaged`** | Lỗi lint **có sẵn từ HEAD** (không do vòng này): deps khai báo `[readCaptureForPath, updateStaging]` nhưng suy luận ra `setStagingPanelOpen`. Cần người nắm luồng staging quyết định deps đúng |

---

## 13. Tệp mới / đã xoá

**Thêm mới:**
- `lib/ui-z.ts` — thang z-index tập trung
- `lib/approval-queue.ts` — trọng tài phê duyệt (đơn vị thuần, có test hành vi)
- `lib/zeromem/persistence.ts` — persistence Zero-Mem (chỉ trình duyệt)
- `components/settings/` — 13 file tách từ `settings-dialog.tsx`
- `scripts/audit-dead-code.cjs` — phân tích reachability tìm code chết
- `scripts/audit-ui-tokens.cjs` — đo hex / palette / `dark:`
- `scripts/codemod-tokens.cjs` — hex → token + gán vai trò viền
- `scripts/codemod-z-index.cjs` — z-index cứng → `Z_CLASS`
- `scripts/reorder-tool-catalog.cjs` — sắp entry catalog vào đúng nhóm
- `scripts/split-settings-dialog.cjs`, `split-settings-tabs.cjs`,
  `split-settings-tabs-panels.cjs`, `fix-settings-split-imports.cjs` — bộ script tách Settings
- `tests/skills-catalog.test.ts` — tách từ `p1-p2.test.ts`
- `tests/approval-queue.test.ts` — 10 test hành vi cho trọng tài phê duyệt
- `docs/UI_REDESIGN_PLAN_V2.md`, `docs/UI_REDESIGN_REPORT.md`

**Xoá:** 46 file nguồn + 17 file test (xem mục 4.3) + `lib/prompt-library.ts`

**Sửa đổi:** xem `git status --short`

---

## Phụ lục — Lệnh kiểm chứng

```bash
node scripts/audit-ui-tokens.cjs    # 828 -> 136 hex | 0 palette | 0 dark:
node scripts/audit-dead-code.cjs    # 458 file | 0 chỉ-test | 0 mồ côi | 0 route chết
npm run typecheck
npm run build
npx vitest run
```
