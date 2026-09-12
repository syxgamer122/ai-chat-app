/**
 * Semantic Knowledge Ontology Triples & Graph Reasoning.
 * Represents codebase architectural facts, rules, and relationships as queryable
 * (Subject, Predicate, Object) triples with temporal validity intervals.
 */

import { ArchitecturalDecision, MilestoneIndexItem, SemanticTriple, TripleQueryFilter } from './types';

export class KnowledgeOntology {
  private readonly triples: SemanticTriple[] = [];

  /**
   * Adds a single semantic triple to the ontology.
   */
  public addTriple(triple: SemanticTriple): void {
    this.triples.push(triple);
  }

  /**
   * Adds multiple semantic triples to the ontology.
   */
  public addTriples(triples: SemanticTriple[]): void {
    this.triples.push(...triples);
  }

  /**
   * Queries triples active at asOf time matching the specified filter criteria.
   */
  public queryTriples(filter: TripleQueryFilter = {}): SemanticTriple[] {
    const asOfTime = filter.asOf ?? Date.now();

    return this.triples.filter((t) => {
      // Temporal validity: [validFrom, validTo)
      const valid = t.validFrom <= asOfTime && (t.validTo === null || t.validTo === undefined || asOfTime < t.validTo);
      if (!valid) return false;

      if (filter.subject && t.subject !== filter.subject) return false;
      if (filter.predicate && t.predicate !== filter.predicate) return false;
      if (filter.object && t.object !== filter.object) return false;
      if (filter.sourceMilestone && t.sourceMilestone !== filter.sourceMilestone) return false;
      if (filter.minConfidence !== undefined && t.confidence < filter.minConfidence) return false;

      return true;
    });
  }

  /**
   * Finds all forward relationships originating from a subject.
   */
  public findForwardRelations(subject: string, predicate?: string, asOf?: number): SemanticTriple[] {
    return this.queryTriples({ subject, predicate, asOf });
  }

  /**
   * Finds all reverse relationships targeting an object.
   */
  public findReverseRelations(object: string, predicate?: string, asOf?: number): SemanticTriple[] {
    return this.queryTriples({ object, predicate, asOf });
  }

  /**
   * Graph traversal: finds all entities connected to startEntity within maxDepth,
   * with cycle prevention.
   */
  public findConnectedEntities(
    startEntity: string,
    options?: {
      maxDepth?: number;
      predicates?: string[];
      asOf?: number;
      direction?: 'forward' | 'reverse' | 'both';
    }
  ): Set<string> {
    const maxDepth = options?.maxDepth ?? 3;
    const direction = options?.direction ?? 'both';
    const allowedPredicates = options?.predicates ? new Set(options.predicates) : null;
    const asOf = options?.asOf ?? Date.now();

    const visited = new Set<string>();
    const queue: Array<{ entity: string; depth: number }> = [{ entity: startEntity, depth: 0 }];
    visited.add(startEntity);

    while (queue.length > 0) {
      const { entity, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const candidates: string[] = [];

      if (direction === 'forward' || direction === 'both') {
        const forward = this.queryTriples({ subject: entity, asOf });
        for (const t of forward) {
          if (!allowedPredicates || allowedPredicates.has(t.predicate)) {
            candidates.push(t.object);
          }
        }
      }

      if (direction === 'reverse' || direction === 'both') {
        const reverse = this.queryTriples({ object: entity, asOf });
        for (const t of reverse) {
          if (!allowedPredicates || allowedPredicates.has(t.predicate)) {
            candidates.push(t.subject);
          }
        }
      }

      for (const next of candidates) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push({ entity: next, depth: depth + 1 });
        }
      }
    }

    return visited;
  }

  /**
   * Supersedes an existing triple without deleting history by closing validTo and adding a new triple.
   */
  public supersedeTriple(
    subject: string,
    predicate: string,
    oldObject: string,
    newObject: string,
    options?: { timestamp?: number; milestoneId?: string; confidence?: number }
  ): SemanticTriple {
    const timestamp = options?.timestamp ?? Date.now();
    const milestoneId = options?.milestoneId ?? 'system';
    const confidence = options?.confidence ?? 1.0;

    // Find and close existing matching active triple
    const existing = this.queryTriples({ subject, predicate, object: oldObject, asOf: timestamp });
    for (const t of existing) {
      t.validTo = timestamp;
    }

    const replacement: SemanticTriple = {
      subject,
      predicate,
      object: newObject,
      validFrom: timestamp,
      validTo: null,
      confidence,
      sourceMilestone: milestoneId,
      metadata: { supersededObject: oldObject },
    };

    this.addTriple(replacement);
    return replacement;
  }

  /**
   * Automatically derives semantic triples from a milestone and its architectural decisions.
   */
  public deriveFactsFromMilestone(
    milestone: MilestoneIndexItem,
    decisions: ArchitecturalDecision[] = [],
    timestamp: number = Date.now()
  ): SemanticTriple[] {
    const derived: SemanticTriple[] = [];
    const msSubject = `milestone:${milestone.id}`;

    // Milestone modifies files
    for (const file of milestone.filesTouched) {
      derived.push({
        subject: msSubject,
        predicate: 'MODIFIES_FILE',
        object: `file:${file}`,
        validFrom: timestamp,
        validTo: null,
        confidence: 1.0,
        sourceMilestone: milestone.id,
      });
    }

    // Decisions associated with milestone
    for (const d of decisions.filter((dec) => dec.milestoneId === milestone.id)) {
      const decisionSubject = `decision:${d.id}`;
      derived.push({
        subject: msSubject,
        predicate: 'DEFINES_SYMBOL',
        object: decisionSubject,
        validFrom: d.timestamp || timestamp,
        validTo: null,
        confidence: 1.0,
        sourceMilestone: milestone.id,
        metadata: { title: d.title },
      });

      for (const c of d.constraints) {
        derived.push({
          subject: decisionSubject,
          predicate: 'ENFORCES_RULE',
          object: `constraint:${c}`,
          validFrom: d.timestamp || timestamp,
          validTo: null,
          confidence: 1.0,
          sourceMilestone: milestone.id,
        });
      }
    }

    this.addTriples(derived);
    return derived;
  }

  /**
   * Renders triples into a concise Markdown string for prompt injection.
   */
  public renderKnowledgeTriples(triples?: SemanticTriple[]): string {
    const list = triples ?? this.queryTriples();
    if (list.length === 0) {
      return '_No ontology relationships recorded._';
    }

    return list
      .map((t) => {
        const confStr = t.confidence < 1.0 ? ` (conf: ${t.confidence})` : '';
        return `- (${t.subject}) --[${t.predicate}]--> (${t.object})${confStr}`;
      })
      .join('\n');
  }

  /**
   * Returns count of total stored triples (including historical/closed ones).
   */
  public totalTriplesCount(): number {
    return this.triples.length;
  }

  /**
   * Clears the ontology store.
   */
  public clear(): void {
    this.triples.length = 0;
  }
}
