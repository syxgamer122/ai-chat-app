/**
 * Catalog trung tâm của toàn bộ tool model nhìn thấy (server + client).
 *
 * Trước đây danh mục tool bị viết tay rải rác ở nhiều nơi: ALL_TOOL_PROTOCOL_NAMES
 * và TOOL_SHORT_LABELS trong agent-tools.ts, taxonomy category trong store.ts.
 * Chúng đã drift thật: bản protocol thiếu delegate + bg_*, map category không
 * phủ bg_* nên lệnh nền không bao giờ bị chính sách quyền quản, short label
 * không có cho bg_*. File này là nguồn sự thật duy nhất; các nơi kia DERIVE
 * từ đây (agent-tools.ts, store.ts re-export để importer cũ không đổi).
 *
 * File không import gì (đặc biệt là không import store.ts) để tránh vòng
 * import: store.ts → tool-catalog.ts là hướng duy nhất được phép.
 */

export type ToolCategory =
  | 'fs_read'
  | 'fs_write'
  | 'shell'
  | 'git'
  | 'web'
  | 'memory'
  | 'plan'
  | 'delegate';

/**
 * 8 category của toolPermissions persist trong localStorage (key
 * 'ai-chat-settings' v2). KHÔNG được đổi tên/thêm/bớt: validateToolPermissions
 * ở store.ts dọn khoá lạ, đổi key là mất cài đặt quyền của người dùng.
 */
export const ALL_TOOL_CATEGORIES: readonly ToolCategory[] = [
  'fs_read', 'fs_write', 'shell', 'git', 'web', 'memory', 'plan', 'delegate',
];

/**
 * Tool name → category, nguồn cho per-tool permission override (auto-pilot)
 * và UI Cài đặt. Phải phủ MỘT-MỘT mọi tên trong TOOL_CATALOG (test chặn),
 * nếu không tool lọt lưới sẽ không bao giờ bị chính sách quyền quản.
 */
export const TOOL_CATEGORY_MAP: Record<string, ToolCategory> = {
  fs_read: 'fs_read',
  fs_list: 'fs_read',
  fs_search: 'fs_read',
  skill_load: 'fs_read',
  fs_edit: 'fs_write',
  fs_write: 'fs_write',
  shell_run: 'shell',
  bg_run: 'shell',
  bg_status: 'shell',
  bg_stop: 'shell',
  git_status: 'git',
  git_diff: 'git',
  git_log: 'git',
  git_add: 'git',
  git_commit: 'git',
  web_search: 'web',
  web_fetch: 'web',
  weather: 'web',
  exchange_rates: 'web',
  memory_search: 'memory',
  memory_save: 'memory',
  lesson_save: 'memory',
  remember_memory: 'memory',
  retrieve_memories: 'memory',
  remove_memory_category: 'memory',
  remove_specific_memory: 'memory',
  plan_create: 'plan',
  plan_update: 'plan',
  delegate: 'delegate',
};

/**
 * Tool có thuộc nhóm hoặc tên đang bị đặt quyền 'deny' (Chặn) không. Nguồn cho
 * cổng chặn trong chat-interface: tool gọi tới trả lỗi ngay ("denied by policy"),
 * không chạy và không hiện modal duyệt. Tham số nhận Record<string, string>
 * thay vì ToolPermissions để file này giữ nguyên tính thuần (không import store).
 */
export function isToolDenied(
  toolName: string,
  permissions: Record<string, string>,
): boolean {
  // 1. Per-tool specific permission
  const specific = permissions[toolName];
  if (specific === 'deny') return true;
  if (specific === 'auto' || specific === 'ask') return false;

  // 2. Category fallback
  const category = TOOL_CATEGORY_MAP[toolName];
  if (category !== undefined && permissions[category] === 'deny') return true;

  // 3. MCP tools prefix & meta-tools fallback
  if ((toolName.startsWith('mcp__') || toolName === 'tools_search' || toolName === 'tools_load') && permissions['mcp'] === 'deny') return true;

  // 4. Code Mode fallback
  if (toolName === 'run_code' && (permissions['shell'] === 'deny' || permissions['fs_write'] === 'deny')) return true;

  return false;
}

function toolsOfCategory(category: ToolCategory): string {
  return Object.entries(TOOL_CATEGORY_MAP)
    .filter(([, cat]) => cat === category)
    .map(([name]) => name)
    .join(', ');
}

