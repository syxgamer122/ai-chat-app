/**
 * Core Types & Data Contracts for Strict Tool Contracts, Provenance & Dual-Gate Guardrails.
 * Security model dùng chung cho thao tác ghi dữ liệu.
 */

import { z } from 'zod';

export type ToolCategory =
  | 'fs_read'
  | 'fs_write'
  | 'shell'
  | 'git'
  | 'web'
  | 'memory'
  | 'plan'
  | 'delegate'
  | 'presentation'
  | 'filesystem'
  | 'test_runner';

export type ToolKind = 'execution' | 'presentation';

export type RiskLevel = 'read' | 'write' | 'destructive' | 'system';

export type AgentRole = 'explorer' | 'worker' | 'critic' | 'orchestrator' | 'human';

/**
 * Dynamic execution context injected securely by the harness.
 * Model inputs CANNOT tamper with or override these runtime properties.
 */
export interface ToolExecutionContext {
  workerId: string;
  milestoneId: string;
  role: AgentRole;
  workspaceRoot: string;
  correlationId?: string;
  authorizationToken?: string;
  dryRun?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Cryptographic provenance record for all resource modifications.
 * Ensures an unbroken chain of custody for every change in the codebase.
 */
export interface ProvenanceRecord {
  id: string;
  timestamp: number;
  workerId: string;
  /** Alias for workerId */
  originatorId?: string;
  milestoneId: string;
  role: AgentRole;
  filePath: string;
  /** Alias for filePath */
  targetResource?: string;
  action: 'create' | 'modify' | 'delete' | 'execute' | 'read';
  /** Alias for action */
  actionType?: 'create' | 'modify' | 'delete' | 'execute' | 'read';
  contentSha256: string;
  contentHashBefore?: string;
  /** Alias for contentSha256 */
  contentHashAfter?: string;
  authorizationToken: string;
  prevRecordHash: string;
  recordHash: string;
  parentRecordId?: string;
}

/**
 * Result returned by Gate 1 (Pre-flight Gate).
 */
export interface PreFlightGateResult {
  passed: boolean;
  reason?: string;
  sanitizedInput?: unknown;
  blockedRule?: string;
  riskScore: number;
}

/** Alias for PreFlightGateResult */
export type PreFlightResult = PreFlightGateResult;

/**
 * Issue detected by Gate 2 (Post-flight Critic Review).
 */
export interface PostFlightIssue {
  severity: 'blocker' | 'major' | 'minor';
  description: string;
  fileLocation?: string;
  reproduction?: string;
}

/**
 * Result returned by Gate 2 (Post-flight Critic Review).
 */
export interface PostFlightReviewResult {
  passed: boolean;
  verdict: 'PASS' | 'FAIL-BLOCKED';
  issues: PostFlightIssue[];
  remediation?: string;
  outputPreview?: string;
}

/** Alias for PostFlightReviewResult */
export type PostFlightResult = PostFlightReviewResult;

/**
 * Production-grade typed tool contract decoupling static Zod validation from dynamic context.
 */
export interface ToolContract<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly kind?: ToolKind;
  readonly category?: ToolCategory;
  readonly riskLevel?: RiskLevel;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  preFlightCheck?: (input: TInput, ctx: ToolExecutionContext) => Promise<PreFlightGateResult> | PreFlightGateResult;
  postFlightReview?: (output: TOutput, ctx: ToolExecutionContext) => Promise<PostFlightReviewResult> | PostFlightReviewResult;
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TOutput>;
}
