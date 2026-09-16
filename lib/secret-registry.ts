/**
 * SecretRegistry — port OpenHands (`openhands/core/utils/secret_registry.py`).
 *
 * VÌ SAO CÓ FILE NÀY: cùng một regex che bí mật từng bị copy ở 5 nơi
 * (app/api/chat, app/api/compact, app/api/orchestrate, app/api/title,
 * lib/fs-access) và chúng đã drift thật (fs-access thêm nhánh `key`, các route
 * khác không có). Quan trọng hơn: KHÔNG nơi nào che bí mật nằm trong KẾT QUẢ
 * TOOL trước khi kết quả đó vào ngữ cảnh model — đúng lỗ mà OpenHands bịt bằng
 * registry: giá trị bí mật được ĐĂNG KÝ (từ env của tiến trình) rồi bị thay
 * bằng [redacted] ở MỌI chỗ nó xuất hiện, kể cả khi khoá không có tiền tố nhận
 * dạng được; kèm một tầng pattern cho khoá chưa từng đăng ký.
 *
 * Hai tầng, cố tình tách bạch:
 *   1. VALUE-BASED (đúng OpenHands): register(value) — che chính xác giá trị đã
 *      biết (openai trả về 401 kèm key trong message, shell_run in env, ...).
 *   2. PATTERN-BASED (Vyen bổ sung): sk-…, ghp_…, AKIA…, xoxb-…, PEM, JWT,
 *      DSN có mật khẩu, và assignment `API_KEY="…"`.
 *
 * BẤT BIẾN
 *  - Placeholder giữ nguyên '[redacted]' như bản cũ → log/lỗi không đổi định dạng.
 *  - Chỉ import DEFAULT_DENY_PATTERNS (Arcbox) — không dựng danh sách env-deny
 *    thứ hai để khỏi drift; module thuần nên chạy được cả client bundle lẫn Node.
 *  - Không bao giờ ném và không bao giờ trả undefined: input lạ giữ nguyên trạng.
 *  - Pattern phải ĐỦ HẸP để dùng được cho kết quả tool (đọc file code): rule
 *    assignment đòi >=16 ký tự trong nháy hoặc >=20 ký tự không nháy, nếu không
 *    `key = sessionStorage` trong một file nguồn sẽ bị redact và làm hỏng nội
 *    dung model đọc được.
 */

import { DEFAULT_DENY_PATTERNS } from '@/lib/teamwork/sandbox/env-scrubber';

/** Chuỗi thay thế — giữ nguyên bản cũ để không đổi định dạng log/lỗi. */
export const REDACT_PLACEHOLDER = '[redacted]';

/** Giá trị bí mật ngắn hơn ngưỡng này không được đăng ký (tránh redact mọi thứ). */
export const MIN_REGISTERED_SECRET_LENGTH = 8;

/**
 * Khoá env TRÔNG NHƯ bí mật — dùng để quyết định giá trị nào đáng đăng ký.
 *
 * Gồm danh sách deny của Arcbox (vốn nhắm strip env của tiến trình con) CỘNG
 * các đuôi *_KEY / *_TOKEN / *_SECRET / *_PASSWORD / *_CREDENTIAL và ACCESS_CODE.
 * Lý do phải cộng thêm: danh sách Arcbox chỉ liệt kê biến của NHÀ CUNG CẤP
 * (OPENAI_API_KEY, AWS_SECRET_ACCESS_KEY…) nên nó bỏ sót biến thật của Vyen —
 * `BRAVE_SEARCH_KEY`, `TINYFISH_API_KEY` (khớp), `DIAG_SECRET` (khớp), nhưng
 * `ACCESS_CODE`, `CUSTOM_ACME_TOKEN`, `KILGORE_KEY` thì KHÔNG. Với mục đích
 * STRIP thì bỏ sót là chuyện nhỏ; với mục đích CHE thì bỏ sót = rò rỉ, còn bắt
 * dư chỉ tốn vài phép so chuỗi.
 */
export const SECRET_ENV_KEY_PATTERNS: readonly RegExp[] = Object.freeze([
  ...DEFAULT_DENY_PATTERNS,
  /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?$/i,
  /(^|_)ACCESS_CODE$/i,
]);

