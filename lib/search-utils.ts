/**
 * Chuẩn hoá & tokenize phục vụ tìm kiếm tiếng Việt (bỏ dấu, lowercase),
 * giữ được bản đồ offset để highlight chính xác trên văn bản gốc.
 */

const CHAR_OVERRIDES: Record<string, string> = {
  đ: 'd', Đ: 'd', ð: 'd', Ð: 'd',
  ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae',
  ß: 'ss', ł: 'l', Ł: 'l',
};

/** Chuẩn hoá 1 code point: bỏ dấu tổ hợp + lowercase. */
function foldChar(ch: string): string {
  const override = CHAR_OVERRIDES[ch];
  if (override) return override;
  return ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export interface FoldedText {
  /** Chuỗi đã bỏ dấu, lowercase. */
  folded: string;
  /** map[i] = offset (UTF-16) trong chuỗi gốc của ký tự folded thứ i. */
  map: number[];
}

/** Fold có bản đồ offset — dùng khi cần highlight/snippet. */
export function foldWithMap(text: string): FoldedText {
  const out: string[] = [];
  const map: number[] = [];
  let originalIndex = 0;

  for (const ch of text) {
    const folded = foldChar(ch);
    for (const c of folded) {
      out.push(c);
      map.push(originalIndex);
    }
    originalIndex += ch.length; // an toàn với surrogate pair (emoji)
  }

  return { folded: out.join(''), map };
}

/** Fold nhanh — dùng khi không cần offset. Kết quả luôn khớp foldWithMap().folded. */
export function foldText(text: string): string {
  let out = '';
  for (const ch of text) out += foldChar(ch);
  return out;
}

export const MIN_TOKEN_LENGTH = 2;
export const MAX_TOKENS_PER_MESSAGE = 600;

/**
 * Tách nội dung thành danh sách token duy nhất, đã fold.
 * Dùng cho index multiEntry `*tokens` trong Dexie.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const folded = foldText(text);
  const seen = new Set<string>();

  for (const raw of folded.split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    // Cắt token quá dài (base64, hash...) để index không phình
    seen.add(raw.length > 40 ? raw.slice(0, 40) : raw);
    if (seen.size >= MAX_TOKENS_PER_MESSAGE) break;
  }

  return Array.from(seen);
}

/** Tách truy vấn của người dùng thành các từ khoá đã fold. */
export function parseQueryTerms(query: string): string[] {
  const folded = foldText(query).trim();
  if (!folded) return [];
  return Array.from(
    new Set(folded.split(/\s+/).filter((t) => t.length > 0)),
  ).sort((a, b) => b.length - a.length); // dài nhất trước → làm "anchor"
}

/* ------------------------------------------------------------------ */
/* Highlight                                                          */
/* ------------------------------------------------------------------ */

export interface SnippetSegment {
  text: string;
  match: boolean;
}

interface Range {
  start: number;
  end: number;
}

function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push(sorted[i]);
    }
  }
  return merged;
}

/** Cắt `text` thành các đoạn match / không match theo `terms` (đã fold). */
export function buildHighlightSegments(
  text: string,
  terms: string[],
): SnippetSegment[] {
  if (!text) return [];
  if (terms.length === 0) return [{ text, match: false }];

  const { folded, map } = foldWithMap(text);
  const raw: Range[] = [];

  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    while (from <= folded.length - term.length) {
      const idx = folded.indexOf(term, from);
      if (idx === -1) break;
      raw.push({ start: idx, end: idx + term.length });
      from = idx + term.length;
      if (raw.length > 200) break; // chặn pathological input
    }
  }

  if (raw.length === 0) return [{ text, match: false }];

  const toOriginal = (foldedIndex: number) =>
    foldedIndex < map.length ? map[foldedIndex] : text.length;

  const segments: SnippetSegment[] = [];
  let cursor = 0;

  for (const range of mergeRanges(raw)) {
    const start = toOriginal(range.start);
    const end = toOriginal(range.end);
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });

  return segments;
}

/**
 * Tạo snippet quanh vị trí khớp đầu tiên, kèm segment highlight.
 * Trả về null nếu không có từ khoá nào xuất hiện trong `content`.
 */
export function buildSnippet(
  content: string,
  terms: string[],
  radius = 70,
): SnippetSegment[] | null {
  if (!content || terms.length === 0) return null;

  const { folded, map } = foldWithMap(content);

  let bestIndex = -1;
  let bestLength = 0;
  for (const term of terms) {
    const idx = folded.indexOf(term);
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx;
      bestLength = term.length;
    }
  }
  if (bestIndex === -1) return null;

  const from = Math.max(0, bestIndex - radius);
  const to = Math.min(folded.length, bestIndex + bestLength + radius * 2);

  let start = from < map.length ? map[from] : 0;
  let end = to < map.length ? map[to] : content.length;

  // Bám vào biên từ cho dễ đọc
  if (start > 0) {
    const space = content.indexOf(' ', start);
    if (space !== -1 && space - start < 15) start = space + 1;
  }
  if (end < content.length) {
    const space = content.lastIndexOf(' ', end);
    if (space > start && end - space < 15) end = space;
  }

  const slice = content.slice(start, end).replace(/\s+/g, ' ').trim();
  const segments = buildHighlightSegments(slice, terms);

  if (start > 0) segments.unshift({ text: '… ', match: false });
  if (end < content.length) segments.push({ text: ' …', match: false });

  return segments;
}
