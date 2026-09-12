/**
 * Bitemporal Codebase Ledger Type Definitions.
 * Decouples Valid Time (Tv) from Transaction Time (Tt).
 */

export type LedgerEventType =
  | 'milestone_init'
  | 'file_snapshot'
  | 'file_patch'
  | 'architectural_decision'
  | 'critic_verdict'
  | 'revert'
  | 'entity_state'
  | 'milestone'
  | 'artifact'
  | 'task_exec'
  | 'fix';

export type LedgerAction = 'INSERT' | 'UPDATE' | 'DELETE' | 'COMPENSATE';

export interface BitemporalRecord<T = unknown> {
  id: string;
  sequence: number;
  entityId?: string;
  validFrom: number;
  validTo: number | null;
  validTime?: { from: number; to?: number };
  txFrom: number;
  txTo: number | null;
  transactionTime?: { recordedAt: number; supersededAt?: number };
  eventType: LedgerEventType;
  action: LedgerAction;
  milestoneId: string;
  workerId: string;
  payload: T;
  prevHash: string;
  recordHash: string;
  merkleHash: string;
  parentRecordId?: string;
  metadata?: Record<string, unknown>;
}

export interface AppendRecordInput<T = unknown> {
  entityId?: string;
  eventType?: LedgerEventType;
  action?: LedgerAction;
  milestoneId?: string;
  workerId?: string;
  author?: string;
  payload: T;
  validFrom?: number;
  validTo?: number | null;
  parentRecordId?: string;
  metadata?: Record<string, unknown>;
}

export interface LedgerQueryOptions {
  validTime?: number;
  asOfValidTime?: number;
  txTime?: number;
  asOfTransactionTime?: number;
  entityId?: string;
  milestoneId?: string;
  eventType?: LedgerEventType;
  action?: LedgerAction;
  limit?: number;
}

export interface ReplayOptions {
  validTime?: number;
  asOfValidTime?: number;
  txTime?: number;
  asOfTransactionTime?: number;
  entityId?: string;
  milestoneId?: string;
}

export interface ReplayEntityState<T = unknown> {
  entityId: string;
  state: T | null;
  active: boolean;
  lastModifiedValidTime: number;
  lastModifiedTxTime: number;
  version: number;
  history: BitemporalRecord<T>[];
}

export interface CompensateOptions {
  targetRecordId: string;
  workerId?: string;
  author?: string;
  milestoneId?: string;
  reason?: string;
  inversePayload?: unknown;
}

export interface IntegrityVerificationResult {
  valid: boolean;
  chainLength: number;
  errors: string[];
  tipHash: string;
}
