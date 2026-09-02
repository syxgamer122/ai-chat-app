/**
 * Flow tests cho relay client-tool của subagent.
 *
 * Covers:
 * - runEmulatedLoop relay mode: tool client KHÔNG yield 'pending-client' mà
 *   chờ resolveClientTool, nhận [TOOL_RESULT] và chạy tiếp tới khi done
 * - executeDelegate: chạy trọn subagent (stub fetch) với tool client qua
 *   relay, trả JSON SubagentResult
 * - executeDelegate LỌC 'delegate' khỏi protocol của subagent (chống đệ quy)
 *   kể cả khi caller truyền set chứa delegate
 * - executeDelegate chặn instructions quá ngắn
 *
 * Harness: stub global fetch trả completion tuần tự — giống
 * tests/emulated-agent.test.ts (model thật của @ai-sdk/openai trỏ gw.test).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { runEmulatedLoop } from '@/lib/emulated-agent';
import { executeDelegate } from '@/lib/subagent';
import type { AgentToolSet } from '@/lib/agent-tools';

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
    model: 'sub-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

function makeModel() {
  const provider = createOpenAI({ apiKey: 'test-key', baseURL: 'https://gw.test/v1' });
  return provider('sub-model');
}

/** Stub fetch trả các completion theo thứ tự, capture body mỗi request. */
function scriptFetch(scripts: string[]) {
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  const wrapped = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    try {
      const raw =
        input instanceof Request
          ? await input.clone().text()
          : typeof init?.body === 'string'
            ? init.body
            : '';
      bodies.push(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
    } catch {
      bodies.push({});
    }
    const content = scripts[Math.min(i, scripts.length - 1)];
    i += 1;
    return completion(content);
  });
  return { fetch: wrapped, bodies };
}

afterEach(() => vi.unstubAllGlobals());

const NOOP_ANNOTATE = () => {};

describe('runEmulatedLoop — relay mode', () => {
  it('tool client chờ resolveClientTool thay vì yield pending-client', async () => {
    const { fetch, bodies } = scriptFetch([
      '<tool_call>\n{"name":"fs_read","arguments":{"path":"a.txt"}}\n</tool_call>',
      'Đã đọc xong file, tóm tắt: đây là file cấu hình.',
    ]);
    vi.stubGlobal('fetch', fetch);

    const relayCalls: Array<{ toolCallId: string; toolName: string }> = [];
    const annotations: Array<Record<string, unknown>> = [];
    let sawText = '';

    const result = await runEmulatedLoop({
      model: makeModel(),
      messages: [{ role: 'user', content: 'đọc file a.txt rồi tóm tắt' }],
      system: 'sys',
      tools: {} as AgentToolSet,
      clientTools: new Set(['fs_read']),
      resolveClientTool: async (call) => {
        relayCalls.push({ toolCallId: call.toolCallId, toolName: call.toolName });
        return JSON.stringify({ content: 'giá trị A=1, B=2' });
      },
      onTextDelta: (d) => {
        sawText += d;
      },
      onReasoningLine: () => {},
      onAnnotation: (a) => annotations.push(a as Record<string, unknown>),
    });

    // KHÔNG yield pending-client — loop tự hoàn tất trong một đời stream.
    expect(result.status).toBe('done');
    expect(result.roundsUsed).toBe(2);
    expect(relayCalls).toEqual([{ toolCallId: 'emu-0-1', toolName: 'fs_read' }]);

    // Kết quả relay quay lại model trong round 2 (transcript kèm TOOL_RESULT).
    const round2 = JSON.stringify(bodies[1]);
    expect(round2).toContain('TOOL_RESULT');
    expect(round2).toContain('giá trị A=1, B=2');

    // Annotation start/done cho tool relay — UI vẫn thấy chip tool.
    const fsAnns = annotations.filter(
      (a) => (a.tool as { name?: string } | undefined)?.name === 'fs_read',
    );
    expect(fsAnns.map((a) => (a.tool as { phase?: string }).phase)).toEqual(['start', 'done']);

    expect(sawText).toContain('tóm tắt');
  });

  it('relay throw → loop nhận lỗi dạng text, vẫn chạy tiếp', async () => {
    const { fetch } = scriptFetch([
      '<tool_call>\n{"name":"fs_read","arguments":{"path":"a.txt"}}\n</tool_call>',
      'Tool lỗi nên tôi không đọc được file.',
    ]);
    vi.stubGlobal('fetch', fetch);

    const result = await runEmulatedLoop({
      model: makeModel(),
      messages: [{ role: 'user', content: 'đọc file' }],
      system: 'sys',
      tools: {} as AgentToolSet,
      clientTools: new Set(['fs_read']),
      resolveClientTool: async () => {
        throw new Error('renderer chết');
      },
      onTextDelta: () => {},
      onReasoningLine: () => {},
      onAnnotation: NOOP_ANNOTATE,
    });

    expect(result.status).toBe('done');
    expect(result.roundsUsed).toBe(2);
  });
});

