/**
 * Zero-Mem Tool Suite.
 *
 * Provides high-level executable tools for the Agent and CLI harness:
 * 1. zeromem_query: Deterministic zero-token search across raw traces & entity graph.
 * 2. zeromem_log: Append raw interaction trace with automatic zero-token entity graph extraction.
 * 3. zeromem_inspect: Deep inspection of entity relations, dependencies, or temporal episodes.
 * 4. zeromem_stats: Real-time report on memory footprint and accumulated LLM token savings.
 */

import { z } from 'zod';
import { ZeroMemStore } from './store';
import type { ZeroMemEntityKind } from './types';

// Global singleton store per workspace
const WORKSPACE_STORES = new Map<string, ZeroMemStore>();

export function getZeroMemStore(workspaceKey: string = 'default'): ZeroMemStore {
  let store = WORKSPACE_STORES.get(workspaceKey);
  if (!store) {
    store = new ZeroMemStore(workspaceKey);
    WORKSPACE_STORES.set(workspaceKey, store);
  }
  return store;
}

export const zeromemQuerySchema = z.object({
  query: z.string().describe('Search query, symbol name, error text, or task objective'),
  max_results: z.number().int().min(1).max(20).optional().describe('Maximum evidences to return (default 5)'),
  mode: z.enum(['hybrid', 'lexical', 'graph']).optional().describe('Retrieval mode (default hybrid)'),
  episode_id: z.string().optional().describe('Target episode ID to filter or boost continuity'),
});

export const zeromemLogSchema = z.object({
  content: z.string().min(1).describe('Raw message or tool result content to record in trace log'),
  role: z.enum(['user', 'assistant', 'tool', 'system']).optional().describe('Trace role (default user)'),
  tool_name: z.string().optional().describe('Tool name if this trace corresponds to a tool execution'),
  episode_id: z.string().optional().describe('Episode or milestone ID'),
});

export const zeromemInspectSchema = z.object({
  target: z.enum(['graph', 'episodes', 'entities']).describe('Inspection view'),
  entity_id: z.string().optional().describe('Specific entity ID to inspect neighbors for'),
  kind: z.enum(['symbol', 'file', 'error', 'tool', 'concept', 'rule']).optional().describe('Filter entities by kind'),
});

export const zeromemStatsSchema = z.object({});

/**
 * Tool execution handlers.
 */
export async function executeZeromemQuery(
  args: z.infer<typeof zeromemQuerySchema>,
  workspaceKey: string = 'default',
) {
  const store = getZeroMemStore(workspaceKey);
  const pack = store.query({
    query: args.query,
    maxResults: args.max_results,
    mode: args.mode,
    episodeId: args.episode_id,
  });

  return {
    ok: true,
    evidencesCount: pack.evidences.length,
    tokensUsed: pack.tokensUsed,
    tokenBudget: pack.tokenBudget,
    injectedBlock: pack.injectedBlock,
    stats: pack.stats,
  };
}

export async function executeZeromemLog(
  args: z.infer<typeof zeromemLogSchema>,
  workspaceKey: string = 'default',
  sessionId: string = 'session-default',
) {
  const store = getZeroMemStore(workspaceKey);
  const trace = store.appendTrace({
    sessionId,
    episodeId: args.episode_id,
    role: args.role ?? 'user',
    content: args.content,
    toolName: args.tool_name,
  });

  return {
    ok: true,
    traceId: trace.id,
    turnIndex: trace.turnIndex,
    extractedEntityIds: trace.entityIds,
    note: `Recorded raw trace #${trace.turnIndex} with ${trace.entityIds.length} extracted entities (0 LLM tokens consumed).`,
  };
}

export async function executeZeromemInspect(
  args: z.infer<typeof zeromemInspectSchema>,
  workspaceKey: string = 'default',
) {
  const store = getZeroMemStore(workspaceKey);

  if (args.target === 'episodes') {
    const episodes = store.getTemporal().getAllEpisodes();
    return {
      ok: true,
      currentEpisodeId: store.getCurrentEpisodeId(),
      episodes,
    };
  }

  if (args.target === 'entities') {
    const allEntities = store.getGraph().getAllEntities();
    const filtered = args.kind
      ? allEntities.filter((e) => e.kind === args.kind)
      : allEntities;
    return {
      ok: true,
      total: allEntities.length,
      matched: filtered.length,
      entities: filtered.slice(0, 50),
    };
  }

  // target === 'graph'
  if (args.entity_id) {
    const neighbors = store.getGraph().getNeighbors(args.entity_id, 2);
    const targetEnt = store.getGraph().getEntity(args.entity_id);
    return {
      ok: true,
      targetEntity: targetEnt,
      neighborsCount: neighbors.length,
      neighbors,
    };
  }

  return {
    ok: true,
    graphSummary: store.getGraph().stats,
  };
}

export async function executeZeromemStats(workspaceKey: string = 'default') {
  const store = getZeroMemStore(workspaceKey);
  return {
    ok: true,
    stats: store.getStats(),
  };
}
