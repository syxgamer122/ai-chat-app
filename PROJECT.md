# Project: Teamwork Multi-Agent Runtime Engine & Headless Harness Runner

## Architecture
Vyen Teamwork Multi-Agent Runtime Engine is a decoupled, headless orchestration layer implementing a strict 2-phase multi-agent workflow (Explorer → Worker → Critic) conforming to OpenCode/Pi/Hermes specifications. It runs seamlessly both in Headless CLI (Node.js) and Electron Desktop without React UI or IndexedDB dependencies.

```
                  +----------------------------------------------+
                  |               User / CLI / Desktop           |
                  +----------------------------------------------+
                                         |
                                         v
                  +----------------------------------------------+
                  |         lib/teamwork/engine.ts               |
                  |  Phase 1: Scope & Plan -> User Confirm Gate  |
                  |  Phase 2: Milestone Dispatcher & Lifecycle   |
                  +----------------------------------------------+
                                   |           |
            +----------------------+           +----------------------+
            |                                                         |
            v                                                         v
+-------------------------------+                         +-------------------------------+
|  lib/teamwork/file-lock.ts    |                         |  lib/teamwork/artifacts.ts    |
|  - Exclusive File Ownership   |                         |  - teamwork/REQUEST.md        |
|  - Concurrency Guard (max 2)  |                         |  - teamwork/PLAN.md           |
|  - Disjointness Validator     |                         |  - teamwork/PROGRESS.md       |
+-------------------------------+                         +-------------------------------+
            |                                                         |
            v                                                         v
+-------------------------------+                         +-------------------------------+
|  lib/teamwork/tools.ts        |                         |  lib/teamwork/critic.ts       |
|  - Headless fs, shell, git    |                         |  - Adversarial Verification   |
|  - Reuses path-guard.cjs      |                         |  - Real test/build runner     |
|  - Reuses staging.ts          |                         |  - PASS / FAIL-BLOCKED gate   |
|  - Reuses auto-pilot.ts       |                         |  - Integrity Mode (dev/demo)  |
|  - Reuses edit-blocks.ts      |                         +-------------------------------+
+-------------------------------+                                     |
            |                                                         v
            v                                             +-------------------------------+
+-------------------------------+                         |  lib/teamwork/rate-limit.ts   |
|  lib/teamwork/cli.ts          |                         |  - 429 auto-pause & logging   |
|  - Node.js standalone runner  |                         |  lib/teamwork/summary.ts      |
|  - Zero React/Dexie dependency|                         |  - Compact summary <= 20 lines|
+-------------------------------+                         +-------------------------------+
```

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Phase 1 Scope Clarification | 4-element check (Purpose, Scope, Testable Criteria, Working Dir) | M1, M4 | spec_miner_survey_1, ORIGINAL_REQUEST:14 |
| 2 | Triad Document Generation | Automatic creation of `teamwork/REQUEST.md`, `teamwork/PLAN.md`, `teamwork/PROGRESS.md` | M1 | spec_miner_survey_1, ORIGINAL_REQUEST:14 |
| 3 | Phase 1 Pause & User Confirmation | Pause gate presenting plan summary to user before modifying any source files | M4 | spec_miner_survey_1, ORIGINAL_REQUEST:14 |
| 4 | Milestone Roadmap Decomposition | Milestone decomposition (<= 3 milestones) with purpose, exclusive files, verify commands | M1, M4 | spec_miner_survey_1, teamwork-orchestrator.md |
| 5 | Exclusive File Ownership Lock | Strict mutual exclusive file locks per worker; reject concurrent edits to same file | M1 | spec_miner_survey_1, ORIGINAL_REQUEST:17 |
| 6 | Concurrency Guard (Max 2 Parallel)| Sequential by default; max 2 parallel only when file sets are 100% disjoint | M1 | spec_miner_survey_1, ORIGINAL_REQUEST:16 |
| 7 | Headless Tool Runner | Pure Node.js filesystem, shell, and git execution decoupled from React & IndexedDB | M2 | explorer_survey_2, ORIGINAL_REQUEST:21 |
| 8 | Path-Guard Integration | Workspace boundary enforcement wrapping all file tools via `electron/path-guard.cjs` | M2 | explorer_survey_2, ORIGINAL_REQUEST:23 |
| 9 | Staging Sandbox Integration | In-RAM diff review overlay reusing `lib/staging.ts` for safe preview | M2 | explorer_survey_2, ORIGINAL_REQUEST:23 |
| 10 | Auto-Pilot Policy Integration | Shell command whitelisting and destructive command blocking via `lib/auto-pilot.ts` | M2 | explorer_survey_2, ORIGINAL_REQUEST:23 |
| 11 | Diff Validation Integration | Precise SEARCH/REPLACE block parsing and application via `lib/edit-blocks.ts` | M2 | explorer_survey_2, ORIGINAL_REQUEST:23 |
| 12 | Adversarial Critic Verifier | Real command runner verifying tests without trusting worker; emits PASS/FAIL-BLOCKED | M3 | spec_miner_survey_1, ORIGINAL_REQUEST:18 |
| 13 | Integrity Mode Rubric | Multi-mode validation (`development`, `demo`, `benchmark`) blocking facades/dummies | M3 | spec_miner_survey_1, teamwork-critic.md |
| 14 | Bounded Milestone Retry | Single retry with Critic reproduction feedback; stop and block if retry fails | M3, M4 | spec_miner_survey_1, teamwork-orchestrator.md |
| 15 | 429 Rate Limit Auto-Pause | Intercept 429 errors, halt immediately, log to `teamwork/PROGRESS.md`, avoid spam | M3 | spec_miner_survey_1, ORIGINAL_REQUEST:28 |
| 16 | Completion & Blocking Summary | Compact markdown summary <= 20 lines with PROGRESS link, test results, file stats | M3 | spec_miner_survey_1, ORIGINAL_REQUEST:29 |
| 17 | 2-Phase Orchestrator Engine | Full lifecycle engine coordinating Phase 1, confirmation, and Phase 2 workers | M4 | spec_miner_survey_1, explorer_survey_2 |
| 18 | Standalone Headless CLI Runner | CLI entry point (`scripts/teamwork-cli.ts` / `lib/teamwork/cli.ts`) runnable via Node/TS | M4 | explorer_survey_2, ORIGINAL_REQUEST:22 |
| 19 | Electron Desktop Dual-Mode | Clean API/IPC integration point for Electron without React/DOM coupling | M4 | explorer_survey_2, ORIGINAL_REQUEST:24 |
| 20 | E2E Testing Suite (Tiers 1-4) | Comprehensive opaque-box test suite covering all features, boundaries, combinations | M_E2E | explorer_survey_3, ORIGINAL_REQUEST:33-42 |
| 21 | Final Verification & 100% Pass | 100% pass on all 83 existing test suites (1082 tests) + all new tests | M5 | explorer_survey_3, ORIGINAL_REQUEST:41 |
| 22 | Tier 5 Adversarial Hardening | White-box stress testing of race conditions, file locks, 429 recovery, integrity | M5 | Project Pattern, explorer_survey_3 |

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|--------------|--------|
| M_E2E | E2E Testing Suite Track | Opaque-box requirement-driven test suite (Tiers 1-4): `TEST_INFRA.md`, `TEST_READY.md`, `tests/teamwork-cli.test.ts`, `tests/teamwork-e2e.test.ts` | None | DONE |
| M1 | Data Models, File-Locking & Artifacts | `lib/teamwork/types.ts`, `lib/teamwork/file-lock.ts`, `lib/teamwork/artifacts.ts`, `tests/teamwork-file-lock.test.ts`, `tests/teamwork-artifacts.test.ts` | None | DONE |
| M2 | Headless Tool Runner & Safety Layers | `lib/teamwork/tools.ts`, `tests/teamwork-tools.test.ts` (reusing path-guard, staging, auto-pilot, edit-blocks) | M1 | DONE |
| M3 | Adversarial Critic, 429 Handler & Summary | `lib/teamwork/critic.ts`, `lib/teamwork/rate-limit.ts`, `lib/teamwork/summary.ts`, `tests/teamwork-critic.test.ts`, `tests/teamwork-rate-limit.test.ts`, `tests/teamwork-summary.test.ts` | M1, M2 | DONE |
| M4 | 2-Phase Engine, CLI Runner & Dual-Mode | `lib/teamwork/engine.ts`, `lib/teamwork/cli.ts`, `lib/teamwork/index.ts`, `bin/teamwork.ts`, `tests/teamwork-engine.test.ts` | M1, M2, M3 | DONE |
| M5 | Final E2E Pass & Adversarial Hardening | Phase 1: 100% pass of existing 83 test suites (1082 tests) + all new tests. Phase 2: Tier 5 adversarial stress testing | M_E2E, M4 | DONE |

