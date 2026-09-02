/**
 * Subagent client-tool relay — cầu nối tool client (fs_*, shell_run, git_*,
 * MCP) từ loop SUBAGENT (chạy server-side trong route) xuống renderer.
 *
 * Vấn đề: subagent fork runEmulatedLoop trong process Next.js, nhưng tool
 * client chỉ tồn tại trên máy user (File System Access API / Electron IPC).
 * Không có relay thì subagent chỉ dùng được server tools (web_search...) —
 * [DELEGATION] quảng cáo "đủ tools" mà thực chất là tool giả.
 *
 * Luồng:
 *   1. Subagent gọi fs_read → route ghi annotation {subagentCall} xuống
 *      data-stream và đăng ký promise trong registry này.
 *   2. Renderer thấy annotation khi stream đang active → chạy ĐÚNG executor
 *      của tool client thường (handleClientToolCall).
 *   3. Renderer POST /api/chat/subagent-relay {requestId, toolCallId, result}
 *      → resolveSubagentRelay() resolve promise.
 *   4. Loop subagent nhận [TOOL_RESULT] và chạy tiếp như tool server.
 *
 * Registry ở module scope: handler stream và endpoint POST là hai request
 * Next.js riêng biệt trong cùng process nên chia sẻ được map này. Mọi entry
 * đều có timeout tự dọn — stream chết giữa chừng không leak promise.
 */

export interface SubagentRelayCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

interface PendingEntry {
  resolve: (result: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const SUBAGENT_RELAY_TIMEOUT_MS = 180_000;

const pending = new Map<string, PendingEntry>();

const keyOf = (requestId: string, toolCallId: string) => `${requestId}:${toolCallId}`;

/**
 * Đăng ký một call chờ renderer. Resolve bằng chuỗi kết quả (format giống
 * tool-result thường) — timeout/abort thì resolve chuỗi lỗi JSON để loop
 * subagent nhận lỗi mạch lạc thay vì treo vĩnh viễn.
 */
export function registerSubagentRelay(
  requestId: string,
  call: SubagentRelayCall,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const key = keyOf(requestId, call.toolCallId);
  // Trùng key (retry cùng id): call cũ nhận lỗi ngay, nhường chỗ call mới.
  const existing = pending.get(key);
  if (existing) {
    pending.delete(key);
    clearTimeout(existing.timer);
    existing.resolve(JSON.stringify({ error: 'Bị thay thế bởi call mới trùng id.' }));
  }

  const timeoutMs = opts.timeoutMs ?? SUBAGENT_RELAY_TIMEOUT_MS;
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(key)) {
        resolve(
          JSON.stringify({
            error: `Renderer không trả kết quả tool "${call.toolName}" trong ${Math.round(
              timeoutMs / 1000,
            )}s (relay timeout).`,
          }),
        );
      }
    }, timeoutMs);

    pending.set(key, { resolve, timer });

    if (opts.signal) {
      opts.signal.addEventListener(
        'abort',
        () => {
          if (pending.delete(key)) {
            clearTimeout(timer);
            resolve(JSON.stringify({ error: 'Luồng chat đã dừng trước khi tool hoàn tất.' }));
          }
        },
        { once: true },
      );
    }
  });
}

/** Renderer trả kết quả. False = không có call nào chờ (stream đã đóng). */
export function resolveSubagentRelay(
  requestId: string,
  toolCallId: string,
  result: string,
): boolean {
  const key = keyOf(requestId, toolCallId);
  const entry = pending.get(key);
  if (!entry) return false;
  pending.delete(key);
  clearTimeout(entry.timer);
  entry.resolve(result);
  return true;
}

/** Stream kết thúc/thất bại — tháo mọi call còn treo của request này. */
export function cancelSubagentRelays(requestId: string): number {
  let cancelled = 0;
  const prefix = `${requestId}:`;
  for (const [key, entry] of pending) {
    if (!key.startsWith(prefix)) continue;
    pending.delete(key);
    clearTimeout(entry.timer);
    entry.resolve(JSON.stringify({ error: 'Luồng chat đã kết thúc.' }));
    cancelled += 1;
  }
  return cancelled;
}

/* ---- chỉ dùng trong test ---- */
export function pendingRelayCount(): number {
  return pending.size;
}

export function clearSubagentRelaysForTests(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
}
