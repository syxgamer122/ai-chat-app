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
}

/** Trần số lần gọi tool MỌI LOẠI trong một lượt chat. */
export const MAX_TOOL_CALLS_PER_TURN = 8;

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
  switch (name) {
    case 'web_search':
      return String(a.query ?? '').slice(0, 80);
    case 'web_fetch':
      return shortenUrl(String(a.url ?? ''));
    case 'weather':
      return String(a.location ?? '').slice(0, 60);
    case 'memory_search':
      return String(a.query ?? '').slice(0, 60);
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
    default:
      return typeof r.note === 'string' ? r.note.slice(0, 80) : '';
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

  // Trạng thái theo LƯỢT GỢI (mỗi request tạo bộ tool mới): log chống lặp +
  // tập host hợp lệ cho provenance. Không state toàn cục để hai request song
  // song không ảnh hưởng nhau.
  const callCounts = new Map<string, number>();
  let totalCalls = 0;
  const knownHosts = new Set<string>();
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
    totalCalls += 1;
    if (totalCalls > MAX_TOOL_CALLS_PER_TURN) {
      return {
        ...errorFallback,
        note:
          'Đã đạt giới hạn số lần gọi công cụ của lượt này. Hãy tổng hợp câu trả lời từ dữ liệu đã có.',
      };
    }
    const key = stableKey(name, args);
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
      return await run();
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
        'Chỉ đọc được trang tĩnh — không đăng nhập, không click. Chỉ dùng URL xuất hiện trong ' +
        'kết quả web_search hoặc do người dùng cung cấp.',
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
        'Tỷ giá hằng ngày của USD/VNĐ/EUR/JPY và các đồng phổ biến khác. Dùng khi hỏi tỷ giá, ' +
        'quy đổi tiền tệ. Không nhận tham số.',
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
              'Tra cứu GHI NHỚ DÀI HẠN của người dùng (sở thích, thông tin cá nhân, quy ước làm việc ' +
              'họ từng yêu cầu lưu). Gọi khi câu hỏi có thể liên quan đến thông tin đã biết về người dùng.',
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

  // Những capability đã có dữ liệu đáng tin cậy trong prompt của CHÍNH lượt
  // này không cần xuất hiện thêm trong catalog tool. Vẫn giữ implementation để
  // dùng làm fallback khi prefetch thất bại hoặc không được bật.
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
/**
 * Emulated Agent cần schema ở dạng text; native function-calling không cần
 * block này. Giữ mô tả ở cạnh registry tool để không drift với runtime.
 */
const TOOL_PROTOCOL_LINES: Record<string, readonly string[]> = {
  web_search: [
    '- web_search: tìm thông tin hiện tại trên web. args: {"query": string, "count"?: number}',
  ],
  web_fetch: [
    '- web_fetch: đọc URL public do người dùng cung cấp hoặc xuất hiện từ web_search. args: {"url": string}',
  ],
  weather: ['- weather: thời tiết theo nơi. args: {"location": string, vd "Hà Nội"}'],
  exchange_rates: ['- exchange_rates: tỷ giá hôm nay. args: {}'],
  memory_search: ['- memory_search: tra ghi nhớ dài hạn. args: {"query": string}'],
  memory_save: [
    '- memory_save: chỉ lưu fact dài hạn khi người dùng yêu cầu nhớ rõ ràng. args: {"text": string}',
  ],
  fs_list: ['- fs_list: liệt kê MỘT cấp thư mục workspace. args: {"path"?: string}'],
  fs_read: [
    '- fs_read: đọc file text. args: {"path": string, "start_line"?: number, "line_count"?: number}',
  ],
  fs_search: ['- fs_search: tìm chuỗi hoặc regex trong workspace. args: {"query": string, "is_regex"?: boolean}'],
  fs_edit: [
    '- fs_edit: sửa cục bộ file bằng khối SEARCH/REPLACE; ưa hơn fs_write với file lớn. args: {"path": string, "blocks": string}',
  ],
  fs_write: [
    '- fs_write: tạo mới hoặc ghi toàn bộ file; người dùng luôn duyệt diff. args: {"path": string, "content": string}',
  ],
};

export const ALL_TOOL_PROTOCOL_NAMES = Object.freeze(Object.keys(TOOL_PROTOCOL_LINES));

/** Chỉ render tool thực sự khả dụng trong request hiện tại. */
export function formatToolProtocolManual(toolNames: Iterable<string>): string {
  const lines: string[] = [];
  for (const name of toolNames) lines.push(...(TOOL_PROTOCOL_LINES[name] ?? []));
  return lines.join('\n');
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
      'Đọc nội dung một FILE text trong workspace (mã nguồn, cấu hình, tài liệu...). Trần ~24k ký tự, ' +
      'dài hơn sẽ báo truncated — dùng start_line/line_count để đọc phần cần thiết.',
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
      'Sửa CỤC BỘ một file trong workspace bằng khối SEARCH/REPLACE. Người dùng LUÔN xem diff và PHẢI phê duyệt. ' +
      'Ưu tiên tool này cho file lớn hoặc chỉ cần thay vài đoạn; SEARCH phải khớp nguyên văn, duy nhất, và copy từ fs_read. ' +
      'Sửa nhiều chỗ bằng nhiều khối liên tiếp; nếu không tìm thấy thì đọc lại file rồi copy nguyên văn. ' +
      'Nếu bị từ chối, đừng gửi lại y nguyên — hỏi người dùng muốn điều chỉnh gì.',
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
      'Tạo mới hoặc ghi toàn bộ một file trong workspace. Người dùng LUÔN xem diff và PHẢI phê duyệt. ' +
      'Dùng cho file mới, file nhỏ, hoặc tái cấu trúc lớn khi fs_edit không phù hợp. ' +
      'Nếu bị từ chối, đừng gửi lại y nguyên — hỏi người dùng muốn điều chỉnh gì.',
    parameters: z.object({
      path: z.string().min(1).max(500).describe('Đường dẫn tương đối tới file cần ghi'),
      content: z.string().max(100_000).describe('Toàn bộ nội dung file sau khi ghi'),
    }),
  }),
} as const;

export type ClientToolSet = typeof CLIENT_TOOL_DEFS;

/** Tên các tool chạy phía client — route dùng để quyết forward part. */
export const CLIENT_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(CLIENT_TOOL_DEFS));

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
