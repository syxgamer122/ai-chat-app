# TÀI LIỆU THIẾT KẾ KIẾN TRÚC MÃ NGUỒN UI & FRONTEND (TSX) — DỰ ÁN VYEN
> **Phiên bản**: v2.1 (Đồng bộ hóa sau khi hoàn thành Gói vá bảo mật & toàn vẹn dữ liệu P0)  
> **Cập nhật lúc**: 2026-09-20  
> **Mục đích tài liệu**: Cung cấp bản đặc tả kỹ thuật toàn diện, tuyệt đối chính xác về thiết kế mã nguồn, cấu trúc Component, luồng dữ liệu (Data Flow), cơ chế quản lý trạng thái (State Management), cơ chế an toàn duyệt mã (Human-in-the-Loop & Guardrails) của toàn bộ **58 file `.tsx`** (tổng cộng **18,876 dòng code**) trong dự án Vyen. Tài liệu này được thiết kế chuyên biệt để các hệ thống AI (Claude, GPT, Gemini...) phân tích, phản biện kiến trúc và đánh giá chất lượng kỹ thuật mà không cần truy cập trực tiếp vào hệ thống file.

---

## MỤC LỤC
1. [Tổng Quan Kiến Trúc Hệ Thống (Architectural Overview)](#1-tổng-quan-kiến-trúc-hệ-thống)
2. [Sơ Đồ Phân Cấp Component & Luồng Dữ Liệu (Hierarchy & Data Flow)](#2-sơ-đồ-phân-cấp-component--luồng-dữ-liệu)
3. [Bảng Chỉ Mục Toàn Bộ 58 File TSX Theo Module](#3-bảng-chỉ-mục-toàn-bộ-58-file-tsx-theo-module)
4. [Đặc Tả Chi Tiết Từng File TSX (58/58 Files)](#4-đặc-tả-chi-tiết-từng-file-tsx)
   - [Module 1: Next.js App Router Root Layer (2 files)](#module-1-nextjs-app-router-root-layer)
   - [Module 2: Core Orchestration & Chat Controller (5 files)](#module-2-core-orchestration--chat-controller)
   - [Module 3: Virtualized Message Tree & Presentation (9 files)](#module-3-virtualized-message-tree--presentation)
   - [Module 4: Rich Content, Markdown & Code Rendering (3 files)](#module-4-rich-content-markdown--code-rendering)
   - [Module 5: Human-in-the-Loop, Guardrails & Sandboxing (6 files)](#module-5-human-in-the-loop-guardrails--sandboxing)
   - [Module 6: Autonomous Agent Panels & Workflows (7 files)](#module-6-autonomous-agent-panels--workflows)
   - [Module 7: Unified Settings System — 6 Domains (17 files)](#module-7-unified-settings-system--6-domains)
   - [Module 8: System Infrastructure, Feedback & Utilities (9 files)](#module-8-system-infrastructure-feedback--utilities)
5. [Đối Soát Phản Biện Chuyên Sâu Của Principal Architect & Ma Trận Kiểm Chứng Thực Tế](#5-đối-soát-phản-biện-chuyên-sâu-của-principal-architect--ma-trận-kiểm-chứng-thực-tế)
6. [Hiện Trạng Thực Thi & Lộ Trình Tái Cấu Trúc (Status & Roadmap)](#6-hiện-trạng-thực-thi--lộ-trình-tái-cấu-trúc-status--roadmap)

---

## 1. TỔNG QUAN KIẾN TRÚC HỆ THỐNG

### 1.1. Bản chất Dự án Vyen
Vyen là một **High-Assurance Coding Agent Harness** kiêm **Local-First AI Chat System** chạy song song ở hai môi trường:
1. **Web Browser (Chromium/Firefox/Safari)**: Sử dụng File System Access API để kết nối trực tiếp thư mục mã nguồn máy khách mà không qua server backend.
2. **Desktop Shell & CLI**: Chạy Next.js local kết hợp Chromium `--app` mode và bridge IPC cục bộ để gọi terminal shell, git và giao thức Model Context Protocol (MCP).

### 1.2. Các Nguyên Lý Kiến Trúc Cốt Lõi
1. **Local-First & Zero-Server Persistence**:
   - Dữ liệu lịch sử chat, các nhánh hội thoại, file đính kèm blob, cấu hình MCP, permissions, recipes đều được lưu trữ trực tiếp trên trình duyệt bằng **Dexie.js (IndexedDB)** trải qua 18 migration phiên bản.
   - Gọi `navigator.storage.persist()` khi ứng dụng khởi chạy ở client để bảo vệ dữ liệu chống browser eviction.
   - Server Node.js Next.js chỉ đóng vai trò Gateway proxy gọi LLM upstream, stream tokens, giải mã PDF/Web scraping, và cầu nối bridge Desktop.
2. **Non-Linear Branching Message Tree (Cây hội thoại phân nhánh)**:
   - Mỗi tin nhắn là một node độc lập trỏ về `parentId` (root mang `parentId = '__ROOT__'`).
   - Khái niệm "Cuộc trò chuyện" thực chất là đường đi từ gốc (root) đến một nút lá tích cực (`activeLeafId`). Khi người dùng chỉnh sửa (edit) hoặc tạo lại (regenerate) câu trả lời cũ, hệ thống tạo nhánh mới mà không làm mất nhánh cũ.
3. **Strict Client-Side Tool Execution Loop (Vòng lặp công cụ phía Client)**:
   - LLM phát sinh tool call (`fs_read`, `fs_edit`, `fs_write`, `code_patch`, `shell_run`, `git_*`, `mcp__*`).
   - Phía Client chặn và kiểm tra phân quyền (Auto / Smart / Manual / Deny). Nếu là thao tác ghi file, hệ thống bắt buộc kiểm tra mã băm SHA-256 cơ sở (`baseFileHash`) chống TOCTOU và mở **Diff Confirm Modal** hoặc lưu vào **Staging Buffer**. Nếu là shell, kiểm tra metacharacters và mở **Shell Confirm Modal**.
   - Sau khi thực thi trên đĩa của máy khách, kết quả tool output được client tự động gửi ngược lại stream LLM (`auto-resubmit`) để model tiếp tục suy luận.
4. **Dual-Gate Guardrails & Staging Sandbox**:
   - Ghi file vào vùng đệm ảo (Staging Overlay) trước khi ghi đĩa thật.
   - Bất kỳ thao tác ghi nào vào file nhạy cảm (`.git/**`, `.vscode/**`, `package.json`, `.env*`, `.vyen/**`) đều bị cưỡng chế hỏi (`ask`), kể cả trong chế độ Autonomous.
   - Chặn đứng các câu lệnh shell nguy hiểm và chuỗi nối lệnh (`&&`, `||`, `;`, `|`, `$()`, `>`, `<`) ở tầng phân tích cú pháp.
5. **Zero-Mem & SARS Architecture Integration**:
   - Zero-Token Memory: Trích xuất quan hệ đồ thị mã nguồn không tốn token LLM, inject minh chứng `<zero-mem-evidence>`.
   - SARS (Sense - Analyze - Refactor - Synthesize): Vòng lặp tự kiểm tra code bằng compiler diagnostics sau mỗi lần chỉnh sửa.

---

## 2. SƠ ĐỒ PHÂN CẤP COMPONENT & LUỒNG DỮ LIỆU

### 2.1. Component Hierarchy (Cây Component)
```
RootLayout (app/layout.tsx)
 └── PWARegister (components/pwa-register.tsx)
 └── Home (app/page.tsx) [storage.persist() bootstrap]
      ├── Sidebar (components/sidebar.tsx)
      │    ├── VyenLogo (components/vyen-logo.tsx)
      │    ├── BackupReminder (components/backup-reminder.tsx)
      │    └── ChatItem (memoized)
      │         ├── Highlight (components/highlight.tsx)
      │         └── Context Menu (Export, Pin, Rename, Delete)
      │
      ├── ChatErrorBoundary (components/chat-error-boundary.tsx)
      │    └── ChatInterface (components/chat-interface.tsx) [CORE ORCHESTRATOR - 32.2% TSX codebase]
      │         ├── AgentHud (components/hud/agent-hud.tsx)
      │         ├── StatusLine (components/chat/status-line.tsx)
      │         │    └── ContextMeter (components/context-meter.tsx)
      │         │
      │         ├── WorkspaceCheckpointBar (components/workspace-checkpoints.tsx)
      │         ├── PlanPanel (components/plan-panel.tsx)
      │         │
      │         ├── MessageList (components/chat/message-list.tsx) [TanStack Virtual]
      │         │    ├── ThinkingIndicator
      │         │    └── MessageItem (components/chat/message-item.tsx)
      │         │         ├── ThinkingBlock (collapsible)
      │         │         ├── BranchSwitcher (components/branch-switcher.tsx)
      │         │         ├── MarkdownRenderer (components/markdown-renderer.tsx)
      │         │         │    ├── SyntaxHighlightGate -> SyntaxHighlight (components/syntax-highlight.tsx)
      │         │         │    └── PlainCode
      │         │         ├── ToolTrace (components/chat/tool-trace.tsx)
      │         │         ├── SubagentCard (components/subagent-card.tsx)
      │         │         ├── OrchestratorBadge (components/chat/orchestrator-badge.tsx)
      │         │         ├── EvidenceBadge (components/evidence-badge.tsx)
      │         │         ├── MessageStatusBadge (components/message-status-badge.tsx)
      │         │         └── MessageUsage (components/chat/message-usage.tsx)
      │         │
      │         ├── Composer (components/composer.tsx) [IME composition 3-layer guard]
      │         │    ├── ModelSelector (components/model-selector.tsx)
      │         │    │    └── ThinkingMenu (components/thinking-menu.tsx)
      │         │    ├── TaskMenu (Tác vụ: Plan, Goal, Staging, Tools, Recipes...)
      │         │    └── Slash Commands Autocomplete Popup
      │         │
      │         ├── [MODALS & SLIDE-OVER PANELS]
      │         │    ├── DiffConfirm (components/diff-confirm.tsx) [SHA-256 verified]
      │         │    ├── ShellConfirm (components/shell-confirm.tsx) [CWD jailed]
      │         │    ├── StagingPanel (components/staging-panel.tsx) [TOCTOU base hash check]
      │         │    ├── ToolsPanel (components/tools-panel.tsx)
      │         │    ├── RecipesPanel (components/recipes/recipes-panel.tsx)
      │         │    ├── McpToolApprovalDialog (components/mcp/tool-approval-dialog.tsx)
      │         │    └── ChatExportMenu (components/chat-export-menu.tsx)
      │         │
      │         └── ToastHost (components/toast.tsx)
      │
      └── SettingsDialog (dynamic import) (components/settings-dialog.tsx)
           ├── AppearanceTab (components/settings/appearance-tab.tsx)
           ├── ProvidersTab (components/settings/providers-tab.tsx)
           │    ├── ProviderManager (components/provider-manager.tsx)
           │    ├── VisionModelSection (components/settings/vision-model-section.tsx)
           │    └── RoutingSettingsPanel (components/routing-settings-panel.tsx)
           ├── SafetyTab (components/settings/safety-tab.tsx)
           │    └── ToolPermissionsTable (components/tool-permissions-table.tsx)
           ├── ExtensionsTab (components/settings/extensions-tab.tsx)
           │    ├── McpSettingsPanel (components/mcp/mcp-settings-panel.tsx)
           │    ├── DiskSkillsSection (components/settings-skills.tsx)
           │    └── CustomSlashCommandsSection (components/settings/slash-commands-section.tsx)
           ├── MemoryTab (components/settings/memory-tab.tsx)
           │    ├── MemoriesSection (components/settings/memories-section.tsx)
           │    └── AgentMemorySection (components/settings-agent-memory.tsx)
           └── DataTab (components/settings/data-tab.tsx)
                ├── AutoBackupSection (components/settings/auto-backup-section.tsx)
                ├── SchedulerPanel (components/scheduler/scheduler-panel.tsx)
                └── UsageStats (components/usage-stats.tsx)
```

---

## 3. BẢNG CHỈ MỤC TOÀN BỘ 58 FILE TSX THEO MODULE

*(Toàn bộ 58 file TSX phân bố chuẩn xác, tổng cộng **18,876 dòng code** sau khi triển khai các chốt chặn an toàn)*

| # | Module | Đường Dẫn File | Số Dòng | Vai Trò Chính |
|---|---|---|---|---|
| 1 | **M1: Root** | `app/layout.tsx` | 71 | Root HTML, fonts, Dark-theme script chống FOUC, PWA registration |
| 2 | | `app/page.tsx` | 161 | Main page layout, phím tắt toàn cục, dynamic import Settings, `storage.persist()` |
| 3 | **M2: Core Harness** | `components/chat-interface.tsx` | 6,082 | Đầu não điều phối: stream, tool runtime, TOCTOU guard, CWD jail, abort queue (32.22%) |
| 4 | | `components/sidebar.tsx` | 609 | Quản lý phiên chat, tìm kiếm fulltext tiếng Việt, workspace link |
| 5 | | `components/composer.tsx` | 994 | Ô nhập đa năng, voice STT, slash commands, 3-layer IME composition guard |
| 6 | | `components/context-meter.tsx` | 94 | Thước đo ngữ cảnh token, tính toán riêng cho active thread |
| 7 | | `components/model-selector.tsx` | 457 | Dropdown chọn model phân nhóm theo nhà cung cấp & khả năng |
| 8 | **M3: Message Tree** | `components/chat/message-list.tsx` | 468 | Danh sách tin nhắn ảo hóa TanStack Virtual, auto-scroll pin |
| 9 | | `components/chat/message-item.tsx` | 425 | Hàng tin nhắn đơn lẻ, thinking block, inline edit, actions |
| 10 | | `components/branch-switcher.tsx` | 74 | Nút chuyển đổi qua lại giữa các nhánh anh em (`< 1/3 >`) |
| 11 | | `components/chat/tool-trace.tsx` | 297 | Hiển thị chi tiết gọi tool (args, execution state, output fold) |
| 12 | | `components/chat/status-line.tsx` | 264 | Thanh trạng thái hoạt động: model, hints, tokens, telemetry |
| 13 | | `components/chat/message-usage.tsx` | 43 | Huy hiệu hiển thị token tiêu thụ và độ trễ response |
| 14 | | `components/chat/orchestrator-badge.tsx` | 151 | Huy hiệu phân biệt tin nhắn sinh ra từ Orchestrator Sweep |
| 15 | | `components/message-status-badge.tsx` | 39 | Badge trạng thái tin nhắn (sending, delivered, error, aborted) |
| 16 | | `components/evidence-badge.tsx` | 50 | Huy hiệu minh chứng bậc thang (Zero-Mem Evidence Level) |
| 17 | **M4: Rich Content** | `components/markdown-renderer.tsx` | 438 | Bộ dựng Markdown chuẩn GFM, KaTeX math, dynamic syntax gate |
| 18 | | `components/syntax-highlight.tsx` | 77 | Tô màu code Prism 18 ngôn ngữ, nạp lười giảm bundle |
| 19 | | `components/highlight.tsx` | 28 | Highlight từ khóa tìm kiếm tiếng Việt không dấu |
| 20 | **M5: Human-In-The-Loop** | `components/diff-confirm.tsx` | 140 | Modal duyệt diff dòng (unified diff) trước khi ghi đĩa |
| 21 | | `components/shell-confirm.tsx` | 104 | Modal duyệt chạy lệnh terminal shell, cảnh báo lệnh phá hủy |
| 22 | | `components/staging-panel.tsx` | 182 | Vùng đệm sandbox xem trước batch sửa đổi trước khi Apply |
| 23 | | `components/workspace-checkpoints.tsx` | 296 | Quản lý snapshot workspace, rollback thay đổi của agent |
| 24 | | `components/mcp/tool-approval-dialog.tsx` | 170 | Hộp thoại phê duyệt 4 cấp cho MCP tool qua Desktop IPC |
| 25 | | `components/tool-permissions-table.tsx` | 324 | Bảng ma trận phân quyền per-tool độc lập 8 nhóm |
| 26 | **M6: Agent Workflows** | `components/hud/agent-hud.tsx` | 129 | Head-Up Display hiển thị telemetry realtime của các agent lane |
| 27 | | `components/plan-panel.tsx` | 210 | Checklist kế hoạch hành động phân rã task, nút "Duyệt & Thực thi" |
| 28 | | `components/recipes/recipes-panel.tsx` | 584 | Quản lý và thực thi Recipes YAML, form tham số, retry logic |
| 29 | | `components/scheduler/scheduler-panel.tsx` | 504 | Quản lý lịch chạy cron tự động, trigger headless session |
| 30 | | `components/subagent-card.tsx` | 132 | Card hiển thị tiến độ và kết quả subagent chạy song song |
| 31 | | `components/tools-panel.tsx` | 257 | Catalog công cụ, tìm kiếm BM25 và nạp tool MCP động |
| 32 | | `components/thinking-menu.tsx` | 365 | Menu điều khiển độ sâu suy luận (Thinking effort: low/med/high/max) |
| 33 | **M7: Settings (6 Domains)** | `components/settings-dialog.tsx` | 287 | Dialog trung tâm Cài đặt, chuẩn APG accessible tabs, quick search |
| 34 | | `components/settings/appearance-tab.tsx` | 190 | Cấu hình theme, system prompt, temperature, throttling |
| 35 | | `components/settings/providers-tab.tsx` | 89 | Cấu hình BYOK keys, safeStorage, endpoints nhà cung cấp |
| 36 | | `components/settings/safety-tab.tsx` | 157 | 4 Chế độ an toàn (Manual/Smart/Auto/ChatOnly), Staging toggle |
| 37 | | `components/settings/extensions-tab.tsx` | 47 | Cấu hình mở rộng MCP, Skills thư mục, Slash Commands |
| 38 | | `components/mcp/mcp-settings-panel.tsx` | 579 | Quản lý máy chủ MCP trong Desktop: kết nối stdio/SSE/HTTP, expose mode |
| 39 | | `components/settings/memory-tab.tsx` | 62 | Quản lý ký ức 3 giai đoạn (Reviewer gate, Approved, Zero-Mem) |
| 40 | | `components/settings/data-tab.tsx` | 205 | Backup/Restore JSON & MD, định kỳ tự động, thống kê token |
| 41 | | `components/settings/auto-backup-section.tsx` | 147 | Cấu hình tự động sao lưu ngầm qua File System Access API |
| 42 | | `components/settings/memories-section.tsx` | 319 | Danh sách ký ức dài hạn theo category, tags và xóa/sửa |
| 43 | | `components/settings/slash-commands-section.tsx` | 185 | Quản lý danh sách lệnh gõ tắt `/` tùy biến |
| 44 | | `components/settings/vision-model-section.tsx` | 67 | Chọn model thị giác phân tích ảnh cho workspace và MCP |
| 45 | | `components/settings/section-loading.tsx` | 17 | Skeleton placeholder hiển thị khi tab đang nạp |
| 46 | | `components/settings-agent-memory.tsx` | 256 | Panel quản lý bộ nhớ agent cấu trúc chuyên sâu |
| 47 | | `components/settings-skills.tsx` | 178 | Trình quản lý kỹ năng dạng file `.vyen/skills/` |
| 48 | | `components/provider-manager.tsx` | 517 | Quản trị đa nhà cung cấp, kiểm tra API key health, endpoint mẫu |
| 49 | | `components/routing-settings-panel.tsx` | 437 | Cấu hình phân luồng mô hình Lead/Worker và chuỗi dự phòng |
| 50 | **M8: Infrastructure & UI**| `components/error-boundary.tsx` | 61 | Generic React Error Boundary bắt crash component cây con |
| 51 | | `components/chat-error-boundary.tsx` | 85 | Error Boundary chuyên biệt cho khung chat, phục hồi draft input |
| 52 | | `components/toast.tsx` | 55 | Hệ thống thông báo nổi (Success, Error, Warning, Info) |
| 53 | | `components/chat-export-menu.tsx` | 155 | Menu xuất hội thoại sang JSON (cả cây) hoặc Markdown (nhánh) |
| 54 | | `components/backup-reminder.tsx` | 94 | Banner nhắc nhở sao lưu dữ liệu phòng ngừa mất dữ liệu browser |
| 55 | | `components/usage-stats.tsx` | 154 | Thống kê tổng số token đã dùng và ước tính chi phí USD |
| 56 | | `components/vyen-logo.tsx` | 102 | SVG branding logo Vyen và Pi Mark tương thích dark mode |
| 57 | | `components/pwa-register.tsx` | 30 | Đăng ký Service Worker và thông báo cập nhật ứng dụng PWA |
| 58 | | `components/effects/index.tsx` | 182 | Hiệu ứng rung phản hồi (Haptics), SiriWave, TextShimmer |

---

## 4. ĐẶC TẢ CHI TIẾT TỪNG FILE TSX (58/58 FILES)

### MODULE 1: NEXT.JS APP ROUTER ROOT LAYER

#### 1. `app/layout.tsx` (71 dòng)
- **Đường dẫn**: `app/layout.tsx`
- **Vai trò**: Điểm nhập gốc (Root Layout) của Next.js 16 App Router. Khởi tạo thẻ `<html>`, nạp Google Fonts, thiết lập Dark Mode bất biến và đăng ký PWA Service Worker.
- **Logic & Thiết kế**:
  - `THEME_NO_FLASH_SCRIPT`: Đoạn script inline thực thi đồng bộ trước First Contentful Paint: `(document.documentElement.classList.add('dark'))` loại bỏ triệt để chớp trắng (FOUC).
  - Cấu hình viewport `interactiveWidget: 'resizes-content'` giúp bàn phím di động thu nhỏ viewport thay vì che khuất ô nhập.

#### 2. `app/page.tsx` (161 dòng)
- **Đường dẫn**: `app/page.tsx`
- **Vai trò**: Trang chủ ứng dụng (`Home`), điều phối layout 2 cột (Sidebar và ChatInterface), lắng nghe phím tắt toàn cục, yêu cầu cấp quyền lưu trữ bền vững `storage.persist()`.
- **Cập nhật an toàn mới**:
  - Tự động gọi `navigator.storage.persist()` khi component mount ở phía client, bảo vệ cơ sở dữ liệu IndexedDB của Vyen không bị trình duyệt tự ý giải phóng khi gặp áp lực bộ nhớ (Storage Pressure).

---

### MODULE 2: CORE ORCHESTRATION & CHAT CONTROLLER

#### 3. `components/chat-interface.tsx` (6,082 dòng — 32.22% toàn bộ code TSX)
- **Đường dẫn**: `components/chat-interface.tsx`
- **Vai trò**: **Trái tim điều phối trung tâm** của toàn bộ ứng dụng. Kết nối AI SDK `useChat`, đồng bộ cây tin nhắn Dexie, điều phối vòng lặp gọi công cụ client (`onToolCall`), quản lý hàng đợi phê duyệt (`ApprovalQueue`), thực thi vòng lặp mục tiêu (`GoalLoop`), Staging sandbox, và tiếp sức Subagent Relay.
- **Cập nhật an toàn P0 đã triển khai**:
  - **Triệt tiêu TOCTOU bằng Base Hash SHA-256**: Trong các lệnh `fs_edit`, `fs_write`, `code_patch`, hệ thống ghi nhận mã băm SHA-256 cơ sở trước khi hiển thị diff. Trước khi ghi xuống đĩa, hệ thống đọc lại file và so khớp SHA-256; nếu phát hiện file bị ứng dụng khác sửa đổi từ bên ngoài, hệ thống lập tức từ chối ghi đè an toàn và cảnh báo người dùng.
  - **Khóa CWD trong Workspace Sandbox**: Kiểm tra `cwd` truyền vào trong `shell_run` qua `validateSafeRelativePath`, từ chối thực thi nếu trỏ ra ngoài workspace root.
  - **Bảo vệ Auto-execute Files**: Kiểm tra `targetsProtectedPath` trước khi cho phép `git_add` đưa file nhạy cảm (`.env`, `.git/**`) vào staging git.
  - **Hủy Abort cho ApprovalQueue**: Trong `handleStop`, kích hoạt `approvalQueue.abortAll()`, giải phóng toàn bộ các pending promises về `false` và đóng modal ngay lập tức khi người dùng bấm Dừng.

#### 4. `components/sidebar.tsx` (609 dòng)
- Quản lý phiên làm việc, tìm kiếm fulltext tiếng Việt BM25 có fold dấu, ghim hội thoại, liên kết thư mục workspace, và mở cài đặt.

#### 5. `components/composer.tsx` (994 dòng)
- Khung nhập liệu với **Draft Isolate Pattern** (ngăn re-render component cha 6,000 dòng theo từng phím gõ).
- **IME Composition 3-layer guard**: Bảo vệ người dùng Việt Nam gõ Telex/VNI không bị gửi sớm tin nhắn qua `composingRef`, `native.isComposing` và `keyCode === 229`.

#### 6. `components/context-meter.tsx` (94 dòng)
- Thước đo thị giác tỷ lệ tiêu thụ context window. **Tính toán chính xác theo active thread** (`reconstructActiveThreadSafe`), không tính gộp các nhánh rẽ phụ.

#### 7. `components/model-selector.tsx` (457 dòng)
- Dropdown chọn 32 model AI tích hợp sẵn và custom providers, tích hợp `ThinkingMenu`.

---

### MODULE 3: VIRTUALIZED MESSAGE TREE & PRESENTATION

#### 8. `components/chat/message-list.tsx` (468 dòng)
- Danh sách ảo hóa TanStack Virtual, bộ nhớ cache chiều cao `HEIGHT_CACHE`, cơ chế ghim đáy `useStickToBottom`.

#### 9. `components/chat/message-item.tsx` (425 dòng)
- Hàng tin nhắn đơn lẻ, chỉnh sửa inline tạo nhánh mới, khối suy luận `ThinkingBlock` thu gọn/mở rộng, tích hợp các badges.

#### 10. `components/branch-switcher.tsx` (74 dòng)
- Nút chuyển đổi nhánh anh em (`< 1/3 >`) với phím tắt `Alt + ←/→`.

#### 11 đến 16: Các Components Trạng Thái & Badges
- `tool-trace.tsx` (297 dòng): Nhật ký gọi công cụ (JSON args, state, fold output).
- `status-line.tsx` (264 dòng): Thanh trạng thái cố định ở đầu màn hình.
- `message-usage.tsx` (43 dòng): Hiển thị token tiêu thụ và độ trễ ms.
- `orchestrator-badge.tsx` (151 dòng): Huy hiệu tin nhắn sinh ra từ Orchestrator Sweep.
- `message-status-badge.tsx` (39 dòng): Badge trạng thái sending/delivered/error/aborted.
- `evidence-badge.tsx` (50 dòng): Huy hiệu minh chứng bậc thang Zero-Mem (`L0` - `L3`).

---

### MODULE 4: RICH CONTENT, MARKDOWN & CODE RENDERING

#### 17. `components/markdown-renderer.tsx` (438 dòng)
- Dựng GFM, KaTeX math, khối bọc `SyntaxHighlightGate` ngăn layout shift khi tải chunk highlighter.

#### 18. `components/syntax-highlight.tsx` (77 dòng)
- Nạp lười Prism cho 18 ngôn ngữ lập trình phổ biến.

#### 19. `components/highlight.tsx` (28 dòng)
- Làm nổi bật từ khóa tìm kiếm tiếng Việt không dấu.

---

### MODULE 5: HUMAN-IN-THE-LOOP, GUARDRAILS & SANDBOXING

#### 20. `components/diff-confirm.tsx` (140 dòng)
- Modal duyệt unified diff trước khi ghi đĩa, tích hợp focus trap và haptic feedback.

#### 21. `components/shell-confirm.tsx` (104 dòng)
- Modal duyệt chạy lệnh shell terminal, cảnh báo lệnh nguy hiểm.

#### 22. `components/staging-panel.tsx` (182 dòng)
- Vùng đệm sandbox xem trước batch sửa nhiều file trong RAM. Khi bấm `Apply All`, hệ thống đối soát `baseFileHash` của từng file trên đĩa trước khi ghi đè, chống TOCTOU race condition.

#### 23. `components/workspace-checkpoints.tsx` (296 dòng)
- Quản lý snapshots workspace và hoàn tác (rollback) thay đổi của agent.

#### 24. `components/mcp/tool-approval-dialog.tsx` (170 dòng)
- Hộp thoại phê duyệt 4 cấp cho MCP tool qua IPC Desktop Bridge.

#### 25. `components/tool-permissions-table.tsx` (324 dòng)
- Ma trận phân quyền độc lập per-tool cho 8 nhóm công cụ (Auto / Ask / Deny).

---

### MODULE 6: AUTONOMOUS AGENT PANELS & WORKFLOWS

#### 26 đến 32: Workflow & Telemetry Panels
- `hud/agent-hud.tsx` (129 dòng): Màn hình Telemetry HUD viễn trắc chi phí và lane trạng thái realtime.
- `plan-panel.tsx` (210 dòng): Checklist nhiệm vụ tuân thủ kỷ luật Phase-TODO (tối đa 1 active task) và nút "Duyệt & Thực hiện".
- `recipes/recipes-panel.tsx` (584 dòng): Quản lý và thực thi Recipes YAML, form tham số, retry logic.
- `scheduler/scheduler-panel.tsx` (504 dòng): Lập lịch chạy cron tự động, trigger headless session.
- `subagent-card.tsx` (132 dòng): Card tiến độ của subagent chạy song song.
- `tools-panel.tsx` (257 dòng): Danh mục công cụ và nạp tool MCP động qua BM25.
- `thinking-menu.tsx` (365 dòng): Điều khiển mức suy luận reasoning (low, medium, high, max).

---

### MODULE 7: UNIFIED SETTINGS SYSTEM — 6 DOMAINS (17 FILES)

#### 33 đến 49: Hệ thống Cài đặt APG Tabs
- `settings-dialog.tsx` (287 dòng): Khung Modal Cài đặt trung tâm, tìm kiếm tức thì.
- `settings/appearance-tab.tsx` (190 dòng): Theme, system prompt, temperature, throttle.
- `settings/providers-tab.tsx` (89 dòng): BYOK keys, safeStorage, vision model, routing.
- `settings/safety-tab.tsx` (157 dòng): 4 Chế độ an toàn, Staging toggle, Code mode.
- `settings/extensions-tab.tsx` (47 dòng): Quản lý tiện ích mở rộng.
- **`components/mcp/mcp-settings-panel.tsx` (579 dòng)**: Quản lý máy chủ MCP trong Desktop qua IPC (`stdio`, `streamable-http`, `sse`), hỗ trợ whitelist `available_tools` (Expose Mode).
- `settings/memory-tab.tsx` (62 dòng): Quản lý ký ức 3 giai đoạn và Zero-Mem.
- `settings/data-tab.tsx` (205 dòng): Backup/Restore JSON & MD, quota IndexedDB.
- `settings/auto-backup-section.tsx` (147 dòng): Cấu hình sao lưu định kỳ ngầm qua FSA.
- `settings/memories-section.tsx` (319 dòng): Quản lý facts dài hạn theo category, tags.
- `settings/slash-commands-section.tsx` (185 dòng): Quản lý lệnh gõ tắt `/` tùy biến.
- `settings/vision-model-section.tsx` (67 dòng): Chọn model thị giác cho workspace và MCP.
- `settings/section-loading.tsx` (17 dòng): Skeleton placeholder khi tab đang tải.
- `settings-agent-memory.tsx` (256 dòng): Panel quản lý bộ nhớ agent cấu trúc.
- `settings-skills.tsx` (178 dòng): Trình quản lý kỹ năng dạng file `.vyen/skills/`.
- `provider-manager.tsx` (517 dòng): Quản trị đa nhà cung cấp, kiểm tra API key health, endpoint mẫu.
- `routing-settings-panel.tsx` (437 dòng): Cấu hình phân luồng mô hình Lead/Worker và chuỗi model fallback.

---

### MODULE 8: SYSTEM INFRASTRUCTURE, FEEDBACK & UTILITIES (9 FILES)

#### 50 đến 58: Tiện ích & Cơ sở hạ tầng UI
- `error-boundary.tsx` (61 dòng): Generic React Error Boundary bắt crash component cây con.
- `chat-error-boundary.tsx` (85 dòng): Error Boundary chuyên biệt cho khung chat, cô lập lỗi render.
- `toast.tsx` (55 dòng): Hệ thống thông báo nổi 4 trạng thái.
- `chat-export-menu.tsx` (155 dòng): Xuất dữ liệu hội thoại sang JSON hoặc Markdown.
- `backup-reminder.tsx` (94 dòng): Banner nhắc nhở sao lưu dữ liệu.
- `usage-stats.tsx` (154 dòng): Thống kê tổng số token và chi phí USD.
- `vyen-logo.tsx` (102 dòng): SVG branding logo Vyen và Pi Mark.
- `pwa-register.tsx` (30 dòng): Đăng ký Service Worker và thông báo cập nhật PWA.
- `effects/index.tsx` (182 dòng): Hiệu ứng xúc giác `useHaptics` và hoạt ảnh SiriWave/TextShimmer.

---

## 5. ĐỐI SOÁT PHẢN BIỆN CHUYÊN SÂU CỦA PRINCIPAL ARCHITECT & MA TRẬN KIỂM CHỨNG THỰC TẾ

Dưới đây là ma trận đối chiếu giữa nhận định của Architect với mã nguồn thực tế và kết quả xử lý:

| # | Luận điểm của Architect | Đánh giá thực tế | Trạng thái xử lý trong Codebase |
|---|---|---|---|
| **1** | **TOCTOU trong File System**: Phê duyệt trên diff cũ, ghi đè không kiểm tra thay đổi trên đĩa. | **CHÍNH XÁC (P0)** | **ĐÃ KHẮC PHỤC TRIỆT ĐỂ**: Thêm SHA-256 base hash verification trước khi ghi đĩa trong `chat-interface.tsx` và `lib/staging.ts`. |
| **2** | **Shell Safety & Bypass**: Denylist regex bị bypass; thiếu jailing `cwd`. | **CHÍNH XÁC & NGUY HIỂM HƠN DỰ KIẾN** | **ĐÃ KHẮC PHỤC TRIỆT ĐỂ**: Xóa bỏ `node -e` và `python -c` khỏi `SAFE_COMMAND_PATTERNS`. Chặn toàn bộ metacharacters nối lệnh (`&&`, `\|\|`, `;`, `\|`, `$()`, `>`, `<`). Khóa `cwd` trong workspace root. |
| **3** | **Auto-execute File Protection**: Không bảo vệ `.git/hooks/**`, `package.json`, `.vyen/**`. | **CHÍNH XÁC (P0)** | **ĐÃ KHẮC PHỤC TRIỆT ĐỂ**: Ép buộc hỏi (`ask`) khi ghi vào `.git/**`, `package.json`, `.vscode/**`, `.env*`, `.vyen/**` qua `isProtectedPath`. |
| **4** | **ApprovalQueue Abort on Stop**: Bấm Stop không hủy modal hoặc promise đang chờ. | **CHÍNH XÁC (Bug thật)** | **ĐÃ KHẮC PHỤC TRIỆT ĐỂ**: Bổ sung `approvalQueue.abortAll()` trong `handleStop`, resolve `false` cho toàn bộ pending promises. |
| **5** | **Durability IndexedDB**: Trình duyệt có thể evict IndexedDB nếu thiếu bộ nhớ. | **CHÍNH XÁC** | **ĐÃ KHẮC PHỤC**: Tự động gọi `navigator.storage.persist()` khi khởi chạy app trong `app/page.tsx`. |
| **6** | **`appendMessage` & Multi-tab**: Await non-Dexie trong transaction; thiếu Web Locks. | **ĐÚNG MỘT NỬA** | Transaction Dexie đơn tab toàn vẹn (không await external promise). Nhưng đúng là **thiếu Web Locks** cho concurrent tabs (xếp vào P1). |
| **7** | **IME Composition tiếng Việt**: Gửi sớm khi gõ Enter tiếng Việt Telex/VNI. | **BÁO ĐỘNG GIẢ (FALSE ALARM)** | Mã nguồn đã có sẵn 3 lớp phòng thủ trong `components/composer.tsx:550-556` (`composingRef`, `native.isComposing`, `keyCode === 229`). |
| **8** | **ContextMeter tính trên toàn cây**: Phê bình ContextMeter tính sai nhánh. | **BÁO ĐỘNG GIẢ (FALSE ALARM)** | `contextUsage` vốn đã được tính riêng cho active path qua `reconstructActiveThreadSafe`. |
| **9** | **Lưu trữ Attachment Base64**: Phê bình tốn 33% và ép base64 vào Dexie. | **BÁO ĐỘNG GIẢ MỘT PHẦN** | `lib/db.ts:69` lưu trực tiếp structured-clone `Blob`, không dùng base64. |
| **10** | **`HEIGHT_CACHE` & Virtualizer**: Cache thiếu width; stream nằm trong virtualizer. | **CHÍNH XÁC 100%** | Xác nhận là rủi ro hiệu năng cao. Đã lập kế hoạch khắc phục trong Sprint P1. |
| **11** | **Mất Draft khi ErrorBoundary**: Boundary unmount làm mất draft state. | **CHÍNH XÁC** | Xác nhận mâu thuẫn giữa mô tả và triển khai. Lập kế hoạch persist draft trong Sprint P1. |
| **12** | **Tool-call Pairing Invariant**: Đứt cặp tool_call / tool_result khi rẽ nhánh. | **CHÍNH XÁC** | Cần bổ sung `normalizeMessageToolPairing()` trước khi gửi payload lên LLM (Sprint P1). |

---

## 6. HIỆN TRẠNG THỰC THI & LỘ TRÌNH TÁI CẤU TRÚC (STATUS & ROADMAP)

### Giai đoạn P0: An toàn dữ liệu & Lỗ hổng Trực tiếp — [ĐÃ HOÀN THÀNH 100%]
Tất cả các hạng mục dưới đây đã được triển khai mã nguồn, biên dịch thành công 0 lỗi (`tsc --noEmit`), và vượt qua **161/161 test suites (2,419 tests)** kèm bộ test tấn công chuyên biệt `tests/p0-security-audit.test.ts` (20/20 test cases):
- [x] **P0.1**: Loại bỏ `node -e`, `node --eval`, `python -c` khỏi `SAFE_COMMAND_PATTERNS`. Chặn đứng command chaining, pipes, subshells, redirections, và neo chặt regex `$`.
- [x] **P0.2**: Khóa `cwd` của shell command trong workspace root, chống path traversal qua `~`, `%...%`, `$VAR`, trailing spaces.
- [x] **P0.3**: Cưỡng chế phê duyệt đối với các file auto-execute (`.git/**`, `.vscode/**`, `package.json`, `.env*`, `.vyen/**`) trong mọi chế độ auto-pilot.
- [x] **P0.4**: Triệt tiêu TOCTOU race condition bằng SHA-256 base hash verification trước khi ghi đĩa cho `fs_write`, `fs_edit`, `code_patch`, `applyAllStaged`.
- [x] **P0.5**: Bổ sung `approvalQueue.abortAll()` khi người dùng bấm Dừng (Stop), resolve `false` giải phóng sạch các pending promises.
- [x] **P0.6**: Gọi `navigator.storage.persist()` khi ứng dụng khởi chạy ở client để bảo vệ dữ liệu Dexie.

---

### Giai đoạn P1: Tái cấu trúc Kiến trúc & Tối ưu Hiệu năng — [KẾ HOẠCH SPRINT TIẾP THEO]
Dành cho AI Reviewer đánh giá kiến trúc và phản biện phương án triển khai:

1. **Tách God Component `chat-interface.tsx` (6,082 dòng) thành Kiến trúc 3 Tầng**:
   - **Tầng 1 (Core)**: `AgentRuntime` thuần TypeScript không phụ thuộc React, quản lý state và tool loop độc lập, có thể chạy trong Node/Vitest và Web Worker.
   - **Tầng 2 (Adapter)**: Hook `useAgentRuntime(chatId)` kết nối qua `useSyncExternalStore`.
   - **Tầng 3 (UI)**: Các Presentational Components mỏng, nhận props và phát sự kiện.
   - Áp dụng **XState** cho Turn Lifecycle Machine: `idle -> streaming -> awaiting_approval -> executing_tool -> resubmitting -> done/aborted/error`.
2. **Tối ưu Danh sách Ảo hóa (TanStack Virtual)**:
   - Tách tin nhắn đang stream ra khỏi Virtualizer, hiển thị như một footer cố định ngoài danh sách ảo hóa để triệt tiêu measurement thrashing.
   - Bổ sung `widthBucket` vào khóa cache của `HEIGHT_CACHE`: `${chatId}:${id}:${widthBucket}` và giới hạn kích thước theo cơ chế LRU (~2,000 mục).
3. **Web Locks Multi-tab Concurrency**:
   - Tích hợp Web Locks API: `navigator.locks.request('chat-runtime:' + chatId)` để chỉ 1 tab làm Leader runtime thực thi, các tab khác làm Observer hiển thị.
4. **Tool-call Pairing Normalizer**:
   - Bổ sung bước chuẩn hóa tự động trong `lib/message-normalize.ts`, tự động phát hiện và vá các `tool_call` mồ côi (thiếu `tool_result` tương ứng do rẽ nhánh) trước khi gửi lên API upstream.
5. **Persist Draft trong Composer**:
   - Lưu trữ bản nháp soạn thảo theo `chatId` vào `localStorage` (debounce 300ms) để bảo toàn văn bản khi `ChatErrorBoundary` kích hoạt.

---

### Giai đoạn P2: Mở rộng & Trưởng thành Hệ thống Dài hạn
1. **Policy-as-data & Audit Log**:
   - Chuyển đổi mô hình phân quyền sang dạng chính sách có phạm vi chi tiết (path glob, rate-limit, session/workspace scope).
   - Ghi nhận nhật ký kiểm toán bất biến (Immutable Audit Log) cho mọi hành động phê duyệt ghi file và chạy lệnh.
2. **Lưu trữ Blob lớn vào OPFS**:
   - Di chuyển các file đính kèm lớn ra Origin Private File System nhằm tối ưu hóa hiệu năng backup/restore JSON của Dexie.
3. **Shiki Worker Highlighting & KaTeX Font Preload**:
   - Đưa quá trình tô màu cú pháp mã nguồn lớn sang Web Worker để giải phóng main thread 60fps.
