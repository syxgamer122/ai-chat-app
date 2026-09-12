/**
 * Standardized <show-me> visual inspection markdown builder,
 * Cybernetic Control Loop (Sensor -> Controller -> Actuator -> Disturbance),
 * and dynamic <important if> instruction optimization.
 */

import type { ApprovalRequest } from '../hitl/types';
import type {
  ShowMeParams,
  VisualDiffResult,
  CodeShapeResult,
  SensorTelemetry,
  ControllerDecision,
  ActuatorExecutionResult,
  DisturbanceSignal,
} from './types';

export class ShowMeBuilder {
  /**
   * Builds the standardized <show-me> markdown artifact.
   */
  public static build(params: ShowMeParams): string {
    const riskScore = params.riskScore ?? 50;
    const severity = params.severity ?? (riskScore >= 80 ? 'CRITICAL' : riskScore >= 50 ? 'HIGH' : 'LOW');

    const riskBadge =
      severity === 'CRITICAL' || riskScore >= 85
        ? '🔴 CRITICAL RISK'
        : severity === 'HIGH' || riskScore >= 60
        ? '🟠 HIGH RISK'
        : severity === 'MEDIUM' || riskScore >= 35
        ? '🟡 MEDIUM RISK'
        : '🟢 LOW RISK';

    const actionTitle = params.actionTitle || params.action || 'Operation';
    const workerId = params.workerId || 'agent';
    const target = params.target || 'workspace';

    const sections: string[] = [];

    sections.push('<show-me>');
    sections.push('# 🔍 Human-in-the-Loop Visual Inspection');
    sections.push(`**Action**: \`${actionTitle}\` | **Worker**: \`${workerId}\` | **Risk**: ${riskBadge} (${riskScore}/100)`);
    sections.push(`**Target**: \`${target}\`\n`);

    if (params.description) {
      sections.push(`### 📋 Intent & Description`);
      sections.push(params.description);
      sections.push('');
    }

    if (params.riskReasons && params.riskReasons.length > 0) {
      sections.push(`### ⚠️ Risk Factors & Security Triggers`);
      for (const reason of params.riskReasons) {
        sections.push(`- ${reason}`);
      }
      sections.push('');
    }

    if (params.flowSketch) {
      sections.push(`### 🗺️ Workflow Position & DAG State`);
      sections.push(params.flowSketch.startsWith('```') ? params.flowSketch : `\`\`\`text\n${params.flowSketch}\n\`\`\``);
      sections.push('');
    }

    if (params.codeShape) {
      const codeShapeText = typeof params.codeShape === 'string' ? params.codeShape : params.codeShape.formatted;
      sections.push(`### 📐 Code-Shape Structural Outline`);
      sections.push(codeShapeText.startsWith('```') ? codeShapeText : `\`\`\`text\n${codeShapeText}\n\`\`\``);
      sections.push('');
    }

    if (params.diff) {
      const diffResult = typeof params.diff === 'string'
        ? { diffText: params.diff, additions: 0, deletions: 0, dangerFlags: [] }
        : params.diff;

      const additionsTag = diffResult.additions ? `+${diffResult.additions}` : '';
      const deletionsTag = diffResult.deletions ? `-${diffResult.deletions}` : '';
      const counts = [additionsTag, deletionsTag].filter(Boolean).join(' / ');
      const countDisplay = counts ? ` (${counts})` : '';

      sections.push(`### 📝 Visual Unified Diff${countDisplay}`);
      sections.push(diffResult.diffText.startsWith('```') ? diffResult.diffText : `\`\`\`diff\n${diffResult.diffText}\n\`\`\``);
      sections.push('');

      if (diffResult.dangerFlags && diffResult.dangerFlags.length > 0) {
        sections.push(`> **Danger Flags Detected:**`);
        for (const flag of diffResult.dangerFlags) {
          sections.push(`> ⚠️ ${flag}`);
        }
        sections.push('');
      }
    }

    if (params.proposedCommand) {
      sections.push(`### 💻 Shell Command Line`);
      sections.push(`\`\`\`bash\n${params.proposedCommand}\n\`\`\``);
      sections.push('');
    }

    sections.push(`### 🔘 Decision Options`);
    if (params.decisionOptions && params.decisionOptions.length > 0) {
      for (const opt of params.decisionOptions) {
        sections.push(`- ${opt}`);
      }
    } else {
      sections.push(`- **APPROVED**: Authorize the action to proceed immediately.`);
      sections.push(`- **REJECTED**: Deny execution and request the agent to explore an alternative path.`);
      sections.push(`- **MODIFIED**: Provide amended parameters or edited file content before execution.`);
    }
    sections.push('</show-me>');

    return sections.join('\n');
  }

