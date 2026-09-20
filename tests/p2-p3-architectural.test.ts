/**
 * Tests for P2 and P3 Architectural Features:
 * 1. Virtualizer Streaming Separation & Width-Aware LRU Height Cache (message-list.tsx)
 * 2. Draft Persistence in Composer (composer.tsx)
 * 3. Tool-call Pairing Normalizer (message-normalize.ts)
 * 4. Immutable Audit Log (lib/audit-log.ts & db.ts)
 * 5. Policy-as-Data Scope Enhancements (tool-permissions.ts & auto-pilot.ts)
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { db } from '@/lib/db';
import { LruCache, getWidthBucket } from '@/components/chat/message-list';
import { getDraftStorageKey, DRAFT_KEY_PREFIX } from '@/components/composer';
import { normalizeMessageToolInvocations, normalizeToolCallPairing } from '@/lib/message-normalize';
import { recordAuditLog, queryAuditLogs, computePayloadHash, clearAuditLogs } from '@/lib/audit-log';
import {
  getEffectiveToolPermission,
  matchesGlobPattern,
  extractTargetPath,
  isDynamicMcpTool,
} from '@/lib/tool-permissions';
import { shouldAutoApprove } from '@/lib/auto-pilot';
import { convertToCoreMessages, type CoreMessage } from 'ai';

describe('P2.1 & P2.2: Width-aware LRU HEIGHT_CACHE', () => {
  it('LruCache limits capacity to maxSize and evicts oldest accessed entries', () => {
    const cache = new LruCache<string, number>(3);
    cache.set('a', 10);
    cache.set('b', 20);
    cache.set('c', 30);
    expect(cache.size).toBe(3);

    // Access 'a' to make it recently used
    expect(cache.get('a')).toBe(10);

    // Insert 'd' -> 'b' should be evicted because 'a' was accessed more recently
    cache.set('d', 40);
    expect(cache.size).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(10);
    expect(cache.get('c')).toBe(30);
    expect(cache.get('d')).toBe(40);
  });

  it('getWidthBucket groups container widths into 50px increments', () => {
    expect(getWidthBucket(780)).toBe(800);
    expect(getWidthBucket(810)).toBe(800);
    expect(getWidthBucket(830)).toBe(850);
    expect(getWidthBucket(0)).toBe(800);
    expect(getWidthBucket(-50)).toBe(800);
  });

  it('cacheKey isolates heights by width bucket preventing layout squashing on resize', () => {
    const cache = new LruCache<string, number>(2000);
    const keyNarrow = `chat-1:msg-1:${getWidthBucket(400)}`; // 400
    const keyWide = `chat-1:msg-1:${getWidthBucket(1200)}`; // 1200

    cache.set(keyNarrow, 350); // Height on narrow mobile view
    cache.set(keyWide, 120);   // Height on wide desktop view

    expect(cache.get(keyNarrow)).toBe(350);
    expect(cache.get(keyWide)).toBe(120);
  });

  it('preserves cached heights across multiple chats up to LRU bound', () => {
    const cache = new LruCache<string, number>(2000);
    cache.set('chatA:msg1:800', 100);
    cache.set('chatB:msg1:800', 200);

    // Switching chats does not wipe entries
    expect(cache.get('chatA:msg1:800')).toBe(100);
    expect(cache.get('chatB:msg1:800')).toBe(200);
  });
});

describe('P2.3: Draft Persistence in Composer', () => {
  it('getDraftStorageKey returns consistent scoped storage keys', () => {
    expect(getDraftStorageKey('chat-abc')).toBe(`${DRAFT_KEY_PREFIX}chat-abc`);
    expect(getDraftStorageKey('')).toBe(`${DRAFT_KEY_PREFIX}default`);
    expect(getDraftStorageKey(undefined)).toBe(`${DRAFT_KEY_PREFIX}default`);
  });
});

describe('P2.4: Tool-Call Pairing Normalizer', () => {
  it('prevents upstream 400 errors by closing open tool-calls before user messages', () => {
    const messages: CoreMessage[] = [
      { role: 'user', content: 'Scan the repo' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Scanning...' },
          { type: 'tool-call', toolCallId: 'tc_1', toolName: 'fs_list', args: { path: '.' } },
        ],
      },
      { role: 'user', content: 'Nevermind, do something else' },
    ];

    const paired = normalizeToolCallPairing(messages);
    expect(paired.length).toBe(4);
    expect(paired[2].role).toBe('tool');
    const content = paired[2].content as any[];
    expect(content[0].type).toBe('tool-result');
    expect(content[0].toolCallId).toBe('tc_1');
    expect(content[0].isError).toBe(true);
  });

  it('drops orphaned tool results with no prior tool calls', () => {
    const messages: CoreMessage[] = [
      { role: 'user', content: 'Hello' },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'orphan_99', toolName: 'fs_read', result: 'data' },
        ],
      },
      { role: 'assistant', content: 'Response' },
    ];

    const paired = normalizeToolCallPairing(messages);
    expect(paired.length).toBe(2);
    expect(paired[0].role).toBe('user');
    expect(paired[1].role).toBe('assistant');
  });

  it('normalizeMessageToolInvocations resolves pending calls allowing convertToCoreMessages to succeed', () => {
    const rawMessages = [
      {
        id: 'msg_1',
        role: 'assistant',
        content: 'Reading...',
        toolInvocations: [
          {
            toolCallId: 'tc_pending',
            toolName: 'fs_read',
            state: 'call',
            args: { path: 'secret.txt' },
          },
        ],
      },
    ];

    const fixed = normalizeMessageToolInvocations(rawMessages);
    expect(fixed[0].toolInvocations![0].state).toBe('result');

    // convertToCoreMessages will succeed without throwing
    const core = convertToCoreMessages(fixed as any);
    expect(core.length).toBe(2);
    expect(core[0].role).toBe('assistant');
    expect(core[1].role).toBe('tool');
  });
});

describe('P3.5: Immutable Audit Log', () => {
  const mockAuditDb = new Map<string, any>();

  beforeEach(() => {
    mockAuditDb.clear();
    vi.spyOn(db.auditLogs, 'add').mockImplementation((async (entry: any) => {
      mockAuditDb.set(entry.id, entry);
      return entry.id;
    }) as any);
    vi.spyOn(db.auditLogs, 'clear').mockImplementation((async () => {
      mockAuditDb.clear();
    }) as any);
    vi.spyOn(db.auditLogs, 'orderBy').mockImplementation(((_index: string) => {
      return {
        reverse: () => {
          const createQuery = (predicate?: (it: any) => boolean) => {
            return {
              filter: (nextPred: (it: any) => boolean) => {
                const combined = predicate ? (it: any) => predicate(it) && nextPred(it) : nextPred;
                return createQuery(combined);
              },
              limit: (n: number) => ({
                toArray: async () => {
                  let items = Array.from(mockAuditDb.values()).sort((a, b) => b.timestamp - a.timestamp);
                  if (predicate) items = items.filter(predicate);
                  return items.slice(0, n);
                },
              }),
              toArray: async () => {
                let items = Array.from(mockAuditDb.values()).sort((a, b) => b.timestamp - a.timestamp);
                if (predicate) items = items.filter(predicate);
                return items;
              },
            };
          };
          return createQuery();
        },
      };
    }) as any);
  });

  it('computes deterministic SHA-256 payload hashes', async () => {
    const hash1 = await computePayloadHash({ cmd: 'npm test', cwd: '/app' });
    const hash2 = await computePayloadHash({ cmd: 'npm test', cwd: '/app' });
    const hash3 = await computePayloadHash({ cmd: 'npm run build' });

    expect(hash1).toBeTruthy();
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });

  it('records and queries append-only audit log entries', async () => {
    const entry1 = await recordAuditLog({
      action: 'file_modification',
      tool: 'fs_edit',
      target: 'src/main.ts',
      decision: 'approved',
      payload: { search: 'foo', replace: 'bar' },
      chatId: 'session-1',
    });

    const entry2 = await recordAuditLog({
      action: 'shell_execution',
      tool: 'shell_run',
      target: 'npm run lint',
      decision: 'auto_approved',
      payload: { command: 'npm run lint' },
      chatId: 'session-1',
    });

    const entry3 = await recordAuditLog({
      action: 'rejection',
      tool: 'shell_run',
      target: 'rm -rf /',
      decision: 'rejected',
      chatId: 'session-2',
    });

    expect(entry1.id).toBeTruthy();
    expect(entry1.payloadHash).toBeTruthy();
    expect(entry2.decision).toBe('auto_approved');

    // Query all
    const all = await queryAuditLogs();
    expect(all.length).toBe(3);

    // Query filtered by tool
    const shellLogs = await queryAuditLogs({ tool: 'shell_run' });
    expect(shellLogs.length).toBe(2);

    // Query filtered by chatId
    const session1Logs = await queryAuditLogs({ chatId: 'session-1' });
    expect(session1Logs.length).toBe(2);

    // Query filtered by decision
    const rejections = await queryAuditLogs({ decision: 'rejected' });
    expect(rejections.length).toBe(1);
    expect(rejections[0].target).toBe('rm -rf /');
  });

  it('declares Dexie v19 schema with auditLogs table', () => {
    expect(db.auditLogs).toBeDefined();
    expect(db.verno).toBe(19);
  });
});

describe('P3.6: Policy-as-Data Scope & Dynamic MCP Enforcement', () => {
  it('matchesGlobPattern matches single and multi-level paths', () => {
    expect(matchesGlobPattern('src/index.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlobPattern('src/sub/index.ts', 'src/*.ts')).toBe(false);

    // Globstar /**/ khớp cả 0 cấp thư mục lẫn nhiều cấp
    expect(matchesGlobPattern('src/button.tsx', 'src/**/*.tsx')).toBe(true);
    expect(matchesGlobPattern('src/components/button.tsx', 'src/**/*.tsx')).toBe(true);
    expect(matchesGlobPattern('src/a/b/c/button.tsx', 'src/**/*.tsx')).toBe(true);
    expect(matchesGlobPattern('dist/bundle.js', 'src/**/*.js')).toBe(false);

    // Chuẩn hóa đường dẫn: './' ở đầu và backslash Windows
    expect(matchesGlobPattern('./src/button.tsx', 'src/**/*.tsx')).toBe(true);
    expect(matchesGlobPattern('src\\components\\button.tsx', 'src/**/*.tsx')).toBe(true);

    // Globstar ở đầu hoặc cuối
    expect(matchesGlobPattern('button.tsx', '**/*.tsx')).toBe(true);
    expect(matchesGlobPattern('src/button.tsx', '**/*.tsx')).toBe(true);
    expect(matchesGlobPattern('src', 'src/**')).toBe(true);
    expect(matchesGlobPattern('src/sub/file.ts', 'src/**')).toBe(true);

    // Env wildcard patterns
    expect(matchesGlobPattern('.env.local', '*.env*')).toBe(true);
    expect(matchesGlobPattern('config.env.production', '*.env*')).toBe(true);
  });

  it('extractTargetPath extracts path from various argument formats', () => {
    expect(extractTargetPath({ path: 'a.txt' })).toBe('a.txt');
    expect(extractTargetPath({ file: 'b.txt' })).toBe('b.txt');
    expect(extractTargetPath({ relPath: 'c.txt' })).toBe('c.txt');
    expect(extractTargetPath({ targetFile: 'd.txt' })).toBe('d.txt');
    expect(extractTargetPath('e.txt')).toBe('e.txt');
  });

  it('isDynamicMcpTool correctly classifies dynamic MCP tools vs built-in tools', () => {
    expect(isDynamicMcpTool('mcp__github__create_issue')).toBe(true);
    expect(isDynamicMcpTool('mcp__postgres__execute_query')).toBe(true);
    expect(isDynamicMcpTool('mcp__server-name__tool.name')).toBe(true);
    expect(isDynamicMcpTool('mcp')).toBe(false);
    expect(isDynamicMcpTool('tools_search')).toBe(false);
    expect(isDynamicMcpTool('fs_read')).toBe(false);
    expect(isDynamicMcpTool('shell_run')).toBe(false);
  });

  it('shouldAutoApprove enforces deny-by-default for dynamic MCP tools even in never (YOLO) mode', () => {
    // Unapproved dynamic MCP tool with empty permissions
    expect(
      shouldAutoApprove({
        toolName: 'mcp__github__delete_repo',
        args: { repo: 'important' },
        policy: 'never',
        autoPilotEnabled: true,
        toolPermissions: {},
      }),
    ).toBe(false);

    // Unapproved dynamic MCP tool without toolPermissions passed
    expect(
      shouldAutoApprove({
        toolName: 'mcp__filesystem__write_file',
        args: { path: 'root.txt' },
        policy: 'never',
        autoPilotEnabled: true,
      }),
    ).toBe(false);

    // Approved dynamic MCP tool via explicit tool override
    expect(
      shouldAutoApprove({
        toolName: 'mcp__github__create_issue',
        args: { title: 'Bug' },
        policy: 'never',
        autoPilotEnabled: true,
        toolPermissions: {
          mcp__github__create_issue: 'auto',
        },
      }),
    ).toBe(true);

    // Approved dynamic MCP tool via mcp group override
    expect(
      shouldAutoApprove({
        toolName: 'mcp__github__create_issue',
        args: { title: 'Bug' },
        policy: 'never',
        autoPilotEnabled: true,
        toolPermissions: {
          mcp: 'auto',
        },
      }),
    ).toBe(true);
  });

  it('shouldAutoApprove respects path glob pattern permissions', () => {
    const perms = {
      'fs_write:src/**/*.ts': 'auto' as const,
      'fs_write:*.env*': 'deny' as const,
    };

    // Safe path matches auto
    expect(
      shouldAutoApprove({
        toolName: 'fs_write',
        args: { path: 'src/models/user.ts' },
        policy: 'smart',
        autoPilotEnabled: true,
        toolPermissions: perms,
      }),
    ).toBe(true);

    // Sensitive path matches deny
    expect(
      shouldAutoApprove({
        toolName: 'fs_write',
        args: { path: '.env.production' },
        policy: 'never',
        autoPilotEnabled: true,
        toolPermissions: perms,
      }),
    ).toBe(false);
  });
});
