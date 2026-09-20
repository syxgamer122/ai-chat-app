/**
 * Persistence cho Zero-Mem — CHỈ chạy ở trình duyệt.
 *
 * Vì sao tách riêng khỏi `lib/zeromem/store.ts`: store phải giữ
 * RUNTIME-AGNOSTIC vì nó còn được CLI headless (`lib/teamwork/tools.ts`) dùng,
 * nơi không có IndexedDB. Nhét Dexie thẳng vào store sẽ làm hỏng đường CLI.
 * Đây là adapter mỏng, chỉ được import từ phía app.
 *
 * Trước khi có file này, ba bảng `zeromemTraces/Entities/Relations` được khai
 * báo trong schema Dexie nhưng KHÔNG ai ghi — bộ nhớ mất sạch khi reload. Nay
 * chúng là nơi lưu thật.
 */

import { db } from '@/lib/db';
import type { ZeroMemStore } from './store';

/** Ghi nhật ký + đồ thị hiện tại xuống Dexie. Gọi sau mỗi lần ghi trace. */
export async function persistZeroMem(store: ZeroMemStore): Promise<void> {
  try {
    const traces = [...store.getTraces()];
    const { entities, relations } = store.getGraph().toJSON();
    await db.transaction(
      'rw',
      db.zeromemTraces,
      db.zeromemEntities,
      db.zeromemRelations,
      async () => {
        await db.zeromemTraces.bulkPut(traces);
        await db.zeromemEntities.bulkPut(entities);
        await db.zeromemRelations.bulkPut(relations);
      },
    );
  } catch {
    /* Persistence là tối ưu, không phải đường sống: lỗi ghi đĩa KHÔNG được làm
       hỏng lượt chạy của agent. */
  }
}

/**
 * Nạp lại bộ nhớ từ Dexie khi store đang rỗng (mở lại app, đổi tab).
 *
 * Chỉ REPLAY trace thay vì nạp thẳng đồ thị đã lưu: trích xuất thực thể là hàm
 * thuần deterministic từ nội dung trace, nên replay tái dựng đồ thị y hệt
 * nguồn — đồng thời tránh rủi ro đồ thị lưu bằng schema cũ không khớp code mới.
 */
export async function hydrateZeroMem(store: ZeroMemStore): Promise<void> {
  if (store.getTraces().length > 0) return;
  try {
    const traces = await db.zeromemTraces.orderBy('timestamp').toArray();
    if (traces.length === 0) return;
    for (const t of traces) {
      store.appendTrace({
        sessionId: t.sessionId,
        episodeId: t.episodeId,
        role: t.role,
        content: t.content,
        ...(t.toolName ? { toolName: t.toolName } : {}),
        ...(t.toolArgs ? { toolArgs: t.toolArgs } : {}),
        ...(t.toolResult !== undefined ? { toolResult: t.toolResult } : {}),
        now: t.timestamp,
      });
    }
  } catch {
    /* Hydrate lỗi: chạy tiếp với bộ nhớ rỗng, không chặn người dùng. */
  }
}
