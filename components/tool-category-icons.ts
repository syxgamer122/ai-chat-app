import type { LucideIcon } from 'lucide-react';
import {
  Bookmark,
  FolderOpen,
  GitBranch,
  Globe,
  ListChecks,
  Pencil,
  Terminal,
  Users,
} from 'lucide-react';

/**
 * Tên icon trong TOOL_CATEGORY_LABELS ('folder-open'...) → component lucide.
 * Catalog (lib/tool-catalog.ts) giữ dữ liệu thuần nên không import lucide;
 * UI map tên → component tại đây. Trước đây settings-dialog và tools-panel
 * mỗi nơi giữ một bản map riêng, thêm nhóm mới là hai nơi phải sửa; giờ còn
 * một nguồn duy nhất. Tên lạ không có entry → caller bỏ qua việc vẽ icon.
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
};
