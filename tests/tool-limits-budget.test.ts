/**
 * Bảo vệ các sửa lỗi kiểm toán kiến trúc tool:
 *  - ngân sách gọi tool sống XUYÊN request (chống vòng lặp qua resubmit fs_*)
 *  - manual sinh từ schema thật (chống drift 3-nguồn-sự-thật)
 *  - trần kết quả tool áp cho CẢ hai đường native/emulated
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAgentTools,
  formatToolNameList,
  formatToolProtocolManual,
  ALL_TOOL_PROTOCOL_NAMES,
} from '@/lib/agent-tools';
import {
  __clearAllToolCallBudgets,
  getToolCallBudget,
  resetToolCallBudget,
  checkDoomLoop,
} from '@/lib/tool-call-budget';
import {
  MAX_TOOL_CALLS_PER_TURN,
  DOOM_LOOP_THRESHOLD,
  TOOL_RESULT_MAX_CHARS,
  serializeToolResult,
  truncateToolResult,
} from '@/lib/tool-limits';

beforeEach(() => __clearAllToolCallBudgets());
afterEach(() => {
  vi.unstubAllGlobals();
  __clearAllToolCallBudgets();
});

describe('ngân sách gọi tool sống xuyên request', () => {
  it('dedupe CHẶN gọi trùng ở request thứ hai của cùng hội thoại', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<a class="result-link" href="https://e.com/a">T</a>', {
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    // Request 1 — bộ tool mới, gọi lần đầu: chạy thật.
    const first = await buildAgentTools({ conversationId: 'chat-1' }).web_search.execute!(
      { query: 'tin mới' },
      {} as never,
    );
    expect((first as any).results.length).toBeGreaterThan(0);

    /* Request 2 = resubmit sau khi client chạy fs_* → buildAgentTools() được
       gọi LẠI. Trước khi sửa, closure reset nên call trùng chạy lại từ đầu. */
    const second = await buildAgentTools({ conversationId: 'chat-1' }).web_search.execute!(
      { query: 'tin mới' },
      {} as never,
    );
    expect((second as any).note).toMatch(/đã gọi công cụ này rồi/i);
  });

  it('hội thoại KHÁC nhau không ảnh hưởng ngân sách của nhau', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<a class="result-link" href="https://e.com/a">T</a>', {
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    await buildAgentTools({ conversationId: 'A' }).web_search.execute!({ query: 'q' }, {} as never);
    const other = await buildAgentTools({ conversationId: 'B' }).web_search.execute!(
      { query: 'q' },
      {} as never,
    );
    expect((other as any).results.length).toBeGreaterThan(0);
  });

  it('trần tổng call tính DỒN qua các request, không reset mỗi request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN; i++) {
      await buildAgentTools({ conversationId: 'burn' }).weather.execute!(
        { location: `nơi-${i}` },
        {} as never,
      );
    }
    const overflow = await buildAgentTools({ conversationId: 'burn' }).weather.execute!(
      { location: 'nơi-cuối' },
      {} as never,
    );
    expect((overflow as any).note).toMatch(/giới hạn số lần gọi/i);
  });

  it('lượt người dùng MỚI reset trần nhưng GIỮ provenance host', () => {
    const bucket = getToolCallBudget('c1');
    bucket.totalCalls = 7;
    bucket.callCounts.set('web_search:{}', 1);
    bucket.knownHosts.add('example.com');

    resetToolCallBudget('c1');

    const after = getToolCallBudget('c1');
    expect(after.totalCalls).toBe(0);
    expect(after.callCounts.size).toBe(0);
    // URL người dùng dán ở lượt trước vẫn hợp lệ cho web_fetch lượt sau.
    expect(after.knownHosts.has('example.com')).toBe(true);
    // Lịch sử doom-loop cũng được dọn — lượt mới không bị oan từ lượt cũ.
    expect(after.recentSignatures.length).toBe(0);
  });

  it('không có conversationId → bucket dùng-một-lần (hành vi cũ, không rò rỉ)', () => {
    const a = getToolCallBudget(undefined);
    a.totalCalls = 5;
    expect(getToolCallBudget(undefined).totalCalls).toBe(0);
  });
});

describe('provenance tích lũy qua các lượt', () => {
  it('host từ web_search lượt trước vẫn cho phép web_fetch ở request sau', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('duck') || String(url).includes('search')
          ? new Response('<a class="result-link" href="https://trusted.com/a">T</a>', {
              headers: { 'content-type': 'text/html' },
            })
          : new Response('<html><body><article>Nội dung trang đủ dài để trích xuất.</article></body></html>', {
              headers: { 'content-type': 'text/html' },
            }),
      ),
    );

    await buildAgentTools({ conversationId: 'prov' }).web_search.execute!(
      { query: 'x' },
      {} as never,
    );

    // Request MỚI: trước khi sửa, knownHosts rỗng → bị từ chối oan.
    const fetched = await buildAgentTools({ conversationId: 'prov' }).web_fetch.execute!(
      { url: 'https://trusted.com/a' },
      {} as never,
    );
    expect((fetched as any).blocked).toBeUndefined();
  });

  it('host lạ vẫn bị chặn (guard không bị nới lỏng)', async () => {
    const out = await buildAgentTools({ conversationId: 'prov2' }).web_fetch.execute!(
      { url: 'https://evil.example/page' },
      {} as never,
    );
    expect((out as any).blocked).toBe('provenance');
  });
});

