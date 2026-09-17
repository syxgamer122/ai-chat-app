/**
 * ObservationSanitizer & Truncation — làm sạch output tool cho Vyen.
 *
 * Không đưa output thô của tool vào context: mọi observation đi qua
 * `truncate_content()` (giữ đầu + đuôi, chèn marker `…[truncated]…`) và qua
 * bước làm sạch terminal trước khi vào LLM. Vyen hiện chỉ có 2 dạng cắt:
 *
 * 1. `fs_read` cắt theo DÒNG (paging start_line/max_lines) — tốt cho file, vô
 *    dụng với output shell một khối.
 * 2. Trần cứng rải rác trong từng tool, thường cắt phần ĐUÔI — mà lỗi build
 *    (`FAIL`, `Error`, stack trace, `exit code`) lại nằm ở ĐUÔI.
 *
 * Module này bổ sung 3 việc thực sự tiết kiệm token:
 *
 * - LÀM SẠCH terminal: bỏ mã màu ANSI/OSC, gộp dòng `\r` ghi đè (progress bar
 *   của npm/pip/pytest đổ hàng trăm frame), gộp dòng trống liên tiếp, bỏ space
 *   cuối dòng. Output `npm install` thường giảm 30–60% ký tự.
 * - CẮT THÔNG MINH: giữ đầu + đuôi (head/tail) thay vì chỉ đầu; khi phát hiện
 *   dấu hiệu lỗi thì nghiêng về ĐUÔI (35/65) để stack trace không bị mất; luôn
 *   ghi rõ số ký tự đã lược để model biết mình đang thiếu thông tin.
 * - TRẦN THEO TOOL: mỗi tool có budget riêng (shell rộng hơn `grep`), tự suy ra
 *   từ tên tool thay vì mỗi nơi hardcode một số.
 *
 * Thuần function, không Dexie/React — test được trong node.
 */

/* ------------------------------------------------------------------ */
/* Trần ký tự                                                          */
/* ------------------------------------------------------------------ */

/**
 * Trần mặc định cho một observation (tham chiếu 10k ký tự cho CLI) /
 * 30k (GUI); Vyen chọn 12k vì context budget đã có tầng riêng lo phần lớn.
 */
export const DEFAULT_OBSERVATION_CHARS = 12_000;

/** Sàn ký tự — dưới mức này marker + phần giữ lại vô nghĩa. */
export const MIN_OBSERVATION_CHARS = 200;

/**
 * Trần riêng theo tool. Tool "đọc nhiều" (shell, fs_read) rộng hơn tool "tra
 * cứu" (grep, web) vì kết quả của chúng là nguồn thông tin chính của lượt.
 */
export const OBSERVATION_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  shell: 16_000,
  run_shell: 16_000,
  bash: 16_000,
  fs_read: 20_000,
  read_file: 20_000,
  fs_write: 1_200,
  fs_edit: 1_200,
  grep: 10_000,
  glob: 6_000,
  fs_search: 12_000,
  find: 6_000,
  web: 12_000,
  web_fetch: 12_000,
  web_search: 8_000,
  vision: 2_000,
  mcp: 10_000,
});

/**
 * Suy ra trần ký tự cho một tool. Không khớp → mặc định. Hậu tố namespace
 * (`mcp__github__list_prs`) được rút về tiền tố để dùng chung budget.
 */
export function budgetForTool(
  toolName: string | null | undefined,
  overrides?: Readonly<Record<string, number>>,
): number {
  const table = overrides ?? OBSERVATION_BUDGETS;
  const raw = (toolName ?? '').trim().toLowerCase();
  if (!raw) return DEFAULT_OBSERVATION_CHARS;
  const direct = table[raw];
  if (typeof direct === 'number') return direct;
  const head = raw.split('__')[0] ?? raw;
  const viaHead = table[head];
  if (typeof viaHead === 'number') return viaHead;
  const viaPrefix = Object.keys(table).find((k) => raw.startsWith(k));
  if (viaPrefix) return table[viaPrefix] ?? DEFAULT_OBSERVATION_CHARS;
  return DEFAULT_OBSERVATION_CHARS;
}

