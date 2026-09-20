# Kế hoạch Refactor UI & Settings — Vyen

> Tài liệu phân tích + kế hoạch thi công. Ngày lập: 2026-09-19.
> Phạm vi: toàn bộ bề mặt giao diện (`app/`, `components/`), trọng tâm là màn hình **Settings**
> và bố cục vùng **chat**.
> Mọi khẳng định trong tài liệu đều kèm `file:dòng` để kiểm chứng trực tiếp.

---

## Phần 0. Tóm tắt điều hành

Vyen là một sản phẩm **rất giàu tính năng** (hơn 40 nhóm năng lực, xem Phần 2) nhưng bề mặt
giao diện đang chịu ba khoản nợ kỹ thuật chồng lên nhau:

| # | Vấn đề | Mức độ | Bằng chứng đại diện |
|---|---|---|---|
| 1 | **Ba hệ thống thiết kế song song** trong cùng một app | Nghiêm trọng | Bề mặt chat dùng hex token (`#0d1116`, `#6a9fcc`); bề mặt Settings dùng Tailwind palette + `dark:` (`text-zinc-800`, `bg-white`); `AgentHud` dùng token shadcn không tồn tại (`bg-card`, `text-muted-foreground`) |
| 2 | **Kiến trúc thông tin của Settings bị dồn nén và trùng lặp** | Nghiêm trọng | Tab "Chung" chứa **14 khối cấu hình** độc lập, gồm cả bảng phân quyền tool (324 dòng) và panel MCP (578 dòng) |
| 3 | **Class CSS không tồn tại → render hỏng thật** | Cao | `claude-input` (6 chỗ), `bg-primary`/`text-primary-foreground`/`ring-primary` (6 chỗ), `no-scrollbar` (3 chỗ), ~15 token shadcn trong `agent-hud.tsx` |

**Nguyên nhân gốc (root cause):** dự án đã có một *hợp đồng thiết kế* được thực thi bằng test
(`tests/design-system.test.ts` → mảng `TOKENIZED_COMPONENTS`) và **bề mặt chat đã được migrate
theo hợp đồng đó**, nhưng **bề mặt Settings chưa bao giờ được đưa vào hợp đồng**. Kết quả là
hai nửa app nói hai ngôn ngữ thị giác khác nhau, và các class "mồ côi" không ai phát hiện vì
không có test nào chạm tới.

**Định hướng:** không viết lại UI. Chỉ cần (a) mở rộng hợp đồng token cho bề mặt Settings,
(b) tái cấu trúc IA của Settings thành các nhóm có nghĩa, (c) sửa các class hỏng, (d) dọn
overlay/z-index ở vùng chat. Toàn bộ thay đổi có thể chia thành 8 giai đoạn, mỗi giai đoạn
đều có tiêu chí nghiệm thu kiểm chứng được bằng test hoặc bằng mắt.

---

## Phần 1. Tổng quan dự án

### 1.1 Sản phẩm là gì

Vyen = **ứng dụng chat AI local-first** + **coding agent harness**.

- Chat: cây hội thoại phân nhánh, lưu trong IndexedDB (Dexie), không cần server DB.
- Agent: kết nối thư mục dự án trên máy, đọc/tìm/sửa file, chạy shell + git, nối MCP server,
  giao việc cho subagent — mọi thao tác ghi đều qua phê duyệt.
- Dual-mode: chạy được cả ở **web/desktop** (Next.js + launcher Edge/Chrome `--app`) và **CLI headless** (`bin/vyen.ts`).

### 1.2 Tech stack

| Tầng | Công nghệ |
|---|---|
| Framework | Next.js 16.3.1 (App Router, Turbopack) |
| UI | React 19.2.8, Tailwind CSS 3.4.19, lucide-react |
| Trạng thái | Zustand 5 (persist localStorage) |
| Lưu trữ | Dexie 4.4.5 (IndexedDB, schema 16+ phiên bản migration) |
| AI | AI SDK 4.3.19 + `@ai-sdk/openai` |
| Virtualization | `@tanstack/react-virtual` |
| Markdown | react-markdown + remark-gfm/math + KaTeX + Prism |
| MCP | `@modelcontextprotocol/sdk` (client trong Node bridge) |
| Test | Vitest 4 — **176 file test** |

### 1.3 Quy mô mã nguồn liên quan UI

| Khu vực | Số file | Số dòng |
|---|---|---|
| `components/` | 49 | **18.906** |
| `app/` (gồm API routes) | 17 | 5.547 |
| `lib/` | 258 | — |
| `tests/` | 177 | — |

Năm file UI lớn nhất:

| File | Dòng |
|---|---|
| `components/chat-interface.tsx` | **5.686** |
| `components/settings-dialog.tsx` | **1.671** |
| `components/composer.tsx` | 866 |
| `components/sidebar.tsx` | 608 |
| `components/recipes/recipes-panel.tsx` | 590 |
| `components/mcp/mcp-settings-panel.tsx` | 578 |

---

## Phần 2. Danh mục tính năng đầy đủ (Feature Inventory)

Bảng dưới liệt kê **toàn bộ năng lực hiện có** của dự án, kèm bề mặt UI tương ứng.
Cột "Bề mặt UI" cho biết người dùng chạm vào tính năng ở đâu — đây là đầu vào cho Phần 3.

### 2.1 Chat & hội thoại

| # | Tính năng | Mô tả | Bề mặt UI |
|---|---|---|---|
| 1 | Cây hội thoại phân nhánh | Mỗi tin nhắn là node; sửa tin cũ / regenerate tạo nhánh mới | `chat/message-item.tsx`, `branch-switcher.tsx` |
| 2 | Chuyển nhánh đa cách | Nút mũi tên, phím tắt, swipe mobile | `use-branch-keyboard-shortcuts.ts`, `use-swipe-branch.ts` |
| 3 | Local-first | Toàn bộ dữ liệu trong IndexedDB (Dexie), offline-capable | `lib/db.ts` |
| 4 | Đồng bộ đa-tab | BroadcastChannel + Lamport revision, fallback localStorage | `lib/chat-broadcast.ts`, `use-cross-tab-chat-sync.ts` |
| 5 | Tìm kiếm full-text tiếng Việt | Fold dấu ("hoa hau" → "Hoa Hậu"), gom nhóm theo ngày | `sidebar.tsx:281-318`, `lib/chat-search.ts` |
| 6 | Markdown + LaTeX + code highlight | KaTeX, Prism 18 ngôn ngữ, GFM, ảnh/bảng | `markdown-renderer.tsx`, `syntax-highlight.tsx` |
| 7 | Đính kèm tệp | Ảnh/PDF/text < 3MB, blob trong IndexedDB | `composer.tsx` (Paperclip) |
| 8 | Backup/Restore | Xuất/nạp `.json` (đầy đủ nhánh + tệp) hoặc `.md` | `settings-dialog.tsx` tab Dữ liệu, `lib/backup.ts` |
| 9 | BYOK | Dán API key riêng trong Settings (không persist) | `settings-dialog.tsx` tab Nhà cung cấp |
| 10 | Failover đa key + đa model | Xoay key theo health, chuỗi model thay thế | `lib/api-keys.ts` |
| 11 | Voice input | Web Speech API, chữ hiện realtime | `use-speech-recognition.ts` |
| 12 | PWA | Cài lên thiết bị, trang offline | `pwa-register.tsx`, `app/manifest.ts` |
| 13 | 32 model chat + 5 model media | Qua gateway tương thích OpenAI | `lib/models.ts`, `model-selector.tsx` |
| 14 | Thanh trượt suy luận | 4 mức low/medium/high/max theo metadata `/v1/models` | `thinking-menu.tsx` |
| 15 | Nén hội thoại (compaction) | Tự tóm tắt phần cũ khi gần trần ngữ cảnh | `lib/context-compaction.ts`, `/api/compact` |
| 16 | Đo ngữ cảnh | Thanh tiến trình ngữ cảnh | `context-meter.tsx` |

### 2.2 Agent coding

| # | Tính năng | Mô tả | Bề mặt UI |
|---|---|---|---|
| 17 | Kết nối workspace | File System Access API (browser) hoặc mở thư mục (desktop/CLI) | `composer.tsx` (FolderOpen) |
| 18 | Bộ tool `fs_*` | `fs_list`/`fs_read`/`fs_search`/`fs_edit`/`fs_write` chạy client-side | `lib/agent-tools.ts`, `lib/fs-access.ts` |
| 19 | Đọc thông minh | Trần 24.000 ký tự, phân trang `start_line`/`line_count` | `lib/fs-access.ts` |
| 20 | Sửa có kỷ luật | Khối SEARCH/REPLACE khớp nguyên văn, **bắt buộc đọc trước khi sửa** | `lib/edit-blocks.ts` |
| 21 | Chặn ghi đè file lớn | `fs_write` chặn ghi đè file > 200 dòng | `lib/path-guard.cjs` |
| 22 | Modal diff phê duyệt | Mọi ghi file đều hiện diff trước khi chạm đĩa | `diff-confirm.tsx` |
| 23 | Vision cho ảnh workspace | Ảnh .png/.jpg/.webp/.heic mô tả thành text | `lib/fs-vision.ts`, `components/settings-dialog.tsx` (VisionModelSection) |

