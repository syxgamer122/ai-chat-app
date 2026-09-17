/**
 * Production-grade Human-in-the-Loop (HITL) Approval Gate and State Machine.
 * Intercepts sensitive operations, evaluates risk policies, and manages authorization lifecycles.
 */

import crypto from 'node:crypto';
import type {
  HitlApprovalPolicy,
  HitlActionType,
  ApprovalSeverity,
  ApprovalState,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResponse,
  HitlGateRule,
  HitlApprovalGateConfig,
  HitlVisualArtifacts,
} from './types';
import { InterruptTokenManager } from './token';

export interface EvaluationResult {
  shouldInterrupt: boolean;
  riskScore: number;
  severity: ApprovalSeverity;
  reasons: string[];
}

/** Ordinal ranking of approval severities, used to combine rule-derived severities. */
const SEVERITY_RANK: Record<ApprovalSeverity, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** Inverse lookup for SEVERITY_RANK, indexed by rank. */
const RANK_TO_SEVERITY: readonly ApprovalSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export interface CreateRequestOptions {
  action: HitlActionType;
  target?: string;
  description: string;
  severity?: ApprovalSeverity;
  riskScore?: number;
  workerId?: string;
  proposedPayload?: unknown;
  diffSummary?: string;
  flowSketch?: string;
  visualArtifacts?: HitlVisualArtifacts;
  metadata?: Record<string, unknown>;
  diffLines?: number;
  ttlMs?: number;
}

export class HitlApprovalGate {
  private readonly policy: HitlApprovalPolicy;
  private readonly tokenManager: InterruptTokenManager;
  private readonly criticalGlobs: string[];
  private readonly blockedCommands: string[];
  private readonly maxDiffLinesThreshold: number;
  private readonly defaultTtlMs: number;
  private readonly customRules: HitlGateRule[] = [];
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly waiters = new Map<string, {
    resolve: (req: ApprovalRequest) => void;
    reject: (err: Error) => void;
    timer?: NodeJS.Timeout;
  }>();
  private readonly clock: () => number;

  constructor(config?: HitlApprovalGateConfig) {
    this.policy = config?.policy ?? 'smart';
    this.tokenManager = new InterruptTokenManager(config?.secret);
    this.criticalGlobs = config?.criticalGlobs ?? [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'next.config.mjs',
      'next.config.js',
      '.env',
      '.env.*',
      '.env.local',
      'lib/teamwork/**',
      '.github/**',
      '.vyen/**',
    ];
    this.blockedCommands = config?.blockedCommands ?? [
      'rm -rf',
      'rmdir /s',
      'git push --force',
      'git reset --hard',
      'npm publish',
      'chmod -R 777',
      ':(){ :|:& };:',
      'drop database',
      'drop table',
      'truncate table',
      'mkfs',
      'dd if=',
    ];
    this.maxDiffLinesThreshold = config?.maxDiffLinesThreshold ?? 100;
    this.defaultTtlMs = config?.ttlMs ?? 15 * 60 * 1000;
    this.clock = config?.clock ?? (() => Date.now());

    if (config?.customRules) {
      this.customRules.push(...config.customRules);
    }
  }

  public getPolicy(): HitlApprovalPolicy {
    return this.policy;
  }

  public registerRule(rule: HitlGateRule): void {
    this.customRules.push(rule);
  }

