/**
 * Dòng thống kê dưới mỗi câu trả lời assistant (mượn ý @rokiy/pi-ui cho Pi:
 * ↑input ↓output · thời lượng · chi phí). Thuần hàm để test node.
 *
 * Nguồn dữ liệu: annotation { usage: { promptTokens, completionTokens },
 * model, durationMs?, est? } được chat-interface ghi tại onFinish. `est: true`
 * đánh dấu token ƯỚC LƯỢNG (gateway không trả usage, chat-interface fallback
 * độ dài chữ / 4). Chi phí USD chỉ hiện khi usage THẬT và model có bảng giá
 * trong lib/pricing, mọi trường hợp khác là null chứ không bịa số.
 */
import { estimateCallCostUsd } from '@/lib/pricing';
import type { RoutingRole } from '@/lib/model-routing';

interface UsageAnnotation {
  usage?: { promptTokens?: unknown; completionTokens?: unknown };
  model?: unknown;
  durationMs?: unknown;
  est?: unknown;
  /** Lead/Worker routing (P1-5): vai trò model của lượt — badge cạnh usage. */
  routingRole?: unknown;
}

export interface MessageUsageStats {
  promptTokens: number;
  completionTokens: number;
  /** true = token ước lượng từ độ dài trả lời, không phải số gateway báo. */
  estimated: boolean;
  model: string | null;
  /** epoch ms của lượt trả lời (từ lúc user gửi tới lúc xong); null = không có. */
  durationMs: number | null;
  /** USD ước lượng theo bảng giá công khai; null = không dám tính. */
  costUsd: number | null;
  /** 'lead' | 'worker' | 'planner' khi lượt chạy qua Lead/Worker routing; null = thường. */
  routingRole: RoutingRole | null;
}

/**
 * Lấy annotation usage CUỐI CÙNG trên message (bản mới nhất sau các bước tool).
 * Trả null khi không có usage hoặc cả hai số đều 0.
 */
export function extractMessageUsage(annotations: unknown): MessageUsageStats | null {
  if (!Array.isArray(annotations)) return null;
  let found: UsageAnnotation | undefined;
  for (const a of annotations) {
    if (a && typeof a === 'object' && 'usage' in a) found = a as UsageAnnotation;
  }
  const usage = found?.usage;
  if (!usage || typeof usage !== 'object') return null;

  const prompt = Number(usage.promptTokens ?? 0) || 0;
  const completion = Number(usage.completionTokens ?? 0) || 0;
  if (prompt <= 0 && completion <= 0) return null;

  const model = typeof found?.model === 'string' && found.model ? found.model : null;
  const durationMs =
    typeof found?.durationMs === 'number' &&
    Number.isFinite(found.durationMs) &&
    found.durationMs > 0
      ? found.durationMs
      : null;
  const estimated = found?.est === true;
  const costUsd =
    estimated || !model ? null : estimateCallCostUsd(model, prompt, completion);
  const routingRole =
    found?.routingRole === 'lead' || found?.routingRole === 'worker' || found?.routingRole === 'planner'
      ? found.routingRole
      : null;

  return { promptTokens: prompt, completionTokens: completion, estimated, model, durationMs, costUsd, routingRole };
}

/** Ghép dòng hiển thị: ↑1024 ↓512 · 4.5s · $0.0012. Phần 0 bị bỏ hẳn. */
export function formatMessageUsage(stats: MessageUsageStats): string {
  const parts: string[] = [];
  if (stats.promptTokens > 0) parts.push(`↑${stats.promptTokens}`);
  if (stats.completionTokens > 0) {
    parts.push(`${stats.estimated ? '≈' : ''}↓${stats.completionTokens}`);
  }
  if (stats.durationMs !== null) parts.push(`${(stats.durationMs / 1000).toFixed(1)}s`);
  if (stats.costUsd !== null) {
    parts.push(`$${stats.costUsd < 0.01 ? stats.costUsd.toFixed(4) : stats.costUsd.toFixed(2)}`);
  }
  return parts.join(' · ');
}
