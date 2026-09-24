# Kiến Trúc Desktop, Web & CLI — Vyen

> **Đồng bộ với codebase ngày 2026-09-24.** Bản trước của tài liệu này mô tả Electron và lộ trình Tauri:
> trong repo **không còn thư mục `electron/` và không có `src-tauri/`**. Desktop hiện tại là launcher mở
> WebView sẵn có của hệ điều hành (Edge/Chrome `--app`), không nhúng thêm runtime nào.

---

## 1. Ba đường chạy (đều dùng chung một core trong `lib/`)

| Đường | Lệnh | Entry point | Đặc điểm |
|---|---|---|---|
| **Terminal CLI** | `npm run cli` / `npm run vyen` | `bin/vyen.ts` | Không GUI, chạy headless; `npm run teamwork` cho quy trình multi-agent |
| **Fast Desktop** | `npm run app:fast` (= `npm run app` = `npm run desktop`) | `scripts/launch-desktop.cjs` | Cửa sổ app không URL bar, không tab; tái dùng Edge/Chrome/WebView2 có sẵn |
| **Universal Web** | `npm run dev` → mở `http://localhost:3000` | `app/api/bridge` + `lib/bridge/` | Full tool (fs/shell/git/MCP) ngay trên trình duyệt thường |

Ba đường này chia sẻ cùng lớp an toàn (path-guard, auto-pilot, staging, audit log) và cùng
`lib/` logic — không có nhánh code riêng cho từng môi trường.

---

## 2. Vì sao bỏ Electron

- Electron nhúng thêm một bản Chromium đầy đủ (~200MB, 500–800MB RAM) trong khi máy Windows 10/11
  đã có sẵn WebView2/Edge Chromium.
- Launcher Electron cũ tự spawn `next dev` bên trong tiến trình Electron → Turbopack khởi động lạnh
  trên Windows I/O rất chậm, cửa sổ treo ở màn hình loading.
- Quyền năng agent (shell, sửa file, git, MCP) bị nhốt trong preload của Electron (cầu `window.vyen`,
  đã bị xoá cùng thư mục `electron/`), nên mở bằng trình duyệt thường là mất tool.

Lời giải: **không nhúng runtime** — launcher mở cửa sổ app của trình duyệt có sẵn, còn quyền năng
agent đưa xuống `/api/bridge` để mọi trình duyệt dùng được.

---

## 3. Launcher `scripts/launch-desktop.cjs`

### 3.1. Cổng và tái sử dụng server

- Danh sách cổng mặc định: `DEFAULT_PORTS = [3000, 3001, 3002, 3457]`.
- `probe(port)` gọi `GET http://127.0.0.1:<port>/api/server-config` (timeout 2.5s) để nhận diện
  **server Vyen đang chạy**. Nếu có → launcher kết nối thẳng, **không spawn** tiến trình trùng
  (triệt tiêu `EADDRINUSE`).
- Nếu chưa có server → spawn `next dev` (hoặc `next start` khi build sẵn) ở cổng khả dụng đầu tiên.

### 3.2. Tham số dòng lệnh

```bash
node scripts/launch-desktop.cjs [tùy chọn]

--port, -p <number>           Cổng Next.js server (mặc định: autodetect 3000/3001/3002/3457)
--workspace, -w <path>        Thư mục làm việc (workspace root)
--window-size <width,height>  Kích thước cửa sổ (mặc định: 1360,880)
--dev                         Bắt buộc chạy server ở chế độ dev (next dev)
--no-open                     Chỉ khởi động server, không mở cửa sổ browser
--help, -h                    Hiển thị hướng dẫn
```

Biến môi trường launcher đọc: `PORT` (cổng ưu tiên), `VYEN_WORKSPACE_ROOT` (workspace root),
`VYEN_USER_DATA_DIR` (thư mục dữ liệu riêng của bản desktop).

### 3.3. Bridge token

- Mỗi phiên launcher spawn server mới sẽ **sinh một bridge token** và ghi vào `userDataDir`
  (`lib/bridge/bridge-token.ts` là nguồn chân lý; launcher chỉ mirror đường dẫn).
- Server con nhận token qua `VYEN_BRIDGE_TOKEN`; renderer vào app bằng `/#bt=<token>`.
- Server đang chạy từ trước (đường reconnect) thì token phải đọc từ file trong `userDataDir` —
  launcher không tự sinh lại, tránh ghi đè token của phiên đang phục vụ.

---

## 4. Universal Web Bridge

- `lib/bridge/server-bridge.ts` — path-guard, cắt output theo kiểu Goose, git runner, MCP manager;
  đây chính là lớp đã được kiểm chứng qua bộ test và **không phụ thuộc Electron**.
- `lib/bridge/bridge-token.ts` — sinh/kiểm tra/so sánh token (timing-safe).
- `app/api/bridge/route.ts` — endpoint chỉ nhận **request local** (`isLocalRequest`) + token hợp lệ.
  Rate-limit 30 request **sai token**/phút/IP; token đúng không bị chặn (agent gọi bridge dồn dập:
  fs tools, git, vision).
- Phía renderer: `lib/desktop-bridge.ts` chọn đường gọi (bridge HTTP khi mở bằng desktop/trình duyệt,
  IPC khi có shell desktop).
- **Chế độ dev**: khởi động server với biến `VYEN_BRIDGE_TOKEN` rồi mở `/#bt=<token>` — không cần
  chạy launcher.

---

## 5. Trạng thái Tauri

`docs/DESKTOP-CHOICE.md` (2026-09-03) chốt **Tauri v2 cho M2**, nhưng tới nay **chưa triển khai**:
không có `src-tauri/`, không có `tauri.conf.json`, và không có script build Rust trong `package.json`. <!-- docs-check:ignore -->
Đường desktop đang dùng là Edge/Chrome `--app` ở mục 3.

Nếu quay lại Tauri, tài liệu này phải được viết lại kèm số đo thật (RAM, cold-start) — bản cũ đã
ghi các ô `đo thật M3` và tới giờ vẫn chưa có số.