describe('executeDelegate — delegate native/emulated dùng chung', () => {
  it('chạy subagent trọn vẹn với tool client qua relay', async () => {
    const { fetch } = scriptFetch([
      '<tool_call>\n{"name":"fs_read","arguments":{"path":"src/x.ts"}}\n</tool_call>',
      'Đã khảo sát xong: file có 3 hàm.',
    ]);
    vi.stubGlobal('fetch', fetch);

    const relayCalls: string[] = [];
    const out = await executeDelegate(
      { instructions: 'Khảo sát file src/x.ts và tóm tắt các hàm.' },
      {
        model: makeModel(),
        systemBase: 'base-system',
        serverTools: {} as AgentToolSet,
        clientToolNames: new Set(['fs_read']),
        resolveClientTool: async (call) => {
          relayCalls.push(call.toolName);
          return JSON.stringify({ content: 'export function a(){} b(){} c(){}' });
        },
      },
    );

    const parsed = JSON.parse(out) as {
      status: string;
      result: string;
      turnsUsed: number;
      toolCalls: number;
    };
    expect(parsed.status).toBe('done');
    expect(parsed.result).toContain('3 hàm');
    expect(parsed.toolCalls).toBe(1);
    expect(relayCalls).toEqual(['fs_read']);
  });

  it('lọc delegate khỏi protocol của subagent dù caller truyền set đầy đủ', async () => {
    const { fetch, bodies } = scriptFetch([
      '<tool_call>\n{"name":"fs_read","arguments":{"path":"a.txt"}}\n</tool_call>',
      'Xong.',
    ]);
    vi.stubGlobal('fetch', fetch);

    await executeDelegate(
      { instructions: 'Đọc file a.txt rồi báo lại nội dung chính.' },
      {
        model: makeModel(),
        systemBase: 'base',
        serverTools: {} as AgentToolSet,
        // Truyền CẢ delegate — executeDelegate phải tự lọc.
        clientToolNames: new Set(['fs_read', 'fs_list', 'delegate']),
        resolveClientTool: async () => JSON.stringify({ content: 'ok' }),
      },
    );

    const subSystem = JSON.stringify(bodies[0]);
    // Protocol liệt kê tool dạng "- tên:" — fs_read có, delegate KHÔNG.
    expect(subSystem).toContain('- fs_read:');
    expect(subSystem).not.toContain('- delegate:');
  });

  it('instructions quá ngắn → lỗi ngay, không tốn lượt gọi model', async () => {
    const { fetch } = scriptFetch(['không-bao-gio-được-dùng']);
    vi.stubGlobal('fetch', fetch);

    const out = JSON.parse(
      await executeDelegate(
        { instructions: 'ngắn quá' },
        {
          model: makeModel(),
          systemBase: 'base',
          serverTools: {} as AgentToolSet,
          clientToolNames: new Set(),
        },
      ),
    );
    expect(out.status).toBe('error');
    expect(fetch).not.toHaveBeenCalled();
  });
});