  /**
   * Conforms to PROJECT.md interface VisualDiffVisualizer
   */
  public static buildShowMeArtifact(request: ApprovalRequest): string {
    return this.build({
      actionTitle: request.action,
      workerId: (request.metadata?.workerId as string) || 'worker',
      target: request.target,
      action: request.action,
      severity: request.severity,
      riskScore: request.riskScore,
      riskReasons: request.riskReasons,
      description: request.description,
      diff: request.visualArtifacts?.unifiedDiff || request.diffSummary,
      flowSketch: request.visualArtifacts?.flowSketch || request.flowSketch,
      codeShape: request.visualArtifacts?.codeShape,
      proposedCommand: (request.metadata?.command as string) || (request.action === 'shell_exec' ? request.target : undefined),
    });
  }

  public buildShowMeArtifact(request: ApprovalRequest): string {
    return ShowMeBuilder.buildShowMeArtifact(request);
  }
}

// ----------------------------------------------------
// Cybernetic Control Loop
// ----------------------------------------------------

export class CyberneticControlLoop {
  private disturbanceHistory: DisturbanceSignal[] = [];

  /**
   * Sensor: Gathers real-time telemetry from environment, tools, and critic.
   */
  public sense(params: {
    activeLocks?: string[];
    gitClean?: boolean;
    gitStatusSummary?: string;
    criticVerdict?: 'PASS' | 'FAIL-BLOCKED' | 'PENDING';
    lastExitCode?: number;
    rateLimitStatus?: 'HEALTHY' | 'BLOCKED_429';
    consecutiveFailures?: number;
    errors?: string[];
  }): SensorTelemetry {
    return {
      timestamp: Date.now(),
      activeFileLocks: params.activeLocks ?? [],
      gitClean: params.gitClean ?? true,
      gitStatusSummary: params.gitStatusSummary,
      criticVerdict: params.criticVerdict ?? 'PENDING',
      lastExitCode: params.lastExitCode ?? 0,
      rateLimitStatus: params.rateLimitStatus ?? 'HEALTHY',
      consecutiveFailures: params.consecutiveFailures ?? 0,
      reportedErrors: params.errors ?? [],
    };
  }

  /**
   * Controller: Computes control error delta (Error = Target - Observed) and determines next action.
   */
  public control(
    telemetry: SensorTelemetry,
    target: {
      requiredCriticVerdict: 'PASS';
      allowInterrupts?: boolean;
      maxConsecutiveFailures?: number;
      targetFiles?: string[];
    }
  ): ControllerDecision {
    // 1. Disturbance: Rate limit 429
    if (telemetry.rateLimitStatus === 'BLOCKED_429') {
      this.recordDisturbance({
        type: 'RATE_LIMIT_429',
        severity: 'ERROR',
        message: 'Rate limit 429 encountered in telemetry',
        source: 'sensor',
        occurredAt: telemetry.timestamp,
      });
      return {
        action: 'HALT_429',
        reason: 'Rate limit 429 active. Safe halt triggered.',
        errorDelta: 100,
        recommendedDelayMs: 60000,
      };
    }

    // 2. Disturbance: Lock contention
    if (target.targetFiles) {
      for (const f of target.targetFiles) {
        if (telemetry.activeFileLocks.includes(f)) {
          this.recordDisturbance({
            type: 'LOCK_CONTENTION',
            severity: 'WARNING',
            message: `Target file "${f}" currently locked by another worker`,
            source: 'lock_manager',
            occurredAt: telemetry.timestamp,
          });
          return {
            action: 'RETRY',
            target: f,
            reason: `Target file "${f}" is locked by another process`,
            errorDelta: 40,
            recommendedDelayMs: 1500,
          };
        }
      }
    }

    // 3. Disturbance: dirty worktree (uncommitted changes) — requires human acknowledgement
    if (!telemetry.gitClean) {
      this.recordDisturbance({
        type: 'DIRTY_WORKTREE',
        severity: 'WARNING',
        message: `Workspace has uncommitted changes${
          telemetry.gitStatusSummary ? `: ${telemetry.gitStatusSummary}` : ''
        }`,
        source: 'sensor',
        occurredAt: telemetry.timestamp,
      });

      if (target.allowInterrupts !== false) {
        return {
          action: 'INTERRUPT',
          reason: 'Uncommitted worktree changes detected; human confirmation required before proceeding.',
          errorDelta: 35,
        };
      }
    }

    // 4. Consecutive failures exceeded circuit breaker
    const maxFailures = target.maxConsecutiveFailures ?? 3;
    if (telemetry.consecutiveFailures >= maxFailures) {
      this.recordDisturbance({
        type: 'CIRCUIT_BREAKER',
        severity: 'FATAL',
        message: `Consecutive failures (${telemetry.consecutiveFailures}) reached threshold (${maxFailures})`,
        source: 'critic',
        occurredAt: telemetry.timestamp,
      });
      return {
        action: 'ABORT',
        reason: `Circuit breaker tripped: ${telemetry.consecutiveFailures} consecutive verification failures.`,
        errorDelta: 999,
      };
    }

    // 5. Critic verification check
    if (telemetry.criticVerdict === 'FAIL-BLOCKED') {
      return {
        action: 'REMEDIATE',
        reason: 'Critic review rejected milestone verification.',
        errorDelta: 50,
        instructions: 'Analyze Critic test output, identify failing assertions, and apply targeted fixes.',
      };
    }

    if (telemetry.criticVerdict === target.requiredCriticVerdict && telemetry.lastExitCode === 0) {
      // System has converged to target state
      return {
        action: 'PROCEED',
        reason: 'Verification passed with zero error delta.',
        errorDelta: 0,
      };
    }

    // Default: Continue execution towards goal
    return {
      action: 'PROCEED',
      reason: 'Environment healthy. Advancing execution.',
      errorDelta: 25,
    };
  }

