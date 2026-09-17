/**
 * Request Scorer — chấm điểm yêu cầu từ tín hiệu tường minh để phân loại hạng mục model.
 *.
 *
 * Nguyên tắc:
 * 1. Chấm điểm từ tín hiệu TƯỜNG MINH (explicit signals), không đoán mò.
 * 2. Cờ exhaustive_search bật khi yêu cầu tìm kiếm toàn diện ("tìm mọi chỗ", "tất cả reference").
 * 3. Trả về category thích hợp nhất kèm danh sách signals giải thích lý do.
 */

import type { CategoryId } from '@/lib/routing/categories';

export interface ScoreRequestInput {
  text: string;
  fileScope?: string[];
  isPlanMode?: boolean;
}

export interface ScoreRequestResult {
  category: CategoryId;
  signals: string[];
  exhaustiveSearch: boolean;
}

// Regex patterns cho các tín hiệu tường minh với ranh giới từ Unicode (/u)
const EXHAUSTIVE_SEARCH_RE =
  /(?<![\p{L}\p{N}])(tìm\s+mọi\s+chỗ|tất\s+cả\s+reference|toàn\s+bộ\s+chỗ\s+dùng|search\s+everywhere|find\s+all(?:\s+references)?|exhaustive(?:\s+search)?|every\s+occurrence)(?![\p{L}\p{N}])/iu;

const ARCHITECT_RE =
  /(?<![\p{L}\p{N}])(thiết\s+kế\s+kiến\s+trúc|kiến\s+trúc\s+hệ\s+thống|architecture\s+design|system\s+design|refactor\s+(?:lớn|toàn\s+bộ|hệ\s+thống)|chia\s+phase|modularity|database\s+migration|thiết\s+kế\s+module)(?![\p{L}\p{N}])/iu;

const ULTRABRAIN_RE =
  /(?<![\p{L}\p{N}])(bài\s+toán\s+rất\s+khó|thuật\s+toán\s+phức\s+tạp|formal\s+verification|np-hard|chứng\s+minh\s+toán\s+học|distributed\s+consensus|bảo\s+mật\s+chuyên\s+sâu|advanced\s+cryptography)(?![\p{L}\p{N}])/iu;

const DEEP_RE =
  /(?<![\p{L}\p{N}])(suy\s+luận\s+sâu|root\s+cause|nguyên\s+nhân\s+gốc\s+rễ|debug\s+(?:lỗi\s+)?(?:khó|memory\s+leak|race\s+condition|deadlock)|race\s+condition|deadlock|memory\s+leak|tại\s+sao\s+test\s+này\s+fail|investigate|mổ\s+xẻ\s+lỗi)(?![\p{L}\p{N}])/iu;

const VISUAL_RE =
  /(?<![\p{L}\p{N}])(css|tailwind|giao\s+diện|ui|ux|styling|layout|responsive|theme|màu\s+sắc|flexbox|grid\s+layout|visual|animation|button\s+style|dark\s+mode)(?![\p{L}\p{N}])/iu;

const WRITING_RE =
  /(?<![\p{L}\p{N}])(viết\s+(?:readme|tài\s+liệu|doc|báo\s+cáo|blog|changelog|hướng\s+dẫn)|dịch\s+(?:sang|thuật)|tóm\s+tắt\s+văn\s+bản|paraphrase|prose|release\s+notes)(?![\p{L}\p{N}])/iu;

const RENAME_OR_SINGLE_FILE_RE =
  /(?<![\p{L}\p{N}])(đổi\s+tên\s+(?:biến|hàm|file|symbol)|rename\s+(?:variable|function|symbol)|sửa\s+typo|fix\s+typo|thay\s+1\s+từ|format\s+code|xóa\s+console\.log)(?![\p{L}\p{N}])/iu;

const SIMPLE_WORK_RE =
  /(?<![\p{L}\p{N}])(kiểm\s+tra\s+cú\s+pháp|check\s+syntax|chỉ\s+in\s+ra|ping|hello|xin\s+chào|tính\s+\d+[\+\-\*\/]\d+)(?![\p{L}\p{N}])/iu;

