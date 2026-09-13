import { describe, it, expect, vi } from 'vitest';
import {
  SKILLS_CATALOG,
  matchSkillsForRequest,
  generateSkillsPrompt,
} from '@/lib/skills/catalog';
import { searchAstCode, code_search_ast } from '@/lib/ast-search';
import { buildCodeGraph, codegraph_uml } from '@/lib/codegraph';
import { parseProjectTerms, checkTermsFreshness } from '@/lib/project-terms';
import { dispatchFanout, type FanoutDispatchEvent } from '@/lib/fanout/dispatch';
import type { FanoutContract } from '@/lib/fanout/contract';

describe('P1-E Fanout Dispatcher with Dependency Frontier & Retry', () => {
  it('dispatches units along the dependency frontier and produces verified results', async () => {
    const contract: FanoutContract = {
      id: 'fanout-test-1',
      goalDigest: 'goal-digest-abc',
      baseRevision: 'git-rev-123456',
      safetyProfileRevision: 'profile-v1',
      units: [
        {
          id: 'unit-core',
          title: 'Core Module',
          owner: 'subagent',
          fileScope: ['src/core.ts'],
          dependsOn: [],
          doneCriteria: ['Core module built'],
        },
        {
          id: 'unit-feature',
          title: 'Feature Module',
          owner: 'subagent',
          fileScope: ['src/feature.ts'],
          dependsOn: ['unit-core'],
          doneCriteria: ['Feature depends on core'],
        },
      ],
      mergeOrder: [],
    };

    const events: FanoutDispatchEvent[] = [];
    const summary = await dispatchFanout({
      contract,
      onEvent: (e) => events.push(e),
      executeUnit: async (unit) => {
        return {
          success: true,
          exitCode: 0,
          stdoutTail: `Unit ${unit.id} success`,
          telemetry: { elapsedSec: 0.05, tokensIn: 100, tokensOut: 50, costUsd: 0.001 },
        };
      },
    });

    expect(summary.success).toBe(true);
    expect(summary.completedUnits).toBe(2);
    expect(summary.failedUnits).toBe(0);
    expect(summary.results['unit-core'].evidence).toBe('verified');
    expect(summary.results['unit-feature'].evidence).toBe('verified');
    expect(summary.mergeOrder).toEqual(['unit-core', 'unit-feature']);

    expect(events.some((e) => e.type === 'contract_started')).toBe(true);
    expect(events.some((e) => e.type === 'unit_completed' && e.unitId === 'unit-core')).toBe(true);
    expect(events.some((e) => e.type === 'contract_completed')).toBe(true);
  });

  it('handles transient errors and retries when probe is replay-safe', async () => {
    const contract: FanoutContract = {
      id: 'fanout-retry-test',
      goalDigest: 'goal-digest-1',
      baseRevision: 'git-rev-1',
      safetyProfileRevision: 'p1',
      units: [
        {
          id: 'u-rate-limit',
          title: 'Rate Limit Unit',
          owner: 'subagent',
          fileScope: ['src/api.ts'],
          dependsOn: [],
          doneCriteria: ['Done'],
        },
      ],
      mergeOrder: [],
    };

    let attempts = 0;
    const events: FanoutDispatchEvent[] = [];

    const summary = await dispatchFanout({
      contract,
      onEvent: (e) => events.push(e),
      executeUnit: async () => {
        attempts++;
        if (attempts === 1) {
          return {
            success: false,
            error: new Error('Rate limit exceeded 429'),
            probeState: { filesModified: 0, bytesWritten: 0 },
          };
        }
        return {
          success: true,
          exitCode: 0,
        };
      },
    });

    expect(summary.success).toBe(true);
    expect(attempts).toBe(2);
    expect(events.some((e) => e.type === 'unit_retrying')).toBe(true);
    expect(summary.results['u-rate-limit'].evidence).toBe('verified');
  });

  it('gracefully aborts when signal is cancelled', async () => {
    const contract: FanoutContract = {
      id: 'fanout-abort-test',
      goalDigest: 'goal-digest-1',
      baseRevision: 'git-rev-1',
      safetyProfileRevision: 'p1',
      units: [
        {
          id: 'u-hang',
          title: 'Hanging Unit',
          owner: 'subagent',
          fileScope: ['src/hang.ts'],
          dependsOn: [],
          doneCriteria: ['Done'],
        },
      ],
      mergeOrder: [],
    };

    const controller = new AbortController();
    controller.abort();

    const summary = await dispatchFanout({
      contract,
      signal: controller.signal,
      executeUnit: async () => {
        return { success: true, exitCode: 0 };
      },
    });

    expect(summary.interrupted).toBe(true);
  });

  it('stops and records retries_exhausted when transient retries exceed maxRetries', async () => {
    const contract: FanoutContract = {
      id: 'fanout-exhausted-test',
      goalDigest: 'goal-digest-ex',
      baseRevision: 'git-rev-ex',
      safetyProfileRevision: 'p1',
      units: [
        {
          id: 'u-exhaust',
          title: 'Exhaust Unit',
          owner: 'subagent',
          fileScope: ['src/exhaust.ts'],
          dependsOn: [],
          doneCriteria: ['Done'],
        },
      ],
      mergeOrder: [],
    };

    let attempts = 0;
    const summary = await dispatchFanout({
      contract,
      maxRetries: 2,
      baseBackoffMs: 1, // Quick backoff for unit tests
      executeUnit: async () => {
        attempts++;
        return {
          success: false,
          error: new Error('Rate limit 429 Too Many Requests'),
          probeState: { filesModified: 0, bytesWritten: 0 },
        };
      },
    });

    expect(summary.success).toBe(false);
    expect(attempts).toBe(3); // 1 initial + 2 retries
    expect(summary.results['u-exhaust'].evidence).toBe('reported_done');
    expect(summary.results['u-exhaust'].retry?.attempts).toBe(3);
    expect(summary.results['u-exhaust'].retry?.stoppedBecause).toBe('retries_exhausted');
  });

  it('blocks execution with spawn_ceiling_reached when maxSpawns limit is hit', async () => {
    const contract: FanoutContract = {
      id: 'fanout-ceiling-test',
      goalDigest: 'goal-digest-ceil',
      baseRevision: 'git-rev-ceil',
      safetyProfileRevision: 'p1',
      units: [
        {
          id: 'u-ceil-1',
          title: 'Unit 1',
          owner: 'subagent',
          fileScope: ['src/c1.ts'],
          dependsOn: [],
          doneCriteria: ['Done 1'],
        },
        {
          id: 'u-ceil-2',
          title: 'Unit 2',
          owner: 'subagent',
          fileScope: ['src/c2.ts'],
          dependsOn: [],
          doneCriteria: ['Done 2'],
        },
      ],
      mergeOrder: [],
    };

    const summary = await dispatchFanout({
      contract,
      maxSpawns: 1, // Ceiling allows only 1 spawn
      executeUnit: async () => {
        return { success: true, exitCode: 0 };
      },
    });

    expect(summary.success).toBe(false);
    const stoppedUnits = Object.values(summary.results).filter(
      (r) => r.retry?.stoppedBecause === 'spawn_ceiling_reached',
    );
    expect(stoppedUnits.length).toBeGreaterThanOrEqual(1);
    expect(stoppedUnits[0].evidence).toBe('blocked');
  });

  it('throws fanout_depth_exceeded when fanoutDepth > 1 is requested', async () => {
    const contract: FanoutContract = {
      id: 'fanout-depth-test',
      goalDigest: 'goal-digest-d',
      baseRevision: 'git-rev-d',
      safetyProfileRevision: 'p1',
      units: [
        {
          id: 'u-d',
          title: 'Unit Depth',
          owner: 'subagent',
          fileScope: ['src/d.ts'],
          dependsOn: [],
          doneCriteria: ['Done'],
        },
      ],
      mergeOrder: [],
    };

    await expect(
      dispatchFanout({
        contract,
        fanoutDepth: 2,
        executeUnit: async () => ({ success: true, exitCode: 0 }),
      }),
    ).rejects.toThrow('fanout_depth_exceeded');
  });
});

