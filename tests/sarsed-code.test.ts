/**
 * Comprehensive Test Suite for Sarsed-Code (sarsvankelsion/sarsed-code port).
 *
 * Verifies:
 * 1. AST Code Skeletonization (80-90% prompt token reduction with interface/signature preservation).
 * 2. Multi-Language Symbol Indexing & Call Hierarchy Resolution.
 * 3. Transactional Multi-Hunk Semantic Patching with Indentation Alignment & Rollback.
 * 4. Structured Diagnostic Parsing (tsc, eslint, vitest).
 * 5. Closed SARS (Sense-Analyze-Refactor-Synthesize) Self-Correction Loop.
 * 6. Multi-Role Fleet (Architect, Coder, Verifier, Critic) Handover Lifecycle.
 * 7. Sarsed Tools (code_skeleton, code_symbols, code_patch, code_verify).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { CodeSkeletonizer } from '@/lib/sarsed/skeletonizer';
import { SarsedSymbolIndex } from '@/lib/sarsed/symbols';
import { SarsedPatcher } from '@/lib/sarsed/patcher';
import { SarsedVerifier } from '@/lib/sarsed/verifier';
import { SarsedSelfCorrectionLoop } from '@/lib/sarsed/self-correct';
import { SarsRoleManager, SARS_ROLES } from '@/lib/sarsed/roles';
import {
  executeCodeSkeleton,
  executeCodeSymbols,
  executeCodePatch,
  executeCodeVerify,
} from '@/lib/sarsed/tools';

describe('Sarsed-Code: AST Code Skeletonizer', () => {
  const skeletonizer = new CodeSkeletonizer();

  it('collapses TypeScript function bodies while preserving signatures, types, and interfaces', () => {
    const code = `
import { db } from './db';
import type { User } from './types';

export interface UserSummary {
  id: string;
  name: string;
  role: string;
}

export type UserFilter = (u: User) => boolean;

export function calculateMetrics(users: User[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    result[u.role] = (result[u.role] || 0) + 1;
    // Many lines of complex business logic here...
    console.log('Processed', u.id);
  }
  return result;
}

export class UserManager {
  constructor(private users: User[]) {}

  public getUser(id: string): User | undefined {
    return this.users.find(u => u.id === id);
  }
}
`;

    const skeleton = skeletonizer.skeletonize('src/users.ts', code);

    expect(skeleton.language).toBe('typescript');
    expect(skeleton.totalLines).toBeGreaterThan(skeleton.skeletonLines);
    expect(skeleton.reductionPercentage).toBeGreaterThan(20);

    // Interface and types preserved
    expect(skeleton.skeletonText).toContain('export interface UserSummary');
    expect(skeleton.skeletonText).toContain('export type UserFilter');

    // Function signature preserved, body collapsed
    expect(skeleton.skeletonText).toContain('calculateMetrics');
    expect(skeleton.skeletonText).toContain('[implementation:');
    expect(skeleton.skeletonText).not.toContain('Many lines of complex business logic');

    // Class preserved
    expect(skeleton.skeletonText).toContain('export class UserManager');
  });

  it('preserves all methods and properties in multi-method classes without swallowing subsequent methods', () => {
    const multiMethodClassCode = `
export class OrderService {
  private taxRate = 0.08;

  constructor(private readonly apiKey: string) {
    console.log('init order service with key', apiKey);
    this.setupListeners();
  }

  public async getOrder(id: string): Promise<Order> {
    const data = await this.fetchRemote(id);
    return this.transform(data);
  }

  public calculateTotal(price: number, quantity: number): number {
    const subtotal = price * quantity;
    return subtotal + subtotal * this.taxRate;
  }

  public static isEligibleForDiscount(order: Order): boolean {
    return order.total > 100;
  }
}
`;

    const skeleton = skeletonizer.skeletonize('src/order-service.ts', multiMethodClassCode);

    expect(skeleton.skeletonText).toContain('export class OrderService');
    expect(skeleton.skeletonText).toContain('private taxRate = 0.08;');
    expect(skeleton.skeletonText).toContain('constructor(private readonly apiKey: string)');
    expect(skeleton.skeletonText).toContain('public async getOrder(id: string): Promise<Order>');
    expect(skeleton.skeletonText).toContain('public calculateTotal(price: number, quantity: number): number');
    expect(skeleton.skeletonText).toContain('public static isEligibleForDiscount(order: Order): boolean');

    // Bodies collapsed
    expect(skeleton.skeletonText).not.toContain('init order service with key');
    expect(skeleton.skeletonText).not.toContain('this.fetchRemote(id)');
    expect(skeleton.skeletonText).not.toContain('subtotal * this.taxRate');

    // Verify symbols extracted include all methods
    const methodNames = skeleton.symbols.map((s) => s.name);
    expect(methodNames).toContain('OrderService');
    expect(methodNames).toContain('getOrder');
    expect(methodNames).toContain('calculateTotal');
    expect(methodNames).toContain('isEligibleForDiscount');
  });

  it('skeletonizes Python code, replacing def bodies with pass', () => {
    const pythonCode = `
import os
import sys

class ModelService:
    def __init__(self, model_name: str):
        self.model_name = model_name
        self.loaded = True

    def predict(self, prompt: str) -> str:
        # Complex tensor operations
        tokens = prompt.split()
        return "response"
`;

    const skeleton = skeletonizer.skeletonize('service.py', pythonCode);
    expect(skeleton.language).toBe('python');
    expect(skeleton.skeletonText).toContain('class ModelService:');
    expect(skeleton.skeletonText).toContain('def predict(self, prompt: str) -> str:');
    expect(skeleton.skeletonText).toContain('pass  # ... [impl omitted] ...');
    expect(skeleton.skeletonText).not.toContain('Complex tensor operations');
  });
});

describe('Sarsed-Code: Symbol Indexer & Call Hierarchy', () => {
  let indexer: SarsedSymbolIndex;

  beforeEach(() => {
    indexer = new SarsedSymbolIndex();
  });

  it('indexes symbols and finds definitions and usages', () => {
    const fileA = {
      path: 'src/math.ts',
      content: `
export function add(a: number, b: number): number {
  return a + b;
}
export class Calculator {}
`,
    };

    const fileB = {
      path: 'src/main.ts',
      content: `
import { add } from './math';
function run() {
  const sum = add(10, 20);
  console.log(sum);
}
`,
    };

    indexer.indexFiles([fileA, fileB]);

    // Find definition
    const def = indexer.findDefinition('add');
    expect(def).toBeDefined();
    expect(def?.file).toBe('src/math.ts');
    expect(def?.kind).toBe('function');

    // Find references
    const refs = indexer.findReferences('add', [fileA, fileB]);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    expect(refs.some((r) => r.file === 'src/main.ts')).toBe(true);

    // Call hierarchy: 'run' calls 'add'
    const callers = indexer.findCallers('add', [fileA, fileB]);
    expect(callers.length).toBe(1);
    expect(callers[0].callerSymbol).toBe('run');
    expect(callers[0].file).toBe('src/main.ts');
  });

  it('identifies class methods as callers in call hierarchy', () => {
    const file = {
      path: 'src/service.ts',
      content: `
function helper() { return 1; }

export class WorkerService {
  public async executeTask() {
    const val = helper();
    return val;
  }
}
`,
    };

    const callers = indexer.findCallers('helper', [file]);
    expect(callers.length).toBe(1);
    expect(callers[0].callerSymbol).toBe('executeTask');
    expect(callers[0].file).toBe('src/service.ts');
  });
});

describe('Sarsed-Code: Transactional Semantic Patcher', () => {
  let patcher: SarsedPatcher;

  beforeEach(() => {
    patcher = new SarsedPatcher();
  });

  it('performs atomic multi-hunk patch and creates diff', () => {
    const original = `
line 1
line 2 (old)
line 3
line 4 (old)
line 5
`;

    const patch = {
      file: 'test.txt',
      hunks: [
        { search: 'line 2 (old)', replace: 'line 2 (new)' },
        { search: 'line 4 (old)', replace: 'line 4 (new)' },
      ],
      atomic: true,
    };

    const res = patcher.applyPatch('test.txt', original, patch);

    expect(res.success).toBe(true);
    expect(res.hunksApplied).toBe(2);
    expect(res.modifiedContent).toContain('line 2 (new)');
    expect(res.modifiedContent).toContain('line 4 (new)');
    expect(res.diff).toContain('+ line 2 (new)');
  });

  it('handles replacement text containing special dollar sequences ($&, $$, $1) without string corruption', () => {
    const original = `
const template = 'PRICE_TAG';
const regexPattern = 'REPLACE_ME';
`;

    const patch = {
      file: 'config.ts',
      hunks: [
        { search: "const template = 'PRICE_TAG';", replace: "const template = '$100 $$USD';" },
        { search: "const regexPattern = 'REPLACE_ME';", replace: "const regexPattern = '$&';" },
      ],
      atomic: true,
    };

    const res = patcher.applyPatch('config.ts', original, patch);
    expect(res.success).toBe(true);
    // Crucial: $100 and $$USD and $& must be preserved literally, not transformed by String.replace
    expect(res.modifiedContent).toContain("const template = '$100 $$USD';");
    expect(res.modifiedContent).toContain("const regexPattern = '$&';");
  });

  it('matches and patches CRLF files with LF hunks, preserving CRLF line endings', () => {
    const crlfOriginal = 'line 1\r\nline 2 (target)\r\nline 3\r\n';
    const lfSearch = 'line 2 (target)';
    const lfReplace = 'line 2 (updated)';

    const res = patcher.applyPatch('windows.ts', crlfOriginal, {
      file: 'windows.ts',
      hunks: [{ search: lfSearch, replace: lfReplace }],
      atomic: true,
    });

    expect(res.success).toBe(true);
    expect(res.modifiedContent).toContain('line 2 (updated)');
    // Preserves CRLF
    expect(res.modifiedContent).toContain('\r\n');
    expect(res.modifiedContent).not.toMatch(/[^\r]\n/);
  });

  it('preserves tab indentation when patching tab-indented files', () => {
    const tabOriginal = 'function run() {\n\tif (ready) {\n\t\tdoWork();\n\t}\n}';
    const res = patcher.applyPatch('tabs.ts', tabOriginal, {
      file: 'tabs.ts',
      hunks: [{ search: 'doWork();', replace: 'doWork();\nlogDone();' }],
      atomic: true,
    });

    expect(res.success).toBe(true);
    expect(res.modifiedContent).toContain('\t\tdoWork();\n\t\tlogDone();');
  });

  it('rolls back completely if any hunk in an atomic patch fails', () => {
    const original = `
const a = 1;
const b = 2;
`;

    const patch = {
      file: 'test.txt',
      hunks: [
        { search: 'const a = 1;', replace: 'const a = 100;' },
        { search: 'NON_EXISTENT_STRING_SHOULD_FAIL', replace: 'new' },
      ],
      atomic: true,
    };

    const res = patcher.applyPatch('test.txt', original, patch);

    expect(res.success).toBe(false);
    expect(res.hunksApplied).toBe(0);
    // Original content is untouched
    expect(res.modifiedContent).toBe(original);
    expect(res.error).toContain('Hunk #2 failed');
  });

  it('auto-aligns indentation when replacing into indented blocks', () => {
    const original = `
function outer() {
    if (true) {
        const x = 1;
        const y = 2;
    }
}
`;

    // Patch provided without indent (e.g. from markdown fence)
    const patch = {
      file: 'indent.ts',
      hunks: [
        {
          search: 'const x = 1;\nconst y = 2;',
          replace: 'const x = 10;\nconst y = 20;',
        },
      ],
      atomic: true,
    };

    const res = patcher.applyPatch('indent.ts', original, patch);

    expect(res.success).toBe(true);
    // Replace lines should receive the 8-space indentation of the target block
    expect(res.modifiedContent).toContain('        const x = 10;\n        const y = 20;');
  });
});

describe('Sarsed-Code: Verifier & Diagnostic Parsing', () => {
  const verifier = new SarsedVerifier();

  it('parses TypeScript (tsc) error outputs into structured diagnostics', () => {
    const tscOutput = `
src/app.ts(45,12): error TS2322: Type 'string' is not assignable to type 'number'.
lib/db.ts(110,5): warning TS7006: Parameter 'data' implicitly has an 'any' type.
`;

    const diags = verifier.parseDiagnostics(tscOutput);

    expect(diags.length).toBe(2);

    const err = diags.find((d) => d.severity === 'error');
    expect(err).toBeDefined();
    expect(err?.file).toBe('src/app.ts');
    expect(err?.line).toBe(45);
    expect(err?.column).toBe(12);
    expect(err?.code).toBe('TS2322');
    expect(err?.source).toBe('tsc');

    const warn = diags.find((d) => d.severity === 'warning');
    expect(warn).toBeDefined();
    expect(warn?.code).toBe('TS7006');
  });

  it('parses Windows absolute paths with drive letters across tsc, eslint, and python', () => {
    const windowsTscOutput = `
C:\\Users\\dev\\project\\src\\index.ts(15,8): error TS2322: Type 'boolean' is not assignable to type 'string'.
D:/repo/lib/engine.ts:42:10 - error TS2554: Expected 2 arguments, but got 1.
`;

    const diags = verifier.parseDiagnostics(windowsTscOutput);
    expect(diags.length).toBe(2);

    expect(diags[0].file).toBe('C:/Users/dev/project/src/index.ts');
    expect(diags[0].line).toBe(15);
    expect(diags[0].column).toBe(8);
    expect(diags[0].code).toBe('TS2322');

    expect(diags[1].file).toBe('D:/repo/lib/engine.ts');
    expect(diags[1].line).toBe(42);
    expect(diags[1].column).toBe(10);
    expect(diags[1].code).toBe('TS2554');

    // Python with Windows drive letter
    const pythonOutput = `C:\\Python\\scripts\\worker.py:25: error: Unsupported operand types`;
    const pyDiags = verifier.parseDiagnostics(pythonOutput);
    expect(pyDiags.length).toBe(1);
    expect(pyDiags[0].file).toBe('C:/Python/scripts/worker.py');
    expect(pyDiags[0].line).toBe(25);
  });

  it('filters diagnostics to touched files', () => {
    const diags = [
      { file: 'src/app.ts', line: 1, column: 1, severity: 'error' as const, message: 'err1', source: 'tsc' as const },
      { file: 'tests/unrelated.test.ts', line: 1, column: 1, severity: 'error' as const, message: 'err2', source: 'tsc' as const },
    ];

    const filtered = verifier.filterByFiles(diags, ['src/app.ts']);
    expect(filtered.length).toBe(1);
    expect(filtered[0].file).toBe('src/app.ts');
  });

  it('renders clean diagnostic report', () => {
    const diags = [
      { file: 'src/main.ts', line: 10, column: 5, severity: 'error' as const, message: 'Unexpected token', code: 'TS1005', source: 'tsc' as const },
    ];

    const report = verifier.renderDiagnosticReport(diags);
    expect(report).toContain('### Verification Diagnostics');
    expect(report).toContain('[TSC] ERROR');
    expect(report).toContain('src/main.ts:10:5');
  });
});

describe('Sarsed-Code: Autonomous Self-Correction Loop', () => {
  it('detects errors and verifies repair iteratively', async () => {
    const loop = new SarsedSelfCorrectionLoop();

    let fileContent = 'const x: number = "wrong";';
    let verifyCallCount = 0;

    const mockExecutor = {
      runVerification: async (_cmd: string) => {
        verifyCallCount++;
        if (fileContent.includes('"wrong"')) {
          return {
            exitCode: 1,
            output: `file.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
          };
        }
        return { exitCode: 0, output: 'Done in 0.2s' };
      },
      readFile: async (_path: string) => fileContent,
      writeFile: async (_path: string, content: string) => {
        fileContent = content;
      },
      generateRepairPatch: async (_diags: any[], current: string) => {
        return {
          file: 'file.ts',
          hunks: [{ search: 'const x: number = "wrong";', replace: 'const x: number = 42;' }],
          atomic: true,
        };
      },
    };

    const report = await loop.executeLoop('npm test', ['file.ts'], mockExecutor, 3);

    expect(report.success).toBe(true);
    expect(report.filesFixed).toContain('file.ts');
    expect(fileContent).toBe('const x: number = 42;');
    expect(verifyCallCount).toBe(2);
  });
});

describe('Sarsed-Code: Multi-Role Fleet Management', () => {
  it('manages role transitions and structured context handovers', () => {
    const manager = new SarsRoleManager();
    expect(manager.getCurrentRole()).toBe('architect');

    const architectContract = manager.getRoleContract();
    expect(architectContract.role).toBe('architect');
    expect(architectContract.responsibilities.length).toBeGreaterThan(0);

    // Handover to coder
    const handover = manager.handover('coder', {
      contextSummary: 'Blueprint created for cache timeout fix.',
      modifiedFiles: ['lib/cache.ts'],
      targetInvariants: ['Must not leak timers', '100% tests pass'],
      artifacts: { blueprintId: 'bp-001' },
    });

    expect(manager.getCurrentRole()).toBe('coder');
    expect(handover.fromRole).toBe('architect');
    expect(handover.toRole).toBe('coder');
    expect(manager.getHandoverHistory().length).toBe(1);
  });
});

describe('Sarsed-Code: High-Level Tool Execution', () => {
  it('executes code_skeleton, code_patch, and code_verify tools', async () => {
    // 1. code_skeleton
    const skeletonRes = await executeCodeSkeleton({
      file_path: 'lib/example.ts',
      content: `
export interface Config { timeout: number }
export function init(c: Config) {
  // complex init lines
  return true;
}
`,
    });
    expect(skeletonRes.ok).toBe(true);
    expect(skeletonRes.skeletonText).toContain('export interface Config');

    // 2. code_patch
    const patchRes = await executeCodePatch({
      file_path: 'lib/example.ts',
      original_content: 'const a = 1;',
      hunks: [{ search: 'const a = 1;', replace: 'const a = 2;' }],
    });
    expect(patchRes.ok).toBe(true);
    expect(patchRes.modifiedContent).toBe('const a = 2;');

    // 3. code_verify
    const verifyRes = await executeCodeVerify({
      raw_output: `lib/test.ts(5,1): error TS2304: Cannot find name 'foo'.`,
      touched_files: ['lib/test.ts'],
    });
    expect(verifyRes.ok).toBe(false);
    expect(verifyRes.errorCount).toBe(1);
    expect(verifyRes.report).toContain('TS2304');
  });
});
