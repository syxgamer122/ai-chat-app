# Project: Vyen Multi-Agent Architecture & Capability Enhancement

## Architecture
Vyen is a high-assurance multi-agent coding harness running dual-mode (headless CLI and desktop Electron). Dự án tổng hợp các mẫu kiến trúc tiên tiến vào `lib/teamwork/`:
1. **DAG bền vững & song song hoá**: Durable DAG task execution, topological ordering, parallel branches, concurrency semaphores, exponential backoff with randomized jitter, durable state checkpoints, and pause/resume lifecycle.
2. **Human-in-the-loop & thẩm định trực quan**: Human-in-the-loop approval interrupts, cryptographic interrupt tokens, visual diff visualizer, ASCII/Unicode flow sketches, code-shape AST outline, `<show-me>` visual inspection artifacts, and cybernetic control loop (Sensor -> Controller -> Actuator -> Disturbance).
3. **Hợp đồng công cụ & sandbox**: Typed Zod tool contracts with strict schema validation, provenance-gated writes with SHA-256 hash chains, dual-gate pre-flight and post-flight guardrails, process sandboxing with regex environment variable scrubbing, CWD lockdown, disposable temp directories, and clean process tree teardown.
4. **Ledger bitemporal & ngữ cảnh**: Bitemporal Codebase Ledger decoupling Valid Time ($T_v$) from Transaction Time ($T_t$), append-only JSONL audit ledger, point-in-time state replay, 3-tier progressive context querying (Index, Decisions, Diffs), and semantic knowledge ontology triples.
5. **Full Compatibility & Zero Regression Engine**: Seamless integration into `TeamworkEngine` (`lib/teamwork/engine.ts`), `HeadlessToolRunner` (`lib/teamwork/tools.ts`), and `bin/teamwork.ts`, maintaining 100% backward compatibility and passing all existing 128 test files (1850+ tests) plus all new test suites.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | DAG Dependency Graph & Topological Sort | Kahn's algorithm topological sorting with cycle detection and parallel independent branches | M1 | DAG & song song hoá |
| 2 | Async Concurrency Limiter & Semaphore | Slot-based semaphore enforcing concurrency ceiling during DAG branch execution | M1 | DAG & song song hoá |
| 3 | Exponential Backoff with Randomized Jitter | Configurable backoff formula `delay = min(max_delay, base * 2^attempt) ± jitter` with full/equal jitter | M1 | DAG & song song hoá |
| 4 | State Checkpoint Serialization | Serialize full task execution state to memory or JSON disk format | M1 | DAG & song song hoá |
| 5 | Pause and Resume Lifecycle | Seamless pause at any node, restart/resume from last valid checkpoint without re-running completed tasks | M1 | DAG & song song hoá |
| 6 | Task Idempotency Tokens | Unique execution idempotency tokens preventing duplicate execution on retry | M1 | DAG & song song hoá |
| 7 | Human-in-the-Loop Approval Gates | Interrupt engine before sensitive operations (destructive writes, critical shell commands) | M2 | Human-in-the-loop |
| 8 | Cryptographic Interrupt Tokens | HMAC/SHA-256 tokens securing approval/rejection authorizations across process boundaries | M2 | Human-in-the-loop |
| 9 | Visual Diff Inspection (`show-me`) | Terminal and markdown unified diff viewer with contextual syntax highlighting | M2 | Human-in-the-loop |
| 10 | ASCII / Unicode Flow Sketches | Concise ASCII graph visualizer illustrating DAG state, active branches, and pending gates | M2 | Human-in-the-loop |
| 11 | Code-Shape AST Outlining | High-level structural outline of modified files (classes, methods, signatures) for review | M2 | Human-in-the-loop |
| 12 | Cybernetic Control Loop | Structured Sensor -> Controller -> Actuator -> Disturbance loop for self-correcting agents | M2 | Human-in-the-loop |
| 13 | Typed Tool Contracts with Zod | Strict schema validation separating static rules from dynamic execution context | M3 | Hợp đồng công cụ |
| 14 | Provenance-Gated Resource Writes | Every write tagged with worker ID, milestone ID, auth token, and chained SHA-256 hash | M3 | Hợp đồng công cụ |
| 15 | Dual-Gate Guardrails | Gate 1 (pre-flight schema/lock/path guard) and Gate 2 (post-flight critic review & verifyCommand) | M3 | Hợp đồng công cụ |
| 16 | Environment Variable Scrubbing | Regex-based filtering stripping API keys, secrets, and sensitive tokens from subprocess env | M3 | Sandbox |
| 17 | CWD Lockdown & Temp Isolation | Strict working directory confinement and disposable isolated temp directories per worker | M3 | Sandbox |
| 18 | Process Tree Teardown & Deadlines | Enforce execution deadlines and clean recursive process group termination (taskkill/SIGKILL) | M3 | Sandbox |
| 19 | Bitemporal Context Ledger | Decouple Valid Time ($T_v$) from Transaction Time ($T_t$) in append-only JSONL ledger | M4 | Ledger bitemporal |
| 20 | Historical State Replay & Point-in-Time Query | Reconstruct codebase and milestone state at any $(T_v, T_t)$ coordinate | M4 | Ledger bitemporal |
| 21 | Non-Destructive Compensating Rollback | Roll back milestone changes by appending inverse compensating actions | M4 | Ledger bitemporal |
| 22 | 3-Tier Progressive Context Querying | Tier 1 Index (~100 tokens), Tier 2 Decisions (~400 tokens), Tier 3 Diffs (~1500 tokens) | M4 | Ledger & ngữ cảnh |
| 23 | Semantic Knowledge Ontology | Subject-Predicate-Object triples representing codebase facts and architectural constraints | M4 | Ledger bitemporal |
| 24 | TeamworkEngine DAG & Checkpoint Integration | Wire DAG scheduler, backoff retry, and checkpointing into `lib/teamwork/engine.ts` | M5 | Core Vyen Integration |
| 25 | ToolRunner Strict Contract & Sandbox Integration | Wire Zod tool contracts, provenance, and sandboxing into `lib/teamwork/tools.ts` | M5 | Core Vyen Integration |
| 26 | CLI & Headless Runner Upgrades | Expose DAG visualization, pause/resume flags, approval prompt, and ledger replay in `bin/teamwork.ts` | M5 | Core Vyen Integration |
| 27 | Full Compatibility & Zero Regression Verification | Pass 100% of all existing 128 test files (1850+ tests) and all new Vitest suites | M5 | Core Vyen Integration |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Durable DAG Workflow Engine & Checkpointing | `lib/teamwork/dag/`, `lib/teamwork/checkpoint/` | none | PLANNED |
| M2 | Human-in-the-Loop Approval & Visual Inspection | `lib/teamwork/hitl/`, `lib/teamwork/visual/` | none | PLANNED |
| M3 | Strict Tool Contracts, Provenance & Process Sandbox | `lib/teamwork/contracts/`, `lib/teamwork/sandbox/` | none | PLANNED |
| M4 | Temporal Context Memory & Bitemporal Codebase Ledger | `lib/teamwork/ledger/`, `lib/teamwork/context/` | none | PLANNED |
| M5 | Engine Integration, CLI Runner & Full Regression Pass | `lib/teamwork/engine.ts`, `lib/teamwork/tools.ts`, `lib/teamwork/cli.ts`, `bin/teamwork.ts` | M1, M2, M3, M4 | PLANNED |
| E2E | E2E Testing Suite (Tiers 1-4) | `tests/e2e-dag.test.ts`, `tests/e2e-hitl.test.ts`, `tests/e2e-contracts-sandbox.test.ts`, `tests/e2e-ledger.test.ts`, `tests/e2e-teamwork-integrated.test.ts` | parallel with M1-M5 | PLANNED |

