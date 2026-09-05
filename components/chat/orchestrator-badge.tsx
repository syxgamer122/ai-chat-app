'use client';

import { memo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * Badge "Kết quả Orchestrator" — provenance cho message assistant được "Thêm
 * vào hội thoại" từ panel Orchestrator (nút ghi đáp án tổng hợp kèm annotation
 * `orchestratorAdopted`, persist theo message qua Dexie).
 *
 * Thuần presentational: không biết gì về orchestrator store, chỉ đọc payload
 * truyền vào. Payload đi qua DB rồi load lại nên từng field có thể thiếu /
 * null / sai type — mọi field đều được normalize trước khi hiển thị, payload
 * rỗng vẫn render được ở mức tối thiểu (icon + nhãn), không crash.
 */

/** Field nào cũng có thể thiếu/null — nguồn ghi là chat-interface, nhưng DB cũ
    hoặc client khác có thể ghi thưa hơn. */
export interface OrchestratorAdoptedPayload {
  goal?: string | null;
  runs?: number | null;
  ok?: number | null;
  failed?: number | null;
  model?: string | null;
  adoptedAt?: number | null;
}

/** Lấy chuỗi hiển thị được (trim, bỏ chuỗi rỗng) — trả null nếu không dùng được. */
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v : null;

/** Lấy số hiển thị được — loại NaN/Infinity/kiểu sai. */
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** dd/MM HH:mm theo locale app (vi-VN). adoptedAt là Date.now() ghi trên
    máy người dùng nên format bằng timezone local là nhất quán. */
function formatAdoptedAt(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const OrchestratorBadge = memo(function OrchestratorBadge({
  payload,
}: {
  payload: OrchestratorAdoptedPayload;
}) {
  const [expanded, setExpanded] = useState(false);

  /* Normalize toàn bộ trước khi render — payload có thể là object rỗng hoặc
     field sai type sau nhiều vòng persist. */
  const p: OrchestratorAdoptedPayload = (payload ?? {}) as OrchestratorAdoptedPayload;
  const goal = str(p.goal);
  const runs = num(p.runs);
  const ok = num(p.ok);
  const failed = num(p.failed);
  const model = str(p.model);
  const adoptedAt = num(p.adoptedAt);

  /* Meta gọn một hàng: số lượt + model + tỉ lệ ok/failed (chỉ hiện cái có). */
  const meta: string[] = [];
  if (runs != null) meta.push(`${runs} lượt chạy`);
  if (model) meta.push(model);
  if (ok != null && failed != null) meta.push(`${ok} ok / ${failed} lỗi`);
  else if (ok != null) meta.push(`${ok} ok`);
  else if (failed != null) meta.push(`${failed} lỗi`);

  /* Chỉ cho expand khi có thông tin bổ sung (goal đầy đủ / thời gian adopt);
     payload rỗng thì chip render tĩnh, không bắt sự kiện. */
  const canExpand = goal != null || adoptedAt != null;
  const timeText = adoptedAt != null ? formatAdoptedAt(adoptedAt) : '';

  /* Cùng hệ chip với tool-trace (DESIGN.md): góc vuông, hairline #495059,
     nền panel, một theme dark duy nhất. Không glow/shimmer — nhãn tĩnh. */
  const chipClass =
    'flex max-w-full items-center gap-1.5 rounded-none border border-[#495059] bg-[#212730] px-2.5 py-1 font-mono text-[11px] transition-colors duration-100 text-[#9fa4ab]';
  const inner = (
    <>
      <span className="flex-shrink-0 font-semibold text-[#ebe7e4]">Kết quả Orchestrator</span>
      {meta.length > 0 && (
        <span className="flex-shrink-0 text-[#9fa4ab]">{meta.join(' · ')}</span>
      )}
      {goal && (
        <span className="min-w-0 max-w-[220px] truncate text-[#9fa4ab]">
          {goal}
        </span>
      )}
      {canExpand && expanded && <ChevronDown size={11} className="flex-shrink-0 text-[#9fa4ab]" aria-hidden />}
      {canExpand && !expanded && <ChevronRight size={11} className="flex-shrink-0 text-[#9fa4ab]" aria-hidden />}
    </>
  );

  return (
    <div className="max-w-full">
      {canExpand ? (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          title={goal ?? undefined}
          className={`${chipClass} cursor-pointer hover:border-[#757d89] hover:text-[#ebe7e4]`}
        >
          {inner}
        </button>
      ) : (
        <div className={chipClass}>{inner}</div>
      )}

      {expanded && (
        <div className="mt-1.5 rounded-none border border-[#495059] bg-[#161d27] px-2.5 py-1.5 font-mono text-[11px] text-[#9fa4ab]">
          {goal && (
            <p className="whitespace-pre-wrap break-words" title={goal}>
              <span className="font-medium text-[#ebe7e4]">Mục tiêu:</span> {goal}
            </p>
          )}
          {timeText && (
            <p>
              <span className="font-medium text-[#ebe7e4]">Thời gian:</span> {timeText}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Extract payload `orchestratorAdopted` đầu tiên từ annotations của message
 * (mỗi message adopt chỉ ghi một annotation như vậy). Trả null khi không có
 * — caller dựa vào đó để không render badge trên message thường.
 */
export function getOrchestratorAdoptedAnnotation(
  annotations: unknown[] | undefined,
): OrchestratorAdoptedPayload | null {
  if (!annotations) return null;
  for (const ann of annotations) {
    if (typeof ann !== 'object' || ann === null) continue;
    const payload = (ann as Record<string, unknown>).orchestratorAdopted;
    if (typeof payload === 'object' && payload !== null) {
      return payload as OrchestratorAdoptedPayload;
    }
  }
  return null;
}