/**
 * Nhãn tiếng Việt + tên icon lucide cho UI (ToolsPanel, Cài đặt, CLI listing).
 * `icon` là TÊN icon dạng chuỗi ('folder-open') chứ không phải glyph: file này
 * không import gì, UI tự map tên → component lucide. Tên icon phải khớp key
 * trong map của tools-panel.tsx và settings-dialog.tsx.
 * Chuỗi `tools` SINH TỪ TOOL_CATEGORY_MAP theo thứ tự khai báo để thêm tool
 * vào map là nhãn tự cập nhật, không kịp drift.
 */
export const TOOL_CATEGORY_LABELS: Record<ToolCategory, { label: string; icon: string; tools: string }> = {
  fs_read: { label: 'Đọc file', icon: 'folder-open', tools: toolsOfCategory('fs_read') },
  fs_write: { label: 'Sửa & ghi file', icon: 'pencil', tools: toolsOfCategory('fs_write') },
  shell: { label: 'Shell & tiến trình nền', icon: 'terminal', tools: toolsOfCategory('shell') },
  git: { label: 'Git', icon: 'git-branch', tools: toolsOfCategory('git') },
  web: { label: 'Web', icon: 'globe', tools: toolsOfCategory('web') },
  memory: { label: 'Ghi nhớ & bài học', icon: 'bookmark', tools: toolsOfCategory('memory') },
  plan: { label: 'Kế hoạch', icon: 'list-checks', tools: toolsOfCategory('plan') },
  delegate: { label: 'Subagent', icon: 'users', tools: toolsOfCategory('delegate') },
};

export interface ToolCatalogEntry {
  name: string;
  kind: 'server' | 'client';
  category: ToolCategory;
  shortLabel: string;
  description: string;
  /** Tên cũ/biến thể tool có thể xuất hiện trong trace (khớp TOOL_META của tool-trace). */
  aliases: readonly string[];
  /** true = chỉ chạy khi có desktop bridge (chat-interface chặn khi thiếu window.vyen). */
  desktopOnly: boolean;
}

/**
 * Thứ tự xác định: nhóm theo category theo đúng thứ tự ALL_TOOL_CATEGORIES,
 * trong nhóm xếp theo tên tăng dần. Test khóa quy tắc này: ai thêm tool mà
 * sai chỗ là đỏ ngay.
 */