## Interface Contracts

### M1: DAG & Checkpointing (`lib/teamwork/dag/`, `lib/teamwork/checkpoint/`)
```typescript
export interface DagNode<T = unknown> {
  id: string;
  name: string;
  dependsOn: string[];
  execute: (context: DagExecutionContext) => Promise<T>;
  retryPolicy?: RetryPolicy;
  timeoutMs?: number;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterType: 'full' | 'equal' | 'none';
}

export interface DagExecutionResult {
  status: 'COMPLETED' | 'FAILED' | 'PAUSED';
  nodeResults: Map<string, NodeResult>;
  checkpointId?: string;
  durationMs: number;
}

export interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  load(id: string): Promise<Checkpoint | null>;
  list(workflowId: string): Promise<CheckpointSummary[]>;
  latest(workflowId: string): Promise<Checkpoint | null>;
}
```

### M2: HITL & Visual (`lib/teamwork/hitl/`, `lib/teamwork/visual/`)
```typescript
export interface ApprovalRequest {
  id: string;
  token: string;
  action: 'file_write' | 'shell_exec' | 'milestone_advance';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  diffSummary?: string;
  flowSketch?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
}

export interface ApprovalResponse {
  requestId: string;
  decision: 'APPROVED' | 'REJECTED' | 'MODIFIED';
  approver: string;
  comments?: string;
  modifiedPayload?: Record<string, unknown>;
}

export interface VisualDiffVisualizer {
  renderDiff(oldContent: string, newContent: string, options?: DiffOptions): string;
  renderFlowSketch(nodes: DagNode[], activeNodeId?: string): string;
  renderCodeShape(filePath: string, content: string): string;
  buildShowMeArtifact(request: ApprovalRequest): string;
}
```

