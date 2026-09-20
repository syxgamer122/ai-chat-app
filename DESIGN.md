# DESIGN.md — Vyen Harness × Pixel/Minecraft Identity

> Tài liệu Design System chuẩn cho ứng dụng Chat/Harness: Kế thừa triết lý Dark Slate, 
> viền tóc, góc vuông và sọc active đặc trưng của Vyen Harness, kết hợp hệ font Pixel Minecraft.

---

## 1. Triết lý & Cảm thức chung (Personality)

- **Terminal học giả đêm sâu**: Tối, phẳng tuyệt đối, **không đổ bóng mềm** (zero drop-shadow).
- **Tính chất Raw & Functional**: Hướng đến trải nghiệm của developer / builder. Không glassmorphism, không bo tròn mềm mại kiểu consumer app.
- **Minecraft Pixel Identity**: Đóng vai trò accent-mono và heading. Góc vuông `border-radius: 0` và lưới tọa độ mờ ăn khớp với kết cấu khối (block) của pixel.

### 1.1 Nguyên tắc tạo chiều sâu: BEVEL, không phải bóng đổ

Đây là nguyên tắc quan trọng nhất của hệ thống, và là bài học từ một lần làm sai.

Bóng đổ và bo góc bị cấm, nên nếu mọi khối đều là hình chữ nhật viền 1px **cùng một màu**
thì container, control và đường phân cách có **cùng trọng lượng thị giác** — mắt không có
tầng bậc để bám vào, toàn bộ giao diện thành một khối bùi nhùi. Đó chính là cảm giác "xấu"
dù màu có đúng chuẩn.

Lời giải lấy từ chính GUI Minecraft và Windows 95: **chiều sâu tạo bằng viền hai tông**.

| Tiện ích | Cạnh trên & trái | Cạnh dưới & phải | Dùng cho |
|---|---|---|---|
| `.vyen-bevel` | sáng (`rgba(255,255,255,.09)`) | tối (`rgba(0,0,0,.5)`) | Khối **nổi**: panel, popover, dropdown, nút |
| `.vyen-bevel-inset` | tối | sáng | Khối **chìm**: ô nhập, rãnh, vùng well |
| `.vyen-bevel-soft` | sáng nhẹ | tối nhẹ | Card/khối lớn — đủ gợi ý, không gây ồn |

Bevel dùng `rgba()` chứ không dùng hex để không mở rộng bảng màu.

**Quy tắc vàng:** nếu hai khối nằm cạnh nhau và người xem không phân biệt được khối nào
"nổi" khối nào "chìm", thì khối đó đang thiếu bevel.

---

## 2. Bảng màu chuẩn (Palette Tokens)

### Dark Core (Mặc định)
| Token | Hex | Ứng dụng |
|---|---|---|
| `--bg-deep` | `#0d1116` | Nền khung ngoài cùng, sidebar, vùng tĩnh |
| `--bg-canvas` | `#161d27` | Nền vùng làm việc/chat stream trung tâm |
| `--panel-bg` | `#212730` | Hộp lệnh, khối chat bubble, panel phụ |
| `--panel-soft`| `#252f3d` | Khối tương tác hover, code block |
| `--border-hairline` | `#495059` | Viền KHUNG: bao panel, dialog, phân vùng lớn |
| `--border-control` | `#5d666f` | Viền CONTROL: ô nhập, nút — nổi hơn khung một bậc để tay mắt thấy được chỗ bấm được |
| `--border-hover` | `#757d89` | Viền khi hover / focus / active |
| `--text-primary` | `#ebe7e4` | Moonstone (trắng ngà ấm, không dùng trắng tinh) |
| `--text-muted` | `#9fa4ab` | Metadata, timestamp, nhãn phụ |
| `--accent-steel` | `#6a9fcc` | Màu nhấn chủ đạo: con trỏ, link, viền focus |
| `--accent-thread`| `#4b607c` | Dùng kết hợp trong sọc trạng thái active |

**Ba bậc viền, ba vai trò** — không dùng lẫn:

| Bậc | Giá trị | Vai trò |
|---|---|---|
| `border-subtle` | `#495059` ở alpha 45% | Đường phân cách **trong** một khối (giữa các dòng trong bảng, dưới dải tiêu đề) |
| `border-hairline` | `#495059` | Viền **khung** bao ngoài |
| `border-control` | `#5d666f` | Viền **control** tương tác được |
| `border-hover` | `#757d89` | Trạng thái hover / focus / active |

