/**
 * MCP bridge phía renderer — cửa ngõ DUY NHẤT xuống `window.vyen.mcp`.
 *
 * Tồn tại để phần còn lại của app không phải biết:
 *  - MCP chỉ sống trong Electron desktop (web thì không có gì cả),
 *  - shell Electron có thể cũ hơn renderer và chưa expose `mcp`.
 *
 * Mọi hàm đều "mềm": thay vì ném lỗi khi bridge vắng mặt, chúng trả giá trị
 * rỗng / false để caller rẽ nhánh. Chỉ những thao tác người dùng CHỦ ĐỘNG bấm
 * (thêm server, gọi tool) mới ném lỗi mang thông điệp cụ thể.
 */

import {
  vyenDesktop,
  type VyenMcpApprovalRequest,
  type VyenMcpCallResult,
  type VyenMcpPermissionDecision,
  type VyenMcpServerConfig,
  type VyenMcpServerStatus,
  type VyenMcpToolInfo,
} from '@/lib/desktop-bridge';

/** MCP chỉ khả dụng trong app desktop có shell hỗ trợ. */
export function isMcpAvailable(): boolean {
  return typeof vyenDesktop()?.mcp?.listTools === 'function';
}

/** Bridge thô hoặc null — caller tự quyết định khi vắng mặt. */
function mcp() {
  return vyenDesktop()?.mcp ?? null;
}

/* ------------------------------------------------------------------ */
/* Đọc (không bao giờ ném)                                             */
/* ------------------------------------------------------------------ */

export async function listMcpServers(): Promise<VyenMcpServerStatus[]> {
  const bridge = mcp();
  if (!bridge) return [];
  try {
    const servers = await bridge.listServers();
    return Array.isArray(servers) ? servers : [];
  } catch {
    // Main chưa init xong hoặc SDK lỗi — danh sách rỗng là câu trả lời đúng:
    // không có server nào để hiện, không đáng làm gián đoạn UI.
    return [];
  }
}

export async function listMcpTools(): Promise<VyenMcpToolInfo[]> {
  const bridge = mcp();
  if (!bridge) return [];
  try {
    const tools = await bridge.listTools();
    return Array.isArray(tools) ? tools : [];
  } catch {
    return [];
  }
}

export async function getMcpStatus(): Promise<{
  servers: VyenMcpServerStatus[];
  tools: number;
}> {
  const bridge = mcp();
  if (!bridge) return { servers: [], tools: 0 };
  try {
    const status = await bridge.getStatus();
    return {
      servers: Array.isArray(status?.servers) ? status.servers : [],
      tools: typeof status?.tools === 'number' ? status.tools : 0,
    };
  } catch {
    return { servers: [], tools: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* Ghi / thực thi (ném lỗi có thông điệp)                              */
/* ------------------------------------------------------------------ */

function requireMcp() {
  const bridge = mcp();
  if (!bridge) {
    throw new Error(
      'MCP chỉ khả dụng trong Vyen desktop (Electron). Hãy chạy app bằng npm run app:dev / app:prod.',
    );
  }
  return bridge;
}

export async function addMcpServer(
  config: VyenMcpServerConfig,
): Promise<VyenMcpServerStatus> {
  return requireMcp().addServer(config);
}

export async function removeMcpServer(id: string): Promise<void> {
  await requireMcp().removeServer(id);
}

export async function reconnectMcpServer(id: string): Promise<VyenMcpServerStatus> {
  return requireMcp().reconnect(id);
}

export async function updateMcpConfig(servers: VyenMcpServerConfig[]): Promise<void> {
  await requireMcp().updateConfig(servers);
}

export async function resolveMcpApproval(
  approvalId: string,
  decision: VyenMcpPermissionDecision,
): Promise<void> {
  await requireMcp().resolveApproval(approvalId, decision);
}

/**
 * Gọi một MCP tool.
 * Ném khi LỖI GIAO THỨC (server mất kết nối, timeout, channel lỗi) — phân
 * biệt với `isError`, tức là tool đã chạy và tự báo thất bại nghiệp vụ.
 */
export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<VyenMcpCallResult> {
  const result = await requireMcp().callTool(serverId, toolName, args ?? {});
  return {
    content: Array.isArray(result?.content) ? result.content : [],
    isError: result?.isError === true,
    ...(result?.denied === true ? { denied: true } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Event một chiều từ main                                             */
/* ------------------------------------------------------------------ */

/** Trả về hàm gỡ đăng ký (hoặc hàm no-op khi không có bridge). */
const noop = () => () => {};

export function onMcpApprovalRequested(
  cb: (req: VyenMcpApprovalRequest) => void,
): () => void {
  const bridge = mcp();
  if (!bridge?.onApprovalRequested) return noop();
  return bridge.onApprovalRequested(cb);
}

export function onMcpApprovalResolved(
  cb: (res: { id: string; decision: VyenMcpPermissionDecision; timedOut?: boolean }) => void,
): () => void {
  const bridge = mcp();
  if (!bridge?.onApprovalResolved) return noop();
  return bridge.onApprovalResolved(cb);
}

export function onMcpServerStatus(cb: (status: VyenMcpServerStatus) => void): () => void {
  const bridge = mcp();
  if (!bridge?.onServerStatus) return noop();
  return bridge.onServerStatus(cb);
}
