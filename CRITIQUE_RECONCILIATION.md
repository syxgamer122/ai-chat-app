# ĐỐI SOÁT PHẢN BIỆN ↔ THỰC TẾ CODEBASE (VYEN)

> **Đối tượng bị phản biện**: `DOCS_TSX_ARCHITECTURE.md` v3.2
> **Đối tượng đối soát**: bản phản biện "Principal Architect" (mục A1–F)
> **HEAD kiểm chứng**: `77956a1` — "fix(build): sửa 5 lỗi chặn chạy app/test và đồng bộ số liệu tài liệu TSX"
> **Ngày đối soát**: 2026-09-23
> **Phương pháp**: đọc mã trực tiếp + đếm bằng `git ls-files` / `wc -l` / `rg`. Mọi kết luận dưới đây kèm `file:dòng` để tự kiểm chứng lại.

## 0. Ký hiệu phán quyết

| Ký hiệu | Nghĩa |
|---|---|
| ✅ **ĐÚNG** | Luận điểm đúng với thực tế, việc cần làm còn nguyên |
| ⚠️ **ĐÚNG MỘT PHẦN** | Cốt lõi đúng nhưng mô tả/đường đi không còn khớp code |
| ❌ **SAI** | Đã được xử lý đúng như đề xuất, hoặc mô tả không khớp code |
| 🕓 **CHƯA KIỂM CHỨNG** | Không đủ bằng chứng trong lần đối soát này |

**Kết luận ngắn**: bản phản biện có **giá trị phương pháp luận cao nhưng chẩn đoán đã lệch một thế hệ code**. 5/8 mục nhóm A (A1 phần lớn, A2, A4 phần lớn, A6, A7 phần lớn) **đã được xử lý** theo đúng hướng phản biện đề xuất. Rủi ro residual thật nằm ở những chỗ khác — đáng chú ý nhất là **cơ chế chống prompt-injection tồn tại nhưng chưa được nối dây (dead wiring)**, tức hệ thống đang *trông* có bảo vệ mà thực tế không kích hoạt.

---

## A. Nhóm an toàn

