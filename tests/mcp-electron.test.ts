/**
 * Tests cho layer MCP của host process (HTTP bridge / desktop shell).
 *
 * Chạy được trên Node thuần vì manager.cjs / ipc-handlers.cjs không còn đụng
 * tới Electron: sự kiện đi ra qua sink `opts.onEvent` (test đăng ký spy thu
 * vào mảng `sinkEvents`), còn `ipcMain` được giả lập — mỗi channel thu thành
 * một hàm gọi trực tiếp, đủ để test toàn bộ luồng duyệt mà không cần dựng UI
 * thật.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// File test là ESM nhưng lib/mcp/*.cjs là CommonJS — cần require thật.
const require = createRequire(import.meta.url);

type Handler = (_event: unknown, payload?: unknown) => Promise<unknown> | unknown;

const ipcHandlers = new Map<string, Handler>();
const fakeIpcMain = {
  handle: (channel: string, fn: Handler) => {
    ipcHandlers.set(channel, fn);
  },
};

const mcpIpc = require('../lib/mcp/ipc-handlers.cjs') as {
  register: (
    ipcMain: unknown,
    opts: {
      userDataDir: string;
      audit?: (l: string) => void;
      onEvent?: (channel: string, payload: unknown) => void;
    },
  ) => Promise<void>;
  shutdown: () => Promise<void>;
  APPROVAL_TIMEOUT_MS: number;
};
const { McpManager, matchesAutoApprove } = require('../lib/mcp/manager.cjs') as {
  McpManager: new () => any;
  matchesAutoApprove: (patterns: string[] | undefined, toolName: string) => boolean;
};

let userDataDir: string;

/** Event thu được từ sink onEvent — reset mỗi test để không nhiễm chéo. */
const sinkEvents: Array<{ channel: string; payload: Record<string, unknown> }> = [];
/** Số lần sink được gọi, tính cả các lần nó ném lỗi. */
let sinkCalls = 0;
/** Bật để sink ném lỗi — mô phỏng host có bug, luồng duyệt vẫn phải sống. */
let sinkThrows = false;

const onEvent = (channel: string, payload: unknown) => {
  sinkCalls += 1;
  if (sinkThrows) throw new Error('onEvent sink bug (mô phỏng host lỗi)');
  sinkEvents.push({ channel, payload: payload as Record<string, unknown> });
};

beforeEach(() => {
  sinkEvents.length = 0;
  sinkCalls = 0;
  sinkThrows = false;
});

/** Gọi thẳng handler đã đăng ký (bỏ qua lớp ipcRenderer). */
const call = (channel: string, payload?: unknown) => {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`Chưa đăng ký channel ${channel}`);
  return Promise.resolve(handler(null, payload));
};

beforeAll(async () => {
  userDataDir = mkdtempSync(path.join(tmpdir(), 'vyen-mcp-test-'));
  await mcpIpc.register(fakeIpcMain, { userDataDir, audit: () => {}, onEvent });
});

afterAll(async () => {
  await mcpIpc.shutdown();
  rmSync(userDataDir, { recursive: true, force: true });
});

describe('matchesAutoApprove', () => {
  it('supports wildcard, prefix and exact patterns', () => {
    expect(matchesAutoApprove(['*'], 'anything')).toBe(true);
    expect(matchesAutoApprove(['read_*'], 'read_file')).toBe(true);
    expect(matchesAutoApprove(['read_*'], 'write_file')).toBe(false);
    expect(matchesAutoApprove(['list_dir'], 'list_dir')).toBe(true);
    expect(matchesAutoApprove([], 'x')).toBe(false);
    expect(matchesAutoApprove(undefined, 'x')).toBe(false);
  });
});

describe('McpManager emitStatus', () => {
  it('emits the server id (not undefined)', () => {
    const manager = new McpManager();
    const entry = {
      config: { id: 'files', name: 'Files', transport: 'stdio', command: 'c' },
      status: 'connected',
      error: null,
      tools: [{ name: 'read' }],
      serverVersion: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      intentionalClose: false,
    };
    manager.servers.set('files', entry);

    const seen: Array<Record<string, unknown>> = [];
    manager.on('server-status', (s: Record<string, unknown>) => seen.push(s));
    manager._emitStatus(entry);

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe('files');
    expect(seen[0].name).toBe('Files');
    expect(seen[0].toolCount).toBe(1);
  });
});

