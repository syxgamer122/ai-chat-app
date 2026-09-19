/**
 * Zero-Mem Entity-Context Graph.
 *
 * Implements an in-memory directed relational graph with weighted edges
 * representing codebase structure, symbols, files, tools, and error provenance.
 * Provides deterministic spreading activation without LLM calls.
 */

import type { ZeroMemEntity, ZeroMemRelation, ZeroMemRelationType } from './types';

export interface GraphNeighbor {
  entity: ZeroMemEntity;
  relation: ZeroMemRelation;
  direction: 'outgoing' | 'incoming';
  hop: number;
}

export class EntityContextGraph {
  private entities: Map<string, ZeroMemEntity> = new Map();
  private outgoing: Map<string, ZeroMemRelation[]> = new Map();
  private incoming: Map<string, ZeroMemRelation[]> = new Map();

  /**
   * Add or update an entity in the graph.
   */
  addEntity(entity: ZeroMemEntity): void {
    const existing = this.entities.get(entity.id);
    if (existing) {
      existing.hitCount += 1;
      existing.updatedAt = Math.max(existing.updatedAt, entity.updatedAt);
      existing.attributes = { ...existing.attributes, ...entity.attributes };
    } else {
      this.entities.set(entity.id, { ...entity });
    }
  }

  getEntity(id: string): ZeroMemEntity | undefined {
    return this.entities.get(id);
  }

  hasEntity(id: string): boolean {
    return this.entities.has(id);
  }

  getAllEntities(): ZeroMemEntity[] {
    return Array.from(this.entities.values());
  }

  /**
   * Add a directed relation (edge) between entities.
   */
  addRelation(relation: ZeroMemRelation): void {
    const outList = this.outgoing.get(relation.sourceId) ?? [];
    // Deduplicate by targetId and relationType
    const existingOutIdx = outList.findIndex(
      (r) => r.targetId === relation.targetId && r.relationType === relation.relationType,
    );
    if (existingOutIdx >= 0) {
      outList[existingOutIdx].weight = Math.max(outList[existingOutIdx].weight, relation.weight);
    } else {
      outList.push(relation);
    }
    this.outgoing.set(relation.sourceId, outList);

    const inList = this.incoming.get(relation.targetId) ?? [];
    const existingInIdx = inList.findIndex(
      (r) => r.sourceId === relation.sourceId && r.relationType === relation.relationType,
    );
    if (existingInIdx >= 0) {
      inList[existingInIdx].weight = Math.max(inList[existingInIdx].weight, relation.weight);
    } else {
      inList.push(relation);
    }
    this.incoming.set(relation.targetId, inList);
  }

  /**
   * Get direct 1-hop or multi-hop neighbors of an entity.
   */
  getNeighbors(entityId: string, maxHops: number = 1): GraphNeighbor[] {
    const results: GraphNeighbor[] = [];
    const visited = new Set<string>([entityId]);
    let currentLevel = [entityId];

    for (let hop = 1; hop <= maxHops; hop++) {
      const nextLevel: string[] = [];
      for (const curr of currentLevel) {
        // Outgoing edges
        const outEdges = this.outgoing.get(curr) ?? [];
        for (const edge of outEdges) {
          if (!visited.has(edge.targetId)) {
            visited.add(edge.targetId);
            const targetEnt = this.entities.get(edge.targetId);
            if (targetEnt) {
              results.push({ entity: targetEnt, relation: edge, direction: 'outgoing', hop });
              nextLevel.push(edge.targetId);
            }
          }
        }
        // Incoming edges
        const inEdges = this.incoming.get(curr) ?? [];
        for (const edge of inEdges) {
          if (!visited.has(edge.sourceId)) {
            visited.add(edge.sourceId);
            const sourceEnt = this.entities.get(edge.sourceId);
            if (sourceEnt) {
              results.push({ entity: sourceEnt, relation: edge, direction: 'incoming', hop });
              nextLevel.push(edge.sourceId);
            }
          }
        }
      }
      currentLevel = nextLevel;
      if (currentLevel.length === 0) break;
    }

    return results;
  }

  /**
   * Deterministic Spreading Activation algorithm across the entity graph.
   * Given seed entity IDs, propagates activation energy along weighted edges with decay.
   *
   * @param seedEntityIds List of entity IDs matching query keywords
   * @param maxHops Maximum propagation distance (default: 2)
   * @param decayFactor Decay multiplier per hop (default: 0.6)
   * @returns Map of entity ID to activation score (0.0 to 1.0)
   */
  spreadActivation(
    seedEntityIds: string[],
    maxHops: number = 2,
    decayFactor: number = 0.6,
  ): Map<string, number> {
    const activation = new Map<string, number>();

    // Initialize seeds with 1.0 energy
    for (const seedId of seedEntityIds) {
      if (this.entities.has(seedId)) {
        activation.set(seedId, 1.0);
      }
    }

    let activeNodes = new Map(activation);

    for (let hop = 1; hop <= maxHops; hop++) {
      const nextActive = new Map<string, number>();

      for (const [nodeId, currentEnergy] of activeNodes.entries()) {
        const outEdges = this.outgoing.get(nodeId) ?? [];
        for (const edge of outEdges) {
          const transferred = currentEnergy * edge.weight * decayFactor;
          const prev = activation.get(edge.targetId) ?? 0;
          if (transferred > prev) {
            activation.set(edge.targetId, transferred);
            nextActive.set(edge.targetId, transferred);
          }
        }

        const inEdges = this.incoming.get(nodeId) ?? [];
        for (const edge of inEdges) {
          const transferred = currentEnergy * edge.weight * decayFactor * 0.8; // Incoming slightly discounted
          const prev = activation.get(edge.sourceId) ?? 0;
          if (transferred > prev) {
            activation.set(edge.sourceId, transferred);
            nextActive.set(edge.sourceId, transferred);
          }
        }
      }

      activeNodes = nextActive;
      if (activeNodes.size === 0) break;
    }

    return activation;
  }

  /**
   * Serialize graph to plain JSON format.
   */
  toJSON(): {
    entities: ZeroMemEntity[];
    relations: ZeroMemRelation[];
  } {
    const relations: ZeroMemRelation[] = [];
    for (const edges of this.outgoing.values()) {
      relations.push(...edges);
    }
    return {
      entities: Array.from(this.entities.values()),
      relations,
    };
  }

  /**
   * Load graph from plain JSON.
   */
  static fromJSON(data: { entities: ZeroMemEntity[]; relations: ZeroMemRelation[] }): EntityContextGraph {
    const graph = new EntityContextGraph();
    for (const ent of data.entities) {
      graph.addEntity(ent);
    }
    for (const rel of data.relations) {
      graph.addRelation(rel);
    }
    return graph;
  }

  clear(): void {
    this.entities.clear();
    this.outgoing.clear();
    this.incoming.clear();
  }

  get stats(): { entityCount: number; relationCount: number } {
    let relCount = 0;
    for (const edges of this.outgoing.values()) {
      relCount += edges.length;
    }
    return {
      entityCount: this.entities.size,
      relationCount: relCount,
    };
  }
}