| # | Luận điểm phản biện | Phán quyết | Bằng chứng trong code | Residual thật còn lại |
|---|---|---|---|---|
| **A1** | Shell safety vẫn là denylist chuỗi → bypass được (backtick, `\n`, `#`, `<(…)`, `{a,b}`, `NODE_OPTIONS`, `LD_PRELOAD`, `git -c …`) | ⚠️ **ĐÚNG MỘT PHẦN** | `lib/shell-policy.cjs:1-11` mở đầu bằng *"Replaces naive string-based regex denylists with…"*: (1) tokenizer argv, (2) allowlist binary/subcommand, (3) `SAFE_ENV`, (4) `shell:false`. Tokenizer chặn `\r\n\0` (:47), backtick (:84 và :110), `$(` / `${` (:87, :113), `; & \| > < ( )` (:116), `#` (:119), quote chưa đóng (:126). `lib/ipc.cjs:596` → `spawn(bin, compiled.args, { shell:false })`. Git: `GIT_ALLOWED_SUBCOMMANDS` (:135) + `DANGEROUS_GIT_OPTIONS` `-c` / `--config` / `--config-env` / `--exec-path` / `--upload-pack` / `--receive-pack` (:148-157). `node`/`python` chỉ còn `--version` (:305-315). `getSafeEnv()` (:318-355) loại `node_*`, `git_*`, `npm_*`, `ld_*`, `dyld_*`, `python*`, `perl*`. `killProcessTree` (:360+) | **(a)** `getSafeEnv` **giữ nguyên `path` kế thừa** (:330 `'path'` nằm trong ALLOWED_ENV_VARS) → allowlist binary vẫn phụ thuộc PATH, không resolve đường dẫn tuyệt đối như phản biện yêu cầu; **(b)** runner nằm trong allowlist **thực thi code do agent viết**: `npm test\|build\|lint\|typecheck\|check` (:159) và `npx vitest\|jest\|eslint\|tsc\|prettier\|webpack` (:160) — `fs_write` + 1 lần duyệt là RCE trọn vẹn (đường đi khác phản biện mô tả, nhưng rủi ro là thật); **(c)** `lib/teamwork/sandbox/process-manager.ts:95`, `lib/teamwork/permission-broker.ts:456`, `lib/cli/cli-surface.ts:443` vẫn `shell: true`; **(d)** không có ranh giới OS (uid hạn chế / seccomp / Job Object / network) |
| **A2** | CWD jail bằng `validateSafeRelativePath` không chống được symlink / NFC-NFD / 8.3 / UNC / case-insensitive | ❌ **SAI** | `lib/path-guard.cjs` đã làm **đúng y đề xuất**: realpath root + target + truy ngược cha gần nhất cho file chưa tồn tại (:84-112), so lại `isWithinRoot` **sau** khi resolve (:113), chuẩn hoá NFC (:66), chặn absolute/drive-letter/UNC/NUL (:70-76), so sánh case-insensitive trên win32 (:20-26), denylist hai chiều `.git/**` + `node_modules/**` (:28-36, :114-120). Có test riêng `tests/path-guard.test.ts` | TOCTOU hẹp giữa `realpath` và `open`: **không** `O_NOFOLLOW`, **không** `lstat` từng thành phần (`rg "O_NOFOLLOW\|lstat" lib scripts components` = 0 hit). Lưu ý phản biện chọn nhầm hàm: `lib/path-utils.ts:26 validateSafeRelativePath` là kiểm tra chuỗi, nhưng nó chỉ dùng cho `cwd` của shell/auto-pilot (`lib/auto-pilot.ts:242`, `components/chat-interface.tsx:1137`), **không phải** lớp jail của desktop |
| **A3** | SHA-256 guard vẫn có cửa sổ TOCTOU: hash-then-write là hai syscall, không CAS | ⚠️ **ĐÚNG MỘT PHẦN** | Hash guard **có thật và đã chặn ghi**: `lib/fs-access.ts:440-478` (`crypto.subtle.digest('SHA-256', …)` + so `expectedBaseHash` + canonical `resolve()` handle check), `lib/staging.ts:31-50`, vòng apply `components/chat-interface.tsx:742-786` (giữ file xung đột lại trong staging để re-confirm) | **(a)** Không có CAS/khoá: `rg "navigator\.locks\|locks\.request"` = **0 hit** → không có Web Locks cũng như file lock; **(b)** chỉ so hash, **không** lưu `(size, mtimeMs, ino/dev)`; **(c)** ghi qua `handle.createWritable()` (`lib/fs-access.ts:487-489`) — không `tmp → fsync → rename`; **(d)** không verify lại hash sau khi ghi, không ghi kết quả vào audit log |
| **A4** | "Audit log bất biến" nằm trong Dexie thì không bất biến | ⚠️ **ĐÚNG MỘT PHẦN** (từ ngữ sai, kỹ thuật đã có) | `lib/audit-log.ts` **đã có hash chain**: `seq` + `prevHash` + `hash = SHA-256(prevHash \|\| canonicalJSON)` (:6-8, :212-244), hàng đợi tuần tự chống đua (:196-207), `verifyChain()` (:279), **disk anchor** nối `{seq,hash,ts}` ra `.vyen/audit/anchor.log` (:22, :258-259) | **(a)** Anchor nằm **trong workspace** (`.vyen/audit/`) — không "ngoài workspace root" và không phải `deny` tuyệt đối, chỉ là `ask` khi ghi `.vyen/**`; **(b)** có `prune` (:186) → chuỗi bị **cắt đầu**, cần xác nhận `verifyChain` xử lý đúng prefix đã prune; **(c)** không ký bằng OS keychain; **(d)** tài liệu dùng từ "bất biến / Immutable Audit Log" ở §1.3, §4-M2, §5#9, §6 → **phải đổi thành "tamper-evident"** |
| **A5** | Thiếu hoàn toàn mô hình đe doạ prompt injection (taint tracking) | ⚠️ **ĐÚNG về tài liệu — và có bug nặng hơn** | Cơ chế **tồn tại và đúng đặc tả phản biện**: `lib/taint-tracker.ts` (nhãn `untrusted`, `wrapUntrustedData` có delimiter + `SYSTEM_REMINDER`, `isEgressTool`, `checkAutoBudget` → hạ cấp sang `ask`); điểm thực thi `lib/auto-pilot.ts:225-235` (`isTurnTainted && isEgressTool` → ép hỏi); thêm lớp `lib/injection-guard.ts` + `lib/agent-tools.ts:14, 364-418, 1151` (lọc injection từ web, chặn web content ghi vào memory dài hạn) | **BUG THẬT**: `rg "taint\|UNTRUSTED"` ngoài `taint-tracker.ts` chỉ ra 2 dòng import ở `auto-pilot.ts` — **không có call site nào của `markTurnUntrustedInput()` và `wrapUntrustedData()`** ⇒ `isTurnTainted()` **luôn false** ⇒ egress guard + budget downgrade là **dead code**. Guard đang "diễn" chứ không chạy. Ngoài ra: `isEgressTool` nhận diện bằng `includes('push'\|'curl'\|'wget'\|'fetch'\|'http')` → bypass được; taint chỉ nằm in-memory, không persist, không ghi provenance vào audit log. **`DOCS_TSX_ARCHITECTURE.md` không nhắc injection/taint ở bất kỳ dòng nào** |
| **A6** | MCP thiếu chống rug-pull: "Luôn cho phép" rồi server đổi schema | ❌ **SAI** (đã làm đúng đề xuất) | `lib/mcp/ipc-handlers.cjs:75-93` `computeSchemaHash(tool)` = SHA-256 của `{ inputSchema, description }`; grant key `serverId:toolName:schemaHash` (:100, :148), policy **persist xuống đĩa** (:145-150, :245-250); `checkPolicy()` **tính lại hash mỗi lần gọi** (:159-166) ⇒ đổi schema là mất grant, bắt duyệt lại; approval **có timeout tự từ chối** (:9, :120-122); `lib/mcp/manager.cjs:79-91` (reconnect cap, `MAX_TOOLS_PER_SERVER = 200`, whitelist `available_tools` hỗ trợ glob), timeout call (:119, :262, :534) | **(a)** Không có màn hình liệt kê/thu hồi grant — dialog chỉ có 4 nút (`components/mcp/tool-approval-dialog.tsx:12, 37`); **(b)** chưa thấy trần kích thước output MCP; **(c)** chưa thấy sanitize env khi spawn stdio server |
| **A7** | "Luôn cho phép" không có phạm vi và hạn dùng | ⚠️ **ĐÚNG MỘT PHẦN** | Phạm vi **đã bị khoanh** ở 2 lớp: grant MCP gắn `(server, tool, schemaHash)` (A6), và `toolPermissions` per-tool/per-category có truyền `args` để quyết định (`lib/auto-pilot.ts:262-282` qua `getEffectiveToolPermission(toolName, permissions, args)`; bảng `lib/db.ts:340, 577-720` từ v14) | **(a)** Không có TTL cho grant đã persist (hiện vĩnh viễn cho tới khi schema đổi); **(b)** không có UI thu hồi; **(c)** chưa thấy scope theo workspace |
| **A8** | Bề mặt XSS ở tầng render (GFM + KaTeX + Prism) đọc sạch IndexedDB | ⚠️ **ĐÚNG MỘT PHẦN** | Sanitize **đã có và được đặt đúng chỗ**: `lib/rehype-sanitizer.ts` (sanitizer tự viết) chạy **TRƯỚC** `rehype-katex` — `components/markdown-renderer.tsx:18, 300-303`; **không** có `dangerouslySetInnerHTML` thật trong `components/` (hit duy nhất là mô tả rule ở `lib/security-sast.ts:347`); `rehype-raw` **không** có trong `package.json` | **(a) CSP = 0**: `rg "Content-Security-Policy"` = 0 hit, `next.config.js` chỉ có `allowedDevOrigins` → đây là lỗ còn thật; **(b)** đề xuất "API key không bao giờ vào renderer, proxy qua main process" **xung đột thiết kế hiện tại** (BYOK gửi header provider từ Web — README mục "LLM fetch qua Web/bridge") → cần quyết định kiến trúc, không phải bug |