/* ------------------------------------------------------------------ */
/* Làm sạch terminal                                                   */
/* ------------------------------------------------------------------ */

/** OSC: ESC ] ... BEL | ESC \ (đặt title cửa sổ, hyperlink). */
const ANSI_OSC_RE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

/** CSI: ESC [ ... chữ cái (màu, di chuyển con trỏ, xoá dòng). */
const ANSI_CSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** Escape 2 ký tự còn sót (ESC 7, ESC M...). */
const ANSI_ESC_RE = /\u001B[@-Z\\-_]/g;

/** Ký tự điều khiển khác — GIỮ `\t` (0x09) và `\n` (0x0A). */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Bỏ toàn bộ mã màu/điều khiển ANSI khỏi output terminal. */
export function stripAnsi(text: string): string {
  if (!text) return text;
  return text
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_ESC_RE, '')
    .replace(CONTROL_RE, '');
}

/**
 * Giải `\r` theo hành vi terminal thật: nội dung sau `\r` ghi đè dòng hiện tại,
 * nên kết quả đúng là frame CUỐI (không phải nối tất cả frame). Progress bar
 * của npm/pip/pytest/cargo thường sinh hàng trăm frame như vậy.
 */
export function normalizeCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const parts = line.split('\r');
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const part = parts[i] ?? '';
        if (part.trim().length) return part;
      }
      return '';
    })
    .join('\n');
}

/** Bỏ space/tab cuối mỗi dòng — thuần túy tốn token, không mang thông tin. */
export function trimTrailingSpaces(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
}

/** Gộp run dòng trống: nhiều hơn `maxBlank` dòng trống liên tiếp → còn đúng `maxBlank`. */
export function collapseBlankRuns(text: string, maxBlank = 1): string {
  const limit = Math.max(0, maxBlank);
  return text.replace(/\n{2,}/g, (run) => '\n'.repeat(Math.min(run.length, limit + 1)));
}

/**
 * Lược blob base64/data-URI dài — ảnh nhúng, attachment, payload MCP dạng
 * inline chiếm hàng chục nghìn ký tự mà model không đọc được.
 * MẶC ĐỊNH TẮT: có thể cắt nhầm dòng minified một hàng, nên phải bật có ý thức.
 */
export function elideBlobs(text: string): string {
  return text
    .replace(
      /(data:[\w.+-]+\/[\w.+-]+;base64,)[A-Za-z0-9+/=]{64,}/g,
      (_m, prefix: string) => `${prefix}[…blob base64 đã lược…]`,
    )
    .replace(/\b[A-Za-z0-9+/]{320,}={0,2}\b/g, (m) => `[…${m.length} ký tự base64 đã lược…]`);
}

/* ------------------------------------------------------------------ */
/* Cắt ngắn                                                            */
/* ------------------------------------------------------------------ */

export type TruncateStrategy = 'head' | 'tail' | 'head_tail';

export interface TruncateOptions {
  /** Trần ký tự của kết quả. Mặc định `DEFAULT_OBSERVATION_CHARS`. */
  maxChars?: number;
  /** Chiến lược cắt. Mặc định `head_tail` (giữ đầu + đuôi). */
  strategy?: TruncateStrategy;
  /** Nghiêng về đuôi khi output có dấu hiệu lỗi. Mặc định bật. */
  errorAware?: boolean;
}

export interface TruncationResult {
  text: string;
  truncated: boolean;
  originalChars: number;
  omittedChars: number;
  strategy: TruncateStrategy;
}

/** Dấu hiệu output chứa lỗi — lỗi/stack trace nằm ở ĐUÔI output. */
const ERROR_HINTS: readonly RegExp[] = [
  /traceback \(most recent call last\)/i,
  /\b(?:error|exception|failed|failure|fatal|panic)\b/i,
  /^\s*FAIL\b/m,
  /\bexit(?:ed)? (?:code|status)\s*[:=]?\s*[1-9]/i,
  /\b(?:SyntaxError|TypeError|ReferenceError|ModuleNotFoundError)\b/,
  /(?:^|\s)[1-9]\d*\s+(?:failing|failed)\b/m,
  /[✖✗]/u, // glyph đánh dấu test fail của vitest/jest
  /\bTS\d{4}\b/, // lỗi TypeScript
  /\bE\d{3}\b:\s/, // lỗi ESLint
];

