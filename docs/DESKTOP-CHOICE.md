# DESKTOP-CHOICE — Quyết định: Tauri + CLI + Web, xóa Electron ở M2

Ngày: 2026-09-03 | Trạng thái: M1 chốt theo ý user. Số liệu chưa đo ghi `đo thật M3`.

## 1. Quyết định
PoC = **Tauri v2 (A) + CLI + Web kiểu OpenCode/Pi (D)**, kèm đường **Edge `--app` `app:fast` (C)** để mở nhanh. **Electron-lite (B) chỉ là fallback, xóa ở M2.**

## 2. Bảng so sánh rút gọn (chi tiết ở teamwork/BENCHMARK.md)

| Ứng viên | Kiến trúc | Installer | RAM | Cold-start | Bảo mật | Auto-update | DX | Phù hợp Vyen |
|----------|-----------|-----------|-----|------------|---------|-------------|----|---------------|
| A. Tauri v2 | Rust + WebView OS + Next | ~2.5MB (nguồn: levminer) | `đo thật M3` (nhẹ hơn Electron; cf. Goose Tauri, Cursor Electron nặng) | `đo thật M3` | Tốt (capability/scope; cf. Goose) | Tauri updater, `đo thật M3` | Tốt (cần Rust) | Cao — vỏ desktop chính |
| B. Electron-lite | Chromium + Node main/preload | ~85MB (nguồn: levminer; cf. Cursor nặng) | `đo thật M3` (kỳ vọng cao nhất) | `đo thật M3` | TB (siết preload) | electron-updater | Quen nhưng nặng | Thấp — xóa ở M2 |
| C. Edge `--app` | Browser sẵn có + Next server | 0MB thêm | `đo thật M3` (~1 tab) | `đo thật M3` (<5s verify M3) | Tốt (không thêm surface) | Không cần | Rất tốt | Cao — đường `app:fast` |
| D. CLI + Web | `bin/vyen.ts cli` + Next; desktop mỏng | Nhỏ (`đo thật M3`; cf. OpenCode CLI+Web+Desktop, Pi terminal-first) | `đo thật M3` (kỳ vọng thấp nhất) | `đo thật M3` | Tốt (CLI rõ quyền) | npm/web deploy | Rất tốt | Rất cao — bản chất Vyen |

## 3. Vì sao thắng
- Nhẹ: 1 số duy nhất được trích (levminer 2.5MB vs 85MB) đã đủ loại Electron khỏi đường chính; RAM/cold-start `đo thật M3` để khẳng định.
- Đúng mô hình học được: Goose chứng minh Tauri đủ cho AI desktop agent; Pi/OpenCode chứng minh CLI-first + Web chia sẻ core, desktop chỉ là client mỏng.
- Thực dụng: C (`app:fast`) cho mở nhanh không toolchain; A cho bản cài gọn; D cho automation/test.

## 4. Kế hoạch M2/M3
- M2: Tauri conf hợp lệ + chuẩn hóa `app:fast`; **xóa Electron** theo chốt. Không giữ song song.
- M3: `npx tsc --noEmit` + `npm run build` + `npm test` PASS; đo RAM/cold-start thật đường nhẹ (<5s `app:fast`) rồi điền số thay mọi ô `đo thật M3`.