/** Predicate mặc định của registerFromEnv. */
export function isLikelySecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export interface SecretPatternRule {
  /** Định danh rule — xuất hiện trong hits/stats, dùng cho Metrics panel. */
  id: string;
  /** Regex nguồn; luôn được chạy bản sao có cờ 'g' nên KHÔNG cần tự thêm 'g'. */
  pattern: RegExp;
  /**
   * Template thay thế (hỗ trợ $1…). Bỏ trống → REDACT_PLACEHOLDER.
   * Dùng khi cần GIỮ phần vô hại của match (vd giữ host của DSN).
   */
  replacement?: string;
  /** Mô tả ngắn cho tài liệu/UI. */
  note?: string;
}

/**
 * Rule theo pattern. Thứ tự CÓ Ý NGHĨA: rule khớp trước thắng, nên rule cụ thể
 * (anthropic) đứng trước rule tổng quát (sk-). Mọi regex con của security-sast.ts
 * (SECRET-OPENAI-001, SECRET-ANTHROPIC-001, SECRET-GITHUB-001, SECRET-AWS-001,
 * SECRET-PRIVKEY-001) được phản chiếu ở đây — tests/secret-registry.test.ts chạy
 * cả hai bộ trên cùng fixture để chặn drift.
 */
export const SECRET_PATTERN_RULES: readonly SecretPatternRule[] = Object.freeze([
  {
    id: 'anthropic-key',
    pattern: /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{8,}/,
    note: 'Anthropic API key (sk-ant-…)',
  },
  {
    id: 'openai-key',
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{8,}/,
    note: 'OpenAI API key (sk-, sk-proj-…)',
  },
  {
    id: 'stripe-key',
    pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/,
    note: 'Stripe secret/restricted key',
  },
  {
    id: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{30,}/,
    note: 'Google/Gemini API key (AIza…) — test dùng AIzaSy-…',
  },
  {
    id: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    note: 'AWS access key id',
  },
  {
    id: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/,
    note: 'GitHub classic PAT',
  },
  {
    id: 'github-pat-fine-grained',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}/,
    note: 'GitHub fine-grained PAT',
  },
  {
    id: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
    note: 'Slack token (xoxb-/xoxp-…)',
  },
  {
    id: 'private-key-block',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----|$)/,
    note: 'PEM/OpenSSH private key block — che cả thân khoá',
  },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/,
    note: 'JWT compact (kể cả khi không có tiền tố Bearer)',
  },
  {
    id: 'bearer-header',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/,
    note: 'Authorization: Bearer … (bản cũ che chung cả từ "Bearer")',
  },
  {
    id: 'dsn-password',
    // Giữ scheme+user+host, chỉ thay mật khẩu: postgres://u:p@h → postgres://u:[redacted]@h
    pattern: /(\/\/[^\s:@/]{1,64}:)([^\s@/]{3,})(?=@)/,
    replacement: `$1${REDACT_PLACEHOLDER}`,
    note: 'Mật khẩu trong DSN — giữ host để thông điệp lỗi còn hữu ích',
  },
  {
    id: 'quoted-secret-assignment',
    /* MỌI quantifier ở đây BỊ CHẶN TRẦN ({0,64}, \s{0,16}) — không phải để cho
       đẹp. Bản đầu dùng `[A-Za-z0-9_-]*` và `\s*` không chặn: trên một chuỗi dài
       toàn ký tự cùng lớp (kết quả tool toàn 'x'), tại MỖI vị trí engine nuốt cả
       run rồi lùi từng ký tự để thử alternation → O(n²), riêng phép che đã ngốn
       >5s cho 24k ký tự (đúng ca tests/mcp-tool-mapper.test.ts timeout). Chặn
       trần giữ nguyên hành vi thực tế (tên biến/thân log không dài tới vậy) mà
       đưa chi phí về O(n). Đừng "dọn dẹp" thành quantifier trần. */
    pattern:
      /((?:[A-Za-z0-9_-]{0,64}(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|credential)[A-Za-z0-9_-]{0,64})\s{0,16}[:=]\s{0,16})(["'])([^"'\n]{16,})(["'])/i,
    replacement: `$1$2${REDACT_PLACEHOLDER}$4`,
    note: 'API_KEY="…"/password: "…" trong log, .env, output tool',
  },
  {
    id: 'unquoted-secret-assignment',
    // Chặn trần như rule trên — cùng lý do O(n²), xem chú thích ở đó.
    pattern:
      /((?:[A-Za-z0-9_-]{0,64}(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)[A-Za-z0-9_-]{0,64})\s{0,16}=\s{0,16})([A-Za-z0-9+/_-]{20,})(?![\w-])/i,
    replacement: `$1${REDACT_PLACEHOLDER}`,
    note: 'API_KEY=… không nháy (>=20 ký tự để không đụng code thường)',
  },
]);