describe('P2 Skills Catalog & Request Matcher', () => {
  it('contains curated skills covering the full stack', () => {
    const ids = SKILLS_CATALOG.map((s) => s.id);
    expect(ids).toContain('next-app-router');
    expect(ids).toContain('react-perf');
    expect(ids).toContain('tailwind-ui');
    expect(ids).toContain('dexie-migration');
    expect(ids).toContain('vitest');
    expect(ids).toContain('security-review');
    expect(ids).toContain('api-route-hardening');
    expect(ids).toContain('refactor-plan');
  });

  it('matches skills based on explicit keywords and triggers', () => {
    const matched = matchSkillsForRequest('Cần tối ưu App Router và route handler streaming trong Next.js');
    expect(matched.some((s) => s.id === 'next-app-router')).toBe(true);

    const matchedDexie = matchSkillsForRequest('Cần nâng cấp database schema Dexie và migration IndexedDB');
    expect(matchedDexie.some((s) => s.id === 'dexie-migration')).toBe(true);
  });

  it('generates rich instruction prompts for matched skills', () => {
    const matched = matchSkillsForRequest('viết unit test vitest');
    const prompt = generateSkillsPrompt(matched);
    expect(prompt).toContain('KỸ NĂNG CHUYÊN MÔN KÍCH HOẠT');
    expect(prompt).toContain('Vitest Unit & Integration Testing');
  });
});

