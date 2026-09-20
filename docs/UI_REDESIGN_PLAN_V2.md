# Báo cáo chẩn đoán & Kế hoạch tái thiết kế UI — Vyen (vòng 2)

> Ngày lập: 2026-09-20. Trạng thái: **đề xuất, chưa thi công**.
> Mọi khẳng định kèm `file:dòng` để kiểm chứng.
> Phạm vi: thiết kế thị giác, dọn Settings, sửa logic thinking slider, quét code chết.

---

## Phần 0. Vì sao vòng sửa trước "vẫn xấu" — kết luận then chốt

Vòng trước **đã hoàn thành đúng kế hoạch về mặt kỹ thuật**:

| Hạng mục kế hoạch | Trạng thái | Bằng chứng đo được |
|---|---|---|
| GĐ2 — Token hoá Settings | ✅ Xong | `audit-ui-tokens.cjs`: **0** class Tailwind palette, **0** `dark:` trên toàn bộ bề mặt |
| GĐ3 — IA Settings 8 tab → 6 nhóm | ✅ Xong | `settings-dialog.tsx:88` — `'appearance' \| 'providers' \| 'safety' \| 'extensions' \| 'memory' \| 'data'` + search index (`:143-162`) |
| GĐ5 — A11y | ✅ Xong | `lib/hooks/use-focus-trap.ts` (101 dòng), `tests/a11y-contract.test.ts` (72 dòng) |
| GĐ6.1 — Xoá dead code UI | ✅ Một phần | Đã xoá `fanout-board.tsx`, `orchestrator-panel.tsx`, `sweep-heatmap.tsx` |
| GĐ1 — Sửa class hỏng | ✅ Xong | `claude-input`, `no-scrollbar`, `bg-primary` đã hết |

**Nhưng chưa hề có hạng mục nào chạm vào thiết kế thị giác.** Kế hoạch vòng 1 chỉ có
"token hoá" (đổi `bg-zinc-900` → `bg-[#212730]`) — đó là **tuân thủ màu**, không phải
**thiết kế**. Kết quả đo được:

- `settings-dialog.tsx` **tăng** từ 1.671 → **1.846 dòng** (thêm search index vào chính file đó).
- Tổng **828 hex thô** rải trên 5.840 dòng bề mặt Settings. Ví dụ `settings-dialog.tsx`
  có **48** `bg-[#...]`, **60** `border-[#...]`, **131** `text-[#...]` — nhưng **0** lần
  dùng token ngữ nghĩa (`bg-panel-bg`, `border-border-hairline`).

→ Vòng trước đã **dịch màu từ tên gọi sang mã hex**, không tạo ra hệ thống thiết kế.
Vấn đề thị giác vẫn nguyên vẹn. Phần 2 giải thích chính xác tại sao nó trông xấu.

**Một lưu ý vận hành:** toàn bộ thay đổi vòng trước **chưa được commit** (git working tree
đang bẩn, 24 file sửa + 3 file xoá + 4 file mới). Cần commit hoặc stash trước khi bắt đầu
vòng 2 để còn đường lùi.

---

## Phần 1. Chẩn đoán thị giác — 10 nguyên nhân gốc

### 1.1 Luật CSS toàn cục đang triệt tiêu mọi tầng bậc ⚠️ NGHIÊM TRỌNG NHẤT

`app/globals.css:191-197`:

```css
*, *::before, *::after {
  border-radius: 0;
  box-shadow: none !important;
  text-shadow: none !important;
}
```

Ba hệ quả trực tiếp:

1. **`box-shadow: none !important` trên `*`** → không có bóng đổ ở bất kỳ đâu. Không thể
   tạo cảm giác "nổi lên" cho modal, dropdown, popover, card.
2. **`border-radius: 0` trên `*`** → mọi hình chữ nhật là góc vuông cứng.
3. Kết hợp với **một màu viền duy nhất** `#495059` dùng cho *mọi* vai trò (khung panel,
   đường phân cách, viền input, viền nút) → **mọi phần tử có cùng trọng lượng thị giác**.

