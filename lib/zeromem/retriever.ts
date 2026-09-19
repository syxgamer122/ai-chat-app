/**
 * Zero-Mem Deterministic Multi-Stage Retriever (Zero LLM Tokens).
 *
 * Implements:
 * 1. Fast BM25 Lexical Ranking across raw traces and entity descriptions.
 * 2. Spreading Activation across Entity-Context Graph.
 * 3. Temporal Recency & Continuity Calibration.
 * 4. Token-Budget Packing & Prompt Evidence Formatter.
 * 5. Zero-Token Savings Meter.
 */

import { EntityContextGraph } from './graph';
import { TemporalHierarchy } from './temporal';
import type {
  ZeroMemEvidence,
  ZeroMemPack,
  ZeroMemQueryOptions,
  ZeroMemTrace,
  ZeroMemEntity,
} from './types';

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const DEFAULT_MAX_TOKENS = 1200;
export const DEFAULT_MAX_RESULTS = 5;

/**
 * Tokenize string into lowercase alphanumeric words, filtering out common stop words.
 */
export function tokenizeForBM25(text: string): string[] {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with',
    'by', 'of', 'from', 'is', 'are', 'was', 'were', 'be', 'this', 'that',
    'it', 'as', 'if', 'when', 'than', 'into', 'la', 'va', 'cho', 'voi',
  ]);

  return text
    .toLowerCase()
    .split(/[^\p{L}\d_]+/u)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

export class ZeroMemRetriever {
  constructor(
    private graph: EntityContextGraph,
    private temporal: TemporalHierarchy,
  ) {}

  /**
   * Deterministic search over traces and entity graph without LLM calls.
   */
  retrieve(
    traces: ZeroMemTrace[],
    options: ZeroMemQueryOptions,
    now: number = Date.now(),
  ): ZeroMemPack {
    const startTime = Date.now();
    const query = options.query.trim();
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    const tokenBudget = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const mode = options.mode ?? 'hybrid';

    const queryTokens = tokenizeForBM25(query);
    if (queryTokens.length === 0 && !options.episodeId) {
      return {
        evidences: [],
        tokensUsed: 0,
        tokenBudget,
        injectedBlock: '',
        stats: {
          totalTracesScanned: traces.length,
          entitiesMatched: 0,
          hopsExplored: 0,
          zeroLlmTokensSaved: 0,
          durationMs: Date.now() - startTime,
        },
      };
    }

    // --- STEP 1: BM25 Lexical Scoring on Traces ---
    const scoredTraces = this.scoreTracesBM25(traces, queryTokens);

    // --- STEP 2: Find Seed Entities and Spread Activation ---
    const allEntities = this.graph.getAllEntities();
    const seedEntityIds: string[] = [];

    for (const ent of allEntities) {
      const entTokens = tokenizeForBM25(`${ent.name} ${JSON.stringify(ent.attributes)}`);
      const hasMatch = queryTokens.some((qt) => entTokens.includes(qt) || ent.name.toLowerCase().includes(qt));
      if (hasMatch) {
        seedEntityIds.push(ent.id);
      }
    }

    const activationMap =
      mode === 'lexical'
        ? new Map<string, number>()
        : this.graph.spreadActivation(seedEntityIds, 2, 0.6);

    // --- STEP 3: Multi-Stage Scoring ---
    const candidateEvidences: ZeroMemEvidence[] = [];
    const wLexical = options.weights?.lexical ?? (mode === 'graph' ? 0.2 : 0.45);
    const wGraph = options.weights?.graph ?? (mode === 'lexical' ? 0.0 : 0.35);
    const wTemporal = options.weights?.temporal ?? 0.20;

    // A) Process Traces
    const matchedEntityIdsInTraces = new Set<string>();

    for (const item of scoredTraces) {
      const trace = item.trace;
      const rawBm25 = item.score;
      const normLexical = rawBm25 > 0 ? Math.min(1.0, 0.5 + rawBm25 / 3.0) : 0;

      // Graph score: average activation of associated entities
      let graphScore = 0;
      if (trace.entityIds.length > 0 && activationMap.size > 0) {
        let maxAct = 0;
        for (const eid of trace.entityIds) {
          const act = activationMap.get(eid) ?? 0;
          if (act > maxAct) maxAct = act;
        }
        graphScore = maxAct;
      }

      // Temporal recency score
      const temporalScore = this.temporal.computeTemporalScore(
        trace.timestamp,
        trace.episodeId,
        { now, decayHalfLifeMs: options.decayHalfLifeMs, currentEpisodeId: options.episodeId },
      );

      // Combined score: direct trace match has ground-truth boost
      const traceBoost = rawBm25 > 0 ? 0.25 : 0;
      const finalScore =
        normLexical * wLexical + graphScore * wGraph + (temporalScore / 1.25) * wTemporal + traceBoost;

      // Must have lexical or graph relevance (temporal recency alone does not match an unrelated query)
      const hasRelevance = rawBm25 > 0 || graphScore > 0.1;
      if (hasRelevance && finalScore > 0.05) {
        for (const eid of trace.entityIds) {
          matchedEntityIdsInTraces.add(eid);
        }
        candidateEvidences.push({
          id: trace.id,
          kind: 'trace',
          title: `Turn #${trace.turnIndex} (${trace.role}${trace.toolName ? ` : ${trace.toolName}` : ''})`,
          text: trace.content,
          score: finalScore,
          lexicalScore: normLexical,
          graphScore,
          temporalScore,
          entityIds: trace.entityIds,
          provenance: {
            sessionId: trace.sessionId,
            episodeId: trace.episodeId,
            timestamp: trace.timestamp,
          },
        });
      }
    }

    // B) Process Activated Graph Entities (only if not already covered by matched traces)
    if (mode !== 'lexical') {
      for (const [entityId, actScore] of activationMap.entries()) {
        if (matchedEntityIdsInTraces.has(entityId)) continue; // avoid redundancy

        const ent = this.graph.getEntity(entityId);
        if (ent && actScore >= 0.5) {
          const temporalScore = this.temporal.computeTemporalScore(
            ent.updatedAt,
            undefined,
            { now, decayHalfLifeMs: options.decayHalfLifeMs },
          );
          const finalScore = actScore * wGraph + (temporalScore / 1.25) * wTemporal;

          candidateEvidences.push({
            id: ent.id,
            kind: 'entity',
            title: `Entity [${ent.kind}]: ${ent.name}`,
            text: `Entity ${ent.name} (${ent.kind}) | Attributes: ${JSON.stringify(ent.attributes)}`,
            score: finalScore,
            lexicalScore: 0.5,
            graphScore: actScore,
            temporalScore,
            entityIds: [ent.id],
            provenance: {
              timestamp: ent.updatedAt,
            },
          });
        }
      }
    }

    // Sort candidates descending by score
    candidateEvidences.sort((a, b) => b.score - a.score);

    // --- STEP 4: Token Budget Packing ---
    const packedEvidences: ZeroMemEvidence[] = [];
    let estimatedTokensUsed = 0;
    const approxTokens = (str: string) => Math.ceil(str.length / 3.8);

    for (const cand of candidateEvidences) {
      if (packedEvidences.length >= maxResults) break;
      const tokens = approxTokens(cand.text) + 20; // 20 tokens overhead for headers
      if (estimatedTokensUsed + tokens > tokenBudget && packedEvidences.length > 0) {
        continue; // Skip if exceeds budget
      }
      packedEvidences.push(cand);
      estimatedTokensUsed += tokens;
    }

    // --- STEP 5: Format Prompt-Ready Evidence Block ---
    const injectedBlock = this.formatEvidenceBlock(packedEvidences);

    // Zero-Token Savings Calculation:
    // Traditional LLM memory architectures consume ~750 tokens per memory search/summary round.
    // Zero-Mem executes deterministically with 0 LLM calls!
    const estimatedSaved = 750 + traces.length * 15;

    return {
      evidences: packedEvidences,
      tokensUsed: estimatedTokensUsed,
      tokenBudget,
      injectedBlock,
      stats: {
        totalTracesScanned: traces.length,
        entitiesMatched: seedEntityIds.length,
        hopsExplored: activationMap.size,
        zeroLlmTokensSaved: estimatedSaved,
        durationMs: Date.now() - startTime,
      },
    };
  }