### 2.3 Duyệt & tự động hoá

| # | Tính năng | Mô tả | Bề mặt UI |
|---|---|---|---|
| 24 | 4 chế độ phê duyệt | `Manual`(always) / `Smart` / `Autonomous`(never) / `Chat Only` | `settings-dialog.tsx:1261-1296`, `composer.tsx` TaskMenu |
| 25 | Bảng phân quyền per-tool | `auto`/`ask`/`deny`/`default` cho từng tool trong 8 nhóm | `tool-permissions-table.tsx` |
| 26 | Staging Sandbox | Ghi vào bộ đệm, review batch rồi Apply/Reject | `staging-panel.tsx` |
| 27 | Goal loop | Đặt mục tiêu, agent tự chạy tới marker `<goal-complete>` | `lib/goal-loop.ts` |
| 28 | Auto-debug | Lệnh test/build fail trả `retryGuidance`, tối đa 3 lần | `lib/debug-loop.ts` |
| 29 | Hard safety backstop | `rm -rf /`, `mkfs`, `shutdown` luôn bị chặn tự duyệt | `lib/auto-pilot.ts` |
| 30 | Checkpoint workspace | Lưu/khôi phục trạng thái trước khi ghi | `workspace-checkpoints.tsx` |

### 2.4 Shell & Git (bản desktop)

| # | Tính năng | Mô tả | Bề mặt UI |
|---|---|---|---|
| 31 | `shell_run` | Chạy cmd/sh sau khi duyệt, timeout 120s (max 600s) | `shell-confirm.tsx` |
| 32 | Cắt output thông minh | > 2000 dòng / 50KB giữ phần cuối, lưu temp + `savedTo` | `lib/agent-tools.ts` |
| 33 | Bộ tool git | `git_status`/`git_diff`/`git_log`/`git_add`/`git_commit` | `lib/agent-tools.ts` |

### 2.5 Bảo mật key & sandbox

| # | Tính năng | Mô tả | Bề mặt UI |
|---|---|---|---|
| 34 | Kho key mã hoá opt-in | safeStorage (DPAPI/Keychain/libsecret), IndexedDB chỉ giữ con trỏ `@secure:` | `provider-manager.tsx` |
| 35 | LLM fetch qua bridge | Gateway chặn origin trình duyệt không còn là rào cản | `lib/desktop-bridge.ts` |
| 36 | SecretRegistry | Che bí mật ở mọi đường vào model | `lib/secret-registry.ts` |
| 37 | Injection guard | Chống prompt-injection | `lib/injection-guard.ts` |

### 2.6 MCP & Tool Router

| # | Tính năng | Mô tả | Bề mặt UI |
|---|---|---|---|
| 38 | MCP server (stdio/SSE/HTTP) | Tool hiện dạng `mcp__<server>__<tool>` | `mcp/mcp-settings-panel.tsx` |
| 39 | Phê duyệt MCP 4 cấp | Cho phép lần này / Luôn cho phép / Từ chối lần này / Luôn từ chối | `mcp/tool-approval-dialog.tsx` |
| 40 | Whitelist `available_tools` | Giảm token ngữ cảnh, khoanh vùng tool | `mcp-settings-panel.tsx` |
| 41 | Tool Router BM25 | Lập chỉ mục toàn bộ tool, tự chọn **top-30** liên quan nhất | `lib/tool-catalog.ts` |
| 42 | Meta-tool `tools_search` / `tools_load` | Tìm & nạp động tool vào phiên | `lib/tool-catalog.ts` |
| 43 | Code Mode (`run_code`) | LLM viết JS gọi `mcp.call()` trong sandbox Node | `settings-dialog.tsx:1314-1335` |
| 44 | Vision cho ảnh MCP | Mô tả ảnh do MCP trả về (tối đa 4 ảnh/kết quả) | `lib/mcp/image-content.ts` |

### 2.7 Session management & ChatRecall

| # | Tính năng | Mô tả | Bề mặt UI |
|---|---|---|---|
| 45 | Gắn phiên với thư mục | Lưu `workspacePath` vào metadata; banner đề nghị kết nối lại | `chat-interface.tsx:5499-5525` |
| 46 | Đổi tên phiên | Double-click inline trên Sidebar, hoặc `/rename` trong CLI | `sidebar.tsx:183-201` |
| 47 | Resume phiên | Nút "Tiếp tục" + "Mở cửa sổ mới" | `sidebar.tsx:114-137` |
| 48 | `chat_recall(query, limit)` | AI tra cứu toàn bộ lịch sử phiên trong Dexie | `lib/chat-recall.ts` |

### 2.8 Scheduler

| # | Tính năng | Mô tả | Bề mặt UI |
|---|---|---|---|
| 49 | Cron 5 trường | Bước nhảy, khoảng, danh sách, alias `@daily`... | `scheduler/scheduler-panel.tsx` |
| 50 | Giải nghĩa tiếng Việt + mốc chạy kế tiếp | — | `scheduler-panel.tsx` |
| 51 | Thực thi ngầm | Timer tick 30s, tạo chat session chứa kết quả | `lib/scheduler/` |
| 52 | Bảng Dexie `schedules` (v16) | Đồng bộ 2 chiều Web UI ↔ bridge daemon | `lib/db.ts` |
| 53 | CLI `vyen schedule` | `list` / `run <id>` / `daemon` | `bin/vyen.ts` |

### 2.9 Bộ nhớ

| # | Tính năng | Mô tả | Bề mặt UI |
|---|---|---|---|
| 54 | Bộ nhớ có cấu trúc | `remember_memory`/`retrieve_memories`/`remove_*`, category + tags + scope | `settings-agent-memory.tsx` |
| 55 | Reviewer Gate | Agent chỉ **đề xuất** candidate; người dùng duyệt Nhớ/Từ chối/Hoãn | `settings-dialog.tsx:74-373` (`MemoriesSection`) |
| 56 | Mirror markdown | `.vyen/memory/<category>.md` + `~/.vyen/memory/` | `lib/memory/` |
| 57 | Zero-Mem | Trích xuất thực thể + đồ thị quan hệ **0 token**, < 2ms | `lib/zeromem/` |
| 58 | Dual-View Zero-Mem | Entity-Context Graph + Temporal Hierarchy (exponential decay) | `lib/zeromem/` |
| 59 | Dexie v17 | `zeromemTraces`, `zeromemEntities`, `zeromemRelations` | `lib/db.ts` |
| 60 | Lessons | `lesson_save` 3 loại (rule/pattern/gotcha), inject vào prompt phiên sau | `lib/lessons.ts` |

### 2.10 Skills & prompt

| # | Tính năng | Mô tả | Bề mặt UI |
|---|---|---|---|
| 61 | Skills dạng file | `.vyen/skills/<name>/SKILL.md` + `~/.vyen/skills/` | `settings-skills.tsx` |
| 62 | Chỉ mục tiết kiệm token | Agent chỉ thấy tên + mô tả; nội dung nạp qua `skill_load` | `lib/skills/` |
| 63 | Skills cũ (legacy) | Lưu trong Dexie `db.prompts` với `mode: 'skill'` | `settings-dialog.tsx:473-662` |
| 64 | Slash command built-in | Danh sách lệnh hệ thống | `lib/slash-commands.ts` |
| 65 | Slash command tuỳ biến | Gán `/<tên>` → Recipe | `settings-dialog.tsx:666-831` |
| 66 | `.vyenhints` | Ngữ cảnh dự án tự nạp vào system prompt (fallback `AGENTS.md`, trần 8000 ký tự) | `chat-interface.tsx:5547-5569` |

### 2.11 Làm việc quy mô lớn

| # | Tính năng | Mô tả | Bề mặt UI |
|---|---|---|---|
| 67 | Subagent delegate | Context riêng, không đệ quy, mặc định 10 turns (max 25) | `subagent-card.tsx` |
| 68 | Subagent relay | Server phát annotation → renderer thực thi → POST kết quả | `/api/chat/subagent-relay` |
| 69 | Sub-recipes | Tool `subrecipe__<name>` + `subrecipe__batch` (song song cap 3) | `lib/recipes/` |
| 70 | Orchestrator sweep | Phân rã lưới N cấu hình chạy song song, chấm điểm, heatmap | `orchestrator/orchestrator-panel.tsx` *(dead code — xem §4.5)* |
| 71 | Plan & checklist | `plan_create`/`plan_update`, checklist tiến độ + progress bar | `plan-panel.tsx` |
| 72 | Plan Mode | Khoá agent ở chế độ chỉ-đọc tới khi chuyển sang Act | `composer.tsx` TaskMenu |
| 73 | Recipes | Workflow đóng gói: tham số, tool policy, retry, structured output | `recipes/recipes-panel.tsx` |
| 74 | Recipes headless | `npx tsx bin/vyen.ts run --recipe ... --output json`, exit code ≠ 0 khi fail | `bin/vyen.ts` |
| 75 | Chia sẻ recipe qua link | `?recipe=` — chỉ mở preview, không tự chạy | `app/page.tsx:98-117` |
| 76 | Sarsed-Code | AST skeletonizer (nén 80-90%), symbol index, transactional patcher, diagnostic engine, vòng lặp SARS | `lib/sarsed/` |
| 77 | Tool budget | Max 32 tool call/lượt, chặn gọi trùng tham số, phát hiện doom-loop | `lib/tool-call-budget.ts` |

