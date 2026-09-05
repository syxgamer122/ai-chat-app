/**
 * Post-edit verification — ý tưởng pi-lens thu gọn về mô hình client của Vyen:
 * sau khi agent fs_edit/fs_write THÀNH CÔNG (đường legacy ghi đĩa), tự chạy
 * lint/typecheck khai báo trong package.json của dự án user rồi gắn kết quả
 * vào tool result — model thấy lỗi NGAY trong cùng lượt thay vì dừng sớm với
 * code lỗi (gap "lint-after-edit" ghi nhận từ 2026-09-02).
 *
 * Ranh giới an toàn:
 * - Chỉ chạy script TÊN KHỚP CHÍNH XÁC allow-list; lệnh thực thi luôn dạng
 *   `npm run <tên> --silent` từ workspace root, KHÔNG nhận đối số tự do.
 * - Vẫn đi qua autoApproveShell như shell_run — chính sách duyệt của user
 *   không bị bypass; bị từ chối thì bỏ qua check im lặng.
 * - Throttle 60s/conversation: tsc trên dự án lớn tốn chục giây, không chạy
 *   mỗi edit. Slot bị CHIẾM TRƯỚC khi await bất kỳ IPC nào — hai edit liền
 *   nhau không sinh hai vòng check song song.
 * - Kết quả check CHỈ là thông tin phụ: `applied: true` / `written: true`
 *   của edit không bao giờ bị đổi nghĩa vì check lỗi.
 *
 * Thuần function, không Dexie/React/IPC — test được trong node.
 */

/** Khoảng cách tối thiểu giữa hai vòng check trong cùng hội thoại. */
export const POST_EDIT_CHECK_INTERVAL_MS = 60_000;

/** Timeout mỗi lệnh check (ms) — trao cho shell.run. */
export const POST_EDIT_CHECK_TIMEOUT_MS = 90_000;

/** Trần ký tự output của MỘT lệnh đưa vào tool result. */
export const POST_EDIT_CHECK_OUTPUT_CHARS = 2000;

/** Trần số lệnh check mỗi vòng (typecheck + lint là đủ, không chạy test/build). */
export const POST_EDIT_MAX_COMMANDS = 2;

/** Tên script được phép tự chạy — khớp CHÍNH XÁC, không tiền tố/hậu tố. */
export const POST_EDIT_SCRIPT_RE = /^(lint|eslint|typecheck|tsc|check)$/;

/** Thứ tự chọn cố định: bắt lỗi kiểu trước, lint sau. */
const PICK_ORDER = ['typecheck', 'tsc', 'lint', 'eslint', 'check'] as const;

export interface PostEditCheckCommand {
  /** Tên script trong package.json. */
  name: string;
  /** Lệnh đầy đủ sẽ thực thi qua shell. */
  command: string;
}

/**
 * Chọn tối đa POST_EDIT_MAX_COMMANDS lệnh từ scripts của package.json.
 * pkgJson không hợp lệ / thiếu scripts / không tên nào khớp → [].
 */
export function detectPostEditCommands(pkgJson: unknown): PostEditCheckCommand[] {
  const scripts =
    pkgJson && typeof pkgJson === 'object'
      ? (pkgJson as { scripts?: unknown }).scripts
      : undefined;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return [];

  const table = scripts as Record<string, unknown>;
  const picked: PostEditCheckCommand[] = [];
  for (const name of PICK_ORDER) {
    if (picked.length >= POST_EDIT_MAX_COMMANDS) break;
    if (!POST_EDIT_SCRIPT_RE.test(name)) continue;
    const value = table[name];
    if (typeof value === 'string' && value.trim()) {
      picked.push({ name, command: `npm run ${name} --silent` });
    }
  }
  return picked;
}

/* ------------------------------------------------------------------ */
/* Throttle theo hội thoại                                             */
/* ------------------------------------------------------------------ */

export interface PostEditThrottleState {
  /** conversationKey → epoch ms lúc CHIẾM slot lần gần nhất. */
  lastStartedAt: Record<string, number>;
}

export function emptyPostEditThrottle(): PostEditThrottleState {
  return { lastStartedAt: {} };
}

/** Trần số hội thoại giữ lại — dọn những slot cũ nhất khi vượt. */
const MAX_THROTTLE_KEYS = 200;

/**
 * Trả true và CHIẾM slot nếu hội thoại được phép chạy check bây giờ. Chiếm
 * slot TRƯỚC khi caller await bất kỳ IPC nào, nên hai edit gọi sát nhau chỉ
 * một vòng check được sinh ra. conversationKey rỗng → không bao giờ chạy
 * (không có định danh để throttle thì thà bỏ lỡ còn hơn chạy loạn).
 */
export function acquirePostEditSlot(
  state: PostEditThrottleState,
  conversationKey: string,
  now: number,
): boolean {
  if (!conversationKey) return false;
  const keys = Object.keys(state.lastStartedAt);
  if (keys.length >= MAX_THROTTLE_KEYS) {
    for (const k of keys.sort((a, b) => state.lastStartedAt[a] - state.lastStartedAt[b]).slice(0, keys.length - MAX_THROTTLE_KEYS + 1)) {
      delete state.lastStartedAt[k];
    }
  }
  const last = state.lastStartedAt[conversationKey] ?? 0;
  if (now - last < POST_EDIT_CHECK_INTERVAL_MS) return false;
  state.lastStartedAt[conversationKey] = now;
  return true;
}

/* ------------------------------------------------------------------ */
/* Gắn kết quả vào tool result                                         */
/* ------------------------------------------------------------------ */

export interface PostEditCheckOutcome {
  command: string;
  exitCode: number | null;
  ok: boolean;
  output: string;
}

/**
 * Gắn `postEditCheck` vào JSON result của fs_edit/fs_write. Result KHÔNG parse
 * được JSON → trả nguyên văn (check không được làm hỏng result). Output bị cắt
 * ở trần POST_EDIT_CHECK_OUTPUT_CHARS per lệnh.
 */
export function attachPostEditCheck(
  resultJson: string,
  outcomes: readonly PostEditCheckOutcome[],
): string {
  if (!outcomes.length) return resultJson;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(resultJson) as Record<string, unknown>;
  } catch {
    return resultJson;
  }
  if (!parsed || typeof parsed !== 'object') return resultJson;
  parsed.postEditCheck = outcomes.map((o) => ({
    command: o.command,
    exitCode: o.exitCode,
    ok: o.ok,
    output: o.output.length > POST_EDIT_CHECK_OUTPUT_CHARS
      ? `${o.output.slice(0, POST_EDIT_CHECK_OUTPUT_CHARS)}…[cắt]`
      : o.output,
  }));
  return JSON.stringify(parsed);
}
