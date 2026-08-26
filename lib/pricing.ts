/**
 * Bảng giá công khai USD/1M token (input/output) — ước lượng chi phí BYOK.
 *
 * Match theo FRAGMENT DÀI NHẤT trong model id (pattern ReidX `runtime/cost.py`
 * + OmniRoute): "gpt-4o-mini" phải khớp entry của nó trước "gpt-4o". Model
 * không nhận diện được → null (hiển thị "—", KHÔNG bịa tiền — model local/
 * gateway free phải hiện 0$ đúng nghĩa).
 *
 * Giá là THAM KHẢO tại thời điểm viết; gateway riêng của user có thể khác.
 */

export interface PriceEntry {
  fragment: string;
  /** USD / 1M input tokens. */
  in: number;
  /** USD / 1M output tokens. */
  out: number;
}

/** Sắp xếp giảm dần theo độ dài fragment lúc khởi tạo — match dài nhất thắng. */
const TABLE: readonly PriceEntry[] = [
  // OpenAI
  { fragment: 'gpt-4.1-nano', in: 0.1, out: 0.4 },
  { fragment: 'gpt-4.1-mini', in: 0.4, out: 1.6 },
  { fragment: 'gpt-4.1', in: 2.0, out: 8.0 },
  { fragment: 'gpt-4o-mini', in: 0.15, out: 0.6 },
  { fragment: 'gpt-4o', in: 2.5, out: 10.0 },
  { fragment: 'o4-mini', in: 1.1, out: 4.4 },
  { fragment: 'o3-mini', in: 1.1, out: 4.4 },
  { fragment: 'o3', in: 2.0, out: 8.0 },
  { fragment: 'o1-mini', in: 3.0, out: 12.0 },
  // Anthropic
  { fragment: 'claude-opus-4', in: 15.0, out: 75.0 },
  { fragment: 'claude-sonnet-4', in: 3.0, out: 15.0 },
  { fragment: 'claude-haiku-4', in: 0.8, out: 4.0 },
  { fragment: 'claude-3-5-haiku', in: 0.8, out: 4.0 },
  { fragment: 'claude-3-5-sonnet', in: 3.0, out: 15.0 },
  { fragment: 'claude-3-haiku', in: 0.25, out: 1.25 },
  // DeepSeek
  { fragment: 'deepseek-reasoner', in: 0.55, out: 2.19 },
  { fragment: 'deepseek-r1', in: 0.55, out: 2.19 },
  { fragment: 'deepseek-chat', in: 0.14, out: 0.28 },
  { fragment: 'deepseek-v3', in: 0.14, out: 0.28 },
  { fragment: 'deepseek', in: 0.14, out: 0.28 },
  // Google
  { fragment: 'gemini-2.0-flash', in: 0.1, out: 0.4 },
  { fragment: 'gemini-flash-lite', in: 0.075, out: 0.3 },
  { fragment: 'gemini-1.5-pro', in: 1.25, out: 5.0 },
  { fragment: 'gemini-flash', in: 0.15, out: 0.6 },
  { fragment: 'gemini-pro', in: 1.25, out: 5.0 },
  // Qwen / GLM / Kimi (giá API public phổ biến)
  { fragment: 'qwen-max', in: 1.6, out: 6.4 },
  { fragment: 'qwen-plus', in: 0.4, out: 1.2 },
  { fragment: 'qwen-turbo', in: 0.05, out: 0.2 },
  { fragment: 'glm-4-plus', in: 1.4, out: 1.4 },
  { fragment: 'glm-4', in: 0.14, out: 0.14 },
  { fragment: 'kimi', in: 0.6, out: 2.5 },
].sort((a, b) => b.fragment.length - a.fragment.length);

export interface ModelPrice {
  in: number;
  out: number;
}

/** Tìm giá theo fragment dài nhất khớp model id (lowercase). */
export function findModelPrice(modelId: string): ModelPrice | null {
  const id = (modelId ?? '').toLowerCase();
  if (!id) return null;
  for (const entry of TABLE) {
    if (id.includes(entry.fragment)) return { in: entry.in, out: entry.out };
  }
  return null;
}

/** Chi phí USD cho một lượt gọi; model không có giá → null (không bịa số). */
export function estimateCallCostUsd(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const price = findModelPrice(modelId);
  if (!price) return null;
  return (
    (promptTokens / 1_000_000) * price.in +
    (completionTokens / 1_000_000) * price.out
  );
}