---

## B. Kiến trúc & khả năng bảo trì

| # | Luận điểm | Phán quyết | Bằng chứng | Residual |
|---|---|---|---|---|
| **B1** | 12 file ≥400 dòng chiếm 64,6%; 18 file <100 dòng; nhiều module chứa business logic ẩn trong JSX | ✅ **ĐÚNG** | Đo lại: **đúng 12 file ≥400** (chat-interface 6.182, composer 1.067, sidebar 608, message-list 599, recipes-panel 583, mcp-settings-panel 578, provider-manager 516, scheduler-panel 503, model-selector 456, markdown-renderer 442, routing-settings-panel 436, message-item 424) = 12.394 dòng = **64,79%**; **đúng 18 file <100 dòng** | Không có residual tranh cãi — chỉ lưu ý tỉ lệ khác nhau tuỳ mẫu số (xem mục D3) |
| **B2** | Thiếu abstraction giữa Web-FSA và Desktop-IPC; cần ports/adapters + conformance test | ⚠️ **ĐÚNG MỘT PHẦN** | **Đúng**: tồn tại 2 implementation FS tách rời (`lib/fs-access.ts` cho FSA vs `lib/ipc.cjs` + `lib/path-guard.cjs` cho desktop), không có `FileSystemPort` / `ProcessPort` / `SecretsPort`, không có conformance test chạy chung. **Không đúng như lo ngại phân kỳ**: lớp policy desktop là **một bản duy nhất dùng chung** — `lib/shell-policy.cjs` được `lib/ipc.cjs` dùng, còn `lib/shell-policy.ts` chỉ là wrapper mỏng 35 dòng; đã có **một** precedent adapter: `lib/skills/disk.ts:120` (`DiskSkillAdapters`) | Thiếu hợp đồng port + conformance test vẫn là việc thật, và đúng như phản biện nói: nên làm **trước** khi bóc `chat-interface.tsx` |
| **B3** | Quy ước thư mục không nhất quán, cùng domain nằm 3 chỗ | ✅ **ĐÚNG** | Cùng domain Settings nằm rải: `components/settings/*.tsx` **và** `components/settings-skills.tsx`, `components/settings-agent-memory.tsx`, `components/provider-manager.tsx`, `components/routing-settings-panel.tsx`, `components/tool-permissions-table.tsx` (root). `lib/` có cặp song song `.ts`/`.cjs` (`shell-policy`, `path-guard` ↔ `path-utils`, `ipc.cjs` ↔ `desktop-bridge.ts`). Không có `dependency-cruiser` hay `eslint-plugin-boundaries` trong `package.json` | Chưa có gì ép boundary → sẽ tái phát |

