# TÀI LIỆU THIẾT KẾ KIẾN TRÚC MÃ NGUỒN UI & FRONTEND (TSX) — DỰ ÁN VYEN
> **Phiên bản**: v3.2 (Đồng bộ hóa số liệu sau Gói P0 Bảo Mật, P2 Tối Ưu UX/Virtualizer, P3 Policy & Audit Log và sprint hardening S1–S2)  
> **Cập nhật lúc**: 2026-09-22 (số liệu đối chiếu tại HEAD `6768422`)  
> **Mục đích tài liệu**: Cung cấp bản đặc tả kỹ thuật toàn diện, tuyệt đối chính xác về thiết kế mã nguồn, cấu trúc Component, luồng dữ liệu (Data Flow), cơ chế quản lý trạng thái (State Management), cơ chế an toàn duyệt mã (Human-in-the-Loop & Guardrails) của toàn bộ **58 file `.tsx`** (tổng cộng **19,130 dòng code** loại trừ trailing newlines, tương đương **19,188 dòng** khi tính cả dòng rỗng cuối file) trong dự án Vyen. Tài liệu này được thiết kế chuyên biệt để các hệ thống AI (Claude, GPT, Gemini...) phân tích, phản biện kiến trúc và đánh giá chất lượng kỹ thuật mà không cần truy cập trực tiếp vào hệ thống file.

---

