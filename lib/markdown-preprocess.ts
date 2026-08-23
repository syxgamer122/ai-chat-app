const MAX_INLINE_MATH = 400;
const TAIL_WINDOW = 400;
const HEAVY_PASS_LIMIT = 120_000;

/**
 * Gateway sinh ảnh (qwen-image, flux...) trả link ảnh trơn trong text —
 * nâng thành markdown image để hiển thị trực tiếp. Bỏ qua URL đã nằm trong
 * cú pháp markdown (bắt đầu bằng "(" hoặc "]").
 */
const BARE_IMAGE_URL =
  /(^|[\s>])(https?:\/\/[^\s<>()]+\.(?:png|jpe?g|webp|gif|avif)(?:\?[^\s<>()]*)?)(?=[)\s.,!?]|$)/gi;

export function linkifyImages(text: string): string {
  return text.replace(BARE_IMAGE_URL, (_m, pre: string, url: string) => `${pre}![](${url})`);
}

const STRONG_MATH_SIGNAL = /[\\^_{}]/;
const MATH_SIGNAL = /[\\^_{}=<>+\-*/|~]/;

export interface MathSpan {
  start: number;
  end: number;
  display: boolean;
}

interface ScanResult {
  spans: MathSpan[];
  pendingDisplay: number | null;
  danglingLone: number[];
}

function isEscaped(s: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && s.charCodeAt(j) === 92; j -= 1) n += 1;
  return n % 2 === 1;
}

function dollarRun(s: string, i: number): number {
  let n = 0;
  while (i + n < s.length && s[i + n] === '$') n += 1;
  return n;
}

function hasBlankLine(s: string): boolean {
  return /\n[ \t]*\r?\n/.test(s);
}

function looksLikeInlineMath(body: string, nextChar: string): boolean {
  if (!body || body.length > MAX_INLINE_MATH) return false;
  if (hasBlankLine(body)) return false;
  if (body.includes('$')) return false;
  if (/\d/.test(nextChar)) return false;

  const padded = /^\s/.test(body) || /\s$/.test(body);
  if (!padded) return true;

  const trimmed = body.trim();
  if (!trimmed) return false;
  if (!/\s/.test(trimmed)) return true;
  return MATH_SIGNAL.test(trimmed);
}

function findLoneClose(s: string, from: number): number {
  let j = from;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\n') {
      if (/^[ \t]*\r?\n/.test(s.slice(j + 1))) return -1;
      j += 1;
      continue;
    }
    if (ch === '$' && !isEscaped(s, j)) {
      if (dollarRun(s, j) > 1) return -1;
      return j;
    }
    j += 1;
  }
  return -1;
}

export function scanMath(s: string): ScanResult {
  const spans: MathSpan[] = [];
  const danglingLone: number[] = [];
  let pendingDisplay: number | null = null;
  let i = 0;

  while (i < s.length) {
    if (s[i] !== '$' || isEscaped(s, i)) {
      i += 1;
      continue;
    }

    const openRun = dollarRun(s, i);

    if (openRun >= 2) {
      let j = i + openRun;
      let closeAt = -1;
      let closeRun = 0;
      while (j < s.length) {
        if (s[j] === '$' && !isEscaped(s, j)) {
          const r = dollarRun(s, j);
          if (r >= 2) {
            closeAt = j;
            closeRun = r;
            break;
          }
          j += r;
          continue;
        }
        j += 1;
      }
      if (closeAt === -1) {
        pendingDisplay = i;
        break;
      }
      spans.push({ start: i, end: closeAt + closeRun, display: true });
      i = closeAt + closeRun;
      continue;
    }

    const closeAt = findLoneClose(s, i + 1);
    if (closeAt === -1) {
      danglingLone.push(i);
      i += 1;
      continue;
    }

    const body = s.slice(i + 1, closeAt);
    if (looksLikeInlineMath(body, s[closeAt + 1] ?? '')) {
      spans.push({ start: i, end: closeAt + 1, display: false });
      i = closeAt + 1;
    } else {
      danglingLone.push(i);
      i += 1;
    }
  }

  return { spans, pendingDisplay, danglingLone };
}

function isInsideSpan(spans: MathSpan[], offset: number, length: number): boolean {
  for (const sp of spans) {
    if (offset >= sp.start && offset + length <= sp.end) return true;
    if (offset < sp.end && offset + length > sp.start) return true;
  }
  return false;
}