---

## C. Dữ liệu & hiệu năng

| # | Luận điểm | Phán quyết | Bằng chứng | Residual |
|---|---|---|---|---|
| **C1** | 19 migration Dexie, không backup trước upgrade; local-first = lỗi migration là mất trắng | ✅ **ĐÚNG** | Đúng **19** `.version()` (`lib/db.ts`, bản cuối `:705` = v19). Có `this.on('blocked', …)` và `this.on('versionchange', …)` (`:772-775`) nhưng **không export snapshot trước khi mở DB**. `tests/fixtures/` chỉ có `mcp-demo-server.mjs` → **không có migration test bằng DB cũ thật** | Rủi ro mất dữ liệu nguyên vẹn; đây là P0 riêng của dòng local-first |
| **C2** | Xoá nhánh/chat để lại blob mồ côi trong IndexedDB | ⚠️ **ĐÚNG MỘT PHẦN** | Attachment lưu **inline trong message** (`lib/db.ts:69-90`, `sanitizeAttachments` :260-272) và có **cascade delete theo chat** (`:879-883` xoá `messages` + `wsSnapshots` theo `chatId`) ⇒ xoá chat **không** để lại blob mồ côi | Không có refCount/orphan sweep (`rg` = 0); không thấy đường xoá **nhánh** riêng; `navigator.storage.estimate()` không xuất hiện ở đâu (DataTab cũng không) |
| **C3** | `reconstructActiveThreadSafe` gọi lại ở nhiều consumer → O(n) mỗi render; cần selector memo + index `childrenByParentId` | ⚠️ **ĐÚNG MỘT PHẦN** | Chỉ có **3 call site thật**, tất cả ở `components/chat-interface.tsx:3618, 3867, 3961` (+ định nghĩa `lib/tree-utils.ts:245`). **`ContextMeter` không gọi nó** — `components/context-meter.tsx` là component presentational `memo` nhận `used/max` ⇒ mệnh đề "nhiều consumer (ContextMeter, MessageList, export…)" **sai**. Ngược lại, `DOCS_TSX_ARCHITECTURE.md` §5#12 biện minh bằng chính ContextMeter ⇒ **tài liệu sai** | `childrenByParentId` **không tồn tại** (`rg` = 0) → đổi nhánh vẫn dựng index mỗi lần; khuyến nghị selector memo vẫn còn giá trị |
| **C4** | Tách stream khỏi virtualizer chỉ sửa layout, không sửa re-render; cần external store + gộp theo rAF | ✅ **ĐÚNG** | `rg "useSyncExternalStore\|requestAnimationFrame"` trong `components/chat-interface.tsx` = **0 hit** → mỗi delta vẫn `setState` trên component 6.182 dòng | Nguyên vẹn |
| **C5** | Markdown re-parse toàn message mỗi token = O(n²) | ⚠️ **ĐÚNG MỘT PHẦN** | `MarkdownRenderer` **đã** là `memo` (`components/markdown-renderer.tsx:254`), `CodeBlock` cũng `memo` (`:196`) | Không có block-cache (`rg "cache"` trong renderer/preprocess = 0) và **không có `content-visibility`** anywhere → vẫn re-parse toàn bộ mỗi token |
| **C6** | `HEIGHT_CACHE` cần invalidate khi đổi font/zoom/theme, evict theo chatId | ⚠️ **ĐÚNG MỘT PHẦN** | **Font đã được xử lý**: `document.fonts.ready` → `HEIGHT_CACHE.clear()` + `rowVirtualizer.measure()` (`components/chat/message-list.tsx:374-382`) — phần "font" trong phản biện đã lỗi thời | Không có listener theo **zoom/theme**; không evict theo `chatId` khi xoá chat (chỉ có LRU 2.000 → `:68`) |

---

## D. Kiểm thử & tài liệu