## MỤC LỤC
1. [Tổng Quan Kiến Trúc Hệ Thống (Architectural Overview)](#1-tổng-quan-kiến-trúc-hệ-thống)
2. [Sơ Đồ Phân Cấp Component & Luồng Dữ Liệu (Hierarchy & Data Flow)](#2-sơ-đồ-phân-cấp-component--luồng-dữ-liệu)
3. [Bảng Chỉ Mục Toàn Bộ 58 File TSX Theo Module](#3-bảng-chỉ-mục-toàn-bộ-58-file-tsx-theo-module)
4. [Đặc Tả Chi Tiết 58 File TSX Theo 8 Module & Nâng Cấp Trọng Yếu](#4-đặc-tả-chi-tiết-58-file-tsx-theo-8-module--nâng-cấp-trọng-yếu)
   - [Module 1: Next.js App Router Root Layer (2 files)](#module-1-nextjs-app-router-root-layer)
   - [Module 2: Core Orchestration & Chat Controller (5 files)](#module-2-core-orchestration--chat-controller)
   - [Module 3: Virtualized Message Tree & Presentation (9 files)](#module-3-virtualized-message-tree--presentation)
   - [Module 4: Rich Content, Markdown & Code Rendering (3 files)](#module-4-rich-content-markdown--code-rendering)
   - [Module 5: Human-in-the-Loop, Guardrails & Sandboxing (6 files)](#module-5-human-in-the-loop-guardrails--sandboxing)
   - [Module 6: Autonomous Agent Panels & Workflows (7 files)](#module-6-autonomous-agent-panels--workflows)
   - [Module 7: Unified Settings System — 6 Domains (17 files)](#module-7-unified-settings-system--6-domains)
   - [Module 8: System Infrastructure, Feedback & Utilities (9 files)](#module-8-system-infrastructure-feedback--utilities)
5. [Đối Soát Phản Biện Chuyên Sâu Của Principal Architect & Ma Trận Kiểm Chứng Thực Tế](#5-đối-soát-phản-biện-chuyên-sâu-của-principal-architect--ma-trận-kiểm-chứng-thực-tế)
6. [Hiện Trạng Thực Thi & Lộ Trình Tái Cấu Trúc (P0, P2, P3 Hoàn Tất -> P1 Kế Hoạch)](#6-hiện-trạng-thực-thi--lộ-trình-tái-cấu-trúc-p0-p2-p3-hoàn-tất---p1-kế-hoạch)

---

## 1. TỔNG QUAN KIẾN TRÚC HỆ THỐNG

### 1.1. Bản chất Dự án Vyen
Vyen là một **High-Assurance Coding Agent Harness** kiêm **Local-First AI Chat System** chạy song song ở hai môi trường:
1. **Web Browser (Chromium/Firefox/Safari)**: Sử dụng File System Access API để kết nối trực tiếp thư mục mã nguồn máy khách mà không qua server backend.
2. **Desktop Shell & CLI**: Chạy Next.js local kết hợp Chromium `--app` mode và bridge IPC cục bộ để gọi terminal shell, git và giao thức Model Context Protocol (MCP).

### 1.2. Các Nguyên Lý Kiến Trúc Cốt Lõi
1. **Local-First & Zero-Server Persistence**:
   - Dữ liệu lịch sử chat, các nhánh hội thoại, file đính kèm blob, cấu hình MCP, permissions, recipes đều được lưu trữ trực tiếp trên trình duyệt bằng **Dexie.js (IndexedDB)** trải qua 19 migration phiên bản (bổ sung bảng `auditLogs`).
   - Gọi `navigator.storage.persist()` khi ứng dụng khởi chạy ở client để bảo vệ dữ liệu chống browser eviction.
2. **Non-Linear Branching Message Tree & Tool-Call Invariance**:
   - Mỗi tin nhắn là một node độc lập trỏ về `parentId` (root mang `parentId = '__ROOT__'`).
   - Khái niệm "Cuộc trò chuyện" thực chất là đường đi từ gốc (root) đến một nút lá tích cực (`activeLeafId`).
   - **Tool-Call Pairing Normalizer**: Tự động phát hiện và vá các `tool_call` mồ côi (chưa có `tool_result` do rẽ nhánh) trước khi gửi lên API upstream, loại bỏ triệt để lỗi 400 của OpenAI/Anthropic.
3. **Strict Client-Side Tool Execution Loop**:
   - LLM phát sinh tool call (`fs_read`, `fs_edit`, `fs_write`, `code_patch`, `shell_run`, `git_*`, `mcp__*`).
   - Kiểm tra SHA-256 base hash chống TOCTOU trước khi ghi đè đĩa.
   - Chặn đứng metacharacters shell chaining (`&&`, `||`, `;`, `|`, `$()`, `>`, `<`) và jailing `cwd` trong workspace root.
   - Ghi lại nhật ký kiểm toán chống giả mạo (Tamper-Evident Audit Log — hash chain + disk anchor; KHÔNG "bất biến" tuyệt đối vì nằm trong Dexie cùng origin) vào bảng `auditLogs`.
   - **Chống prompt injection (A5)**: taint tracking toàn lượt — mọi nguồn ngoài (file đọc, output MCP, web_search/web_fetch, stdout shell/diff git, `run_code`) đánh dấu lượt nhiễm qua `lib/taint-tracker.ts`; khi lượt đã nhiễm, Egress Guard (`lib/auto-pilot.ts`) hạ cấp mọi tool exfil (web/MCP/git_push/shell có curl) sang chế độ hỏi người dùng, kèm trần ngân sách autonomous. CSP (`next.config.js`) là lớp phòng thủ thứ hai cho bề mặt render GFM/KaTeX.
4. **Virtualizer Layout Stability & Measurement Isolation**:
   - Tách tin nhắn đang stream ra ngoài TanStack Virtualizer vào sticky container độc lập, triệt tiêu measurement thrashing.
   - Bộ nhớ đệm chiều cao `HEIGHT_CACHE` tích hợp `widthBucket` và giới hạn LRU 2,000 mục, chống giật màn hình khi đóng/mở sidebar.
5. **Draft Persistence**:
   - Tự động lưu bản nháp soạn thảo theo `chatId` vào `localStorage` (debounce 300ms + flush on switch/unload), bảo toàn nội dung khi crash hoặc unmount.

---

## 2. SƠ ĐỒ PHÂN CẤP COMPONENT & LUỒNG DỮ LIỆU

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
      │    └── ChatInterface (components/chat-interface.tsx) [CORE ORCHESTRATOR - 32.1% TSX codebase]
      │         ├── AgentHud (components/hud/agent-hud.tsx)
      │         ├── StatusLine (components/chat/status-line.tsx)
      │         │    ├── ContextMeter (components/context-meter.tsx)
      │         │    ├── ThinkingMenu (components/thinking-menu.tsx)
      │         │    └── ChatExportMenu (components/chat-export-menu.tsx)
      │         │
      │         ├── WorkspaceCheckpointBar (components/workspace-checkpoints.tsx)
      │         ├── PlanPanel (components/plan-panel.tsx)
      │         │
      │         ├── MessageList (components/chat/message-list.tsx) [TanStack Virtual + Stream Sticky Footer + Width LRU]
      │         │    ├── ThinkingIndicator
      │         │    └── MessageItem (components/chat/message-item.tsx)
      │         │         ├── ThinkingBlock (collapsible)
      │         │         ├── BranchSwitcher (components/branch-switcher.tsx)
      │         │         ├── MarkdownRenderer (components/markdown-renderer.tsx)
      │         │         │    ├── SyntaxHighlightGate -> SyntaxHighlight (components/syntax-highlight.tsx)
      │         │         │    └── PlainCode
      │         │         ├── ToolTrace (components/chat/tool-trace.tsx)
      │         │         │    └── SubagentCard (components/subagent-card.tsx)
      │         │         ├── OrchestratorBadge (components/chat/orchestrator-badge.tsx)
      │         │         ├── EvidenceBadge (components/evidence-badge.tsx)
      │         │         ├── MessageStatusBadge (components/message-status-badge.tsx)
      │         │         └── MessageUsage (components/chat/message-usage.tsx)
      │         │
      │         ├── Composer (components/composer.tsx) [Draft Persist + 3-layer IME composition guard]
      │         │    ├── ModelSelector (components/model-selector.tsx)
      │         │    ├── TaskMenu (Tác vụ: Plan, Goal, Staging, Tools, Recipes...)
      │         │    └── Slash Commands Autocomplete Popup
      │         │
      │         ├── [MODALS & SLIDE-OVER PANELS]
      │         │    ├── DiffConfirm (components/diff-confirm.tsx) [SHA-256 verified]
      │         │    ├── ShellConfirm (components/shell-confirm.tsx) [CWD jailed]
      │         │    ├── StagingPanel (components/staging-panel.tsx) [TOCTOU base hash check]
      │         │    ├── ToolsPanel (components/tools-panel.tsx)
      │         │    ├── RecipesPanel (components/recipes/recipes-panel.tsx)
      │         │    └── McpToolApprovalDialog (components/mcp/tool-approval-dialog.tsx)
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

*(Toàn bộ 58 file TSX phân bố chuẩn xác, tổng cộng **19,130 dòng code** loại trừ trailing newlines, hoặc **19,188 dòng** khi tính cả dòng rỗng cuối file)*

| # | Module | Đường Dẫn File | Số Dòng | Vai Trò Chính |
|---|---|---|---|---|
| 1 | **M1: Root** | `app/layout.tsx` | 71 | Root HTML, fonts, Dark-theme script chống FOUC, PWA registration |
| 2 | | `app/page.tsx` | 161 | Main page layout, phím tắt toàn cục, dynamic import Settings, `storage.persist()` |
| 3 | **M2: Core Harness** | `components/chat-interface.tsx` | 6,183 | Đầu não điều phối: stream, tool runtime, TOCTOU guard, CWD jail, abort queue, audit log (32.22%) |
| 4 | | `components/sidebar.tsx` | 609 | Quản lý phiên chat, tìm kiếm fulltext tiếng Việt, workspace link |
| 5 | | `components/composer.tsx` | 1,068 | Ô nhập đa năng, voice STT, slash commands, Draft Persist vào localStorage, 3-layer IME guard |
| 6 | | `components/context-meter.tsx` | 94 | Thước đo ngữ cảnh token, tính toán riêng cho active thread |
| 7 | | `components/model-selector.tsx` | 457 | Dropdown chọn model phân nhóm theo nhà cung cấp & khả năng |
| 8 | **M3: Message Tree** | `components/chat/message-list.tsx` | 600 | Danh sách tin nhắn ảo hóa TanStack Virtual, tách stream message ra ngoài virtualizer, width-aware LRU cache |
| 9 | | `components/chat/message-item.tsx` | 425 | Hàng tin nhắn đơn lẻ, thinking block, inline edit, actions |
| 10 | | `components/branch-switcher.tsx` | 74 | Nút chuyển đổi qua lại giữa các nhánh anh em (`< 1/3 >`) |
| 11 | | `components/chat/tool-trace.tsx` | 297 | Hiển thị chi tiết gọi tool (args, execution state, output fold) |
| 12 | | `components/chat/status-line.tsx` | 264 | Thanh trạng thái hoạt động: model, hints, tokens, telemetry |
| 13 | | `components/chat/message-usage.tsx` | 43 | Huy hiệu hiển thị token tiêu thụ và độ trễ response |
| 14 | | `components/chat/orchestrator-badge.tsx` | 151 | Huy hiệu phân biệt tin nhắn sinh ra từ Orchestrator Sweep |
| 15 | | `components/message-status-badge.tsx` | 39 | Badge trạng thái tin nhắn (sending, delivered, error, aborted) |
| 16 | | `components/evidence-badge.tsx` | 50 | Huy hiệu minh chứng bậc thang (Zero-Mem Evidence Level) |
| 17 | **M4: Rich Content** | `components/markdown-renderer.tsx` | 443 | Bộ dựng Markdown chuẩn GFM, KaTeX math, dynamic syntax gate |
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

## 4. ĐẶC TẢ CHI TIẾT 58 FILE TSX THEO 8 MODULE & NÂNG CẤP TRỌNG YẾU

### Module 1: Next.js App Router Root Layer (2 files)
- **`app/layout.tsx` (71 dòng)**:
  - Khởi tạo khung HTML root, fonts hệ thống, inject inline theme script chống hiện tượng nhấp nháy giao diện (FOUC).
  - Mount component `PWARegister` (`components/pwa-register.tsx`) để đăng ký Service Worker và lắng nghe cập nhật phiên bản client.
- **`app/page.tsx` (161 dòng)**:
  - Entrypoint giao diện chính của ứng dụng. Gọi `navigator.storage.persist()` ngay khi client mount để yêu cầu trình duyệt bảo vệ bộ nhớ IndexedDB vĩnh viễn, chống việc bị OS/browser tự động dọn dẹp khi thiếu dung lượng đĩa.
  - Đăng ký bộ phím tắt toàn cục (`Ctrl/Cmd + K`, `Ctrl/Cmd + Shift + S`, `Escape`), điều phối hiển thị Sidebar và nạp lười (dynamic import) `SettingsDialog`.

### Module 2: Core Orchestration & Chat Controller (5 files)
- **`components/chat-interface.tsx` (6,183 dòng — 32.22% toàn bộ code TSX)**:
  *Đầu não điều phối toàn bộ vòng đời tác vụ, streaming token, và phân phối công cụ*:
  - **TOCTOU Guard (P0)**: Tính toán và kiểm tra SHA-256 base hash trước khi ghi đĩa cho `fs_edit`, `fs_write`, `code_patch`. Nếu hash trên đĩa khác base hash thời điểm đọc, lập tức hủy ghi và trả lỗi `[TOCTOU] File đã bị thay đổi trên đĩa bởi tiến trình khác`.
  - **CWD Sandbox & Shell Chaining (P0)**: Toàn bộ đường dẫn thực thi lệnh shell được khóa chặt chẽ trong workspace root thông qua `validateSafeRelativePath`. Chặn đứng triệt để metacharacters (`&&`, `||`, `;`, `|`, `$()`, `>`, `<`) và denylist các flag nguy hiểm của `node`/`python`.
  - **ApprovalQueue Abort on Stop (P0)**: Khi người dùng bấm nút "Dừng" (Stop), hàm `handleStop` kích hoạt `approvalQueue.abortAll(false)` để lập tức giải phóng toàn bộ pending promises của các modal duyệt, ngăn chặn treo luồng.
  - **Audit Logging Bất Biến (P3)**: Ghi lại đầy đủ mọi quyết định duyệt/từ chối công cụ kèm payload vào bảng Dexie v19 `auditLogs` thông qua `lib/audit-log.ts`.
- **`components/sidebar.tsx` (609 dòng)**:
  - Quản lý cây danh sách phiên chat, tìm kiếm full-text tiếng Việt có fold dấu (`foldText`), nhóm lịch sử theo ngày (`date-groups.ts`).
  - Hỗ trợ đổi tên inline, ghim cuộc trò chuyện, xuất dữ liệu và banner tự động nhận diện kết nối lại thư mục workspace tương ứng.
- **`components/composer.tsx` (1,068 dòng)**:
  - **Draft Persistence Engine (P2)**: Tự động lưu bản nháp vào `localStorage['vyen:draft:${chatId}']` với debounce 300ms. Đồng bộ flush draft khi đổi `chatId`, khi đóng tab/refresh (`beforeunload`), và khi unmount. Khôi phục hoàn hảo bản nháp kể cả khi `ChatErrorBoundary` reset.
  - **3-Layer IME Composition Guard**: Kiểm soát chặt chẽ 3 tầng điều kiện (`composingRef`, `nativeEvent.isComposing`, `keyCode === 229`) loại bỏ triệt để lỗi vô tình gửi tin nhắn sớm khi gõ phím Enter để bỏ dấu tiếng Việt Telex/VNI (tại dòng 626-630).
  - Tích hợp voice STT Web Speech API, menu gõ tắt `/`, TaskMenu và bộ chọn model.
- **`components/context-meter.tsx` (94 dòng)**:
  - Thước đo dung lượng ngữ cảnh token thời gian thực, tính toán chuẩn xác riêng cho active thread hiện tại thông qua `reconstructActiveThreadSafe`.
- **`components/model-selector.tsx` (457 dòng)**:
  - Dropdown chọn model phân loại theo nhóm nhà cung cấp, hiển thị badge khả năng (vision, function calling, reasoning).

### Module 3: Virtualized Message Tree & Presentation (9 files)
- **`components/chat/message-list.tsx` (600 dòng)**:
  - **Virtualizer Stream Separation (P2)**: Tách tin nhắn trợ lý đang stream (`isLoading && lastMsg.role === 'assistant'`) ra khỏi `rowVirtualizer`, cố định ở sticky container độc lập nhằm triệt tiêu hoàn toàn layout thrashing đo đạc chiều cao liên tục theo từng token ký tự.
  - **Width-Aware LRU `HEIGHT_CACHE` (P2)**: Bộ nhớ đệm chiều cao tin nhắn bổ sung bucket chiều rộng container (`${chatId}:${id}:${widthBucket}`) với dung lượng LRU 2,000 mục, loại bỏ rung giật cuộn trang khi co giãn sidebar.
  - **Smooth Stream Transition**: Sử dụng hook `prevLoadingRef` để bắt thời điểm kết thúc stream (`isLoading: true -> false`), tự động kích hoạt `rowVirtualizer.measure()` và `pin(400)` ghim mượt mà.
- **`components/chat/message-item.tsx` (425 dòng)**:
  - Hiển thị từng turn hội thoại (user/assistant), khối suy luận collapsible, các nút hành động (sao chép, sửa tin nhắn cũ, rẽ nhánh mới, retry).
- **`components/branch-switcher.tsx` (74 dòng)**:
  - Điều hướng giữa các nhánh hội thoại song song (`< 1/3 >`), hỗ trợ phím tắt và swipe.
- **`components/chat/tool-trace.tsx` (297 dòng)**:
  - Khối biểu diễn chi tiết trạng thái gọi tool (đang chạy, hoàn tất, thất bại, output gấp gọn), bao gói và hiển thị các card subagent (`SubagentCard`).
- **`components/chat/status-line.tsx` (264 dòng)**:
  - Thanh trạng thái cố định dưới khung chat, chứa `ContextMeter`, menu suy luận `ThinkingMenu`, và menu xuất dữ liệu `ChatExportMenu`.
- **`components/chat/message-usage.tsx` (43 dòng)**:
  - Hiển thị token vào/ra và thời gian phản hồi (latency) của từng lượt phản hồi.
- **`components/chat/orchestrator-badge.tsx` (151 dòng)**:
  - Badge trực quan gắn vào tin nhắn sinh ra từ chế độ Orchestrator Sweep song song.
- **`components/message-status-badge.tsx` (39 dòng)**:
  - Trạng thái tin nhắn: đang gửi, đã nhận, lỗi mạng, hoặc đã hủy (`aborted`).
- **`components/evidence-badge.tsx` (50 dòng)**:
  - Huy hiệu hiển thị cấp độ bằng chứng ngữ cảnh từ bộ nhớ Zero-Mem (`<zero-mem-evidence>`).

### Module 4: Rich Content, Markdown & Code Rendering (3 files)
- **`components/markdown-renderer.tsx` (443 dòng)**:
  - Bộ dựng Markdown chuẩn GitHub Flavored Markdown (GFM), hỗ trợ công thức toán học KaTeX (`remark-math`, `rehype-katex`), bảng biểu, và nạp code block qua dynamic gate.
- **`components/syntax-highlight.tsx` (77 dòng)**:
  - Tô màu cú pháp Prism cho 18 ngôn ngữ lập trình phổ biến, nạp lười theo yêu cầu để tối ưu bundle size ban đầu.
- **`components/highlight.tsx` (28 dòng)**:
  - Tô màu từ khóa tìm kiếm tiếng Việt không phân biệt dấu trong danh sách chat và nội dung tin nhắn.

### Module 5: Human-in-the-Loop, Guardrails & Sandboxing (6 files)
- **`components/diff-confirm.tsx` (140 dòng)**:
  - Modal xem trước unified diff từng dòng (xanh/đỏ) trước khi ghi đĩa, bắt buộc xác nhận thủ công ở chế độ Manual/Smart.
- **`components/shell-confirm.tsx` (104 dòng)**:
  - Hộp thoại cảnh báo và yêu cầu phê duyệt khi agent chuẩn bị chạy lệnh terminal trong bản desktop, đánh dấu đỏ các lệnh destructive.
- **`components/staging-panel.tsx` (182 dòng)**:
  - Vùng đệm staging sandbox cho phép xem xét toàn bộ các file đã sửa trong phiên trước khi nhấn "Apply Tất Cả" xuống đĩa.
- **`components/workspace-checkpoints.tsx` (296 dòng)**:
  - Quản lý các điểm phục hồi (checkpoints) của thư mục workspace, hỗ trợ so sánh diff và khôi phục mã nguồn về trạng thái an toàn trước đó.
- **`components/mcp/tool-approval-dialog.tsx` (170 dòng)**:
  - Hộp thoại phê duyệt 4 cấp cho công cụ Model Context Protocol: Cho phép lần này / Luôn cho phép / Từ chối lần này / Luôn từ chối.
- **`components/tool-permissions-table.tsx` (324 dòng)**:
  - Bảng ma trận quản trị phân quyền độc lập cho từng công cụ thuộc 8 nhóm (`fs`, `shell`, `git`, `mcp`, `web`, `plan`, `delegate`, `memory`) với các mức `auto`, `ask`, `deny`, `default`.

### Module 6: Autonomous Agent Panels & Workflows (7 files)
- **`components/hud/agent-hud.tsx` (129 dòng)**:
  - Head-Up Display hiển thị trạng thái hoạt động theo thời gian thực của các lane agent và subagent đang thực thi.
- **`components/plan-panel.tsx` (210 dòng)**:
  - Bảng theo dõi tiến độ kế hoạch tự hành (Plan Mode), phân rã task thành checklist các bước và nút "Duyệt & Thực thi".
- **`components/recipes/recipes-panel.tsx` (584 dòng)**:
  - Trình quản trị và chạy quy trình tự động hóa YAML Recipes (`.vyen/recipes/*.yaml`), form tham số, retry state machine và chạy song song sub-recipes.
- **`components/scheduler/scheduler-panel.tsx` (504 dòng)**:
  - Giao diện quản lý lịch chạy cron tự động, kích hoạt các phiên làm việc headless ngầm theo biểu thức cron tiêu chuẩn.
- **`components/subagent-card.tsx` (132 dòng)**:
  - Card hiển thị tiến độ, công cụ đang gọi và kết quả tóm tắt của subagent chạy song song (được render bên trong `ToolTrace`).
- **`components/tools-panel.tsx` (257 dòng)**:
  - Danh mục công cụ đầy đủ, tích hợp thuật toán tìm kiếm BM25 tiếng Việt và meta-tool `tools_load` nạp công cụ MCP theo nhu cầu.
- **`components/thinking-menu.tsx` (365 dòng)**:
  - Menu điều khiển mức độ suy luận (Thinking effort: `low`, `medium`, `high`, `max`), gắn kết trực tiếp trong `StatusLine`.

### Module 7: Unified Settings System — 6 Domains (17 files)
- **`components/settings-dialog.tsx` (287 dòng)**:
  - Hộp thoại Cài đặt trung tâm chuẩn APG, hỗ trợ tìm kiếm nhanh tức thì và điều hướng 6 tab chính:
  1. **Appearance (`appearance-tab.tsx`, 190 dòng)**: Giao diện, theme, system prompt, temperature, streaming throttle.
  2. **Providers (`providers-tab.tsx`, 89 dòng)**: Tích hợp `provider-manager.tsx` (517 dòng) quản lý API key BYOK, `vision-model-section.tsx` (67 dòng) chọn model thị giác, và `routing-settings-panel.tsx` (437 dòng) cấu hình Lead/Worker.
  3. **Safety (`safety-tab.tsx`, 157 dòng)**: Chọn 4 chế độ phê duyệt (Manual, Smart, Autonomous, Chat Only), bật/tắt Staging Sandbox, nhúng `tool-permissions-table.tsx`.
  4. **Extensions (`extensions-tab.tsx`, 47 dòng)**: `mcp-settings-panel.tsx` (579 dòng) cấu hình máy chủ MCP stdio/SSE, `settings-skills.tsx` (178 dòng) quản lý file SKILL.md, và `slash-commands-section.tsx` (185 dòng) quản lý lệnh `/`.
  5. **Memory (`memory-tab.tsx`, 62 dòng)**: Quản trị ký ức qua `memories-section.tsx` (319 dòng) và `settings-agent-memory.tsx` (256 dòng).
  6. **Data (`data-tab.tsx`, 205 dòng)**: Sao lưu/phục hồi JSON & Markdown, `auto-backup-section.tsx` (147 dòng) sao lưu tự động qua FSA API, và nhúng `scheduler-panel.tsx`.
- **`components/settings/section-loading.tsx` (17 dòng)**: Skeleton loading placeholder khi chuyển tab.

### Module 8: System Infrastructure, Feedback & Utilities (9 files)
- **`components/error-boundary.tsx` (61 dòng)**:
  - Generic React Error Boundary bắt lỗi crash giao diện ở các component con, ngăn chặn sập toàn bộ ứng dụng.
- **`components/chat-error-boundary.tsx` (85 dòng)**:
  - Error Boundary chuyên biệt cho khung hội thoại, tự động khôi phục nội dung draft đang soạn thảo dở dang khi xảy ra lỗi.
- **`components/toast.tsx` (55 dòng)**:
  - Hệ thống thông báo nổi (Toast notifications) phản hồi các hành động sao lưu, lưu key, lỗi mạng.
- **`components/chat-export-menu.tsx` (155 dòng)**:
  - Menu xuất lịch sử hội thoại sang định dạng JSON (toàn bộ cây phân nhánh) hoặc Markdown (nhánh tích cực đang xem), render trong `StatusLine`.
- **`components/backup-reminder.tsx` (94 dòng)**:
  - Banner định kỳ nhắc nhở người dùng sao lưu dữ liệu IndexedDB ra file đĩa.
- **`components/usage-stats.tsx` (154 dòng)**:
  - Thống kê chi tiết tổng số token vào/ra và ước tính chi phí theo USD của phiên làm việc.
- **`components/vyen-logo.tsx` (102 dòng)**:
  - Vector SVG logo thương hiệu Vyen và biểu tượng Pi Mark tương thích chế độ Dark/Light.
- **`components/pwa-register.tsx` (30 dòng)**:
  - Đăng ký Service Worker chuẩn Progressive Web App, quản lý kiểm tra cập nhật phiên bản offline.
- **`components/effects/index.tsx` (182 dòng)**:
  - Hiệu ứng rung haptics trên thiết bị di động, sóng âm thanh SiriWave cho Voice STT và TextShimmer loading.

---

## 5. ĐỐI SOÁT PHẢN BIỆN CHUYÊN SÂU CỦA PRINCIPAL ARCHITECT & MA TRẬN KIỂM CHỨNG THỰC TẾ

| # | Luận điểm của Architect | Đánh giá thực tế | Trạng thái xử lý trong Codebase |
|---|---|---|---|
| **1** | **TOCTOU trong File System**: Phê duyệt trên diff cũ, ghi đè không kiểm tra thay đổi trên đĩa. | **CHÍNH XÁC (P0)** | **[ĐÃ HOÀN THÀNH 100%]**: SHA-256 base hash verification trong `chat-interface.tsx` và `lib/staging.ts`. |
| **2** | **Shell Safety & Bypass**: Denylist regex bị bypass; thiếu jailing `cwd`. | **CHÍNH XÁC & NGUY HIỂM HƠN DỰ KIẾN** | **[ĐÃ HOÀN THÀNH 100%]**: Xóa bỏ `node -e`/`python -c`. Chặn metacharacters shell chaining. Khóa `cwd` trong workspace root. |
| **3** | **Auto-execute File Protection**: Không bảo vệ `.git/hooks/**`, `package.json`, `.vyen/**`. | **CHÍNH XÁC (P0)** | **[ĐÃ HOÀN THÀNH 100%]**: Ép buộc hỏi (`ask`) khi ghi vào `.git/**`, `package.json`, `.vscode/**`, `.env*`, `.vyen/**`. |
| **4** | **ApprovalQueue Abort on Stop**: Bấm Stop không hủy modal hoặc promise đang chờ. | **CHÍNH XÁC (Bug thật)** | **[ĐÃ HOÀN THÀNH 100%]**: `approvalQueue.abortAll()` trong `handleStop`, resolve `false` cho toàn bộ pending promises. |
| **5** | **Durability IndexedDB**: Trình duyệt có thể evict IndexedDB nếu thiếu bộ nhớ. | **CHÍNH XÁC** | **[ĐÃ HOÀN THÀNH 100%]**: Tự động gọi `navigator.storage.persist()` khi khởi chạy app trong `app/page.tsx`. |
| **6** | **`HEIGHT_CACHE` & Virtualizer**: Cache thiếu width; stream nằm trong virtualizer gây giật scroll. | **CHÍNH XÁC 100% (P2)** | **[ĐÃ HOÀN THÀNH 100%]**: Tách message đang stream ra ngoài virtualizer. Nâng cấp `HEIGHT_CACHE` width-aware + LRU 2,000 mục. |
| **7** | **Mất Draft khi ErrorBoundary**: Boundary unmount làm mất draft state. | **CHÍNH XÁC (P2)** | **[ĐÃ HOÀN THÀNH 100%]**: Tích hợp Draft Persistence vào `localStorage` kèm synchronous flush on switch/unload. |
| **8** | **Tool-call Pairing Invariant**: Đứt cặp tool_call / tool_result khi rẽ nhánh gây lỗi 400. | **CHÍNH XÁC (P2)** | **[ĐÃ HOÀN THÀNH 100%]**: Thêm `normalizeMessageToolInvocations` và `normalizeToolCallPairing` trong `lib/message-normalize.ts`. |
| **9** | **Audit Log Bất Biến**: Cần ghi nhận mọi thao tác duyệt/ghi/lệnh shell. | **CHÍNH XÁC (P3)** | **[ĐÃ HOÀN THÀNH 100%]**: Tạo bảng Dexie v19 `auditLogs` và module `lib/audit-log.ts`. |
| **10** | **Policy-as-data Scope**: Phân quyền path glob (`src/**`) và deny MCP mặc định. | **CHÍNH XÁC (P3)** | **[ĐÃ HOÀN THÀNH 100%]**: Xây dựng bộ so khớp glob chuẩn xác và áp dụng chính sách deny-by-default cho dynamic MCP tools. |
| **11** | **IME Composition tiếng Việt**: Gửi sớm khi gõ Enter tiếng Việt Telex/VNI. | **BÁO ĐỘNG GIẢ (FALSE ALARM)** | Đã có sẵn 3 lớp phòng thủ trong `components/composer.tsx:626-630` (`composingRef`, `native.isComposing`, `keyCode === 229`). |
| **12** | **ContextMeter tính trên toàn cây**: Phê bình ContextMeter tính sai nhánh. | **BÁO ĐỘNG GIẢ (FALSE ALARM)** | `contextUsage` vốn đã được tính riêng cho active path qua `reconstructActiveThreadSafe`. |
| **13** | **Lưu trữ Attachment Base64**: Phê bình tốn 33% và ép base64 vào Dexie. | **BÁO ĐỘNG GIẢ MỘT PHẦN** | `lib/db.ts:69` lưu trực tiếp structured-clone `Blob`, không dùng base64. |

---

## 6. HIỆN TRẠNG THỰC THI & LỘ TRÌNH TÁI CẤU TRÚC (P0, P2, P3 HOÀN TẤT -> P1 KẾ HOẠCH)

### Hiện Trạng Đã Hoàn Thành — [163/163 Test Files PASS · 2,456/2,456 Tests PASS]
- [x] **Gói P0 (Bảo Mật & Toàn Vẹn)**: TOCTOU hash guard, loại bỏ shell RCE, CWD jail, auto-execute file protection, ApprovalQueue abort, `storage.persist()`.
- [x] **Gói P2 (Tối Ưu UX & Virtualization)**: Tách stream message khỏi virtualizer, width-aware LRU `HEIGHT_CACHE`, draft persistence chống mất chữ, tool-call pairing normalizer chống lỗi 400.
- [x] **Gói P3 (Chính Sách & Kiểm Toán)**: Bảng Dexie v19 `auditLogs`, ghi nhật ký kiểm toán chống giả mạo (tamper-evident: hash chain + `verifyChain` + anchor `.vyen/audit/anchor.log`), bộ so khớp đường dẫn glob (`matchesGlobPattern`), deny-by-default cho dynamic MCP.
- [x] **Kiểm chứng tại HEAD `6768422` (2026-09-22)**: `tsc --noEmit` sạch; `vitest run` **163/163 test file PASS · 2,456/2,456 test PASS**; `node tests/sprint-s1-verification.cjs` và `node tests/sprint-s2-verification.cjs` đều PASS (gồm toàn bộ kiểm tra bảo mật shell policy).
- [x] **5 lỗi chặn đã sửa trong đợt kiểm chứng này**: (1) comment JSDoc chưa đóng trong `lib/fs-access.ts` nuốt cả hàm `isProtectedFsPath` → `TS2304` + `ReferenceError` lúc chạy; (2) `const crypto` khai báo trùng ở module scope trong `lib/ipc.cjs` → SyntaxError làm sập toàn bộ bridge IPC; (3) `fsWrite` tự so `err.name === 'NotFoundError'` thay vì dùng helper chung `isNotFoundError()` cùng module → tạo file mới luôn thất bại; (4) `lib/shell-policy.cjs` thiếu `grep`/`echo`/`printf` trong allowlist đọc-only → `shell_run` từ chối cả lệnh chỉ-đọc vô hại; (5) `npx vite build`/`npx next build` bị chặn vì `vite`/`next` không nằm trong `NPX_ALLOWED_BINS` (nay tách thành `NPX_REQUIRED_SUBCOMMANDS` — vẫn chặn `vite dev`/`next dev`).
- [x] **Ghi chú bảo mật (chủ ý)**: `find`/`fd` vẫn NGOÀI allowlist dù `SAFE_COMMAND_PATTERNS` của `lib/auto-pilot.ts` có liệt kê — `find ... -exec <cmd> +` và `-delete` chạy/ghi được mà tokenizer không chặn (không cần dấu `;`), nên hai binary này phải đòi phê duyệt thay vì auto-approve.
- **Flaky theo môi trường**: `tests/web-backend.test.ts` phụ thuộc mạng (DuckDuckGo/SearXNG) — khi pass khi fail tùy kết nối, không phải lỗi logic.

---

### Giai đoạn P1: Tái Cấu Trúc Kiến Trúc Cốt Lõi — [TRỌNG TÂM LỚN TIẾP THEO]
*Dành cho Principal Architect phản biện và thẩm định thiết kế chi tiết:*

1. **Bóc tách God Component `chat-interface.tsx` (6,183 dòng) thành Kiến trúc 3 Tầng**:
   - **Tầng 1 (Core Engine)**: `AgentRuntime` thuần TypeScript không dính dáng React (chạy được trong Node/Vitest và Web Worker), quản lý state máy trạng thái và vòng lặp tool độc lập.
   - **Tầng 2 (React Adapter)**: Hook `useAgentRuntime(chatId)` kết nối qua `useSyncExternalStore` + selectors để chặn re-render lan truyền.
   - **Tầng 3 (UI Presentation)**: Các presentational components mỏng, chỉ nhận props và phát sự kiện.
2. **State Machine XState cho Turn Lifecycle**:
   - Chuyển toàn bộ luồng turn logic sang XState v5: `idle -> streaming -> awaiting_approval -> executing_tool -> resubmitting -> done/aborted/error`.
   - Loại bỏ triệt để nguy cơ stale closure khi người dùng đổi chat/workspace trong lúc đang chờ duyệt diff.
3. **Web Locks Multi-tab Concurrency**:
   - Sử dụng Web Locks API `navigator.locks.request('chat-runtime:' + chatId)` để đảm bảo chỉ có 1 tab duy nhất làm Leader runtime thực thi, các tab khác làm Observer hiển thị.