  /**
   * Evaluates whether an intended action should trigger an approval gate interrupt.
   */
  public evaluate(params: {
    workerId?: string;
    action: HitlActionType;
    target?: string;
    description?: string;
    content?: string;
    diffLines?: number;
    proposedPayload?: unknown;
    metadata?: Record<string, unknown>;
  }): EvaluationResult {
    if (this.policy === 'never') {
      return {
        shouldInterrupt: false,
        riskScore: 0,
        severity: 'LOW',
        reasons: ['Policy is configured to NEVER interrupt.'],
      };
    }

    if (this.policy === 'always') {
      return {
        shouldInterrupt: true,
        riskScore: 100,
        severity: 'CRITICAL',
        reasons: ['Policy is configured to ALWAYS interrupt for user confirmation.'],
      };
    }

    const reasons: string[] = [];
    let maxRisk = 5;

    // Rule 1: Shell commands containing dangerous patterns
    if (params.action === 'shell_exec') {
      const cmd = (params.target || params.description || '').toLowerCase();
      for (const blocked of this.blockedCommands) {
        if (cmd.includes(blocked.toLowerCase())) {
          reasons.push(`Command contains high-risk operation: "${blocked}"`);
          maxRisk = Math.max(maxRisk, 95);
        }
      }
      if (maxRisk < 50 && (cmd.includes('npm install') || cmd.includes('npm i') || cmd.includes('git checkout'))) {
        reasons.push(`System-modifying command: "${params.target}"`);
        maxRisk = Math.max(maxRisk, 55);
      }
    }

    // Rule 2: Critical file writes & edits
    if (params.action === 'file_write' || params.action === 'fs_write' || params.action === 'fs_edit') {
      const targetPath = params.target || '';
      for (const glob of this.criticalGlobs) {
        if (this.matchesGlob(targetPath, glob)) {
          reasons.push(`Target "${targetPath}" matches protected core project pattern "${glob}"`);
          maxRisk = Math.max(maxRisk, 85);
        }
      }

      if (params.diffLines && params.diffLines > this.maxDiffLinesThreshold) {
        reasons.push(`Diff size (${params.diffLines} lines) exceeds threshold of ${this.maxDiffLinesThreshold} lines`);
        maxRisk = Math.max(maxRisk, 75);
      }
    }

    // Rule 3: Milestone advance without critic pass
    if (params.action === 'milestone_advance' || params.action === 'plan_confirm') {
      if (params.metadata?.criticVerdict !== 'PASS') {
        reasons.push('Advancing milestone or confirming plan without verified Critic PASS');
        maxRisk = Math.max(maxRisk, 80);
      }
    }

    // Rule 4: Custom registered rules
    let maxSeverityRank = 0;
    for (const rule of this.customRules) {
      const res = rule.evaluate(params);
      if (res.triggered) {
        if (res.reason) reasons.push(res.reason);
        if (res.riskScore !== undefined) maxRisk = Math.max(maxRisk, res.riskScore);
        // A rule may force a severity even without a numeric risk score.
        if (res.severity) maxSeverityRank = Math.max(maxSeverityRank, SEVERITY_RANK[res.severity]);
      }
    }

    const computedSeverity: ApprovalSeverity =
      maxRisk >= 85 ? 'CRITICAL' : maxRisk >= 65 ? 'HIGH' : maxRisk >= 40 ? 'MEDIUM' : 'LOW';
    const severity: ApprovalSeverity =
      RANK_TO_SEVERITY[Math.max(maxSeverityRank, SEVERITY_RANK[computedSeverity])];

    const shouldInterrupt = maxRisk >= 50 || reasons.length > 0 || maxSeverityRank > 0;

    return {
      shouldInterrupt,
      riskScore: maxRisk,
      severity,
      reasons,
    };
  }

  /**
   * Creates and registers a new pending approval request with a cryptographic interrupt token.
   */
  public createRequest(options: CreateRequestOptions): ApprovalRequest {
    const now = this.clock();
    const ttl = options.ttlMs ?? this.defaultTtlMs;
    const expiresAt = now + ttl;
    const id = `hitl_req_${now}_${crypto.randomBytes(4).toString('hex')}`;

    const evalResult = this.evaluate({
      workerId: options.workerId,
      action: options.action,
      target: options.target,
      description: options.description,
      diffLines: options.diffLines,
      metadata: options.metadata,
    });

    const tokenData = this.tokenManager.createToken(
      id,
      options.proposedPayload ?? { action: options.action, target: options.target },
      ttl,
      now
    );

    const request: ApprovalRequest = {
      id,
      token: tokenData.token,
      action: options.action,
      // Explicit caller-provided severity/risk wins over the derived evaluation.
      severity: options.severity ?? evalResult.severity,
      description: options.description,
      target: options.target,
      diffSummary: options.diffSummary,
      flowSketch: options.flowSketch,
      visualArtifacts: options.visualArtifacts,
      metadata: options.metadata ?? {},
      proposedPayload: options.proposedPayload,
      riskScore: options.riskScore ?? evalResult.riskScore,
      riskReasons: evalResult.reasons,
      state: 'PENDING_APPROVAL',
      createdAt: now,
      expiresAt,
    };

    this.requests.set(id, request);
    return request;
  }

  /**
   * Submits an approval decision, transitioning the state machine.
   */
  public respond(response: ApprovalResponse): ApprovalRequest {
    const now = this.clock();
    const req = this.requests.get(response.requestId);

    if (!req) {
      throw new Error(`Approval request "${response.requestId}" was not found.`);
    }

    if (req.state !== 'PENDING_APPROVAL') {
      throw new Error(
        `Approval request "${response.requestId}" is already resolved with state "${req.state}".`
      );
    }

    if (req.expiresAt && now > req.expiresAt) {
      req.state = 'EXPIRED';
      throw new Error(`Approval request "${response.requestId}" expired at ${new Date(req.expiresAt).toISOString()}.`);
    }

    // Verify token validity and payload integrity
    const tokenVerify = this.tokenManager.verifyToken(
      response.token,
      req.proposedPayload ?? { action: req.action, target: req.target },
      now
    );

    if (!tokenVerify.valid) {
      throw new Error(`Invalid interrupt token for request "${response.requestId}": ${tokenVerify.reason}`);
    }

    // Bind the token to the request being answered. The HMAC only proves the token is
    // authentic; without this check a valid token minted for one request could be
    // replayed to approve a different request that happens to share the same payload.
    if (tokenVerify.tokenData && tokenVerify.tokenData.requestId !== response.requestId) {
      throw new Error(
        `Interrupt token does not belong to request "${response.requestId}" (token is bound to "${tokenVerify.tokenData.requestId}").`
      );
    }

    // Apply state machine transition
    const decision: ApprovalDecision = response.decision;
    switch (decision) {
      case 'APPROVED':
        req.state = 'APPROVED';
        break;
      case 'REJECTED':
        req.state = 'REJECTED';
        break;
      case 'MODIFIED':
        req.state = 'MODIFIED';
        req.modifiedPayload = response.modifiedPayload;
        break;
      default:
        throw new Error(`Unsupported approval decision: "${decision as string}"`);
    }

    req.decision = decision;
    req.resolvedAt = now;
    req.resolvedBy = response.approver || 'system';
    req.resolutionComments = response.comments;

    // Wake up any asynchronous waiters
    const waiter = this.waiters.get(req.id);
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      this.waiters.delete(req.id);
      waiter.resolve(req);
    }