describe('P2 Structural Search & Ast-grep Fallback', () => {
  const sampleFiles = [
    {
      path: 'src/components/button.tsx',
      content: 'export function Button() {\n  return <button className="btn">Click me</button>;\n}',
    },
    {
      path: 'src/lib/utils.ts',
      content: 'export function formatDate(d: Date): string {\n  return d.toISOString();\n}',
    },
  ];

  it('finds code occurrences across files using structural matching', () => {
    const result = searchAstCode({
      query: 'function Button()',
      files: sampleFiles,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].file).toBe('src/components/button.tsx');
    expect(result.matches[0].line).toBe(1);
  });

  it('handles exhaustive_search flag to ensure full sweep without skipping', () => {
    const result = searchAstCode({
      query: 'export function',
      files: sampleFiles,
      exhaustive: true,
    });

    expect(result.matches).toHaveLength(2);
    expect(result.exhaustiveCompleted).toBe(true);
  });

  it('matches patterns with metavariables $NAME and $$$ using code_search_ast alias', () => {
    const result = code_search_ast({
      query: 'function $NAME($$$)',
      files: sampleFiles,
    });

    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    expect(result.matches.some((m) => m.file === 'src/components/button.tsx')).toBe(true);
    expect(result.matches.some((m) => m.file === 'src/lib/utils.ts')).toBe(true);
  });
});

describe('P2 Codegraph & Dependency Cycle Detection', () => {
  it('detects circular import dependencies and assigns high severity finding', () => {
    const cyclicFiles = [
      {
        path: 'src/a.ts',
        content: "import { b } from './b';\nexport const a = 1;",
      },
      {
        path: 'src/b.ts',
        content: "import { a } from './a';\nexport const b = 2;",
      },
    ];

    const graph = buildCodeGraph(cyclicFiles);
    expect(graph.cycles.length).toBeGreaterThan(0);
    expect(graph.findings.some((f) => f.type === 'cycle' && f.severity === 'high')).toBe(true);
    expect(graph.mermaid).toContain('graph TD');
  });

  it('identifies god modules with excessive imports', () => {
    const godFile = {
      path: 'src/god.ts',
      content: Array.from({ length: 12 }, (_, i) => `import { x } from './mod${i}';`).join('\n'),
    };
    const modFiles = Array.from({ length: 12 }, (_, i) => ({
      path: `src/mod${i}.ts`,
      content: 'export const x = 1;',
    }));

    const graph = buildCodeGraph([godFile, ...modFiles]);
    expect(graph.findings.some((f) => f.type === 'god_module')).toBe(true);
  });

  it('resolves exact relative paths correctly without false-positive substring matches and exposes codegraph_uml alias', () => {
    const files = [
      { path: 'src/b.ts', content: 'export const b = 1;' },
      { path: 'src/button.ts', content: 'export const button = 2;' },
      { path: 'src/consumer.ts', content: "import { b } from './b';\nimport { button } from './button';" },
    ];

    const graph = codegraph_uml(files);
    const consumerNode = graph.nodes['src/consumer.ts'];
    expect(consumerNode.imports).toContain('src/b.ts');
    expect(consumerNode.imports).toContain('src/button.ts');
    expect(graph.nodes['src/b.ts'].importedBy).toContain('src/consumer.ts');
    expect(graph.nodes['src/button.ts'].importedBy).toContain('src/consumer.ts');
  });
});