Đây chính là cảm giác "xấu": khi container, control và divider đều là hình chữ nhật viền
1px cùng màu, mắt không có tầng bậc để bám vào → **một khối bùi nhùi**.

`app/globals.css:205-209` còn vô hiệu hoá `backdrop-filter`:

```css
[class*="backdrop-blur"] { backdrop-filter: none !important; }
```

### 1.2 Chỉ có 3 mức bề mặt, dùng không nhất quán

Bảng token có `--bg-deep #0d1116`, `--bg-canvas #161d27`, `--panel-bg #212730`,
`--panel-soft #252f3d` — nhưng vì không có bóng đổ, sự khác biệt 3–5% độ sáng giữa các
mức **gần như không nhìn thấy** trên màn hình thường. Kết quả: `#0d1116` và `#161d27`
trông giống hệt nhau, nên mọi vùng trông như một mặt phẳng.

### 1.3 Cỡ chữ gốc 18px làm mọi thứ phình to

`app/globals.css:130`:

```css
html { font-size: 18px; }
```

Toàn bộ Tailwind tính theo `rem`, nên mọi kích thước bị đẩy lên **12,5%** so với chuẩn 16px:

| Class | Chuẩn 16px | Thực tế 18px |
|---|---|---|
| `text-xs` | 12px | **13,5px** |
| `text-sm` | 14px | **15,75px** |
| `p-2` | 8px | **9px** |
| `gap-1.5` | 6px | **6,75px** |
| `h-8` | 32px | **36px** |

Hệ quả: bảng cấu hình dày đặc (bảng phân quyền 60+ tool) vừa **phình** vừa **chật** —
vì chữ to mà khoảng cách không co giãn tương ứng.

### 1.4 Nhãn IN HOA + font pixel → khó quét

`app/globals.css:288-295`:

```css
.pixel-label, .pixel-meta {
  font-family: var(--font-pixel), 'Pixelify Sans', 'Minecraft', monospace;
  font-size: 0.84rem;              /* = 15,1px ở base 18px */
  text-transform: uppercase;
  letter-spacing: 0.08em;
  image-rendering: pixelated;
}
```

Chữ IN HOA + giãn chữ + font pixel ở 15px là tổ hợp **tệ nhất cho việc đọc quét** —
mắt phải giải mã từng ký tự thay vì nhận diện hình dạng từ. Dùng cho tiêu đề mục thì
chấp nhận được; dùng cho nhãn trường thì gây mệt mỏi.

### 1.5 Không có lớp token ngữ nghĩa

828 hex thô nghĩa là mỗi chỗ tự chọn màu. Không có gì đảm bảo `#9fa4ab` ở file này bằng
`#9fa4ab` ở file kia, và không có cách nào đổi "màu chữ phụ" trên toàn hệ thống.

### 1.6 Không có nhịp khoảng cách

Rà nhanh `settings-dialog.tsx` thấy các giá trị tuỳ hứng: `p-3`, `px-2.5`, `py-1.5`,
`gap-1.5`, `gap-2`, `mt-0.5`, `mt-1`, `pt-3`, `pb-1.5`, `space-y-2`, `space-y-3`.
Không có thang bậc. Mắt không nhận ra nhóm nào thuộc nhóm nào.

### 1.7 Settings: danh sách phẳng, không có cấu trúc thị giác

`settings-dialog.tsx` dài **1.846 dòng**, chứa 6 section con (`MemoriesSection`,
`VisionModelSection`, `LegacySkillsSection`, `CustomSlashCommandsSection`,
`AutoBackupSection`) + component chính. Trong tab, các mục chỉ được ngăn bằng
đường kẻ 1px — đúng kiểu "danh sách phẳng", không có card, không có tiêu đề nhóm
có trọng lượng, không có icon dẫn đường.

### 1.8 z-index còn sai — Settings nằm DƯỚI các modal

Đo được sau vòng 1:

| Thành phần | z-index | Đánh giá |
|---|---|---|
| `sidebar.tsx:112` (menu ngữ cảnh phiên) | `z-[100]` | ❌ cao hơn cả modal |
| `workspace-checkpoints.tsx:180` | `z-[100]` | |
| `tools-panel.tsx:117`, `recipes-panel.tsx:365` | `z-[90]` | |
| `mcp/tool-approval-dialog.tsx:94` | `z-[85]` | |
| `diff-confirm.tsx:61`, `shell-confirm.tsx:39`, `staging-panel.tsx:63` | `z-[80]` | |
| `toast.tsx:27` | `z-[60]` | ✅ đã sửa |
| **`settings-dialog.tsx:1143`** | **`z-50`** | ❌ **thấp hơn mọi modal** |
| `model-selector.tsx:375`, `chat-export-menu.tsx:89` | `z-50` | |
| `composer.tsx:261`, `thinking-menu.tsx:295` | `z-40` | |

**Lỗi thật:** mở Cài đặt trong khi một modal phê duyệt đang mở → modal vẽ **đè lên**
Cài đặt. Kế hoạch vòng 1 (GĐ4) chưa được thi công: **không có** `OverlayHost`,
không có `useOverlayStore`.

### 1.9 Mâu thuẫn nội tại của DESIGN.md

`DESIGN.md:10` chốt "zero drop-shadow, phẳng tuyệt đối, góc vuông" — đó là *ý đồ nghệ thuật*.
Nhưng khi áp lên một công cụ dày đặc thông tin, nó **triệt tiêu khả năng phân cấp**.
Một công cụ pro (Linear, Vercel, Cursor, Zed) đều dùng **tầng bậc tinh tế**:
viền sáng 1px ở mép trên + nền tối dần + bóng mờ rất nhẹ. Đây là điểm phải sửa.

### 1.10 Kết luận chẩn đoán

Vấn đề **không phải** màu sắc sai, cũng không phải bố cục sai. Vấn đề là **hệ thống
thiết kế chủ động cấm mọi công cụ tạo phân cấp** (bóng, bo góc, tương phản viền).
Cần sửa ở tầng `globals.css` + `tailwind.config.ts` + `DESIGN.md`, không phải sửa
từng component.

---

## Phần 2. Rác còn sót từ dự án web chat cũ

### 2.1 Thư viện prompt chat phổ thông — RÁC RÕ RÀNG

`lib/prompt-library.ts` (189 dòng) seed **5 mẫu prompt của một trợ lý chat đa dụng**,
không liên quan gì tới coding agent:

| Dòng | Tiêu đề |
|---|---|
| `:18` | **Dịch Trung - Việt** |
| `:23` | Giải thích code |
| `:28` | **Sửa lỗi chính tả** |
| `:33` | **Tóm tắt văn bản** |
| `:38` | Viết unit test |

"Dịch Trung - Việt", "Sửa lỗi chính tả", "Tóm tắt văn bản" là di sản của app chat cũ.
Chúng hiển thị trong Settings dưới tên **"Skills cũ (trình duyệt)"**
(`settings-dialog.tsx:1669` → `LegacySkillsSection`, `:562-737`) và trong menu `/` của
composer. Bảng `db.prompts` (9 điểm truy cập) phục vụ riêng việc này.

**Bằng chứng mạnh:** commit `10d4d89` có thông điệp *"gỡ tính năng sinh ảnh/video,
giọng nói, prompt library và orchestrator sweep"* — tức việc gỡ đã được **tuyên bố**
nhưng `prompt-library.ts` **vẫn tồn tại và vẫn hoạt động** vì nó được tái sử dụng
cho "Skills cũ". Đây là rác chưa dọn hết.

### 2.2 Ba hệ thống bộ nhớ song song

| Hệ | Bảng Dexie | Nơi quản lý | Trạng thái |
|---|---|---|---|
| Legacy | `memories` | `lib/db.ts:718-745` (`addMemory`/`deleteMemory`) | Còn helper, UI đã bỏ |
| Reviewer Gate | `memoryCandidates`, `memoryRecords`, `memoryReviews` | `MemoriesSection` (`settings-dialog.tsx:203-505`, 303 dòng) | Đang hiển thị |
| Bộ nhớ có cấu trúc | `agentMemories` | `AgentMemorySection` (`settings-agent-memory.tsx`) | Đang hiển thị |