### 2.12 Kiểm soát model

| # | Tính năng | Mô tả | Bề mặt UI |
|---|---|---|---|
| 78 | Lead/Worker routing | Model mạnh chạy vài lượt đầu rồi model rẻ; tự quay lại khi fail | `routing-settings-panel.tsx:311-436` |
| 79 | Mixture-of-Models | Chuỗi dự phòng `model:effort` theo từng hạng mục công việc | `routing-settings-panel.tsx:22-269` |
| 80 | Emulated tool-calling | Model không hỗ trợ function calling vẫn dùng được toàn bộ tool | `lib/emulated-agent.ts` |
| 81 | `/plan` | Planner model lập kế hoạch ở chế độ chỉ-đọc | `lib/slash-commands.ts` |

### 2.13 Hạ tầng

| # | Tính năng | Mô tả |
|---|---|---|
| 82 | Teamwork Multi-Agent Engine | DAG bền vững, checkpoint, HITL approval, strict tool contracts, bitemporal ledger (M1–M5, xem `PROJECT.md`) |
| 83 | CLI Vyen | `bin/vyen.ts` — chat, session, schedule, recipe run |
| 84 | Desktop launcher | `scripts/launch-desktop.cjs` — Edge/Chrome `--app`, tự dò cổng trống |
| 85 | 176 file test | Vitest, gồm test thực thi hợp đồng thiết kế |

---

## Phần 3. Bản đồ UI hiện tại

### 3.1 Cấu trúc tổng thể

```
app/page.tsx  (Home)
├── <Sidebar />                                   components/sidebar.tsx
│   ├── VyenLogo, nút "$ new session"
│   ├── BackupReminder
│   ├── ô tìm kiếm phiên
│   ├── danh sách phiên (gom nhóm theo ngày, cây thụt lề)
│   └── footer: nút đổi theme + nút Cài đặt
└── <ChatInterface />                             components/chat-interface.tsx  (5.686 dòng)
    ├── <StatusLine />          (header)          chat/status-line.tsx
    │   ├── ModelSelector        (portal z-50)
    │   ├── ThinkingMenu         (portal z-40)
    │   └── ChatExportMenu       (portal z-50)
    ├── <MessageList />  (virtualized)            chat/message-list.tsx
    │   └── <MessageItem />                       chat/message-item.tsx
    ├── banner kết nối lại workspace
    ├── <WorkspaceCheckpointBar />
    ├── <PlanPanel />
    ├── chip ".vyenhints"
    ├── banner recall memory
    ├── <Composer />                              composer.tsx
    │   └── TaskMenu (dropdown z-40) — 8 tính năng ẩn
    ├── <AgentHud />                              hud/agent-hud.tsx   ← RENDER HỎNG
    └── Overlay: DiffConfirm, ShellConfirm, McpToolApprovalDialog,
                 StagingPanel, ToolsPanel, RecipesPanel, ToastHost
```

### 3.2 Kiểm kê component theo số dòng

| Component | Dòng | Vai trò |
|---|---|---|
| `chat-interface.tsx` | 5.686 | God component: hydration, persist, edit/regenerate, branch, client tools, auto-pilot, goal loop, staging, MCP, memory, workspace, compaction |
| `settings-dialog.tsx` | 1.671 | Toàn bộ màn hình Settings (8 tab) |
| `composer.tsx` | 866 | Ô nhập liệu + TaskMenu |
| `sidebar.tsx` | 608 | Danh sách phiên |
| `recipes/recipes-panel.tsx` | 590 | Panel Recipes |
| `mcp/mcp-settings-panel.tsx` | 578 | Cấu hình MCP |
| `provider-manager.tsx` | 515 | Quản lý nhà cung cấp API |
| `scheduler/scheduler-panel.tsx` | 503 | Panel Scheduler |
| `chat/message-list.tsx` | 467 | Danh sách tin nhắn virtualized |
| `orchestrator/orchestrator-panel.tsx` | 461 | **Dead code** |
| `model-selector.tsx` | 456 | Chọn model |
| `markdown-renderer.tsx` | 437 | Render markdown |
| `routing-settings-panel.tsx` | 436 | Routing model |
| `chat/message-item.tsx` | 424 | Hàng tin nhắn |
| `thinking-menu.tsx` | 364 | Mức suy luận |
| `tool-permissions-table.tsx` | 324 | Bảng phân quyền tool |
| `fanout-board.tsx` | 302 | **Dead code** |
| `chat/tool-trace.tsx` | 296 | Vết tool call |
| `workspace-checkpoints.tsx` | 294 | Checkpoint |
| `tools-panel.tsx` | 273 | Panel công cụ |
| `chat/status-line.tsx` | 271 | Header |
| `settings-agent-memory.tsx` | 250 | Bộ nhớ có cấu trúc |
| `plan-panel.tsx` | 209 | Checklist kế hoạch |
| `staging-panel.tsx` | 189 | Staging sandbox |
| `settings-skills.tsx` | 177 | Skills trên đĩa |
| `usage-stats.tsx` | 153 | Thống kê token |
| `hud/agent-hud.tsx` | 127 | Telemetry HUD |

---

## Phần 4. Chẩn đoán chi tiết

### 4.1 Kiến trúc thông tin của Settings

#### 4.1.1 Tám tab, nhãn trộn hai ngôn ngữ

`components/settings-dialog.tsx:457-468`:

```ts
type SettingsTab = 'chung' | 'provider' | 'routing' | 'stats' | 'skills' | 'memory' | 'schedules' | 'data';
```

| id | Nhãn hiển thị | Ngôn ngữ |
|---|---|---|
| `chung` | Chung | Việt |
| `provider` | Nhà cung cấp | Việt |
| `routing` | **Routing** | Anh |
| `stats` | Thống kê | Việt |
| `skills` | **Skills** & lệnh | Anh + Việt |
| `memory` | Ghi nhớ | Việt |
| `schedules` | **Scheduler** | Anh |
| `data` | Dữ liệu | Việt |

→ Không nhất quán. Người dùng phải đoán "Routing" và "Scheduler" là gì.

#### 4.1.2 Tab "Chung" bị dồn 14 khối cấu hình không liên quan

Đây là vấn đề nặng nhất. Tab "Chung" (`settings-dialog.tsx:1156-1455`) chứa **tuần tự**:

| # | Khối | Dòng | Bản chất |
|---|---|---|---|
| 1 | Temperature | 1161-1177 | Tham số model |
| 2 | System Prompt | 1179-1190 | Tham số model |
| 3 | Bật/tắt công cụ (`agentTools`) | 1192-1209 | Quyền hạn |
| 4 | Đường tool giả lập | 1211-1234 | Gỡ lỗi kỹ thuật |
| 5 | Staging Sandbox | 1236-1259 | Quyền hạn |
| 6 | Approval Policy (4 chế độ) | 1261-1296 | Quyền hạn |
| 7 | **Bảng phân quyền per-tool** | 1299-1312 | Quyền hạn — **324 dòng riêng** |
| 8 | Code Mode | 1314-1335 | Tính năng nâng cao |
| 9 | **Panel MCP** | 1337 | MCP — **578 dòng riêng** |
| 10 | Enter để gửi | 1342-1358 | Nhập liệu |
| 11 | Steering / Follow-up mode | 1360-1396 | Nhập liệu |
| 12 | Nén tự động | 1398-1415 | Hiệu năng |
| 13 | Hiệu ứng chuyển động | 1417-1434 | Hiệu năng |
| 14 | Tần suất vẽ lại | 1436-1451 | Hiệu năng |

**Hệ quả:** người dùng muốn tắt hiệu ứng chuyển động phải cuộn qua **bảng 60+ tool** và
**panel MCP** để tới được. Chiều dài thực tế của tab này khi mở rộng đầy đủ ước tính
**> 2.500px** trên desktop.

Ba vấn đề cụ thể:

- **MCP nằm sai chỗ.** Cấu hình MCP server là một *tích hợp bên ngoài* (578 dòng component riêng),
  không phải "cài đặt chung".
- **Bảng phân quyền tool nằm sai chỗ.** Đây là bảng điều khiển bảo mật chi tiết, nên là màn
  hình riêng, không phải một khối trong tab "Chung".
- **Hiệu năng/UI nằm chung với bảo mật.** `animations`, `throttleMs` thuộc về "Giao diện",
  không thuộc "Công cụ & quyền".

#### 4.1.3 Ba cách trùng lặp để "tắt công cụ"

| Cách | Vị trí | Hành vi |
|---|---|---|
| `agentTools: false` | `settings-dialog.tsx:1202-1208` | Tắt toàn bộ công cụ (AI chỉ chat) |
| `approvalPolicy: 'chat_only'` | `settings-dialog.tsx:1286` | "Vô hiệu hoàn toàn toàn bộ công cụ (kể cả `fs_read`)" |
| `toolPermissions[tool] = 'deny'` | `tool-permissions-table.tsx` | Chặn từng tool |

