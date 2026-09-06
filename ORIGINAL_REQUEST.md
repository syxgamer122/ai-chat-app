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

## 2026-09-06T07:15:20Z

Trích xuất, chuyển thể và tích hợp toàn diện các mẫu kiến trúc, tính năng cao cấp và cơ chế tối ưu hóa vượt trội từ 6 kho mã nguồn tham chiếu (Hatchet, HumanLayer Skills, Utopia, Anthropic Commerce-Agents, Stably Orca, Arcbox) vào nền tảng Vyen (TypeScript / Node.js / Next.js coding harness) nhằm hoàn thiện hệ thống điều phối đa tác tử, an toàn thực thi và quản lý ngữ cảnh mà không gây hồi quy (100% PASS, zero regression).

Working directory: c:/Users/huumanh/Downloads/ai-chat-app
Integrity mode: demo

## Reference Repositories & Extracted Capabilities

1. **Hatchet (`hatchet-dev/hatchet`)** — Workflow Durability & Task Graph:
   - DAG-based task dependency graph resolution (topological ordering, parallel branches).
   - Checkpointing & durable task state (serialize execution state to disk/memory, pause & resume workflows).
   - Exponential retry backoff with randomized jitter (`delay = min(max_delay, base * 2^attempt) ± jitter`).
   - Queue concurrency limits, semaphore slots, and execution timeout/deadline enforcement.

2. **HumanLayer Skills (`humanlayer/skills`)** — Human-in-the-Loop & Modular Skill Lifecycle:
   - Human-in-the-loop approval interrupts (approval gates for sensitive write/exec actions).
   - Standardized control-loop structure: Sensor, Controller, Actuator, Disturbance handling.
   - Visual inspection artifacts (`show-me`: concise diagrams, code-shape sketches, diff visualization).
   - Instruction optimization patterns (`<important if>` blocks) to prevent instruction drift.

3. **Utopia (`deeplethe/utopia`)** — Temporal Context & Knowledge Ledger:
   - Bitemporal context tracking (distinguishing valid time vs. transaction time of changes).
   - Append-only audit ledger (state changes record checkpoints without destructive overwrite; full state replay).
   - Knowledge ontology and derived fact relationships for codebase context awareness.

4. **Anthropic Commerce-Agents (`anthropics/commerce-agents`)** — Strict Contracts & Guardrail Gates:
   - Typed tool contracts: strict schema validation (Zod) separating static system rules from dynamic request context.
   - Provenance-gated writes: resource modifications track originator and validate authorization.
   - Presentation tool calls: separating interactive UI presentation events from execution logic.
   - Dual-gate architecture: pre-flight check before tool execution and post-flight critic review.

5. **Stably Orca (`stablyai/orca`)** — Coding Fleet & Parallel Worktrees:
   - Parallel Git Worktree orchestration: fanning out prompts to parallel agents in isolated worktrees.
   - Fleet manager for tracking agent states, memory usage, and lifecycle across concurrent workers.
   - Context packaging and multi-root codebase context indexing.

6. **Arcbox (`arcboxlabs/arcbox`)** — Process Isolation & Sandboxing:
   - Process sandboxing and environment isolation: scrubbed environment variables, restricted temp directories.
   - Execution deadlines, process lifecycle tracking, and clean resource teardown.
   - Safe disposable workspace snapshots for destructive testing runs.

## Requirements

### R1. Durable DAG Workflow Engine & Checkpointing (Hatchet & Orca)
Nâng cấp tầng điều phối tác vụ hỗ trợ mô hình đồ thị có hướng không chu trình (DAG) cho phép định nghĩa các bước công việc có phụ thuộc lẫn nhau, tự động tính toán nhánh song song độc lập. Trang bị cơ chế tự động thử lại (retry with exponential backoff & jitter) khi gặp lỗi tạm thời và hỗ trợ serialize/deserialize checkpoint tiến trình giúp tạm dừng và khôi phục tác vụ liền mạch.