| # | Luận điểm | Phán quyết | Bằng chứng | Residual |
|---|---|---|---|---|
| **D1** | "2.445 test pass" không chứng minh an toàn; cần fuzz/property, golden policy, e2e, mutation | ✅ **ĐÚNG** | Không có `fast-check` (property/fuzz) ở bất kỳ đâu; không có `stryker`/mutation trong `package.json`. **163 file `tests/*.test.ts`** — khớp đúng con số tài liệu | **2.456 test không xác nhận được** trong lần đối soát này (repo không có `node_modules`) → con số này hiện chỉ là *số liệu tài liệu*; cần chạy lại để biến thành bằng chứng |
| **D2** | Tài liệu là inventory, không phải architecture spec (thiếu C4 diagram, hợp đồng IPC, topology state, đặc tả `lib/`, error taxonomy, threat model, ADR) | ✅ **ĐÚNG** | `DOCS_TSX_ARCHITECTURE.md` không có sơ đồ C4, không đặc tả `lib/*` (nơi chứa toàn bộ logic nguy hiểm), không threat model, không ADR, không error taxonomy | Thêm bằng chứng phụ: `docs/harness-port-handoff.md` **bị hỏng nội dung** (2 dòng, toàn ký tự lặp) — độ tin cậy handoff thấp |
| **D3** | Số liệu trong tài liệu sẽ sai ngay tuần sau; nên sinh bằng script; tồn tại mâu thuẫn tổng dòng / % | ✅ **ĐÚNG** (và **vẫn còn** ở v3.2, xem §D3 chi tiết bên dưới) | Tổng `tsx` thật = **19.130** dòng (`wc -l`) — khớp; nhưng **mọi** giá trị trong bảng §3 = `wc -l + 1` ⇒ cột đó cộng ra **19.188**, không phải 19.130 | Cần script sinh bảng trong CI + chốt **một** quy ước mẫu số |
| **D4** | Chuyển mục 5 từ "bảng đã xong" sang risk register (residual risk, test ID, owner, ngày review) | ✅ **ĐÚNG** | Mục 5 hiện có **10 mục "ĐÃ HOÀN THÀNH 100%"**, 3 mục "BÁO ĐỘNG GIẢ" — không mục nào có residual risk, test ID hay owner | 3 báo động giả (IME, ContextMeter, Blob) cũng không có regression test ID gắn kèm |
| **D5** | Modal bảo mật thiếu a11y/anti-fatigue: `alertdialog`, focus trap, không focus vào Approve, diff lớn phải cuộn hết, lệnh destructive phải gõ xác nhận | ⚠️ **ĐÚNG MỘT PHẦN** | **Đã có**: `useFocusTrap` (`components/diff-confirm.tsx:8, 34-52`; `components/shell-confirm.tsx:7, 29`), Escape = từ chối, `aria-modal="true"` + `aria-labelledby` (`diff-confirm.tsx:59-60`). Focus ban đầu vào focusable **đầu tiên** (`lib/hooks/use-focus-trap.ts:38-44`) — nút "Từ chối" đứng trước nút duyệt, nên **vô tình** đã thoả "không focus mặc định vào Approve" | **(a)** `role="dialog"` chứ **không phải** `alertdialog`; **(b)** không có scroll-gate cho diff lớn (nút "Duyệt & ghi" luôn bật, `diff-confirm.tsx:118-124`); **(c)** lệnh destructive không có xác nhận gõ-tên; **(d)** việc focus không vào Approve là *tình cờ*, không phải ràng buộc được test |

---

## E. Phản biện kế hoạch P1

| # | Luận điểm | Phán quyết | Bằng chứng / Ghi chú |
|---|---|---|---|
| **E1** | Chỉ dùng XState cho turn FSM, tool loop là invoked actor; **phải persist FSM snapshot xuống Dexie**, nếu không thì không giải quyết đúng vấn đề stale closure | ✅ **ĐÚNG** | `xstate` **không** có trong `package.json` ⇒ kế hoạch P1 chưa bắt đầu; mục 6 của tài liệu mô tả FSM nhưng **không** đề cập persist snapshot ⇒ lỗ hổng phản biện chỉ ra là nguyên vẹn |
| **E2** | Runtime trong Web Worker khả thi (FSA handle structured-cloneable) nhưng cần protocol rõ (Comlink) + worker **không bao giờ** tự resolve approval | ✅ **ĐÚNG** | `comlink` không có trong `package.json`; hiện approval resolve ở main thread qua `lib/approval-queue.ts` (không có token gắn `toolCallId`) |
| **E3** | Leader chết giữa turn: lock tự nhả, observer phải recover từ snapshot; bắt buộc idempotency key per tool call + ghi trạng thái `executing` trước khi chạy | ✅ **ĐÚNG** | Không có `navigator.locks` (0 hit) ⇒ chưa có leader election; chưa thấy idempotency key per tool call |
| **E4** | Thiếu mục cross-tab data sync + UX rõ cho tab Observer | ⚠️ **ĐÚNG MỘT PHẦN** | Data sync **đã có**: `lib/chat-broadcast.ts` (BroadcastChannel + Lamport + fallback storage, README mục "Đồng bộ đa-tab") ⇒ nửa "cross-tab data sync" không còn thiếu; nửa "UX cho tab Observer" thì đúng vì chưa có leader election |

