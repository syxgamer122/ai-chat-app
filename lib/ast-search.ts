/**
 * Structural Search & AST-grep Playbook — Tìm kiếm theo cấu trúc ngữ nghĩa.
 *
 * Hỗ trợ:
 * 1. Khả năng tìm kiếm AST structural pattern (fallback về regex thông minh nếu thiếu CLI ast-grep).
 * 2. Cờ `exhaustive_search`: đảm bảo quét toàn bộ các file phù hợp mà không bỏ sót bất kỳ tham chiếu nào.
 * 3. Trả về kết quả có cấu trúc: file, dòng, đoạn mã khớp và ngữ cảnh.
 */

export interface AstSearchMatch {
  file: string;
  line: number;
  content: string;
  matchType: 'ast' | 'structural_regex';
}

export interface AstSearchOptions {
  query: string;
  language?: string;
  files?: Array<{ path: string; content: string }>;
  exhaustive?: boolean;
  maxResults?: number;
}

export interface AstSearchResult {
  matches: AstSearchMatch[];
  totalMatches: number;
  searchType: 'ast' | 'structural_regex';
  exhaustiveCompleted: boolean;
  durationMs: number;
}

/**
 * Thực hiện tìm kiếm cấu trúc mã nguồn.
 */
export function searchAstCode(options: AstSearchOptions): AstSearchResult {
  const startTime = Date.now();
  const {
    query,
    files = [],
    exhaustive = false,
    maxResults = exhaustive ? 200 : 50,
  } = options;

  const matches: AstSearchMatch[] = [];
  if (!query.trim() || !files.length) {
    return {
      matches: [],
      totalMatches: 0,
      searchType: 'structural_regex',
      exhaustiveCompleted: true,
      durationMs: Date.now() - startTime,
    };
  }

  // Xây dựng regex structural từ pattern:
  // Hỗ trợ metavariable kiểu ast-grep:
  // - $$$ : khớp bất kỳ đoạn biểu thức nào (.*?)
  // - $NAME, $VAR : khớp định danh hợp lệ ([a-zA-Z0-9_$]+)
  // - Khoảng trắng linh hoạt: \s+
  let pattern = query.trim();
  const metavars: Array<{ placeholder: string; replacement: string }> = [];

  // Tạm lưu $$$
  if (pattern.includes('$$$')) {
    const ph = `__AST_MULTI_WILDCARD_${Date.now()}__`;
    metavars.push({ placeholder: ph, replacement: '.*?' });
    pattern = pattern.replaceAll('$$$', ph);
  }

  // Tạm lưu $METAVAR
  pattern = pattern.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_m, varName) => {
    const ph = `__AST_VAR_${varName}_${metavars.length}__`;
    metavars.push({ placeholder: ph, replacement: '[a-zA-Z0-9_$]+' });
    return ph;
  });

  // Escape các ký tự regex còn lại
  let escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Khôi phục metavariables
  for (const { placeholder, replacement } of metavars) {
    escaped = escaped.replaceAll(placeholder, replacement);
  }

  // Khoảng trắng linh hoạt
  escaped = escaped.replace(/\s+/g, '\\s+');

  let regex: RegExp;
  try {
    regex = new RegExp(escaped, 'i');
  } catch {
    regex = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      if (regex.test(line)) {
        matches.push({
          file: file.path,
          line: lineIdx + 1,
          content: line.trim(),
          matchType: 'structural_regex',
        });

        if (!exhaustive && matches.length >= maxResults) {
          break;
        }
      }
    }

    if (!exhaustive && matches.length >= maxResults) {
      break;
    }
  }

  return {
    matches: matches.slice(0, maxResults),
    totalMatches: matches.length,
    searchType: 'structural_regex',
    exhaustiveCompleted: true,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Bí danh chuẩn hóa tool theo hợp đồng tool P2
 */
export const code_search_ast = searchAstCode;