/**
 * Chấm điểm và phân loại request vào một CategoryId.
 */
export function scoreRequest(input: ScoreRequestInput): ScoreRequestResult {
  const text = (input.text || '').trim();
  const fileScope = input.fileScope || [];
  const isPlanMode = Boolean(input.isPlanMode);

  const signals: string[] = [];
  let exhaustiveSearch = false;

  // 1. Kiểm tra cờ tìm kiếm toàn diện
  if (EXHAUSTIVE_SEARCH_RE.test(text)) {
    exhaustiveSearch = true;
    signals.push('exhaustive_search');
  }

  // 2. Plan Mode luôn yêu cầu tư duy kiến trúc
  if (isPlanMode) {
    signals.push('plan_mode_active');
  }

  // 3. Phân tích fileScope
  if (fileScope.length > 5) {
    signals.push(`broad_file_scope(${fileScope.length}_files)`);
  } else if (fileScope.length === 1) {
    signals.push('single_file_scope');
  }

  // 4. Match signals
  if (RENAME_OR_SINGLE_FILE_RE.test(text)) {
    signals.push('rename_or_minor_tweak');
  }
  if (ARCHITECT_RE.test(text)) {
    signals.push('architectural_signal');
  }
  if (ULTRABRAIN_RE.test(text)) {
    signals.push('ultrabrain_signal');
  }
  if (DEEP_RE.test(text)) {
    signals.push('deep_reasoning_signal');
  }
  if (VISUAL_RE.test(text)) {
    signals.push('visual_engineering_signal');
  }
  if (WRITING_RE.test(text)) {
    signals.push('writing_signal');
  }
  if (SIMPLE_WORK_RE.test(text)) {
    signals.push('simple_work_signal');
  }

  // 5. Quyết định hạng mục theo độ ưu tiên tường minh
  // a. Plan Mode hoặc yêu cầu kiến trúc hoặc phạm vi > 5 files kèm refactor
  if (isPlanMode || signals.includes('architectural_signal') || (fileScope.length > 5 && text.toLowerCase().includes('refactor'))) {
    return {
      category: 'architect',
      signals: signals.length ? signals : ['architect_default'],
      exhaustiveSearch,
    };
  }

  // b. Bài toán suy luận cực đỉnh (Ultrabrain)
  if (signals.includes('ultrabrain_signal')) {
    return {
      category: 'ultrabrain',
      signals,
      exhaustiveSearch,
    };
  }

  // c. Suy luận sâu / debug nguyên nhân gốc rễ
  if (signals.includes('deep_reasoning_signal')) {
    return {
      category: 'deep',
      signals,
      exhaustiveSearch,
    };
  }

  // d. Giao diện / CSS / Visual
  if (signals.includes('visual_engineering_signal')) {
    return {
      category: 'visual-engineering',
      signals,
      exhaustiveSearch,
    };
  }

  // e. Viết văn bản / tài liệu / dịch
  if (signals.includes('writing_signal')) {
    return {
      category: 'writing',
      signals,
      exhaustiveSearch,
    };
  }

  // f. Tác vụ nhanh: rename, sửa typo, câu hỏi rất ngắn 1 file
  if (signals.includes('rename_or_minor_tweak') || (signals.includes('single_file_scope') && text.length < 100)) {
    return {
      category: 'quick',
      signals,
      exhaustiveSearch,
    };
  }

  // g. Tác vụ siêu đơn giản
  if (signals.includes('simple_work_signal') && text.length < 50) {
    return {
      category: 'simple-work',
      signals,
      exhaustiveSearch,
    };
  }

  // h. Exhaustive search không thuộc nhóm trên -> ưu tiên deep để không sót reference
  if (exhaustiveSearch) {
    return {
      category: 'deep',
      signals,
      exhaustiveSearch: true,
    };
  }

  // i. Mặc định cho coding chuẩn
  signals.push('standard_coding_fallback');
  return {
    category: 'capable',
    signals,
    exhaustiveSearch,
  };
}
