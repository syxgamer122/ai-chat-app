/**
 * Trajectory export/import — lưu phiên agent ra file cho Vyen.
 *
 * EventStream mới chỉ là source of truth TRONG phiên.
 * Còn thiếu tầng trajectory: serialize stream ra file để (a) replay lại
 * đúng một phiên, (b) dùng làm fixture regression/eval, (c) gửi kèm bug report.
 * Vyen chưa có gì tương đương — bug report hiện chỉ có ảnh chụp màn hình.
 *
 * Module này bổ sung 5 việc:
 *
 * 1. EXPORT có version schema (`TRAJECTORY_SCHEMA_VERSION`) → đọc lại được
 *    sau khi Vyen đổi format event, không phá fixture cũ.
 * 2. REDACT bí mật trước khi ghi file: API key, Bearer token, JWT, private key,
 *    mật khẩu trong connection string, `KEY=value` kiểu .env. Trajectory hay
 *    bị dán vào issue/chat, nên redaction phải là MẶC ĐỊNH, không phải option.
 * 3. IMPORT khoan dung: nhận cả JSON đơn khối lẫn JSONL, bỏ qua event hỏng và
 *    báo lại warnings thay vì ném lỗi cả file.
 * 4. THỐNG KÊ phiên (số tool call, lỗi, event lặp theo contentHash, thời lượng)
 *    — cùng tín hiệu mà StuckDetector dùng, nhưng nhìn toàn phiên.
 * 5. DIFF hai trajectory: so cùng một task chạy bằng 2 model/prompt, phát hiện
 *    lệch tool sequence ở event nào và tool nào chỉ xuất hiện ở một bên.
 *
 * Thuần function, không Dexie/React — test được trong node.
 */

import {
  hashEventPayload,
  AGENT_RUNTIME_EVENT_TYPES,
  type AgentRuntimeEvent,
  type AgentRuntimeEventType,
} from './event-stream';
import { sanitizeObservation } from './observation';

/* ------------------------------------------------------------------ */
/* Kiểu dữ liệu                                                        */
/* ------------------------------------------------------------------ */

/** Tăng khi format file đổi theo cách không tương thích ngược. */
export const TRAJECTORY_SCHEMA_VERSION = 1;

export interface TrajectoryMeta {
  conversationId: string;
  /** Model đã chạy phiên (để so sánh khi replay). */
  model?: string;
  title?: string;
  /** Phiên bản app ghi ra file — cần cho bug report. */
  appVersion?: string;
  /** Nhãn tự do: 'eval', 'bug-report', 'regression'... */
  labels?: string[];
  notes?: string;
}

export interface TrajectoryFile {
  schemaVersion: number;
  exportedAt: number;
  meta: TrajectoryMeta;
  events: AgentRuntimeEvent[];
}

export type TrajectoryFormat = 'json' | 'jsonl';

