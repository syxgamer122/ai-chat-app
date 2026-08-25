/**
 * Status restatement registry — sửa nhãn lỗi SAI của free gateway trước khi
 * bộ phân loại (`classifyUpstreamStatus` + `diagnoseUpstreamError`) đọc.
 *
 * Thực tế đo đạc trên các gateway free: nhiều cái trả 403/500 kèm nội dung
 * body cho biết nguyên nhân THẬT là quota/rate-limit/auth — nếu tin vào số
 * status thì phân loại sai hướng (blame WAF/blame server), failover đi nhầm
 * đường hoặc dừng oan. Pattern port từ OmniRoute
 * (`upstreamStatusRestatement.ts` + `providerErrorRules.ts`): bảng rule
 * {from, match, unless?, to} — khớp marker trong body thì VIẾT LẠI status.
 *
 * Nguyên tắc bảo thủ: chỉ restatement khi body RÕ RÀNG nói nguyên nhân; có
 * dấu hiệu Cloudflare/WAF thì KHÔNG đụng vào (đó là block thật theo IP).
 */

export interface RestateRule {
  /** Chỉ áp dụng cho các status gốc này. */
  from: readonly number[];
  /** Marker trong body lỗi xác nhận nguyên nhân thật. */
  match: RegExp;
  /** Có marker này thì giữ nguyên status (block thật, không phải mislabel). */
  unless?: RegExp;
  /** Status đúng sau khi restatement. */
  to: number;
  /** Nhãn ngắn ghi vào devLog để debug. */
  reason: string;
}

/**
 * Bảng rule — MỞ RỘNG khi gặp case mới thực tế, mỗi rule phải kèm nguồn gốc
 * quan sát trong comment.
 */
export const STATUS_RESTATE_RULES: readonly RestateRule[] = [
  {
    // New API/one-api họ trả 403/400 kèm chữ quota thay vì 429 — retry trên
    // key khác là đúng đường, nhưng 403 hiện tại bị coi là WAF/forbidden.
    from: [400, 403, 503],
    match: /\b(quota|insufficient[_ ]?(?:balance|credit|quota))\b|额度不足|余额不足/i,
    unless: /cloudflare|attention required|just a moment|error code: 1020/i,
    to: 429,
    reason: 'quota-body→429',
  },
  {
    // Một số gateway trả 5xx generic khi thực chất đang throttle.
    from: [500, 502],
    match: /\brate.?limit\b|\btoo many requests\b|请求过多|请求频率/i,
    unless: /cloudflare|attention required/i,
    to: 429,
    reason: 'ratelimit-body→429',
  },
  {
    // 403 mang chữ key/token không hợp lệ → là lỗi AUTH (quarantine được),
    // không phải forbidden chung chung — cho phép key health xử lý đúng.
    from: [403],
    match: /invalid[\s_-]*api[\s_-]*key|incorrect api key|unauthorized.*key|api key.*(invalid|expired)/i,
    unless: /cloudflare|attention required/i,
    to: 401,
    reason: 'apikey-body→401',
  },
];

export interface RestateResult {
  /** Status nên dùng cho toàn bộ pipeline phân loại phía sau. */
  status: number | undefined;
  /** reason khi có restatement, undefined khi giữ nguyên. */
  reason?: string;
}

/** Áp bảng rule lên cặp (status gốc, body lỗi). Thuần function — test không cần network. */
export function restateUpstreamStatus(
  status: number | undefined,
  bodyText: string,
): RestateResult {
  if (!status || !bodyText) return { status };
  for (const rule of STATUS_RESTATE_RULES) {
    if (!rule.from.includes(status)) continue;
    if (!rule.match.test(bodyText)) continue;
    if (rule.unless?.test(bodyText)) continue;
    if (rule.to === status) continue;
    return { status: rule.to, reason: rule.reason };
  }
  return { status };
}