Hai mục đầu **mô tả cùng một kết quả bằng hai từ khác nhau** ("Tắt: chat thuần" vs
"Chat Only — vô hiệu hoàn toàn"). Không có chỉ dấu nào cho người dùng biết chúng đồng nghĩa
hay khác nhau. Đây là nguồn gốc trực tiếp của cảm giác "khó hiểu".

#### 4.1.4 Hai nguồn sự thật cho chế độ phê duyệt

`settings-dialog.tsx:1273`:

```ts
value={settings.approvalPolicy ?? (settings.autoPilot ? 'smart' : 'always')}
```

và `settings-dialog.tsx:1276-1279`:

```ts
updateSettings({
  approvalPolicy: policy,
  autoPilot: policy === 'smart' || policy === 'never',
});
```

→ `autoPilot` là trường **dư thừa**, chỉ được suy ra từ `approvalPolicy`. Mọi logic đọc
`autoPilot` ở nơi khác sẽ lệch nếu người dùng đổi `approvalPolicy` bằng đường khác
(ví dụ từ TaskMenu trong `composer.tsx`). Cần hợp nhất về một trường.

#### 4.1.5 Bộ nhớ: hai hệ thống xếp chồng trong một tab

`settings-dialog.tsx:1533-1539`:

```tsx
{visited.has('memory') && (
  <div className={show('memory') ? 'contents' : 'hidden'}>
    <AgentMemorySection />      {/* Bộ nhớ có cấu trúc — lib/memory/agent-memory */}
    <div className="my-4 border-t border-zinc-200 dark:border-zinc-800" />
    <MemoriesSection />          {/* Reviewer Gate — db.memoryCandidates / db.memoryRecords */}
  </div>
)}
```

Hai mô hình dữ liệu khác nhau, hai từ vựng khác nhau ("Bộ nhớ có cấu trúc" vs
"Ký ức đã duyệt"), cùng nói về "bộ nhớ". Người dùng không có cách nào biết cái nào đang
thực sự được inject vào prompt.

#### 4.1.6 Skills: ba hệ thống trong một tab

`settings-dialog.tsx:1523-1531`:

```tsx
<DiskSkillsSection />          {/* .vyen/skills/SKILL.md — hệ mới */}
<div className="my-6 border-t ..." />
<LegacySkillsSection />        {/* tiêu đề: "Skills cũ (lưu trong trình duyệt)" */}
<div className="my-6 border-t ..." />
<CustomSlashCommandsSection /> {/* lệnh slash → recipe */}
```

Việc giữ "Skills cũ" là hợp lý để tương thích ngược, nhưng nó **ngang hàng thị giác** với
hệ mới → người dùng mới sẽ cấu hình sai hệ thống.

#### 4.1.7 Không có tìm kiếm cài đặt

Với 8 tab và hơn 40 điểm cấu hình, không có ô tìm kiếm nào trong Settings. Người dùng phải
nhớ cấu hình nằm ở tab nào.

#### 4.1.8 Tab panel khai báo ARIA sai

`settings-dialog.tsx:1127-1146` — mỗi tab khai `aria-controls={`settings-panel-${t.id}`}`.

`settings-dialog.tsx:1150-1155` — nhưng chỉ có **một** phần tử `role="tabpanel"` duy nhất,
và `id` của nó **thay đổi theo tab đang chọn**:

```tsx
<div
  role="tabpanel"
  id={`settings-panel-${tab}`}
  aria-labelledby={`settings-tab-${tab}`}
  className="settings-panel min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6"
>
```

→ Với 7/8 tab, `aria-controls` trỏ tới một `id` **không tồn tại**. Screen reader không
liên kết được tab với panel. Đây là lỗi ARIA thật, không phải vấn đề thẩm mỹ.

#### 4.1.9 Đường phân cách mục không bao giờ được vẽ

`app/globals.css:408-410`:

```css
.settings-panel > * + * {
  @apply mt-5 border-t border-[#495059] pt-5;
}
```

Nhưng con trực tiếp của `.settings-panel` là các wrapper `<div className={show(t) ? 'contents' : 'hidden'}>`.
- Wrapper đang active có `display: contents` → **không sinh box**, nên `border`/`margin`/`padding`
  của chính nó không được vẽ (đúng theo CSS spec).
- Wrapper không active có `display: none` → cũng không vẽ.

→ Quy tắc này **không có tác dụng thị giác** trong mọi trường hợp. Các khối cấu hình trong
Settings đang dính vào nhau không có đường phân cách, đúng như cảm nhận "bố cục lộn xộn".

### 4.2 Ba hệ thống thiết kế song song

#### 4.2.1 Hệ 1 — Design token hex (DESIGN.md), dùng ở bề mặt chat

`DESIGN.md` + `app/globals.css:19-127` định nghĩa bảng màu chuẩn:

`#0d1116` `#161d27` `#212730` `#252f3d` `#495059` `#757d89` `#ebe7e4` `#9fa4ab`
`#6a9fcc` `#4b607c` `#5db87a` `#e8993a` `#e8704f` `#1c2128`

`tailwind.config.ts:33-76` đã ánh xạ chúng thành token (`bg-deep`, `panel-bg`, `border-hairline`,
`text-primary`, `accent-steel`...) và `tailwind.config.ts:77-101` khoá `borderRadius`/`boxShadow` về 0.

`components/sidebar.tsx` là ví dụ mẫu mực: **91 lần** dùng hex đúng bảng, 0 class palette.

#### 4.2.2 Hệ 2 — Tailwind palette + `dark:`, dùng ở bề mặt Settings

Số liệu đo được:

| File | Dòng | hex | Tailwind palette | `dark:` |
|---|---|---|---|---|
| `settings-dialog.tsx` | 1.671 | 15 | **248** | **84** |
| `tool-permissions-table.tsx` | 324 | 0 | **62** | **28** |
| `mcp/mcp-settings-panel.tsx` | 578 | 1 | **55** | 0 |
| `scheduler/scheduler-panel.tsx` | 503 | 2 | **56** | 0 |
| `routing-settings-panel.tsx` | 436 | 4 | **44** | 0 |
| `settings-agent-memory.tsx` | 250 | 0 | **40** | **16** |
| `settings-skills.tsx` | 177 | 0 | **32** | **11** |
| `usage-stats.tsx` | 153 | 0 | **25** | 0 |
| `provider-manager.tsx` | 515 | 2 | **41** | 6 |
| `hud/agent-hud.tsx` | 127 | 0 | **15** | 0 |
| — so sánh — | | | | |
| `recipes/recipes-panel.tsx` | 590 | **77** | 0 | 0 |
| `tools-panel.tsx` | 273 | **26** | 0 | 0 |
| `orchestrator/orchestrator-panel.tsx` | 461 | **103** | 4 | 0 |

**Vì sao điều này trông tệ dù app là dark-only:** app gắn cứng `class="dark"` trước first-paint
(`app/layout.tsx:46,52`; `app/page.tsx:39-41`), `color-scheme: dark` (`globals.css:69,126`), và
thang `zinc` được **remap** qua CSS var (`tailwind.config.ts:11-17`, `globals.css:57-67,114-124`)
nên `text-zinc-700` render ra `#ebe7e4`.

Nghĩa là **mỗi class sáng đều phụ thuộc vào một override `dark:` để đúng**. Hệ quả:
- Nửa chuỗi class là **dead code** (`bg-white dark:bg-zinc-900` → chỉ vế sau chạy).
- Chỗ nào **quên** `dark:` là hỏng ngay. Ví dụ `settings-dialog.tsx:533`:
  `className="text-sm font-semibold text-zinc-800"` — không có `dark:`, may mắn là `zinc-800`
  được remap nên vẫn đọc được. Nhưng `settings-dialog.tsx:146`:
  `bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300` thì vế `bg-red-50` là nền đỏ nhạt
  vô nghĩa trong theme tối.
- **Nút sidebar đổi theme** (`sidebar.tsx:267-276`, `cycleTheme` xoay `light → dark → system`)
  đang tồn tại nhưng app đã commit dark-only (`app/page.tsx:34-41` luôn `add('dark')`).
  Nếu theme sáng được bật thật, toàn bộ bề mặt Settings sẽ vỡ vì mọi thứ đều dựa vào `dark:`.

#### 4.2.3 Hệ 3 — Token shadcn không tồn tại (`agent-hud.tsx`)

`components/hud/agent-hud.tsx` dùng các class **không hề được định nghĩa** trong
`tailwind.config.ts`:

| Dòng | Class |
|---|---|
| 24 | `border-border/50`, `bg-background/90`, `text-muted-foreground` |
| 45 | `bg-muted`, `text-muted-foreground`, `border-border/60` |
| 53 | `border-border/40`, `bg-card/40`, `hover:border-border/80` |
| 56 | `text-foreground` |
| 57 | `text-primary` |
| 60, 61 | `text-muted-foreground/60`, `text-muted-foreground` |
| 65 | `bg-secondary/80`, `text-secondary-foreground` |
| 82, 88, 101, 107 | `text-muted-foreground`, `text-foreground` |

