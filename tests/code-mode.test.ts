import { describe, it, expect, vi } from 'vitest';
import {
  executeCodeMode,
  truncateCodeOutput,
  CODE_MODE_MAX_OUTPUT_CHARS,
} from '@/lib/mcp/code-mode';

describe('Code Mode — Sandbox Execution', () => {
  it('thực thi code JS cơ bản, console.log và trả về kết quả đúng', async () => {
    const code = `
      const a = 10;
      const b = 20;
      console.log('Tổng là:', a + b);
      return { sum: a + b, product: a * b };
    `;

    const res = await executeCodeMode(code);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('Tổng là: 30');
    expect(res.output).toContain('"sum": 30');
    expect(res.returnValue).toEqual({ sum: 30, product: 200 });
  });

  it('inject mcp.call thành công và nhận được dữ liệu trả về', async () => {
    const mockCaller = vi.fn(async (serverId: string, toolName: string, args: Record<string, unknown>) => {
      if (serverId === 'github' && toolName === 'get_user') {
        return { user: args.username, role: 'developer' };
      }
      return { error: 'Unknown tool' };
    });

    const code = `
      const user = await mcp.call('github', 'get_user', { username: 'vyen_ai' });
      console.log('User role:', user.role);
      return user;
    `;

    const res = await executeCodeMode(code, { mcpCaller: mockCaller });
    expect(res.ok).toBe(true);
    expect(mockCaller).toHaveBeenCalledWith('github', 'get_user', { username: 'vyen_ai' });
    expect(res.output).toContain('User role: developer');
    expect(res.returnValue).toEqual({ user: 'vyen_ai', role: 'developer' });
  });

  it('xử lý lỗi cú pháp hoặc runtime error không làm crash process', async () => {
    const code = `
      const x = undefined;
      x.someMethod();
    `;

    const res = await executeCodeMode(code);
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.output).toContain('[Lỗi]:');
  });

  it('timeout khi đoạn mã chạy vòng lặp vô tận hoặc promise treo', async () => {
    const code = `
      await new Promise(r => setTimeout(r, 2000));
    `;

    const res = await executeCodeMode(code, { timeoutMs: 1000 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('quá thời gian');
  });

  it('cắt ngắn output nếu vượt quá 24.000 ký tự', async () => {
    const longString = 'A'.repeat(30_000);
    const code = `
      console.log('${longString}');
    `;

    const res = await executeCodeMode(code);
    expect(res.truncated).toBe(true);
    expect(res.output.length).toBeLessThanOrEqual(CODE_MODE_MAX_OUTPUT_CHARS);
    expect(res.output).toContain('Cắt ngắn: Kết quả vượt quá');
  });

  it('hàm truncateCodeOutput hoạt động chính xác với giới hạn tùy chỉnh', () => {
    const str = 'HelloWorld12345';
    const res = truncateCodeOutput(str, 10);
    expect(res.truncated).toBe(true);
    expect(res.text).toContain('Cắt ngắn: Kết quả vượt quá 10 ký tự');
  });
});
