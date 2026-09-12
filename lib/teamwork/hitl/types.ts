/**
 * Types and data models for Human-in-the-Loop (HITL) approval gates.
 * Conforms to PROJECT.md § Interface Contracts and survey_explorer_2/report.md.
 */

export type HitlApprovalPolicy = 'always' | 'smart' | 'never' | 'custom';

/** Backward-compatible alias used by engine.ts and cli.ts */
export type HitlPolicy = HitlApprovalPolicy;

export type HitlActionType =
  | 'file_write'
  | 'shell_exec'
  | 'milestone_advance'
  | 'fs_write'
  | 'fs_edit'
  | 'plan_confirm'
  | 'worktree_merge';

export type ApprovalSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type ApprovalState =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'MODIFIED'
  | 'EXPIRED'
  | 'CANCELLED';

export type ApprovalDecision = 'APPROVED' | 'REJECTED' | 'MODIFIED';

/**
 * Visual inspection attachments for an approval request.
 */
export interface HitlVisualArtifacts {
  unifiedDiff?: string;
  flowSketch?: string;
  codeShape?: string;
  showMeMarkdown?: string;
}

/**
 * Core approval request structure.
 */
export interface ApprovalRequest {
  id: string;
  token: string;
  action: HitlActionType;
  severity: ApprovalSeverity;
  description: string;
  target?: string;
  diffSummary?: string;
  flowSketch?: string;
  visualArtifacts?: HitlVisualArtifacts;
  metadata: Record<string, unknown>;
  proposedPayload?: unknown;
  riskScore: number; // 0 to 100
  riskReasons: string[];
  state: ApprovalState;
  createdAt: number;
  expiresAt?: number;
  resolvedAt?: number;
  resolvedBy?: string;
  decision?: ApprovalDecision;
  resolutionComments?: string;
  modifiedPayload?: Record<string, unknown>;
}

/**
 * Approval decision payload submitted by user or external caller.
 */
export interface ApprovalResponse {
  requestId: string;
  token: string;
  decision: ApprovalDecision;
  approver: string;
  comments?: string;
  modifiedPayload?: Record<string, unknown>;
  timestamp?: number;
}

/**
 * Cryptographic interrupt token representing pending authorization.
 */
export interface HitlInterruptToken {
  token: string;
  requestId: string;
  payloadHash: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

/**
 * Custom policy rule evaluated by the approval gate.
 */
export interface HitlGateRule {
  name: string;
  description?: string;
  evaluate: (req: {
    workerId?: string;
    action: HitlActionType;
    target?: string;
    description?: string;
    content?: string;
    diffLines?: number;
    proposedPayload?: unknown;
    metadata?: Record<string, unknown>;
  }) => {
    triggered: boolean;
    riskScore?: number;
    severity?: ApprovalSeverity;
    reason?: string;
  };
}

/**
 * Configuration options for the HITL approval gate.
 */
export interface HitlApprovalGateConfig {
  policy?: HitlApprovalPolicy;
  secret?: string;
  ttlMs?: number; // Default: 15 minutes (900,000ms)
  criticalGlobs?: string[];
  blockedCommands?: string[];
  maxDiffLinesThreshold?: number;
  customRules?: HitlGateRule[];
  clock?: () => number;
}
