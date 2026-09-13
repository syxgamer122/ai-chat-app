'use client';

/**
 * Bảng phân quyền chi tiết từng công cụ (P1-6 Port Goose).
 *
 * Tính năng:
 * - Bảng phân quyền chi tiết per-tool: auto | ask | deny (hoặc default)
 * - Nhóm công cụ: fs / shell / git / mcp / web / plan / delegate / memory
 * - Tìm kiếm tool theo tên / mô tả
 * - Lọc theo nhóm
 * - Nút Reset: đặt lại toàn bộ quyền về mặc định
 * - Lưu đồng bộ: Zustand persist + Dexie v14 (toolPermissions)
 */

import { useId, useMemo, useState } from 'react';
import {
  RotateCcw,
  Search,
  FolderOpen,
  Terminal,
  GitBranch,
  Server,
  Globe,
  ListChecks,
  Users,
  Bookmark,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react';
import { useAppStore, PERMISSION_OPTIONS, type PermissionOverride } from '@/lib/store';
import {
  getAllToolRows,
  TOOL_PERMISSION_GROUPS,
  type ToolPermissionGroup,
  type ToolRowItem,
  saveToolPermissionToDb,
  resetToolPermissionsInDb,
} from '@/lib/tool-permissions';

const GROUP_ICONS: Record<ToolPermissionGroup, React.ComponentType<{ className?: string; size?: number }>> = {
  fs: FolderOpen,
  shell: Terminal,
  git: GitBranch,
  mcp: Server,
  web: Globe,
  plan: ListChecks,
  delegate: Users,
  memory: Bookmark,
};

export function ToolPermissionsTable() {
  const searchInputId = useId();
  const groupFilterId = useId();
  const toolPermissions = useAppStore((s) => s.settings.toolPermissions ?? {});
  const updateSettings = useAppStore((s) => s.updateSettings);

  const [search, setSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<ToolPermissionGroup | 'all'>('all');
  const [resetConfirm, setResetConfirm] = useState(false);

  // Danh sách toàn bộ tool
  const allRows = useMemo(() => getAllToolRows(), []);

  // Lọc theo search và nhóm
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return allRows.filter((row) => {
      const matchGroup = selectedGroup === 'all' || row.group === selectedGroup;
      if (!matchGroup) return false;
      if (!query) return true;
      return (
        row.name.toLowerCase().includes(query) ||
        row.shortLabel.toLowerCase().includes(query) ||
        row.description.toLowerCase().includes(query) ||
        row.group.toLowerCase().includes(query)
      );
    });
  }, [allRows, search, selectedGroup]);

  // Xử lý thay đổi quyền cho một tool
  const handlePermissionChange = (toolName: string, val: PermissionOverride) => {
    const updated = { ...toolPermissions, [toolName]: val };
    updateSettings({ toolPermissions: updated });
    void saveToolPermissionToDb(toolName, val);
  };

  // Đặt lại toàn bộ về mặc định
  const handleReset = async () => {
    // Giữ lại 8 category mặc định nhưng clear các per-tool overrides
    const defaultCategories: Record<string, PermissionOverride> = {
      fs_read: 'default',
      fs_write: 'default',
      shell: 'default',
      git: 'default',
      web: 'default',
      memory: 'default',
      plan: 'default',
      delegate: 'default',
    };
    updateSettings({ toolPermissions: defaultCategories });
    await resetToolPermissionsInDb();
    setResetConfirm(false);
  };

  const getPermissionBadge = (perm: PermissionOverride) => {
    switch (perm) {
      case 'auto':
        return (
          <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
            <ShieldCheck size={11} /> Tự duyệt
          </span>
        );
      case 'ask':
        return (
          <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
            <ShieldQuestion size={11} /> Luôn hỏi
          </span>
        );
      case 'deny':
        return (
          <span className="inline-flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-400">
            <ShieldAlert size={11} /> Chặn
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            <Shield size={11} /> Mặc định
          </span>
        );
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      {/* Header controls: Search, Group Filter, Reset */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          {/* Ô tìm kiếm */}
          <div className="relative min-w-[160px] flex-1 max-w-xs">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400"
            />
            <input
              id={searchInputId}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Tìm kiếm tool theo tên, mô tả..."
              className="field-sm w-full pl-8 text-xs"
            />
          </div>

          {/* Lọc theo nhóm */}
          <select
            id={groupFilterId}
            aria-label="Lọc nhóm công cụ"
            value={selectedGroup}
            onChange={(e) => setSelectedGroup(e.target.value as ToolPermissionGroup | 'all')}
            className="field-sm text-xs"
          >
            <option value="all">Tất cả nhóm ({allRows.length} tool)</option>
            {TOOL_PERMISSION_GROUPS.map((g) => {
              const count = allRows.filter((r) => r.group === g.key).length;
              return (
                <option key={g.key} value={g.key}>
                  {g.label} ({count})
                </option>
              );
            })}
          </select>
        </div>

        {/* Nút reset */}
        <div className="flex items-center gap-1">
          {resetConfirm ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-amber-600 dark:text-amber-400">Xác nhận reset?</span>
              <button
                type="button"
                onClick={() => void handleReset()}
                className="rounded bg-red-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-700"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => setResetConfirm(false)}
                className="rounded border border-zinc-300 px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Hủy
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setResetConfirm(true)}
              className="inline-flex items-center gap-1 rounded border border-zinc-200 px-2.5 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              title="Đặt lại toàn bộ quyền về mặc định"
            >
              <RotateCcw size={12} /> Đặt lại mặc định
            </button>
          )}
        </div>
      </div>

      {/* Bảng phân quyền */}
      <div className="max-h-[380px] overflow-y-auto rounded border border-zinc-200 text-xs dark:border-zinc-800">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-zinc-50 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            <tr className="border-b border-zinc-200 dark:border-zinc-700">
              <th className="px-3 py-2">Công cụ</th>
              <th className="px-3 py-2">Nhóm</th>
              <th className="px-3 py-2">Mô tả</th>
              <th className="px-3 py-2 text-right">Quyền</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {filteredRows.map((row) => {
              const currentVal = toolPermissions[row.name] ?? 'default';
              const Icon = GROUP_ICONS[row.group] ?? FolderOpen;
              const selectId = `perm-select-${row.name}`;

              return (
                <tr
                  key={row.name}
                  className="hover:bg-zinc-50/70 transition-colors dark:hover:bg-zinc-800/40"
                >
                  <td className="px-3 py-2 font-mono text-[11.5px]">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                        {row.name}
                      </span>
                      {row.desktopOnly && (
                        <span
                          className="rounded bg-zinc-100 px-1 py-0.2 text-[9.5px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                          title="Chỉ khả dụng trên bản Desktop"
                        >
                          desktop
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-zinc-400">{row.shortLabel}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                      <Icon size={12} className="text-zinc-500" />
                      {row.group}
                    </span>
                  </td>
                  <td className="max-w-[280px] px-3 py-2 text-[11px] text-zinc-500 leading-snug dark:text-zinc-400">
                    {row.description}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-2">
                      {getPermissionBadge(currentVal)}
                      <label htmlFor={selectId} className="sr-only">
                        Quyền cho tool {row.name}
                      </label>
                      <select
                        id={selectId}
                        value={currentVal}
                        onChange={(e) =>
                          handlePermissionChange(row.name, e.target.value as PermissionOverride)
                        }
                        className="field-sm h-7 text-[11px]"
                      >
                        {PERMISSION_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-zinc-400">
                  Không tìm thấy tool nào khớp với bộ lọc.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span>Hiển thị {filteredRows.length} / {allRows.length} công cụ</span>
        <span>Mọi thay đổi được lưu tự động (Zustand + Dexie v14)</span>
      </div>
    </div>
  );
}