`tailwind.config.ts:33-76` **không có** `background`, `card`, `primary`, `secondary`, `muted`,
`border`, `foreground`. Các class này sinh CSS rỗng.

→ `AgentHud` (mount tại `chat-interface.tsx:5657`) render **không nền, không viền, màu chữ kế thừa**.
Nó còn dùng Tailwind palette (`blue-500`, `amber-500`, `emerald-500`, `red-500` ở dòng 46-49) —
vi phạm bảng màu DESIGN.md.

#### 4.2.4 Class "mồ côi" khác — render hỏng thật

| Class | Số chỗ | Vị trí | Hệ quả |
|---|---|---|---|
| `claude-input` | 6 | `settings-agent-memory.tsx:122,133,146,165`; `settings-skills.tsx:155,163` | Input **không viền, không nền, không padding** — trông như text trần |
| `bg-primary`, `text-primary-foreground`, `ring-primary`, `border-primary` | 6 | `routing-settings-panel.tsx:146,163,200,213,297,354` | Chip "category" đang chọn và thông báo import **không có màu** |
| `no-scrollbar` | 3 | `chat/status-line.tsx:119`; `settings-dialog.tsx:1123`; `sidebar.tsx:480` | Thanh cuộn vẫn hiện ở dải tab Settings và status line |
| token shadcn | ~15 | `hud/agent-hud.tsx` | Như §4.2.3 |

Đây là **lỗi hiển thị đang xảy ra**, không phải vấn đề thẩm mỹ chủ quan. Sửa chúng là
"quick win" có tỉ lệ đòn bẩy cao nhất.

### 4.3 Hợp đồng thiết kế đang bị bỏ dở

`tests/design-system.test.ts:25-50` định nghĩa `TOKENIZED_COMPONENTS` — danh sách các file
**bắt buộc** chỉ dùng hex trong bảng DESIGN.md và **cấm** dùng họ màu Tailwind:

```
composer.tsx, thinking-menu.tsx, model-selector.tsx, chat-export-menu.tsx,
sidebar.tsx, branch-switcher.tsx, staging-panel.tsx, plan-panel.tsx,
tools-panel.tsx, subagent-card.tsx, diff-confirm.tsx, shell-confirm.tsx,
workspace-checkpoints.tsx, context-meter.tsx, backup-reminder.tsx,
chat/message-list.tsx, chat/message-item.tsx, chat/message-usage.tsx,
message-status-badge.tsx, chat/status-line.tsx, chat/tool-trace.tsx,
chat/orchestrator-badge.tsx, app/globals.css, app/layout.tsx
```

Hai test thực thi hợp đồng (`design-system.test.ts:146-165`):

- `bề mặt chat + composer chỉ dùng hex trong bảng màu DESIGN.md mục 2`
- `bề mặt chat + composer không dùng họ màu Tailwind (red-500, zinc-400...)`

**Quan sát then chốt:** danh sách này **không có một file Settings nào**.
Không `settings-dialog.tsx`, không `tool-permissions-table.tsx`, không `provider-manager.tsx`,
không `mcp-settings-panel.tsx`, không `scheduler-panel.tsx`, không `agent-hud.tsx`.

→ Bề mặt Settings **chưa bao giờ được đưa vào hợp đồng**. Đây là lý do gốc rễ khiến nó
lệch chuẩn một cách hệ thống chứ không phải lẻ tẻ. Và đây cũng là **đòn bẩy lớn nhất**:
một khi thêm các file Settings vào `TOKENIZED_COMPONENTS`, test sẽ tự động chặn mọi
hồi quy trong tương lai.

### 4.4 Vấn đề khả năng tiếp cận (a11y)

| # | Vấn đề | Bằng chứng |
|---|---|---|
| 1 | `aria-controls` trỏ tới id không tồn tại cho 7/8 tab | `settings-dialog.tsx:1134` vs `1152` |
| 2 | Modal khai `aria-modal="true"` nhưng **không trap Tab** | `diff-confirm.tsx:64-65` (chỉ xử Escape + focus nút Discard), `shell-confirm.tsx:42-43`, `staging-panel.tsx:69-70` |
| 3 | `TaskMenu` khai `role="menu"`/`role="menuitem"` nhưng **không có điều hướng mũi tên** | `composer.tsx:174-268` — chỉ Escape + pointerdown ngoài |
| 4 | Bất nhất giữa các menu: `ThinkingMenu` làm đúng APG, `TaskMenu` thì không | `thinking-menu.tsx:284-350` vs `composer.tsx:174-268` |
| 5 | `AgentHud` có `aria-label` nhưng không có `role` | `agent-hud.tsx:22-24` |
| 6 | Các dải banner ngang là `<div>` trần, không nhóm ngữ nghĩa | `chat-interface.tsx:5499-5617` |
| 7 | Dòng gợi ý phím ở composer là text trần, không liên kết control | `composer.tsx:861-863` |

**Điểm làm tốt (giữ nguyên):** `ModelSelector` theo đúng APG (`aria-haspopup`, `aria-expanded`,
`aria-activedescendant`, điều hướng ↑↓/Home/End); `ThinkingMenu` có `role="menuitemradio"` +
`aria-checked`; `MessageList` có `role="log"` + `tabIndex={0}`; `ContextMeter` có
`role="progressbar"` đầy đủ `aria-value*`; `prefers-reduced-motion` (`globals.css:168-176`);
focus-visible toàn cục (`globals.css:162-165`); focus trap trong `SettingsDialog`
(`settings-dialog.tsx:991-1029`).

### 4.5 Vấn đề bố cục vùng chat

#### 4.5.1 Sáu dải ngang có thể chồng cùng lúc

Trong `chat-interface.tsx`, giữa MessageList và Composer có tới 6 khối đều dùng
`mx-auto max-w-thread`, không có cơ chế ưu tiên hay gom nhóm:

| Dải | Dòng |
|---|---|
| Banner kết nối lại workspace | 5499-5525 |
| WorkspaceCheckpointBar | 5528-5532 |
| PlanPanel | 5536-5543 |
| Chip `.vyenhints` | 5547-5569 |
| Banner recall memory | 5572-5617 |
| AgentHud | 5657 |

→ Khi agent đang bận, người dùng có thể thấy 4-5 dải xếp chồng, đẩy composer xuống thấp.

#### 4.5.2 Hỗn loạn z-index ở tầng overlay

| Overlay | z-index | Mount |
|---|---|---|
| DiffConfirm | `z-[100]` | `chat-interface.tsx:5660` |
| ShellConfirm | `z-[100]` | `:5661` |
| StagingPanel | `z-[100]` | `:5666-5674` |
| ToolsPanel | `z-[100]` | `:5675-5677` |
| RecipesPanel | `z-[100]` | `:5678-5682` |
| WorkspaceCheckpoints | `z-[100]` | nội bộ |
| **McpToolApprovalDialog** | **`z-[80]`** | `:5665` |
| ModelSelector portal | `z-50` | `status-line.tsx:131` |
| ChatExportMenu portal | `z-50` | `status-line.tsx:221` |
| ToastHost | `z-50` | `:5683` |
| ThinkingMenu portal | `z-40` | `status-line.tsx:209` |
| TaskMenu dropdown | `z-40` | `composer.tsx:851` |

Hai vấn đề:
- **`McpToolApprovalDialog` ở `z-[80]` thấp hơn 5 modal `z-[100]`.** Comment tại
  `chat-interface.tsx:5662-5664` nói event MCP đến từ Electron main "bất kể đang ở đâu" —
  nghĩa là nếu một `DiffConfirm` đang mở, hộp phê duyệt MCP **bị che khuất** và agent treo chờ.
- **Toast `z-50` ngang `ModelSelector`/`ChatExportMenu` `z-50`** → dropdown model có thể chồng lên toast.

Không có overlay manager; thứ tự chồng do thứ tự DOM quyết định.

#### 4.5.3 Composer: 8 tính năng ẩn sau một nút "…"

`composer.tsx:827-858` chỉ có 4 control hiển thị: Paperclip, FolderOpen, TaskMenu, Send.

Nhưng `TaskMenu` (`composer.tsx:665-669`) chứa 3 nhóm, 8 mục:

| Nhóm | Mục |
|---|---|
| Chế độ | PLAN/ACT (`:544-555`), Auto-pilot cycle 4 policy (`:557-589`) |
| Tra cứu | 🌐 web search (`:591-602`) |
| Nâng cao | goal-loop (`:604-617`), staging (`:619-629`), ngắt workspace (`:631-641`), Công cụ & quyền (`:643-652`), Recipes (`:654-663`) |

Hai vấn đề:
- **Hai tầng ẩn.** Mỗi mục có `label` + `shortLabel` + `description` (`composer.tsx:150-166`) —
  người dùng phải mở menu để *khám phá*, rồi đọc để *hiểu*.
- **Nhóm "Nâng cao" trộn loại tác vụ.** Thao tác phiên (staging, ngắt workspace) nằm chung
  với cấu hình (công cụ & quyền, Recipes).
- **Model selector và ThinkingMenu không nằm trong composer** mà ở `StatusLine`
  (`status-line.tsx:131-142`, `:209-219`) — người dùng thường tìm chúng ở composer.