export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  // fs_read
  {
    name: 'fs_list',
    kind: 'client',
    category: 'fs_read',
    shortLabel: 'liệt kê thư mục',
    description: 'Liệt kê một cấp thư mục trong workspace của người dùng, thư mục con đứng trước file.',
    aliases: ['fs_listDir', 'list_dir'],
    desktopOnly: false,
  },
  {
    name: 'fs_read',
    kind: 'client',
    category: 'fs_read',
    shortLabel: 'đọc file',
    description: 'Đọc file text theo dòng, tối đa 24.000 ký tự từ start_line; file ảnh trả về bản mô tả.',
    aliases: ['read', 'fs_readFile', 'read_file'],
    desktopOnly: false,
  },
  {
    name: 'fs_search',
    kind: 'client',
    category: 'fs_read',
    shortLabel: 'tìm trong workspace',
    description: 'Tìm chuỗi hoặc regex trong workspace, tối đa 30 dòng khớp, bỏ qua dòng dài quá 5000 ký tự.',
    aliases: [],
    desktopOnly: false,
  },
  {
    name: 'skill_load',
    kind: 'client',
    category: 'fs_read',
    shortLabel: 'nạp skill SKILL.md',
    description: 'Nạp nội dung đầy đủ một kỹ năng SKILL.md theo chỉ mục [SKILLS].',
    aliases: [],
    desktopOnly: false,
  },
  // fs_write
  {
    name: 'fs_edit',
    kind: 'client',
    category: 'fs_write',
    shortLabel: 'sửa file (ưu tiên)',
    description: 'Sửa cục bộ file đã đọc bằng khối SEARCH/REPLACE, người dùng duyệt diff trước khi ghi.',
    aliases: ['edit', 'fs_editFile', 'replace_file_content'],
    desktopOnly: false,
  },
  {
    name: 'fs_write',
    kind: 'client',
    category: 'fs_write',
    shortLabel: 'ghi cả file',
    description: 'Ghi toàn bộ nội dung file; chặn ghi đè file hơn 200 dòng, người dùng duyệt diff trước.',
    aliases: ['write', 'fs_writeFile', 'write_to_file'],
    desktopOnly: false,
  },
  // shell
  {
    name: 'bg_run',
    kind: 'client',
    category: 'shell',
    shortLabel: 'chạy nền',
    description: 'Chạy lệnh nền detached tại workspace root, trả jobId ngay, tối đa 5 lệnh cùng lúc.',
    aliases: [],
    desktopOnly: true,
  },
  {
    name: 'bg_status',
    kind: 'client',
    category: 'shell',
    shortLabel: 'trạng thái nền',
    description: 'Xem trạng thái và đuôi output của lệnh nền theo job_id, hoặc liệt kê job gần nhất.',
    aliases: [],
    desktopOnly: true,
  },
  {
    name: 'bg_stop',
    kind: 'client',
    category: 'shell',
    shortLabel: 'dừng nền',
    description: 'Dừng một lệnh nền đang chạy theo job_id, diệt cả cây process.',
    aliases: [],
    desktopOnly: true,
  },
  {
    name: 'shell_run',
    kind: 'client',
    category: 'shell',
    shortLabel: 'chạy shell',
    description: 'Chạy lệnh shell trong workspace, timeout mặc định 120s, output vượt 2000 dòng hoặc 50KB bị cắt.',
    aliases: ['bash', 'run_command', 'shell'],
    desktopOnly: true,
  },
  // git
  {
    name: 'git_add',
    kind: 'client',
    category: 'git',
    shortLabel: 'git add',
    description: 'Stage tối đa 20 đường dẫn vào git index, không cần phê duyệt riêng.',
    aliases: [],
    desktopOnly: true,
  },
  {
    name: 'git_commit',
    kind: 'client',
    category: 'git',
    shortLabel: 'git commit',
    description: 'Tạo commit git với message do model soạn, người dùng phê duyệt trước khi commit.',
    aliases: [],
    desktopOnly: true,
  },
  {
    name: 'git_diff',
    kind: 'client',
    category: 'git',
    shortLabel: 'git diff',
    description: 'Xem diff git của workspace, mặc định unstaged; staged=true để xem diff đã stage.',
    aliases: [],
    desktopOnly: true,
  },
  {
    name: 'git_log',
    kind: 'client',
    category: 'git',
    shortLabel: 'git log',
    description: 'Xem lịch sử commit git dạng rút gọn, mặc định 30 commit mới nhất.',
    aliases: [],
    desktopOnly: true,
  },
  {
    name: 'git_status',
    kind: 'client',
    category: 'git',
    shortLabel: 'git status',
    description: 'Xem branch và danh sách file staged/unstaged của workspace git.',
    aliases: [],
    desktopOnly: true,
  },
  // web
  {
    name: 'exchange_rates',
    kind: 'server',
    category: 'web',
    shortLabel: 'tỷ giá',
    description: 'Tra bảng tỷ giá hôm nay quy về gốc USD, không nhận tham số.',
    aliases: [],
    desktopOnly: false,
  },
  {
    name: 'weather',
    kind: 'server',
    category: 'web',
    shortLabel: 'thời tiết',
    description: 'Tra thời tiết hiện tại và dự báo 2 ngày theo tên địa điểm.',
    aliases: [],
    desktopOnly: false,
  },
  {
    name: 'web_fetch',
    kind: 'server',
    category: 'web',
    shortLabel: 'đọc URL',
    description: 'Đọc nội dung text một URL public; chỉ host có trong kết quả search hoặc do user gửi.',
    aliases: ['read_url_content'],
    desktopOnly: false,
  },
  {
    name: 'web_search',
    kind: 'server',
    category: 'web',
    shortLabel: 'tìm web',
    description: 'Tìm kiếm web công khai, trả danh sách kết quả có title, url và snippet.',
    aliases: ['search_web'],
    desktopOnly: false,
  },
  // memory
  {
    name: 'lesson_save',
    kind: 'client',
    category: 'memory',
    shortLabel: 'lưu bài học',
    description: 'Lưu bài học coding dạng rule, pattern hoặc gotcha, tối đa 400 ký tự, dùng cho các phiên sau.',
    aliases: [],
    desktopOnly: false,
  },
  {
    name: 'memory_save',
    kind: 'server',
    category: 'memory',
    shortLabel: 'lưu ghi nhớ',
    description: 'Đề xuất lưu một câu ghi nhớ dài hạn về người dùng; client ghi thật vào IndexedDB.',
    aliases: [],
    desktopOnly: false,
  },
  {
    name: 'memory_search',
    kind: 'server',
    category: 'memory',
    shortLabel: 'tra ghi nhớ',
    description: 'Tra ghi nhớ dài hạn của người dùng; chỉ có mặt khi đã tồn tại dữ liệu ghi nhớ.',
    aliases: [],
    desktopOnly: false,
  },
  {
    name: 'remember_memory',
    kind: 'client',
    category: 'memory',
    shortLabel: 'ghi bộ nhớ cấu trúc',
    description: 'Ghi fact vào bộ nhớ cấu trúc (category, tags, local/global), tối đa 2.000 ký tự.',
    aliases: [],
    desktopOnly: false,
  },
  {
    name: 'remove_memory_category',
    kind: 'client',
    category: 'memory',
    shortLabel: 'xoá cả category',
    description: 'Xoá toàn bộ memory của một category khi người dùng yêu cầu rõ ràng (Goose port).',
    aliases: [],
    desktopOnly: false,
  },
  {
    name: 'remove_specific_memory',
    kind: 'client',
    category: 'memory',
    shortLabel: 'xoá một memory',
    description: 'Xoá đúng một entry memory theo id (Goose port).',
    aliases: [],
    desktopOnly: false,
  },
  {
    name: 'retrieve_memories',
    kind: 'client',
    category: 'memory',
    shortLabel: 'tra bộ nhớ cấu trúc',
    description: 'Tra nội dung bộ nhớ có cấu trúc theo từ khoá/category/tags, trả tối đa 8 entry (Goose port).',
    aliases: [],
    desktopOnly: false,
  },
  // plan
  {
    name: 'plan_create',
    kind: 'client',
    category: 'plan',
    shortLabel: 'tạo plan',
    description: 'Tạo plan chia task lớn thành tối đa 20 subtask có tiêu đề và file liên quan.',
    aliases: [],
    desktopOnly: false,
  },
  {
    name: 'plan_update',
    kind: 'client',
    category: 'plan',
    shortLabel: 'cập nhật plan',
    description: 'Cập nhật trạng thái một subtask: in_progress, done, failed hoặc skipped.',
    aliases: [],
    desktopOnly: false,
  },
  // delegate
  {
    name: 'delegate',
    kind: 'client',
    category: 'delegate',
    shortLabel: 'giao subagent',
    description: 'Giao task cho subagent context riêng, tối đa 4 task song song, không đệ quy delegate.',
    aliases: [],
    desktopOnly: false,
  },
];

