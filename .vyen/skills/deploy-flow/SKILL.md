---
name: deploy-flow
description: Quy trình release production của Vyen — test, bump version, tag, push, rồi kiểm tra deploy.
version: 1.0.0
allowed_tools:
  - shell_run
  - git_status
  - git_diff
  - git_add
  - git_commit
---

# Deploy flow

Quy trình release production, làm ĐÚNG thứ tự. Không bỏ bước nào.

## 1. Tiền kiểm
- Chạy `npm test` — phải xanh 100%. Đỏ thì DỪNG, sửa trước.
- Chạy `npm run build` — phải pass.
- `git status` phải sạch; còn thay đổi dở thì hỏi người dùng trước.

## 2. Version
- Bump version trong `package.json` theo semver: fix → patch, feature → minor,
  breaking → major.
- Cập nhật mục CHANGELOG nếu repo có.

## 3. Commit + tag
- Commit message theo Conventional Commits (`feat:`, `fix:`, `chore:`...).
- Tạo tag `v<version>` khớp package.json.

## 4. Push
- Push nhánh + tag. **Luôn hỏi người dùng trước khi push** — đây là thao tác
  ra ngoài, không tự ý.

## 5. Hậu kiểm
- Theo dõi deploy (Vercel/CI). Lỗi build phía CI thì đọc log, sửa, lặp lại.

## Lỗi thường gặp
- Tag đã tồn tại → `git tag -d` rồi tạo lại, đừng force push tag cũ.
- CI fail vì env thiếu → dừng lại, báo người dùng bổ sung env, không hard-code
  secret vào repo.