describe('McpManager.callTool', () => {
  it('normalises the MCP result shape', async () => {
    const manager = new McpManager();
    manager.servers.set('srv', {
      config: { id: 'srv', name: 'S', transport: 'stdio', command: 'c' },
      status: 'connected',
      client: { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: true }) },
      tools: [],
      error: null,
      callTimeoutMs: 60_000,
    });

    await expect(manager.callTool('srv', 't', {})).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: true,
    });
  });

  it('throws for unknown or disconnected servers', async () => {
    const manager = new McpManager();
    await expect(manager.callTool('nope', 't', {})).rejects.toThrow(/không tồn tại/);

    manager.servers.set('down', {
      config: { id: 'down', name: 'D', transport: 'stdio', command: 'c' },
      status: 'disconnected',
      client: null,
      tools: [],
      error: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      intentionalClose: false,
    });
    await expect(manager.callTool('down', 't', {})).rejects.toThrow(/chưa kết nối/);
  });

  it('marks the server disconnected when the transport died mid-call', async () => {
    const manager = new McpManager();
    const entry: Record<string, unknown> = {
      config: { id: 'srv', name: 'S', transport: 'stdio', command: 'c' },
      status: 'connected',
      client: { callTool: async () => { throw new Error('Connection closed'); } },
      tools: [],
      error: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      intentionalClose: false,
    };
    manager.servers.set('srv', entry);

    await expect(manager.callTool('srv', 't', {})).rejects.toThrow(/thất bại/);
    expect(entry.status).toBe('disconnected');

    // Hạ trạng thái kéo theo lịch reconnect — dọn để không rò timer sang test khác.
    await manager.shutdown();
  });
});

