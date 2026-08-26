/**
 * Naive line diff cho modal phê duyệt ghi file của agent coding.
 *
 * Không dùng thư viện diff đầy đủ (Myers/patience) — với mục đích "người dùng
 * liếc xem agent sắp ghi gì rồi bấm Apply/Discard", thuật toán trim prefix/
 * suffix chung rồi đánh dấu phần giữa là del/add là đủ và DỪNG ĐƯỢC ở mọi
 * input (không bao giờ đệ quy nổ stack như LCS cài đặt ngây thơ).
 */

export type DiffLineType = 'same' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

/** Diff theo dòng: prefix/suffix chung giữ nguyên, phần giữa đánh dấu thay đổi. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ type: 'same', text: a[i] });
  for (let i = start; i < endA; i++) out.push({ type: 'del', text: a[i] });
  for (let i = start; i < endB; i++) out.push({ type: 'add', text: b[i] });
  for (let i = endA; i < a.length; i++) out.push({ type: 'same', text: a[i] });
  return out;
}

export interface UnifiedRenderOptions {
  /** Số dòng same liền nhau được gộp thành "…" để modal gọn. */
  contextLines?: number;
  maxChars?: number;
}

/** Render kiểu unified (- / + / space) có co cụm dòng không đổi. */
export function renderUnifiedDiff(
  lines: readonly DiffLine[],
  opts: UnifiedRenderOptions = {},
): { text: string; adds: number; dels: number } {
  const ctx = opts.contextLines ?? 2;
  const maxChars = opts.maxChars ?? 12_000;

  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type !== 'same') {
      for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
        keep[j] = true;
      }
    }
  });

  const out: string[] = [];
  let adds = 0;
  let dels = 0;
  let skipping = false;

  lines.forEach((l, i) => {
    if (!keep[i]) {
      if (!skipping) {
        out.push('…');
        skipping = true;
      }
      return;
    }
    skipping = false;
    if (l.type === 'add') {
      out.push(`+ ${l.text}`);
      adds += 1;
    } else if (l.type === 'del') {
      out.push(`- ${l.text}`);
      dels += 1;
    } else {
      out.push(`  ${l.text}`);
    }
  });

  let text = out.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… [đã cắt]`;
  return { text, adds, dels };
}
