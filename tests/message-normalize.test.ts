/**
 * Logic chuẩn hoá message trước khi gửi upstream. Trước đây nằm trong
 * app/api/chat/route.ts (~2.000 dòng) nên không test trực tiếp được.
 */

import { describe, expect, it } from 'vitest';
import { convertToCoreMessages, type CoreMessage } from 'ai';
import {
  mergeSameRole,
  normalize,
  normalizeMessageToolInvocations,
  normalizeToolCallPairing,
  toParts,
} from '@/lib/message-normalize';

const u = (text: string): CoreMessage => ({ role: 'user', content: text });
const a = (text: string): CoreMessage => ({ role: 'assistant', content: text });
const s = (text: string): CoreMessage => ({ role: 'system', content: text });

describe('toParts', () => {
  it('string → mảng một part text', () => {
    expect(toParts('xin chào')).toEqual([{ type: 'text', text: 'xin chào' }]);
  });

  it('mảng giữ nguyên', () => {
    const parts = [{ type: 'text' as const, text: 'a' }];
    expect(toParts(parts as never)).toBe(parts);
  });
});

describe('mergeSameRole', () => {
  /* Nhiều gateway trả 400 khi thấy hai message cùng vai liền nhau. */
  it('gộp hai user liên tiếp, chèn dòng trống ở giữa', () => {
    const out = mergeSameRole([u('một'), u('hai')]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([
      { type: 'text', text: 'một' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'hai' },
    ]);
  });

  it('vai khác nhau thì KHÔNG gộp', () => {
    expect(mergeSameRole([u('hỏi'), a('đáp'), u('hỏi tiếp')])).toHaveLength(3);
  });

  it('không gộp system (chỉ user/assistant mới gộp)', () => {
    expect(mergeSameRole([s('a'), s('b')])).toHaveLength(2);
  });

  it('gộp chuỗi dài 3 message cùng vai', () => {
    const out = mergeSameRole([a('x'), a('y'), a('z')]);
    expect(out).toHaveLength(1);
    expect((out[0].content as unknown[]).length).toBe(5); // 3 nội dung + 2 ngăn cách
  });

  it('KHÔNG làm hỏng mảng gốc (không mutate input)', () => {
    const input: CoreMessage[] = [u('một'), u('hai')];
    mergeSameRole(input);
    expect(input[0].content).toBe('một');
  });

  it('mảng rỗng → rỗng', () => {
    expect(mergeSameRole([])).toEqual([]);
  });
});

describe('normalize', () => {
  it('dồn system lên đầu (gateway 400 nếu system nằm giữa)', () => {
    const out = normalize([u('hỏi'), s('quy tắc'), a('đáp')]);
    expect(out[0].role).toBe('system');
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('bỏ message text rỗng/toàn khoảng trắng', () => {
    const out = normalize([u('thật'), u('   '), a('')]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('thật');
  });

  it('cắt phần trước user message đầu tiên', () => {
    // assistant mở đầu không hợp lệ với hầu hết gateway.
    const out = normalize([a('chào trước'), u('câu hỏi')]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });

  it('KHÔNG có user nào → trả rỗng (đầu vào không hợp lệ)', () => {
    expect(normalize([s('quy tắc'), a('đáp')])).toEqual([]);
    expect(normalize([])).toEqual([]);
  });

  it('giữ part không phải text (ảnh) dù không có chữ', () => {
    const withImage: CoreMessage = {
      role: 'user',
      content: [{ type: 'image', image: 'https://x/a.png' }] as never,
    };
    expect(normalize([withImage])).toHaveLength(1);
  });

  it('giữ nhiều system, tất cả đều lên đầu', () => {
    const out = normalize([s('a'), u('hỏi'), s('b')]);
    expect(out.map((m) => m.role)).toEqual(['system', 'system', 'user']);
  });
});

describe('normalizeToolCallPairing (P2.4)', () => {
  it('giữ nguyên khi mọi tool-call đã có tool-result hợp lệ tương ứng', () => {
    const input: CoreMessage[] = [
      u('Đọc file cho tôi'),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'fs_read', args: { path: 'a.txt' } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call_1', toolName: 'fs_read', result: 'hello' },
        ],
      },
    ];

    const out = normalizeToolCallPairing(input);
    expect(out).toHaveLength(3);
    expect(out[1].role).toBe('assistant');
    expect(out[2].role).toBe('tool');
  });

  it('chèn synthetic aborted tool-result khi rẽ nhánh làm mất tool-result trước tin nhắn user', () => {
    const input: CoreMessage[] = [
      u('Đọc file'),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_orphan', toolName: 'fs_read', args: { path: 'secret.txt' } },
        ],
      },
      // Người dùng rẽ nhánh hoặc submit câu hỏi mới khi tool chưa hoàn thành
      u('Bỏ đi, làm việc khác'),
    ];

    const out = normalizeToolCallPairing(input);
    // Phải có tool message ở giữa assistant và user thứ hai để tránh lỗi 400
    expect(out).toHaveLength(4);
    expect(out[0].role).toBe('user');
    expect(out[1].role).toBe('assistant');
    expect(out[2].role).toBe('tool');
    expect(out[3].role).toBe('user');

    const toolMsg = out[2];
    expect(Array.isArray(toolMsg.content)).toBe(true);
    const part = (toolMsg.content as any[])[0];
    expect(part.type).toBe('tool-result');
    expect(part.toolCallId).toBe('call_orphan');
    expect(part.isError).toBe(true);
  });

  it('chèn synthetic aborted tool-result khi assistant tool-call nằm ở cuối thread', () => {
    const input: CoreMessage[] = [
      u('Chạy lệnh'),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_end', toolName: 'shell_run', args: { command: 'npm test' } },
        ],
      },
    ];

    const out = normalizeToolCallPairing(input);
    expect(out).toHaveLength(3);
    expect(out[2].role).toBe('tool');
    const part = (out[2].content as any[])[0];
    expect(part.toolCallId).toBe('call_end');
    expect(part.isError).toBe(true);
  });

  it('bổ sung tool-result thiếu khi assistant gọi 2 tools nhưng chỉ 1 tool kịp trả về', () => {
    const input: CoreMessage[] = [
      u('Chạy song song 2 tool'),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'fs_read', args: { path: '1.txt' } },
          { type: 'tool-call', toolCallId: 'call_2', toolName: 'fs_read', args: { path: '2.txt' } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call_1', toolName: 'fs_read', result: 'content 1' },
        ],
      },
      u('Tin nhắn tiếp theo'),
    ];

    const out = normalizeToolCallPairing(input);
    expect(out).toHaveLength(4);
    const toolMsg = out[2];
    expect((toolMsg.content as any[]).length).toBe(2);
    expect((toolMsg.content as any[])[0].toolCallId).toBe('call_1');
    expect((toolMsg.content as any[])[1].toolCallId).toBe('call_2');
    expect((toolMsg.content as any[])[1].isError).toBe(true);
  });

  it('loại bỏ orphan tool-result không có tool-call tương ứng', () => {
    const input: CoreMessage[] = [
      u('Tin nhắn user'),
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call_ghost', toolName: 'fs_read', result: 'ghost' },
        ],
      },
    ];

    const out = normalizeToolCallPairing(input);
    // Tool message mồ côi bị loại bỏ hoàn toàn
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });

  it('mảng rỗng trả về mảng rỗng', () => {
    expect(normalizeToolCallPairing([])).toEqual([]);
  });

  it('gộp các assistant message liền nhau sau khi loại bỏ orphan tool-result', () => {
    const input: CoreMessage[] = [
      u('Bắt đầu'),
      a('Đoạn 1'),
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'orphan_call', toolName: 'fs_read', result: 'data' },
        ],
      },
      a('Đoạn 2'),
    ];

    const paired = normalizeToolCallPairing(input);
    const merged = mergeSameRole(paired);
    // Orphan tool bị loại bỏ, 2 assistant message được merge lại thành 1
    expect(merged).toHaveLength(2);
    expect(merged[0].role).toBe('user');
    expect(merged[1].role).toBe('assistant');
  });
});

describe('normalizeMessageToolInvocations (P2.4)', () => {
  it('tự động hoàn tất toolInvocation bị treo (state: "call") thành synthetic aborted result', () => {
    const messages = [
      {
        id: 'msg_1',
        role: 'user',
        content: 'Chạy tool',
      },
      {
        id: 'msg_2',
        role: 'assistant',
        content: 'Đang chạy...',
        toolInvocations: [
          {
            toolCallId: 'call_interrupted',
            toolName: 'shell_run',
            state: 'call',
            args: { command: 'npm test' },
          },
        ],
      },
    ];

    const normalized = normalizeMessageToolInvocations(messages);
    expect(normalized[1].toolInvocations![0].state).toBe('result');
    expect((normalized[1].toolInvocations![0] as any).result).toBeDefined();

    // Quan trọng: convertToCoreMessages của AI SDK không bị throw AI_MessageConversionError
    expect(() => convertToCoreMessages(normalized as any)).not.toThrow();

    const core = convertToCoreMessages(normalized as any);
    const paired = normalizeToolCallPairing(core);
    expect(paired.length).toBe(3);
    expect(paired[2].role).toBe('tool');
  });
});