---

## D3. Số liệu đã kiểm chứng lại (bảng cụ thể)

| Chỉ số | Tài liệu v3.2 ghi | Thực tế đo được | Kết luận |
|---|---|---|---|
| Số file `.tsx` | 58 | **58** (`git ls-files '*.tsx' \| wc -l`) | ✅ khớp |
| Tổng dòng TSX | 19.130 (không trailing newline) / 19.188 (có) | `wc -l` = **19.130** | ✅ mốc "không trailing newline" đúng |
| Cột "Số Dòng" trong bảng §3 | được hiểu là 19.130 | **cộng lại = 19.188** (mọi dòng = `wc -l + 1`: 6.182→6.183, 1.067→1.068, 608→609, 599→600, 583→584, 578→579, 516→517, 503→504, 456→457, 442→443, 436→437, 424→425) | ❌ hai quy ước mẫu số bị trộn |
| Tỉ lệ god component | §2 sơ đồ: **32.1%**; §4: **32.22%** | 6.182/19.130 = **32,31%**; 6.183/19.188 = **32,22%** | ❌ ba con số khác nhau trong cùng một file |
| 12 file ≥400 dòng | — (phản biện: 64,6%) | 12 file ✅; tổng 12.394 = **64,79%** (theo `wc -l`) / 12.406 = **64,65%** (theo bảng §3) | ✅ bậc độ lớn khớp |
| 18 file <100 dòng | — (phản biện nêu 18) | **18** | ✅ khớp |
| Migration Dexie | 19 | **19** (`lib/db.ts:705` = v19) | ✅ khớp |
| File test | 163/163 PASS | **163** file `tests/*.test.ts` | ✅ khớp số **file** |
| Số test | 2.456/2.456 PASS | 🕓 không chạy được (không có `node_modules`) | chưa xác nhận |
| README | — | bảng tech stack ghi *"Dexie — schema 16 phiên bản"* trong khi thân README dùng v18/v19 | ❌ drift nội bộ README |

---

## F. Thứ tự ưu tiên — hiệu chỉnh sau đối soát

| Hạng đề xuất (phản biện) | Hiệu chỉnh | Lý do |
|---|---|---|
| P0: A1, A2, A5 | **A2 → ĐÃ XONG**; **A1 → hạ xuống P0.5** (mô hình đã xong, chỉ còn 4 residual); **A5 → giữ P0 nhưng đổi nội dung**: không phải "viết taint tracking" mà là **"nối dây `markTurnUntrustedInput` + `wrapUntrustedData`"** | Guard chống exfil hiện là dead code — nặng hơn cả việc chưa có |
| — | **THÊM P0 mới: A8-CSP** (hiện `Content-Security-Policy` = 0) | XSS trong app local-first = đọc sạch IndexedDB |
| — | **THÊM P0 mới: C1** (không snapshot trước migration, không migration test) | local-first, không có backup server: một migration lỗi là mất trắng |
| P0.5: A3, A4, A8 | **A4 → hạ**: hash chain + anchor + `verifyChain` đã có, việc còn lại là *anchor ra ngoài workspace*, *prune/verifyChain*, và **đổi từ ngữ "bất biến" → "tamper-evident"**. **A8 → tách**: sanitize xong, CSP chưa | Tránh làm lại việc đã làm |
| P1: B2 trước B1 | ✅ giữ nguyên (đồng ý: chưa có port mà bóc god component sẽ phải tách hai lần) | Không đổi |
| P2: C4, C5, C3 | ✅ giữ, nhưng **C4 trước C3** (re-render mỗi token là nguyên nhân giật chính; C3 ít consumer hơn phản biện tưởng) | Sửa theo mức tác động thật |
| P2: D1, D2/D3 | ✅ giữ, **thêm D4/D5** vào cùng đợt | Rẻ, và giữ cho P0 không thoái hoá |

---

## G. Tóm tắt 8 kết luận quan trọng nhất

