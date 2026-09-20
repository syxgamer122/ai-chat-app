'use client';

/**
 * Trạng thái đang tải cho các panel nạp động trong Cài đặt.
 *
 * Tách riêng vì cả 4 tab (Model, An toàn, Mở rộng, Dữ liệu) đều dùng nó làm
 * `loading` cho `next/dynamic` — để trong một tab thì ba tab kia phải import chéo.
 */
export function SectionLoading() {
  return (
    <div className="flex items-center gap-2 py-6 font-mono text-xs text-text-muted" role="status">
      <span className="terminal-cursor" aria-hidden="true" />
      <span>Đang tải mục cài đặt…</span>
    </div>
  );
}