describe('P2 PROJECT_TERMS Strict Parser & Freshness Checker', () => {
  const validTerms = `# Project Terms

## domain: architecture
- Agent HUD -> Bảng điều khiển quan sát thời gian thực
  author: vyen-team
  category: ui
- Evidence Ladder: Thang 4 mức chứng minh độ hoàn thành

## domain: testing
- Behavior-locked: Khóa hành vi bằng bài kiểm thử hồi quy
`;

  it('successfully parses valid terms file with strict grammar and calculates SHA-256', () => {
    const res = parseProjectTerms(validTerms);
    expect(res.ok).toBe(true);
    expect(res.file?.domains).toEqual(['architecture', 'testing']);
    expect(res.file?.terms.length).toBe(3);
    expect(res.file?.terms[0].phrase).toBe('Agent HUD');
    expect(res.file?.terms[0].canonical).toBe('Bảng điều khiển quan sát thời gian thực');
    expect(res.file?.terms[0].metadata?.author).toBe('vyen-team');
    expect(res.file?.digest.length).toBe(64);
    expect(res.file?.freshness).toBe('unchanged');
  });

  it('rejects files containing Byte Order Mark (BOM)', () => {
    const bomBuffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(validTerms)]);
    const res = parseProjectTerms(bomBuffer);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Byte Order Mark (BOM)');
  });

  it('rejects mixed line endings (CRLF and LF mixed)', () => {
    const mixed = '# Project Terms\r\n## domain: general\nterm: canonical\r\n';
    const res = parseProjectTerms(mixed);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Line-ending không thuần nhất');
  });

  it('rejects files exceeding 64KB limit', () => {
    const huge = '# Project Terms\n' + 'x'.repeat(70 * 1024);
    const res = parseProjectTerms(huge);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('64KB');
  });

  it('rejects invalid preamble', () => {
    const invalidHeader = '# Random Header\n## domain: test\nx: y\n';
    const res = parseProjectTerms(invalidHeader);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Preamble cố định không hợp lệ');
  });

  it('rejects malformed syntax lines failing closed without losing audit info', () => {
    const malformed = `# Project Terms\n\n## domain: general\nThis is just a random line without mapping\n`;
    const res = parseProjectTerms(malformed);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Định dạng thuật ngữ không hợp lệ');
  });

  it('rejects invalid metadata indentation (1 space, 3 spaces, tabs)', () => {
    const badIndent1 = `# Project Terms\n\n## domain: general\n- term -> canonical\n author: vyen\n`;
    const res1 = parseProjectTerms(badIndent1);
    expect(res1.ok).toBe(false);
    expect(res1.error).toContain('Metadata phải thụt lề đúng 2 dấu cách');

    const badIndent3 = `# Project Terms\n\n## domain: general\n- term -> canonical\n   author: vyen\n`;
    const res3 = parseProjectTerms(badIndent3);
    expect(res3.ok).toBe(false);
    expect(res3.error).toContain('Metadata phải thụt lề đúng 2 dấu cách');

    const badIndentTab = `# Project Terms\n\n## domain: general\n- term -> canonical\n\tauthor: vyen\n`;
    const resTab = parseProjectTerms(badIndentTab);
    expect(resTab.ok).toBe(false);
    expect(resTab.error).toContain('Metadata phải thụt lề đúng 2 dấu cách');
  });

  it('rejects metadata not preceded by a term in the same domain', () => {
    const orphanMeta = `# Project Terms\n\n## domain: general\n  author: vyen\n- term -> canonical\n`;
    const res = parseProjectTerms(orphanMeta);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Metadata phải nằm ngay sau một thuật ngữ');
  });

  it('evaluates checkTermsFreshness for unchanged, changed, missing, and untracked states', () => {
    const content = '# Project Terms\n## domain: test\n- a -> b\n';
    const parsed = parseProjectTerms(content);
    expect(parsed.ok).toBe(true);
    const digest = parsed.file!.digest;

    // unchanged
    expect(checkTermsFreshness(content, digest)).toBe('unchanged');
    expect(checkTermsFreshness(parsed.file!, digest)).toBe('unchanged');

    // changed
    expect(checkTermsFreshness(content + '\n', digest)).toBe('changed');

    // missing
    expect(checkTermsFreshness(null, digest)).toBe('missing');
    expect(checkTermsFreshness(undefined, digest)).toBe('missing');

    // untracked
    expect(checkTermsFreshness(content)).toBe('untracked');
    expect(checkTermsFreshness(content, '')).toBe('untracked');
  });
});
