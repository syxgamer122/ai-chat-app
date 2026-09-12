/**
 * Core types and data models for Teamwork Multi-Agent Runtime Engine.
 * Conforms strictly to .opencode/agents/teamwork-orchestrator.md,
 * .opencode/commands/teamwork.md, and ORIGINAL_REQUEST.md.
 */

export type MilestoneStatus =
  | 'todo'
  | 'doing'
  | 'reviewing'
  | 'done'
  | 'blocked'
  | 'failed';

export type CriticVerdict = 'PASS' | 'FAIL-BLOCKED';

export type TeamworkPhase =
  | 'phase1_planning'
  | 'phase1_awaiting_confirm'
  | 'phase2_executing'
  | 'completed'
  | 'blocked'
  | 'blocked_429'
  | 'failed'
  | 'error';

export type ApprovalPolicy = 'always' | 'smart' | 'never';

export type IntegrityMode = 'development' | 'demo' | 'benchmark';

export type RateLimitStatus = 'HEALTHY' | 'BLOCKED_429';

/**
 * Single milestone definition conforming to Phase 2 roadmap.
 * Max 3 milestones per run.
 */
export interface Milestone {
  id: string; // e.g. "M1", "M2", "M3"
  title: string;
  goal: string;
  assignedWorker?: string; // worker identifier, e.g. "teamwork-worker"
  ownedFiles: string[]; // Exclusive File Ownership paths
  targetFiles?: string[]; // Alias for ownedFiles
  verifyCommand: string; // e.g. "npm test tests/file1.test.ts"
  status: MilestoneStatus;
  criticVerdict?: CriticVerdict;
  retryCount?: number; // Max 1 retry per milestone (attempts 0..2)
  maxRetries?: number; // default: 1
  dependsOn?: string; // e.g. "None", "M1"
  workerBrief?: string; // Brief <= 15 lines
  notes?: string;
}

/**
 * Single testable acceptance criterion in REQUEST.md.
 */
export interface AcceptanceCriterion {
  description: string;
  verifyCommand: string;
  completed?: boolean;
}

/**
 * Git and directory context captured at the start of Phase 1.
 */
export interface RepoContext {
  latestCommit?: string;
  gitStatus?: string;
  workingDirectory: string;
}

/**
 * System constraints defined in REQUEST.md.
 */
export interface TeamworkConstraints {
  process: string;
  concurrency: string;
  fileOwnership: string;
  maxMilestones: number;
  maxRetriesPerMilestone: number;
  rateLimitPolicy: string;
}

/**
 * Structured representation of teamwork/REQUEST.md.
 */
export interface TeamworkRequest {
  title: string;
  originalGoal: string;
  repoContext: RepoContext;
  constraints: TeamworkConstraints;
  acceptanceCriteria: AcceptanceCriterion[];
  rawMarkdown?: string;
}

/**
 * Structured representation of teamwork/PLAN.md.
 */
export interface TeamworkPlan {
  title: string;
  milestones: Milestone[];
  rawMarkdown?: string;
}

/**
 * Single row in the milestone status board inside teamwork/PROGRESS.md.
 */
export interface ProgressMilestoneRow {
  milestoneId: string;
  title: string;
  worker: string;
  status: MilestoneStatus;
  ownedFiles: string[];
  criticVerdict: string; // "PASS", "FAIL-BLOCKED", "pending", or "-"
  attempts: string; // e.g. "1/2"
  notes: string;
}

/**
 * Execution log entry in teamwork/PROGRESS.md.
 */
export interface ExecutionLogEntry {
  timestamp: string;
  milestoneId: string;
  agent: 'teamwork-explorer' | 'teamwork-worker' | 'teamwork-critic' | 'orchestrator' | string;
  action: string;
  details: string;
}

/**
 * File change statistics (+lines / -lines).
 */
export interface FileChangeStat {
  file: string;
  additions: number;
  deletions: number;
}

/**
 * Structured representation of teamwork/PROGRESS.md.
 */
export interface ProgressState {
  title: string;
  milestones: ProgressMilestoneRow[];
  rateLimitStatus: RateLimitStatus;
  lastUpdated: string;
  rateLimitNote?: string;
  executionLogs: ExecutionLogEntry[];
  fileStats: FileChangeStat[];
  rawMarkdown?: string;
}