  /**
   * Actuator: Executes approved actions and records telemetry.
   */
  public async act<T>(
    toolName: string,
    executor: () => Promise<T>
  ): Promise<{ result?: T; execution: ActuatorExecutionResult }> {
    const start = Date.now();
    try {
      const res = await executor();
      const durationMs = Date.now() - start;
      return {
        result: res,
        execution: {
          tool: toolName,
          success: true,
          output: res,
          durationMs,
          timestamp: start,
        },
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        execution: {
          tool: toolName,
          success: false,
          error: errorMsg,
          durationMs,
          timestamp: start,
        },
      };
    }
  }

  public recordDisturbance(signal: DisturbanceSignal): void {
    this.disturbanceHistory.push(signal);
  }

  public getDisturbances(): DisturbanceSignal[] {
    return [...this.disturbanceHistory];
  }

  public clearDisturbances(): void {
    this.disturbanceHistory = [];
  }
}

// ----------------------------------------------------
// Instruction Optimizer (<important if="...">)
// ----------------------------------------------------

export class InstructionOptimizer {
  /**
   * Parses dynamic conditional tags in prompts to inject critical constraints
   * only when specific runtime states occur.
   */
  public static optimizePrompt(template: string, state: Record<string, unknown>): string {
    const pattern = /<important\s+if="([^"]+)">([\s\S]*?)<\/important>/gi;

    return template
      .replace(pattern, (_, condition: string, content: string) => {
        const isMatch = InstructionOptimizer.evaluateCondition(condition, state);
        return isMatch ? content.trim() : '';
      })
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private static evaluateCondition(condition: string, state: Record<string, unknown>): boolean {
    const trimmed = condition.trim();

    // Support simple boolean checks: "isRetry" or "!isRetry"
    if (/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return Boolean(state[trimmed]);
    }
    if (/^![a-zA-Z0-9_]+$/.test(trimmed)) {
      return !Boolean(state[trimmed.slice(1)]);
    }

    // Support comparison operators: ==, !=, >=, <=, >, <
    const compMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s*(==|!=|>=|<=|>|<)\s*(.*)$/);
    if (compMatch) {
      const [, key, op, rawVal] = compMatch;
      const actualVal = state[key];
      let expectedVal: unknown = rawVal.trim();

      if (expectedVal === 'true') expectedVal = true;
      else if (expectedVal === 'false') expectedVal = false;
      else if (!isNaN(Number(expectedVal)) && expectedVal !== '') expectedVal = Number(expectedVal);
      else if (
        ((expectedVal as string).startsWith("'") && (expectedVal as string).endsWith("'")) ||
        ((expectedVal as string).startsWith('"') && (expectedVal as string).endsWith('"'))
      ) {
        expectedVal = (expectedVal as string).slice(1, -1);
      }

      switch (op) {
        case '==':
          return actualVal === expectedVal;
        case '!=':
          return actualVal !== expectedVal;
        case '>':
          return Number(actualVal) > Number(expectedVal);
        case '<':
          return Number(actualVal) < Number(expectedVal);
        case '>=':
          return Number(actualVal) >= Number(expectedVal);
        case '<=':
          return Number(actualVal) <= Number(expectedVal);
      }
    }

    return false;
  }
}
