/**
 * Chính sách chuỗi model cho các route LLM phụ (title/compact/orchestrate).
 *
 * Nguyên tắc "provider active là nguồn duy nhất": khi request mang provider
 * của người dùng (header `x-api-base` hợp lệ hoặc `x-api-key` BYOK), MỌI lượt
 * gọi LLM phải đi qua baseUrl/key đó và model người dùng đang chọn
 * (body.model) phải được thử ĐẦU TIÊN. Chuỗi model từ biến môi trường chỉ còn
 * vai trò DỰ PHÒNG SAU model người dùng: tên kiểu 'gpt-5-4-nano' là tên thật
 * của gateway mặc định, gần như chắc chắn KHÔNG tồn tại trên provider khác —
 * nhưng khi model người dùng 404 thì còn tên kế để failover thay vì chết ngắt.
 *
 * Khi KHÔNG có provider (chế độ demo trên Vercel): bỏ qua body.model hoàn
 * toàn để hành vi cũ không đổi — demo dùng catalog model của máy chủ nên
 * chuỗi env vẫn là nguồn đúng.
 *
 * Module THUẦN: không đọc env, không side effect, không network — test được
 * trong node và dùng chung cho 3 route mà không kéo dependency của route.
 */

import { z } from 'zod';

/**
 * Field `model` cho body của route phụ (dùng ở /api/title).
 * Chặn tên rác (khoảng trắng, ký tự lạ, chuỗi rỗng) trước khi tên được gửi
 * thẳng lên upstream dưới dạng model_id — tên vi phạm khiến request hỏng ngay
 * từ lượt đầu thay vì rơi vào failover vô nghĩa.
 *
 * Trần 120 ký tự (nới từ 64 của compact/orchestrate cũ): model id thật của
 * gateway có dạng `vendor/model:tag` — vd `deepseek/deepseek-r1-0528:free` —
 * dễ vượt 64, cắt ngắn hơn sẽ chặn oan model hợp lệ.
 */
export const ACTIVE_MODEL_FIELD = z.string().min(1).max(120).regex(/^[\w.\-:~/]+$/);

/**
 * Bản dùng TRONG body schema của route: model rác chỉ bị BỎ QUA, không được
 * giết cả request.
 *
 * Lý do: `model` là field PHỤ. Không có `.catch()`, một tên model méo (client
 * cũ, người dùng dán tên có khoảng trắng) làm cả `safeParse` fail → /api/title
 * trả 'New Chat' và ghi đè tiêu đề heuristic, /api/compact trả `bad_schema` →
 * hội thoại rơi về hard-trim, /api/orchestrate chết trước khi chạy, và
 * `visionModel` rác thì giết luôn lượt chat. Hạ cấp tính năng chính vì một
 * field phụ là sai đánh đổi: bỏ field đó đi thì route vẫn chạy đúng bằng
 * chuỗi model dự phòng (hoặc bỏ bridge, rơi về placeholder).
 */
export const ACTIVE_MODEL_BODY_FIELD = ACTIVE_MODEL_FIELD.optional().catch(undefined);

/**
 * "Provider active" theo quy ước header của /api/chat: request có baseUrl
 * provider hợp lệ (đã qua validateProviderBaseUrl) HOẶC có key BYOK hợp lệ.
 *
 * Nhận giá trị ĐÃ sanitize của route (providerBase/customKey sau khi validate
 * độ dài/ký tự) — đừng nhét header thô vào đây.
 *
 * Đặc biệt: có baseUrl nhưng KHÔNG có key (gateway miễn phí, route thay key
 * bằng 'provider-no-key') vẫn là provider active: chuỗi model phải theo
 * provider đó chứ không theo env của máy chủ.
 */
export function isActiveProvider(
  providerBase: string | undefined,
  customKey: string | undefined,
): boolean {
  return Boolean(providerBase || customKey);
}

/**
 * Đặt model lên đầu chuỗi, khử trùng bằng so khớp CHÍNH XÁC (phân biệt hoa
 * thường — model_id của API tương thích OpenAI phân biệt hoa thường, khử
 * kiểu lowercase sẽ giết nhầm tên hợp lệ). Model rỗng/toàn khoảng trắng bị
 * coi như không có.
 *
 * Luôn trả mảng MỚI — kẻo route vô tình đụng vào frozen array dùng chung.
 */
export function prependActiveModel(
  activeModel: string | undefined,
  fallbackChain: readonly string[],
): string[] {
  const preferred = activeModel?.trim();
  if (!preferred) return [...fallbackChain];
  return [preferred, ...fallbackChain.filter((m) => m !== preferred)];
}

export interface ActiveModelChainInput {
  /** Kết quả isActiveProvider(providerBase, customKey) của route. */
  providerActive: boolean;
  /** Model người dùng đang chọn (body.model) — chỉ được ưu tiên khi providerActive. */
  model?: string;
  /** Chuỗi dự phòng từ env, ĐÃ qua filterSupportedModels của route. */
  fallbackChain: readonly string[];
}

/**
 * Xây chuỗi model theo chính sách provider-active (xem đầu file). Cả 3 route
 * phụ dùng chung hàm này để không route nào "quên" nhánh gating demo.
 */
export function buildActiveModelChain({
  providerActive,
  model,
  fallbackChain,
}: ActiveModelChainInput): string[] {
  return prependActiveModel(providerActive ? model : undefined, fallbackChain);
}
