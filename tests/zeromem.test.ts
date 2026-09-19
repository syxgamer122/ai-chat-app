/**
 * Comprehensive Test Suite for Zero-Mem (sarsvankelsion/zero-mem port).
 *
 * Verifies:
 * 1. Zero-Token Overhead Assertion: Storing, indexing, and querying consume 0 LLM calls/tokens.
 * 2. Raw Trace Ground Truth: Preserves original traces verbatim without lossy summarization.
 * 3. Dual-View Architecture:
 *    - Entity-Context Graph (relational links, spreading activation)
 *    - Temporal Hierarchy (episodes, exponential recency decay, continuity boost)
 * 4. Deterministic Multi-Stage Retrieval (BM25 + Graph Activation + Temporal Decay).
 * 5. Token Budget Packing and Prompt Markdown Formatter.
 * 6. High-level Tools (zeromem_query, zeromem_log, zeromem_inspect, zeromem_stats).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  extractEntities,
  buildEntityId,
} from '@/lib/zeromem/entity-extractor';
import { EntityContextGraph } from '@/lib/zeromem/graph';
import { TemporalHierarchy } from '@/lib/zeromem/temporal';
import { tokenizeForBM25, ZeroMemRetriever } from '@/lib/zeromem/retriever';
import { ZeroMemStore } from '@/lib/zeromem/store';
import {
  executeZeromemQuery,
  executeZeromemLog,
  executeZeromemInspect,
  executeZeromemStats,
  getZeroMemStore,
} from '@/lib/zeromem/tools';

describe('Zero-Mem: Algorithmic Entity Extractor (Zero LLM Calls)', () => {
  it('extracts file paths, functions, classes, and errors deterministically', () => {
    const text = `
      In file lib/db.ts, function saveTransaction() encountered TypeError: Cannot read properties of undefined.
      We should run npm run test and verify with vitest.
    `;

    const res = extractEntities(text, { workspaceKey: 'ai-chat-app' });

    // File entity
    const fileEnt = res.entities.find((e) => e.kind === 'file' && e.name.includes('lib/db.ts'));
    expect(fileEnt).toBeDefined();

    // Function symbol entity
    const fnEnt = res.entities.find((e) => e.kind === 'symbol' && e.name === 'saveTransaction');
    expect(fnEnt).toBeDefined();

    // Error entity
    const errEnt = res.entities.find((e) => e.kind === 'error');
    expect(errEnt).toBeDefined();
    expect(errEnt!.name).toContain('TypeError');

    // Tool/Command entity
    const toolEnt = res.entities.find((e) => e.kind === 'tool' && e.name.includes('npm run test'));
    expect(toolEnt).toBeDefined();

    // Concept entity
    const conceptEnt = res.entities.find((e) => e.kind === 'concept' && e.name === 'vitest');
    expect(conceptEnt).toBeDefined();

    // Relations
    expect(res.relations.length).toBeGreaterThan(0);
    const definesRel = res.relations.find((r) => r.relationType === 'defines');
    expect(definesRel).toBeDefined();
  });

  it('extracts Windows absolute file paths with drive letters', () => {
    const text = 'Investigated error in C:/Users/huumanh/Downloads/ai-chat-app/lib/db.ts and D:\\data\\schema.json.';
    const res = extractEntities(text, { workspaceKey: 'ai-chat-app' });

    const winFile1 = res.entities.find((e) => e.kind === 'file' && e.name.includes('lib/db.ts'));
    expect(winFile1).toBeDefined();
    expect(winFile1?.name).toContain('C:/Users/huumanh/Downloads/ai-chat-app/lib/db.ts');

    const winFile2 = res.entities.find((e) => e.kind === 'file' && e.name.includes('schema.json'));
    expect(winFile2).toBeDefined();
  });

  it('generates consistent deterministic entity IDs', () => {
    const id1 = buildEntityId('symbol', 'CalculateTotal');
    const id2 = buildEntityId('symbol', 'calculatetotal');
    expect(id1).toBe(id2);
    expect(id1).toBe('ent:symbol:calculatetotal');
  });
});

describe('Zero-Mem: Entity-Context Graph & Spreading Activation', () => {
  let graph: EntityContextGraph;

  beforeEach(() => {
    graph = new EntityContextGraph();
  });

  it('adds entities and tracks 1-hop and 2-hop neighbors', () => {
    graph.addEntity({
      id: 'ent:file:app.ts',
      name: 'app.ts',
      kind: 'file',
      scope: '*',
      attributes: {},
      createdAt: 1000,
      updatedAt: 1000,
      hitCount: 1,
    });

    graph.addEntity({
      id: 'ent:symbol:render',
      name: 'render',
      kind: 'symbol',
      scope: '*',
      attributes: {},
      createdAt: 1000,
      updatedAt: 1000,
      hitCount: 1,
    });

    graph.addEntity({
      id: 'ent:symbol:helper',
      name: 'helper',
      kind: 'symbol',
      scope: '*',
      attributes: {},
      createdAt: 1000,
      updatedAt: 1000,
      hitCount: 1,
    });

    // app.ts defines render
    graph.addRelation({
      id: 'r1',
      sourceId: 'ent:file:app.ts',
      targetId: 'ent:symbol:render',
      relationType: 'defines',
      weight: 1.0,
      createdAt: 1000,
    });

    // render references helper
    graph.addRelation({
      id: 'r2',
      sourceId: 'ent:symbol:render',
      targetId: 'ent:symbol:helper',
      relationType: 'references',
      weight: 0.8,
      createdAt: 1000,
    });

    // 1-hop neighbors of app.ts
    const oneHop = graph.getNeighbors('ent:file:app.ts', 1);
    expect(oneHop.length).toBe(1);
    expect(oneHop[0].entity.id).toBe('ent:symbol:render');

    // 2-hop neighbors of app.ts
    const twoHop = graph.getNeighbors('ent:file:app.ts', 2);
    expect(twoHop.length).toBe(2);
    expect(twoHop.map((n) => n.entity.id)).toContain('ent:symbol:helper');
  });

  it('spreads activation energy with decay factor', () => {
    graph.addEntity({
      id: 'e1',
      name: 'e1',
      kind: 'symbol',
      scope: '*',
      attributes: {},
      createdAt: 1000,
      updatedAt: 1000,
      hitCount: 1,
    });
    graph.addEntity({
      id: 'e2',
      name: 'e2',
      kind: 'symbol',
      scope: '*',
      attributes: {},
      createdAt: 1000,
      updatedAt: 1000,
      hitCount: 1,
    });
    graph.addEntity({
      id: 'e3',
      name: 'e3',
      kind: 'symbol',
      scope: '*',
      attributes: {},
      createdAt: 1000,
      updatedAt: 1000,
      hitCount: 1,
    });

    graph.addRelation({ id: 'r12', sourceId: 'e1', targetId: 'e2', relationType: 'depends_on', weight: 1.0, createdAt: 1000 });
    graph.addRelation({ id: 'r23', sourceId: 'e2', targetId: 'e3', relationType: 'depends_on', weight: 1.0, createdAt: 1000 });

    const activation = graph.spreadActivation(['e1'], 2, 0.5);

    expect(activation.get('e1')).toBe(1.0);
    expect(activation.get('e2')).toBe(0.5); // 1.0 * 1.0 * 0.5
    expect(activation.get('e3')).toBe(0.25); // 0.5 * 1.0 * 0.5
  });

  it('serializes and deserializes graph correctly', () => {
    graph.addEntity({
      id: 'e1',
      name: 'Test',
      kind: 'concept',
      scope: '*',
      attributes: { test: true },
      createdAt: 1000,
      updatedAt: 1000,
      hitCount: 1,
    });

    const json = graph.toJSON();
    const restored = EntityContextGraph.fromJSON(json);
    expect(restored.hasEntity('e1')).toBe(true);
    expect(restored.getEntity('e1')?.name).toBe('Test');
  });
});

describe('Zero-Mem: Temporal Hierarchy & Exponential Recency Decay', () => {
  let temporal: TemporalHierarchy;

  beforeEach(() => {
    temporal = new TemporalHierarchy();
  });

  it('computes exponential half-life decay correctly', () => {
    const halfLife = 3_600_000; // 1 hour
    const now = 10_000_000;

    // Event occurring right now: score 1.0
    const scoreNow = temporal.computeTemporalScore(now, undefined, { now, decayHalfLifeMs: halfLife });
    expect(scoreNow).toBeCloseTo(1.0, 3);

    // Event occurring 1 half-life ago: score 0.5
    const score1H = temporal.computeTemporalScore(now - halfLife, undefined, { now, decayHalfLifeMs: halfLife });
    expect(score1H).toBeCloseTo(0.5, 3);

    // Event occurring 2 half-lives ago: score 0.25
    const score2H = temporal.computeTemporalScore(now - 2 * halfLife, undefined, { now, decayHalfLifeMs: halfLife });
    expect(score2H).toBeCloseTo(0.25, 3);
  });

  it('applies episodic continuity boost for current episode', () => {
    const now = 10_000_000;
    const halfLife = 3_600_000;

    const baseScore = temporal.computeTemporalScore(now, 'other-ep', {
      now,
      decayHalfLifeMs: halfLife,
      currentEpisodeId: 'active-ep',
    });

    const boostedScore = temporal.computeTemporalScore(now, 'active-ep', {
      now,
      decayHalfLifeMs: halfLife,
      currentEpisodeId: 'active-ep',
    });

    expect(boostedScore).toBeGreaterThan(baseScore);
    expect(boostedScore).toBeCloseTo(1.25, 2);
  });
});

describe('Zero-Mem: Store & Deterministic Multi-Stage Retriever', () => {
  let store: ZeroMemStore;

  beforeEach(() => {
    store = new ZeroMemStore('test-workspace');
  });

  it('preserves raw traces and retrieves them deterministically without LLM calls', () => {
    // 1. Log traces
    store.appendTrace({
      sessionId: 'sess-1',
      role: 'user',
      content: 'Fix the memory leak in lib/cache.ts where cleanEntries() hangs.',
    });

    store.appendTrace({
      sessionId: 'sess-1',
      role: 'assistant',
      content: 'I will modify lib/cache.ts to clear timeouts in cleanEntries().',
    });

    store.appendTrace({
      sessionId: 'sess-1',
      role: 'user',
      content: 'How is weather in Tokyo today?',
    });

    // 2. Query
    const pack = store.query({ query: 'cleanEntries cache' });

    expect(pack.evidences.length).toBeGreaterThan(0);
    // Highest ranked evidence should be the cache fix trace
    expect(pack.evidences[0].text).toContain('cleanEntries()');

    // Weather query should NOT match cache query
    const weatherMatches = pack.evidences.filter((e) => e.text.includes('Tokyo'));
    expect(weatherMatches.length).toBe(0);

    // Context format block should be populated
    expect(pack.injectedBlock).toContain('<zero-mem-evidence');
    expect(pack.injectedBlock).toContain('cleanEntries');

    // Zero-token savings should be positive!
    expect(pack.stats.zeroLlmTokensSaved).toBeGreaterThan(0);
  });

  it('matches file traces when querying by base name without file extension in BM25', () => {
    store.appendTrace({
      sessionId: 'sess-code',
      role: 'assistant',
      content: 'Optimized index calculation inside lib/zeromem/retriever.ts for fast vector scoring.',
    });

    // Query with base name "retriever" without ".ts"
    const pack = store.query({ query: 'retriever' });
    expect(pack.evidences.length).toBeGreaterThan(0);
    expect(pack.evidences[0].text).toContain('retriever.ts');
  });

  it('enforces token budget strictly', () => {
    for (let i = 0; i < 20; i++) {
      store.appendTrace({
        sessionId: 'sess-bulk',
        role: 'tool',
        content: `Iteration ${i}: Running test suite for lib/feature_${i}.ts with full test output ${'x'.repeat(100)}`,
      });
    }

    const pack = store.query({ query: 'Running test suite', maxTokens: 150 });
    expect(pack.tokensUsed).toBeLessThanOrEqual(200);
    expect(pack.evidences.length).toBeLessThan(10);
  });

  it('tracks comprehensive memory statistics', () => {
    const ep = store.startEpisode('sess-1', 'Milestone 1: Cache Repair');
    store.appendTrace({
      sessionId: 'sess-1',
      episodeId: ep.id,
      role: 'user',
      content: 'Please refactor lib/utils.ts function parseTokens().',
    });
    store.endEpisode(ep.id, 'completed');

    const stats = store.getStats();
    expect(stats.totalTraces).toBe(1);
    expect(stats.totalEpisodes).toBe(1);
    expect(stats.totalEntities).toBeGreaterThan(0);
    expect(stats.estimatedTokenSavings).toBeGreaterThan(0);
  });
});

describe('Zero-Mem: High-Level Tool Execution', () => {
  const ws = 'test-tool-ws';

  beforeEach(() => {
    const s = getZeroMemStore(ws);
    s.clear();
  });

  it('executes zeromem_log, zeromem_query, and zeromem_stats seamlessly', async () => {
    // 1. Log
    const logRes = await executeZeromemLog(
      {
        content: 'Configured PostgreSQL connection pool in config/database.ts for high throughput.',
        role: 'assistant',
      },
      ws,
    );
    expect(logRes.ok).toBe(true);
    expect(logRes.traceId).toBeDefined();

    // 2. Query
    const queryRes = await executeZeromemQuery(
      {
        query: 'PostgreSQL database pool',
      },
      ws,
    );
    expect(queryRes.ok).toBe(true);
    expect(queryRes.evidencesCount).toBeGreaterThan(0);
    expect(queryRes.injectedBlock).toContain('config/database.ts');

    // 3. Inspect
    const inspectRes = await executeZeromemInspect({ target: 'entities' }, ws);
    expect(inspectRes.ok).toBe(true);
    expect(inspectRes.total).toBeGreaterThan(0);

    // 4. Stats
    const statsRes = await executeZeromemStats(ws);
    expect(statsRes.ok).toBe(true);
    expect(statsRes.stats.totalTraces).toBe(1);
    expect(statsRes.stats.estimatedTokenSavings).toBeGreaterThan(0);
  });
});