## Code Layout & Write Ownership
All new implementation modules are placed under `lib/teamwork/`, `bin/`, and `tests/`:
- `lib/teamwork/types.ts` (M1)
- `lib/teamwork/file-lock.ts` (M1)
- `lib/teamwork/artifacts.ts` (M1)
- `lib/teamwork/tools.ts` (M2)
- `lib/teamwork/critic.ts` (M3)
- `lib/teamwork/rate-limit.ts` (M3)
- `lib/teamwork/summary.ts` (M3)
- `lib/teamwork/engine.ts` (M4)
- `lib/teamwork/cli.ts` (M4)
- `lib/teamwork/index.ts` (M4)
- `bin/teamwork.ts` (M4)
- `tests/teamwork-*.test.ts` (M1-M5, M_E2E)

### Existing Safety Layers Reused (Read-Only)
- `electron/path-guard.cjs`: `resolveWithin`, `isWithinRoot`
- `lib/staging.ts`: `stageFile`, `emptyStagingStore`, `stagedFileDiff`, `commitStagedFile`
- `lib/auto-pilot.ts`: `isSafeCommand`, `isAlwaysBlocked`, `shouldAutoApprove`
- `lib/edit-blocks.ts`: `parseEditBlocks`, `replaceMostSimilarChunk`
- `lib/naive-diff.ts`: `lineDiff`, `renderUnifiedDiff`
- `lib/upstream-status-rules.ts`: `restateUpstreamStatus`

