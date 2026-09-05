# Original User Request

## 2026-09-03T05:31:15Z

Biến dự án Vyen thành một coding harness toàn diện theo chuẩn OpenCode / Pi / Hermes, tập trung hiện thực hóa Runtime Teamwork Multi-Agent Engine 2-phase (Explorer → Worker → Critic) hỗ trợ chạy cả Dual-mode (Headless CLI và Desktop Electron).

Working directory: c:/Users/huumanh/Downloads/ai-chat-app
Integrity mode: development

## Requirements

### R1. Teamwork Multi-Agent Runtime Engine
Hiện thực hóa hệ sinh thái điều phối đa tác tử (multi-agent orchestration) theo quy trình 2 pha dựa trên đặc tả trong `.opencode/agents/` và `.opencode/commands/teamwork.md`:
- **Phase 1 (Chốt Scope & Kế hoạch)**: Phân tích mục tiêu, xác định phạm vi, tự động tạo bộ ba tài liệu quản lý `teamwork/REQUEST.md`, `teamwork/PLAN.md`, `teamwork/PROGRESS.md` và dừng chờ xác nhận trước khi tác động đến mã nguồn.
- **Phase 2 (Thực thi & Thẩm định)**:
  - Điều phối tuần tự các worker; chỉ cho phép tối đa 2 tác vụ chạy song song khi hoàn toàn độc lập về file.
  - Áp dụng nguyên tắc Exclusive File Ownership (mỗi file nguồn tại một thời điểm chỉ thuộc quyền sở hữu của 1 worker duy nhất).
  - Tích hợp bước Critic kiểm chứng bằng cách chạy lệnh test/build thực tế; milestone chỉ được xem là hoàn thành khi có verdict PASS từ Critic.

### R2. Headless Harness Runner & Dual-Mode Support
Cung cấp khả năng vận hành Agent độc lập từ terminal / CLI mà không bị ràng buộc vào React UI hay IndexedDB của trình duyệt:
- Tách tầng điều phối tác vụ cốt lõi trong `lib/` để có thể kích hoạt trực tiếp từ dòng lệnh (Node.js/TypeScript CLI runner).
- Tái sử dụng trọn vẹn các lớp an toàn hiện có: path-guard, staging sandbox, auto-pilot và xác thực diff.
- Đồng thời tương thích và có thể tích hợp kích hoạt liền mạch từ giao diện Vyen Desktop (Electron).

### R3. Task Lifecycle & Safety Controls
Đảm bảo kiểm soát vòng đời tác vụ tự hành an toàn và bền vững:
- Quản lý rate limit: tự động dừng an toàn khi gặp lỗi 429 hoặc quá tải, ghi nhận trạng thái vào `teamwork/PROGRESS.md` thay vì gửi request dồn dập.
- Tổng kết ngắn gọn (≤20 dòng) kèm liên kết tới `teamwork/PROGRESS.md` và thống kê file thay đổi khi hoàn tất hoặc khi bị chặn.

## Acceptance Criteria

### Multi-Agent Teamwork Verification
- [ ] Quy trình Phase 1 sinh đầy đủ 3 file `teamwork/REQUEST.md`, `teamwork/PLAN.md`, `teamwork/PROGRESS.md` với cấu trúc chuẩn và tạm dừng chờ xác nhận.
- [ ] Hai worker chạm cùng một file không bao giờ được phép thực thi song song (bảo toàn tính toàn vẹn mã nguồn).
- [ ] Bất kỳ milestone nào cũng bắt buộc phải có kết quả chạy test thực tế đạt PASS từ Critic mới được chuyển trạng thái done.
- [ ] Hệ thống tự ngắt và ghi nhật ký an toàn khi gặp lỗi 429/rate-limit.

### Headless Execution & Quality Bar
- [ ] Có thể chạy kiểm thử một workflow teamwork hoàn chỉnh thông qua lệnh dòng lệnh (headless) trong môi trường phát triển.
- [ ] 100% test suites hiện có (83 files, 1082 tests) tiếp tục vượt qua thành công, đồng thời bổ sung các unit test mới bao phủ logic điều phối của Teamwork Engine.

## 2026-09-03T15:27:23Z

This is a single self-contained fix; keep it small and focused.

Sửa lỗi xung đột cổng `EADDRINUSE: address already in use :::3000` trong launcher Desktop (`scripts/launch-desktop.cjs`). Tự động phát hiện cổng bận trước khi spawn và fallback sang cổng khả dụng tiếp theo (3001, 3002, 3457...) hoặc kết nối vào instance Vyen đang chạy, triệt tiêu hoàn toàn lỗi crash launcher.

Working directory: c:\Users\huumanh\Downloads\ai-chat-app
Integrity mode: development

## Requirements

### R1. Tự động kiểm tra và chuyển cổng khi bị chiếm dụng (Port Conflict Fallback)
Trước khi khởi chạy tiến trình Next.js, launcher phải kiểm tra tính khả dụng thực tế của cổng mục tiêu (sử dụng socket probe / `net.createServer` test). Nếu cổng mặc định (3000) đang bị chiếm dụng bởi một tiến trình khác mà không phải Vyen server hợp lệ, launcher phải tự động thử cổng tiếp theo trong danh sách candidate (`[3000, 3001, 3002, 3457]`) hoặc tìm cổng trống ngẫu nhiên thay vì để Next.js crash với `EADDRINUSE`.

### R2. Cơ chế Probe thông minh & Tái sử dụng Server sẵn có
Nâng cấp hàm `probe()` để nếu trên cổng hiện tại đã có sẵn một server Vyen Next.js đang chạy (kể cả chế độ `dev` hay `start`), launcher sẽ kết nối thẳng vào server đó mà không cố khởi động một server trùng lặp gây xung đột tài nguyên.

## Acceptance Criteria

### Port Collision Resilience
- [ ] Khi cổng 3000 bị một tiến trình khác chiếm dụng, chạy `node scripts/launch-desktop.cjs --no-open` hoặc `npm run desktop` không bị crash với lỗi `EADDRINUSE`.
- [ ] Launcher tự động chuyển sang cổng khả dụng tiếp theo (ví dụ: 3001) và khởi động Next.js thành công.
- [ ] Nếu cổng 3000 đã có sẵn server Vyen hoạt động, launcher nhận diện chính xác và mở giao diện kết nối vào server đó mà không spawn tiến trình thừa.
- [ ] Bộ test `tests/launch-desktop.test.ts` bổ sung kịch bản giả lập cổng 3000 bị chiếm dụng và xác nhận 100% tests PASS.