Tab "Ghi nhớ" hiện render **cả hai** (`settings-dialog.tsx:1692` và `:1695`) → người dùng
thấy hai khái niệm "bộ nhớ" cạnh nhau, không biết cái nào thực sự được nạp vào prompt.

### 2.3 Bảng Dexie chết

| Bảng | Số điểm truy cập ngoài `db.ts` | Kết luận |
|---|---|---|
| `prompts` | 9 | Thuộc rác 2.1 |
| `memories` | 0 (chỉ helper trong `db.ts`) | Chết |
| `memoryCandidates` / `memoryRecords` / `memoryReviews` | 9 / 9 / 2 | Trùng lặp với `agentMemories` |
| **`zeromemTraces`** | **0** | **Chết — không ai ghi** |
| **`zeromemEntities`** | **0** | **Chết** |
| **`zeromemRelations`** | **0** | **Chết** |

### 2.4 Tính năng được quảng cáo nhưng KHÔNG thể truy cập được

Đây là phát hiện nặng nhất về mặt sản phẩm. `README.md:100-115` quảng cáo **Zero-Mem**
với 4 tool (`zeromem_query`, `zeromem_log`, `zeromem_inspect`, `zeromem_stats`).
`README.md:117-142` quảng cáo **Sarsed-Code** với 4 tool (`code_skeleton`, `code_symbols`,
`code_patch`, `code_verify`).

Kiểm chứng: **không tên tool nào trong số đó xuất hiện trong `lib/agent-tools.ts`** —
nơi khai báo toàn bộ tool cho agent của app. Chúng chỉ tồn tại trong
`lib/zeromem/tools.ts` và `lib/sarsed/tools.ts`, và chỉ được `lib/teamwork/tools.ts`
(CLI headless) tham chiếu.

→ Trong app web/desktop, **người dùng không bao giờ gọi được các tool này**. Ba bảng
Dexie `zeromem*` không bao giờ được ghi. Tính năng tồn tại trên giấy.

---

## Phần 3. Thinking slider — vì sao bị "fake với mọi model"

### 3.1 Chuỗi logic hiện tại

```
/v1/models của provider
   → normalizeProviderModels()            lib/provider-url.ts:121
   → parseModelReasoning(item)            lib/reasoning-capability.ts:40
   → ProviderModel.reasoning              lib/provider-url.ts:126
   → activeProvider.models[].reasoning    components/chat-interface.tsx:354
   → thinkingSupportedLevels              components/chat-interface.tsx:5435
   → ThinkingMenu                         components/chat-interface.tsx:5432
   → status-line.tsx:209  {thinkingLevel && onThinkingLevelChange && <ThinkingMenu/>}
```

### 3.2 Lỗi chính xác

`lib/reasoning-capability.ts:57-69` — khi gateway khai `reasoning: {}` (object rỗng,
**rất phổ biến** vì nhiều gateway trả metadata reasoning cho *mọi* model):

```ts
if (Array.isArray(rawEfforts)) { /* ... */ }
// Có object reasoning nhưng KHÔNG khai báo efforts:
return { efforts: [], mandatory };   // ← trả về capability KHÁC null
```

`{ efforts: [], mandatory: false }` là **khác `null`** → `modelReasoningCap` truthy
→ menu **được hiển thị**.

Rồi `components/thinking-menu.tsx:153-154`:

```ts
const isLevelSupported = (key: ThinkingLevel) =>
  !supportedLevels || supportedLevels.length === 0 || supportedLevels.includes(key);
```

`supportedLevels.length === 0` → **cả 4 mức đều "được hỗ trợ"** → menu hiện đủ
Thấp/Trung bình/Cao/Tối đa, chọn được, nhưng thực chất model chỉ bật/tắt suy luận.

**Đó chính xác là "fake với mọi model" mà bạn thấy**: gateway trả `reasoning: {}` cho
mọi model → slider hiện cho mọi model → chọn mức nào cũng như nhau.