  /**
   * Format packed evidence into a markdown block for agent prompt context.
   */
  private formatEvidenceBlock(evidences: ZeroMemEvidence[]): string {
    if (evidences.length === 0) return '';

    const lines: string[] = [
      '<zero-mem-evidence source="zero-mem" mode="deterministic-zero-token">',
      'The following high-confidence context traces were retrieved deterministically from prior interactions without LLM overhead:',
    ];

    for (const ev of evidences) {
      lines.push(`\n### [${ev.kind.toUpperCase()}] ${ev.title} (Relevance Score: ${ev.score.toFixed(2)})`);
      lines.push(ev.text.trim());
    }

    lines.push('\n</zero-mem-evidence>');
    return lines.join('\n');
  }

  /**
   * Internal BM25 scoring across traces.
   */
  private scoreTracesBM25(
    traces: ZeroMemTrace[],
    queryTokens: string[],
  ): Array<{ trace: ZeroMemTrace; score: number }> {
    if (traces.length === 0 || queryTokens.length === 0) return [];

    // Document lengths & Average doc length
    const docTokensList = traces.map((t) => tokenizeForBM25(t.content));
    const totalLen = docTokensList.reduce((acc, t) => acc + t.length, 0);
    const avgDl = totalLen / (traces.length || 1);

    // Calculate Document Frequencies (DF)
    const dfMap = new Map<string, number>();
    for (const tokens of docTokensList) {
      const seen = new Set(tokens);
      for (const token of seen) {
        dfMap.set(token, (dfMap.get(token) ?? 0) + 1);
      }
    }

    const N = traces.length;
    const scored: Array<{ trace: ZeroMemTrace; score: number }> = [];

    for (let i = 0; i < traces.length; i++) {
      const trace = traces[i];
      const tokens = docTokensList[i];
      const docLen = tokens.length;

      // Term Frequencies in current document
      const tfMap = new Map<string, number>();
      for (const t of tokens) {
        tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
      }

      let docScore = 0;
      for (const qToken of queryTokens) {
        const tf = tfMap.get(qToken) ?? 0;
        if (tf === 0) continue;

        const df = dfMap.get(qToken) ?? 0;
        // Standard Robertson-Spärck Jones IDF
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

        // BM25 TF formula
        const tfComponent =
          (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDl)));

        docScore += idf * tfComponent;
      }

      scored.push({ trace, score: docScore });
    }

    return scored;
  }
}
