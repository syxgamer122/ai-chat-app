/**
 * Types and interfaces for visual inspection, diff visualization, flow sketches,
 * code outlines, show-me markdown builders, and cybernetic control loops.
 * Conforms to PROJECT.md § Interface Contracts.
 */

import type { ApprovalRequest } from '../hitl/types';

export interface VisualDiffOptions {
  color?: boolean;
  contextLines?: number;
  maxLines?: number;
  detectDanger?: boolean;
  showHunkHeaders?: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: string[];
}

export interface VisualDiffResult {
  filePath: string;
  additions: number;
  deletions: number;
  totalChanges: number;
  diffText: string;
  hunks: DiffHunk[];
  isBinary: boolean;
  dangerFlags: string[];
  summary: string;
}

export interface FlowSketchNode {
  id: string;
  name?: string;
  status: string; // 'pending' | 'ready' | 'running' | 'reviewing' | 'completed' | 'failed' | 'interrupted' | 'blocked'
  dependsOn?: string[];
}

export interface FlowSketchOptions {
  format?: 'ascii' | 'unicode';
  showStatusSymbols?: boolean;
  activeNodeId?: string;
  highlightGates?: boolean;
  compact?: boolean;
}

export type CodeShapeItemType =
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'type'
  | 'enum'
  | 'variable'
  | 'property';

export interface CodeShapeItem {
  type: CodeShapeItemType;
  name: string;
  exported: boolean;
  signature: string;
  line: number;
  docstring?: string;
  children?: CodeShapeItem[];
}

export interface CodeShapeResult {
  filePath: string;
  items: CodeShapeItem[];
  summary: string;
  formatted: string;
}

export interface ShowMeParams {
  actionTitle?: string;
  workerId?: string;
  target?: string;
  action?: string;
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskScore?: number;
  riskReasons?: string[];
  diff?: VisualDiffResult | string;
  flowSketch?: string;
  codeShape?: CodeShapeResult | string;
  proposedCommand?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  decisionOptions?: string[];
}

/**
 * PROJECT.md interface contract for VisualDiffVisualizer
 */
export interface VisualDiffVisualizer {
  renderDiff(oldContent: string | null, newContent: string, options?: VisualDiffOptions): string;
  renderFlowSketch(nodes: FlowSketchNode[], activeNodeId?: string, options?: FlowSketchOptions): string;
  renderCodeShape(filePath: string, content: string): string;
  buildShowMeArtifact(request: ApprovalRequest): string;
}

// ----------------------------------------------------
// Cybernetic Control Loop Types
// ----------------------------------------------------

export interface SensorTelemetry {
  timestamp: number;
  activeFileLocks: string[];
  gitClean: boolean;
  gitStatusSummary?: string;
  criticVerdict?: 'PASS' | 'FAIL-BLOCKED' | 'PENDING';
  lastExitCode?: number;
  rateLimitStatus: 'HEALTHY' | 'BLOCKED_429';
  consecutiveFailures: number;
  cpuUsagePct?: number;
  memoryUsageMb?: number;
  reportedErrors: string[];
}

export type ControllerActionType =
  | 'PROCEED'
  | 'RETRY'
  | 'INTERRUPT'
  | 'HALT_429'
  | 'REMEDIATE'
  | 'ABORT';

export interface ControllerDecision {
  action: ControllerActionType;
  target?: string;
  reason: string;
  errorDelta: number; // 0 = converged / goal reached, >0 = error distance
  recommendedDelayMs?: number;
  instructions?: string;
  payload?: Record<string, unknown>;
}

export interface ActuatorExecutionResult {
  tool: string;
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
  timestamp: number;
}

export type DisturbanceType =
  | 'RATE_LIMIT_429'
  | 'CRITIC_FAIL'
  | 'PROCESS_TIMEOUT'
  | 'LOCK_CONTENTION'
  | 'DIRTY_WORKTREE'
  | 'CIRCUIT_BREAKER';

export interface DisturbanceSignal {
  type: DisturbanceType;
  severity: 'WARNING' | 'ERROR' | 'FATAL';
  message: string;
  source: string;
  occurredAt: number;
  details?: unknown;
}
