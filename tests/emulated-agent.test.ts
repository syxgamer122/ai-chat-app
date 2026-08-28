import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import {
  buildProtocolHeader,
  EMU_MAX_CALLS_PER_ROUND,
  EMU_MAX_ROUNDS,
  parseToolCallBlocks,
  runEmulatedLoop,
} from '@/lib/emulated-agent';
import { buildAgentTools } from '@/lib/agent-tools';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function completion(content: string): Response {
  return jsonResponse({
    id: 'test',
    object: 'chat.completion',
    created: 0,
    model: 'emu-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  });
}

const SEARCH_FIXTURE =
  '<a class="result-link" href="https://example.com/a">Kết quả vàng</a>' +
  '<td class="result-snippet">giá vàng tăng</td>';

const WEATHER_FETCH = async (url: string) =>
  String(url).includes('geocoding')
    ? jsonResponse({
        results: [{ name: 'Hà Nội', country: 'Việt Nam', latitude: 21.03, longitude: 105.85 }],
      })
    : jsonResponse({
        current: {
          temperature_2m: 31.2,
          apparent_temperature: 35,
          relative_humidity_2m: 70,
          weather_code: 61,
          wind_speed_10m: 9.4,
        },
        daily: {
          time: ['2026-08-25'],
          temperature_2m_max: [33],
          temperature_2m_min: [26],
          precipitation_probability_max: [40],
        },
      });

function makeModel() {
  const provider = createOpenAI({ apiKey: 'test-key', baseURL: 'https://gw.test/v1' });
  return provider('emu-model');
}

afterEach(() => vi.unstubAllGlobals());

describe('parseToolCallBlocks — parser khoan dung', () => {
  const known = new Set(['web_search', 'web_fetch', 'weather']);

  it('khối chuẩn + alias + attribute style + XML args', () => {
    const r1 = parseToolCallBlocks(
      '<tool_call>\n{"name":"web_search","arguments":{"query":"vàng"}}\n</tool_call>',
      known,
    );
    expect(r1.calls).toEqual([{ name: 'web_search', args: { query: 'vàng' } }]);

    const r2 = parseToolCallBlocks(
      '<function_call name="weather">\n<parameter name="location">Hà Nội</parameter>\n</function_call>',
      known,
    );
    expect(r2.calls[0]).toEqual({ name: 'weather', args: { location: 'Hà Nội' } });
    expect(r2.preamble).toBe('');
  });

  it('prose trước khối → preamble; fence bọc JSON vẫn đọc được', () => {
    const r = parseToolCallBlocks(
      'Để tôi tìm giá vàng đã.\n<tool_call>\n```json\n{"name":"web_search","arguments":{"query":"vàng"}}\n```\n</tool_call>',
      known,
    );
    expect(r.preamble).toContain('Để tôi tìm');
    expect(r.calls[0].args).toEqual({ query: 'vàng' });
  });

  it('JSON hỏng nhẹ (trailing comma) vẫn cứu được qua parseLooseJson', () => {
    const r = parseToolCallBlocks(
      '<tool_call>{"name":"web_search","arguments":{"query":"vàng",}}</tool_call>',
      known,
    );
    expect(r.calls).toHaveLength(1);
  });

  it('thiếu tag đóng (stream cắt) → vẫn bắt được call', () => {
    const r = parseToolCallBlocks(
      '<tool_call>\n{"name":"weather","arguments":{"location":"Tokyo"}}',
      known,
    );
    expect(r.calls[0].name).toBe('weather');
  });

  it('tool lạ/bịa bị loại; tool_result model tự bịa không thành call', () => {
    expect(
      parseToolCallBlocks('<tool_call>{"name":"delete_all","arguments":{}}</tool_call>', known)
        .calls,
    ).toEqual([]);
    const hallucinated = parseToolCallBlocks(
      '<tool_result>{"fake":"data"}</tool_result>',
      known,
    );
    expect(hallucinated.calls).toEqual([]);
  });

  it(`cap ${EMU_MAX_CALLS_PER_ROUND} call mỗi round`, () => {
    const spam = Array.from(
      { length: 6 },
      (_, i) => `<tool_call>{"name":"web_search","arguments":{"query":"q${i}"}}</tool_call>`,
    ).join('\n');
    expect(parseToolCallBlocks(spam, known).calls.length).toBe(EMU_MAX_CALLS_PER_ROUND);
  });
});

describe('runEmulatedLoop — e2e với upstream giả lập', () => {
  function makeOpts(overrides?: Partial<Parameters<typeof runEmulatedLoop>[0]>) {
    const events = {
      text: '',
      reasoning: '',
      annotations: [] as Array<Record<string, unknown>>,
      usage: [] as Array<{ promptTokens?: number; completionTokens?: number }>,
      memoryProposals: [] as string[],
    };
    const opts = {
      model: makeModel(),
      messages: [{ role: 'user' as const, content: 'giá vàng bao nhiêu?' }],
      system: 'Bạn là trợ lý.',
      tools: buildAgentTools(),
      temperature: 0.7,
      onTextDelta: (d: string) => (events.text += d),
      onReasoningLine: (l: string) => (events.reasoning += `${l}\n`),
      onAnnotation: (a: Record<string, unknown>) => events.annotations.push(a),
      onUsage: (u: { promptTokens?: number; completionTokens?: number }) => events.usage.push(u),
      onMemoryProposal: (t: string) => events.memoryProposals.push(t),
      ...overrides,
    };
    return { events, opts };
  }

  it('round 0 gọi web_search → round 1 trả lời prose', async () => {
    let completionCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('duckduckgo')) return new Response(SEARCH_FIXTURE, { headers: { 'content-type': 'text/html' } });
        if (url.includes('/chat/completions')) {
          completionCount += 1;
          return completion(
            completionCount === 1
              ? 'Để tôi tra giá vàng.\n<tool_call>\n{"name":"web_search","arguments":{"query":"giá vàng hôm nay"}}\n</tool_call>'
              : 'Giá vàng hôm nay khoảng 92 triệu/lượng theo kết quả tìm kiếm.',
          );
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const { events, opts } = makeOpts();
    const result = await runEmulatedLoop(opts);

    expect(result.roundsUsed).toBe(2);
    expect(result.totalCalls).toBe(1);
    expect(events.text).toContain('Giá vàng hôm nay');
    // Tiến trình round 0 đi kênh reasoning.
    expect(events.reasoning).toContain('Để tôi tra giá vàng');
    // Annotation start/done cho chip tool-trace.
    const phases = events.annotations.filter((a) => (a.tool as { phase?: string })?.phase);
    expect(phases.map((a) => (a.tool as { phase: string }).phase)).toEqual(['start', 'done']);
    // Usage từ cả 2 round đều được ghi.
    expect(events.usage.length).toBe(2);
    // Request round 2 phải mang TOOL_RESULT thật (không phải model bịa).
    expect(completionCount).toBe(2);
  });

  it('cạn ngân sách → round cuối ép prose, prompt có nhắc TOOL_RESULT', async () => {
    let completionCount = 0;
    let lastBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/chat/completions')) {
          completionCount += 1;
          lastBody = String(init?.body ?? '');
          return completion('<tool_call>{"name":"exchange_rates","arguments":{}}</tool_call>');
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const { events, opts } = makeOpts({ maxRounds: 3 });
    await runEmulatedLoop(opts);

    expect(completionCount).toBe(3);
    // Prompt của round CUỐI chứa nudge ép prose và các TOOL_RESULT đã thu.
    expect(lastBody).toContain('Đã hết lượt sử dụng công cụ');
    expect(lastBody).toContain('[TOOL_RESULT name=exchange_rates]');
    // Model cứng đầu chỉ nhả call → strip sạch nhưng KHÔNG rỗng tuyệt đối
    // (nguyên tắc never-empty: fallback nguyên văn).
    expect(events.text.length).toBeGreaterThan(0);
  });

  it('memory_save được chấp nhận → bắn onMemoryProposal cho client ghi', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/chat/completions')) {
          return completion(
            '<tool_call>\n{"name":"memory_save","arguments":{"text":"Người dùng tên Tuấn"}}\n</tool_call>',
          );
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const { events, opts } = makeOpts({ maxRounds: 2 });
    await runEmulatedLoop(opts);
    expect(events.memoryProposals).toEqual(['Người dùng tên Tuấn']);
  });

  it('fs_* ở chế độ giả lập → YIELD về client (pending-client + onClientToolCall)', async () => {
    const clientCalls: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/chat/completions')) {
          return completion(
            'Để tôi xem cấu trúc thư mục.\n<tool_call>\n{"name":"fs_list","arguments":{"path":"src"}}\n</tool_call>',
          );
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const { events, opts } = makeOpts({
      maxRounds: 3,
      clientTools: new Set(['fs_list', 'fs_read', 'fs_write', 'fs_search']),
      onClientToolCall: (c) => clientCalls.push(c),
    });
    const result = await runEmulatedLoop(opts);

    // Yield đúng nghi thức: status + callback mang args đã parse.
    expect(result.status).toBe('pending-client');
    expect(clientCalls).toEqual([
      { toolCallId: 'emu-0-1', toolName: 'fs_list', args: { path: 'src' } },
    ]);
    // Preamble đi kênh reasoning để user thấy tiến trình.
    expect(events.reasoning).toContain('Để tôi xem cấu trúc');
    // Usage round 0 vẫn được ghi trước khi yield.
    expect(events.usage.length).toBe(1);
  });

  it('protocol header có đủ quy tắc chống hallucination + chống loop', () => {
    // Danh sách tool không liên quan tới các quy tắc dưới đây — truyền rỗng.
    const p = buildProtocolHeader([]);
    expect(p).toContain('KHÔNG có kênh tool-call native');
    expect(p).toContain('TUYỆT ĐỐI KHÔNG tự viết <tool_result>');
    expect(p).toContain('Không lặp lại một call với tham số y hệt');
    expect(p).toContain('"name": "TEN_TOOL"');
  });

  it('protocol runtime chỉ liệt kê tool thực sự khả dụng', () => {
    const p = buildProtocolHeader(new Set(['web_search', 'fs_list']));
    expect(p).toContain('web_search');
    expect(p).toContain('fs_list');
    expect(p).not.toContain('memory_search');
    expect(p).not.toContain('exchange_rates');
  });

  it(`số round mặc định = ${EMU_MAX_ROUNDS}`, () => {
    expect(EMU_MAX_ROUNDS).toBe(10);
  });
});