Lý do tách: trước đây cả bốn vai trò dùng chung `#495059`, khiến mắt không phân biệt
được đâu là khung, đâu là thứ bấm được.


### Màu trạng thái & Code block
- **Success / Warning / Error**: `#5db87a` / `#e8993a` / `#e8704f`
- **Sọc Active chữ ký (Split Indicator)**:
  `linear-gradient(90deg, #6a9fcc 0 62%, #4b607c 62% 100%)` (đặt ở mép trái session/tab đang chọn).
- **Code Block Theme**: One Dark tinh chỉnh (`#1c2128` hoặc `#212730`), cú pháp ưu tiên highlight nhẹ nhàng, không chói.

---

## 3. Typography & Font Hierarchy

- **Base HTML**: **`16px`** (mốc thiết kế của Tailwind), `text-rendering: optimizeLegibility`.
  > Trước đây base là `18px`, khiến MỌI kích thước rem phình 12,5% (`text-xs` = 13,5px,
  > `p-2` = 9px, `h-8` = 36px). Hệ quả: bảng cấu hình dày đặc vừa to vừa chật. Về 16px là
  > mức chuẩn để mật độ thông tin cao mà vẫn đọc thoải mái.
- **Thang chữ chuẩn** — chỉ dùng các mốc sau, không tự chọn số lẻ:

| Vai trò | Size | Class | Ghi chú |
|---|---|---|---|
| Nhãn siêu nhỏ / badge | 11px | `text-[11px]` | Metadata, mã tool |
| Nhãn trường, UI mặc định | 13px | `text-[13px]` / `.field-label` | |
| Chữ UI chính | 14px | `text-sm` | |
| Tiêu đề khối | 15px | `text-[15px]` | `.vyen-block-head` |
| Thân bài đọc dài | 17px | `.claude-prose` | Chỉ dành cho nội dung chat |
| Tiêu đề mục | 16 / 24 / 32px | `.pixel-header-*` | Chia hết cho 8 |

- **Display / App Title / Header**: **Font Pixel Minecraft** (Pixelify Sans / font MC nguyên bản).
  - Quy tắc: size chia hết cho 8 (16px, 24px, 32px), `letter-spacing: +0.05em`, không italic, `image-rendering: pixelated`.
- **Nhãn MỤC (section header)**: `.pixel-label` — pixel font, **IN HOA**, `letter-spacing: 0.06em`, `0.78rem`.
  - **Chỉ dùng cho tiêu đề cấp 1.** Đây là chỗ duy nhất được IN HOA.
- **Nhãn TRƯỜNG (form label)**: `.field-label` — mono, **chữ thường**, không giãn chữ, 13px.
  > **Quy tắc bắt buộc:** không dùng `.pixel-label` cho nhãn trường. IN HOA + giãn chữ +
  > font pixel ở cỡ nhỏ là tổ hợp tệ nhất cho việc đọc quét — mắt phải giải mã từng ký tự
  > thay vì nhận diện hình dạng từ. Đây là lỗi đã từng mắc và đã sửa.
- **Mô tả phụ**: `.field-hint` — 12px, `--text-muted`, `line-height: 1.5`.
- **Input / Terminal Prompt**: Monospace thuần (`JetBrains Mono` hoặc fallback `ui-monospace`).

### 3.1 Thang khoảng cách

Chỉ dùng các mốc: **4 / 8 / 12 / 16 / 24 / 32px** (Tailwind `1 / 2 / 3 / 4 / 6 / 8`).
Không dùng giá trị tuỳ hứng như `2.5`, `3.5`, `1.5` cho khoảng cách giữa các NHÓM —
chỉ dùng trong nội bộ một control.

Quy ước áp dụng:
- Trong một nhóm (label ↔ input): `8px`
- Giữa hai trường trong cùng khối: `12–16px`
- Giữa hai khối: `16px`
- Padding trong khối: `16px` (`px-4 py-3.5`)


---

## 4. Hình khối & Layout (Layout Structure)

- **Góc vuông tuyệt đối (`border-radius: 0`)**: 
  - Toàn bộ Panel, Chat Box, Dialog, Button, Input đều dùng góc vuông `0px`.
  - Ngoại lệ: Pill badge/tag trạng thái nếu cần bo thì dùng hẳn `pill` hoàn toàn, không dùng bo lửng lơ 4px–8px.