describe('manual sinh từ schema thật — chống drift', () => {
  it('fs_read có start_line/line_count (bản viết tay cũ thiếu)', () => {
    const manual = formatToolProtocolManual(['fs_read']);
    expect(manual).toContain('start_line');
    expect(manual).toContain('line_count');
  });

  it('chữ ký args phản ánh optional bằng dấu ?', () => {
    const manual = formatToolProtocolManual(['fs_search']);
    expect(manual).toContain('"query": string');
    expect(manual).toContain('"is_regex"?: boolean');
  });

  it('ràng buộc provenance của web_fetch tới được model emulated', () => {
    expect(formatToolProtocolManual(['web_fetch'])).toMatch(/BỊ TỪ CHỐI/);
  });

  it('chỉ render tool được yêu cầu, không rò tool khác', () => {
    const manual = formatToolProtocolManual(['web_search']);
    expect(manual).toContain('web_search');
    expect(manual).not.toContain('fs_write');
    expect(manual).not.toContain('memory_save');
  });

  it('mọi tool trong ALL_TOOL_PROTOCOL_NAMES đều render được (không sót tên)', () => {
    const manual = formatToolProtocolManual(ALL_TOOL_PROTOCOL_NAMES);
    for (const name of ALL_TOOL_PROTOCOL_NAMES) {
      expect(manual).toContain(`- ${name}:`);
    }
  });

  it('danh sách ngắn cho native rẻ hơn manual đầy đủ nhiều lần', () => {
    const short = formatToolNameList(ALL_TOOL_PROTOCOL_NAMES);
    const full = formatToolProtocolManual(ALL_TOOL_PROTOCOL_NAMES);
    expect(short.length * 5).toBeLessThan(full.length);
    expect(short).toContain('fs_edit');
  });
});

describe('trần kết quả tool', () => {
  it('truncateToolResult giữ đầu và đuôi, bỏ ruột', () => {
    const raw = `${'A'.repeat(20_000)}${'B'.repeat(20_000)}`;
    const out = truncateToolResult(raw, 1_000);
    expect(out.length).toBeLessThan(raw.length);
    expect(out.startsWith('A')).toBe(true);
    expect(out.endsWith('B')).toBe(true);
    expect(out).toMatch(/đã cắt bớt/);
  });

  it('kết quả nhỏ đi qua nguyên vẹn', () => {
    expect(truncateToolResult('{"ok":true}', 1_000)).toBe('{"ok":true}');
  });

  it('serializeToolResult không ném với giá trị vòng tròn', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializeToolResult(circular)).not.toThrow();
  });

  it('web_fetch nội dung khổng lồ bị cắt nhưng GIỮ shape (url/title còn nguyên)', async () => {
    const huge = 'x'.repeat(TOOL_RESULT_MAX_CHARS * 2);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(`<html><body><article>${huge}</article></body></html>`, {
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    const tools = buildAgentTools({
      conversationId: 'big',
      allowedHosts: ['https://ok.com/'],
    });
    const out = (await tools.web_fetch.execute!(
      { url: 'https://ok.com/page' },
      {} as never,
    )) as Record<string, unknown>;

    expect(JSON.stringify(out).length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + 500);
    expect(typeof out.url).toBe('string');
  });
});

/**
 * Doom-loop detector (port doom_loop.rs của evot) — bắt chuỗi lặp LIÊN TIẾP
 * của cùng một call mà dedupe thuần không chặn được. Dedupe chặn call trùng
 * THỨ HAI bằng note nhẹ; doom-loop can thiệp từ lần thứ ba trở lên bằng
 * steering message mạnh hơn buộc model đổi hướng.
 */
