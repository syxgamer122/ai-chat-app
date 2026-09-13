/**
 * Hệ thống Slash Commands chuẩn hoá cho Vyen (Goose P2-10).
 *
 * Cung cấp danh mục các lệnh slash chuẩn hỗ trợ cả Web UI và CLI:
 * - /plan <mục tiêu>               — Lập kế hoạch bằng planner model
 * - /mode <auto|smart|approve|chat> — Chuyển đổi chế độ phê duyệt công cụ
 * - /summarize                     — Nén bộ nhớ ngữ cảnh hội thoại ngay lập tức
 * - /recipe <tên>                  — Kích hoạt chạy recipe theo tên
 * - /skills                        — Quản lý và tra cứu các kỹ năng (Skills)
 * - /memory                        — Tra cứu và quản lý bộ nhớ dài hạn
 * - /tools [query]                 — Tra cứu catalog công cụ hệ thống
 * - /cost                          — Thống kê token và chi phí ước tính
 * - Custom slash commands          — Cho phép ánh xạ /<tên> -> recipeId
 */

export interface SlashCommandDef {
  name: string;
  syntax: string;
  description: string;
  aliases?: string[];
  category: 'agent' | 'session' | 'system';
}

export const BUILTIN_SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: 'plan',
    syntax: '/plan <mục tiêu>',
    description: 'Lập kế hoạch khảo sát bằng planner model ở chế độ chỉ-đọc',
    category: 'agent',
  },
  {
    name: 'mode',
    syntax: '/mode <auto|smart|approve|chat>',
    description: 'Chuyển chế độ phê duyệt công cụ (auto, smart, approve, chat)',
    aliases: ['policy'],
    category: 'agent',
  },
  {
    name: 'summarize',
    syntax: '/summarize',
    description: 'Nén gọn ngữ cảnh hội thoại ngay lập tức (compaction)',
    aliases: ['compact'],
    category: 'session',
  },
  {
    name: 'recipe',
    syntax: '/recipe <tên>',
    description: 'Mở hoặc chạy một workflow recipe theo tên',
    category: 'agent',
  },
  {
    name: 'skills',
    syntax: '/skills',
    description: 'Xem danh sách và quản lý các kỹ năng SKILL.md',
    aliases: ['skill'],
    category: 'system',
  },
  {
    name: 'memory',
    syntax: '/memory',
    description: 'Xem và quản lý bộ nhớ dài hạn (Goose memory)',
    aliases: ['memories'],
    category: 'system',
  },
  {
    name: 'tools',
    syntax: '/tools [query]',
    description: 'Xem danh mục hoặc tìm kiếm công cụ có sẵn',
    aliases: ['tool'],
    category: 'system',
  },
  {
    name: 'cost',
    syntax: '/cost',
    description: 'Xem số lượng token đã dùng và chi phí ước tính',
    aliases: ['usage', 'tokens'],
    category: 'session',
  },
];

export type ParsedSlashCommand =
  | { kind: 'plan'; target: string }
  | { kind: 'mode'; mode: 'always' | 'smart' | 'never' | 'chat_only' }
  | { kind: 'summarize' }
  | { kind: 'recipe'; recipeName: string }
  | { kind: 'skills' }
  | { kind: 'memory' }
  | { kind: 'tools'; query?: string }
  | { kind: 'cost' }
  | { kind: 'custom_recipe'; recipeId: string; args?: string }
  | { kind: 'unknown'; command: string; raw: string }
  | null;

/**
 * Chuẩn hóa tham số mode sang 1 trong 4 approvalPolicy chuẩn:
 * 'always' (approve / manual), 'smart' (smart), 'never' (auto / autonomous), 'chat_only' (chat).
 */
export function normalizeModeParam(input: string): 'always' | 'smart' | 'never' | 'chat_only' | null {
  const lower = input.trim().toLowerCase();
  if (['auto', 'never', 'yolo', 'autonomous'].includes(lower)) return 'never';
  if (['smart'].includes(lower)) return 'smart';
  if (['approve', 'always', 'manual', 'ask'].includes(lower)) return 'always';
  if (['chat', 'chat_only', 'chat-only'].includes(lower)) return 'chat_only';
  return null;
}

/**
 * Phân tích chuỗi nhập vào xem có phải lệnh slash không.
 */
export function parseSlashCommand(
  input: string,
  customMappings?: Record<string, string>,
): ParsedSlashCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const args = (match[2] ?? '').trim();

  if (command === 'plan') {
    return { kind: 'plan', target: args };
  }

  if (command === 'mode' || command === 'policy') {
    const mode = normalizeModeParam(args);
    return mode ? { kind: 'mode', mode } : { kind: 'unknown', command, raw: trimmed };
  }

  if (command === 'summarize' || command === 'compact') {
    return { kind: 'summarize' };
  }

  if (command === 'recipe') {
    return { kind: 'recipe', recipeName: args };
  }

  if (command === 'skills' || command === 'skill') {
    return { kind: 'skills' };
  }

  if (command === 'memory' || command === 'memories') {
    return { kind: 'memory' };
  }

  if (command === 'tools' || command === 'tool') {
    return { kind: 'tools', query: args || undefined };
  }

  if (command === 'cost' || command === 'usage' || command === 'tokens') {
    return { kind: 'cost' };
  }

  // Kiểm tra custom slash command: /<tên> -> recipeId
  if (customMappings && command in customMappings) {
    return {
      kind: 'custom_recipe',
      recipeId: customMappings[command],
      args: args || undefined,
    };
  }

  return { kind: 'unknown', command, raw: trimmed };
}