export interface ParseResult {
  trajectory: TrajectoryFile | null;
  errors: string[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

interface RedactRule {
  label: string;
  re: RegExp;
  /** Thay bằng gì — mặc định `[REDACTED:label]`. */
  replace?: string | ((match: string, ...groups: string[]) => string);
}

/**
 * Bộ luật redaction. Cố tình che cả `KEY=value` chung (rule cuối) dù có thể
 * che nhầm hằng số vô hại — an toàn hơn là để lọt khoá thật vào file share.
 */
const REDACT_RULES: readonly RedactRule[] = [
  {
    label: 'private-key',
    re: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  },
  { label: 'openai-key', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g },
  { label: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { label: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: 'google-key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { label: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { label: 'aws-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g },
  { label: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: 'Bearer [REDACTED:bearer]' },
  {
    label: 'db-password',
    re: /((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|https?):\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi,
    replace: '$1[REDACTED:db-password]$3',
  },
  {
    label: 'secret-assignment',
    re: /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|credential|auth(?:orization)?|access[_-]?key)[A-Za-z0-9_.-]*)\s*[:=]\s*["']?([^\s"'`,;)]{6,})/gi,
    replace: '$1=[REDACTED:secret-assignment]',
  },
];

export interface RedactResult {
  text: string;
  /** Số lần thay thế, theo nhãn luật. */
  redactions: number;
  byLabel: Record<string, number>;
}

/**
 * Che bí mật trong một đoạn text. Trả cả số lần che để log/telemetry biết
 * trajectory có chứa bí mật hay không (cảnh báo người dùng đổi key).
 */
export function redactSecrets(text: string): RedactResult {
  let out = text ?? '';
  const byLabel: Record<string, number> = {};
  let total = 0;

  for (const rule of REDACT_RULES) {
    const replacement = rule.replace ?? `[REDACTED:${rule.label}]`;
    out = out.replace(rule.re, (...args: unknown[]) => {
      // Idempotent: đã che rồi thì để nguyên (redact 2 lần không nhân đôi số đếm).
      if (String(args[0]).includes('[REDACTED:')) return String(args[0]);
      total += 1;
      byLabel[rule.label] = (byLabel[rule.label] ?? 0) + 1;
      if (typeof replacement === 'function') {
        const m = String(args[0]);
        const groups = args.slice(1, -2).map((g) => (g === undefined ? '' : String(g)));
        return replacement(m, ...groups);
      }
      // Hỗ trợ $1/$3 trong chuỗi thay thế.
      return replacement.replace(/\$(\d)/g, (_s, d: string) => {
        const idx = Number(d);
        const g = args[idx];
        return g === undefined ? '' : String(g);
      });
    });
  }

  return { text: out, redactions: total, byLabel };
}

/** Redact payload của mọi event. Trả trajectory mới + tổng số lần che. */
export function redactTrajectory(trajectory: TrajectoryFile): {
  trajectory: TrajectoryFile;
  redactions: number;
  byLabel: Record<string, number>;
} {
  const byLabel: Record<string, number> = {};
  let total = 0;
  const events = trajectory.events.map((e) => {
    const r = redactSecrets(e.payload);
    total += r.redactions;
    for (const [k, v] of Object.entries(r.byLabel)) byLabel[k] = (byLabel[k] ?? 0) + v;
    if (r.redactions === 0) return e;
    return Object.freeze({ ...e, payload: r.text, contentHash: hashEventPayload(r.text) });
  });
  return { trajectory: { ...trajectory, events }, redactions: total, byLabel };
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export interface BuildOptions {
  /** Redact ngay khi dựng file. Mặc định BẬT. */
  redact?: boolean;
  /** Chỉ lấy N event cuối (bug report thường không cần cả phiên dài). */
  lastN?: number;
  /** Bỏ event hệ thống (nhiễu khi đọc lại). */
  dropSystemEvents?: boolean;
  exportedAt?: number;
}

export function buildTrajectory(
  events: readonly AgentRuntimeEvent[],
  meta: TrajectoryMeta,
  options: BuildOptions = {},
): TrajectoryFile {
  let list = [...(events ?? [])];
  if (options.dropSystemEvents) list = list.filter((e) => e.type !== 'system_event');
  if (options.lastN && options.lastN > 0) list = list.slice(-options.lastN);

  const base: TrajectoryFile = {
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    exportedAt: options.exportedAt ?? Date.now(),
    meta,
    events: list,
  };
  return options.redact === false ? base : redactTrajectory(base).trajectory;
}

/**
 * Serialize. `jsonl` = dòng đầu là header, mỗi event một dòng — đúng kiểu file
 * trajectory chuẩn, đọc được bằng `tail`/`grep` và append dần.
 */
export function serializeTrajectory(
  trajectory: TrajectoryFile,
  options: { format?: TrajectoryFormat; redact?: boolean; pretty?: boolean } = {},
): string {
  const redacted = options.redact === false ? trajectory : redactTrajectory(trajectory).trajectory;
  const format = options.format ?? 'json';

  if (format === 'jsonl') {
    const header = {
      schemaVersion: redacted.schemaVersion,
      exportedAt: redacted.exportedAt,
      meta: redacted.meta,
    };
    return [JSON.stringify(header), ...redacted.events.map((e) => JSON.stringify(e))].join('\n');
  }

  return options.pretty === false
    ? JSON.stringify(redacted)
    : JSON.stringify(redacted, null, 2);
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

const EVENT_TYPE_SET = new Set<string>(AGENT_RUNTIME_EVENT_TYPES);
const SOURCES = new Set(['user', 'model', 'tool', 'system']);

/** Chuẩn hoá một event thô; trả null + warning nếu không dùng được. */
function normalizeEvent(raw: unknown, fallbackId: number, warnings: string[]): AgentRuntimeEvent | null {
  if (!raw || typeof raw !== 'object') {
    warnings.push(`bỏ qua event #${fallbackId}: không phải object`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === 'string' ? r.type : '';
  if (!EVENT_TYPE_SET.has(type)) {
    warnings.push(`bỏ qua event #${fallbackId}: type không hợp lệ (${type || 'rỗng'})`);
    return null;
  }
  let payload: string;
  if (typeof r.payload === 'string') payload = r.payload;
  else if (r.payload === undefined || r.payload === null) payload = '';
  else if (typeof r.payload === 'object') payload = JSON.stringify(r.payload);
  else payload = String(r.payload);

  const source = typeof r.source === 'string' && SOURCES.has(r.source) ? r.source : 'system';
  return Object.freeze({
    id: typeof r.id === 'number' && Number.isFinite(r.id) ? r.id : fallbackId,
    type: type as AgentRuntimeEventType,
    ts: typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : 0,
    payload,
    ...(typeof r.toolName === 'string' ? { toolName: r.toolName } : {}),
    source: source as AgentRuntimeEvent['source'],
    contentHash: typeof r.contentHash === 'string' ? r.contentHash : hashEventPayload(payload),
  });
}

function looksLikeHeader(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if ('type' in v) return false;
  return 'schemaVersion' in v || 'events' in v || 'meta' in v;
}

function normalizeMeta(raw: unknown, fallback: string): TrajectoryMeta {
  const v = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) ?? {};
  return {
    conversationId: typeof v.conversationId === 'string' ? v.conversationId : fallback,
    ...(typeof v.model === 'string' ? { model: v.model } : {}),
    ...(typeof v.title === 'string' ? { title: v.title } : {}),
    ...(typeof v.appVersion === 'string' ? { appVersion: v.appVersion } : {}),
    ...(Array.isArray(v.labels) ? { labels: v.labels.filter((l): l is string => typeof l === 'string') } : {}),
    ...(typeof v.notes === 'string' ? { notes: v.notes } : {}),
  };
}

/**
 * Đọc trajectory từ text: nhận JSON đơn khối, mảng event thuần, hoặc JSONL
 * (header dòng đầu). Bỏ qua dòng/event hỏng và báo qua `warnings`.
 */
export function parseTrajectory(raw: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = (raw ?? '').replace(/^\uFEFF/, '').trim();
  if (!text) return { trajectory: null, errors: ['input rỗng'], warnings };

  const finish = (header: unknown, rawEvents: unknown[]): ParseResult => {
    const events: AgentRuntimeEvent[] = [];
    rawEvents.forEach((e, i) => {
      const normalized = normalizeEvent(e, i, warnings);
      if (normalized) events.push(normalized);
    });
    if (!events.length && rawEvents.length) errors.push('không có event nào hợp lệ');
    const h = (header && typeof header === 'object' ? (header as Record<string, unknown>) : {}) as Record<string, unknown>;
    const meta = normalizeMeta(h.meta, 'imported');
    const schemaVersion = typeof h.schemaVersion === 'number' ? h.schemaVersion : TRAJECTORY_SCHEMA_VERSION;
    if (typeof h.schemaVersion === 'number' && h.schemaVersion > TRAJECTORY_SCHEMA_VERSION) {
      warnings.push(
        `file dùng schema v${h.schemaVersion} mới hơn bản hiện tại (v${TRAJECTORY_SCHEMA_VERSION}) — có thể thiếu trường`,
      );
    }
    return {
      trajectory: {
        schemaVersion,
        exportedAt: typeof h.exportedAt === 'number' ? h.exportedAt : 0,
        meta,
        events,
      },
      errors,
      warnings,
    };
  };

  // 1) JSON đơn khối (object hoặc mảng) — thử trước.
  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed: unknown;
    let ok = true;
    try {
      parsed = JSON.parse(text);
    } catch {
      ok = false;
    }
    if (ok) {
      if (Array.isArray(parsed)) return finish(null, parsed);
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.events)) return finish(obj, obj.events);
      if ('type' in obj) return finish(null, [obj]); // một event lẻ
      errors.push('JSON hợp lệ nhưng không có mảng `events`');
      return { trajectory: null, errors, warnings };
    }
  }

  // 2) JSONL — mỗi dòng một JSON object.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const header = { schemaVersion: TRAJECTORY_SCHEMA_VERSION, exportedAt: 0, meta: undefined as unknown };
  const rawEvents: unknown[] = [];
  lines.forEach((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(`bỏ qua dòng ${i + 1}: không phải JSON`);
      return;
    }
    if (looksLikeHeader(parsed)) {
      Object.assign(header, parsed as Record<string, unknown>);
      return;
    }
    rawEvents.push(parsed);
  });

  if (!rawEvents.length) {
    errors.push('không đọc được event nào từ JSONL');
    return { trajectory: null, errors, warnings };
  }
  return finish(header, rawEvents);
}

/* ------------------------------------------------------------------ */
/* Thống kê                                                            */
/* ------------------------------------------------------------------ */

export interface TrajectoryStats {
  total: number;
  byType: Partial<Record<AgentRuntimeEventType, number>>;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  toolErrors: number;
  uniqueTools: number;
  /** Event có contentHash trùng event trước đó — tín hiệu vòng lặp. */
  duplicatePayloads: number;
  chars: number;
  avgPayloadChars: number;
  maxPayloadChars: number;
  startTs: number;
  endTs: number;
  durationMs: number;
}

export function trajectoryStats(events: readonly AgentRuntimeEvent[]): TrajectoryStats {
  const byType: Partial<Record<AgentRuntimeEventType, number>> = {};
  const tools = new Set<string>();
  const seen = new Set<string>();
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let duplicatePayloads = 0;
  let chars = 0;
  let maxPayloadChars = 0;
  let startTs = Number.POSITIVE_INFINITY;
  let endTs = Number.NEGATIVE_INFINITY;

  for (const e of events ?? []) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (e.type === 'user_message') userTurns += 1;
    if (e.type === 'assistant_message') assistantTurns += 1;
    if (e.type === 'agent_action') toolCalls += 1;
    if (e.type === 'agent_error') toolErrors += 1;
    if (e.toolName) tools.add(e.toolName);
    if (seen.has(e.contentHash)) duplicatePayloads += 1;
    else seen.add(e.contentHash);
    chars += e.payload.length;
    maxPayloadChars = Math.max(maxPayloadChars, e.payload.length);
    if (Number.isFinite(e.ts) && e.ts > 0) {
      startTs = Math.min(startTs, e.ts);
      endTs = Math.max(endTs, e.ts);
    }
  }

  const total = events?.length ?? 0;
  const hasTs = Number.isFinite(startTs) && Number.isFinite(endTs) && endTs >= startTs;
  return {
    total,
    byType,
    userTurns,
    assistantTurns,
    toolCalls,
    toolErrors,
    uniqueTools: tools.size,
    duplicatePayloads,
    chars,
    avgPayloadChars: total ? Math.round(chars / total) : 0,
    maxPayloadChars,
    startTs: hasTs ? startTs : 0,
    endTs: hasTs ? endTs : 0,
    durationMs: hasTs ? endTs - startTs : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Transcript người đọc được                                           */
/* ------------------------------------------------------------------ */

const TYPE_LABEL: Record<AgentRuntimeEventType, string> = {
  user_message: 'USER',
  assistant_message: 'MODEL',
  agent_action: 'TOOL►',
  agent_observation: 'RESULT◄',
  agent_error: 'ERROR•',
  system_event: 'SYSTEM',
};

/**
 * Render trajectory thành markdown dễ đọc (dùng cho fixture regression:
 * đổi prompt/model rồi so transcript trước–sau). Payload đi qua
 * `sanitizeObservation` nên ANSI/buffer progress không làm rối transcript.
 */
export function formatTrajectoryTranscript(
  trajectory: TrajectoryFile,
  options: { payloadChars?: number; maxEvents?: number } = {},
): string {
  const payloadChars = options.payloadChars ?? 400;
  const events = options.maxEvents ? trajectory.events.slice(-options.maxEvents) : trajectory.events;
  const header = [
    `# Trajectory: ${trajectory.meta.title ?? trajectory.meta.conversationId}`,
    '',
    `- conversationId: \`${trajectory.meta.conversationId}\``,
    ...(trajectory.meta.model ? [`- model: \`${trajectory.meta.model}\``] : []),
    `- schema: v${trajectory.schemaVersion}`,
    `- events: ${trajectory.events.length}`,
    '',
  ];

  const body = events.map((e) => {
    const clean = sanitizeObservation(e.payload, { maxChars: payloadChars, strategy: 'head_tail' }).text;
    const tool = e.toolName ? ` \`${e.toolName}\`` : '';
    return `## #${e.id} ${TYPE_LABEL[e.type]}${tool}\n\n${clean.trim() || '(rỗng)'}`;
  });

  return [...header, ...body].join('\n');
}

/* ------------------------------------------------------------------ */
/* Diff hai trajectory                                                 */
/* ------------------------------------------------------------------ */

export interface TrajectoryDiff {
  /** Chuỗi toolName của action/observation có khớp hoàn toàn không. */
  toolSequenceSame: boolean;
  /** Vị trí event đầu tiên khác nhau; -1 nếu giống hệt. */
  firstDivergenceIndex: number;
  onlyInA: string[];
  onlyInB: string[];
  statsA: TrajectoryStats;
  statsB: TrajectoryStats;
  summary: string;
}

function toolSequence(events: readonly AgentRuntimeEvent[]): string[] {
  return (events ?? [])
    .filter((e) => e.type === 'agent_action')
    .map((e) => e.toolName ?? '?');
}

/** So hai phiên chạy cùng một task — dùng khi thử model/prompt mới. */
export function diffTrajectories(a: TrajectoryFile, b: TrajectoryFile): TrajectoryDiff {
  const seqA = toolSequence(a.events);
  const seqB = toolSequence(b.events);
  const max = Math.max(seqA.length, seqB.length);
  let firstDivergenceIndex = -1;
  for (let i = 0; i < max; i += 1) {
    if ((seqA[i] ?? null) !== (seqB[i] ?? null)) {
      firstDivergenceIndex = i;
      break;
    }
  }

  const statsA = trajectoryStats(a.events);
  const statsB = trajectoryStats(b.events);
  const onlyInA = [...new Set(seqA)].filter((t) => !seqB.includes(t));
  const onlyInB = [...new Set(seqB)].filter((t) => !seqA.includes(t));

  const deltaCalls = statsB.toolCalls - statsA.toolCalls;
  const deltaErrors = statsB.toolErrors - statsA.toolErrors;
  const summary =
    firstDivergenceIndex === -1
      ? `Hai phiên trùng tool sequence (${seqA.length} action); chênh tool call ${deltaCalls >= 0 ? '+' : ''}${deltaCalls}, lỗi ${deltaErrors >= 0 ? '+' : ''}${deltaErrors}.`
      : `Lệch từ action #${firstDivergenceIndex} (A=${seqA[firstDivergenceIndex] ?? '∅'}, B=${seqB[firstDivergenceIndex] ?? '∅'}); A ${statsA.toolCalls} tool call / ${statsA.toolErrors} lỗi, B ${statsB.toolCalls} / ${statsB.toolErrors}.`;

  return {
    toolSequenceSame: firstDivergenceIndex === -1,
    firstDivergenceIndex,
    onlyInA,
    onlyInB,
    statsA,
    statsB,
    summary,
  };
}
