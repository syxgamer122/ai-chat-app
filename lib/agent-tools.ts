/**
 * Agentic tools cho /api/chat — model TỰ quyết khi nào cần dữ liệu ngoài
 * (pattern fx/OpenClaw): không còn đoán ý định bằng regex hay toggle thủ công.
 *
 * - web_search / web_fetch: tái dùng đúng đường ống SSRF-guarded của /api/web
 * - weather / exchange_rates: bọc live-tools (Open-Meteo, open.er-api)
 * - memory_search: tra ghi nhớ dài hạn của người dùng (chỉ đọc)
 *
 * Ba lớp tự vệ trong file này (port triết lý fx auto_classifier):
 *  1. DEDUPE/loop-guard: gọi trùng (tool + args) hoặc vượt trần số call →
 *     trả note bảo model tổng hợp thay vì thực thi lại.
 *  2. PROVENANCE: web_fetch chỉ đọc host có nguồn gốc rõ ràng (tin nhắn user,
 *     kết quả search cùng lượt) — chặn chuỗi crawl do nội dung web dẫn dụ.
 *  3. INJECTION GUARD: kết quả web mang mẫu prompt-injection rõ ràng thì bị
 *     chặn khỏi ngữ cảnh trước khi model bước sang step kế tiếp.
 *
 * Model gọi qua function calling của gateway (crax/Kilgore đều hỗ trợ với
 * model chat hiện đại); gateway từ chối thì route tự tắt tools và thử lại
 * không tools — xem xử lý lỗi trong route.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { capHits, fetchReadablePage, searchWeb } from '@/lib/web-backend';
import { fetchRates, fetchWeather } from '@/lib/live-tools';
import { WEB_LIMITS } from '@/lib/web-context';
import { judgeInjection } from '@/lib/injection-guard';
import { getToolCallBudget, checkDoomLoop } from '@/lib/tool-call-budget';
import { MAX_TOOL_CALLS_PER_TURN, TOOL_RESULT_MAX_CHARS } from '@/lib/tool-limits';
import { isMcpToolKey } from '@/lib/mcp/tool-mapper';

export type AgentToolSet = ReturnType<typeof buildAgentTools>;

export interface MemoryItem {
  id: string;
  text: string;
}

export interface AgentToolsOptions {
  memories?: MemoryItem[];
  /** Host được phép web_fetch: từ URL user gắn + kết quả search cùng lượt. */
  allowedHosts?: Iterable<string>;
  /** Tắt khi lượt hiện tại đã có webContext được người dùng yêu cầu. */
  includeWeb?: boolean;
  /** Tắt riêng khi client đã lấy được dữ liệu thời tiết cho lượt này. */
  includeWeather?: boolean;
  /** Tắt riêng khi client đã lấy được tỷ giá cho lượt này. */
  includeExchangeRates?: boolean;
  /**
   * Id hội thoại — khoá ngân sách gọi tool sống xuyên các resubmit của
   * client tool. Thiếu id thì rơi về hành vi cũ (đếm theo từng request).
   */
  conversationId?: string | null;
}

/** Trần số lần gọi tool MỌI LOẠI trong một lượt chat. */
export { MAX_TOOL_CALLS_PER_TURN };

/* ------------------------------------------------------------------ */
/* Tìm ghi nhớ (thuần, test được không cần Dexie)                      */
/* ------------------------------------------------------------------ */

/**
 * Tìm fact ghi nhớ khớp query — điểm số = số từ khóa xuất hiện, trả tối đa 5
 * fact tốt nhất.
 */
export function searchMemories(
  memories: MemoryItem[],
  query: string,
): Array<{ id: string; text: string }> {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\d]+/u)
    .filter((w) => w.length >= 2);
  if (!words.length) return [];
  const scored = memories.map((m) => {
    const lower = m.text.toLowerCase();
    const score = words.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0);
    return { m, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => ({ id: s.m.id, text: s.m.text }));
}

/* ------------------------------------------------------------------ */
/* Summarizer cho UI tool-trace (annotation {tool:{...}})               */
/* ------------------------------------------------------------------ */