Hành vi này **được test khoá lại** ở `tests/reasoning-capability.test.ts:30`
(*"có reasoning nhưng thiếu supported_efforts -> toggle-only"*) — nên **không được sửa
ở tầng parser**; phải sửa ở **tầng UI** (`thinking-menu.tsx` + `status-line.tsx`).

### 3.3 Cách sửa đề xuất

| Trường hợp | Hiện tại | Sau khi sửa |
|---|---|---|
| Không có metadata (`cap === null`) | Ẩn | Ẩn (giữ nguyên) |
| `efforts.length > 0` | Hiện, mờ mức không hỗ trợ | Hiện (giữ nguyên) — đây là trường hợp thật |
| `mandatory === true` | Hiện | Hiện, hiện rõ "model luôn suy luận" |
| **`efforts: []` + `mandatory: false`** | **Hiện đủ 4 mức** ❌ | **Ẩn slider** — không có gì để điều khiển |
| Model nằm ngoài `activeProvider.models` | Ẩn | Ẩn (giữ nguyên) |

Kèm theo: thêm test UI cho ma trận 5 trường hợp trên.

---

## Phần 4. Code chết — kết quả quét

Công cụ: `scripts/audit-dead-code.cjs` (đã viết, phân tích reachability từ entry point thật,
loại trừ API route không client nào gọi).

```
505 file nguồn | 290 tiếp cận từ app/ | 31 chỉ-test | 4 mồ côi | 2 route chết
```

### 4.1 Nhóm A — CHỈ-TEST: tính năng đã gỡ, chỉ còn test canh (31 file)

| Nhóm | File nguồn | Test tương ứng |
|---|---|---|
| **Agent runtime** | `lib/agent-runtime/{condenser,event-stream,observation,security,stuck-detector,trajectory}.ts` + `index.ts` | 6 test `agent-runtime-*.test.ts` |
| **Agent class** | `lib/agent/{agent,loop,persistence-subscriber,types}.ts` + `index.ts` | `agent-class`, `agent-loop`, `persistence-subscriber` |
| **Orchestrator sweep** | `lib/orchestrator/{engine,grid,metrics,plan,prompts,repair}.ts` | 4 test `orchestrator-*.test.ts` |
| **Fanout** | `lib/fanout/{contract,dispatch,retry,scheduler}.ts` | `fanout.test.ts` |
| **Khác** | `lib/ast-search.ts`, `lib/codegraph.ts`, `lib/pollinations.ts`, `lib/project-terms.ts`, `lib/speech-text.ts`, `lib/sse.ts`, `lib/use-tts.ts` | `p1-p2`, `pollinations-searxng`, `speech-text`, `sse` |
| **Barrel** | `lib/teamwork/{index,contracts/index,sandbox/index,mcp-client}.ts` | — |

### 4.2 Nhóm B — MỒ CÔI: không ai import (4 file)

`lib/agent/index.ts`, `lib/agent-runtime/index.ts`, `lib/memory/index.ts`,
`lib/use-orchestrator.ts`

### 4.3 Nhóm C — Route API không client nào gọi (2 file)

`app/api/fanout/dispatch/route.ts`, `app/api/orchestrate/route.ts`

### 4.4 Cần GIỮ (không phải dead code)

- `lib/orchestrator/scheduler.ts` — `runPool` được `lib/subagent.ts:27` và
  `lib/recipes/subrecipe-exec.ts:13` dùng thật.
- `lib/routing/*`, `lib/prompt/protocol.ts`, `lib/skills/*`, `lib/memory/*` (trừ barrel),
  `lib/zeromem/store.ts` + `lib/sarsed/*` — còn được `lib/teamwork/tools.ts` (CLI) dùng.
- `components/chat/orchestrator-badge.tsx` — còn được `chat/message-item.tsx:293` dùng.

### 4.5 Test thừa

**17 file test cần xoá hoàn toàn** (chỉ canh code chết):
`agent-runtime-condenser`, `agent-runtime-event-stream`, `agent-runtime-observation`,
`agent-runtime-security`, `agent-runtime-stuck-detector`, `agent-runtime-trajectory`,
`agent-class`, `agent-loop`, `persistence-subscriber`, `orchestrator-engine`,
`orchestrator-grid`, `orchestrator-metrics`, `orchestrator-repair`, `fanout`,
`pollinations-searxng`, `speech-text`, `sse` (đều `.test.ts`).