1. **A5 là lỗi nặng nhất và cũng là lỗi phản biện chẩn đoán sai nhất**: cơ chế taint/egress **đã viết đầy đủ** nhưng `markTurnUntrustedInput`/`wrapUntrustedData` **không có call site** ⇒ guard không bao giờ chạy.
2. **A2 đã xong đúng như đề xuất** (`lib/path-guard.cjs` realpath jail + NFC + case-insensitive + denylist). Residual chỉ còn TOCTOU hẹp (không `O_NOFOLLOW`/`lstat`).
3. **A6 rug-pull đã được chặn** bằng chính giải pháp phản biện đề xuất: grant key gắn `schemaHash = SHA-256(inputSchema + description)`, tính lại mỗi lần gọi, persist xuống đĩa, approval có timeout.
4. **A4 "bất biến" là vấn đề từ ngữ, không phải thiếu kỹ thuật**: hash chain + `verifyChain` + anchor ra `.vyen/audit/anchor.log` đã có; thiếu là anchor ngoài workspace, xử lý `prune`, và **đổi chữ trong tài liệu**.
5. **A1 đã đổi mô hình đúng hướng phản biện** (tokenizer argv + allowlist + `SAFE_ENV` + `shell:false`). Residual thật không nằm ở backtick/newline mà ở: `PATH` kế thừa, runner trong allowlist (`npm test`, `npx vitest`) **thực thi code do agent viết**, `lib/teamwork/*` còn `shell:true`, và không có ranh giới OS.
6. **A8 thiếu hẳn CSP** dù `rehype-sanitizer` đã chạy trước KaTeX — đây là lỗ còn thật, dễ sửa, tác động cao.
7. **C1 là rủi ro mất dữ liệu nguyên vẹn**: 19 migration, không snapshot trước upgrade, không migration test với DB cũ thật.
8. **D3 vẫn đúng ở v3.2 dưới dạng mới**: tổng 19.130 là đúng nhưng cột bảng cộng ra 19.188, tỉ lệ god component có 3 giá trị (32,1% / 32,22% / 32,31%) trong cùng một tài liệu → cần sinh bảng bằng script trong CI.

---

## H. Giới hạn của lần đối soát này

- **Không chạy được test/typecheck**: repo không có `node_modules` → mọi con số test trong tài liệu (2.456) **chưa được xác nhận**, chỉ có số *file* test (163) là kiểm chứng được.
- Chỉ đối soát các luận điểm trong bản phản biện; **không** audit toàn bộ 236 file `lib/` (ví dụ: đường ghi file phía desktop trong `lib/ipc.cjs` có áp hash guard hay không **chưa kiểm chứng**).
- Lịch sử git chỉ có **1 commit** (`77956a1`) → không thể so v3.1 ↔ v3.2 để biết phần nào mới được sửa.
- Các mục đánh dấu 🕓 cần một vòng kiểm chứng riêng (chạy `vitest`, đọc `lib/ipc.cjs` phần fs-write, kiểm tra UI thu hồi grant MCP).
- **Giới hạn công cụ sửa file**: `components/chat-interface.tsx` dài 6.182 dòng, công cụ sửa chỉ áp dụng được vùng đầu (~1.5k dòng) — mọi thay đổi ở vùng sâu (onToolCall, submitTurn, subagent relay) phải đi vòng qua tầng `lib/`. Đây cũng là lý do kỹ thuật cụ thể ủng hộ việc tách file ở P1 (B1/B2).

### Lệnh tái lập nhanh

```bash
git ls-files '*.tsx' | xargs wc -l | tail -1                      # 19.130
git ls-files '*.tsx' | xargs wc -l | awk '$1<100{a++}END{print a}' # 18
rg -c "\.version\(" lib/db.ts                                      # 19
ls tests/*.test.ts | wc -l                                         # 163
rg -n "markTurnUntrustedInput|wrapUntrustedData" lib components    # chỉ có định nghĩa
rg -n "navigator\.locks|locks\.request" lib components app         # 0 hit
rg -n "O_NOFOLLOW|lstat" lib scripts components                    # 0 hit
rg -n "Content-Security-Policy" .                                  # 0 hit
```

---

## I. Trạng thái sau khi sửa (cùng ngày 2026-09-23)

### A5 — Egress Guard từ "diễn" → "chạy"

| Thay đổi | File |
|---|---|
| Con trỏ hội thoại đang hoạt động + `resolveTaintKey()`; gọi taint không có id sẽ ghi vào hội thoại đang hoạt động | `lib/taint-tracker.ts` |
| `untrustedSourceForTool()` / `payloadByteLength()` / `noteUntrustedToolResult()` | `lib/taint-tracker.ts` |
| Đọc file workspace = nguồn KHÔNG ĐÁNG TIN → đánh dấu taint (web FSA + desktop) | `lib/fs-access.ts` (`fsRead`, `fsSearch`), `lib/desktop-fs.ts` (`desktopFsRead`) |
| Output MCP (trừ khi bị `denied`) → đánh dấu taint | `lib/mcp/bridge.ts` (`callMcpTool`) |
| Mốc lượt mới: reset taint khi append message `role: 'user'` | `lib/db.ts` (`appendMessage`) |
| Egress Guard ghi provenance (nguồn nhiễm) vào audit log | `lib/auto-pilot.ts` (`recordTaintedEgress`) |
| Guard nhận `conversationId: chatKey` (3 call site) + đặt hội thoại hoạt động | `components/chat-interface.tsx` (vùng đầu file) |
| 11 test mới: bảng ánh xạ nguồn, đánh dấu/byte, delimiter, guard theo hội thoại, ngân sách | `tests/taint-tracker.test.ts` |