## Interface Contracts

### 1. `lib/teamwork/file-lock.ts` ↔ `lib/teamwork/engine.ts`
```ts
export class FileLockManager {
  canAcquire(workerId: string, files: string[]): boolean;
  acquire(workerId: string, files: string[]): void;
  release(workerId: string): void;
  getActiveWorkers(): string[];
  getActiveLocks(): Map<string, string>;
  isLocked(filePath: string): boolean;
  getLockOwner(filePath: string): string | undefined;
}
```

### 2. `lib/teamwork/tools.ts` ↔ `lib/teamwork/critic.ts` & Workers
```ts
export interface HeadlessToolEnvironment {
  workspaceRoot: string;
  stagingEnabled?: boolean;
  approvalPolicy?: 'smart' | 'never' | 'always';
}

export class HeadlessToolRunner {
  constructor(env: HeadlessToolEnvironment);
  fsList(relPath?: string): Promise<Array<{ name: string; type: 'file' | 'dir'; size?: number }>>;
  fsRead(relPath: string, opts?: { startLine?: number; lineCount?: number }): Promise<{ content: string; truncated: boolean }>;
  fsSearch(query: string, isRegex?: boolean): Promise<Array<{ path: string; line: number; text: string }>>;
  fsEdit(relPath: string, blocksText: string, workerId?: string): Promise<{ applied: boolean; error?: string }>;
  fsWrite(relPath: string, content: string, workerId?: string): Promise<{ written: boolean; error?: string }>;
  shellRun(command: string, cwd?: string, timeoutMs?: number): Promise<{ code: number | null; stdout: string; stderr: string; truncated?: boolean }>;
  gitStatus(): Promise<{ branch: string | null; clean: boolean; status: string }>;
  gitDiff(relPath?: string, staged?: boolean): Promise<string>;
}
```

### 3. `lib/teamwork/critic.ts` ↔ `lib/teamwork/engine.ts`
```ts
export interface CriticResult {
  verdict: 'PASS' | 'FAIL-BLOCKED';
  command: string;
  exitCode: number | null;
  outputPreview: string;
  issues: Array<{ severity: 'blocker' | 'major' | 'minor'; fileLocation: string; description: string }>;
  passCriteriaMet: boolean;
}

export class TeamworkCritic {
  constructor(tools: HeadlessToolRunner);
  verifyMilestone(milestone: Milestone, integrityMode?: 'development' | 'demo' | 'benchmark'): Promise<CriticResult>;
}
```

### 4. `lib/teamwork/engine.ts` ↔ CLI Runner & Dual-Mode
```ts
export interface TeamworkEngineConfig {
  workspaceRoot: string;
  model?: LanguageModel;
  integrityMode?: 'development' | 'demo' | 'benchmark';
  concurrencyCap?: number; // default: 2
  confirmPrompt?: () => Promise<boolean>; // Callback for Phase 1 pause gate
  onEvent?: (event: TeamworkEvent) => void;
}

export interface TeamworkRunSummary {
  status: 'COMPLETED' | 'BLOCKED_429' | 'FAILED';
  milestones: Milestone[];
  summaryText: string; // <= 20 lines
  progressFilePath: string;
  changedFiles: string[];
}
```