- **Không có nút mic** dù tính năng voice input tồn tại (`use-speech-recognition.ts`).

### 4.6 Vấn đề bảo trì

| # | Vấn đề | Bằng chứng |
|---|---|---|
| 1 | `chat-interface.tsx` là god component | **5.686 dòng**, 18 `useState`, **43 `useEffect`**, 64 `useCallback`, 11 `useMemo`, 17 `useRef` |
| 2 | Prop drilling nặng | `ComposerProps` ~30 prop (`composer.tsx:270-308`); `StatusLineProps` ~30 prop (`status-line.tsx:18-60`); `MessageListProps` ~24 prop (`message-list.tsx:92-139`) |
| 3 | Dead code | `FanoutBoard` (`fanout-board.tsx:39`) và `OrchestratorPanel`/`SweepHeatmap` (`orchestrator-panel.tsx:61`) **không được mount ở đâu** — riêng `OrchestratorPanel` chiếm `z-[110]` |
| 4 | Cờ mở panel rời rạc | `stagingPanelOpen`, `toolsPanelOpen`, `recipesPanelOpen`, `plan`/`planHidden`, `diffState`, `shellState` — không có overlay manager |
| 5 | Bug logic trong store | `lib/store.ts:308`: `settingsInitialTab: open ? undefined : undefined` — ternary chết, cả hai nhánh đều `undefined` |
| 6 | State module-level mutable | `HEIGHT_CACHE` Map cấp module (`message-list.tsx:16`), phải tự dọn tay |
| 7 | Inline IIFE tính toán trong JSX | `message-item.tsx:289-294,304-310,325-342,347-357` |
| 8 | Nút đổi theme không có tác dụng thật | `sidebar.tsx:267-276` xoay `light/dark/system` nhưng `app/page.tsx:39-41` luôn ép `dark` |

---

## Phần 5. Trạng thái mục tiêu (Target state)

### 5.1 IA mới của Settings — 6 nhóm

Nguyên tắc phân nhóm: **theo câu hỏi của người dùng**, không theo module kỹ thuật.

| Nhóm mới | Câu hỏi người dùng | Nội dung |
|---|---|---|
| **1. Giao diện & trải nghiệm** | "App trông và phản hồi thế nào?" | Temperature*, System Prompt, Enter để gửi, Steering/Follow-up, Nén tự động, Hiệu ứng chuyển động, Tần suất vẽ lại |
| **2. Model & Nhà cung cấp** | "Dùng AI nào, key nào?" | ProviderManager, Vision model, Access code, API key server, Lead/Worker routing, Mixture-of-Models |
| **3. Quyền & An toàn** | "Agent được phép làm gì?" | Chế độ phê duyệt (1 nguồn sự thật), Staging Sandbox, Bảng phân quyền per-tool, Code Mode, Đường tool giả lập |
| **4. Mở rộng** | "Nối thêm năng lực gì?" | MCP servers, Skills trên đĩa, Skills cũ (thu gọn), Lệnh slash |
| **5. Bộ nhớ** | "Agent nhớ gì về tôi?" | Bộ nhớ có cấu trúc, Reviewer Gate — **gộp thành một luồng duy nhất** |
| **6. Dữ liệu & Tự động hoá** | "Sao lưu và chạy theo lịch?" | Tự động sao lưu, Sao lưu & Phục hồi, Thống kê, Scheduler, Vùng nguy hiểm |

Thay đổi cụ thể:
- **Bỏ tab "Chung"** — dải nội dung của nó được phân bổ lại vào nhóm 1 và 3.
- **MCP ra khỏi tab "Chung"** → nhóm 4 "Mở rộng".
- **Bảng phân quyền tool** → nhóm 3, có tiêu đề rõ và **thu gọn mặc định**.
- **Hợp nhất `agentTools` + `approvalPolicy: 'chat_only'`** thành một lựa chọn duy nhất.
- **Hợp nhất `autoPilot` vào `approvalPolicy`** (giữ `autoPilot` như getter suy dẫn để
  không phá vỡ tương thích).
- **Gộp hai hệ bộ nhớ** thành một luồng: "Đề xuất đang chờ" → "Đã duyệt" → "Bộ nhớ chủ động".
- **Thêm ô tìm kiếm cài đặt** lọc theo nhãn + mô tả, nhảy tới mục khớp.
- **Thống nhất nhãn tiếng Việt**; thuật ngữ kỹ thuật giữ tiếng Anh trong ngoặc.

### 5.2 Một hệ thiết kế duy nhất

- **Nguồn sự thật:** bảng màu DESIGN.md (`#0d1116` … `#1c2128`).
- **Cách dùng:** ưu tiên token Tailwind đã có (`bg-deep`, `panel-bg`, `border-hairline`,
  `text-primary`, `accent-steel`); nếu buộc dùng hex thì phải thuộc bảng.
- **Cấm:** họ màu Tailwind (`zinc-*`, `sky-*`, `amber-*`, `red-*`, `emerald-*`...) trong
  các file thuộc `TOKENIZED_COMPONENTS`.
- **Bỏ dần:** mọi cặp `x dark:y` — chỉ giữ một vế.
- **Hợp đồng:** thêm toàn bộ file Settings vào `TOKENIZED_COMPONENTS` để test chặn hồi quy.

### 5.3 Chuẩn a11y

- Mỗi tab là một `role="tabpanel"` **riêng**, `id` ổn định, `aria-controls` khớp.
- Mọi modal: có focus trap thật (vòng Tab), `aria-modal="true"`, `role="dialog"`,
  `aria-labelledby` trỏ tới tiêu đề.
- Mọi `role="menu"` có điều hướng ↑↓/Home/End/Escape giống `ThinkingMenu`.
- Mọi nút icon-only có `aria-label`.
- Tương phản chữ ≥ 4.5:1 (test hiện có đã chặn `#55779b` — `design-system.test.ts:191-199`).

### 5.4 Overlay manager + thang z-index

| Tầng | z-index | Dùng cho |
|---|---|---|
| Nội dung nền | 0 | chat, sidebar |
| Dropdown/menu | 40 | TaskMenu, ThinkingMenu |
| Popover | 50 | ModelSelector, ChatExportMenu |
| Toast | 60 | ToastHost |
| Modal phê duyệt | 80 | DiffConfirm, ShellConfirm, McpToolApprovalDialog, StagingPanel |
| Modal điều hướng | 90 | ToolsPanel, RecipesPanel, WorkspaceCheckpoints |
| Hộp thoại hệ thống | 100 | Settings, confirm xoá |

Nguyên tắc: **một overlay manager duy nhất** quyết định cái nào đang mở, xếp hàng các
yêu cầu phê duyệt thay vì chồng lên nhau.

---

## Phần 6. Kế hoạch thi công theo giai đoạn

> Mỗi giai đoạn độc lập, có thể merge riêng. Thứ tự được chọn để **giá trị tăng dần và
> rủi ro giảm dần**: sửa cái đang hỏng trước, rồi mới tái cấu trúc.

---

### Giai đoạn 0 — Chuẩn bị & đo baseline

**Mục tiêu:** có số liệu trước/sau và lưới an toàn.

| Bước | Việc làm | File |
|---|---|---|
| 0.1 | Chạy `npm test` — ghi lại số test pass hiện tại (kỳ vọng 176 file) | — |
| 0.2 | Chạy `npm run lint` và `npm run typecheck` — lưu output baseline | — |
| 0.3 | Chạy `npm run dev`, chụp màn hình: Settings tab "Chung" (đầy đủ), tab "Ghi nhớ", tab "Skills & lệnh", AgentHud khi agent chạy | — |
| 0.4 | Viết script đếm class để đo tiến độ migrate | `scripts/audit-ui-tokens.cjs` (mới) |
| 0.5 | Tạo nhánh `refactor/ui-settings` | — |

**Script 0.4** — đếm và in ra bảng như §4.2.2, để mỗi giai đoạn sau chứng minh được
số hex/palette/`dark:` đã giảm.

**Tiêu chí nghiệm thu:** có baseline test + ảnh chụp + script đếm chạy được.

---

### Giai đoạn 1 — Sửa lỗi hiển thị đang xảy ra (quick wins)

**Mục tiêu:** hết render hỏng. Đây là giai đoạn **giá trị/chi phí cao nhất**.

