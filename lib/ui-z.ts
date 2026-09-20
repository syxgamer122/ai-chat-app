/**
 * Thang z-index tập trung (DESIGN.md mục 4).
 *
 * Vì sao cần file này: trước đây mỗi overlay tự chọn số tuỳ hứng, dẫn tới
 * 5 modal cùng `z-[100]` (thứ tự chồng do thứ tự DOM quyết định), menu ngữ cảnh
 * sidebar cũng `z-[100]` (nổi trên cả modal), và nghiêm trọng nhất là **Settings
 * ở `z-50` — thấp hơn mọi modal**, nên mở Cài đặt trong lúc có modal phê duyệt
 * thì modal vẽ đè lên Cài đặt.
 *
 * Quy ước: số càng lớn càng gần người dùng. Mọi overlay mới PHẢI lấy số từ đây,
 * không tự đặt.
 */

export const Z_INDEX = {
  /** Nội dung nền: chat, sidebar, status line. */
  content: 0,
  /** Dropdown gắn với control: TaskMenu, ThinkingMenu, menu ngữ cảnh phiên. */
  dropdown: 40,
  /** Popover rời: ModelSelector, ChatExportMenu. */
  popover: 50,
  /** Thông báo nổi — phải trên dropdown nhưng dưới modal. */
  toast: 60,
  /** Modal PHÊ DUYỆT: chặn luồng agent, người dùng phải trả lời mới đi tiếp. */
  approval: 80,
  /**
   * Phê duyệt MCP — cao hơn `approval` vì hộp thoại này đến từ tiến trình main
   * của desktop bất kể UI đang ở đâu, và agent đang BỊ CHẶN chờ trả lời. Nếu
   * nằm ngang hàng, một DiffConfirm đang mở sẽ che nó và agent treo vô hạn.
   */
  approvalCritical: 85,
  /** Modal ĐIỀU HƯỚNG: panel quản trị mở bằng ý muốn người dùng. */
  navigation: 90,
  /** Hộp thoại HỆ THỐNG: Cài đặt, xác nhận xoá — luôn trên cùng. */
  system: 100,
} as const;

export type ZLayer = keyof typeof Z_INDEX;

/** Class Tailwind tương ứng — dùng trực tiếp trong className. */
export const Z_CLASS: Record<ZLayer, string> = {
  content: 'z-0',
  dropdown: 'z-40',
  popover: 'z-50',
  toast: 'z-[60]',
  approval: 'z-[80]',
  approvalCritical: 'z-[85]',
  navigation: 'z-[90]',
  system: 'z-[100]',
};

/**
 * Thứ tự tăng dần của các lớp, để test và code khác kiểm chứng quan hệ.
 * Bất biến: `approval < approvalCritical < navigation < system`.
 */
export const Z_ORDER: ZLayer[] = [
  'content',
  'dropdown',
  'popover',
  'toast',
  'approval',
  'approvalCritical',
  'navigation',
  'system',
];
