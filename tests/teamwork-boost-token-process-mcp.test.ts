/**
 * Comprehensive Verification Test Suite for:
 * 1. /boost & --boost command with isolated Git Worktree and merge gate
 * 2. Token Discipline & History Invariants (slimToolResults, trimHistory)
 * 3. Background Process Management (process_start, process_status, process_output, process_stop)
 * 4. Native MCP Client (zero-dependency JSON-RPC stdio client with lifecycle cleanup)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseCliArgs, runCli } from '../lib/teamwork/cli';
import { TeamworkEngine } from '../lib/teamwork/engine';
import { NativeMcpClient } from '../lib/teamwork/mcp-client';
import {
  type HistoryMessage,
  slimToolResults,
  trimHistory,
} from '../lib/teamwork/token-discipline';
import {
  HeadlessToolRunner,
  process_output,
  process_start,
  process_status,
  process_stop,
} from '../lib/teamwork/tools';
import { GitWorktreeManager } from '../lib/teamwork/worktree';

describe('Feature 1: /boost & --boost in CLI & Isolated Worktree', () => {
  const workspaceRoot = path.resolve(process.cwd());

  it('parses --boost flag correctly', () => {
    const parsed = parseCliArgs(['--boost', '--goal', 'Optimize database indexes']);
    expect(parsed.boost).toBe(true);
    expect(parsed.goal).toBe('Optimize database indexes');
  });

  it('parses inline --boost= syntax', () => {
    const parsed = parseCliArgs(['--boost=Refactor auth middleware']);
    expect(parsed.boost).toBe(true);
    expect(parsed.goal).toBe('Refactor auth middleware');
  });

  it('parses /boost prefix command syntax', () => {
    const parsed = parseCliArgs(['/boost Migrate cache to Redis']);
    expect(parsed.boost).toBe(true);
    expect(parsed.goal).toBe('Migrate cache to Redis');
  });

  it('parses standalone /boost with subsequent goal', () => {
    const parsed = parseCliArgs(['/boost', 'Fix race condition']);
    expect(parsed.boost).toBe(true);
    expect(parsed.goal).toBe('Fix race condition');
  });

  it('generates diff stat using GitWorktreeManager.getDiffStat()', async () => {
    const mgr = new GitWorktreeManager({
      workspaceRoot,
      baseWorktreeDir: path.join(os.tmpdir(), 'teamwork-boost-diffstat-test'),
      branchPrefix: 'teamwork/diff-test',
    });

    if (!mgr.isGitRepo()) return;

    const workerId = `diff-worker-${Date.now()}`;
    const ctx = await mgr.createWorktree(workerId);

    try {
      // Modify a file in the worktree
      const testFile = path.join(ctx.worktreePath, 'boost-diff-test.txt');
      fs.writeFileSync(testFile, 'Hello Boost Worktree\nLine 2\n', 'utf8');

      const statRes = mgr.getDiffStat(workerId);
      expect(statRes.success).toBe(true);
      expect(statRes.stat).toContain('boost-diff-test.txt');
    } finally {
      await mgr.removeWorktree(workerId, { force: true, deleteBranch: true });
    }
  }, 30000);

  it('executes runCli with --boost and dry-run cleanly in worktree', async () => {
    const res = await runCli([
      '--boost',
      '--goal',
      'Boost dry run test',
      '--dry-run',
      '--auto-approve',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('[Boost Mode]');
    expect(res.stdout).toContain('[Dry Run]');
  }, 30000);

  it('executes runCli with /boost, showing diff stat and prompt merge', async () => {
    const runnerWorkspace = path.resolve(process.cwd());

    const res = await runCli(
      ['/boost Implement feature in worktree', '--auto-approve'],
      {
        workspaceRoot: runnerWorkspace,
        userConfirm: true,
        engineFactory: (wsRoot) => {
          const engine = new TeamworkEngine({
            workspaceRoot: wsRoot,
            confirmPrompt: async () => true,
            workerExecutor: async (milestone, attempt, tools) => {
              return { filesTouched: [] };
            },
          });

          (engine as any).critic.verifyMilestone = async () => ({
            verdict: 'PASS',
            command: 'npm test',
            exitCode: 0,
            outputPreview: 'Clean pass',
            issues: [],
            passCriteriaMet: true,
          });

          return engine;
        },
      }
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('[Boost Mode]');
    expect(res.stdout).toContain('[Boost Diff Stat]');
    expect(res.stdout).toContain('[Boost Merge Gate]');
  }, 30000);
});

describe('Feature 2: Token Discipline & History Invariants', () => {
  it('slimToolResults preserves recent 3 tool results and slims older ones', () => {
    const longText = 'A'.repeat(500);

    const history: HistoryMessage[] = [
      { role: 'user', content: 'Task start' },
      { role: 'assistant', content: 'Calling tool 1', tool_calls: [{ id: 'call-1', function: { name: 'read_1', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: `Tool 1 output: ${longText}` },
      { role: 'assistant', content: 'Calling tool 2', tool_calls: [{ id: 'call-2', function: { name: 'read_2', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-2', content: `Tool 2 output: ${longText}` },
      { role: 'assistant', content: 'Calling tool 3', tool_calls: [{ id: 'call-3', function: { name: 'read_3', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-3', content: `Tool 3 output: ${longText}` },
      { role: 'assistant', content: 'Calling tool 4', tool_calls: [{ id: 'call-4', function: { name: 'read_4', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-4', content: `Tool 4 output: ${longText}` },
      { role: 'assistant', content: 'Calling tool 5', tool_calls: [{ id: 'call-5', function: { name: 'read_5', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-5', content: `Tool 5 output: ${longText}` },
    ];

    const slimmed = slimToolResults(history, { recentStepsToKeep: 3, maxTrimmedChars: 100 });

    // There are 5 tool results:
    // Indices for tool results: 2 (call-1), 4 (call-2), 6 (call-3), 8 (call-4), 10 (call-5)
    // The last 3 are 6, 8, 10 -> MUST remain full output
    // Earlier ones (2, 4) MUST be slimmed
    expect(slimmed[2].content).toContain('[Tool result trimmed:');
    expect(slimmed[2].tool_call_id).toBe('call-1'); // Envelope preserved!

    expect(slimmed[4].content).toContain('[Tool result trimmed:');
    expect(slimmed[4].tool_call_id).toBe('call-2'); // Envelope preserved!

    // Recent 3 steps preserved intact
    expect(slimmed[6].content).toContain(longText);
    expect(slimmed[8].content).toContain(longText);
    expect(slimmed[10].content).toContain(longText);
  });

  it('slimToolResults does not trim tool results when count <= 3', () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Calling', tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'X'.repeat(400) },
      { role: 'assistant', content: 'Calling', tool_calls: [{ id: 'c2' }] },
      { role: 'tool', tool_call_id: 'c2', content: 'Y'.repeat(400) },
    ];

    const result = slimToolResults(history, { recentStepsToKeep: 3 });
    expect(result[2].content).toBe('X'.repeat(400));
    expect(result[4].content).toBe('Y'.repeat(400));
  });

  it('trimHistory enforces Invariant 1: First message MUST have role "user"', () => {
    const history: HistoryMessage[] = [
      { role: 'assistant', content: 'Leading assistant message' },
      { role: 'user', content: 'First real user message' },
      { role: 'assistant', content: 'Assistant response' },
    ];

    const trimmed = trimHistory(history, { maxMessages: 2 });
    expect(trimmed[0].role).toBe('user');
    expect(trimmed[0].content).toBe('First real user message');
  });

  it('trimHistory synthesizes initial user message if none exists in history', () => {
    const history: HistoryMessage[] = [
      { role: 'assistant', content: 'Orphan assistant 1' },
      { role: 'assistant', content: 'Orphan assistant 2' },
    ];

    const trimmed = trimHistory(history);
    expect(trimmed[0].role).toBe('user');
  });

  it('trimHistory enforces Invariant 2: Drops orphaned tool results (missing assistant call)', () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: 'Start task' },
      // Tool result whose assistant was previously pruned:
      { role: 'tool', tool_call_id: 'pruned-call-id', content: 'Dangling tool result' },
      { role: 'assistant', content: 'Next action' },
    ];

    const trimmed = trimHistory(history);
    const hasOrphan = trimmed.some((m) => m.tool_call_id === 'pruned-call-id');
    expect(hasOrphan).toBe(false);
  });

  it('trimHistory enforces Invariant 2: Cleans up assistant tool calls with missing results', () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: 'Start task' },
      {
        role: 'assistant',
        content: 'I will call a tool',
        tool_calls: [{ id: 'call-unresolved', function: { name: 'foo', arguments: '{}' } }],
      },
      { role: 'user', content: 'Next user turn' },
    ];

    const trimmed = trimHistory(history);
    const assistant = trimmed.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    // The unresolved tool call was pruned to prevent 400 Bad Request
    expect(assistant?.tool_calls).toBeUndefined();
    expect(assistant?.content).toBe('I will call a tool');
  });

  it('trimHistory handles complex multi-turn conversation with token discipline and invariant preservation', () => {
    const longOutput = 'Output '.repeat(60);
    const history: HistoryMessage[] = [
      { role: 'user', content: 'Initial user prompt' },
      { role: 'assistant', content: 'Turn 1', tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: longOutput },
      { role: 'assistant', content: 'Turn 2', tool_calls: [{ id: 'c2' }] },
      { role: 'tool', tool_call_id: 'c2', content: longOutput },
      { role: 'assistant', content: 'Turn 3', tool_calls: [{ id: 'c3' }] },
      { role: 'tool', tool_call_id: 'c3', content: longOutput },
      { role: 'assistant', content: 'Turn 4', tool_calls: [{ id: 'c4' }] },
      { role: 'tool', tool_call_id: 'c4', content: longOutput },
      { role: 'user', content: 'Latest prompt' },
    ];

    const trimmed = trimHistory(history, { maxMessages: 8, recentStepsToKeep: 3 });

    // Invariant 1: role 'user' first
    expect(trimmed[0].role).toBe('user');

    // Invariant 2: every tool result has matching assistant call
    for (const m of trimmed) {
      if (m.role === 'tool') {
        const id = m.tool_call_id;
        const matchingAssistant = trimmed.find(
          (a) => a.role === 'assistant' && a.tool_calls?.some((c) => c.id === id)
        );
        expect(matchingAssistant).toBeDefined();
      }
    }
  });
});

describe('Feature 3: Background Process Management Tools', () => {
  let runner: HeadlessToolRunner;
  const workspaceRoot = path.resolve(process.cwd());

  beforeAll(() => {
    runner = new HeadlessToolRunner({ workspaceRoot });
  });

  afterAll(async () => {
    await runner.cleanupAllProcesses();
  });

  it('starts a background process and queries its status', async () => {
    const isWin = process.platform === 'win32';
    // Use long-running command (ping localhost or node sleep)
    const cmd = isWin ? 'ping 127.0.0.1 -n 5' : 'sleep 5';

    const startRes = await runner.process_start(cmd);
    expect(startRes.processId).toBeDefined();
    expect(startRes.status).toBe('running');
    expect(typeof startRes.pid).toBe('number');

    const status = runner.process_status(startRes.processId);
    expect(status.status).toBe('running');
    expect(status.pid).toBe(startRes.pid);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);

    // Stop process
    const stopRes = await runner.process_stop(startRes.processId);
    expect(stopRes.stopped).toBe(true);

    const postStatus = runner.process_status(startRes.processId);
    expect(postStatus.status).toBe('stopped');
  });

  it('captures background process output with tail and clear options', async () => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'echo line1 & echo line2 & echo line3' : 'echo line1; echo line2; echo line3';

    const startRes = await runner.process_start(cmd);

    // Wait a brief moment for output
    await new Promise((resolve) => setTimeout(resolve, 600));

    const out = runner.process_output(startRes.processId);
    expect(out.stdout).toContain('line1');
    expect(out.stdout).toContain('line2');

    // Test tail
    const tailed = runner.process_output(startRes.processId, { tail: 1 });
    const lines = tailed.stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBe(1);

    // Test clear
    runner.process_output(startRes.processId, { clear: true });
    const cleared = runner.process_output(startRes.processId);
    expect(cleared.stdout).toBe('');
  });

  it('standalone functions process_start, process_status, process_stop work', async () => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'ping 127.0.0.1 -n 4' : 'sleep 4';

    const res = await process_start(cmd, { workspaceRoot });
    expect(res.processId).toBeDefined();

    const st = process_status(res.processId);
    expect(st.status).toBe('running');

    const stop = await process_stop(res.processId);
    expect(stop.stopped).toBe(true);
  });

  it('blocks dangerous commands in process_start', async () => {
    await expect(runner.process_start('rm -rf /')).rejects.toThrow(/auto-pilot safety policy/);
  });
});

describe('Feature 4: Native Zero-Dependency MCP Client', () => {
  let serverScriptPath: string;

  beforeAll(() => {
    // Create a mock MCP server Node script using pure stdio JSON-RPC
    serverScriptPath = path.join(os.tmpdir(), `mock-mcp-server-${Date.now()}.cjs`);
    const serverCode = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

      rl.on('line', (line) => {
        if (!line.trim()) return;
        let req;
        try { req = JSON.parse(line); } catch { return; }

        if (req.method === 'initialize') {
          const res = {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: { listChanged: true }, resources: {} },
              serverInfo: { name: 'mock-test-mcp', version: '1.0.0' }
            }
          };
          process.stdout.write(JSON.stringify(res) + '\\n');
        } else if (req.method === 'notifications/initialized') {
          // No response needed for notification
        } else if (req.method === 'ping') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n');
        } else if (req.method === 'tools/list') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              tools: [
                {
                  name: 'calculate_sum',
                  description: 'Adds two numbers',
                  inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } }
                }
              ]
            }
          }) + '\\n');
        } else if (req.method === 'tools/call') {
          const args = req.params?.arguments || {};
          const sum = (args.a || 0) + (args.b || 0);
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [{ type: 'text', text: String(sum) }],
              isError: false
            }
          }) + '\\n');
        } else if (req.method === 'resources/list') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { resources: [{ uri: 'file:///data.txt', name: 'data.txt' }] }
          }) + '\\n');
        } else if (req.method === 'resources/read') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { contents: [{ uri: req.params.uri, text: 'Hello Resource' }] }
          }) + '\\n');
        } else if (req.method === 'prompts/list') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { prompts: [{ name: 'code_review', description: 'Review code' }] }
          }) + '\\n');
        }
      });
    `;
    fs.writeFileSync(serverScriptPath, serverCode, 'utf8');
  });

  afterAll(() => {
    try {
      if (fs.existsSync(serverScriptPath)) {
        fs.unlinkSync(serverScriptPath);
      }
    } catch {
      // Best effort
    }
  });

  it('connects to stdio MCP server, exchanges initialize handshake, and reports capabilities', async () => {
    const client = new NativeMcpClient({
      command: process.execPath,
      args: [serverScriptPath],
    });

    await client.connect();
    expect(client.isConnected()).toBe(true);

    const info = client.getServerInfo();
    expect(info.name).toBe('mock-test-mcp');
    expect(info.version).toBe('1.0.0');

    const pingOk = await client.ping();
    expect(pingOk).toBe(true);

    await client.close();
    expect(client.isConnected()).toBe(false);
  });

  it('lists tools and executes tool call correctly', async () => {
    const client = new NativeMcpClient({
      command: process.execPath,
      args: [serverScriptPath],
    });

    await client.connect();

    const tools = await client.listTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('calculate_sum');
    expect(tools[0].description).toBe('Adds two numbers');

    const callRes = await client.callTool('calculate_sum', { a: 15, b: 27 });
    expect(callRes.isError).toBe(false);
    expect(callRes.content[0].text).toBe('42');

    await client.close();
  });

  it('lists resources, reads resource, and lists prompts', async () => {
    const client = new NativeMcpClient({
      command: process.execPath,
      args: [serverScriptPath],
    });

    await client.connect();

    const resources = await client.listResources();
    expect(resources.length).toBe(1);
    expect(resources[0].uri).toBe('file:///data.txt');

    const resContent = await client.readResource('file:///data.txt');
    expect(resContent.contents[0].text).toBe('Hello Resource');

    const prompts = await client.listPrompts();
    expect(prompts.length).toBe(1);
    expect(prompts[0].name).toBe('code_review');

    await client.close();
  });

  it('performs lifecycle cleanup and rejects pending requests on close', async () => {
    const client = new NativeMcpClient({
      command: process.execPath,
      args: [serverScriptPath],
    });

    await client.connect();
    expect(client.isConnected()).toBe(true);

    await client.close();
    expect(client.isConnected()).toBe(false);

    // Request on closed client should reject
    await expect(client.request('ping')).rejects.toThrow(/closed/);
    expect(await client.ping()).toBe(false);

    // Idempotent close
    await expect(client.close()).resolves.toBeUndefined();
  });
});
