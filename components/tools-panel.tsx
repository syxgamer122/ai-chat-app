'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { TOOL_CATEGORY_ICON_COMPONENTS } from '@/components/tool-category-icons';
import {
  ALL_TOOL_CATEGORIES,
  TOOL_CATALOG,
  TOOL_CATEGORY_LABELS,
  toolsByCategory,
  type ToolCatalogEntry,
  type ToolCategory,
} from '@/lib/tool-catalog';
import {
  PERMISSION_OPTIONS,
  useAppStore,
  type PermissionOverride,
  type ToolPermissions,
} from '@/lib/store';

/* Pure helpers: export để test thuần (repo không có hạ tầng DOM). */

export interface ToolPanelSection {
  category: ToolCategory;
  label: string;
  icon: string;
  tools: readonly ToolCatalogEntry[];
}

/**
 * 8 section theo đúng thứ tự ALL_TOOL_CATEGORIES; tool trong nhóm giữ thứ tự
 * TOOL_CATALOG. Catalog là dữ liệu tĩnh nên kết quả xác định qua mọi lần gọi.
 */
export function buildPanelSections(): ToolPanelSection[] {
  const byCategory = toolsByCategory();
  return ALL_TOOL_CATEGORIES.map((category) => ({
    category,
    label: TOOL_CATEGORY_LABELS[category].label,
    icon: TOOL_CATEGORY_LABELS[category].icon,
    tools: byCategory[category],
  }));
}

/**
 * Lọc tool theo tên / mô tả / shortLabel, không phân biệt hoa thường.
 * Query rỗng (hoặc chỉ khoảng trắng) trả nguyên danh sách; query có từ khoá
 * thì nhóm rỗng bị bỏ để section không hiện header chết.
 */
export function filterPanelSections(
  sections: ToolPanelSection[],
  query: string,
): ToolPanelSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  return sections
    .map((section) => ({
      ...section,
      tools: section.tools.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.shortLabel.toLowerCase().includes(q),
      ),
    }))
    .filter((section) => section.tools.length > 0);
}

const PERMISSION_VALUES: readonly PermissionOverride[] = ['default', 'auto', 'ask', 'deny'];

/**
 * Đổi quyền MỘT category, bất biến: trả bản sao mới, giữ nguyên 7 nhóm còn lại
 * và không sửa object đầu vào. Value lạ ném lỗi để bug UI nổ ngay ở dev.
 */
export function updateToolPermission(
  permissions: ToolPermissions,
  category: ToolCategory,
  value: PermissionOverride,
): ToolPermissions {
  if (!PERMISSION_VALUES.includes(value)) {
    throw new Error(`Giá trị quyền không hợp lệ: ${value}`);
  }
  return { ...permissions, [category]: value };
}

/* UI */

/**
 * Panel "Công cụ & quyền": toàn bộ catalog tool của agent nhóm theo 8 category,
 * kèm quyền auto-pilot theo nhóm. Đây là bản GUI của `vyen tool list` / /tools:
 * người dùng xem được AI có tool gì, tool nào chạy ở đâu, và chặn/đặt quyền.
 */
