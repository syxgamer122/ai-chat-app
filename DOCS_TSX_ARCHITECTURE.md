# TÀI LIỆU THIẾT KẾ KIẾN TRÚC MÃ NGUỒN UI & FRONTEND (TSX) — DỰ ÁN VYEN
> **Phiên bản**: v3.0 (Đồng bộ hóa toàn diện sau khi hoàn thành Gói P0 Bảo Mật, P2 Tối Ưu UX/Virtualizer và P3 Policy & Audit Log)  
> **Cập nhật lúc**: 2026-09-20  
> **Mục đích tài liệu**: Cung cấp bản đặc tả kỹ thuật toàn diện, tuyệt đối chính xác về thiết kế mã nguồn, cấu trúc Component, luồng dữ liệu (Data Flow), cơ chế quản lý trạng thái (State Management), cơ chế an toàn duyệt mã (Human-in-the-Loop & Guardrails) của toàn bộ **58 file `.tsx`** (tổng cộng **19,152 dòng code**) trong dự án Vyen. Tài liệu này được thiết kế chuyên biệt để các hệ thống AI (Claude, GPT, Gemini...) phân tích, phản biện kiến trúc và đánh giá chất lượng kỹ thuật mà không cần truy cập trực tiếp vào hệ thống file.

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
   - Ghi lại nhật ký kiểm toán bất biến (Immutable Audit Log) vào bảng `auditLogs`.
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
      │         │    └── ContextMeter (components/context-meter.tsx)
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
      │         │         ├── SubagentCard (components/subagent-card.tsx)
      │         │         ├── OrchestratorBadge (components/chat/orchestrator-badge.tsx)
      │         │         ├── EvidenceBadge (components/evidence-badge.tsx)
      │         │         ├── MessageStatusBadge (components/message-status-badge.tsx)
      │         │         └── MessageUsage (components/chat/message-usage.tsx)
      │         │
      │         ├── Composer (components/composer.tsx) [Draft Persist + 3-layer IME composition guard]
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

*(Toàn bộ 58 file TSX phân bố chuẩn xác, tổng cộng **19,152 dòng code**)*

| # | Module | Đường Dẫn File | Số Dòng | Vai Trò Chính |
|---|---|---|---|---|
| 1 | **M1: Root** | `app/layout.tsx` | 71 | Root HTML, fonts, Dark-theme script chống FOUC, PWA registration |
| 2 | | `app/page.tsx` | 161 | Main page layout, phím tắt toàn cục, dynamic import Settings, `storage.persist()` |
| 3 | **M2: Core Harness** | `components/chat-interface.tsx` | 6,152 | Đầu não điều phối: stream, tool runtime, TOCTOU guard, CWD jail, abort queue, audit log (32.12%) |
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

## 4. ĐẶC TẢ CHI TIẾT CÁC COMPONENT NÂNG CẤP TRỌNG YẾU

#### 3. `components/chat-interface.tsx` (6,152 dòng — 32.12% toàn bộ code TSX)
- **Cập nhật P0 & P3 đã triển khai**:
  - **TOCTOU Guard**: Tích hợp SHA-256 base hash verification trước khi ghi đĩa cho `fs_edit`, `fs_write`, `code_patch`.
  - **CWD Sandbox**: Khóa `cwd` của shell command chặt chẽ trong workspace root qua `validateSafeRelativePath`.
  - **ApprovalQueue Abort**: Resolve `false` giải phóng toàn bộ pending promises khi người dùng bấm Stop.
  - **Audit Logging**: Tự động ghi lại nhật ký kiểm toán bất biến vào bảng `db.auditLogs` khi phê duyệt hoặc từ chối công cụ.

#### 5. `components/composer.tsx` (1,068 dòng)
- **Draft Persistence Engine**:
  - Tự động lưu bản nháp vào `localStorage['vyen:draft:${chatId}']` với debounce 300ms.
  - Xử lý đồng bộ `flushDraft` khi đổi chat (`prevChatIdRef`), khi đóng tab / refresh (`beforeunload`), và khi unmount.
  - Khôi phục nguyên vẹn nội dung khi chuyển lại chat cũ hoặc khi `ChatErrorBoundary` khôi phục giao diện.
  - 3-layer IME composition guard chống gửi sớm khi gõ dấu tiếng Việt Telex/VNI.

