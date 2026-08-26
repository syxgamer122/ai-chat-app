/**
 * SEARCH/REPLACE edit blocks — port từ aider `coders/editblock_coder.py`
 * (Apache-2.0), thu gọn về TS thuần cho agent coding của KODA.
 *
 * Vì sao: model free viết khối edit rất hay lệch — thiếu/thừa indent, bọc
 * thêm fence, quên tên file, dùng "..." để lược code. Chuỗi fallback của
 * aider xử lý gần hết mà KHÔNG cần fuzzy matching (họ đã TẮT
 * replace_closest_edit_distance vì nguy hiểm — giữ nguyên quyết định đó,
 * chỉ để lại cờ opt-in).
 *
 * Cấu trúc khối:
 *   <<<<<<< SEARCH
 *   (đoạn cần tìm — phải khớp duy nhất trong file)
 *   =======
 *   (nội dung thay thế)
 *   >>>>>>> REPLACE
 */

const HEAD_RE = /^<{5,9}\s*SEARCH>?\s*$/;
const DIVIDER_RE = /^={5,9}\s*$/;
const UPDATED_RE = /^>{5,9}\s*REPLACE\s*$/;

const SHELL_FENCE_PREFIXES = [
  '```bash',
  '```sh',
  '```shell',
  '```cmd',
  '```batch',
  '```powershell',
  '```ps1',
  '```zsh',
  '```fish',
];

export interface EditBlock {
  filename: string;
  search: string;
  replace: string;
}

export interface ParseEditBlocksResult {
  blocks: EditBlock[];
  /** Lỗi parse có kèm vị trí — model dùng để tự sửa ở lượt kế. */
  error?: string;
}

/** Bỏ fence + dòng tên file mà model hay bọc quanh khối. */
function stripQuotedWrapping(res: string): string {
  const lines = res.split('\n');
  if (lines.length < 3) return res;
  const first = lines[0].replace(/^```[^\n]*$/, '').trim();
  const last = lines[lines.length - 1].replace(/^```[^\n]*$/, '').trim();
  if (lines[0].startsWith('```') && lines[lines.length - 1].startsWith('```') && first) {
    return lines.slice(1, lines.length - 1).join('\n');
  }
  return res;
}

/** Tên file từ tối đa 3 dòng trước HEAD — model hay viết trong fence riêng. */
function findFilename(precedingLines: string[]): string | null {
  const candidates: string[] = [];
  for (const line of precedingLines.slice(-3).reverse()) {
    const stripped = line
      .replace(/^```[^\n]*$/, '')
      .replace(/^#+\s*/, '')
      .trim();
    if (stripped && !stripped.startsWith('```') && !/[<>]/.test(stripped)) {
      candidates.push(stripped);
    }
    if (!line.startsWith('```')) break; // hết vùng fence thì dừng
  }
  return candidates[0] ?? null;
}

/**
 * Parse các khối SEARCH/REPLACE từ output của model. Khoan dung: marker 5-9
 * ký tự, tên file nằm ở dòng trước (kể cả trong fence), tên file carry-over
 * cho nhiều khối cùng file, bỏ qua code fence shell (trừ khi dòng kế là HEAD).
 */
export function parseEditBlocks(content: string): ParseEditBlocksResult {
  const lines = (content ?? '').split('\n');
  const blocks: EditBlock[] = [];
  let currentFilename: string | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence shell: bỏ qua trừ khi dòng kế (hoặc kế nữa) là HEAD.
    const nextIsHead =
      (i + 1 < lines.length && HEAD_RE.test(lines[i + 1].trim())) ||
      (i + 2 < lines.length && HEAD_RE.test(lines[i + 2].trim()));
    if (SHELL_FENCE_PREFIXES.some((p) => line.trim().startsWith(p)) && !nextIsHead) {
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) i += 1;
      if (i < lines.length) i += 1;
      continue;
    }

    if (!HEAD_RE.test(line.trim())) {
      i += 1;
      continue;
    }

    // Tên file: 3 dòng trước HEAD.
    let filename = findFilename(lines.slice(Math.max(0, i - 3), i));
    if (!filename) filename = currentFilename;
    if (!filename) {
      return {
        blocks,
        error: 'Khối SEARCH thiếu tên file. Ghi tên file ở dòng ngay trên <<<<<<< SEARCH.',
      };
    }
    currentFilename = filename;

    // SEARCH body tới DIVIDER.
    const searchLines: string[] = [];
    i += 1;
    while (i < lines.length && !DIVIDER_RE.test(lines[i].trim())) {
      searchLines.push(lines[i]);
      i += 1;
    }
    if (i >= lines.length) {
      return { blocks, error: 'Thiếu dòng ======= ngăn cách SEARCH/REPLACE.' };
    }

    // REPLACE body tới UPDATED hoặc DIVIDER (khối mới cùng file).
    const replaceLines: string[] = [];
    i += 1;
    while (i < lines.length && !UPDATED_RE.test(lines[i].trim()) && !DIVIDER_RE.test(lines[i].trim())) {
      replaceLines.push(lines[i]);
      i += 1;
    }
    if (i >= lines.length) {
      return { blocks, error: 'Thiếu dòng >>>>>>> REPLACE kết thúc khối.' };
    }

    blocks.push({
      filename,
      search: stripQuotedWrapping(searchLines.join('\n')),
      replace: stripQuotedWrapping(replaceLines.join('\n')),
    });
    i += 1;
  }

  if (!blocks.length) {
    return { blocks, error: 'Không tìm thấy khối SEARCH/REPLACE nào trong nội dung.' };
  }
  return { blocks };
}