/** Env để tắt tầng che khi cần debug thô (mặc định BẬT). */
export const DISABLE_REDACTION_ENV = 'VYEN_DISABLE_SECRET_REDACTION';

/** Một rule đã khớp, gộp theo id — nguồn số liệu cho Metrics panel. */
export interface SecretHit {
  rule: string;
  count: number;
}

export interface RedactResult {
  /** Text sau khi che. */
  text: string;
  /** Rule đã khớp kèm số lần (rỗng nếu không có gì). */
  hits: SecretHit[];
  /** Tổng số lần che. */
  total: number;
}

const noHits = (text: string): RedactResult => ({ text, hits: [], total: 0 });

/**
 * Bản sao regex có cờ 'g' (String.replace chỉ thay MỘT vị trí nếu thiếu 'g' —
 * đúng lỗi bản cũ khiến bí mật thứ hai trong cùng dòng đi qua nguyên vẹn).
 * Cache theo identity của rule object để không recompile mỗi tool result.
 */
const compiledRules = new WeakMap<SecretPatternRule, RegExp>();

function globalRuleRegex(rule: SecretPatternRule): RegExp {
  let re = compiledRules.get(rule);
  if (!re) {
    const flags = rule.pattern.flags.includes('g')
      ? rule.pattern.flags
      : `${rule.pattern.flags}g`;
    re = new RegExp(rule.pattern.source, flags);
    compiledRules.set(rule, re);
  }
  re.lastIndex = 0;
  return re;
}

function addHit(bag: Map<string, number>, rule: string, count: number): void {
  bag.set(rule, (bag.get(rule) ?? 0) + count);
}

function hitsOf(bag: Map<string, number>): SecretHit[] {
  return [...bag.entries()].map(([rule, count]) => ({ rule, count }));
}

/**
 * Tầng VALUE (đúng OpenHands): thay chính xác giá trị đã đăng ký.
 * Dùng split/join nên không cần escape regex; giá trị dài chạy TRƯỚC giá trị
 * ngắn để khoá ngắn là substring của khoá khác không cắt khoá dài thành mảnh.
 */
function redactValues(
  text: string,
  values: readonly string[],
  placeholder: string,
): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const value of values) {
    if (!value || !out.includes(value)) continue;
    const parts = out.split(value);
    count += parts.length - 1;
    out = parts.join(placeholder);
  }
  return { text: out, count };
}

/**
 * Tầng PATTERN: chạy tuần tự các rule, rule khớp trước thắng.
 *
 * Đếm bằng `match` trên bản sao có cờ 'g' rồi thay bằng `replace` (template
 * $1… do engine native xử lý) — KHÔNG tự parse template, tránh lỗi off-by-one
 * giữa callback args và nhóm bắt.
 */
export function redactSecretPatterns(
  text: string,
  rules: readonly SecretPatternRule[] = SECRET_PATTERN_RULES,
  placeholder: string = REDACT_PLACEHOLDER,
): RedactResult {
  const input = typeof text === 'string' ? text : String(text ?? '');
  if (input.length === 0) return noHits(input);

  let out = input;
  const bag = new Map<string, number>();
  for (const rule of rules) {
    if (!rule?.pattern) continue;
    const re = globalRuleRegex(rule);
    const matched = out.match(re);
    const count = matched ? matched.length : 0;
    if (count === 0) continue;
    out = out.replace(globalRuleRegex(rule), rule.replacement ?? placeholder);
    addHit(bag, rule.id, count);
  }
  const hits = hitsOf(bag);
  return { text: out, hits, total: hits.reduce((sum, h) => sum + h.count, 0) };
}

/* ------------------------------------------------------------------ */
/* Registry                                                           */
/* ------------------------------------------------------------------ */

/** Trần độ sâu khi đi đệ quy kết quả tool (JSON lồng nhau hiếm khi sâu hơn).
 *  Đánh đổi có ý thức: quá trần thì trả NGUYÊN subtree (không đi tiếp) để không
 *  làm nổ chi phí trên payload bệnh hoạn — nghĩa là bí mật nằm sâu hơn 12 tầng
 *  vẫn lọt. Chấp nhận vì (a) kết quả tool thật không lồng tới mức đó, (b) tầng
 *  value vẫn che được nếu nơi khác cùng tiến trình gọi lại giá trị đó. */