function cutIndexForStream(s: string, scan: ScanResult): number | null {
  if (scan.pendingDisplay !== null) return scan.pendingDisplay;

  for (let k = scan.danglingLone.length - 1; k >= 0; k -= 1) {
    const idx = scan.danglingLone[k];
    if (s.length - idx > TAIL_WINDOW) break;
    const tail = s.slice(idx + 1);
    if (tail.length === 0) return idx;
    if (/^\S/.test(tail) && (STRONG_MATH_SIGNAL.test(tail) || !/\s/.test(tail))) {
      return idx;
    }
  }
  return null;
}

function closeOpenMath(s: string, scan: ScanResult): string {
  if (scan.pendingDisplay !== null) {
    const body = s.slice(scan.pendingDisplay + 2);
    if (!body.trim()) return s.slice(0, scan.pendingDisplay);
    if (hasBlankLine(body)) return s;
    return `${s.replace(/\s+$/, '')}\n$$`;
  }

  const idx = scan.danglingLone[scan.danglingLone.length - 1];
  if (idx === undefined) return s;

  const tail = s.slice(idx + 1);
  if (!tail.trim() || !/^\S/.test(tail)) return s;
  if (tail.length > MAX_INLINE_MATH || hasBlankLine(tail)) return s;
  if (!STRONG_MATH_SIGNAL.test(tail) && /\s/.test(tail.trim())) return s;

  return `${s}$`;
}

function escapeAllDollars(t: string): string {
  if (!t.includes('$')) return t;
  return t.replace(/(\\*)\$/g, (m, slashes: string) =>
    slashes.length % 2 === 1 ? m : `${slashes}\\$`,
  );
}

function escapeStrayDollars(s: string, spans: MathSpan[]): string {
  if (!s.includes('$')) return s;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += escapeAllDollars(s.slice(cursor, span.start));
    out += s.slice(span.start, span.end);
    cursor = span.end;
  }
  out += escapeAllDollars(s.slice(cursor));
  return out;
}

function normalizeLatexDelimiters(s: string): string {
  let out = s.replace(
    /\\\[([\s\S]*?)\\\]/g,
    (_m, body: string, offset: number, full: string) => {
      const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
      const prefix = full.slice(lineStart, offset);
      const inner = String(body).trim();
      if (!inner) return '';
      if (prefix.trim().length > 0) return `$$${inner}$$`;
      const indent = prefix;
      return `\n\n${indent}$$\n${indent}${inner}\n${indent}$$\n\n`;
    },
  );

  out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => {
    const inner = String(body).trim();
    return inner ? `$$${inner}$$` : '';
  });

  return out;
}

const ENV_NAMES =
  'align\\*?|aligned|alignat\\*?|equation\\*?|gather\\*?|gathered|multline\\*?|cases|split|array|[pbBvV]matrix|smallmatrix|CD';

const BARE_ENV = new RegExp(
  `\\\\begin\\{(${ENV_NAMES})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`,
  'g',
);

function wrapBareEnvironments(s: string, spans: MathSpan[]): string {
  if (!s.includes('\\begin{')) return s;
  return s.replace(BARE_ENV, (match, _name, _body, offset: number) => {
    if (isInsideSpan(spans, offset, match.length)) return match;
    return `\n\n$$\n${match}\n$$\n\n`;
  });
}

const CODE_MASK =
  /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|``[\s\S]*?``|`[^`\n]*`|`[^`\n]*$)/g;

function balanceFences(s: string): string {
  let out = s;
  const nl = () => (out.endsWith('\n') ? '' : '\n');
  if (((out.match(/^[ \t]{0,3}```/gm) ?? []).length) % 2 === 1) out += `${nl()}\`\`\``;
  if (((out.match(/^[ \t]{0,3}~~~/gm) ?? []).length) % 2 === 1) out += `${nl()}~~~`;
  return out;
}

/* ------------------------------------------------------------------
 * FIX BUG 3 — lớp phòng thủ artifact JS bị serialize vào text stream
 * ---------------------------------------------------------------- */

const ARTIFACT_TOKEN = String.raw`(?:\[object [A-Za-z]+\]|undefined|null|NaN)`;

/** Artifact nằm trên DÒNG RIÊNG ở cuối chuỗi -> chắc chắn là rác. */
const ARTIFACT_OWN_LINE = new RegExp(
  String.raw`(?:\r?\n[ \t]*${ARTIFACT_TOKEN}[ \t]*)+[\s]*$`,
);