**2 file test cần rà và cắt phần chết** (không xoá cả file):
`tests/p1-p2.test.ts` (import `ast-search`, `codegraph`, `fanout`, `project-terms`),
`tests/secret-registry.test.ts` (import `lib/agent/loop`).

Sau khi dọn: **178 → ~161 file test**, không mất độ phủ nào vì phần bị xoá không còn
tương ứng với code sản phẩm.

---

## Phần 5. Kế hoạch thi công

> Thứ tự chọn để **làm rõ thắng lợi sớm** (visual fix thấy được ngay) rồi mới dọn dẹp.
> Mỗi giai đoạn commit riêng.

### Giai đoạn 0 — An toàn & đo baseline

| Bước | Việc |
|---|---|
| 0.1 | Commit (hoặc stash) toàn bộ thay đổi vòng 1 đang treo — tạo điểm lùi sạch |
| 0.2 | Chạy `npm test`, `npm run lint`, `npm run typecheck` — lưu baseline |
| 0.3 | Chạy `node scripts/audit-dead-code.cjs` + `node scripts/audit-ui-tokens.cjs` — lưu số liệu |
| 0.4 | Chụp màn hình 6 tab Settings + vùng chat (before) |

### Giai đoạn 1 — Nền tảng thiết kế (quyết định 90% cảm giác "đẹp")

Đây là giai đoạn quan trọng nhất. Sửa ở 3 file gốc, không sửa từng component.

| Bước | Việc | File |
|---|---|---|
| 1.1 | **Gỡ `box-shadow: none !important` khỏi `*`** — thay bằng thang bóng rất nhẹ (`0 1px 2px rgba(0,0,0,.3)`, `0 8px 24px rgba(0,0,0,.4)`) dùng có chọn lọc cho modal/popover/card | `app/globals.css:191-197` |
| 1.2 | **Nới `border-radius`**: mở lại thang bo góc thật (4/6/8/12px) trong Tailwind; bỏ `border-radius: 0` toàn cục. Giữ góc vuông cho **vùng dữ liệu** (bảng, code block), dùng bo nhẹ cho **control** (nút, input, card) | `app/globals.css:191-197`, `tailwind.config.ts:77-87` |
| 1.3 | **Tách viền theo vai trò**: `--border-hairline` (khung panel), `--border-control` (input/nút), `--border-strong` (hover/focus). Hiện tất cả dùng chung `#495059` | `app/globals.css`, `tailwind.config.ts` |
| 1.4 | **Thêm viền sáng trên đỉnh** cho surface nổi: `box-shadow: inset 0 1px 0 rgba(255,255,255,.05)` — mẹo tạo chiều sâu không cần blur, hợp với tinh thần "phẳng" | `globals.css` |
| 1.5 | **Hạ base font về 16px**, định nghĩa thang chữ thật: 11/12/13/15/17/20/24px. Giữ `18px` chỉ cho thân bài đọc dài (`.claude-prose`) | `app/globals.css:130`, `tailwind.config.ts` |
| 1.6 | **Bỏ IN HOA cho nhãn trường**; chỉ giữ pixel font + IN HOA cho **logo và tiêu đề mục cấp 1** | `globals.css:288-295` |
| 1.7 | **Định nghĩa thang khoảng cách** 4/8/12/16/24/32 và ghi vào `DESIGN.md` như hợp đồng | `DESIGN.md` |
| 1.8 | **Lớp token ngữ nghĩa**: `--surface-0..3`, `--text-1..3`, `--accent`, `--success/warn/danger`. Cho phép dùng token Tailwind (`bg-panel-bg`) — cấm hex thô trong component | `globals.css`, `tailwind.config.ts` |
| 1.9 | Cập nhật `DESIGN.md` — viết lại mục 1 và 4 cho khớp định hướng mới | `DESIGN.md` |

**Tiêu chí nghiệm thu:** mở Settings và vùng chat, mắt phân biệt được ngay 3 tầng
(nền → panel → control) mà không cần đọc chữ.