/* ------------------------------------------------------------------ */
/* Chuỗi áp dụng — perfect → whitespace → blank-line → dotdotdots      */
/* ------------------------------------------------------------------ */

interface ApplyOptions {
  /** Fuzzy edit-distance (nguy hiểm — aider đã tắt, mặc định false). */
  allowFuzzy?: boolean;
}

export interface ApplyResult {
  ok: boolean;
  text?: string;
  /** Gợi ý "did you mean" khi SEARCH không tìm thấy — model tự sửa. */
  hint?: string;
  strategy?: string;
}

function prep(text: string): { text: string; lines: string[] } {
  const withNl = text && !text.endsWith('\n') ? `${text}\n` : text;
  return { text: withNl, lines: withNl.split('\n').slice(0, -1) };
}

function perfectReplace(
  wholeLines: string[],
  partLines: string[],
  replaceLines: string[],
): string | null {
  const partLen = partLines.length;
  for (let i = 0; i <= wholeLines.length - partLen; i++) {
    let match = true;
    for (let j = 0; j < partLen; j++) {
      if (wholeLines[i + j] !== partLines[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return [...wholeLines.slice(0, i), ...replaceLines, ...wholeLines.slice(i + partLen)].join('\n');
    }
  }
  return null;
}

/** Cả ORIG lẫn UPD bị outdent/indent ĐỀU nhất — bù lại prefix tìm được. */
function matchButForLeadingWhitespace(
  wholeLines: string[],
  partLines: string[],
): string | null {
  const sameBody = wholeLines.every(
    (w, i) => w.replace(/^\s+/, '') === partLines[i].replace(/^\s+/, ''),
  );
  if (!sameBody) return null;
  const prefixes = new Set(
    wholeLines
      .map((w, i) => {
        if (!w.trim()) return '';
        /* Prefix đúng của w = phần TRƯỚC thân chung với partLines[i].
           Dùng độ dài thân (sau khi bỏ indent) chứ không phải độ dài dòng
           part — SEARCH thụy sâu hơn file từng làm chỉ số âm, slice(0, âm)
           cắt từ CUỐI dòng ra prefix rác rồi ghi đè file user. */
        const body = partLines[i].replace(/^\s+/, '');
        return w.slice(0, w.length - body.length);
      })
      .filter((p) => p !== ''),
  );
  if (prefixes.size !== 1) return null;
  return [...prefixes][0];
}

function replacePartWithMissingLeadingWhitespace(
  wholeLines: string[],
  partLines: string[],
  replaceLines: string[],
): string | null {
  const indents = [...partLines, ...replaceLines]
    .filter((p) => p.trim())
    .map((p) => p.length - p.replace(/^\s+/, '').length);
  if (indents.length && Math.min(...indents) > 0) {
    const cut = Math.min(...indents);
    partLines = partLines.map((p) => (p.trim() ? p.slice(cut) : p));
    replaceLines = replaceLines.map((p) => (p.trim() ? p.slice(cut) : p));
  }

  for (let i = 0; i <= wholeLines.length - partLines.length; i++) {
    const window = wholeLines.slice(i, i + partLines.length);
    const prefix = matchButForLeadingWhitespace(window, partLines);
    if (prefix === null) continue;
    const patched = replaceLines.map((r) => (r.trim() ? prefix + r : r));
    return [...wholeLines.slice(0, i), ...patched, ...wholeLines.slice(i + partLines.length)].join('\n');
  }
  return null;
}

function perfectOrWhitespace(
  wholeLines: string[],
  partLines: string[],
  replaceLines: string[],
): { text: string; strategy: string } | null {
  const perfect = perfectReplace(wholeLines, partLines, replaceLines);
  if (perfect !== null) return { text: perfect, strategy: 'exact' };
  const flex = replacePartWithMissingLeadingWhitespace(wholeLines, partLines, replaceLines);
  if (flex !== null) return { text: flex, strategy: 'whitespace' };
  return null;
}

/** Khối có dòng "..." lược code: tách mảnh, mỗi mảnh phải khớp duy nhất. */
function tryDotDotDots(whole: string, part: string, replace: string): string | null {
  const dotsRe = /^[ \t]*\.\.\.[ \t]*\n/gm;
  const partPieces = part.split(dotsRe);
  const replacePieces = replace.split(dotsRe);
  if (partPieces.length !== replacePieces.length) return null;
  if (partPieces.length === 1) return null;

  let out = whole.endsWith('\n') ? whole : `${whole}\n`;
  for (let k = 0; k < partPieces.length; k++) {
    const p = partPieces[k];
    const r = replacePieces[k];
    if (!p && !r) continue;
    if (!p && r) {
      out += r.endsWith('\n') ? r : `${r}\n`;
      continue;
    }
    const count = out.split(p).length - 1;
    if (count !== 1) return null; // 0 hoặc >1 lần → từ chối (aider raise)
    out = out.replace(p, r);
  }
  return out;
}

/** Gợi ý chỗ giống SEARCH nhất trong file (threshold 0.6) — cho error hint.
    So khớp theo dòng TRIMMED: model hay lệch indent, hint vẫn phải ra. */
export function findSimilarLines(searchText: string, contentText: string, threshold = 0.6): string | null {
  const searchLines = searchText.split('\n');
  const contentLines = contentText.split('\n');
  if (!searchLines.length || searchLines.length > contentLines.length) return null;

  const norm = (l: string) => l.trim();
  const searchSet = new Map<string, number>();
  for (const l of searchLines) searchSet.set(norm(l), (searchSet.get(norm(l)) ?? 0) + 1);

  let bestRatio = 0;
  let bestStart = 0;
  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const window = contentLines.slice(i, i + searchLines.length);
    const winSet = new Map<string, number>();
    for (const l of window) {
      const n = norm(l);
      winSet.set(n, (winSet.get(n) ?? 0) + 1);
    }
    let matched = 0;
    for (const [line, n] of searchSet) {
      const w = winSet.get(line) ?? 0;
      matched += Math.min(n, w);
    }
    const ratio = (2 * matched) / (searchLines.length + window.length);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestStart = i;
    }
  }
  if (bestRatio < threshold) return null;
  return contentLines.slice(bestStart, bestStart + searchLines.length).join('\n');
}