    return req;
  }

  /**
   * Waits asynchronously for an approval decision on a pending request.
   */
  public async waitForDecision(requestId: string, timeoutMs?: number): Promise<ApprovalRequest> {
    const req = this.requests.get(requestId);
    if (!req) {
      throw new Error(`Approval request "${requestId}" not found.`);
    }

    if (req.state !== 'PENDING_APPROVAL') {
      return req;
    }

    return new Promise<ApprovalRequest>((resolve, reject) => {
      const waiterTimeout = timeoutMs ?? (req.expiresAt ? Math.max(100, req.expiresAt - this.clock()) : 60000);

      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        if (req.state === 'PENDING_APPROVAL') {
          req.state = 'EXPIRED';
        }
        reject(new Error(`Timeout waiting for approval decision on request "${requestId}" after ${waiterTimeout}ms.`));
      }, waiterTimeout);

      this.waiters.set(requestId, {
        resolve: (resolvedReq) => {
          clearTimeout(timer);
          resolve(resolvedReq);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
    });
  }

  public getRequest(requestId: string): ApprovalRequest | undefined {
    this.sweepExpired();
    return this.requests.get(requestId);
  }

  public listPendingRequests(): ApprovalRequest[] {
    this.sweepExpired();
    return Array.from(this.requests.values()).filter((r) => r.state === 'PENDING_APPROVAL');
  }

  public cancelRequest(requestId: string, reason: string = 'Cancelled by system'): ApprovalRequest {
    const req = this.requests.get(requestId);
    if (!req) {
      throw new Error(`Approval request "${requestId}" not found.`);
    }

    if (req.state !== 'PENDING_APPROVAL') {
      throw new Error(`Cannot cancel request in state "${req.state}".`);
    }

    req.state = 'CANCELLED';
    req.resolvedAt = this.clock();
    req.resolutionComments = reason;

    const waiter = this.waiters.get(requestId);
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      this.waiters.delete(requestId);
      waiter.reject(new Error(`Approval request "${requestId}" was cancelled: ${reason}`));
    }

    return req;
  }

  public sweepExpired(): number {
    const now = this.clock();
    let expiredCount = 0;

    for (const req of this.requests.values()) {
      if (req.state === 'PENDING_APPROVAL' && req.expiresAt && now > req.expiresAt) {
        req.state = 'EXPIRED';
        expiredCount++;

        const waiter = this.waiters.get(req.id);
        if (waiter) {
          if (waiter.timer) clearTimeout(waiter.timer);
          this.waiters.delete(req.id);
          waiter.reject(new Error(`Approval request "${req.id}" has expired.`));
        }
      }
    }

    return expiredCount;
  }

  /**
   * Helper glob matcher supporting wildcard, file extensions, directory recursion.
   *
   * Patterns without a path separator (e.g. `package.json`, `.env.*`, `*.ts`) are matched
   * against the path BASENAME as well as the full path, so nested files such as
   * `config/.env.local` are still protected by a `.env.*` rule.
   */
  private matchesGlob(filePath: string, pattern: string): boolean {
    const normPath = filePath.replace(/\\/g, '/').toLowerCase();
    const normPattern = pattern.replace(/\\/g, '/').toLowerCase();

    if (normPattern === '**') return true;

    // Directory recursion shorthand: "lib/teamwork/**"
    if (normPattern.endsWith('/**')) {
      const dirPrefix = normPattern.slice(0, -3);
      return normPath === dirPrefix || normPath.startsWith(`${dirPrefix}/`);
    }

    const regex = HitlApprovalGate.globToRegExp(normPattern);

    if (regex.test(normPath)) return true;

    // Separator-free patterns also match the basename of the path.
    if (!normPattern.includes('/')) {
      const baseName = normPath.split('/').pop() ?? normPath;
      if (regex.test(baseName)) return true;
    }

    return false;
  }

  /**
   * Compiles a glob pattern into an anchored RegExp.
   * `*` matches within a path segment, `**` spans segments, `?` matches one non-slash char.
   */
  private static globToRegExp(glob: string): RegExp {
    let out = '^';
    for (let i = 0; i < glob.length; i++) {
      const ch = glob[i];
      if (ch === '*') {
        if (glob[i + 1] === '*') {
          out += '.*';
          i++;
        } else {
          out += '[^/]*';
        }
      } else if (ch === '?') {
        out += '[^/]';
      } else {
        out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    }
    return new RegExp(out + '$');
  }
}

// Alias for flexibility
export const ApprovalGate = HitlApprovalGate;