### Giai đoạn 2 — Sửa z-index & overlay

| Bước | Việc | File |
|---|---|---|
| 2.1 | Tạo `components/overlay-host.tsx` + `lib/overlay-store.ts` — hàng đợi overlay, cấp z theo bảng | mới |
| 2.2 | **Nâng Settings lên `z-[100]`** (hiện `z-50` — dưới cả modal phê duyệt) | `settings-dialog.tsx:1143` |
| 2.3 | **Hạ menu ngữ cảnh sidebar từ `z-[100]` xuống `z-[60]`** | `sidebar.tsx:112` |
| 2.4 | Đưa các modal vào OverlayHost để xếp hàng thay vì chồng | `chat-interface.tsx:5663-5685` |
| 2.5 | Thêm test chặn hồi quy z-index (thang cố định trong một file hằng số) | `tests/a11y-contract.test.ts` |

### Giai đoạn 3 — Dọn Settings

| Bước | Việc |
|---|---|
| 3.1 | **Xoá `LegacySkillsSection`** (`settings-dialog.tsx:562-737`, 176 dòng) + `lib/prompt-library.ts` + `db.prompts` + 5 prompt rác |
| 3.2 | Cập nhật menu `/` trong composer bỏ nhóm prompt cũ, chỉ giữ slash command + recipe |
| 3.3 | **Hợp nhất bộ nhớ**: giữ `agentMemories` làm nguồn duy nhất; chuyển reviewer gate thành luồng "đề xuất → duyệt" trên cùng bảng; bỏ `MemoriesSection` riêng (303 dòng) |
| 3.4 | Xoá bảng Dexie chết: `memories`, `memoryCandidates`, `memoryRecords`, `memoryReviews`, `prompts`, `zeromem*` — bump schema lên v18 với migration xoá bảng |
| 3.5 | **Tách `settings-dialog.tsx` (1.846 dòng)** thành `components/settings/<tab>.tsx` — mỗi tab một file |
| 3.6 | Chuyển từ "danh sách phẳng" sang **card có tiêu đề + mô tả**, mục nâng cao thu gọn mặc định |
| 3.7 | Thêm icon dẫn đường cho từng nhóm; giữ search index nhưng chuyển sang file riêng |

### Giai đoạn 4 — Sửa thinking slider

| Bước | Việc | File |
|---|---|---|
| 4.1 | Ẩn slider khi `efforts.length === 0 && !mandatory` (toggle-only) | `thinking-menu.tsx`, `status-line.tsx:209` |
| 4.2 | Thêm hàm thuần `shouldShowThinkingControl(cap)` để test được | `lib/reasoning-capability.ts` |
| 4.3 | Test ma trận 5 trường hợp (null / rỗng / subset / đủ 4 / mandatory) | `tests/thinking-menu.test.ts` |
| 4.4 | Giữ nguyên hành vi parser (đã có test khoá) — chỉ đổi tầng UI | — |

### Giai đoạn 5 — Dọn code chết

| Bước | Việc |
|---|---|
| 5.1 | Xoá 31 file nhóm A + 4 file nhóm B + 2 route nhóm C |
| 5.2 | Xoá 17 file test thừa; cắt phần chết trong `p1-p2.test.ts`, `secret-registry.test.ts` |
| 5.3 | **Quyết định** về Zero-Mem & Sarsed-Code: hoặc **đăng ký tool** vào `lib/agent-tools.ts` để tính năng thật sự dùng được, hoặc **xoá** và gỡ khỏi README |
| 5.4 | Xoá `lib/teamwork/*` barrel không dùng — **hoặc** giữ và ghi chú là API module |
| 5.5 | Chạy lại `audit-dead-code.cjs` → kỳ vọng 0 mồ côi, 0 chỉ-test |

### Giai đoạn 6 — Chốt & tài liệu

