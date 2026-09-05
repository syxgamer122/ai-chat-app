# DESIGN.md — Pi Harness × Pixel/Minecraft Identity

> Tài liệu Design System chuẩn cho ứng dụng Chat/Harness: Kế thừa triết lý Dark Slate, 
> viền tóc, góc vuông và sọc active đặc trưng của Pi, kết hợp hệ font Pixel Minecraft.

---

## 1. Triết lý & Cảm thức chung (Personality)

- **Terminal học giả đêm sâu**: Tối, phẳng tuyệt đối, không đổ bóng mềm (zero drop-shadow), tận dụng độ tương phản giữa các lớp nền và viền tóc 1px để tạo chiều sâu.
- **Tính chất Raw & Functional**: Hướng đến trải nghiệm của developer / builder. Không glassmorphism, không bo tròn mềm mại kiểu consumer app.
- **Minecraft Pixel Identity**: Đóng vai trò accent-mono và heading. Góc vuông `border-radius: 0` và lưới tọa độ mờ tự nhiên ăn khớp với kết cấu khối (block) của pixel.

---

## 2. Bảng màu chuẩn (Palette Tokens)

### Dark Core (Mặc định)
| Token | Hex | Ứng dụng |
|---|---|---|
| `--bg-deep` | `#0d1116` | Nền khung ngoài cùng, sidebar, vùng tĩnh |
| `--bg-canvas` | `#161d27` | Nền vùng làm việc/chat stream trung tâm |
| `--panel-bg` | `#212730` | Hộp lệnh, khối chat bubble, panel phụ |
| `--panel-soft`| `#252f3d` | Khối tương tác hover, code block |
| `--border-hairline` | `#495059` | Viền chia phân vùng 1px |
| `--border-hover` | `#757d89` | Viền khi hover hoặc active |
| `--text-primary` | `#ebe7e4` | Moonstone (trắng ngà ấm, không dùng trắng tinh) |
| `--text-muted` | `#9fa4ab` | Metadata, timestamp, nhãn phụ |
| `--accent-steel` | `#6a9fcc` | Màu nhấn chủ đạo: con trỏ, link, viền focus |
| `--accent-thread`| `#4b607c` | Dùng kết hợp trong sọc trạng thái active |

### Màu trạng thái & Code block
- **Success / Warning / Error**: `#5db87a` / `#e8993a` / `#e8704f`
- **Sọc Active chữ ký (Pi Split Indicator)**:
  `linear-gradient(90deg, #6a9fcc 0 62%, #4b607c 62% 100%)` (đặt ở mép trái session/tab đang chọn).
- **Code Block Theme**: One Dark tinh chỉnh (`#1c2128` hoặc `#212730`), cú pháp ưu tiên highlight nhẹ nhàng, không chói.

---

## 3. Typography & Font Hierarchy

- **Base HTML**: `18px`, `text-rendering: optimizeLegibility`.
- **Display / App Title / Header**: **Font Pixel Minecraft** (ví dụ: *Pixelify Sans* hoặc font MC nguyên bản).
  - Quy tắc: Size chia hết cho 8 (16px, 24px, 32px), `letter-spacing: +0.05em`, không dùng italic, set `image-rendering: pixelated`.
- **Labels / Meta / Status Indicators**: **Pixel Mono** (Departure Mono hoặc Pixelify Sans size nhỏ).
  - Quy tắc: `0.84rem` (≈14–15px), **UPPERCASE**, letter-spacing `0.08em`.
- **Thân đoạn chat dài (Reading Body)**: Serif biên tập ấm (Lora / Plantin / Source Serif 4) hoặc Mono sạch (JetBrains Mono / Commit Mono) ở size 17–18px để không gây mỏi mắt khi đọc code giải thích dài.
- **Input / Terminal Prompt**: Monospace thuần (`JetBrains Mono`, `Commit Mono` hoặc fallback `ui-monospace`).

---

## 4. Hình khối & Layout (Layout Structure)

- **Góc vuông tuyệt đối (`border-radius: 0`)**: 
  - Toàn bộ Panel, Chat Box, Dialog, Button, Input đều dùng góc vuông `0px`.
  - Ngoại lệ: Pill badge/tag trạng thái nếu cần bo thì dùng hẳn `pill` hoàn toàn, không dùng bo lửng lơ 4px–8px.
- **Hairline Borders**: Mọi đường phân tách và khung bao đều là viền 1px mã `#495059`. Không dùng border 2px trừ outline focus bàn phím (`outline: 2px solid #6a9fccb8`).
- **Nền lưới Graph-Paper siêu mờ**:
  - Vân caro mờ ở canvas chính bằng `repeating-linear-gradient` màu xanh sáng alpha cực thấp (1%–4%) tạo cảm giác bản vẽ kỹ thuật / tọa độ.
- **Tree-based Session Sidebar**:
  - Lịch sử trò chuyện tổ chức dạng nhánh cây (Cây tiến trình rẽ nhánh đặc trưng của harness), phân cấp bằng thụt đầu dòng và đường kẻ 1px.
- **Terminal Input Box**:
  - Đặt cố định dưới đáy, có ký tự tiền tố `$` hoặc `>` hiển thị mờ, focus vào là sáng viền accent.

---

## 5. Trạng thái & Vi chuyển động (Micro-interactions)

- **Zero Soft-Shadows**: Loại bỏ hoàn toàn `box-shadow` dạng blur/khói.
- **Độ trễ chuyển động**: Cực ngắn (100ms – 150ms ease-out) cho border-color và background-color.
- **Con trỏ gõ Terminal (Cursor Block)**:
  - Khi AI stream nội dung hoặc tại ô input: Con trỏ hình chữ nhật `█` nhấp nháy (`animation: blink 1s step-end infinite`).