**Kiểm chứng**: `npx tsc --noEmit` sạch; `npx vitest run` → **164 file / 2.467 test PASS** (trước khi sửa: 163 file / 2.456 — khớp đúng con số §6 của tài liệu).

### Fix phát sinh khi kiểm chứng

`node bin/vyen.ts audit` quét theo dòng cả file `.md`, nên **chính tài liệu này** bị báo CRITICAL/HIGH giả (`shell: true` và `dangerouslySetInnerHTML` được TRÍCH DẪN trong bảng đối soát) → `tests/web-bridge.test.ts` đỏ. Đã thêm `isDocFile()` cho đúng 2 luật nhạy với việc trích dẫn mẫu mã trong `lib/security-sast.ts`; luật secret-leak / weak-crypto **vẫn** quét `.md`. Audit trở lại `PASSED (No Critical/High vulnerabilities)`, exit code 0.

### Còn lại chưa nối → ĐÃ NỐI HẾT (cùng ngày 2026-09-23, phiên 2)

| Khoảng trống trước đây | Cách nối | Bằng chứng |
|---|---|---|
| Tool web chạy server-side (`web_search`/`web_fetch`) chưa đánh dấu taint | Hook trong `components/chat-interface.tsx` quét `toolInvocations` của message assistant khi stream active: invocation state `result` + không phải JSON lỗi + tên `web_*` → `noteUntrustedToolResult` | `components/chat-interface.tsx` (useEffect sau subagent-relay, ~:3131) |
| Đường subagent relay chưa đánh dấu | Relay đã gọi `handleClientToolCall` — giờ đi qua wrapper `executeClientToolCall` nên tự được phủ | `components/chat-interface.tsx` (wrapper sau `rawHandleClientToolCall`, ~:2633) |
| `run_code`, stdout `shell_run`/`bg_run`, `git_diff`/`git_log`, `skill_load` chưa thuộc nguồn ngoài | Mở rộng `untrustedSourceForTool()`: shell/bg_run gắn nhãn `tool:<command 120 ký tự>`, git_diff/log, run_code; **cố ý KHÔNG** tính `git_status`/`git_add`/`git_commit`/`bg_status`/`bg_stop` (chỉ trạng thái của harness) | `lib/taint-tracker.ts` (mapping), `tests/taint-tracker.test.ts` (4 test mới) |
| Kết quả bị deny bị đếm nhầm là nhiễm | Wrapper chỉ đánh dấu khi result không chứa `"denied":true` — payload deny là thông điệp lỗi harness, không phải dữ liệu ngoài | `components/chat-interface.tsx` (guard trong wrapper) |
| CSP = 0 | `next.config.js` phát hành CSP tĩnh cho `/:path*`: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `style-src 'self' 'unsafe-inline' fonts.googleapis.com` (KaTeX), `script-src 'self' 'unsafe-inline'` (khối chống flash theme — không nonce được với headers() tĩnh) + `'unsafe-eval'` CHỈ ở dev, `connect-src *` (BYOK + desktop bridge — xem quyết định kiến trúc A8(b)); kèm `X-Content-Type-Options: nosniff`, `Referrer-Policy` | `next.config.js`, regression test `tests/csp-config.test.ts` (3 test) |
| Tài liệu không nhắc injection/taint; "bất biến" | Thêm bullet A5 vào §1.3; đổi "bất biến / Immutable Audit Log" → "chống giả mạo / tamper-evident" ở §1.3 và §6 | `DOCS_TSX_ARCHITECTURE.md` |

**Kiểm chứng phiên 2**: `npx tsc --noEmit` sạch; `npx vitest run` → **165 file / 2.472 test PASS**; `npx tsx bin/vyen.ts audit` → PASSED (0 Critical/High — CSP comment không đụng luật nào).

### Residual còn lại (trung thực)

- **A5**: taint vẫn in-memory theo lượt (reset khi appendMessage user) — đúng thiết kế, nhưng provenance không persist xuyên reload; wrapper chỉ phủ tool client (fs/shell/git/MCP/relay) + web_* qua toolInvocations, KHÔNG phủ tool server thuần (memory_search...) vì chúng không thành toolInvocation. `isEgressTool` vẫn nhận diện bằng `includes('push'\|'curl'\|...)` — bypass được bằng lệnh không chứa keyword (đã ghi nhận từ lần đối soát đầu, chưa sửa).
- **A8**: CSP dùng `'unsafe-inline'` cho script (khối theme) — cần nonce + middleware/proxy để siết thêm; `connect-src *` là trade-off của BYOK.
- **A1/A3/A4/A6/A7/C1**: nguyên trạng theo mục F (PATH kế thừa, runner trong allowlist, `lib/teamwork/*` còn `shell: true`, không CAS/Web Locks, anchor trong workspace, không TTL grant, không snapshot migration).