/** true khi output giống log lỗi — dùng để chọn tỉ lệ head/tail. */
export function looksLikeError(text: string): boolean {
  if (!text) return false;
  return ERROR_HINTS.some((re) => re.test(text));
}

function elisionMarker(omitted: number): string {
  return `\n…[đã lược ${omitted} ký tự]…\n`;
}

/** Dịch chỉ số cắt về ranh giới dòng gần nhất (tránh cắt giữa dòng). */
function alignToLine(text: string, index: number, direction: 'back' | 'forward'): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  if (direction === 'back') {
    const nl = text.lastIndexOf('\n', index);
    return nl === -1 ? 0 : nl;
  }
  const nl = text.indexOf('\n', index);
  return nl === -1 ? text.length : nl;
}

/**
 * Cắt observation. Giữ đầu + đuôi, marker ghi rõ số ký tự đã lược để model
 * biết phần nào còn thiếu (chỉ ghi `…[truncated]…` là chưa đủ — ở đây có thêm
 * con số, hữu ích khi model quyết định đọc lại theo offset).
 */
export function truncateObservation(text: string, options: TruncateOptions = {}): TruncationResult {
  const strategy = options.strategy ?? 'head_tail';
  const maxChars = Math.max(MIN_OBSERVATION_CHARS, Math.floor(options.maxChars ?? DEFAULT_OBSERVATION_CHARS));
  const originalChars = text.length;

  if (originalChars <= maxChars) {
    return { text, truncated: false, originalChars, omittedChars: 0, strategy };
  }

  if (strategy === 'tail') {
    const cut = alignToLine(text, originalChars - maxChars, 'forward');
    const kept = text.slice(cut);
    return { text: `…[đã lược ${cut} ký tự đầu]…\n${kept}`, truncated: true, originalChars, omittedChars: cut, strategy };
  }

  if (strategy === 'head') {
    const cut = alignToLine(text, maxChars, 'back');
    const kept = text.slice(0, cut);
    return { text: `${kept}\n…[đã lược ${originalChars - cut} ký tự cuối]…`, truncated: true, originalChars, omittedChars: originalChars - cut, strategy };
  }

  // head_tail — tỉ lệ nghiêng về đuôi khi có lỗi (errorAware mặc định bật).
  const errorAware = options.errorAware !== false;
  const headRatio = errorAware && looksLikeError(text) ? 0.35 : 0.5;

  // Marker cũng tốn budget → chừa chỗ trước, rồi thu hẹp đầu cho vừa trần.
  const budget = maxChars - elisionMarker(originalChars).length;
  if (budget < 120) {
    // Ngân sách quá nhỏ cho head+tail: cắt đầu thuần cho chắc.
    return truncateObservation(text, { ...options, strategy: 'head' });
  }

  let headEnd = alignToLine(text, Math.round(budget * headRatio), 'back');
  let tailStart = alignToLine(text, originalChars - (budget - Math.round(budget * headRatio)), 'forward');

  // alignToLine chỉ dịch về ranh giới dòng nên vẫn có thể vượt trần — thu hẹp dần.
  for (let guard = 0; guard < 64; guard += 1) {
    const kept = headEnd + (originalChars - tailStart);
    const marker = elisionMarker(tailStart - headEnd);
    if (kept + marker.length <= maxChars) break;
    const overflow = kept + marker.length - maxChars;
    const nextHead = alignToLine(text, Math.max(0, headEnd - overflow), 'back');
    if (nextHead >= headEnd) {
      // Không co được nữa (đang ở dòng đầu) — bỏ luôn phần đầu.
      headEnd = 0;
      break;
    }
    headEnd = nextHead;
  }

  if (headEnd === 0 || tailStart >= originalChars) {
    // Text một dòng (hoặc dòng đầu/ cuối quá dài): alignToLine không co được
    // về ranh giới dòng → cắt thẳng theo ký tự, nếu không thì mất sạch output.
    const markerGuess = elisionMarker(originalChars).length;
    const available = Math.max(60, maxChars - markerGuess);
    const headPart = text.slice(0, Math.round(available * headRatio));
    const tailChars = available - headPart.length;
    const tailPart = tailChars > 0 ? text.slice(originalChars - tailChars) : '';
    const omittedFlat = originalChars - headPart.length - tailPart.length;
    return {
      text: `${headPart}${elisionMarker(omittedFlat)}${tailPart}`,
      truncated: true,
      originalChars,
      omittedChars: omittedFlat,
      strategy,
    };
  }

  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  const omitted = originalChars - head.length - tail.length;
  return {
    text: `${head}${elisionMarker(omitted)}${tail}`,
    truncated: true,
    originalChars,
    omittedChars: omitted,
    strategy,
  };
}