| Bước | Việc làm | File:dòng |
|---|---|---|
| 1.1 | Thêm `.claude-input` vào `globals.css`, kế thừa `.field-sm` (viền `#495059`, nền `#0d1116`, focus `#6a9fcc`) | `app/globals.css` (`@layer components`) |
| 1.2 | Thêm `.no-scrollbar` (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`) | `app/globals.css` |
| 1.3 | Thay `bg-primary`/`text-primary-foreground`/`ring-primary`/`border-primary` bằng token Vyen (`bg-accent-steel`, `text-[#0d1116]`, `ring-[#6a9fcc]`) | `routing-settings-panel.tsx:146,163,200,213,297,354` |
| 1.4 | Viết lại `agent-hud.tsx` theo token Vyen: `bg-background` → `bg-[#161d27]`, `text-muted-foreground` → `text-[#9fa4ab]`, `border-border` → `border-[#495059]`, `bg-card` → `bg-[#212730]`, `bg-secondary` → `bg-[#252f3d]`; thay `blue-500`/`amber-500`/`emerald-500`/`red-500` bằng `#6a9fcc`/`#e8993a`/`#5db87a`/`#e8704f` | `hud/agent-hud.tsx:24,45-49,53,56-57,60-61,65,75,82,88,101,107` |
| 1.5 | Thêm `role="status"` (hoặc `role="region"` + `aria-label`) cho `AgentHud` | `hud/agent-hud.tsx:22-24` |
| 1.6 | Sửa `.settings-panel > * + *` — chuyển quy tắc phân cách vào **từng khối nội dung** thay vì wrapper, hoặc bỏ `display: contents` và dùng `block` cho wrapper đang active | `app/globals.css:408-410` + `settings-dialog.tsx` |
| 1.7 | Sửa bug ternary chết | `lib/store.ts:308` → `settingsInitialTab: open ? undefined : undefined` thành `set({ isSettingsOpen: open, settingsInitialTab: undefined })` |

**Kiểm chứng:** mở Settings → tab "Ghi nhớ" (input có viền), tab "Routing" (chip có màu),
chạy một tác vụ agent (AgentHud có nền + viền), dải tab Settings không còn thanh cuộn.

**Rủi ro:** thấp. Không đổi logic, chỉ đổi trình bày.

---

### Giai đoạn 2 — Đưa bề mặt Settings vào hợp đồng thiết kế

**Mục tiêu:** một hệ thiết kế duy nhất, được test bảo vệ.

| Bước | Việc làm |
|---|---|
| 2.1 | Thêm vào `TOKENIZED_COMPONENTS` (`tests/design-system.test.ts:25-50`): `settings-dialog.tsx`, `tool-permissions-table.tsx`, `provider-manager.tsx`, `mcp/mcp-settings-panel.tsx`, `scheduler/scheduler-panel.tsx`, `routing-settings-panel.tsx`, `settings-skills.tsx`, `settings-agent-memory.tsx`, `usage-stats.tsx`, `hud/agent-hud.tsx` |
| 2.2 | Chạy test → nó sẽ **fail** và liệt kê chính xác mọi class vi phạm (test đã in ra danh sách — `design-system.test.ts:155,163`) |
| 2.3 | Migrate từng file một, theo thứ tự nhỏ → lớn: `usage-stats` → `settings-skills` → `settings-agent-memory` → `tool-permissions-table` → `routing-settings-panel` → `mcp-settings-panel` → `scheduler-panel` → `provider-manager` → `settings-dialog` |
| 2.4 | Bảng ánh xạ khi migrate (xem dưới) |
| 2.5 | Xoá mọi cặp `x dark:y` — chỉ giữ một vế |
| 2.6 | Thêm `orchestrator/orchestrator-panel.tsx` vào danh sách **chỉ khi** đã quyết định giữ nó (xem Giai đoạn 6) |

**Bảng ánh xạ chuẩn khi migrate:**

| Class hiện tại | Token thay thế |
|---|---|
| `bg-white`, `bg-zinc-50`, `bg-zinc-100` | `bg-[#161d27]` (hoặc `bg-surface-raised`) |
| `bg-zinc-900`, `dark:bg-zinc-900` | `bg-[#212730]` (`bg-panel-bg`) |
| `bg-zinc-800` | `bg-[#252f3d]` (`bg-panel-soft`) |
| `border-zinc-200`, `border-zinc-300` | `border-[#495059]` (`border-border-hairline`) |
| `text-zinc-800`, `text-zinc-900` | `text-[#ebe7e4]` (`text-text-primary`) |
| `text-zinc-500`, `text-zinc-600` | `text-[#9fa4ab]` (`text-text-muted`) |
| `text-zinc-400` | `text-[#757d89]` (`text-border-hover`) |
| `bg-emerald-*`, `text-emerald-*` | `#5db87a` |
| `bg-amber-*`, `text-amber-*` | `#e8993a` |
| `bg-red-*`, `text-red-*` | `#e8704f` |
| `bg-sky-*`, `text-sky-*` | `#6a9fcc` |
| `bg-primary`, `text-primary-foreground` | `bg-[#6a9fcc]`, `text-[#0d1116]` |

**Kiểm chứng:** `npx vitest run tests/design-system.test.ts` → PASS; script đếm ở 0.4
báo `twPalette = 0` và `dark: = 0` cho mọi file trong danh sách.

**Rủi ro:** trung bình — khối lượng cơ học lớn (~600 class). Giảm thiểu bằng cách
migrate từng file và commit riêng.

---

### Giai đoạn 3 — Tái cấu trúc IA của Settings

**Mục tiêu:** Settings dễ hiểu, dễ tìm.

| Bước | Việc làm | File |
|---|---|---|
| 3.1 | Đổi `SETTINGS_TABS` thành 6 nhóm mới (§5.1), nhãn tiếng Việt thống nhất | `settings-dialog.tsx:457-468` |
| 3.2 | Sửa ARIA: render **mỗi tab một `role="tabpanel"` riêng** với `id` ổn định, `hidden` khi không active | `settings-dialog.tsx:1127-1166` |
| 3.3 | Tách khối "Chung" thành hai component mới: `SettingsAppearanceSection` (nhóm 1) và `SettingsSafetySection` (nhóm 3) | tách từ `settings-dialog.tsx:1156-1451` |
| 3.4 | Chuyển `<McpSettingsPanel />` từ tab Chung sang nhóm "Mở rộng" | `settings-dialog.tsx:1337` |
| 3.5 | Chuyển `<ToolPermissionsTable />` sang nhóm "Quyền & An toàn", **thu gọn mặc định** (dùng `<details>` hoặc accordion) | `settings-dialog.tsx:1299-1312` |
| 3.6 | Hợp nhất `agentTools=false` và `approvalPolicy='chat_only'` thành một lựa chọn "Chế độ Chat Only"; giữ `agentTools` như giá trị suy dẫn để không phá tương thích | `settings-dialog.tsx:1192-1209` + `1261-1296`, `lib/store.ts:152,180` |
| 3.7 | Hợp nhất `autoPilot` vào `approvalPolicy`; `autoPilot` trở thành getter suy dẫn (`approvalPolicy === 'smart' \|\| 'never'`) | `lib/store.ts:172`, `settings-dialog.tsx:1273-1279` |
| 3.8 | Gộp `AgentMemorySection` + `MemoriesSection` thành **một luồng 3 phần**: Đang chờ duyệt → Đã duyệt → Bộ nhớ chủ động | `settings-dialog.tsx:1533-1539` |
| 3.9 | Thu gọn `LegacySkillsSection` vào một khối "Skills cũ (trình duyệt)" mặc định đóng | `settings-dialog.tsx:1523-1531` |
| 3.10 | Thêm ô **tìm kiếm cài đặt** ở đầu dialog: lọc theo nhãn + mô tả, hiện kết quả nhảy tới mục | `settings-dialog.tsx` (mới) |
| 3.11 | Thêm mô tả 1 dòng dưới mỗi tiêu đề nhóm | `settings-dialog.tsx` |

**Kiểm chứng:**
- Tab "Chung" biến mất; mọi cấu hình cũ vẫn tìm được trong ≤ 2 click.
- Kiểm tra bằng screen reader: mỗi tab liên kết đúng panel.
- Gõ "hiệu ứng" vào ô tìm kiếm → nhảy tới "Hiệu ứng chuyển động".

**Rủi ro:** trung bình-cao — đụng vào store. Giảm thiểu: giữ tương thích ngược 100%
(các trường cũ vẫn đọc được), chỉ đổi cách trình bày.

---

### Giai đoạn 4 — Dọn vùng chat: overlay & composer

**Mục tiêu:** hết chồng lớp, composer dễ hiểu.

| Bước | Việc làm | File |
|---|---|---|
| 4.1 | Tạo `components/overlay-host.tsx`: một store Zustand `useOverlayStore` giữ `{ activeOverlay, queue }`, cấp z-index theo bảng §5.4 | mới |
| 4.2 | Chuyển 5 modal `z-[100]` + MCP dialog sang `OverlayHost`, xếp hàng thay vì chồng | `chat-interface.tsx:5660-5682` |
| 4.3 | **Nâng `McpToolApprovalDialog` lên tầng 80** và cho nó ưu tiên hơn modal thường (vì agent đang chờ) | `mcp/tool-approval-dialog.tsx:83` |
| 4.4 | Đưa `ToastHost` xuống tầng 60 để không chồng dropdown | `toast.tsx:27` |
| 4.5 | Gom 6 dải ngang thành **một vùng `StatusRail`** có thứ tự ưu tiên: lỗi > phê duyệt > kế hoạch > gợi ý | `chat-interface.tsx:5499-5617` |
| 4.6 | Tái cấu trúc `TaskMenu`: 2 nhóm rõ ràng — "Chế độ phiên" (PLAN/ACT, auto-pilot, web, goal-loop) và "Công cụ & mở rộng" (staging, công cụ & quyền, Recipes, ngắt workspace) | `composer.tsx:665-669` |
| 4.7 | Thêm nút **mic** vào composer (tính năng đã có, chỉ thiếu UI) | `composer.tsx:827-858` |
| 4.8 | Thêm điều hướng mũi tên cho `TaskMenu` (theo APG như `ThinkingMenu`) | `composer.tsx:174-268` |
| 4.9 | Cân nhắc đưa `ModelSelector` vào composer, hoặc thêm nhãn "model" rõ ở StatusLine | `composer.tsx`, `status-line.tsx:131` |

**Kiểm chứng:** mở `DiffConfirm` rồi kích hoạt phê duyệt MCP → hộp MCP hiện **trên**,
không bị che. Tab qua `TaskMenu` bằng phím mũi tên.

**Rủi ro:** trung bình — chạm vào luồng phê duyệt là luồng an toàn. Phải có test
`staging-panel-keyboard.test.ts` (đã có) và thêm test mới cho `OverlayHost`.

---

### Giai đoạn 5 — Hoàn thiện a11y

| Bước | Việc làm | File |
|---|---|---|
| 5.1 | Thêm focus trap thật cho `DiffConfirm`, `ShellConfirm`, `StagingPanel`, `ToolsPanel`, `RecipesPanel` — tái dùng logic đã đúng ở `SettingsDialog:991-1029`, tách thành hook `useFocusTrap` | `lib/hooks/use-focus-trap.ts` (mới) |
| 5.2 | Đảm bảo mọi modal có `role="dialog"` + `aria-modal` + `aria-labelledby` trỏ tới `<h2>` có thật | các modal |
| 5.3 | Thêm điều hướng bàn phím chuẩn cho mọi `role="menu"` | `composer.tsx`, `chat-export-menu.tsx` |
| 5.4 | Thêm `aria-label` cho mọi nút icon-only còn thiếu | rà soát toàn bộ `components/` |
| 5.5 | Thêm test a11y: assert mọi `role="tab"` có `aria-controls` trỏ tới id tồn tại; mọi modal có focus trap | `tests/a11y-contract.test.ts` (mới) |

**Kiểm chứng:** test mới PASS; điều hướng bằng Tab không thoát ra ngoài modal.

---

### Giai đoạn 6 — Giảm nợ bảo trì

| Bước | Việc làm | File |
|---|---|---|
| 6.1 | Xoá dead code: `fanout-board.tsx`, `orchestrator/orchestrator-panel.tsx`, `orchestrator/sweep-heatmap.tsx` (và test `fanout.test.ts` nếu chỉ phục vụ chúng) — **hoặc** quyết định mount chúng vào UI | — |
| 6.2 | Tách `chat-interface.tsx` theo cụm state, theo thứ tự an toàn: (a) `useChatPersistence`, (b) `useClientToolRunner`, (c) `useApprovalQueue`, (d) `useWorkspaceBanner` | `lib/hooks/` + `components/chat-interface.tsx` |
| 6.3 | Giảm prop drilling: tạo `ChatSessionContext` cho các prop dùng chung giữa `StatusLine`/`MessageList`/`Composer` | mới |
| 6.4 | Quyết định số phận nút đổi theme: hoặc bỏ, hoặc làm theme sáng thật (khi đó mọi `dark:` đã bị xoá ở GĐ2 sẽ phải kiểm lại) | `sidebar.tsx:267-276` |

**Rủi ro:** cao nếu làm 6.2 vội. Khuyến nghị làm 6.1 trước, 6.2 chia thành nhiều PR nhỏ,
mỗi PR chỉ tách **một** hook và chạy full test.

---

### Giai đoạn 7 — Chốt hợp đồng & tài liệu

| Bước | Việc làm |
|---|---|
| 7.1 | Chạy lại script đếm 0.4 — xác nhận `twPalette = 0`, `dark: = 0` trên toàn bộ bề mặt UI |
| 7.2 | Chạy `npm test` (kỳ vọng 176+ file PASS), `npm run lint`, `npm run typecheck` |
| 7.3 | Cập nhật `DESIGN.md`: thêm mục "Hợp đồng token" nêu rõ file nào bắt buộc, bảng ánh xạ §2.4 |
| 7.4 | Cập nhật `README.md`: mô tả IA Settings mới (6 nhóm) |
| 7.5 | Chụp ảnh before/after cho mỗi tab Settings |

---

## Phần 7. Ưu tiên & công sức

| Giai đoạn | Giá trị | Rủi ro | Phụ thuộc | Nên làm |
|---|---|---|---|---|
| 0. Baseline | Cao (đo lường) | Rất thấp | — | Ngay |
| 1. Sửa render hỏng | **Rất cao** | Rất thấp | GĐ0 | **Ngay** |
| 2. Token hoá Settings | Cao | Trung bình | GĐ1 | Ngay sau |
| 3. IA Settings | **Rất cao** | Trung bình-cao | GĐ2 | Ngay sau |
| 4. Overlay & composer | Cao | Trung bình | GĐ1 | Song song GĐ3 |
| 5. A11y | Trung-cao | Thấp | GĐ3, GĐ4 | Sau |
| 6. Nợ bảo trì | Trung | Cao | GĐ3, GĐ4 | Sau cùng |
| 7. Chốt hợp đồng | Trung | Rất thấp | Tất cả | Cuối |

**Khuyến nghị thứ tự thi công:** 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7.

Nếu chỉ có thời gian cho **một** giai đoạn, hãy làm **Giai đoạn 1** — nó sửa các lỗi
hiển thị đang xảy ra với chi phí thấp nhất. Nếu làm được **hai**, thêm **Giai đoạn 3** —
đó là giai đoạn giải quyết trực tiếp cảm nhận "lộn xộn, khó hiểu" mà người dùng báo.

---

## Phần 8. Tiêu chí hoàn thành (Definition of Done)

- [ ] `agent-hud.tsx` render có nền, viền, màu chữ đúng DESIGN.md.
- [ ] `.claude-input`, `.no-scrollbar` được định nghĩa; không còn class mồ côi trong `components/`.
- [ ] `routing-settings-panel.tsx` không còn `bg-primary`/`ring-primary`.
- [ ] Mọi file Settings nằm trong `TOKENIZED_COMPONENTS` và test PASS.
- [ ] Không còn cặp `x dark:y` trên bề mặt UI.
- [ ] Settings có 6 nhóm; tab "Chung" không còn tồn tại.
- [ ] Mỗi tab Settings có `role="tabpanel"` riêng với `aria-controls` hợp lệ.
- [ ] MCP nằm trong nhóm "Mở rộng", không nằm trong nhóm cấu hình chung.
- [ ] Chỉ còn **một** cách biểu đạt "tắt công cụ" và **một** nguồn sự thật cho chế độ phê duyệt.
- [ ] Settings có ô tìm kiếm hoạt động.
- [ ] Chỉ còn **một** hệ bộ nhớ hiển thị cho người dùng.
- [ ] `McpToolApprovalDialog` không bị modal khác che.
- [ ] Mọi modal có focus trap thật.
- [ ] `TaskMenu` điều hướng được bằng phím mũi tên.
- [ ] Dead code `FanoutBoard`/`OrchestratorPanel` được xoá hoặc mount.
- [ ] `npm test`, `npm run lint`, `npm run typecheck` đều PASS.

---

## Phụ lục A. Vị trí chính xác các lỗi cần sửa ngay

| Lỗi | File:dòng |
|---|---|
| `claude-input` không định nghĩa | `settings-agent-memory.tsx:122,133,146,165`; `settings-skills.tsx:155,163` |
| `no-scrollbar` không định nghĩa | `chat/status-line.tsx:119`; `settings-dialog.tsx:1123`; `sidebar.tsx:480` |
| Token `primary` không định nghĩa | `routing-settings-panel.tsx:146,163,200,213,297,354` |
| Token shadcn không định nghĩa | `hud/agent-hud.tsx:24,45,53,56,57,60,61,65,82,88,101,107` |
| Palette ngoài DESIGN.md trong agent-hud | `hud/agent-hud.tsx:46,47,48,49,75` |
| ARIA tabpanel sai | `settings-dialog.tsx:1134` vs `1152` |
| Đường phân cách không vẽ | `globals.css:408-410` |
| Ternary chết trong store | `lib/store.ts:308` |
| Hai nguồn sự thật approval | `lib/store.ts:172,180`; `settings-dialog.tsx:1273` |
| MCP trong tab "Chung" | `settings-dialog.tsx:1337` |
| Bảng quyền trong tab "Chung" | `settings-dialog.tsx:1299-1312` |
| MCP dialog z thấp hơn modal | `mcp/tool-approval-dialog.tsx:83` vs `chat-interface.tsx:5660` |
| Dead code không mount | `fanout-board.tsx:39`; `orchestrator/orchestrator-panel.tsx:61` |

## Phụ lục B. Lệnh kiểm chứng

```bash
npm test                                    # 176 file test
npx vitest run tests/design-system.test.ts  # hợp đồng thiết kế
npm run lint
npm run typecheck
npm run dev                                 # kiểm tra bằng mắt
node scripts/audit-ui-tokens.cjs            # script đo ở Giai đoạn 0.4
```