describe('MCP IPC handlers', () => {
  it('registered every documented channel', () => {
    for (const channel of [
      'mcp:list-servers',
      'mcp:add-server',
      'mcp:remove-server',
      'mcp:reconnect',
      'mcp:update-config',
      'mcp:list-tools',
      'mcp:call-tool',
      'mcp:resolve-approval',
      'mcp:get-pending-approvals',
      'mcp:get-status',
    ]) {
      expect(ipcHandlers.has(channel), channel).toBe(true);
    }
  });

  it('rejects an invalid server id', async () => {
    await expect(
      call('mcp:add-server', {
        id: 'bad id!',
        name: 'Bad',
        transport: 'stdio',
        command: 'npx',
      }),
    ).rejects.toThrow();
  });

  it('keeps a server that fails to connect, in error state', async () => {
    const added = (await call('mcp:add-server', {
      id: 'broken',
      name: 'Broken',
      transport: 'stdio',
      command: 'vyen-command-that-does-not-exist',
    })) as { id: string; status: string; error?: string };

    expect(added.id).toBe('broken');
    expect(added.status).toBe('error');
    expect(added.error).toBeTruthy();

    const servers = (await call('mcp:list-servers')) as Array<{ id: string; status: string }>;
    expect(servers.some((s) => s.id === 'broken' && s.status === 'error')).toBe(true);
  });

  it('lists no tools while every server is down', async () => {
    await expect(call('mcp:list-tools')).resolves.toEqual([]);
    const status = (await call('mcp:get-status')) as { tools: number; servers: unknown[] };
    expect(status.tools).toBe(0);
  });

  it('requires approval, then honours a deny decision', async () => {
    const pending0 = (await call('mcp:get-pending-approvals')) as unknown[];
    expect(pending0).toHaveLength(0);

    const inFlight = call('mcp:call-tool', {
      serverId: 'broken',
      toolName: 'do_thing',
      arguments: { a: 1 },
    });

    // Chờ yêu cầu duyệt xuất hiện (handler đang treo ở createApproval).
    let pending = (await call('mcp:get-pending-approvals')) as Array<{
      id: string;
      serverId: string;
      toolName: string;
    }>;
    for (let i = 0; i < 20 && pending.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      pending = (await call('mcp:get-pending-approvals')) as typeof pending;
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].serverId).toBe('broken');
    expect(pending[0].toolName).toBe('do_thing');

    // Sink nhận 'mcp:approval-requested' với id khớp bản poll và đủ payload.
    const requested = sinkEvents.find((e) => e.channel === 'mcp:approval-requested');
    expect(requested).toBeDefined();
    expect(requested?.payload).toMatchObject({
      id: pending[0].id,
      serverId: 'broken',
      toolName: 'do_thing',
    });
    expect(requested?.payload.arguments).toEqual({ a: 1 });
    expect(typeof requested?.payload.createdAt).toBe('number');
    expect(requested?.payload.expiresAt).toBe(
      (requested?.payload.createdAt as number) + mcpIpc.APPROVAL_TIMEOUT_MS,
    );

    await expect(call('mcp:resolve-approval', { approvalId: pending[0].id, decision: 'deny_once' }))
      .resolves.toEqual({ ok: true });

    // Sau khi resolve, sink nhận 'mcp:approval-resolved' cho đúng id đó.
    const resolved = sinkEvents.find((e) => e.channel === 'mcp:approval-resolved');
    expect(resolved).toBeDefined();
    expect(resolved?.payload).toEqual({ id: pending[0].id, decision: 'deny_once' });

    const result = (await inFlight) as { isError: boolean; denied?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.denied).toBe(true);
    expect(result.content[0].text).toContain('từ chối');
  });

  it('rejects resolving an unknown approval id', async () => {
    await expect(
      call('mcp:resolve-approval', {
        approvalId: '00000000-0000-4000-8000-000000000000',
        decision: 'allow_once',
      }),
    ).rejects.toThrow();
  });

  it('auto-denies an approval nobody answers', async () => {
    vi.useFakeTimers();
    try {
      const inFlight = call('mcp:call-tool', {
        serverId: 'broken',
        toolName: 'ghost',
        arguments: {},
      });
      await vi.advanceTimersByTimeAsync(mcpIpc.APPROVAL_TIMEOUT_MS);
      const result = (await inFlight) as { denied?: boolean };
      expect(result.denied).toBe(true);

      // Timeout cũng phát 'mcp:approval-resolved' — đủ payload để UI tắt dialog.
      const requested = sinkEvents.find((e) => e.channel === 'mcp:approval-requested');
      const resolved = sinkEvents.find((e) => e.channel === 'mcp:approval-resolved');
      expect(requested).toBeDefined();
      expect(resolved).toBeDefined();
      expect(resolved?.payload).toEqual({
        id: requested?.payload.id,
        decision: 'deny_once',
        timedOut: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows a throwing onEvent sink without breaking the approval flow', async () => {
    sinkThrows = true;

    const inFlight = call('mcp:call-tool', {
      serverId: 'broken',
      toolName: 'boom',
      arguments: {},
    });

    // Sink ném ngay tại 'mcp:approval-requested' — pending vẫn phải được tạo.
    let pending = (await call('mcp:get-pending-approvals')) as Array<{ id: string }>;
    for (let i = 0; i < 20 && pending.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      pending = (await call('mcp:get-pending-approvals')) as typeof pending;
    }
    expect(pending).toHaveLength(1);
    // Sink ĐÃ được gọi và ĐÃ ném — không phải "chắc là vậy".
    expect(sinkCalls).toBeGreaterThanOrEqual(1);

    await expect(
      call('mcp:resolve-approval', { approvalId: pending[0].id, decision: 'deny_once' }),
    ).resolves.toEqual({ ok: true });

    const result = (await inFlight) as { isError: boolean; denied?: boolean };
    expect(result.isError).toBe(true);
    expect(result.denied).toBe(true);
    // 'mcp:approval-resolved' cũng ném — luồng vẫn settle và dọn pending.
    expect(sinkCalls).toBeGreaterThanOrEqual(2);
    await expect(call('mcp:get-pending-approvals')).resolves.toEqual([]);
  });

  it('removes a server', async () => {
    await expect(call('mcp:remove-server', { id: 'broken' })).resolves.toEqual({ ok: true });
    const servers = (await call('mcp:list-servers')) as Array<{ id: string }>;
    expect(servers.some((s) => s.id === 'broken')).toBe(false);
  });

  it('refuses to call a tool on a removed server', async () => {
    await expect(call('mcp:call-tool', { serverId: 'broken', toolName: 'x', arguments: {} }))
      .rejects.toThrow(/không tồn tại/);
  });
});