/* ------------------------------------------------------------------ */
/* Pipeline đầy đủ — dùng chung cho mọi tool result                     */
/* ------------------------------------------------------------------ */

export interface SanitizeOptions extends TruncateOptions {
  /** Bỏ mã màu ANSI. Mặc định bật. */
  stripAnsi?: boolean;
  /** Giải `\r` ghi đè. Mặc định bật. */
  normalizeCarriageReturns?: boolean;
  /** Gộp run dòng trống. Mặc định bật. */
  collapseBlankRuns?: boolean;
  /** Bỏ space cuối dòng. Mặc định bật. */
  trimTrailingSpaces?: boolean;
  /** Lược blob base64 — mặc định TẮT (xem `elideBlobs`). */
  elideBlobs?: boolean;
}

export interface SanitizeResult {
  text: string;
  /** true khi có bước nào can thiệp (kể cả chỉ làm sạch, không cắt). */
  changed: boolean;
  originalChars: number;
  finalChars: number;
  omittedChars: number;
  truncated: boolean;
  /** Các bước đã áp dụng: 'ansi' | 'carriage-returns' | 'trailing-spaces' | 'blank-runs' | 'blobs' | 'truncated:*'. */
  notes: string[];
}

/** Chuỗi bước làm sạch, đo mức tiết kiệm và cắt theo trần. */
export function sanitizeObservation(raw: string, options: SanitizeOptions = {}): SanitizeResult {
  const notes: string[] = [];
  const originalChars = (raw ?? '').length;
  let text = raw ?? '';

  const step = (label: string, fn: (value: string) => string, enabled: boolean) => {
    if (!enabled || !text) return;
    const next = fn(text);
    if (next !== text) {
      text = next;
      notes.push(label);
    }
  };

  step('ansi', stripAnsi, options.stripAnsi !== false);
  step('carriage-returns', normalizeCarriageReturns, options.normalizeCarriageReturns !== false);
  step('trailing-spaces', trimTrailingSpaces, options.trimTrailingSpaces !== false);
  step('blank-runs', (v) => collapseBlankRuns(v, 1), options.collapseBlankRuns !== false);
  step('blobs', elideBlobs, options.elideBlobs === true);

  const result = truncateObservation(text, options);
  if (result.truncated) notes.push(`truncated:${result.strategy}`);

  return {
    text: result.text,
    changed: notes.length > 0,
    originalChars,
    finalChars: result.text.length,
    omittedChars: originalChars - result.text.length,
    truncated: result.truncated,
    notes,
  };
}

/**
 * Tiện dụng cho tầng gọi tool: tự chọn trần theo tool rồi làm sạch + cắt.
 */
export function sanitizeToolObservation(
  toolName: string | null | undefined,
  raw: string,
  options: SanitizeOptions = {},
): SanitizeResult {
  const maxChars = options.maxChars ?? budgetForTool(toolName);
  return sanitizeObservation(raw, { ...options, maxChars });
}

/**
 * Tỉ lệ ký tự tiết kiệm được (0–1). Dùng cho log/telemetry context budget.
 */
export function savedRatio(result: SanitizeResult): number {
  if (result.originalChars <= 0) return 0;
  return Math.round(((result.originalChars - result.finalChars) / result.originalChars) * 1000) / 1000;
}
