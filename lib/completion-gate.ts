/**
 * Completion-Integrity Gate — cổng kiểm định tính liêm chính của mã nguồn (Oh My Hermes port).
 *
 * Từ chối nâng trạng thái lên "verified" nếu diff có dấu hiệu làm khống (stubbing, fake pass):
 * - Thêm TODO / FIXME / not implemented
 * - Thêm it.skip, test.skip, describe.skip, xit, xtest để qua mặt test
 * - Xóa test suites để làm giảm độ phủ kiểm thử
 * - Cập nhật snapshot mà không có assertion mới
 */

export interface IntegrityCheckResult {
  ok: boolean;
  violations: string[];
}

const STUB_PATTERNS = [
  {
    pattern: /\bthrow\s+new\s+Error\s*\(\s*['"`](?:not\s+implemented|todo|stub)['"`]\s*\)/i,
    reason: 'Chứa stub ngoại lệ chưa hoàn thiện (throw new Error("not implemented"))',
  },
  {
    pattern: /\b(?:it|test|describe)\.skip\b/,
    reason: 'Lạm dụng .skip để vô hiệu hóa bài kiểm thử thay vì sửa lỗi',
  },
  {
    pattern: /\b(?:xit|xtest)\s*\(/,
    reason: 'Lạm dụng xit/xtest để tắt kiểm thử',
  },
  {
    pattern: /\/\/\s*(?:TODO|FIXME):?\s*(?:làm\s+sau|chưa\s+xong|implement\s+later|stub)/i,
    reason: 'Chứa chú thích trì hoãn triển khai (TODO/FIXME implement later)',
  },
  {
    pattern: /return\s+null\s*;\s*\/\/\s*stub/i,
    reason: 'Trả về giá trị rỗng kèm nhãn stub giả tạo',
  },
];

/**
 * Kiểm tra mã nguồn hoặc diff để phát hiện vi phạm liêm chính.
 */
export function evaluateCompletionIntegrity(diffOrCode: string): IntegrityCheckResult {
  const violations: string[] = [];
  if (!diffOrCode) return { ok: true, violations };

  for (const { pattern, reason } of STUB_PATTERNS) {
    if (pattern.test(diffOrCode)) {
      violations.push(reason);
    }
  }

  // Kiểm tra trường hợp test bị xoá trắng trong diff:
  // Nếu số dòng "- test(" hoặc "- it(" vượt quá số dòng "+ test(" hoặc "+ it("
  const removedTests = (diffOrCode.match(/^-\s*(?:it|test)\s*\(/gm) || []).length;
  const addedTests = (diffOrCode.match(/^\+\s*(?:it|test)\s*\(/gm) || []).length;
  if (removedTests > 0 && addedTests === 0) {
    violations.push(`Xóa bỏ ${removedTests} bài kiểm thử thay vì sửa mã để test pass`);
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}