/**
 * Áp MỘT khối edit lên nội dung file theo chuỗi fallback của aider.
 * Trả `{ ok:false, hint }` khi không tìm thấy — hint là đoạn giống nhất để
 * model tự chỉnh khối SEARCH ở lượt kế.
 */
export function replaceMostSimilarChunk(
  whole: string,
  part: string,
  replace: string,
  opts: ApplyOptions = {},
): ApplyResult {
  const { text: wholeN, lines: wholeLines } = prep(whole);
  let { lines: partLines } = prep(part);
  let { lines: replaceLines } = prep(replace);

  let res = perfectOrWhitespace(wholeLines, partLines, replaceLines);
  if (res !== null) return { ok: true, text: res.text, strategy: res.strategy };

  // GPT hay tự thêm dòng trắng đầu khối (aider issue #25).
  if (partLines.length > 2 && !partLines[0].trim()) {
    res = perfectOrWhitespace(wholeLines, partLines.slice(1), replaceLines);
    if (res !== null) return { ok: true, text: res.text, strategy: `skip-blank+${res.strategy}` };
  }

  // Elision "..." — chia mảnh khớp duy nhất.
  try {
    const dots = tryDotDotDots(wholeN, part, replace);
    if (dots !== null) return { ok: true, text: dots, strategy: 'dotdotdots' };
  } catch {
    /* ValueError của aider tương ứng return null ở đây */
  }

  if (opts.allowFuzzy) {
    // Giữ chuẩn aider: fuzzy TẮT mặc định — chỉ bật khi caller hiểu rủi ro.
    const similarity = (a: string, b: string): number => {
      const sa = new Set(a.split(/\s+/).filter(Boolean));
      const sb = new Set(b.split(/\s+/).filter(Boolean));
      let inter = 0;
      for (const t of sa) if (sb.has(t)) inter += 1;
      return (2 * inter) / (sa.size + sb.size || 1);
    };
    const scale = 0.1;
    const minLen = Math.floor(partLines.length * (1 - scale));
    const maxLen = Math.ceil(partLines.length * (1 + scale));
    let bestRatio = 0;
    let bestStart = -1;
    let bestEnd = -1;
    for (let len = minLen; len <= maxLen; len++) {
      for (let i = 0; i <= wholeLines.length - len; i++) {
        const chunk = wholeLines.slice(i, i + len).join('\n');
        const ratio = similarity(chunk, partLines.join('\n'));
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestStart = i;
          bestEnd = i + len;
        }
      }
    }
    if (bestRatio >= 0.8 && bestStart >= 0) {
      return {
        ok: true,
        text: [...wholeLines.slice(0, bestStart), ...replaceLines, ...wholeLines.slice(bestEnd)].join('\n'),
        strategy: `fuzzy(${bestRatio.toFixed(2)})`,
      };
    }
  }

  const similar = findSimilarLines(partLines.join('\n'), wholeLines.join('\n'));
  return {
    ok: false,
    hint: similar
      ? `Không tìm thấy đoạn SEARCH khớp. Đoạn GIỐNG NHẤT trong file:\n${similar}`
      : 'Không tìm thấy đoạn SEARCH trong file. Hãy đọc lại file rồi viết khối SEARCH khớp NGUYÊN VĂN.',
    strategy: 'not-found',
  };
}