describe('doom-loop detector', () => {
  it('call đầu tiên → không trigger, signature được ghi', () => {
    const bucket = getToolCallBudget('dl-1');
    const result = checkDoomLoop(bucket, 'web_search:{"query":"a"}');
    expect(result.triggered).toBe(false);
    expect(result.counted).toBe(1);
    expect(bucket.recentSignatures).toEqual(['web_search:{"query":"a"}']);
  });

  it(`lặp ${DOOM_LOOP_THRESHOLD} lần liên tiếp → trigger`, () => {
    const bucket = getToolCallBudget('dl-2');
    const sig = 'web_search:{"query":"x"}';
    for (let i = 0; i < DOOM_LOOP_THRESHOLD - 1; i++) {
      const r = checkDoomLoop(bucket, sig);
      expect(r.triggered).toBe(false);
    }
    const triggered = checkDoomLoop(bucket, sig);
    expect(triggered.triggered).toBe(true);
    expect(triggered.counted).toBe(DOOM_LOOP_THRESHOLD);
  });

  it('trigger rồi KHÔNG push signature → detector giữ ở mép ngưỡng', () => {
    const bucket = getToolCallBudget('dl-3');
    const sig = 'weather:{"location":"Hanoi"}';
    for (let i = 0; i < DOOM_LOOP_THRESHOLD; i++) checkDoomLoop(bucket, sig);
    // Lần thứ 4 vẫn trigger, counted vẫn đúng ngưỡng
    const again = checkDoomLoop(bucket, sig);
    expect(again.triggered).toBe(true);
    expect(again.counted).toBe(DOOM_LOOP_THRESHOLD);
    // recentSignatures không phình vô hạn
    expect(bucket.recentSignatures.length).toBeLessThanOrEqual(DOOM_LOOP_THRESHOLD);
  });

  it('call KHÁC xen vào → reset chuỗi, không trigger', () => {
    const bucket = getToolCallBudget('dl-4');
    const a = 'web_search:{"query":"a"}';
    const b = 'web_search:{"query":"b"}';
    checkDoomLoop(bucket, a);
    checkDoomLoop(bucket, a);
    // B xen vào phá chuỗi
    checkDoomLoop(bucket, b);
    // A lại xuất hiện nhưng chỉ đếm từ sau B → counted=1
    const r = checkDoomLoop(bucket, a);
    expect(r.triggered).toBe(false);
    expect(r.counted).toBe(1);
  });

  it('resetToolCallBudget dọn lịch sử doom-loop', () => {
    const bucket = getToolCallBudget('dl-5');
    const sig = 'fs_read:{"path":"a.ts"}';
    checkDoomLoop(bucket, sig);
    checkDoomLoop(bucket, sig);
    resetToolCallBudget('dl-5');
    const after = getToolCallBudget('dl-5');
    expect(after.recentSignatures.length).toBe(0);
    // Sau reset, cùng signature lại bắt đầu từ 1
    const r = checkDoomLoop(after, sig);
    expect(r.triggered).toBe(false);
    expect(r.counted).toBe(1);
  });

  it('bucket dùng-một-lần (không conversationId) cũng hỗ trợ doom-loop', () => {
    const bucket = getToolCallBudget(undefined);
    const sig = 'test:{}';
    for (let i = 0; i < DOOM_LOOP_THRESHOLD - 1; i++) checkDoomLoop(bucket, sig);
    expect(checkDoomLoop(bucket, sig).triggered).toBe(true);
  });
});

describe('doom-loop qua guarded() — integration', () => {
  it(`lặp ${DOOM_LOOP_THRESHOLD} lần → nhận steering message thay vì kết quả`, async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<a class="result-link" href="https://e.com/a">T</a>', {
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    const tools = () => buildAgentTools({ conversationId: 'dl-int' });

    // Lần 1: chạy thật
    const first = await tools().web_search.execute!({ query: 'doom-test' }, {} as never);
    expect((first as any).results.length).toBeGreaterThan(0);

    // Lần 2: dedupe note (nhẹ)
    const second = await tools().web_search.execute!({ query: 'doom-test' }, {} as never);
    expect((second as any).note).toMatch(/đã gọi công cụ này rồi/i);

    // Lần 3+: doom-loop steering (mạnh)
    for (let i = 0; i < 3; i++) {
      const doom = await tools().web_search.execute!({ query: 'doom-test' }, {} as never);
      expect((doom as any).note).toMatch(/LIÊN TIẾP/i);
      expect((doom as any).note).toMatch(/đổi hướng|thử.*khác|vướng/i);
    }
  });

  it('call khác xen vào → doom-loop reset, call gốc chạy lại bình thường', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<a class="result-link" href="https://e.com/a">T</a>', {
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    const tools = () => buildAgentTools({ conversationId: 'dl-reset' });

    // Lặp 2 lần (chưa trigger)
    await tools().web_search.execute!({ query: 'q1' }, {} as never);
    await tools().web_search.execute!({ query: 'q1' }, {} as never);

    // Call khác xen vào
    await tools().web_search.execute!({ query: 'q2' }, {} as never);

    // q1 lại xuất hiện — counted reset về 1, không trigger
    const after = await tools().web_search.execute!({ query: 'q1' }, {} as never);
    // Vẫn bị dedupe (seen > 0) nhưng KHÔNG phải doom-loop
    expect((after as any).note).toMatch(/đã gọi công cụ này rồi/i);
    expect((after as any).note).not.toMatch(/LIÊN TIẾP/i);
  });
});
