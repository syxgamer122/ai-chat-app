/**
 * SecurityAnalyzer & AgentStateMachine — phân loại rủi ro + trạng thái agent.
 *
 * MỖI action được kiểm tra qua SecurityAnalyzer trước khi chạy (risk
 * analysis + confirm mode). Vyen đã có auto-pilot (phân quyền theo tool) và
 * permission-broker, nhưng thiếu 2 mảnh:
 *
 * 1. PHÂN LOẠI RỦI RO định lượng theo NỘI DUNG lệnh (low/medium/high/
 *    unknown) — auto-pilot hiện chỉ phân auto/ask/deny theo tên tool + regex
 *    an toàn; ở đây bổ sung khái niệm "rủi ro không chắc chắn" (unknown)
 *    và "rủi ro cao cần confirm rõ ràng" ngay cả khi policy cho phép auto.
 * 2. CONFIRM MODE toàn cục: khi bật, MỌI action "risk > ngưỡng" buộc dừng chờ
 *    phê duyệt bất chấp policy — tương đương `confirmation_mode`.
 *
 * AgentStateMachine bổ sung: tách bạch trạng thái agent (idle/running/
 * paused/error/stopped) khỏi trạng thái hội thoại, cho phép pause/resume an
 * toàn. Vyen cần state machine nhỏ để goal-loop/delegate dùng chung, tránh
 * mỗi feature tự chế trạng thái riêng.
 *
 * Thuần function, không Dexie/React — test được trong node.
 */

/* ------------------------------------------------------------------ */
/* SecurityAnalyzer                                                    */
/* ------------------------------------------------------------------ */

export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export interface SecurityAnalysis {
  risk: RiskLevel;
  /** Lý do phân loại — hiển thị cho người dùng trong modal phê duyệt. */
  reason: string;
  /** true khi cần dừng chờ phê duyệt theo confirm mode + ngưỡng. */
  requiresConfirmation: boolean;
}

/** Ngưỡng risk cần confirm khi confirm mode bật (default: medium trở lên). */
export const CONFIRM_RISK_THRESHOLD: RiskLevel = 'medium';

/**
 * Pattern rủi ro CAO — phá hoại dữ liệu/hệ thống, luôn confirm kể cả khi
 * policy cho auto (chồng lên auto-pilot, không thay thế).
 */
const HIGH_RISK_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+-(?:rf|r)\b/i, reason: 'Xóa đệ quy file/thư mục' },
  { re: /\bdel\s+\/[qs]\b/i, reason: 'Xóa đệ quy (Windows)' },
  { re: /\b(git\s+)?(reset\s+--hard|clean\s+-[fdx]+|push\s+--force|push\s+-f)\b/i, reason: 'Ghi đè/làm mất lịch sử git' },
  { re: /\b(drop\s+(table|database)|truncate\s+table)\b/i, reason: 'Phá hủy dữ liệu DB' },
  { re: /\b(mkfs|format\s+[a-zA-Z]:|diskpart)\b/i, reason: 'Format ổ đĩa' },
  { re: /\bdd\s+.*of=\/dev\/\b/i, reason: 'Ghi trực tiếp thiết bị' },
  { re: /\b(shutdown|reboot|poweroff)\b/i, reason: 'Tắt/khởi động lại hệ thống' },
  { re: /\b(chmod|chown)\s+(-R\s+)?777\b/i, reason: 'Mở quyền ghi toàn cục' },
  { re: /\b(curl|wget)\b.*\|\s*(ba)?sh\b/i, reason: 'Thực thi script từ mạng' },
  { re: /\bnpm\s+(publish|unpublish)\b/i, reason: 'Đăng package public' },
];

/**
 * Pattern rủi ro VỪA — thay đổi có hồi phục nhưng đáng để người dùng biết.
 */
const MEDIUM_RISK_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bgit\s+(add|commit|merge|rebase|stash|checkout|switch)\b/i, reason: 'Thay đổi trạng thái git' },
  { re: /\b(npm|yarn|pnpm|bun)\s+(install|add|remove|uninstall|update)\b/i, reason: 'Thay đổi dependencies' },
  { re: /\bkill(all)?\b/i, reason: 'Kết thúc tiến trình' },
  { re: /\bmv\b.*\b(\/|~)\b/i, reason: 'Di chuyển file ra ngoài/thư mục hệ thống' },
  { re: /\b(apt|brew|choco)\s+(install|remove|upgrade)\b/i, reason: 'Cài/gỡ phần mềm hệ thống' },
  { re: /\b(docker|kubectl)\s+(rm|delete|down|prune)\b/i, reason: 'Xóa tài nguyên container' },
  { re: />\s*\/(etc|usr|var|boot)\b/i, reason: 'Ghi vào thư mục hệ thống' },
];