/** Artifact dính ngay sau delimiter toán/HTML đóng -> rác. */
const ARTIFACT_GLUED = new RegExp(
  String.raw`(\$\$|\\\]|\\\)|>)[ \t]*${ARTIFACT_TOKEN}(?:[ \t\r\n]*${ARTIFACT_TOKEN})*[\s]*$`,
);

/** Toàn bộ chuỗi chỉ là artifact. */
const ARTIFACT_ONLY = new RegExp(String.raw`^[\s]*(?:${ARTIFACT_TOKEN}[\s]*)+$`);

/**
 * CHỈ gọi trên segment KHÔNG phải code fence, và chỉ ở segment cuối cùng.
 * Không dùng regex " \bundefined\b$" trần vì sẽ xoá nhầm câu hợp lệ
 * kiểu "biến này trả về undefined".
 */
function stripTrailingArtifacts(s: string): string {
  if (!s) return s;
  if (ARTIFACT_ONLY.test(s)) return '';
  let out = s.replace(ARTIFACT_OWN_LINE, '');
  out = out.replace(ARTIFACT_GLUED, '$1');
  return out;
}

/** Ký tự điều khiển vô hình luôn phải bỏ, kể cả trong code. */
function stripControlChars(s: string): string {
  return s.replace(/\u0000/g, '').replace(/^\uFEFF/, '');
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|svg)(?:[?#][^\s<>)]*)?$/i;
const IMAGE_HOST_RE =
  /^https?:\/\/(?:cdn\.qwenlm\.ai|media\.pollinations\.ai|image\.pollinations\.ai)\//i;

/**
 * Model sinh ảnh (qwen-image, flux...) thường trả về URL ảnh trần trong text.
 * Biến thành cú pháp markdown ảnh để render trực tiếp trong bubble.
 * Bỏ qua URL đã nằm trong cú pháp link/image sẵn — không đụng code fence
 * vì hàm này chỉ chạy trên segment text.
 */
function embedBareImageUrls(s: string): string {
  if (!s.includes('http')) return s;
  return s.replace(
    /(^|[\s(])(https?:\/\/[^\s<>)"']+)/g,
    (match, lead: string, url: string) => {
      const clean = url.replace(/[.,!?;]+$/, '');
      const punct = url.slice(clean.length);
      // Video (qwen-video trả mp4 từ chính các host ảnh) — để nguyên URL trần,
      // GFM autolink + component `a` sẽ render <video> thay vì <img>.
      const isVideo = /\.(?:mp4|webm)(?:[?#][^\s<>)]*)?$/i.test(clean);
      const isImage =
        !isVideo && (IMAGE_EXT_RE.test(clean) || IMAGE_HOST_RE.test(clean));
      if (!isImage || s.includes(`](${clean}`)) return match;
      return `${lead}![${clean}](${clean})${punct}`;
    },
  );
}

export function preprocessMarkdown(raw: string, isStreaming: boolean): string {
  if (!raw) return '';
  const cleaned = linkifyImages(stripControlChars(raw));

  if (cleaned.length > HEAVY_PASS_LIMIT) {
    return balanceFences(stripTrailingArtifacts(cleaned));
  }

  const parts = cleaned.split(CODE_MASK);
  const lastIndex = parts.length - 1;

  const rebuilt = parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // code fence: giữ nguyên tuyệt đối
      if (!part) return part;

      // Artifact chỉ xuất hiện ở đuôi output => chỉ xử lý segment cuối.
      let text = i === lastIndex ? stripTrailingArtifacts(part) : part;
      if (!text) return text;

      text = embedBareImageUrls(text);

      text = normalizeLatexDelimiters(text);
      let scan = scanMath(text);

      const wrapped = wrapBareEnvironments(text, scan.spans);
      if (wrapped !== text) {
        text = wrapped;
        scan = scanMath(text);
      }

      if (i === lastIndex) {
        if (isStreaming) {
          const cut = cutIndexForStream(text, scan);
          text = (cut !== null ? text.slice(0, cut) : text).replace(/\\+$/, '');
          scan = scanMath(text);
        } else {
          const closed = closeOpenMath(text, scan);
          if (closed !== text) {
            text = closed;
            scan = scanMath(text);
          }
        }
      }

      return escapeStrayDollars(text, scan.spans);
    })
    .join('');

  return balanceFences(rebuilt);
}