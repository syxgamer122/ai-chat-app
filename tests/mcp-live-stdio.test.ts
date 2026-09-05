/**
 * Tích hợp THẬT với một MCP server qua stdio.
 *
 * Đây là test duy nhất chứng minh Vyen nói đúng giao thức MCP end-to-end:
 * spawn process → initialize → tools/list → tools/call → close. Mọi test khác
 * trong bộ đều giả lập client, nên sẽ không bắt được lỗi lệch protocol.
 */
import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { McpManager } = require('../lib/mcp/manager.cjs') as {
  McpManager: new () => any;
};

const SERVER_PATH = path.join(__dirname, 'fixtures', 'mcp-demo-server.mjs');
const manager = new McpManager();

afterAll(async () => {
  await manager.shutdown();
});

describe('MCP end-to-end qua stdio', () => {
  it('connects, lists tools and calls them', async () => {
    await manager.init([]);
    await manager.addServer({
      id: 'demo',
      name: 'Demo',
      transport: 'stdio',
      command: process.execPath,
      args: [SERVER_PATH],
      autoApprove: ['*'],
    });

    const status = manager.getServer('demo');
    expect(status.status).toBe('connected');
    expect(status.toolCount).toBe(3);
    expect(status.serverVersion).toBe('demo-server 2.3.4');

    const tools = manager.listTools();
    expect(tools).toHaveLength(3);
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'add',
      'always_fails',
      'enable_extra',
    ]);
    expect(tools[0].serverId).toBe('demo');
    expect(tools[0].serverName).toBe('Demo');
  }, 30_000);

  it('picks up tools added after connect (tools/list_changed)', async () => {
    const refreshed = new Promise<number>((resolve) => {
      manager.on('server-status', (s: { toolCount: number }) => {
        if (s.toolCount === 4) resolve(s.toolCount);
      });
    });

    await manager.callTool('demo', 'enable_extra', {});

    // Không có timeout riêng: nếu Vyen bỏ lỡ thông báo, promise treo tới khi
    // vitest cắt (30s) — đỏ ở đúng chỗ cần đỏ.
    await expect(refreshed).resolves.toBe(4);
    expect(manager.listTools().map((t: { name: string }) => t.name)).toContain('extra_tool');
  }, 30_000);

  it('returns a successful result unchanged', async () => {
    const result = await manager.callTool('demo', 'add', { a: 2, b: 40 });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe('42');
  }, 30_000);

  it('keeps isError from the tool (business failure ≠ protocol failure)', async () => {
    const result = await manager.callTool('demo', 'always_fails', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('không tìm thấy file');
  }, 30_000);

  it('throws on a tool the server does not have', async () => {
    await expect(manager.callTool('demo', 'not_a_tool', {})).rejects.toThrow(/thất bại/);
  }, 30_000);

  it('removes the server and forgets its tools', async () => {
    await manager.removeServer('demo');
    expect(manager.getServer('demo')).toBeNull();
    expect(manager.listTools()).toEqual([]);
  }, 30_000);
});