### M3: Strict Contracts & Sandbox (`lib/teamwork/contracts/`, `lib/teamwork/sandbox/`)
```typescript
export interface ToolContract<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  preFlightCheck: (input: TInput, ctx: ToolExecutionContext) => Promise<PreFlightResult>;
  postFlightReview: (output: TOutput, ctx: ToolExecutionContext) => Promise<PostFlightResult>;
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TOutput>;
}

export interface ProvenanceRecord {
  id: string;
  workerId: string;
  milestoneId: string;
  filePath: string;
  action: 'create' | 'modify' | 'delete';
  contentSha256: string;
  prevRecordHash: string;
  authorizationToken: string;
  timestamp: number;
}

export interface SandboxedProcessOptions {
  cwd: string;
  timeoutMs: number;
  envWhiteList?: string[];
  scrubSensitiveEnv?: boolean;
  isolatedTempDir?: boolean;
}
```

### M4: Bitemporal Ledger & Context (`lib/teamwork/ledger/`, `lib/teamwork/context/`)
```typescript
export interface BitemporalRecord<T = unknown> {
  id: string;
  entityId: string;
  validTime: { from: number; to?: number };
  transactionTime: { recordedAt: number; supersededAt?: number };
  action: 'INSERT' | 'UPDATE' | 'DELETE' | 'COMPENSATE';
  payload: T;
  merkleHash: string;
  prevHash: string;
}

export interface TemporalContextQuery {
  asOfValidTime?: number;
  asOfTransactionTime?: number;
  entityId?: string;
  tier: 1 | 2 | 3;
}
```

## Code Layout
```
lib/teamwork/
├── dag/
│   ├── types.ts
│   ├── graph.ts
│   ├── topological-sort.ts
│   ├── semaphore.ts
│   ├── backoff.ts
│   ├── engine.ts
│   └── index.ts
├── checkpoint/
│   ├── types.ts
│   ├── serializer.ts
│   ├── memory-store.ts
│   ├── file-store.ts
│   └── index.ts
├── hitl/
│   ├── types.ts
│   ├── token.ts
│   ├── approval-gate.ts
│   └── index.ts
├── visual/
│   ├── types.ts
│   ├── diff-viewer.ts
│   ├── flow-sketch.ts
│   ├── code-shape.ts
│   ├── show-me.ts
│   └── index.ts
├── contracts/
│   ├── types.ts
│   ├── tool-contract.ts
│   ├── provenance.ts
│   ├── dual-gate.ts
│   └── index.ts
├── sandbox/
│   ├── types.ts
│   ├── env-scrubber.ts
│   ├── cwd-lockdown.ts
│   ├── temp-isolation.ts
│   ├── process-manager.ts
│   └── index.ts
├── ledger/
│   ├── types.ts
│   ├── bitemporal.ts
│   ├── audit-ledger.ts
│   ├── replay.ts
│   └── index.ts
├── context/
│   ├── types.ts
│   ├── temporal-context.ts
│   ├── knowledge-ontology.ts
│   └── index.ts
├── engine.ts          # Updated with DAG & Checkpoint delegates
├── tools.ts           # Updated with Strict Tool Contracts & Sandbox delegates
├── cli.ts             # Updated CLI interface
├── index.ts           # Unified barrel export
└── types.ts           # Extended shared types
```
