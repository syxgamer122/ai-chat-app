import type { LucideIcon } from 'lucide-react';
import {
  Bookmark,
  FolderOpen,
  GitBranch,
  Globe,
  ListChecks,
  Pencil,
  Server,
  Terminal,
  Users,
} from 'lucide-react';

/**
 * Tên icon trong TOOL_CATEGORY_LABELS ('folder-open'...) → component lucide.
 * Catalog (lib/tool-catalog.ts) giữ dữ liệu thuần nên không import lucide;
 * UI map tên → component tại đây.
 *
 * Đây là NGUỒN DUY NHẤT. Trước đây `tools-panel` và `settings-dialog` mỗi nơi
 * giữ một bản riêng; khi `settings-dialog` được tách file, hoá ra bản của nó đã
 * chết từ lâu còn `tool-permissions-table` lại tự dựng `GROUP_ICONS` thứ ba —
 * đúng kiểu lệch mà bản đồ dùng chung sinh ra để chặn. Nay cả hai tra qua đây.
 *
 * `server` phục vụ nhóm quyền `mcp` — nhóm này chỉ tồn tại ở tầng phân quyền
 * (`ToolPermissionGroup`), không có trong `ToolCategory` của catalog.
 */
export const TOOL_CATEGORY_ICON_COMPONENTS: Record<string, LucideIcon> = {
  'folder-open': FolderOpen,
  pencil: Pencil,
  terminal: Terminal,
  'git-branch': GitBranch,
  globe: Globe,
  bookmark: Bookmark,
  'list-checks': ListChecks,
  users: Users,
  server: Server,
};