### R2. Human-in-the-Loop Approval & Visual Inspection (HumanLayer & Commerce-Agents)
Tích hợp cơ chế ngắt và chờ phê duyệt (approval gate / interrupt) trước khi thực thi các hành động nhạy cảm (sửa file cốt lõi, chạy lệnh shell thay đổi hệ thống). Hỗ trợ trực quan hóa các thay đổi và sơ đồ luồng (visual diff / flow sketch) giúp người dùng dễ dàng thẩm định trước khi cấp quyền.

### R3. Strict Tool Contracts, Provenance & Dual-Gate Guardrails (Commerce-Agents & Arcbox)
Chuẩn hóa toàn bộ tool catalog với schema validation nghiêm ngặt; mỗi thao tác ghi dữ liệu (file write/patch) đều được gắn nhãn nguồn gốc (provenance tracking). Triển khai cơ chế 2 cổng kiểm soát (pre-flight validation trước khi gọi tool và post-flight critic review sau khi hoàn thành) kết hợp cô lập môi trường thực thi shell (env var scrubbing, process timeout, cwd lockdown).

### R4. Temporal Context Memory & Bitemporal Codebase Ledger (Utopia & HumanLayer)
Xây dựng module theo dõi lịch sử ngữ cảnh theo dòng thời gian (bitemporal context history) ghi nhận trạng thái codebase trước và sau mỗi milestone theo mô hình append-only, cho phép tác tử tra cứu lại các quyết định kỹ thuật và diff lịch sử mà không làm quá tải token context.

### R5. Full Compatibility, Zero Regression & Comprehensive Test Suite
Toàn bộ tính năng mới phải được phát triển bằng TypeScript thuần chạy tương thích 100% trong môi trường Node.js CLI và Electron Desktop của Vyen (`lib/teamwork/`, `lib/`, `bin/`), đảm bảo 100% các bộ kiểm thử hiện có tiếp tục PASS (128 test files) và đi kèm các unit/integration test suites mới kiểm chứng toàn bộ các năng lực được bổ sung.

## Acceptance Criteria

### Workflow & Task Orchestration
- [ ] Engine giải quyết đúng thứ tự topo cho các DAG tasks với các nhánh phụ thuộc và nhánh độc lập song song.
- [ ] Cơ chế retry với exponential backoff & jitter hoạt động chính xác theo cấu hình số lần thử và độ trễ tối đa.
- [ ] Hỗ trợ lưu trữ checkpoint trạng thái ra file/bộ nhớ và phục hồi (resume) lại chính xác điểm đã dừng.

### Safety, Guardrails & Human Approval
- [ ] Interrupt / approval gate tự động kích hoạt khi gặp thao tác nhạy cảm, chỉ tiếp tục khi có tín hiệu confirm.
- [ ] Tool contract chặn đứng các tham số sai schema hoặc ngoài phạm vi cho phép trước khi tool được thực thi.
- [ ] Process sandbox lọc sạch các biến môi trường nhạy cảm, áp trần thời gian chạy (timeout) và dọn dẹp tiến trình con khi kết thúc.

### Memory & Context Awareness
- [ ] Hệ thống bitemporal ledger lưu trữ các bản ghi thay đổi theo dòng thời gian mà không ghi đè mất mát lịch sử.
- [ ] Tác tử có thể truy vấn nhanh lịch sử thay đổi và lý do đưa ra quyết định của các bước trước đó.

### Verification & Zero Regression
- [ ] Bổ sung các bài test Vitest độc lập bao phủ toàn diện các module mới (DAG, retry, checkpoint, approval gate, tool contract, sandbox, bitemporal context).
- [ ] Toàn bộ test suites hiện có của dự án Vyen (128 files, 1850+ tests) tiếp tục PASS 100%, không phát sinh lỗi hay hồi quy.
- [ ] CLI runner (`bin/teamwork.ts`) và engine API có thể kích hoạt các workflow mới một cách trực tiếp trong môi trường headless.


