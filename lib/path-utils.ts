/**
 * Path normalization utility — single source of truth cho việc chuẩn hóa
 * đường dẫn tương đối dùng làm key so sánh (staging, read-before-edit...).
 *
 * TRƯỚC ĐÂY logic này lặp lại ở 6 nơi (tool-call-budget, staging, chat-interface ×4).
 * Sửa một nơi phải sửa cả sáu — giờ gộp về đây.
 *
 * LƯU Ý: Đây là normalization cho KEY SO SÁNH (lowercase, strip prefix/suffix).
 * KHÁC với normalizeRelPath() trong fs-access.ts vốn là security guard
 * (strip .., reject absolute paths) — KHÔNG được gộp hai hàm này.
 */

export function normalizePathKey(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}
