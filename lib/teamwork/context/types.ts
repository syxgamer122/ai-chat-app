/**
 * Temporal Context Memory & Knowledge Ontology Type Definitions.
 */

export interface MilestoneIndexItem {
  id: string;
  title: string;
  status: string;
  worker?: string;
  filesTouched: string[];
  criticVerdict?: string;
  summary?: string;
  durationMs?: number;
}

export interface ArchitecturalDecision {
  id: string;
  milestoneId: string;
  title: string;
  rationale: string;
  constraints: string[];
  rejectedAlternatives?: string[];
  interfaceChanges?: string[];
  timestamp: number;
}

export interface FileDiffItem {
  filePath: string;
  diff: string;
  milestoneId?: string;
  estimatedTokens?: number;
}

export type OntologyPredicate =
  | 'DEFINES_SYMBOL'
  | 'DEPENDS_ON'
  | 'MODIFIES_FILE'
  | 'IMPORTS_FROM'
  | 'ENFORCES_RULE'
  | 'SUPERSEDES_DECISION'
  | 'SATISFIES_REQUIREMENT'
  | string;

export interface SemanticTriple {
  subject: string;
  predicate: OntologyPredicate;
  object: string;
  validFrom: number;
  validTo?: number | null;
  confidence: number;
  sourceMilestone: string;
  metadata?: Record<string, unknown>;
}

export interface TripleQueryFilter {
  subject?: string;
  predicate?: OntologyPredicate;
  object?: string;
  asOf?: number;
  sourceMilestone?: string;
  minConfidence?: number;
}

export interface ContextQueryBudget {
  tier1Tokens?: number;
  tier2Tokens?: number;
  tier3Tokens?: number;
  maxTotalTokens?: number;
}

export interface ContextRenderOptions {
  tier?: 1 | 2 | 3;
  requestedFiles?: string[];
  targetMilestoneId?: string;
  budget?: ContextQueryBudget;
  includeTriples?: boolean;
  asOf?: number;
}

export interface MilestoneContextSummary {
  tier1Index: string;
  tier2Decisions: string;
  tier3Diffs?: string;
  renderedMarkdown: string;
  activeTier: 1 | 2 | 3;
  totalEstimatedTokens: number;
}