const TOOL_INDEX: ReadonlyMap<string, ToolCatalogEntry> = new Map(
  TOOL_CATALOG.map((t) => [t.name, t]),
);

export function getToolEntry(name: string): ToolCatalogEntry | undefined {
  return TOOL_INDEX.get(name);
}

/**
 * Tra entry theo tên chính HOẶC alias. Trace (TOOL_META của tool-trace) có thể
 * hiện tên di sản như read/bash/read_file, panel công cụ cần mô tả cho cả các
 * tên đó. Tên lạ trả undefined (khác toolShortLabel cố tình trả nguyên tên). */
export function resolveToolEntry(name: string): ToolCatalogEntry | undefined {
  return TOOL_INDEX.get(name) ?? TOOL_CATALOG.find((t) => t.aliases.includes(name));
}

/** Nhãn ngắn để hiển thị; tên lạ trả nguyên tên thay vì undefined cho UI an toàn. */
export function toolShortLabel(name: string): string {
  return TOOL_INDEX.get(name)?.shortLabel ?? name;
}

/** Gom catalog theo category; đủ cả 8 khoá (category rỗng vẫn có mảng rỗng). */
export function toolsByCategory(): Record<ToolCategory, readonly ToolCatalogEntry[]> {
  const out = {} as Record<ToolCategory, readonly ToolCatalogEntry[]>;
  for (const cat of ALL_TOOL_CATEGORIES) out[cat] = [];
  for (const entry of TOOL_CATALOG) {
    (out[entry.category] as ToolCatalogEntry[]).push(entry);
  }
  return out;
}
