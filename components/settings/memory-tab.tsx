'use client';

/**
 * Settings → tab "Bộ nhớ"
 *
 * Tab này gom HAI hệ bộ nhớ khác vai trò. Trước đây phần mô tả chỉ nói
 * "luồng quản lý ký ức thống nhất: ... → ... → ...", người dùng vẫn không biết
 * vì sao có hai mục và chúng khác nhau chỗ nào.
 *
 * Sự thật kỹ thuật: hai hệ KHÁC NHAU Ở AI TẠO RA KÝ ỨC, không phải hai cách
 * nhìn cùng một dữ liệu —
 *   - Reviewer gate: AGENT đề xuất candidate, người dùng duyệt (Nhớ / Từ chối /
 *     Hoãn). Chưa duyệt thì không bao giờ vào ngữ cảnh.
 *   - Sổ có cấu trúc: CHÍNH NGƯỜI DÙNG viết, tổ chức theo category/tag/scope,
 *     xuất ra JSON được. Không qua bước duyệt vì không phải agent đề xuất.
 * Gộp hai bảng dữ liệu làm một là sai — chúng khác vòng đời và khác nguồn ghi.
 * Nên phần mô tả dưới đây nói rõ khác biệt đó thay vì gọi chung là "thống nhất".
 *
 * (Tách ra từ components/settings-dialog.tsx.)
 */

import { MemoriesSection } from '@/components/settings/memories-section';
import { AgentMemorySection } from '@/components/settings-agent-memory';

export function MemoryTab() {
  return (
    <>
      <div className="border-b border-border-hairline pb-2">
        <h3 className="text-sm font-semibold text-text-primary">Bộ nhớ</h3>
        <p className="mt-0.5 text-[11px] text-text-muted">
          Hai đường vào bộ nhớ dài hạn — khác nhau ở <strong className="font-semibold text-text-primary">ai tạo ra ký ức</strong>:
        </p>
        <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-text-muted">
          <li className="flex gap-1.5">
            <span aria-hidden="true" className="text-accent-steel">▸</span>
            <span>
              <strong className="font-semibold text-text-primary">Agent đề xuất, bạn duyệt</strong> — không
              ghi nhớ im lặng. Mục chưa duyệt không bao giờ được nạp vào ngữ cảnh.
            </span>
          </li>
          <li className="flex gap-1.5">
            <span aria-hidden="true" className="text-accent-steel">▸</span>
            <span>
              <strong className="font-semibold text-text-primary">Bạn tự viết sổ có cấu trúc</strong> — tổ
              chức theo category / tag / scope, xuất ra JSON được.
            </span>
          </li>
        </ul>
        <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">
          Cả hai đều được nạp vào ngữ cảnh khi liên quan tới lượt đang chạy.
        </p>
      </div>

      <MemoriesSection />

      <div className="settings-card settings-card-body">
        <AgentMemorySection />
      </div>
    </>
  );
}