#### 8. `components/chat/message-list.tsx` (600 dòng)
- **Virtualizer Stream Separation**:
  - Tách tin nhắn trợ lý đang stream (`isLoading && lastMsg.role === 'assistant'`) ra khỏi `rowVirtualizer`, hiển thị ở sticky container độc lập.
  - Triệt tiêu hoàn toàn hiện tượng `measureElement` liên tục theo từng token ký tự.
  - Chuyển tiếp mượt mà: Hook `prevLoadingRef` bắt sự kiện kết thúc stream (`isLoading: true -> false`) để gọi `rowVirtualizer.measure()` và `pin(400)`, ghim màn hình mượt mà không nhảy scroll.
- **Width-Aware LRU `HEIGHT_CACHE`**:
  - Cache key bổ sung bucket chiều rộng container: `${chatId}:${id}:${widthBucket}`.
  - Giới hạn kích thước LRU 2,000 mục, tự động loại bỏ mục cũ nhất khi đầy, lưu giữ cache xuyên suốt các chat đã mở gần đây.

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
| **11** | **IME Composition tiếng Việt**: Gửi sớm khi gõ Enter tiếng Việt Telex/VNI. | **BÁO ĐỘNG GIẢ (FALSE ALARM)** | Đã có sẵn 3 lớp phòng thủ trong `components/composer.tsx:550-556` (`composingRef`, `native.isComposing`, `keyCode === 229`). |
| **12** | **ContextMeter tính trên toàn cây**: Phê bình ContextMeter tính sai nhánh. | **BÁO ĐỘNG GIẢ (FALSE ALARM)** | `contextUsage` vốn đã được tính riêng cho active path qua `reconstructActiveThreadSafe`. |
| **13** | **Lưu trữ Attachment Base64**: Phê bình tốn 33% và ép base64 vào Dexie. | **BÁO ĐỘNG GIẢ MỘT PHẦN** | `lib/db.ts:69` lưu trực tiếp structured-clone `Blob`, không dùng base64. |

---

## 6. HIỆN TRẠNG THỰC THI & LỘ TRÌNH TÁI CẤU TRÚC (P0, P2, P3 HOÀN TẤT -> P1 KẾ HOẠCH)

### Hiện trạng Đã Hoàn Thành — [162/162 Test Suites Passed, 2,445 Tests]
- [x] **Gói P0 (Bảo Mật & Toàn Vẹn)**: TOCTOU hash guard, loại bỏ shell RCE, CWD jail, auto-execute file protection, ApprovalQueue abort, `storage.persist()`.
- [x] **Gói P2 (Tối Ưu UX & Virtualization)**: Tách stream message khỏi virtualizer, width-aware LRU `HEIGHT_CACHE`, draft persistence chống mất chữ, tool-call pairing normalizer chống lỗi 400.
- [x] **Gói P3 (Chính Sách & Kiểm Toán)**: Bảng Dexie v19 `auditLogs`, ghi nhật ký kiểm toán bất biến, bộ so khớp đường dẫn glob (`matchesGlobPattern`), deny-by-default cho dynamic MCP.

---

### Giai đoạn P1: Tái Cấu Trúc Kiến Trúc Cốt Lõi — [TRỌNG TÂM LỚN TIẾP THEO]
*Dành cho Principal Architect phản biện và thẩm định thiết kế chi tiết:*

1. **Bóc tách God Component `chat-interface.tsx` (6,152 dòng) thành Kiến trúc 3 Tầng**:
   - **Tầng 1 (Core Engine)**: `AgentRuntime` thuần TypeScript không dính dáng React (chạy được trong Node/Vitest và Web Worker), quản lý state máy trạng thái và vòng lặp tool độc lập.
   - **Tầng 2 (React Adapter)**: Hook `useAgentRuntime(chatId)` kết nối qua `useSyncExternalStore` + selectors để chặn re-render lan truyền.
   - **Tầng 3 (UI Presentation)**: Các presentational components mỏng, chỉ nhận props và phát sự kiện.
2. **State Machine XState cho Turn Lifecycle**:
   - Chuyển toàn bộ luồng turn logic sang XState v5: `idle -> streaming -> awaiting_approval -> executing_tool -> resubmitting -> done/aborted/error`.
   - Loại bỏ triệt để nguy cơ stale closure khi người dùng đổi chat/workspace trong lúc đang chờ duyệt diff.
3. **Web Locks Multi-tab Concurrency**:
   - Sử dụng Web Locks API `navigator.locks.request('chat-runtime:' + chatId)` để đảm bảo chỉ có 1 tab duy nhất làm Leader runtime thực thi, các tab khác làm Observer hiển thị.
