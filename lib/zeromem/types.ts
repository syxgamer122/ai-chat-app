/**
 * Zero-Mem: Zero-Token Memory Operations for LLM Agents.
 * Conforms to sarsvankelsion/zero-mem architecture & research specification.
 *
 * Core Principles:
 * 1. Zero-Token Overhead: No LLM calls for storing, updating, linking, or retrieving memory.
 * 2. Raw Interaction Trace Source of Record: Verbatim trace preservation without lossy summarization.
 * 3. Dual-View Memory Architecture:
 *    - Entity-Context Graph (relational evidence, symbols, dependencies, tools, files)
 *    - Temporal Hierarchy (sessions, episodes/milestones, turns, exponential recency decay)
 * 4. Deterministic Multi-Stage Retrieval:
 *    - Lexical BM25 ranking + Graph spreading activation + Temporal recency calibration
 *    - Budget-constrained packing into prompt-ready <zero-mem-evidence> context.
 */

export type ZeroMemEntityKind =
  | 'symbol'      // function, class, interface, type, variable, method
  | 'file'        // source code file or directory path
  | 'error'       // diagnostic, stack trace, compile/runtime error
  | 'tool'        // tool name, command execution (e.g. git, npm, shell_run)
  | 'concept'     // architectural concept, framework, library
  | 'rule';       // constraint, coding guideline, invariant

export interface ZeroMemEntity {
  /** Deterministic unique identifier (e.g. `ent:file:lib/db.ts` or `ent:symbol:calculateTotal`) */
  id: string;
  name: string;
  kind: ZeroMemEntityKind;
  /** Workspace scope key (e.g. 'ai-chat-app' or '*' for global) */
  scope: string;
  /** Extracted attributes (e.g. signature, filePath, language, line) */
  attributes: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  hitCount: number;
}

export type ZeroMemRelationType =
  | 'defines'        // file -> symbol
  | 'imports'        // file -> file / symbol
  | 'references'     // symbol -> symbol / file
  | 'modifies'       // tool/trace -> file
  | 'causes_error'   // symbol/tool -> error
  | 'resolves_error' // trace/edit -> error
  | 'depends_on';    // entity -> entity

export interface ZeroMemRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: ZeroMemRelationType;
  weight: number; // 0.0 to 1.0
  createdAt: number;
}

export type ZeroMemTraceRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ZeroMemTrace {
  id: string;
  sessionId: string;
  episodeId: string;
  turnIndex: number;
  role: ZeroMemTraceRole;
  /** Verbatim raw content (unaltered ground truth) */
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  /** Extracted entity IDs associated with this trace */
  entityIds: string[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ZeroMemEpisode {
  id: string;
  sessionId: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  status: 'active' | 'completed' | 'failed';
  traceCount: number;
}

export interface ZeroMemQueryOptions {
  query: string;
  workspaceKey?: string;
  episodeId?: string;
  maxResults?: number;
  maxTokens?: number;
  mode?: 'hybrid' | 'lexical' | 'graph';
  /** Half-life in milliseconds for exponential recency decay (default: 3600000 = 1 hour) */
  decayHalfLifeMs?: number;
  /** Weight coefficients for hybrid score (must sum to ~1.0) */
  weights?: {
    lexical?: number; // default: 0.45
    graph?: number;   // default: 0.35
    temporal?: number;// default: 0.20
  };
}

export interface ZeroMemEvidence {
  id: string;
  kind: 'trace' | 'entity' | 'relation';
  title: string;
  text: string;
  score: number;
  lexicalScore: number;
  graphScore: number;
  temporalScore: number;
  entityIds: string[];
  provenance: {
    sessionId?: string;
    episodeId?: string;
    timestamp: number;
  };
}

export interface ZeroMemPack {
  evidences: ZeroMemEvidence[];
  tokensUsed: number;
  tokenBudget: number;
  injectedBlock: string;
  stats: {
    totalTracesScanned: number;
    entitiesMatched: number;
    hopsExplored: number;
    zeroLlmTokensSaved: number;
    durationMs: number;
  };
}

export interface ZeroMemStats {
  totalEntities: number;
  totalRelations: number;
  totalTraces: number;
  totalEpisodes: number;
  estimatedTokenSavings: number;
  workspaceKey: string;
}