export function ToolsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toolPermissions = useAppStore((s) => s.settings.toolPermissions);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [query, setQuery] = useState('');

  const sections = useMemo(() => filterPanelSections(buildPanelSections(), query), [query]);
  const shown = sections.reduce((acc, s) => acc + s.tools.length, 0);

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Mở: focus nút đóng để Enter/Escape thao tác ngay; đóng: trả focus về
    // phần tử đã mở panel (nút Tác vụ trong composer). Cùng chuẩn StagingPanel.
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeBtnRef.current?.focus();
    return () => {
      restoreFocusRef.current?.focus();
    };
  }, [open]);

  // Escape nghe ở document (không phải onKeyDown trên container): focus có thể
  // rơi vào vùng không focusable. Không nghe khi đóng để không cướp Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Công cụ & quyền"
      className="fixed inset-0 z-[100] flex justify-end bg-black/60"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-[min(30rem,100vw)] flex-col overflow-hidden rounded-none border border-[#495059] bg-[#212730] font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 border-b border-[#495059] bg-[#161d27] px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[15px] font-semibold text-[#ebe7e4]">
              <span className="font-bold text-[#6a9fcc]">$</span>
              <span className="text-[#6a9fcc]">tools</span>
              <span>
                · {TOOL_CATALOG.length} tool · {ALL_TOOL_CATEGORIES.length} nhóm
              </span>
            </div>
            <div className="text-[11px] text-[#9fa4ab]">
              Toàn bộ tool AI đang có, nhóm theo loại, kèm quyền chạy.
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Đóng panel công cụ"
            className="icon-btn icon-btn-md relative rounded-none after:absolute after:-inset-[6px] after:content-[''] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#6a9fcc]"
          >
            <X size={14} />
          </button>
        </div>

        <div className="border-b border-[#495059] px-3 py-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Lọc theo tên, mô tả hoặc nhãn..."
            aria-label="Tìm tool"
            className="field-sm"
          />
          {query.trim() && (
            <div role="status" className="mt-1 px-1 text-[10.5px] text-[#9fa4ab]">
              {shown} / {TOOL_CATALOG.length} tool
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {sections.map((section) => {
            const Icon = TOOL_CATEGORY_ICON_COMPONENTS[section.icon];
            return (
              <section
                key={section.category}
                aria-label={section.label}
                className="border-b border-[#495059] last:border-b-0"
              >
                <div className="flex items-center gap-2 bg-[#161d27] px-3 py-2">
                  {Icon && <Icon size={13} className="flex-none text-[#6a9fcc]" aria-hidden="true" />}
                  <span className="flex-none text-[12px] font-semibold text-[#ebe7e4]">
                    {section.label}
                  </span>
                  <span className="flex-none text-[11px] text-[#9fa4ab]">
                    {section.tools.length} tool
                  </span>
                  <span className="min-w-1 flex-1" />
                  <label
                    htmlFor={`tools-panel-perm-${section.category}`}
                    className="sr-only"
                  >
                    Quyền nhóm {section.label}
                  </label>
                  <select
                    id={`tools-panel-perm-${section.category}`}
                    value={toolPermissions[section.category] ?? 'default'}
                    onChange={(e) => {
                      updateSettings({
                        toolPermissions: updateToolPermission(
                          toolPermissions,
                          section.category,
                          e.target.value as PermissionOverride,
                        ),
                      });
                    }}
                    className="field-sm min-h-[38px] w-[7.5rem] flex-none text-[11px]"
                  >
                    {PERMISSION_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <ul>
                  {section.tools.map((tool) => (
                    <li key={tool.name} className="border-t border-[#495059] px-3 py-2">
                      <div className="flex items-baseline gap-2">
                        <span className="flex-none text-[12px] text-[#ebe7e4]">{tool.name}</span>
                        <span className="min-w-0 flex-1 truncate text-[11px] text-[#9fa4ab]">
                          {tool.shortLabel}
                        </span>
                        {tool.desktopOnly && (
                          <span
                            title="Chỉ chạy ở bản desktop, cần desktop bridge đang kết nối"
                            className="flex-none text-[10.5px] text-[#9fa4ab]"
                          >
                            chỉ bản desktop
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-[#9fa4ab]">
                        {tool.description}
                      </p>
                      <p className="text-[10.5px] text-[#9fa4ab]">
                        {tool.kind === 'client' ? 'chạy trên máy người dùng' : 'chạy trên backend'}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {sections.length === 0 && (
            <div role="status" className="px-3 py-8 text-center text-[11.5px] text-[#9fa4ab]">
              Không có tool khớp &quot;{query.trim()}&quot;.
            </div>
          )}
        </div>

        <div className="border-t border-[#495059] bg-[#161d27] px-4 py-2.5">
          <p className="text-[10.5px] leading-relaxed text-[#9fa4ab]">
            Chặn: tool trong nhóm trả lỗi ngay và không chạy (áp dụng cho tool chạy trên máy bạn;
            tool backend như tìm web vẫn chạy). Quyền nhóm đè chính sách duyệt chung của
            Auto-pilot; lệnh nguy hiểm (rm -rf /, mkfs) luôn phải hỏi.
          </p>
        </div>
      </aside>
    </div>
  );
}