/**
 * Pattern AN TOÀN — chỉ đọc/phan tích. Ghi đè quyết định "không chắc chắn"
 * của heuristic: cat/ls/grep... không nên bị nghi ngờ oan.
 */
const LOW_RISK_PATTERNS: RegExp[] = [
  /^\s*(cat|head|tail|less|more|ls|dir|stat|file|wc)\b/i,
  /^\s*(grep|rg|find|fd|ag)\b/i,
  /^\s*git\s+(status|log|diff|show|branch|remote|tag|blame|shortlog|rev-parse|ls-files)\b/i,
  /^\s*(npm|npx|yarn|pnpm|bun)\s+(test|run\s+test|run\s+lint|run\s+typecheck|run\s+build|lint|typecheck)\b/i,
  /^\s*(node|python3?|tsx|ts-node)\s+(-v|--version|-V)\b/i,
  /^\s*(echo|pwd|which|whoami|date|env|printenv)\b/i,
];

/**
 * Phân tích rủi ro một SHELL COMMAND — mảnh auto-pilot của Vyen còn thiếu:
 * trả về 'unknown' khi không khớp pattern nào thay vì đoán — caller (auto-
 * pilot) quyết định hỏi người dùng khi unknown, đúng tinh thần "conservative
 * defaults" nhưng có phân cấp rõ ràng.
 */
export function analyzeShellCommand(command: string): SecurityAnalysis {
  const cmd = (command ?? '').trim();
  if (!cmd) {
    return { risk: 'unknown', reason: 'Lệnh rỗng', requiresConfirmation: false };
  }

  // 1. High risk — luôn thắng mọi pattern khác.
  for (const { re, reason } of HIGH_RISK_PATTERNS) {
    if (re.test(cmd)) {
      return { risk: 'high', reason, requiresConfirmation: true };
    }
  }

  // 2. Low risk — pattern an toàn KHÔNG bị pattern medium "ăn" vì chúng
  //    neo ^ đầu chuỗi (lệnh cat ... | rm vẫn có high pattern phía sau).
  for (const re of LOW_RISK_PATTERNS) {
    if (re.test(cmd)) {
      return { risk: 'low', reason: 'Lệnh chỉ đọc/phân tích', requiresConfirmation: false };
    }
  }

  // 3. Medium risk.
  for (const { re, reason } of MEDIUM_RISK_PATTERNS) {
    if (re.test(cmd)) {
      return { risk: 'medium', reason, requiresConfirmation: false };
    }
  }

  // 4. Không nhận diện được — khai báo trung thực là unknown.
  return {
    risk: 'unknown',
    reason: 'Lệnh không nằm trong danh sách nhận diện — cần con người đánh giá',
    requiresConfirmation: false,
  };
}

/**
 * Áp confirm mode: khi bật, mọi action có risk >= threshold đều cần confirm.
 * Đây là "chốt chặn cuối" toàn cục mà permission-broker chưa có.
 */
export function applyConfirmMode(
  analysis: SecurityAnalysis,
  confirmMode: boolean,
  threshold: RiskLevel = CONFIRM_RISK_THRESHOLD,
): SecurityAnalysis {
  if (!confirmMode) return analysis;
  const order: RiskLevel[] = ['low', 'medium', 'high', 'unknown'];
  if (order.indexOf(analysis.risk) >= order.indexOf(threshold)) {
    return { ...analysis, requiresConfirmation: true };
  }
  return analysis;
}

/* ------------------------------------------------------------------ */
/* AgentStateMachine                                                   */
/* ------------------------------------------------------------------ */

export type AgentState =
  | 'idle'
  | 'running'
  | 'paused'
  | 'awaiting_approval'
  | 'error'
  | 'stopped'
  | 'finished';

/** Chuyển đổi trạng thái HỢP LỆ — ngoài bảng này là từ chối (trả null). */
const TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ['running', 'stopped'],
  running: ['paused', 'awaiting_approval', 'error', 'finished', 'stopped'],
  paused: ['running', 'stopped'],
  awaiting_approval: ['running', 'stopped', 'error'],
  error: ['running', 'stopped'], // retry hoặc dừng hẳn
  stopped: [], // terminal
  finished: [], // terminal
};

export const AGENT_STATE_MACHINE = {
  states: Object.keys(TRANSITIONS) as AgentState[],
  transitions: TRANSITIONS,
} as const;

/** Kiểm tra một chuyển đổi có hợp lệ không. */
export function canTransition(from: AgentState, to: AgentState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Áp một chuyển đổi; trả state mới nếu hợp lệ, THROW nếu không (lập trình
 * viên lỗi là bug gọi API, không phải runtime condition).
 */
export function transitionAgent(current: AgentState, to: AgentState): AgentState {
  if (!canTransition(current, to)) {
    throw new Error(`Chuyển đổi agent state không hợp lệ: ${current} → ${to}`);
  }
  return to;
}