- **Viền theo vai trò (thay cho "mọi viền là #495059")**:
  - Khung bao panel/dialog → `border-hairline`
  - Ô nhập, nút → `border-control` (+ bevel ngược cho ô nhập, bevel xuôi cho nút)
  - Đường phân cách trong khối → `border-subtle` (alpha 45%)
  - Hover / focus / active → `border-hover`
  - Không dùng border 2px, trừ outline focus bàn phím (`outline: 2px solid #6a9fccb8`).
- **Khối cài đặt / panel nội dung**: dùng `.settings-card` + `.settings-card-head` + `.settings-card-body`.
  - Dải tiêu đề (`.settings-card-head`) có nền sáng hơn thân một bậc + gạch chân `border-subtle`,
    tạo phân vùng "khung / nội dung" mà không cần bóng.
  - **Không** xếp các mục cài đặt thành danh sách phẳng ngăn bằng đường kẻ 1px — đó là
    nguyên nhân khiến Settings trông như một dải chữ liền mạch.

- **Nền lưới Graph-Paper siêu mờ**:
  - Vân caro mờ ở canvas chính bằng `repeating-linear-gradient` màu xanh sáng alpha cực thấp (1%–4%) tạo cảm giác bản vẽ kỹ thuật / tọa độ.
- **Tree-based Session Sidebar**:
  - Lịch sử trò chuyện tổ chức dạng nhánh cây (Cây tiến trình rẽ nhánh đặc trưng của harness), phân cấp bằng thụt đầu dòng và đường kẻ 1px.
- **Terminal Input Box**:
  - Đặt cố định dưới đáy, có ký tự tiền tố `$` hoặc `>` hiển thị mờ, focus vào là sáng viền accent.

### 4.1 Thang z-index

Mọi overlay lấy số từ `lib/ui-z.ts`, **không tự đặt**. Số càng lớn càng gần người dùng.

| Lớp | z | Dùng cho |
|---|---|---|
| `content` | 0 | Chat, sidebar, status line |
| `dropdown` | 40 | TaskMenu, ThinkingMenu, menu ngữ cảnh phiên |
| `popover` | 50 | ModelSelector, ChatExportMenu |
| `toast` | 60 | ToastHost — trên dropdown, dưới modal |
| `approval` | 80 | Modal PHÊ DUYỆT: DiffConfirm, ShellConfirm, StagingPanel |
| `navigation` | 90 | Panel ĐIỀU HƯỚNG: ToolsPanel, RecipesPanel, WorkspaceCheckpoints |
| `system` | 100 | Hộp thoại HỆ THỐNG: Cài đặt, xác nhận xoá |

**Bất biến:** `approval < navigation < system`. Vi phạm điều này từng gây lỗi thật —
Cài đặt ở `z-50` nằm **dưới** modal phê duyệt, nên mở Cài đặt trong lúc có modal thì
modal vẽ đè lên Cài đặt.


---

## 5. Trạng thái & Vi chuyển động (Micro-interactions)

- **Zero Soft-Shadows**: Loại bỏ hoàn toàn `box-shadow` dạng blur/khói.
- **Độ trễ chuyển động**: Cực ngắn (100ms – 150ms ease-out) cho border-color và background-color.
- **Con trỏ gõ Terminal (Cursor Block)**:
  - Khi AI stream nội dung hoặc tại ô input: Con trỏ hình chữ nhật `█` nhấp nháy (`animation: blink 1s step-end infinite`).

---

## 6. Hợp đồng thiết kế & Token Enforcement (Design System Contract)

Mọi component thuộc bề mặt ứng dụng (Chat, Composer, HUD, Dialogs, Settings, Modals) phải tuân thủ hợp đồng thiết kế kiểm tra tự động bởi test suite (`tests/design-system.test.ts`):

### 6.1 Danh sách file bắt buộc tuân thủ (Tokenized Surfaces)
- **Chat & Composer**: `composer.tsx`, `chat/message-list.tsx`, `chat/message-item.tsx`, `chat/message-usage.tsx`, `chat/status-line.tsx`, `chat/tool-trace.tsx`, `chat/orchestrator-badge.tsx`, `thinking-menu.tsx`, `model-selector.tsx`, `chat-export-menu.tsx`, `sidebar.tsx`, `branch-switcher.tsx`, `message-status-badge.tsx`, `context-meter.tsx`, `backup-reminder.tsx`
- **Overlays & Panels**: `staging-panel.tsx`, `plan-panel.tsx`, `tools-panel.tsx`, `subagent-card.tsx`, `diff-confirm.tsx`, `shell-confirm.tsx`, `recipes/recipes-panel.tsx`, `workspace-checkpoints.tsx`, `hud/agent-hud.tsx`
- **Settings**: `settings-dialog.tsx`, `tool-permissions-table.tsx`, `provider-manager.tsx`, `mcp/mcp-settings-panel.tsx`, `scheduler/scheduler-panel.tsx`, `routing-settings-panel.tsx`, `settings-skills.tsx`, `settings-agent-memory.tsx`, `usage-stats.tsx`
- **Core styles**: `app/globals.css`, `app/layout.tsx`