/**
 * Critic verification issue report.
 */
export interface CriticIssue {
  severity: 'blocker' | 'major' | 'minor';
  fileLocation: string;
  description: string;
  reproduction?: string;
}

/**
 * Result emitted by Critic verification.
 */
export interface CriticResult {
  verdict: CriticVerdict;
  command: string;
  exitCode: number | null;
  outputPreview: string;
  issues: CriticIssue[];
  passCriteriaMet: boolean;
  remediation?: string;
}

/**
 * Active file lock record maintained by FileLockManager.
 */
export interface FileLock {
  filePath: string;
  normalizedPath: string;
  workerId: string;
  acquiredAt: number;
}

/**
 * Event emitted across the Teamwork lifecycle.
 */
export type TeamworkEventType =
  | 'phase_change'
  | 'plan_created'
  | 'plan_confirmed'
  | 'file_locked'
  | 'file_released'
  | 'worker_start'
  | 'worker_done'
  | 'critic_start'
  | 'critic_verdict'
  | 'rate_limit_paused'
  | 'milestone_completed'
  | 'milestone_failed'
  | 'milestone_retry'
  | 'hitl_interrupt'
  | 'done'
  | 'error';

export interface TeamworkEvent {
  type: TeamworkEventType;
  timestamp: number;
  milestoneId?: string;
  workerId?: string;
  message?: string;
  payload?: Record<string, unknown>;
}

/**
 * Compact completion summary (<= 20 lines).
 */
export interface TeamworkRunSummary {
  status: 'COMPLETED' | 'BLOCKED_429' | 'FAILED';
  milestones: Milestone[];
  summaryText: string; // <= 20 lines
  progressFilePath: string;
  changedFiles: string[];
}

/**
 * Teamwork Engine Configuration.
 */
export interface TeamworkEngineConfig {
  workspaceRoot: string;
  model?: unknown;
  integrityMode?: IntegrityMode;
  concurrencyCap?: number; // default: 2
  maxMilestones?: number; // default: 3
  confirmPrompt?: () => Promise<boolean>;
  onEvent?: (event: TeamworkEvent) => void;
}

/**
 * Triad document container.
 */
export interface TeamworkArtifacts {
  requestMd: string;
  planMd: string;
  progressMd: string;
}

/**
 * Update parameters for updating progress board.
 */
export interface ProgressUpdateOptions {
  milestoneId?: string;
  status?: MilestoneStatus;
  worker?: string;
  criticVerdict?: string;
  attempts?: string;
  notes?: string;
  rateLimitStatus?: RateLimitStatus;
  rateLimitNote?: string;
  lastUpdated?: string;
  logEntry?: {
    milestoneId?: string;
    agent: 'teamwork-explorer' | 'teamwork-worker' | 'teamwork-critic' | 'orchestrator' | string;
    action: string;
    details: string;
    timestamp?: string;
  };
  fileStats?: FileChangeStat[];
}

/**
 * Worktree metadata and execution context (inspired by stablyai/orca).
 */
export interface WorktreeContext {
  workerId: string;
  worktreePath: string;
  branchName: string;
  baseCommit: string;
  createdAt: number;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  prunable?: boolean;
}

/**
 * Dependency graph types (inspired by stablyai/orca).
 */
export interface DependencyNode {
  filePath: string;
  imports: string[];
  exports: string[];
  importedBy: string[];
  associatedTests: string[];
}

export interface DisjointnessResult {
  disjoint: boolean;
  overlaps: string[];
  sharedDependencies: string[];
}

/**
 * Capability-based permissions and process tree supervision (inspired by milind-soni/OpenMausBot).
 */
export interface AgentCapabilityScope {
  workerId: string;
  allowedReadGlobs?: string[];
  allowedWriteGlobs?: string[];
  allowedCommands?: string[];
  blockedCommands?: string[];
  allowNetwork?: boolean;
  maxExecutionTimeMs?: number;
}

export interface PermissionCheckResult {
  granted: boolean;
  reason?: string;
  violatingTarget?: string;
}

export interface PermissionAuditLog {
  timestamp: number;
  workerId: string;
  action: 'fs_read' | 'fs_write' | 'fs_edit' | 'shell_exec';
  target: string;
  decision: 'allow' | 'deny';
  reason?: string;
}