/** Args ngắn gọn hiển thị trên chip — KHÔNG đưa nội dung dài vào annotation. */
export function summarizeToolArgs(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  /* Tool MCP: tên đã encode server + tool, arg thì tuỳ server ngoài kia nên
     không có case riêng — gom key/value ngắn để chip có nội dung thay vì trống. */
  if (isMcpToolKey(name)) {
    return Object.entries(a)
      .slice(0, 3)
      .map(([k, v]) => {
        const raw = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}=${String(raw ?? '').slice(0, 40)}`;
      })
      .join(' ');
  }
  switch (name) {
    case 'web_search':
      return String(a.query ?? '').slice(0, 80);
    case 'web_fetch':
      return shortenUrl(String(a.url ?? ''));
    case 'weather':
      return String(a.location ?? '').slice(0, 60);
    case 'memory_search':
      return String(a.query ?? '').slice(0, 60);
    case 'shell_run':
      return String(a.command ?? '').slice(0, 80);
    case 'git_commit':
      return String(a.message ?? '').slice(0, 60);
    case 'git_add':
      return Array.isArray(a.paths) ? (a.paths as string[]).join(', ').slice(0, 80) : '';
    case 'git_diff':
      return String(a.path ?? (a.staged ? 'staged' : '')).slice(0, 60);
    default:
      return '';
  }
}

/** Kết quả tóm tắt một dòng — chỉ metadata, không đem content vào annotation. */
export function summarizeToolResult(name: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'web_search': {
      const results = Array.isArray(r.results) ? r.results : [];
      if (r.note && results.length === 0) return String(r.note);
      return `${results.length} kết quả`;
    }
    case 'web_fetch': {
      if (r.content === null || r.content === undefined) return String(r.note ?? 'Không đọc được');
      return `${String(r.title ?? '').slice(0, 70) || shortenUrl(String(r.url ?? ''))}`;
    }
    case 'weather':
      return r.report ? 'Có báo cáo thời tiết' : String(r.note ?? 'Không tra được');
    case 'exchange_rates':
      return r.rates ? 'Có bảng tỷ giá' : String(r.note ?? 'Thất bại');
    case 'memory_search': {
      const matches = Array.isArray(r.matches) ? r.matches : [];
      return matches.length ? `${matches.length} ghi nhớ khớp` : 'Không có ghi nhớ khớp';
    }
    case 'memory_save': {
      if (r.accepted === true) {
        const t = String(r.text ?? '');
        return `Chấp nhận: "${t.slice(0, 50)}${t.length > 50 ? '…' : ''}"`;
      }
      return String(r.note ?? 'Từ chối');
    }
    case 'shell_run': {
      if (typeof r.error === 'string') return r.error.slice(0, 80);
      const code = r.code;
      return code === 0 ? 'thành công' : `exit ${String(code ?? '?')}`;
    }
    case 'git_status': {
      const entries = Array.isArray((r as { entries?: unknown[] }).entries) ? (r as { entries: unknown[] }).entries : [];
      return `${entries.length} thay đổi${r.branch ? ` (${String(r.branch)})` : ''}`;
    }
    case 'git_diff':
      return typeof r === 'string' ? `${(r as string).split('\n').length} dòng diff` : 'có diff';
    case 'git_log':
      return typeof r === 'string' ? `${(r as string).split('\n').filter(Boolean).length} commit` : 'có log';
    default:
      return typeof r.note === 'string' ? r.note.slice(0, 80) : typeof r.error === 'string' ? (r.error as string).slice(0, 80) : '';
  }
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.hostname}${path}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Áp trần kích thước cho kết quả tool ở ĐƯỜNG NATIVE. Trước đây chỉ đường
 * emulated cắt (6k) còn native để nguyên — một web_fetch trang dài có thể
 * đẩy cả chục nghìn token vào context mà ContextMeter không kịp phản ánh.
 *
 * Cắt trên TỪNG trường string dài thay vì stringify cả object, để shape kết
 * quả (results[], content, note...) không đổi — model vẫn đọc được cấu trúc.
 */
function capToolResult(result: Record<string, unknown>): Record<string, unknown> {
  let raw: string;
  try {
    raw = JSON.stringify(result) ?? '';
  } catch {
    return { note: 'Kết quả công cụ không đọc được.' };
  }
  if (raw.length <= TOOL_RESULT_MAX_CHARS) return result;

  const out: Record<string, unknown> = {};
  let remaining = TOOL_RESULT_MAX_CHARS;
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string' && value.length > remaining) {
      out[key] = `${value.slice(0, Math.max(0, remaining))}\n…[đã cắt bớt vì quá dài]`;
      remaining = 0;
    } else {
      out[key] = value;
      if (typeof value === 'string') remaining -= value.length;
    }
  }
  out.truncated = true;
  return out;
}

function stableKey(name: string, args: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(args ?? {});
  } catch {
    raw = String(args);
  }
  // Chuẩn hoá thứ tự key đã đủ vì args đến từ zod-parse của SDK (thứ tự ổn định).
  return `${name}:${raw.slice(0, 300)}`;
}

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

export function buildAgentTools(
  memoriesOrOptions: MemoryItem[] | AgentToolsOptions = [],
) {
  const opts: AgentToolsOptions = Array.isArray(memoriesOrOptions)
    ? { memories: memoriesOrOptions }
    : memoriesOrOptions ?? {};
  const memories = opts.memories ?? [];

  /* Ngân sách theo HỘI THOẠI (không phải theo request): mỗi lần client thực
     thi fs_* xong, useChat resubmit tạo request mới — nếu đếm theo request
     thì trần và dedupe reset sạch, đúng kịch bản vòng lặp fs_list vô hạn đã
     gặp. Không có conversationId → bucket dùng-một-lần (hành vi cũ). */
  const budget = getToolCallBudget(opts.conversationId);
  const callCounts = budget.callCounts;
  const knownHosts = budget.knownHosts;
  for (const h of opts.allowedHosts ?? []) {
    const host = hostOf(h);
    if (host) knownHosts.add(host);
  }

  /**
   * Wrapper chung: đếm tổng call, chặn gọi TRÙNG (cùng tool + cùng args).
   * Trùng thì trả note hướng dẫn model tổng hợp — rẻ hơn và đoán đúng ý hơn
   * việc để nó thử lại rồi nhận y hệt kết quả cũ.
   * `errorFallback` giữ nguyên SHAPE kết quả của từng tool khi lỗi upstream
   * (vd web_search vẫn có `results: []`) — model đọc được cấu trúc ổn định.
   */
  async function guarded(
    name: string,
    args: Record<string, unknown>,
    run: () => Promise<Record<string, unknown>>,
    errorFallback: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    budget.totalCalls += 1;
    budget.touchedAt = Date.now();
    if (budget.totalCalls > MAX_TOOL_CALLS_PER_TURN) {
      return {
        ...errorFallback,
        note:
          'Đã đạt giới hạn số lần gọi công cụ của lượt này. Hãy tổng hợp câu trả lời từ dữ liệu đã có.',
      };
    }
    const key = stableKey(name, args);
    /* Doom-loop TRƯỚC dedupe: dedupe chỉ chặn call trùng THỨ HAI bằng note
       nhẹ; nếu model vẫn ngoan cố lặp lần 3-4-5 (điển hình khi gateway yếu),
       cần tín hiệu MẠNH hơn — steering message bắt đổi hướng. Detector đếm
       chuỗi LẶP LIÊN TIẾP ở đuôi, khác với callCounts đếm tổng. */
    const doom = checkDoomLoop(budget, key);
    if (doom.triggered) {
      return {
        ...errorFallback,
        note:
          `Bạn đã gọi cùng công cụ với cùng tham số ${doom.counted} lần LIÊN TIẾP ` +
          'mà không thu được gì mới. TUYỆT ĐỐI không lặp lại. Hãy: (1) thử một công cụ ' +
          'khác, (2) đổi tham số, hoặc (3) nếu đang vướng thì nói thẳng với người dùng ' +
          'bạn vướng ở đâu và cần họ hỗ trợ gì.',
      };
    }
    const seen = callCounts.get(key) ?? 0;
    callCounts.set(key, seen + 1);
    if (seen > 0) {
      return {
        ...errorFallback,
        note:
          'Bạn đã gọi công cụ này rồi với cùng tham số và đã có kết quả. Dùng lại kết quả đó, đừng gọi lại.',
      };
    }
    try {
      return capToolResult(await run());
    } catch {
      // Giữ hành vi cũ: lỗi network/upstream trả payload "trống + note" để
      // model tự chọn hướng đi thay vì văng exception làm đứt step.
      return { ...errorFallback, note: 'Công cụ tạm thời không khả dụng.' };
    }
  }

  const serverTools = {
    web_search: tool({
      description:
        'Tìm kiếm thông tin HIỆN TẠI trên web công khai (tin tức, giá cả, sự kiện sau thời điểm ' +
        'kiến thức của bạn). Trả về danh sách kết quả có title/url/snippet. Khi trình bày kết quả, ' +
        'luôn trích dẫn nguồn dạng [tên ngắn](url).',
      parameters: z.object({
        query: z
          .string()
          .min(1)
          .max(300)
          .describe('Cụm từ tìm kiếm — viết ngắn gọn, chứa từ khóa chính'),
        count: z.number().int().min(1).max(8).optional().describe('Số kết quả tối đa (mặc định 5)'),
      }),
      execute: async (args) =>
        guarded(
          'web_search',
          args,
          async () => {
            const { hits } = await searchWeb(args.query);
            // Host từ kết quả search trở nên HỢP LỆ để web_fetch ở step sau —
            // đây là đường provenance chính thống duy nhất.
            for (const hit of hits) {
              const host = hostOf(hit.url);
              if (host) knownHosts.add(host);
            }
            // Lọc injection trên title+snippet TRƯỚC khi trả cho model.
            const clean = hits.filter(
              (h) => judgeInjection(`${h.title}\n${h.snippet}`) !== 'block',
            );
            const results = capHits(clean, args.count ?? WEB_LIMITS.maxHits);
            return {
              results,
              ...(results.length === 0 && hits.length > 0
                ? { note: 'Mọi kết quả đều chứa mẫu prompt-injection nên đã bị lọc bỏ.' }
                : {}),
            };
          },
          { results: [] },
        ),
    }),

    web_fetch: tool({
      description:
        'Đọc nội dung văn bản của một URL public cụ thể (bài báo, tài liệu, trang chủ...). ' +
        'Chỉ đọc được trang tĩnh — không đăng nhập, không click. ' +
        'RÀNG BUỘC: URL phải xuất hiện trong kết quả web_search của cùng hội thoại hoặc do ' +
        'người dùng gửi; URL lấy từ nội dung một trang khác sẽ BỊ TỪ CHỐI. Cần đọc trang chưa ' +
        'từng thấy thì gọi web_search trước.',
      parameters: z.object({
        url: z.string().max(2048).describe('URL http(s) đầy đủ cần đọc'),
      }),
      execute: async (args) =>
        guarded(
          'web_fetch',
          args,
          async () => {
            /* Provenance check: host lạ (không nằm trong tin nhắn user hay kết
               quả search) → từ chối TRƯỚC khi fetch. Đây là hàng rào chống kịch
               bản "trang A bảo model đọc trang B" — B phải tự qua search/user. */
            const host = hostOf(args.url);
            if (!host || !knownHosts.has(host)) {
              return {
                url: args.url,
                content: null,
                blocked: 'provenance' as const,
                note:
                  'URL không có nguồn gốc rõ ràng (không nằm trong kết quả tìm kiếm hay tin nhắn ' +
                  'người dùng) nên không được đọc. Hãy tìm kiếm trước rồi mới đọc.',
              };
            }
            const page = await fetchReadablePage(args.url);
            // Injection guard trên NỘI DUNG trang — vector nguy hiểm nhất vì
            // model sẽ đọc nó ở step kế tiếp như "dữ liệu đáng tin".
            if (judgeInjection(page.content) === 'block') {
              return {
                url: page.url,
                title: page.title,
                content: null,
                blocked: 'injection' as const,
                note: 'Nội dung trang chứa mẫu prompt-injection rõ ràng nên đã bị chặn khỏi ngữ cảnh.',
              };
            }
            return {
              url: page.url,
              title: page.title,
              content: page.content,
              truncated: page.truncated,
            };
          },
          { url: args.url, content: null },
        ),
    }),

    weather: tool({
      description:
        'Thời tiết hiện tại + dự báo 2 ngày theo tên nơi (thành phố, tỉnh, quốc gia). ' +
        'Dùng khi người dùng hỏi thời tiết/nhiệt độ/mưa.',
      parameters: z.object({
        location: z.string().min(1).max(80).describe('Tên nơi, ví dụ "Hà Nội", "Tokyo", "Paris"'),
      }),
      execute: async (args) =>
        guarded(
          'weather',
          args,
          async () => {
            const report = await fetchWeather(args.location);
            return report ? { report } : { report: null, note: `Không tra được thời tiết "${args.location}".` };
          },
          { report: null },
        ),
    }),

    exchange_rates: tool({
      description:
        'Tỷ giá hối đoái hôm nay, quy về gốc USD. Dùng khi người dùng hỏi tỷ giá hoặc cần quy ' +
        'đổi tiền tệ. KHÔNG nhận tham số và LUÔN trả về TOÀN BỘ bảng các đồng phổ biến ' +
        '(VND, EUR, JPY, CNY, KRW...) — tự tìm đồng cần dùng trong bảng đó rồi tính, đừng gọi ' +
        'lại nhiều lần cho từng đồng tiền.',
      parameters: z.object({}).describe('Không cần tham số'),
      execute: async (args) =>
        guarded(
          'exchange_rates',
          args,
          async () => {
            const block = await fetchRates();
            return block ? { rates: block } : { rates: null, note: 'Tra tỷ giá thất bại.' };
          },
          { rates: null },
        ),
    }),

    ...(memories.length
      ? {
          memory_search: tool({
            description:
              'Tra kho GHI NHỚ DÀI HẠN mà người dùng đã yêu cầu lưu (sở thích, tên gọi, quy ước ' +
              'làm việc, ràng buộc cá nhân). CHỈ gọi khi: (a) người dùng nhắc tới thiết lập/sở ' +
              'thích cá nhân của chính họ, (b) họ hỏi "tôi đã nói gì về…", "bạn còn nhớ…", hoặc ' +
              '(c) yêu cầu cần biết quy ước riêng của họ mới làm đúng được. ' +
              'KHÔNG gọi cho câu hỏi kiến thức chung, câu hỏi về code, hay khi đã đủ thông tin ' +
              'để trả lời — kho ghi nhớ nhỏ và không liên quan tới kiến thức phổ thông.',
            parameters: z.object({
              query: z.string().min(1).max(200).describe('Từ khóa cần tra, ví dụ "ngôn ngữ ưa thích"'),
            }),
            execute: async (args) =>
              guarded(
                'memory_search',
                args,
                async () => {
                  const matches = searchMemories(memories, args.query);
                  return {
                    matches,
                    totalMemories: memories.length,
                    note: matches.length ? undefined : 'Không có ghi nhớ nào khớp.',
                  };
                },
                {},
              ),
          }),
        }
      : {}),

    /* memory_save LUÔN có mặt (kể cả khi memories rỗng — đó chính là cách
       fact đầu tiên được lưu). Execute phía server CHỈ validate và chấp nhận
       đề xuất: việc ghi thật vào IndexedDB thuộc về client (route phát
       annotation {memoryProposal}, chat-interface gọi addMemory) vì DB nằm
       trong trình duyệt của user. */
    memory_save: tool({
      description:
        'Lưu một THÔNG TIN DÀI HẠN về người dùng để các hội thoại sau nhớ lại (sở thích, tên gọi, ' +
        'quy ước làm việc, ràng buộc cá nhân). CHỈ gọi khi người dùng yêu cầu nhớ rõ ràng ("nhớ giúp ' +
        'mình...", "ghi lại...") hoặc khi họ chia sẻ fact quan trọng cần tái sử dụng. Một lần gọi = ' +
        'MỘT câu ngắn độc lập, không lưu nội dung nhạy cảm (mật khẩu, số thẻ).',
      parameters: z.object({
        text: z.string().min(4).max(400).describe('Câu ghi nhớ ngắn gọn, đứng độc lập, ví dụ "Người dùng thích code style functional TS"'),
      }),
      execute: async (args) =>
        guarded(
          'memory_save',
          args,
          async () => {
            const verdict = validateMemoryProposal(args.text, memories);
            if (!verdict.ok) {
              return {
                accepted: false,
                note: verdict.reason,
              };
            }
            // Chấp thuận KHÔNG có nghĩa là đã ghi — client mới là nơi ghi.
            return {
              accepted: true,
              text: verdict.text,
              note: undefined,
            };
          },
          { accepted: false },
        ),
    }),
  };

  /* Cờ include* CHỈ còn hiệu lực khi caller yêu cầu tường minh. Mặc định
     KHÔNG gỡ tool nữa dù lượt này đã prefetch dữ liệu: regex đoán ý định có
     thể trích sai địa điểm/truy vấn, gỡ tool đi thì model mất đường sửa sai.
     Route hiện dùng ghi chú trong system prompt thay cho việc gỡ. */
  if (opts.includeWeb === false) {
    Reflect.deleteProperty(serverTools, 'web_search');
    Reflect.deleteProperty(serverTools, 'web_fetch');
  }
  if (opts.includeWeather === false) Reflect.deleteProperty(serverTools, 'weather');
  if (opts.includeExchangeRates === false) {
    Reflect.deleteProperty(serverTools, 'exchange_rates');
  }

  return serverTools;
}

/* ------------------------------------------------------------------ */
/* CLIENT TOOLS — agent coding trên trình duyệt                        */
/* ------------------------------------------------------------------ */

/**
 * fs_* tools KHÔNG có execute: AI SDK v4 phát tool-call rồi dừng step, client
 * (useChat onToolCall) thực thi trên File System Access API rồi tự resubmit
 * với kết quả (maxSteps phía useChat). File nằm trong máy user nên server
 * không thể — và không được phép — chạm vào.
 *
 * Chỉ hoạt động trên đường NATIVE function calling. Đường emulated lọc các
 * tool này ra (xem route) vì client-execution protocol của nó khác.
 */
/* ------------------------------------------------------------------ */
/* Manual sinh TỰ ĐỘNG từ schema thật                                  */
/* ------------------------------------------------------------------ */

/**
 * Trước đây danh mục tool được viết tay ở 3 nơi (bảng TOOL_PROTOCOL_LINES,
 * TOOLS_MANUAL trong emulated-agent, chuỗi [Tools] trong route) và đã drift
 * thật — bản emulated thiếu hẳn start_line/line_count của fs_read khiến model
 * luôn đọc full file. Giờ mọi mô tả đều sinh từ CHÍNH object tool đang chạy.
 */

/** Tên kiểu ngắn gọn cho một zod schema, phục vụ dòng `args: {...}`. */
function zodTypeName(schema: unknown): string {
  const def = (schema as { _def?: { typeName?: string; innerType?: unknown; type?: unknown } })?._def;
  switch (def?.typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodArray':
      return `${zodTypeName(def.type)}[]`;
    case 'ZodObject':
      return 'object';
    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodNullable':
      return zodTypeName(def.innerType);
    default:
      return 'any';
  }
}

function isOptionalSchema(schema: unknown): boolean {
  const typeName = (schema as { _def?: { typeName?: string } })?._def?.typeName;
  return typeName === 'ZodOptional' || typeName === 'ZodDefault';
}

/** `{"path": string, "start_line"?: number}` từ schema z.object thật. */
function formatArgsSignature(parameters: unknown): string {
  const def = (parameters as { _def?: { typeName?: string; shape?: () => Record<string, unknown> } })?._def;
  if (def?.typeName !== 'ZodObject' || typeof def.shape !== 'function') return '{}';
  const shape = def.shape();
  const parts = Object.entries(shape).map(
    ([key, value]) => `"${key}"${isOptionalSchema(value) ? '?' : ''}: ${zodTypeName(value)}`,
  );
  return `{${parts.join(', ')}}`;
}

export interface ToolLikeForDocs {
  description?: string;
  parameters?: unknown;
}

/**
 * Registry dùng CHO TÀI LIỆU: chính các object tool sẽ chạy lúc runtime.
 * Server tool dựng một lần với memories giả để memory_search có mặt — chỉ
 * đọc `.description`/`.parameters` nên không chạm mạng.
 */
let docRegistryCache: Record<string, ToolLikeForDocs> | null = null;
function getDocRegistry(): Record<string, ToolLikeForDocs> {
  if (docRegistryCache) return docRegistryCache;
  docRegistryCache = {
    ...(buildAgentTools({
      memories: [{ id: '__doc__', text: '__doc__' }],
    }) as unknown as Record<string, ToolLikeForDocs>),
    ...(CLIENT_TOOL_DEFS as unknown as Record<string, ToolLikeForDocs>),
  };
  return docRegistryCache;
}

export const ALL_TOOL_PROTOCOL_NAMES: readonly string[] = Object.freeze([
  'web_search',
  'web_fetch',
  'weather',
  'exchange_rates',
  'memory_search',
  'memory_save',
  'fs_list',
  'fs_read',
  'fs_search',
  'fs_edit',
  'fs_write',
  'shell_run',
  'git_status',
  'git_diff',
  'git_log',
  'git_add',
  'git_commit',
  'plan_create',
  'plan_update',
  'lesson_save',
]);

/**
 * Render manual ĐẦY ĐỦ (mô tả + chữ ký args) cho các tool khả dụng.
 *
 * CHỈ dùng cho đường EMULATED: ở đó không có kênh tool-call native nên toàn
 * bộ schema phải nằm trong text. Mô tả lấy nguyên văn từ object tool đang
 * chạy nên ràng buộc (provenance của web_fetch, ngưỡng dòng của
 * fs_edit/fs_write...) luôn tới được model.
 *
 * KHÔNG dùng cho đường native: SDK đã gửi name/description/parameters qua
 * trường `tools` của API, chèn thêm manual là trả tiền token hai lần (~960
 * token mỗi request). Đường đó dùng formatToolNameList().
 */
export function formatToolProtocolManual(
  toolNames: Iterable<string>,
  /**
   * Tool không nằm trong registry tĩnh (MCP từ Electron main chẳng hạn) —
   * chúng chỉ tồn tại trong request hiện tại nên không thể cache vào
   * `docRegistryCache`.
   */
  extraRegistry?: Record<string, ToolLikeForDocs>,
): string {
  const registry = extraRegistry
    ? { ...getDocRegistry(), ...extraRegistry }
    : getDocRegistry();
  const lines: string[] = [];
  for (const name of toolNames) {
    const def = registry[name];
    if (!def) continue;
    const description = (def.description ?? '').replace(/\s+/g, ' ').trim();
    lines.push(`- ${name}: ${description} args: ${formatArgsSignature(def.parameters)}`);
  }
  return lines.join('\n');
}

/**
 * Danh sách TÊN tool kèm nhãn cực ngắn — dùng cho đường native, nơi mô tả
 * đầy đủ đã đi qua trường `tools` của API. Chỉ để nhắc model rằng những
 * capability này tồn tại và nên chủ động dùng.
 */
const TOOL_SHORT_LABELS: Record<string, string> = {
  web_search: 'tìm web',
  web_fetch: 'đọc URL',
  weather: 'thời tiết',
  exchange_rates: 'tỷ giá',
  memory_search: 'tra ghi nhớ',
  memory_save: 'lưu ghi nhớ',
  fs_list: 'liệt kê thư mục',
  fs_read: 'đọc file',
  fs_search: 'tìm trong workspace',
  fs_edit: 'sửa file (ưu tiên)',
  fs_write: 'ghi cả file',
  shell_run: 'chạy shell',
  git_status: 'git status',
  git_diff: 'git diff',
  git_log: 'git log',
  git_add: 'git add',
  git_commit: 'git commit',
  plan_create: 'tạo plan',
  plan_update: 'cập nhật plan',
  lesson_save: 'lưu bài học',
};

export function formatToolNameList(toolNames: Iterable<string>): string {
  const parts: string[] = [];
  for (const name of toolNames) {
    const label = TOOL_SHORT_LABELS[name];
    parts.push(label ? `${name} (${label})` : name);
  }
  return parts.join(', ');
}

export const CLIENT_TOOL_DEFS = {
  fs_list: tool({
    description:
      'Liệt kê MỘT cấp thư mục trong workspace của người dùng (trên máy họ). Dùng để khám phá ' +
      'cấu trúc dự án từng bước. Thư mục con sắp trước file.',
    parameters: z.object({
      path: z.string().max(500).optional().describe('Đường dẫn tương đối trong workspace; rỗng = gốc'),
    }),
  }),
  fs_read: tool({
    description:
      'Đọc nội dung một FILE trong workspace của người dùng (trên máy họ). ' +
      'File TEXT (mã nguồn, cấu hình, tài liệu...): trả nội dung, tối đa 24.000 ký tự tính TỪ start_line ' +
      'trở đi; vượt trần thì kết quả có `truncated: true` — đọc tiếp bằng cách gọi lại với start_line lớn hơn. ' +
      'File ẢNH (.png/.jpg/.webp/.heic): trả `description` — bản mô tả chi tiết do model vision của Nhà cung cấp đang bật tạo (qua /api/vision), ' +
      'kèm transcribe nguyên văn mọi chữ trong ảnh; dùng để xem ảnh, screenshot, diagram trong workspace. ' +
      'Định dạng khác (PDF, font, video, file nén) bị từ chối — với PDF/tài liệu hãy bảo người dùng đính kèm vào khung chat. ' +
      'Với file text lớn, nên dùng fs_search để định vị trước rồi đọc quanh vùng đó bằng ' +
      'start_line/line_count thay vì đọc cả file.',
    parameters: z.object({
      path: z.string().min(1).max(500).describe('Đường dẫn tương đối tới file, vd "src/index.ts"'),
      start_line: z.number().int().min(1).max(1_000_000).optional().describe('Dòng bắt đầu, đánh số từ 1; mặc định 1'),
      line_count: z.number().int().min(1).max(2_000).optional().describe('Số dòng cần đọc; mặc định đọc tới trần ký tự'),
    }),
  }),
  fs_search: tool({
    description:
      'Tìm chuỗi hoặc regex trong toàn bộ file text của workspace (bỏ qua node_modules/.git/dist...). ' +
      'Trả tối đa 30 dòng khớp kèm file:dòng.',
    parameters: z.object({
      query: z.string().min(1).max(300).describe('Chuỗi hoặc regex cần tìm'),
      is_regex: z.boolean().optional().describe('Mặc định false — tìm chuỗi thường'),
    }),
  }),
  fs_edit: tool({
    description:
      'Sửa CỤC BỘ một file ĐÃ TỒN TẠI bằng khối SEARCH/REPLACE. Người dùng LUÔN xem diff và PHẢI phê duyệt. ' +
      'BẮT BUỘC gọi fs_read TRƯỚC khi sửa — tool sẽ TỪ CHỐI nếu file chưa được đọc. ' +
      'ĐÂY LÀ LỰA CHỌN MẶC ĐỊNH cho mọi thay đổi trên file đã có — chỉ dùng fs_write khi tạo file mới ' +
      'hoặc khi phải viết lại gần như toàn bộ một file ngắn (dưới ~100 dòng). ' +
      'SEARCH phải khớp NGUYÊN VĂN và DUY NHẤT trong file, copy trực tiếp từ kết quả fs_read. ' +
      'Sửa nhiều chỗ bằng nhiều khối liên tiếp trong một lần gọi. Nếu báo không khớp thì đọc lại file ' +
      'rồi copy nguyên văn, đừng đoán. Nếu bị từ chối, đừng gửi lại y nguyên — hỏi người dùng muốn điều chỉnh gì.',
    parameters: z.object({
      path: z.string().min(1).max(500).describe('Đường dẫn tương đối tới file cần sửa'),
      blocks: z
        .string()
        .min(10)
        .max(100_000)
        .describe(
          'Một hoặc nhiều khối:\n<<<<<<< SEARCH\n(đoạn khớp NGUYÊN VĂN và DUY NHẤT, copy từ fs_read)\n=======\n(nội dung thay thế)\n>>>>>>> REPLACE\nKhông bọc code fence.',
        ),
    }),
  }),
  fs_write: tool({
    description:
      'Ghi TOÀN BỘ nội dung một file trong workspace (ghi đè nếu đã tồn tại). Người dùng LUÔN xem diff ' +
      'và PHẢI phê duyệt. File ĐÃ TỒN TẠI: BẮT BUỘC gọi fs_read TRƯỚC — tool sẽ TỪ CHỐI nếu chưa đọc. ' +
      'File >200 dòng: BỊ CHẶN ghi đè toàn bộ — PHẢI dùng fs_edit để sửa cục bộ thay vì ghi đè cả file lớn. ' +
      'CHỈ dùng khi: (a) tạo file MỚI, hoặc (b) viết lại gần như toàn bộ một file ' +
      'ngắn dưới ~100 dòng. Với file đã tồn tại và dài hơn thế, PHẢI dùng fs_edit — ghi đè cả file lớn ' +
      'dễ làm mất nội dung bạn chưa đọc tới. Nếu bị từ chối, đừng gửi lại y nguyên — hỏi người dùng muốn điều chỉnh gì.',
    parameters: z.object({
      path: z.string().min(1).max(500).describe('Đường dẫn tương đối tới file cần ghi'),
      content: z.string().max(100_000).describe('Toàn bộ nội dung file sau khi ghi'),
    }),
  }),
  // ── Desktop-only tools (chỉ chạy khi window.vyen.desktop === true) ──
  // Trên web thuần các tool này không có mặt — route lọc theo CLIENT_TOOL_NAMES
  // và chat-interface trả lỗi mạch lạc nếu thiếu bridge.
  shell_run: tool({
    description:
      'Chạy LỆNH SHELL trong workspace của người dùng (CHỈ trong Vyen desktop). Dùng để build/test/lint/chạy script. ' +
      'Người dùng LUÔN xem lệnh và PHẢI phê duyệt trước khi chạy. Lệnh chạy qua cmd.exe / sh, timeout mặc định 120s. ' +
      'OUTPUT TRUNCATION (Goose-style): output vượt 2000 dòng hoặc 50KB sẽ bị cắt, giữ phần CUỐI (chứa lỗi/thông báo quan trọng). ' +
      'Full output được lưu vào temp file, kết quả có savedTo (đường dẫn) và previewHint (hướng dẫn đọc tiếp). ' +
      'Khi thấy truncated: true, đọc full output bằng fs_read với path = savedTo ' +
      '(temp file do Vyen tự ghi — NGOẠI LỆ duy nhất fs_read đọc được ngoài workspace; dùng start_line/line_count để phân trang) ' +
      'hoặc chạy lệnh trong previewHint. ' +
      'AUTO-DEBUG: khi lệnh test/build/lint thất bại, kết quả kèm retryGuidance hướng dẫn sửa và chạy lại. ' +
      'KHÔNG dùng để đọc/ghi file → dùng fs_* cho việc đó. Trên web thuần tool này sẽ báo lỗi.',
    parameters: z.object({
      command: z.string().min(1).max(4000).describe('Lệnh shell, vd "npm test" hoặc "npm run build"'),
      cwd: z.string().max(500).optional().describe('Thư mục làm việc tương đối trong workspace, mặc định gốc'),
      timeout_secs: z.number().int().min(1).max(600).optional().describe('Timeout giây (mặc định 120, tối đa 600)'),
    }),
  }),
  git_status: tool({
    description: 'Xem trạng thái git của workspace (CHỈ trong Vyen desktop). Trả branch + danh sách file staged/unstaged.',
    parameters: z.object({}),
  }),
  git_diff: tool({
    description: 'Xem diff git của workspace (CHỈ trong Vyen desktop). Mặc định diff unstaged; staged=true để xem staged.',
    parameters: z.object({
      path: z.string().max(500).optional().describe('Đường dẫn tương đối cần diff; bỏ trống = toàn workspace'),
      staged: z.boolean().optional().describe('True = diff staged (git diff --cached)'),
    }),
  }),
  git_log: tool({
    description: 'Xem lịch sử commit git (CHỈ trong Vyen desktop).',
    parameters: z.object({
      limit: z.number().int().min(1).max(100).optional().describe('Số commit, mặc định 20'),
    }),
  }),
  git_add: tool({
    description:
      'Stage file vào git index (CHỈ trong Vyen desktop). Người dùng KHÔNG cần phê duyệt riêng — git_add an toàn. ' +
      'Chỉ stage đường dẫn người dùng đã thấy qua fs_* trước đó.',
    parameters: z.object({
      paths: z.array(z.string().min(1).max(500)).min(1).max(20).describe('Danh sách đường dẫn tương đối cần stage, vd ["src/index.ts"]'),
    }),
  }),
  git_commit: tool({
    description: 'Tạo commit git (CHỈ trong Vyen desktop). Người dùng PHẢI phê duyệt message trước khi commit.',
    parameters: z.object({
      message: z.string().min(1).max(2000).describe('Commit message'),
    }),
  }),

  /* ------------------------------------------------------------------ */
  /* Sub-task Plan — phân rã task phức tạp thành subtask trackable        */
  /* ------------------------------------------------------------------ */

  plan_create: tool({
    description:
      'Tạo PLAN phân rã task phức tạp thành các subtask nhỏ hơn. Dùng khi nhận task lớn ' +
      '(nhiều file, nhiều bước, refactor toàn bộ...). Mỗi subtask có title, mô tả ngắn, ' +
      'và danh sách file liên quan. Plan giúp bạn và người dùng theo dõi tiến độ. ' +
      'Sau khi tạo plan, bắt đầu làm từng subtask và gọi plan_update để cập nhật trạng thái.',
    parameters: z.object({
      title: z.string().min(1).max(200).describe('Tên plan, vd "Refactor auth module"'),
      subtasks: z
        .array(
          z.object({
            title: z.string().min(1).max(200),
            description: z.string().max(500).optional(),
            files: z.array(z.string().max(500)).max(10).optional(),
          }),
        )
        .min(1)
        .max(20)
        .describe('Danh sách subtask, mỗi cái có title + mô tả ngắn + file liên quan'),
    }),
  }),

  plan_update: tool({
    description:
      'Cập nhật trạng thái một subtask trong plan hiện tại. Gọi SAU KHI hoàn thành hoặc thất bại ' +
      'một subtask. Status: "in_progress" (đang làm), "done" (xong), "failed" (thất bại), "skipped" (bỏ qua).',
    parameters: z.object({
      subtaskId: z.string().min(1).max(20).describe('ID subtask, vd "st-1", "st-2"'),
      status: z.enum(['in_progress', 'done', 'failed', 'skipped']).describe('Trạng thái mới'),
    }),
  }),

  /* ------------------------------------------------------------------ */
  /* Self-Improvement Lessons — lưu bài học từ các phiên trước           */
  /* ------------------------------------------------------------------ */

  lesson_save: tool({
    description:
      'Lưu BÀI HỌC từ kinh nghiệm coding để các phiên sau không lặp lại lỗi. ' +
      'Category: "rule" (quy tắc luôn tuân theo), "pattern" (cách làm hiệu quả), ' +
      '"gotcha" (lỗi/thứ cần tránh). Gọi khi: sửa xong bug khó, phát hiện pattern tốt, ' +
      'hoặc nhận ra gotcha. Text ngắn gọn, actionable, tối đa 400 ký tự.',
    parameters: z.object({
      category: z.enum(['rule', 'pattern', 'gotcha']).describe('Loại bài học'),
      text: z.string().min(5).max(400).describe('Nội dung bài học, vd "Luôn chạy tsc --noEmit trước khi commit TypeScript"'),
    }),
  }),
  /* ------------------------------------------------------------------ */
  /* Subagent Delegation — Goose-style task delegation to isolated worker     */
  /* ------------------------------------------------------------------ */

  delegate: tool({
    description:
      'GIAO TASK cho SUBAGENT độc lập (Goose-style). Subagent chạy với context RIÊNG (không thấy lịch sử chat), ' +
      'có tools giống bạn nhưng KHÔNG thể gọ delegate (không đế quy). Dùng khi: task độc lập cần ' +
      'nhiều bước tool (refactor file, research codebase, chạy test suite...). Max turns mặc định 10, tối đa 25. ' +
      'Chạy NHIỀU TASK SONG SONG: truyền `tasks` (1-4 task, tối đa 3 chạy cùng lúc) thay vì instructions — ' +
      'kết quả trả về theo mảng đúng thứ tự. mode "scout" = chỉ đọc (không fs_write/fs_edit/shell_run) ' +
      'dùng cho research/recon; mode "worker" = đầy đủ (mặc định). context "brief" = kèm tóm tắt bối cảnh ' +
      'hội thoại cha cho subagent (dùng khi task cần hiểu bối cảnh trước đó). Subagent trả kết quả tóm tắt khi xong.',
    parameters: z.object({
      instructions: z
        .string()
        .min(10)
        .max(5000)
        .optional()
        .describe('Mô tả task chi tiết cho subagent (KHÔNG truyền cùng lúc với tasks)'),
      tasks: z
        .array(
          z.object({
            instructions: z.string().min(10).max(5000).describe('Mô tả task chi tiết'),
            max_turns: z.number().int().min(1).max(25).optional(),
            timeout_secs: z.number().int().min(30).max(600).optional(),
            mode: z.enum(['scout', 'worker']).optional(),
          }),
        )
        .min(1)
        .max(4)
        .optional()
        .describe('1-4 task chạy SONG SONG (tối đa 3 cùng lúc). Khi dùng, KHÔNG truyền instructions'),
      max_turns: z
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .describe('Số turns tối đa (mặc định 10, max 25). Áp cho mọi task nếu task không tự đè'),
      timeout_secs: z
        .number()
        .int()
        .min(30)
        .max(600)
        .optional()
        .describe('Timeout giây (mặc định 300, max 600). Áp cho mọi task nếu task không tự đè'),
      mode: z
        .enum(['scout', 'worker'])
        .optional()
        .describe('scout = chỉ đọc (recon/research), worker = đầy đủ. Mặc định worker'),
      context: z
        .enum(['fresh', 'brief'])
        .optional()
        .describe("brief = kèm tóm tắt bối cảnh phiên cha; mặc định 'fresh'"),
    }),
  }),
} as const;

export type ClientToolSet = typeof CLIENT_TOOL_DEFS;

/** Tên các tool chạy phía client — route dùng để quyết forward part. */
export const CLIENT_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(CLIENT_TOOL_DEFS));

/**
 * Tool client KHÔNG được khai báo TRỰC TIẾP ở đường NATIVE (function calling
 * gốc).
 *
 * `delegate` không có execute phía client — renderer không tự chạy được
 * subagent (thiếu model + khoá). Ở native, ROUTE cung cấp một bản SERVER của
 * delegate (tool() với execute → executeDelegate, xem app/api/chat/route.ts
 * + lib/subagent.ts). Set này đảm bảo def CLIENT không bị spread đè lên bản
 * server đó; đường emulated vẫn dùng def client vì loop emulated xử lý
 * delegate qua onDelegateCall.
 */
export const NATIVE_EXCLUDED_CLIENT_TOOLS: ReadonlySet<string> = new Set(['delegate']);

/* ------------------------------------------------------------------ */
/* Validate đề xuất ghi nhớ — thuần, test được                         */
/* ------------------------------------------------------------------ */

export interface MemoryVerdict {
  ok: boolean;
  /** Text đã chuẩn hóa khi ok. */
  text?: string;
  reason?: string;
}

/** Trần ký tự mỗi đề xuất — khớp MAX_MEMORY_CHARS ở db.ts. */
const MEMORY_TEXT_CHARS = 400;

export function validateMemoryProposal(
  rawText: string,
  existingMemories: MemoryItem[],
): MemoryVerdict {
  const text = (rawText ?? '').replace(/\s+/g, ' ').trim().slice(0, MEMORY_TEXT_CHARS);
  if (text.length < 4) {
    return { ok: false, reason: 'Ghi nhớ quá ngắn/không có nội dung.' };
  }
  // Không cho nội dung web/injection chui vào kho dài hạn — đây là dữ liệu
  // sống sót qua nhiều phiên nên phải sạch hơn mọi nơi khác.
  if (judgeInjection(text) === 'block') {
    return { ok: false, reason: 'Nội dung chứa mẫu prompt-injection nên bị từ chối.' };
  }
  if (existingMemories.some((m) => m.text === text)) {
    return { ok: false, reason: 'Ghi nhớ này đã tồn tại.' };
  }
  return { ok: true, text };
}