| Bước | Việc |
|---|---|
| 6.1 | Thêm test chặn hồi quy: **cấm hex thô trong component** (mở rộng `design-system.test.ts`) |
| 6.2 | Chạy toàn bộ `npm test` + `lint` + `typecheck` |
| 6.3 | Cập nhật `README.md` — gỡ mô tả tính năng đã xoá, sửa lại phần Zero-Mem/Sarsed |
| 6.4 | Chụp ảnh after, so sánh với baseline GĐ0 |

---

## Phần 6. Tiêu chí hoàn thành

- [ ] Mắt phân biệt được 3 tầng bề mặt mà không cần đọc chữ (nền → panel → control).
- [ ] Base font 16px; thang chữ và thang khoảng cách được định nghĩa trong `DESIGN.md`.
- [ ] Nhãn trường không còn IN HOA; pixel font chỉ dùng cho logo + tiêu đề cấp 1.
- [ ] Không còn `box-shadow: none !important` trên `*`.
- [ ] Mọi component dùng token ngữ nghĩa, không hex thô (test chặn).
- [ ] Settings ở `z-[100]`, không bị modal nào đè.
- [ ] Không còn "Skills cũ" và 5 prompt chat phổ thông.
- [ ] Chỉ còn **một** hệ bộ nhớ hiển thị cho người dùng.
- [ ] Bảng Dexie chết đã xoá, schema bump kèm migration.
- [ ] `settings-dialog.tsx` không còn là god component (>1.800 dòng).
- [ ] Thinking slider **không hiện** với model chỉ khai `reasoning: {}`.
- [ ] `audit-dead-code.cjs` báo 0 mồ côi, 0 chỉ-test, 0 route chết.
- [ ] `npm test` / `lint` / `typecheck` đều PASS.

---

## Phần 7. Quy mô & rủi ro

| Giai đoạn | File đụng tới | Rủi ro | Ghi chú |
|---|---|---|---|
| 0. Baseline | 0 | Rất thấp | Bắt buộc làm trước |
| 1. Nền tảng thiết kế | 4 | **Trung bình-cao** | Chạm CSS toàn cục → mọi màn hình đổi. Cần xem bằng mắt từng màn |
| 2. z-index | 6 | Thấp | Cơ học |
| 3. Dọn Settings | ~12 | Trung bình | Có migration Dexie |
| 4. Thinking | 3 | Thấp | Có test |
| 5. Code chết | ~54 xoá | Thấp | Xoá là an toàn; đã kiểm chứng reachability |
| 6. Chốt | 3 | Rất thấp | |

**Rủi ro lớn nhất** nằm ở Giai đoạn 1: sửa `globals.css` ảnh hưởng tới **mọi** màn hình
cùng lúc. Giảm thiểu bằng cách làm từng bước nhỏ, mỗi bước xem bằng mắt rồi mới sang bước sau.

---

## Phụ lục A. Lệnh kiểm chứng

```bash
node scripts/audit-dead-code.cjs     # 505 file | 31 chỉ-test | 4 mồ côi | 2 route chết
node scripts/audit-ui-tokens.cjs     # 828 hex | 0 palette | 0 dark:
npm test                             # 178 file
npm run lint
npm run typecheck
```

## Phụ lục B. Vị trí gốc cần sửa cho từng vấn đề

| Vấn đề | File:dòng |
|---|---|
| Cấm bóng đổ toàn cục | `app/globals.css:195` |
| Cấm bo góc toàn cục | `app/globals.css:194` |
| Base font 18px | `app/globals.css:130` |
| Nhãn IN HOA | `app/globals.css:288-295` |
| Vô hiệu backdrop-filter | `app/globals.css:205-209` |
| Settings z-50 | `settings-dialog.tsx:1143` |
| Menu sidebar z-[100] | `sidebar.tsx:112` |
| Thinking hiện đủ 4 mức khi toggle-only | `thinking-menu.tsx:153-154` |
| Capability toggle-only khác null | `lib/reasoning-capability.ts:69` |
| Prompt rác web chat | `lib/prompt-library.ts:18,23,28,33,38` |
| LegacySkillsSection | `settings-dialog.tsx:562-737` |
| Hai hệ bộ nhớ cùng tab | `settings-dialog.tsx:1692,1695` |
| God component Settings | `settings-dialog.tsx` (1.846 dòng) |
