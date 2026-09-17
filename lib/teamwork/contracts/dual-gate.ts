/**
 * Dual-Gate Guardrails.
 * Gate 1 (Pre-Flight): Schema validation, CWD lockdown, capability scopes, and exclusive file lock checks.
 * Gate 2 (Post-Flight): Output schema validation, adversarial diff audit, and verifyCommand critic review.
 */

import path from 'node:path';
import {
  PostFlightIssue,
  PostFlightReviewResult,
  PreFlightGateResult,
  ToolContract,
  ToolExecutionContext,
} from './types';
import { ProvenanceTracker, calculateSha256 } from './provenance';

export interface PreFlightCheckOptions {
  contract: ToolContract<any, any>;
  rawInput: unknown;
  context: ToolExecutionContext;
  checkLock?: (filePath: string, workerId: string) => boolean;
  checkPermission?: (workerId: string, target: string) => Promise<boolean> | boolean;
}

export interface PostFlightReviewOptions {
  contract: ToolContract<any, any>;
  output: unknown;
  context: ToolExecutionContext;
  diffText?: string;
  newContent?: string;
  oldContent?: string;
  verifyCommand?: string;
  runVerifyCommand?: (command: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export interface ExecuteWithDualGateOptions<TInput, TOutput> {
  contract: ToolContract<TInput, TOutput>;
  rawInput: unknown;
  context: ToolExecutionContext;
  checkLock?: (filePath: string, workerId: string) => boolean;
  checkPermission?: (workerId: string, target: string) => Promise<boolean> | boolean;
  provenanceTracker?: ProvenanceTracker;
  diffText?: string;
  newContent?: string;
  oldContent?: string;
  verifyCommand?: string;
  runVerifyCommand?: (command: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export interface DualGateExecutionResult<TOutput> {
  success: boolean;
  preFlight: PreFlightGateResult;
  output?: TOutput;
  postFlight?: PostFlightReviewResult;
  error?: Error;
}

/** Dangerous destructive command signatures */
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /rm\s+-rf\s+\/($|\s)/i,
  /:(){ :\|:& };:/,
  /\bmkfs\b/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\bdrop\s+database\b/i,
];

/** Dummy facade and stub detection patterns */
const ADVERSARIAL_FACADE_PATTERNS = [
  { pattern: /async\s+function\s+\w+\s*\([^)]*\)\s*\{\s*\}/, desc: 'Empty async function facade' },
  { pattern: /function\s+\w+\s*\([^)]*\)\s*\{\s*return\s+(null|undefined|true|false);\s*\}/, desc: 'Trivial dummy stub facade' },
  { pattern: /throw\s+new\s+Error\s*\(\s*['"`]not implemented['"`]\s*\)/i, desc: 'Unimplemented error stub' },
];

export class DualGateController {
  /**
   * Evaluates Gate 1 (Pre-Flight Guardrail).
   */
  public async evaluatePreFlight(options: PreFlightCheckOptions): Promise<PreFlightGateResult> {
    const { contract, rawInput, context } = options;

    // 1. Zod Schema Validation
    const parsed = contract.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const issuesSummary = parsed.error.issues
        .map((iss) => `[${iss.path.join('.') || 'root'}]: ${iss.message}`)
        .join('; ');
      return {
        passed: false,
        reason: `Schema validation failed for tool "${contract.name}": ${issuesSummary}`,
        blockedRule: 'zod_schema_violation',
        riskScore: 100,
      };
    }

    const inputData = parsed.data as Record<string, unknown>;

    // 2. CWD & Path Lockdown Check
    const targetPath = (inputData?.filePath ||
      inputData?.path ||
      inputData?.relPath ||
      inputData?.targetResource ||
      inputData?.cwd) as string | undefined;

    if (targetPath && typeof targetPath === 'string') {
      const rootAbs = path.resolve(context.workspaceRoot);
      const targetAbs = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(rootAbs, targetPath);

      const rel = path.relative(rootAbs, targetAbs);
      // `..foo` is a legitimate sibling inside the root; only a real parent hop escapes.
      const isEscaping = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

      if (isEscaping) {
        return {
          passed: false,
          reason: `Path lockdown violation: target "${targetPath}" resolves outside workspaceRoot "${rootAbs}".`,
          blockedRule: 'path_lockdown_violation',
          riskScore: 100,
        };
      }
    }

    // 3. Destructive Command Detection
    const command = inputData?.command as string | undefined;
    if (command && typeof command === 'string') {
      for (const pat of DESTRUCTIVE_COMMAND_PATTERNS) {
        if (pat.test(command)) {
          return {
            passed: false,
            reason: `Destructive command detected: "${command}" violates safety guardrails.`,
            blockedRule: 'destructive_command_blocked',
            riskScore: 100,
          };
        }
      }
    }

    // 4. Exclusive File Lock Check (for write/destructive actions)
    if (contract.riskLevel === 'write' || contract.riskLevel === 'destructive' || contract.category === 'fs_write') {
      if (targetPath && options.checkLock) {
        const hasLock = options.checkLock(targetPath, context.workerId);
        if (!hasLock) {
          return {
            passed: false,
            reason: `Exclusive file lock required: worker "${context.workerId}" does not own "${targetPath}"`,
            blockedRule: 'exclusive_file_lock_missing',
            riskScore: 90,
          };
        }
      }
    }

    // 5. Capability Scope Check
    if (options.checkPermission && targetPath) {
      const granted = await options.checkPermission(context.workerId, targetPath);
      if (!granted) {
        return {
          passed: false,
          reason: `Capability scope denied: worker "${context.workerId}" is not authorized for "${targetPath}"`,
          blockedRule: 'capability_scope_denied',
          riskScore: 85,
        };
      }
    }

    // 6. Custom Pre-Flight check if defined on contract
    if (contract.preFlightCheck) {
      const customRes = await contract.preFlightCheck(parsed.data, context);
      if (!customRes.passed) {
        return customRes;
      }
    }

    return {
      passed: true,
      sanitizedInput: parsed.data,
      riskScore: contract.riskLevel === 'read' ? 10 : 50,
    };
  }

  /**
   * Evaluates Gate 2 (Post-Flight Critic Review).
   */
  public async evaluatePostFlight(options: PostFlightReviewOptions): Promise<PostFlightReviewResult> {
    const { contract, output, context, diffText, newContent, verifyCommand, runVerifyCommand } = options;
    const issues: PostFlightIssue[] = [];

    // 1. Validate Output Schema
    const outParsed = contract.outputSchema.safeParse(output);
    if (!outParsed.success) {
      const formatted = outParsed.error.issues
        .map((iss) => `[${iss.path.join('.') || 'root'}]: ${iss.message}`)
        .join('; ');
      return {
        passed: false,
        verdict: 'FAIL-BLOCKED',
        issues: [
          {
            severity: 'blocker',
            description: `Tool output failed schema validation: ${formatted}`,
          },
        ],
        remediation: 'Ensure tool execution output strictly satisfies outputSchema.',
      };
    }

    // 2. Adversarial Diff & Facade Audit
    const textToAudit = (diffText ?? '') + '\n' + (newContent ?? '');
    if (textToAudit.trim().length > 0) {
      for (const item of ADVERSARIAL_FACADE_PATTERNS) {
        if (item.pattern.test(textToAudit)) {
          issues.push({
            severity: 'blocker',
            description: `Adversarial audit failed: detected dummy facade or stub (${item.desc}).`,
            reproduction: `Matched pattern ${item.pattern.source}`,
          });
        }
      }
    }

    // 3. Verification Command Execution (Critic Verifier)
    if (verifyCommand && runVerifyCommand) {
      try {
        const cmdRes = await runVerifyCommand(verifyCommand);
        if (cmdRes.code !== 0) {
          issues.push({
            severity: 'blocker',
            description: `Verification command "${verifyCommand}" failed with exit code ${cmdRes.code}.`,
            reproduction: cmdRes.stderr || cmdRes.stdout,
          });
        }
      } catch (err: any) {
        issues.push({
          severity: 'blocker',
          description: `Verification command execution failed: ${err.message}`,
        });
      }
    }

    // 4. Custom Post-Flight review if defined on contract
    if (contract.postFlightReview) {
      const customRes = await contract.postFlightReview(outParsed.data, context);
      if (!customRes.passed) {
        issues.push(...customRes.issues);
        return {
          passed: false,
          verdict: 'FAIL-BLOCKED',
          issues,
          remediation: customRes.remediation ?? 'Address issues flagged in post-flight review.',
          outputPreview: customRes.outputPreview,
        };
      }
    }

    const passed = issues.length === 0;
    return {
      passed,
      verdict: passed ? 'PASS' : 'FAIL-BLOCKED',
      issues,
      outputPreview: typeof output === 'object' ? JSON.stringify(output).slice(0, 300) : String(output).slice(0, 300),
    };
  }

  /**
   * Executes a contract guarded by both Gate 1 and Gate 2.
   * Also automatically logs provenance if write occurred.
   */
  public async executeWithDualGate<TInput, TOutput>(
    options: ExecuteWithDualGateOptions<TInput, TOutput>
  ): Promise<DualGateExecutionResult<TOutput>> {
    const { contract, rawInput, context, provenanceTracker } = options;

    // Gate 1: Pre-Flight
    const preFlight = await this.evaluatePreFlight({
      contract,
      rawInput,
      context,
      checkLock: options.checkLock,
      checkPermission: options.checkPermission,
    });

    if (!preFlight.passed) {
      return {
        success: false,
        preFlight,
        error: new Error(`Gate 1 Pre-Flight Blocked: ${preFlight.reason}`),
      };
    }

    // Execute Tool Core
    let output: TOutput;
    try {
      output = await contract.execute(preFlight.sanitizedInput as TInput, context);
    } catch (err: any) {
      return {
        success: false,
        preFlight,
        error: err,
      };
    }

    // Gate 2: Post-Flight Review
    const postFlight = await this.evaluatePostFlight({
      contract,
      output,
      context,
      diffText: options.diffText,
      newContent: options.newContent,
      oldContent: options.oldContent,
      verifyCommand: options.verifyCommand,
      runVerifyCommand: options.runVerifyCommand,
    });

    if (!postFlight.passed) {
      return {
        success: false,
        preFlight,
        output,
        postFlight,
        error: new Error(
          `Gate 2 Post-Flight Blocked: ${postFlight.issues.map((i) => i.description).join('; ')}`
        ),
      };
    }

    // Record Provenance if provenanceTracker supplied and this is a write
    if (
      provenanceTracker &&
      (contract.riskLevel === 'write' || contract.riskLevel === 'destructive' || contract.category === 'fs_write')
    ) {
      const inputObj = preFlight.sanitizedInput as Record<string, unknown>;
      const filePath = (inputObj?.filePath || inputObj?.path || inputObj?.relPath) as string | undefined;
      if (filePath) {
        const contentAfter = (inputObj?.content || (output as any)?.content) as string | undefined;
        provenanceTracker.createRecord({
          context,
          filePath,
          action: 'modify',
          contentAfter,
        });
      }
    }

    return {
      success: true,
      preFlight,
      output,
      postFlight,
    };
  }
}
