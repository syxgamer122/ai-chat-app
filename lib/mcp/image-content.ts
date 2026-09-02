/**
 * Image content MCP → text — lượt mô tả ảnh cho kết quả tool MCP.
 *
 * Vấn đề gốc: MCP spec cho phép tool trả content blocks lẫn ảnh base64, nhưng
 * model của Vyen tiêu thụ tool-result dạng TEXT. `mcpContentToText` (sync,
 * fallback) hiện thay mỗi khối ảnh bằng dòng ghi chú "[ảnh ... — Vyen chưa
 * đưa ảnh từ MCP vào ngữ cảnh]" → model biết CÓ ảnh nhưng không bao giờ thấy
 * nội dung. App đã có pipeline vision (`/api/vision` qua lib/fs-vision.ts);
 * module này tái dùng pipeline đó cho ảnh DO MCP TRẢ VỀ.
 *
 * Thiết kế "thuần": mô-đun không tự gọi fetch — caller đưa describer vào
 * (dependency injection, giống WorkspaceImageReader của fs-vision) nên chạy
 * được ở renderer lẫn test. Mọi thất bại mô tả đều HÓA thành khối text ghi
 * lỗi, không bao giờ ném ra ngoài — một ảnh hỏng không làm mất các khối khác.
 */

import type { McpContentBlock } from '@/lib/mcp/tool-mapper';

/**
 * Trần số ảnh mô tả mỗi tool-result (mặc định). Mỗi ảnh là một request
 * vision; không trần thì một tool trả 50 ảnh sẽ thành 50 lần gọi Gemini
 * và nhét 50 bản mô tả dài vào ngữ cảnh model.
 */
export const DEFAULT_MAX_MCP_IMAGES = 4;

/** Hàm mô tả ảnh do caller cung cấp — nhận data URL, trả bản mô tả text. */
export type McpImageDescriber = (dataUrl: string, mimeType: string) => Promise<string>;

/**
 * Khối image "đủ điều kiện mô tả": MCP spec bắt buộc cặp data (base64,
 * không rỗng) + mimeType. Khối thiếu field nào coi như hỏng — trả null để
 * tầng giữ nguyên nguyên bản (mcpContentToText tự ghi chú), không đếm vào trần.
 */
function imageFields(block: McpContentBlock): { data: string; mimeType: string } | null {
  const { data, mimeType } = block;
  if (typeof data !== 'string' || data.length === 0) return null;
  if (typeof mimeType !== 'string' || mimeType.length === 0) return null;
  return { data, mimeType };
}

/**
 * true nếu content có ≥1 khối image hợp lệ (type 'image' + data + mimeType).
 * Caller dùng để quyết định có đáng đi qua luồng vision (mất mạng, mất thời
 * gian chờ) hay không — không có ảnh thì cứ dùng fallback sync cho nhanh.
 */
export function hasMcpImages(content: McpContentBlock[]): boolean {
  for (const item of content ?? []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'image' && imageFields(item)) return true;
  }
  return false;
}

/**
 * Thay các khối image (hợp lệ, trong trần) bằng khối text chứa bản mô tả.
 *
 * Trả về MẢNG MỚI giữ nguyên thứ tự; mọi khối không phải ảnh — và cả ảnh
 * hỏng/ảnh vượt trần — giữ nguyên tham chiếu gốc để tầng trên tự quyết.
 *
 * Quy ước khối text:
 *  - thành công: `[ảnh MCP <mimeType>]: <mô tả>`
 *  - thất bại:   `[ảnh MCP <mimeType>: mô tả thất bại — <lỗi>]`
 *
 * KHÔNG BAO GIỜ throw: describer reject → khối text lỗi; input rỗng/null →
 * trả lại nguyên mảng. Ảnh hợp lệ được mô tả song song (Promise.allSettled)
 * để chờ đúng một vòng network thay vì nối tiếp từng ảnh.
 */
export async function describeMcpImageBlocks(
  content: McpContentBlock[],
  describe: McpImageDescriber,
  opts: { maxImages?: number } = {},
): Promise<McpContentBlock[]> {
  const blocks = content ?? [];
  const maxImages = Math.max(0, opts.maxImages ?? DEFAULT_MAX_MCP_IMAGES);

  // Các khối sẽ mô tả (kèm vị trí + dữ liệu đã xác thực kiểu) — quét theo
  // thứ tự, dừng đủ trần. Ảnh vượt trần không vào danh sách nên tự động giữ
  // nguyên là image block.
  const targets: Array<{ index: number; data: string; mimeType: string }> = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const item = blocks[i];
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'image' && targets.length < maxImages) {
      const fields = imageFields(item);
      if (fields) targets.push({ index: i, ...fields });
    }
  }

  // Không có ảnh nào cần mô tả: trả lại đúng mảng nhận vào (cùng tham chiếu)
  // — caller không mô tả gì thì cũng không phải trả giá copy.
  if (targets.length === 0) return blocks;

  // Callback async: describer ném sync (vi phạm hợp đồng Promise) cũng hóa
  // thành rejection thay vì trồi ra ngoài — giữ trọn lời hứa "không throw".
  const settled = await Promise.allSettled(
    targets.map(async ({ data, mimeType }) =>
      describe(`data:${mimeType};base64,${data}`, mimeType),
    ),
  );

  const result = [...blocks];
  settled.forEach((outcome, k) => {
    const { index, mimeType } = targets[k];
    if (outcome.status === 'fulfilled') {
      result[index] = { type: 'text', text: `[ảnh MCP ${mimeType}]: ${outcome.value}` };
    } else {
      const reason = outcome.reason;
      const msg = reason instanceof Error ? reason.message : String(reason ?? 'không rõ lỗi');
      result[index] = {
        type: 'text',
        text: `[ảnh MCP ${mimeType}: mô tả thất bại — ${msg}]`,
      };
    }
  });

  return result;
}
