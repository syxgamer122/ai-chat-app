# Báo cáo port bộ nhớ dài hạn & nền tảng → Vyen (đợt 1: P0-1 → P1-4)

Ngày: 2026-09-13 · Lỗi gốc: `fcb5a8d` → HEAD `036b765` (5 commit + 1 fix lint riêng `a1672a8`)

Đã hoàn thành: **P0-1 Recipes, P0-2 Sub-recipes, P0-3 Skills + .vyenhints, P1-4 Memory cấu trúc**.
Tạm dừng theo yêu cầu người dùng: P1-5 → P2-11 (Lead/Worker, Permissions 4 mode, Tool router,
Session/chat_recall, Scheduler, Headless CLI slash, Cost telemetry, ACP).

---

## P0-1 — RECIPES (commit `53dae8c`)

**File thêm**: `lib/recipes/{schema,render,parse,run,retry,structured,share,store,run-store,index}.ts`,
`components/recipes/recipes-panel.tsx`, `lib/cli/{recipe-runner,recipe-list}.ts`,
`tests/{recipes-core,recipes-run,cli-recipe-runner}.test.ts`, `.vyen/recipes/fix-tests.yaml`
**File sửa**: `lib/db.ts`, `app/api/chat/route.ts`, `app/page.tsx`, `components/{chat-interface,composer}.tsx`,
`lib/cli/cli-surface.ts`, `lib/prompt-library.ts`, `package.json` (+`yaml`, `pako`, `@types/pako`)

- **Dexie v12**: bảng `recipes` (id, title, format, content, source local/imported, updatedAt). Migration
  chỉ thêm bảng — rollback: xoá `version(12)` block, Dexie tự drop bảng không khai báo.
- **Schema zod**: đúng đặc tả (version literal "1.0.0", title/description bắt buộc, instructions XOR prompt,
  parameters 4 input_type + 3 requirement, tools allow/deny, mcp, settings, response.json_schema,
  retry {max_retries, timeout_seconds, checks[], on_failure}, sub_recipes path|inline). Strict — field lạ bị chặn.
- **Template engine one-pass**: `{{ param }}`, `{{ recipe_dir }}`, `{{#if x}}…{{/if}}`; giá trị tham số
  KHÔNG BAO GIỜ bị parse lại (chống template-injection — có test khóa).
- **Retry**: state machine thuần `nextRetryAction` — pass/retry/stop; tổng lượt = 1 + max_retries;
  check destructive không auto-retry (tái dùng DESTRUCTIVE_COMMAND_RE của debug-loop); checksBlocked
  (user deny) → dừng không retry mù. UI chạy checks qua `autoApproveShell` + `bridge.shell.run` —
  KHÔNG bypass phê duyệt.
- **Structured output**: extract JSON (fenced + balanced-brace, xử lý ngoặc trong chuỗi) → validate tập con
  JSON Schema (type/required/properties/items/enum) → in MỘT DÒNG JSON (CI parse được).
- **Share link**: deflate + base64url vào `?recipe=`; decode qua schema; link chỉ MỞ PREVIEW trong panel —
  không gì chạy tới khi user bấm Run (chống prompt-injection qua link). Param bị xoá khỏi URL sau decode.
- **Route**: `body.recipe` (instructions + jsonSchema + toolDeny/Allow) — không route mới. Tool policy lọc
  clientToolNames + native spread; deny được cả `delegate`.
- **UI**: RecipesPanel (list Dexie + workspace `.vyen/recipes`, form tham số render theo input_type,
  Run/Export .yaml/Copy link/Import file+link); slash menu "/" gộp recipe (icon chef-hat — thay emoji 🍳
  theo antislop; chọn mở panel thay vì chèn text); TaskMenu "Recipes"; runner attempt→checks→retry reset
  context về snapshot; phiên từ recipe đặt title "🍳 <tên>"; annotation `recipeResult` 1 dòng.
- **CLI**: `vyen run --recipe <file> --params k=v [--output json|text] [--no-session] [--model]` và
  `vyen recipe list|run`. Exit code: 0 pass / 1 checks fail / 2 lỗi cấu hình. Recipe mẫu `.vyen/recipes/fix-tests.yaml`
  (param path, retry 3, check npm test).
- **Acceptance**: chạy từ UI ✓ (runner); CLI ✓ (`vyen recipe list` + `run --recipe fix-tests.yaml --params path=tests`
  vào đúng attempt 1/4). GUI-test full-flow recipe từ UI chưa chạy bằng user — cần verify `npm run app`.