export const DEEP_REDACT_MAX_DEPTH = 12;

export interface SecretRegistryOptions {
  /** Giá trị bí mật biết trước (env của tiến trình, key của provider đang dùng). */
  extraValues?: Iterable<string>;
  /** Rule theo pattern bổ sung (chạy SAU rule gốc). */
  extraPatterns?: readonly SecretPatternRule[];
  placeholder?: string;
  /** Ngưỡng đăng ký theo value. Mặc định MIN_REGISTERED_SECRET_LENGTH. */
  minValueLength?: number;
}

export interface SecretRegistryStats {
  registeredValues: number;
  ruleCount: number;
  totalRedactions: number;
  /** Tổng số lần che theo từng rule (nguồn số liệu Metrics panel). */
  hits: Record<string, number>;
}

/**
 * Env tắt khẩn cấp — chỉ để DEBUG thô khi cần nhìn nguyên văn kết quả tool.
 * Đọc mỗi lần gọi (env có thể đổi lúc runtime/test) nhưng không cache.
 */
export function isSecretRedactionDisabled(
  env?: Record<string, string | undefined>,
): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : undefined);
  const raw = (source?.[DISABLE_REDACTION_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Port OpenHands SecretRegistry: đăng ký giá trị bí mật rồi che mọi chỗ nó
 * xuất hiện, kèm tầng pattern cho khoá chưa đăng ký. Instance độc lập hoàn toàn
 * (không global state) nên test được từng tầng riêng.
 */
export class SecretRegistry {
  private readonly values = new Set<string>();
  private readonly labels = new Map<string, string>();
  private readonly rules: readonly SecretPatternRule[];
  private readonly placeholderText: string;
  private readonly minValueLength: number;
  private ordered: string[] = [];
  private readonly hitCounts = new Map<string, number>();
  private totalRedactions = 0;

  constructor(options: SecretRegistryOptions = {}) {
    this.placeholderText = options.placeholder ?? REDACT_PLACEHOLDER;
    this.minValueLength = options.minValueLength ?? MIN_REGISTERED_SECRET_LENGTH;
    this.rules = options.extraPatterns?.length
      ? [...SECRET_PATTERN_RULES, ...options.extraPatterns]
      : SECRET_PATTERN_RULES;
    if (options.extraValues) this.registerAll(options.extraValues);
  }

  get size(): number {
    return this.values.size;
  }

  get placeholder(): string {
    return this.placeholderText;
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  /** Nhãn debug của một giá trị đã đăng ký (KHÔNG trả về chính giá trị). */
  labelOf(value: string): string | undefined {
    return this.labels.get(value);
  }

  /**
   * Đăng ký một giá trị bí mật. Trả false khi giá trị quá ngắn/trùng/rỗng —
   * ngưỡng độ dài là hàng rào quan trọng: đăng ký giá trị 1-2 ký tự sẽ redact
   * gần như mọi kết quả tool.
   */
  register(value: unknown, label = 'secret'): boolean {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v.length < this.minValueLength) return false;
    if (this.values.has(v)) return false;
    this.values.add(v);
    this.labels.set(v, label);
    this.ordered = [];
    return true;
  }

  registerAll(values: Iterable<string> | undefined, label = 'secret'): number {
    let added = 0;
    for (const value of values ?? []) {
      if (this.register(value, label)) added += 1;
    }
    return added;
  }

  /**
   * Đăng ký mọi biến môi trường trông như bí mật (SECRET_ENV_KEY_PATTERNS: danh
   * sách deny của Arcbox + đuôi *_KEY/*_TOKEN…). Trả số giá trị mới.
   */
  registerFromEnv(
    env?: Record<string, string | undefined>,
    options?: { isSecretKey?: (key: string) => boolean },
  ): number {
    const source = env ?? (typeof process !== 'undefined' ? process.env : undefined);
    if (!source) return 0;
    const isSecretKey = options?.isSecretKey ?? isLikelySecretEnvKey;
    let added = 0;
    for (const [key, value] of Object.entries(source)) {
      if (!isSecretKey(key)) continue;
      if (this.register(value, key)) added += 1;
    }
    return added;
  }

  /** Text có chứa bí mật không — KHÔNG cập nhật số liệu (dùng để quyết định). */
  containsSecret(text: string): boolean {
    const input = typeof text === 'string' ? text : '';
    if (input.length === 0 || isSecretRedactionDisabled()) return false;
    if (redactValues(input, this.orderedValues(), this.placeholderText).count > 0) return true;
    return redactSecretPatterns(input, this.rules, this.placeholderText).total > 0;
  }

  /** Che một chuỗi. Không bao giờ ném; không bao giờ trả undefined. */
  redact(text: string): RedactResult {
    const input = typeof text === 'string' ? text : String(text ?? '');
    if (input.length === 0) return noHits(input);
    if (isSecretRedactionDisabled()) return noHits(input);

    const valuePass = redactValues(input, this.orderedValues(), this.placeholderText);
    const patternPass = redactSecretPatterns(valuePass.text, this.rules, this.placeholderText);

    const bag = new Map<string, number>();
    if (valuePass.count > 0) addHit(bag, 'registered-value', valuePass.count);
    for (const hit of patternPass.hits) addHit(bag, hit.rule, hit.count);
    const hits = hitsOf(bag);
    const total = hits.reduce((sum, hit) => sum + hit.count, 0);
    if (total > 0) {
      this.totalRedactions += total;
      for (const hit of hits) addHit(this.hitCounts, hit.rule, hit.count);
    }
    return { text: patternPass.text, hits, total };
  }

  redactText(text: string): string {
    return this.redact(text).text;
  }

  /**
   * Che ĐỆ QUY kết quả tool (object/array/string) trước khi nó vào ngữ cảnh
   * model. Giữ nguyên instance lạ (Date/Map/class) để không phá shape mà code
   * khác đang dựa vào; chỉ đi vào plain object + array.
   */
  redactDeep<T>(value: T): T {
    return this.walk(value, 0, new Set<unknown>()) as T;
  }

  stats(): SecretRegistryStats {
    return {
      registeredValues: this.values.size,
      ruleCount: this.rules.length,
      totalRedactions: this.totalRedactions,
      hits: Object.fromEntries(this.hitCounts),
    };
  }

  resetStats(): void {
    this.hitCounts.clear();
    this.totalRedactions = 0;
  }

  private orderedValues(): string[] {
    if (this.ordered.length !== this.values.size) {
      // Giá trị DÀI trước: khi khoá ngắn là substring của khoá dài, che khoá dài
      // trước để lại đúng một placeholder thay vì hai mảnh rác.
      this.ordered = [...this.values].sort((a, b) => b.length - a.length);
    }
    return this.ordered;
  }

  private walk(value: unknown, depth: number, seen: Set<unknown>): unknown {
    if (typeof value === 'string') return this.redactText(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= DEEP_REDACT_MAX_DEPTH) return value;
    if (seen.has(value)) return '[kết quả vòng lặp — không đọc được]';
    const isArray = Array.isArray(value);
    const proto = isArray ? Object.prototype : Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    seen.add(value);
    try {
      if (isArray) return (value as unknown[]).map((item) => this.walk(item, depth + 1, seen));
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = this.walk(item, depth + 1, seen);
      }
      return out;
    } catch {
      // Getter ném / proxy lạ: thà giữ nguyên còn hơn làm đứt step của agent.
      return value;
    } finally {
      seen.delete(value);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Instance mặc định                                                   */
/* ------------------------------------------------------------------ */

let defaultRegistry: SecretRegistry | null = null;

/**
 * Registry toàn tiến trình: tự đăng ký bí mật từ env ngay lần đầu dùng, để mọi
 * đường (log lỗi route, kết quả tool, transcript emulated) dùng CÙNG một bộ che
 * — đúng vai trò của SecretRegistry trong OpenHands.
 */
export function getDefaultSecretRegistry(): SecretRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new SecretRegistry();
    defaultRegistry.registerFromEnv();
  }
  return defaultRegistry;
}

/** Test hook — cùng quy ước với __clearAllToolCallBudgets(). */
export function __resetDefaultSecretRegistry(): void {
  defaultRegistry = null;
}

/** Che text bằng registry mặc định (thay 5 bản `redact()` copy-paste cũ). */
export function redactSecretText(text: string): string {
  return getDefaultSecretRegistry().redactText(text);
}

/** Che đệ quy kết quả tool bằng registry mặc định. */
export function redactSecretsDeep<T>(value: T): T {
  return getDefaultSecretRegistry().redactDeep(value);
}