/**
 * Comprehensive Vitest test suite for Visual Inspection modules.
 * Tests DiffViewer, FlowSketchGenerator, CodeShapeExtractor, ShowMeBuilder,
 * CyberneticControlLoop, and InstructionOptimizer.
 */

import { describe, it, expect } from 'vitest';
import {
  DiffViewer,
  FlowSketchGenerator,
  CodeShapeExtractor,
  ShowMeBuilder,
  CyberneticControlLoop,
  InstructionOptimizer,
  VisualDiffVisualizer,
  type FlowSketchNode,
} from '../lib/teamwork/visual';
import type { ApprovalRequest } from '../lib/teamwork/hitl';

describe('DiffViewer - Unified Diff & Danger Detection', () => {
  it('should compute line additions, deletions, and hunks correctly', () => {
    const oldContent = `line 1\nline 2\nline 3\nline 4`;
    const newContent = `line 1\nline 2 modified\nline 3\nline 4\nline 5 added`;

    const result = DiffViewer.renderUnifiedDiff('src/sample.ts', oldContent, newContent);

    expect(result.filePath).toBe('src/sample.ts');
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(1);
    expect(result.totalChanges).toBe(3);
    expect(result.isBinary).toBe(false);

    expect(result.diffText).toContain('--- a/src/sample.ts');
    expect(result.diffText).toContain('+++ b/src/sample.ts');
    expect(result.diffText).toContain('-line 2');
    expect(result.diffText).toContain('+line 2 modified');
    expect(result.diffText).toContain('+line 5 added');
    expect(result.hunks.length).toBeGreaterThan(0);
    expect(result.hunks[0].header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  });

  it('should handle completely new file creation (oldContent is null)', () => {
    const newContent = `export const hello = "world";\nconsole.log(hello);`;
    const result = DiffViewer.renderUnifiedDiff('src/new-file.ts', null, newContent);

    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(0);
    expect(result.diffText).toContain('--- a/src/new-file.ts');
    expect(result.diffText).toContain('+++ b/src/new-file.ts');
    expect(result.diffText).toContain('+export const hello');
  });

  it('should detect danger flags when sensitive keys or destructive commands are modified/deleted', () => {
    const oldContent = `const apiKey = "sk-1234567890";\nrm -rf /tmp/data\nprocess.exit(1);\nconsole.log("normal");`;
    const newContent = `console.log("normal");`;

    const result = DiffViewer.renderUnifiedDiff('config.ts', oldContent, newContent);

    expect(result.deletions).toBe(3);
    expect(result.dangerFlags.length).toBeGreaterThanOrEqual(2);
    expect(result.dangerFlags.some((f) => f.includes('secret/key deletion'))).toBe(true);
    expect(result.dangerFlags.some((f) => f.includes('Destructive command'))).toBe(true);
  });

  it('should detect binary content and produce a safe summary without dumping data', () => {
    const binaryData = `GIF89a\x00\x01\x00\x02\x00\x00`;
    const result = DiffViewer.renderUnifiedDiff('assets/logo.gif', null, binaryData);

    expect(result.isBinary).toBe(true);
    expect(result.diffText).toContain('Binary files differ');
    expect(result.dangerFlags).toContain('Binary file modification detected');
  });

  it('should render colorized ANSI output when color option is true', () => {
    const oldContent = `const a = 1;`;
    const newContent = `const a = 2;`;

    const result = DiffViewer.renderUnifiedDiff('index.ts', oldContent, newContent, { color: true });
    expect(result.diffText).toContain('\x1b['); // contains ANSI escapes
  });

  it('should truncate output if diff exceeds maxLines', () => {
    const oldLines = Array.from({ length: 50 }, (_, i) => `old line ${i}`).join('\n');
    const newLines = Array.from({ length: 50 }, (_, i) => `new line ${i}`).join('\n');

    const result = DiffViewer.renderUnifiedDiff('large.txt', oldLines, newLines, { maxLines: 15 });
    expect(result.diffText).toContain('[diff truncated at 15 lines]');
  });
});

describe('FlowSketchGenerator - ASCII & Unicode DAG Diagrams', () => {
  const sampleNodes: FlowSketchNode[] = [
    { id: 'M1', name: 'Scope & Plan', status: 'completed' },
    { id: 'M2', name: 'HITL Gate', status: 'interrupted', dependsOn: ['M1'] },
    { id: 'M3', name: 'Visualizer', status: 'running', dependsOn: ['M1'] },
    { id: 'M4', name: 'Critic Review', status: 'pending', dependsOn: ['M2', 'M3'] },
  ];

  it('should render a clean Unicode DAG flow sketch with stage waves and status symbols', () => {
    const sketch = FlowSketchGenerator.renderFlowSketch(sampleNodes, 'M3');

    expect(sketch).toContain('WORKFLOW EXECUTION GRAPH');
    expect(sketch).toContain('Stage 1:');
    expect(sketch).toContain('Stage 2:');
    expect(sketch).toContain('Stage 3:');
    expect(sketch).toContain('✓ M1 (Scope & Plan)');
    expect(sketch).toContain('⧗ M2 (HITL Gate) ⧗ GATE PENDING');
    expect(sketch).toContain('► M3 (Visualizer) ★ ACTIVE');
    expect(sketch).toContain('○ M4 (Critic Review)');
    expect(sketch).toContain('▼');
  });

  it('should render clean ASCII flow sketch when format is ascii', () => {
    const sketch = FlowSketchGenerator.renderFlowSketch(sampleNodes, 'M3', { format: 'ascii' });

    expect(sketch).toContain('=== WORKFLOW EXECUTION GRAPH ===');
    expect(sketch).toContain('Wave 1:');
    expect(sketch).toContain('[X] M1 (Scope & Plan)');
    expect(sketch).toContain('[!] M2 (HITL Gate) <! GATE PENDING>');
    expect(sketch).toContain('[>] M3 (Visualizer) <ACTIVE>');
    expect(sketch).toContain('[ ] M4 (Critic Review)');
    expect(sketch).toContain('|');
    expect(sketch).toContain('v');
  });

  it('should handle empty workflow nodes gracefully', () => {
    const unicodeSketch = FlowSketchGenerator.renderFlowSketch([]);
    expect(unicodeSketch).toContain('empty workflow');

    const asciiSketch = FlowSketchGenerator.renderFlowSketch([], undefined, { format: 'ascii' });
    expect(asciiSketch).toContain('(empty workflow)');
  });
});

describe('CodeShapeExtractor - Structural Outline Extractor', () => {
  it('should extract classes, constructors, methods, interfaces, types, and functions', () => {
    const sourceCode = `
import { Config } from './types';

export interface UserProfile {
  id: string;
  name: string;
  getRole(): string;
}

export type RoleType = 'admin' | 'user';

export enum StatusEnum {
  ACTIVE,
  INACTIVE,
}

export class UserManager implements UserProfile {
  id: string;
  name: string;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  public getRole(): string {
    return 'admin';
  }

  private async fetchRemote(url: string): Promise<boolean> {
    return true;
  }

  public static createDefault(): UserManager {
    return new UserManager('1', 'default');
  }
}

export async function processUsers(users: UserManager[]): Promise<void> {
  // process
}

export const calculateScore = (count: number): number => count * 10;
`;

    const outline = CodeShapeExtractor.extract('lib/user-manager.ts', sourceCode);

    expect(outline.filePath).toBe('lib/user-manager.ts');
    expect(outline.items.length).toBeGreaterThanOrEqual(5);

    // Verify Interface
    const iface = outline.items.find((i) => i.name === 'UserProfile' && i.type === 'interface');
    expect(iface).toBeDefined();
    expect(iface?.exported).toBe(true);

    // Verify Type
    const typeAlias = outline.items.find((i) => i.name === 'RoleType' && i.type === 'type');
    expect(typeAlias).toBeDefined();

    // Verify Enum
    const enumItem = outline.items.find((i) => i.name === 'StatusEnum' && i.type === 'enum');
    expect(enumItem).toBeDefined();

    // Verify Class and Methods
    const cls = outline.items.find((i) => i.name === 'UserManager' && i.type === 'class');
    expect(cls).toBeDefined();
    expect(cls?.children).toBeDefined();
    expect(cls?.children?.some((m) => m.name === 'constructor')).toBe(true);
    expect(cls?.children?.some((m) => m.name === 'getRole')).toBe(true);
    expect(cls?.children?.some((m) => m.name === 'fetchRemote' && m.signature.includes('[private]'))).toBe(true);
    expect(cls?.children?.some((m) => m.name === 'createDefault' && m.signature.includes('[static]'))).toBe(true);

    // Verify Functions
    const fn = outline.items.find((i) => i.name === 'processUsers' && i.type === 'function');
    expect(fn).toBeDefined();
    expect(fn?.signature).toContain('[async]');

    const arrowFn = outline.items.find((i) => i.name === 'calculateScore' && i.type === 'function');
    expect(arrowFn).toBeDefined();

    // Verify formatted text output
    expect(outline.formatted).toContain('Outline: lib/user-manager.ts');
    expect(outline.formatted).toContain('[class] [export] UserManager');
    expect(outline.formatted).toContain('[interface] [export] UserProfile');
  });
});

describe('ShowMeBuilder - Standardized Markdown Artifacts', () => {
  it('should assemble a complete <show-me> inspection report with risk badge and sections', () => {
    const markdown = ShowMeBuilder.build({
      actionTitle: 'Write Core Config',
      workerId: 'worker_m2',
      target: 'package.json',
      severity: 'CRITICAL',
      riskScore: 90,
      riskReasons: ['Target package.json is a protected root configuration', 'Diff exceeds 50 lines'],
      description: 'Updating dependencies and adding script hooks.',
      flowSketch: 'Stage 1: [✓ M1] ──► [⧗ M2]',
      codeShape: 'Outline: package.json\n  └── dependencies',
      diff: {
        filePath: 'package.json',
        additions: 15,
        deletions: 2,
        totalChanges: 17,
        diffText: '--- a/package.json\n+++ b/package.json\n@@ -1,2 +1,3 @@\n- old\n+ new',
        hunks: [],
        isBinary: false,
        dangerFlags: ['Modified core dependency'],
        summary: 'package.json (+15, -2)',
      },
      proposedCommand: 'npm install --save-dev vitest',
    });

    expect(markdown).toContain('<show-me>');
    expect(markdown).toContain('</show-me>');
    expect(markdown).toContain('🔴 CRITICAL RISK (90/100)');
    expect(markdown).toContain('`package.json`');
    expect(markdown).toContain('`worker_m2`');
    expect(markdown).toContain('### ⚠️ Risk Factors & Security Triggers');
    expect(markdown).toContain('Target package.json is a protected root configuration');
    expect(markdown).toContain('### 🗺️ Workflow Position & DAG State');
    expect(markdown).toContain('### 📐 Code-Shape Structural Outline');
    expect(markdown).toContain('### 📝 Visual Unified Diff (+15 / -2)');
    expect(markdown).toContain('### 💻 Shell Command Line');
    expect(markdown).toContain('npm install --save-dev vitest');
    expect(markdown).toContain('### 🔘 Decision Options');
    expect(markdown).toContain('APPROVED');
    expect(markdown).toContain('REJECTED');
    expect(markdown).toContain('MODIFIED');
  });

  it('should implement buildShowMeArtifact for ApprovalRequest conforming to PROJECT.md interface', () => {
    const request: ApprovalRequest = {
      id: 'req_001',
      token: 'hitl_v1.token',
      action: 'shell_exec',
      severity: 'HIGH',
      description: 'Run destructive cleanup',
      target: 'rm -rf node_modules',
      riskScore: 75,
      riskReasons: ['Destructive command execution'],
      state: 'PENDING_APPROVAL',
      createdAt: Date.now(),
      metadata: { workerId: 'worker_shell', command: 'rm -rf node_modules' },
    };

    const visualizer = new VisualDiffVisualizer();
    const artifact = visualizer.buildShowMeArtifact(request);

    expect(artifact).toContain('<show-me>');
    expect(artifact).toContain('🟠 HIGH RISK (75/100)');
    expect(artifact).toContain('rm -rf node_modules');
    expect(artifact).toContain('worker_shell');
  });
});

describe('CyberneticControlLoop - Sensor, Controller, Actuator & Disturbance', () => {
  it('should trigger HALT_429 when sensor telemetry indicates rate limit 429', () => {
    const loop = new CyberneticControlLoop();
    const telemetry = loop.sense({
      rateLimitStatus: 'BLOCKED_429',
    });

    const decision = loop.control(telemetry, { requiredCriticVerdict: 'PASS' });

    expect(decision.action).toBe('HALT_429');
    expect(decision.errorDelta).toBe(100);
    expect(decision.recommendedDelayMs).toBe(60000);

    const disturbances = loop.getDisturbances();
    expect(disturbances.some((d) => d.type === 'RATE_LIMIT_429')).toBe(true);
  });

  it('should trigger RETRY when target file is locked by another worker', () => {
    const loop = new CyberneticControlLoop();
    const telemetry = loop.sense({
      activeLocks: ['lib/teamwork/engine.ts'],
    });

    const decision = loop.control(telemetry, {
      requiredCriticVerdict: 'PASS',
      targetFiles: ['lib/teamwork/engine.ts'],
    });

    expect(decision.action).toBe('RETRY');
    expect(decision.target).toBe('lib/teamwork/engine.ts');

    const disturbances = loop.getDisturbances();
    expect(disturbances.some((d) => d.type === 'LOCK_CONTENTION')).toBe(true);
  });

  it('should trigger ABORT when consecutive failures exceed circuit breaker limit', () => {
    const loop = new CyberneticControlLoop();
    const telemetry = loop.sense({
      consecutiveFailures: 3,
    });

    const decision = loop.control(telemetry, {
      requiredCriticVerdict: 'PASS',
      maxConsecutiveFailures: 3,
    });

    expect(decision.action).toBe('ABORT');
    expect(decision.reason).toContain('Circuit breaker tripped');
  });

  it('should trigger REMEDIATE when Critic returns FAIL-BLOCKED', () => {
    const loop = new CyberneticControlLoop();
    const telemetry = loop.sense({
      criticVerdict: 'FAIL-BLOCKED',
      lastExitCode: 1,
    });

    const decision = loop.control(telemetry, { requiredCriticVerdict: 'PASS' });

    expect(decision.action).toBe('REMEDIATE');
    expect(decision.errorDelta).toBe(50);
    expect(decision.instructions).toContain('Analyze Critic test output');
  });

  it('should trigger PROCEED with zero error delta when Critic passes', () => {
    const loop = new CyberneticControlLoop();
    const telemetry = loop.sense({
      criticVerdict: 'PASS',
      lastExitCode: 0,
    });

    const decision = loop.control(telemetry, { requiredCriticVerdict: 'PASS' });

    expect(decision.action).toBe('PROCEED');
    expect(decision.errorDelta).toBe(0);
  });

  it('should record execution telemetry via actuator', async () => {
    const loop = new CyberneticControlLoop();

    const { result, execution } = await loop.act('test_tool', async () => {
      return 42;
    });

    expect(result).toBe(42);
    expect(execution.tool).toBe('test_tool');
    expect(execution.success).toBe(true);
    expect(execution.output).toBe(42);
    expect(execution.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('InstructionOptimizer - Dynamic <important if> Parser', () => {
  it('should conditionally include or omit blocks based on boolean state variables', () => {
    const template = `
Base instruction.
<important if="isRetry">
This is a retry attempt! Do not repeat previous mistakes.
</important>
<important if="!isRetry">
First attempt: proceed with caution.
</important>
Final remarks.
`;

    const retryPrompt = InstructionOptimizer.optimizePrompt(template, { isRetry: true });
    expect(retryPrompt).toContain('This is a retry attempt!');
    expect(retryPrompt).not.toContain('First attempt: proceed with caution.');

    const firstAttemptPrompt = InstructionOptimizer.optimizePrompt(template, { isRetry: false });
    expect(firstAttemptPrompt).not.toContain('This is a retry attempt!');
    expect(firstAttemptPrompt).toContain('First attempt: proceed with caution.');
  });

  it('should evaluate numeric comparisons in conditions', () => {
    const template = `
<important if="attempt > 1">
High attempt count warning!
</important>
<important if="attempt <= 1">
Standard execution.
</important>
`;

    const prompt1 = InstructionOptimizer.optimizePrompt(template, { attempt: 2 });
    expect(prompt1).toContain('High attempt count warning!');
    expect(prompt1).not.toContain('Standard execution.');

    const prompt2 = InstructionOptimizer.optimizePrompt(template, { attempt: 1 });
    expect(prompt2).not.toContain('High attempt count warning!');
    expect(prompt2).toContain('Standard execution.');
  });

  it('should evaluate string equality in conditions', () => {
    const template = `
<important if="criticVerdict == 'FAIL-BLOCKED'">
CRITIC HAS BLOCKED: Remediate failing tests immediately!
</important>
<important if="criticVerdict == 'PASS'">
Critic verified: Ready to advance milestone.
</important>
`;

    const failedPrompt = InstructionOptimizer.optimizePrompt(template, { criticVerdict: 'FAIL-BLOCKED' });
    expect(failedPrompt).toContain('CRITIC HAS BLOCKED');
    expect(failedPrompt).not.toContain('Critic verified');

    const passedPrompt = InstructionOptimizer.optimizePrompt(template, { criticVerdict: 'PASS' });
    expect(passedPrompt).not.toContain('CRITIC HAS BLOCKED');
    expect(passedPrompt).toContain('Critic verified');
  });
});
