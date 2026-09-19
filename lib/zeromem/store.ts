/**
 * Zero-Mem Store — Central Memory Coordinator.
 *
 * Coordinates:
 * - In-memory Raw Trace Append-Only Log
 * - Entity-Context Graph
 * - Temporal Hierarchy & Episodes
 * - Deterministic Multi-Stage Retriever
 * - Cumulative Zero-Token Savings Tracker
 */

import { extractEntities } from './entity-extractor';
import { EntityContextGraph } from './graph';
import { ZeroMemRetriever } from './retriever';
import { TemporalHierarchy } from './temporal';
import type {
  ZeroMemEpisode,
  ZeroMemPack,
  ZeroMemQueryOptions,
  ZeroMemStats,
  ZeroMemTrace,
  ZeroMemTraceRole,
} from './types';

export class ZeroMemStore {
  private traces: ZeroMemTrace[] = [];
  private graph: EntityContextGraph;
  private temporal: TemporalHierarchy;
  private retriever: ZeroMemRetriever;
  private currentEpisodeId?: string;
  private cumulativeTokensSaved = 0;

  constructor(
    public readonly workspaceKey: string = 'default',
  ) {
    this.graph = new EntityContextGraph();
    this.temporal = new TemporalHierarchy();
    this.retriever = new ZeroMemRetriever(this.graph, this.temporal);
  }

  /**
   * Start a new episodic context (e.g. task milestone or coding session branch).
   */
  startEpisode(sessionId: string, title: string, now: number = Date.now()): ZeroMemEpisode {
    const episodeId = `ep-${now}-${Math.random().toString(36).slice(2, 7)}`;
    const episode: ZeroMemEpisode = {
      id: episodeId,
      sessionId,
      title,
      startedAt: now,
      status: 'active',
      traceCount: 0,
    };
    this.temporal.registerEpisode(episode);
    this.currentEpisodeId = episodeId;
    return episode;
  }

  /**
   * Complete or terminate the active episode.
   */
  endEpisode(episodeId: string, status: 'completed' | 'failed' = 'completed', now: number = Date.now()): void {
    const ep = this.temporal.getEpisode(episodeId);
    if (ep) {
      ep.endedAt = now;
      ep.status = status;
    }
    if (this.currentEpisodeId === episodeId) {
      this.currentEpisodeId = undefined;
    }
  }

  getCurrentEpisodeId(): string | undefined {
    return this.currentEpisodeId;
  }

  /**
   * Append a raw conversation/tool interaction trace into the append-only log.
   * Automatically extracts entities and links them into the Entity-Context Graph with ZERO LLM calls!
   */
  appendTrace(input: {
    sessionId: string;
    episodeId?: string;
    role: ZeroMemTraceRole;
    content: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolResult?: unknown;
    now?: number;
  }): ZeroMemTrace {
    const now = input.now ?? Date.now();
    const episodeId = input.episodeId ?? this.currentEpisodeId ?? `ep-default-${input.sessionId}`;
    const traceId = `tr-${now}-${this.traces.length + 1}`;

    // Extract entities & relations deterministically
    const extraction = extractEntities(input.content, {
      workspaceKey: this.workspaceKey,
      now,
      toolNameHint: input.toolName,
      filePathHint: typeof input.toolArgs?.path === 'string' ? input.toolArgs.path : undefined,
    });

    // Populate Entity-Context Graph
    const entityIds: string[] = [];
    for (const entity of extraction.entities) {
      this.graph.addEntity(entity);
      entityIds.push(entity.id);
    }
    for (const rel of extraction.relations) {
      this.graph.addRelation(rel);
    }

    const trace: ZeroMemTrace = {
      id: traceId,
      sessionId: input.sessionId,
      episodeId,
      turnIndex: this.traces.length + 1,
      role: input.role,
      content: input.content,
      toolName: input.toolName,
      toolArgs: input.toolArgs,
      toolResult: input.toolResult,
      entityIds,
      timestamp: now,
    };

    this.traces.push(trace);

    // Update episode trace count
    const ep = this.temporal.getEpisode(episodeId);
    if (ep) {
      ep.traceCount += 1;
    }

    // Accumulate estimated tokens saved vs LLM-based memory updates
    // (Traditional memory burns ~400 tokens per trace to summarize)
    this.cumulativeTokensSaved += 400;

    return trace;
  }

  /**
   * Deterministic zero-token retrieval of relevant past context.
   */
  query(options: ZeroMemQueryOptions, now: number = Date.now()): ZeroMemPack {
    const pack = this.retriever.retrieve(
      this.traces,
      {
        workspaceKey: this.workspaceKey,
        episodeId: options.episodeId ?? this.currentEpisodeId,
        ...options,
      },
      now,
    );

    this.cumulativeTokensSaved += pack.stats.zeroLlmTokensSaved;
    return pack;
  }

  /**
   * Get raw traces for inspection or replay.
   */
  getTraces(): readonly ZeroMemTrace[] {
    return this.traces;
  }

  /**
   * Access underlying EntityContextGraph.
   */
  getGraph(): EntityContextGraph {
    return this.graph;
  }

  /**
   * Access underlying TemporalHierarchy.
   */
  getTemporal(): TemporalHierarchy {
    return this.temporal;
  }

  /**
   * Return comprehensive memory statistics.
   */
  getStats(): ZeroMemStats {
    const graphStats = this.graph.stats;
    return {
      totalEntities: graphStats.entityCount,
      totalRelations: graphStats.relationCount,
      totalTraces: this.traces.length,
      totalEpisodes: this.temporal.getAllEpisodes().length,
      estimatedTokenSavings: this.cumulativeTokensSaved,
      workspaceKey: this.workspaceKey,
    };
  }

  clear(): void {
    this.traces = [];
    this.graph.clear();
    this.temporal.clear();
    this.currentEpisodeId = undefined;
    this.cumulativeTokensSaved = 0;
  }
}