### 6.2 Quy tắc hợp đồng
1. **Ưu tiên CLASS TOKEN ngữ nghĩa, không dùng hex thô.** Dùng `bg-panel-bg`, `bg-surface-raised`, `text-text-primary`, `text-text-muted`, `border-border-hairline`, `border-border-control`, `border-border-subtle`, `border-accent-steel`, `text-status-error`...
   > Hex thô chỉ được phép khi thật sự không có token tương ứng, và khi đó **bắt buộc** thuộc bảng màu mục 2.
   > Lý do: lần "token hoá" trước chỉ dịch `bg-zinc-900` → `bg-[#212730]` — màu đúng nhưng **không có lớp ngữ nghĩa**, nên không thể đổi hệ thống về sau và mọi viền vẫn cùng một mã.
2. **Cấm tuyệt đối họ màu Tailwind (Zero TW Palette)**: Không dùng `zinc-*`, `sky-*`, `amber-*`, `red-*`, `emerald-*`, `blue-*`...
3. **Loại bỏ hoàn toàn biến thể `dark:`**: Bề mặt luôn chạy Dark Core, không dùng cặp `x dark:y`.
4. **Góc vuông tuyệt đối**: `rounded-none` (0px) trên toàn bộ container, button, dialog, input.
5. **Bevel bắt buộc cho khối nổi / chìm**: panel và control phải phân biệt được bằng mắt.
   Xem `.vyen-bevel`, `.vyen-bevel-inset`, `.vyen-bevel-soft` ở mục 1.1.
6. **Nhãn trường không IN HOA**: dùng `.field-label`. Chỉ tiêu đề mục cấp 1 mới dùng `.pixel-label`.
7. **z-index lấy từ `lib/ui-z.ts`**, không tự đặt số.

### 6.3 Bảng ánh xạ khi migration
| Palette cũ | Token thay thế |
|---|---|
| `bg-white`, `bg-zinc-50`, `bg-zinc-100`, `bg-[#161d27]` | `bg-surface-raised` |
| `bg-zinc-900`, `dark:bg-zinc-900`, `bg-[#212730]` | `bg-panel-bg` |
| `bg-zinc-800`, `bg-[#252f3d]` | `bg-panel-soft` |
| `bg-[#0d1116]` | `bg-bg-deep` |
| `bg-[#1c2128]` | `bg-surface-code` |
| `border-zinc-200/300`, `border-border`, `border-[#495059]` (khung) | `border-border-hairline` |
| `border-[#495059]` (ô nhập, nút) | `border-border-control` |
| `border-t/b/l/r-[#495059]` (đường phân cách) | `border-{t,b,l,r}-border-subtle` |
| `border-[#757d89]` | `border-border-hover` |
| `text-zinc-800/900`, `text-foreground`, `text-[#ebe7e4]` | `text-text-primary` |
| `text-zinc-500/600`, `text-muted-foreground`, `text-[#9fa4ab]` | `text-text-muted` |
| `text-zinc-400` | `text-[#757d89]` (chưa có token riêng — xem ghi chú) |
| `bg-emerald-*`, `text-emerald-*` | `text-status-success` / hex `#5db87a` |
| `bg-amber-*`, `text-amber-*` | `text-status-warning` / hex `#e8993a` |
| `bg-red-*`, `text-red-*` | `text-status-error` / hex `#e8704f` |
| `bg-sky-*`, `text-sky-*`, `bg-blue-*` | `text-accent-steel` / hex `#6a9fcc` |

> **Ghi chú về `#757d89`**: token tương ứng là `--border-hover`, vốn mang nghĩa "viền khi
> hover". Dùng nó cho màu chữ là lệch ngữ nghĩa, nên codemod cố ý **không** map
> `text-[#757d89]` — để nguyên hex vẫn hợp lệ vì thuộc bảng màu.