- **Test**: 67 test mới.
- **Lỗi gặp**: pako `inflate(bytes, {to:'string'})` trả byte-array trong bản này → thay bằng `TextDecoder`.

## P0-2 — SUB-RECIPES (commit `3e218aa`)

**File thêm**: `lib/recipes/{subrecipe,subrecipe-exec}.ts`, `tests/recipes-subrecipe.test.ts`,
`.vyen/recipes/audit-suite.yaml`

- Mỗi sub-recipe → tool `subrecipe__<name>` (zod sinh từ parameters; fixedValues LOẠI khỏi schema —
  model không đè được giá trị recipe cha gắn cứng) + tool `subrecipe__batch` (1-8 calls, validate tên +
  không trùng, kết quả giữ đúng thứ tự).
- **Parallel cap 3** qua `runPool` (orchestrator/scheduler — semantics allSettled có sẵn, khớp
  SUBAGENT_PARALLEL_CONCURRENCY). Ngân sách spawn dùng chung `subagent-budget`.
- **Chặn đệ quy**: schema cấm inline chứa sub_recipes (superRefine); subagent là leaf worker — không
  `delegate`, không `subrecipe__*` trong bộ tool của nó.
- **return_mode**: `summary` (default — subagent tự tóm tắt, cứng 2.000 ký tự + ghi chú) | `full`.
- **Client resolve lúc Run**: inline parse / path đọc qua fs máy user (desktopFsRead / FSA); sub-recipe hỏng
  chặn Run với lỗi rõ (không chạy dở).
- **UI cards**: annotation `{subagent:{task:'subrecipe:<name>', taskIndex, taskTotal}}` — tái dùng
  subagent-card.tsx hiện có; Stop abort lan qua `link.signal` → AbortController → relay.
- **Demo**: `.vyen/recipes/audit-suite.yaml` (3 sub-recipe parallel: lint/test/deps).
- **Test**: 14 test mới. GUI-test 3-card song song chờ user chạy `npm run app`.

## P0-3 — SKILLS + `.vyenhints` (commit `c644aae`)

**File thêm**: `lib/skills/{disk,client-adapters,disk-store}.ts`, `components/settings-skills.tsx`,
`tests/skills-disk.test.ts`, `.vyen/skills/deploy-flow/SKILL.md`
**File sửa**: `lib/ipc.cjs` (2 lệnh bridge), `lib/desktop-bridge.ts`, `lib/{store,tool-catalog,auto-pilot}.ts`,
`app/api/chat/route.ts`, `components/{chat-interface,settings-dialog}.tsx`

- **Progressive disclosure** (đúng spec, KHÔNG nhồi skill vào system prompt): prompt chỉ chứa BẢNG
  `[SKILLS (chỉ mục)]` name + mô tả + nguồn; nội dung chỉ vào context khi model gọi `skill_load` —
  tool client đọc SKILL.md ở máy user + liệt kê file phụ (agent tự fs_read).
- **Quét**: `.vyen/skills/<dir>/SKILL.md` (web FSA + desktop bridge) và `~/.vyen/skills/` (bridge lệnh
  `vyen:home-skills-list/read` — name chặn regex, chỉ đọc đúng thư mục đó, không mở fs tùy ý).
  Trùng tên workspace > global.
- **Front-matter**: name/description/version/allowed_tools (YAML giữa 2 dòng `---`, CRLF chuẩn hoá).
- **`.vyenhints`**: fallback `AGENTS.md`; trần 8.000 ký tự; chip
  "hints loaded" trên UI click xem nguyên văn. Merge order theo spec: hints < skills < lessons < recipe
  (hints + skill index chèn TRƯỚC các khối đó trong composedSystem).
- **UI Settings → tab Skills**: liệt kê + bật/tắt từng cái (persist `disabledSkills` trong localStorage
  settings), scaffold "Tạo skill mới" ghi `.vyen/skills/<name>/SKILL.md` vào workspace.
- `skill_load` vào TOOL_CATALOG nhóm fs_read (auto-approve read-only; parity CLIENT_TOOL_DEFS).
- **Skill mẫu**: `.vyen/skills/deploy-flow/SKILL.md` cho acceptance ("agent không thấy nội dung cho tới
  khi gọi skill_load") — cần GUI-verify.
- **Test**: 19 test mới.
- **Ghi chú kỹ thuật**: react-hooks v7 immutability cấm mutate ref trong callback → scan nằm trong
  useEffect + store zustand (`useDiskSkillsStore`) đọc qua getState.

## P1-4 — MEMORY CÓ CẤU TRÚC (commits `2db62f7` + `036b765`)

**File thêm**: `lib/memory/{agent-memory,agent-memory-client}.ts`, `components/settings-agent-memory.tsx`,
`tests/agent-memory.test.ts`
**File sửa**: `lib/db.ts`, `lib/{agent-tools,tool-catalog,auto-pilot}.ts`, `lib/ipc.cjs` (+2 lệnh),
`lib/desktop-bridge.ts`, `app/api/chat/route.ts`, `components/{chat-interface,settings-dialog}.tsx`,
3 file test lock số tool

- **Dexie v13**: bảng `agentMemories` (id, category, scope, workspaceKey, createdAt, *tags) — tách biệt
  hệ reviewer-gate v11 (hệ này là kho ghi nhanh do tool ghi, không qua duyệt).
- **4 tool bộ nhớ**: `remember_memory(category, data, tags, is_global)` /
  `retrieve_memories(query|category|tags)` / `remove_memory_category(category)` /
  `remove_specific_memory(id)` — client tool, CRUD Dexie renderer. retrieve read-only auto-approve;
  3 tool ghi thuộc WRITE_TOOLS (phải duyệt). Trần 2.000 ký tự/entry (nâng từ 400).
- **Inject theo ngân sách**: block index (category · số entry · tags) + TOÀN BỘ memory global ngắn;
  trần 4.000 ký tự — vượt thì index-only, agent tự `retrieve_memories`. Scope-aware: global luôn vào,
  local theo workspaceKey. `lesson_save` KHÔNG phá: category "lesson" của bảng mới ghép vào mảng
  memories với prefix `[LESSON:pattern]` — đi tiếp đường formatLessonsBlock cũ.
- **Mirror file**: `.vyen/memory/<category>.md` (workspace, cả web FSA lẫn desktop) +
  `~/.vyen/memory/<category>.md` (bridge `vyen:home-memory-read/write`, category chặn regex).
  Sửa tay file → "Đọc lại file mirror" áp vào Dexie (id trong comment HTML `<!-- id: -->`).
- **UI Settings → Ghi nhớ**: xem/sửa/xoá entry, filter category/tag/query, xoá cả category,
  export JSON, nút đọc lại mirror.
- **Test**: 20 test mới + cập nhật 3 file test lock 24→29 tool.

---

## Trạng thái kiểm tra (tại HEAD `036b765`)

- `tsc --noEmit`: SẠCH.
- `eslint`: 0 error (3 warning `currentChat?.id` exhaustivedeps có sẵn từ trước đợt này).
- `next build`: PASS.
- `vitest run`: **2410+ pass / 2 fail** — cả 2 (`teamwork-adversarial-stress` CWD lockdown +
  `teamwork-engine-integrated` env scrubbing) đã verify FAIL TẠI HEAD GỐC bằng `git stash` (bug Windows
  path của teamwork sandbox, có từ commit teamwork cũ, không liên quan đợt này).

## Breaking changes + rollback

- KHÔNG breaking: mọi bảng Dexie mới (v12/v13) chỉ ADD; body mới của /api/chat đều optional; tool mới
  thuần thêm vào catalog. Rollback từng commit riêng lẽ được (git revert), riêng `npm install` cần
  chạy lại nếu revert P0-1 (deps yaml/pako).
- Test lock số tool 24→29 là thay đổi CÓ CẦN khi revert (3 file phải revert cùng).

## Còn nợ (chưa làm trong đợt này)

- P1-5 Lead/Worker + `/plan`, P1-6 Permissions 4 mode + per-tool + MCP whitelist, P1-7 Tool router +
  Code Mode, P2-8 chat_recall, P2-9 Scheduler, P2-10 slash commands chuẩn hoá (`/plan /mode /summarize
  /recipe /skills /memory /tools /cost`), P2-11 Cost telemetry, P3-12 ACP.
- GUI-test bằng user cho: recipe run từ UI (attempt→checks→retry), 3-card sub-recipe + Stop, skill_load
  theo deploy-flow, chip hints. Mở bằng `npm run app` (kịch bản: docs/FEATURE-TEST-GUIDE.md sẽ bổ sung).
- README mục Tính năng + Kiến trúc: cập nhật ở commit báo cáo này.
