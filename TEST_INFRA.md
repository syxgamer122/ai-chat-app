# E2E Test Infra: Teamwork Multi-Agent Runtime Engine

## Test Philosophy
- Opaque-box, requirement-driven, derived directly from `ORIGINAL_REQUEST.md` and `.opencode/` specifications.
- Complete feature coverage: tests every feature in `PROJECT.md § Feature Inventory`.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial Testing + Real-World Workload Testing.
- Zero browser DOM or IndexedDB dependencies — runs under Node.js test environment with Vitest.

## Feature Inventory & Test Mapping
| # | Feature | Source (requirement) | Tier 1 (Feature) | Tier 2 (Boundary) | Tier 3 (Pairwise) | Tier 4 (Scenario) |
|---|---------|---------------------|:----------------:|:-----------------:|:-----------------:|:-----------------:|
| 1 | Phase 1 Scope Clarification & 4-element check | ORIGINAL_REQUEST §R1 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 2 | Triad Generation (REQUEST, PLAN, PROGRESS) | ORIGINAL_REQUEST §R1 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 3 | Phase 1 Pause Gate & Confirmation | ORIGINAL_REQUEST §R1 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 4 | Milestone Roadmap Decomposition (<= 3) | ORIGINAL_REQUEST §R1 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 5 | Exclusive File Ownership Locking | ORIGINAL_REQUEST §R1 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 6 | Concurrency Ceiling (Max 2 Parallel) | ORIGINAL_REQUEST §R1 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 7 | Headless Tool Runner (fs, shell, git) | ORIGINAL_REQUEST §R2 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 8 | Path-Guard File Traversal Protection | ORIGINAL_REQUEST §R2 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 9 | Staging Sandbox In-RAM Overlay | ORIGINAL_REQUEST §R2 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 10 | Auto-Pilot Command Policy | ORIGINAL_REQUEST §R2 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 11 | Diff Validation & Search/Replace | ORIGINAL_REQUEST §R2 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 12 | Adversarial Critic Test Execution | ORIGINAL_REQUEST §R1 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 13 | Integrity Mode Enforcement (dev/demo) | ORIGINAL_REQUEST §R1 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 14 | Bounded Retry Policy (<= 1 retry) | ORIGINAL_REQUEST §R1 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 15 | 429 Rate Limit Auto-Pause & Logging | ORIGINAL_REQUEST §R3 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 16 | Completion/Blocking Summary (<= 20 lines) | ORIGINAL_REQUEST §R3 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 17 | 2-Phase Orchestrator Engine Lifecycle | ORIGINAL_REQUEST §R1 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 18 | Standalone Headless CLI Runner | ORIGINAL_REQUEST §R2 | >= 5 tests | >= 5 tests | ✓ | ✓ |
| 19 | Electron Desktop Dual-Mode Integration | ORIGINAL_REQUEST §R2 | >= 5 tests | >= 5 tests | ✓ | ✓ |

## Test Architecture
- Test Runner: `npx vitest run tests/teamwork-cli.test.ts tests/teamwork-e2e.test.ts`
- Pass/Fail Semantics: 100% passing tests, exit code 0.
- Test Files:
  - `tests/teamwork-cli.test.ts`: Headless CLI runner, argument parsing, safety layers in headless mode.
  - `tests/teamwork-e2e.test.ts`: Complete 2-phase lifecycle integration, scripted agents, pause gate, concurrency guard, Critic gate, 429 rate limit interrupt.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Full Happy-Path Feature Development | Phase 1 plan generation -> User approval -> Sequential Worker 1 & Worker 2 -> Critic PASS -> Summary <= 20 lines | High |
| 2 | Disjoint File Parallelism Execution | 2 milestones with disjoint file ownership dispatched concurrently (concurrency = 2) | High |
| 3 | Overlapping File Serialization | 2 milestones touching shared files automatically serialized by Concurrency Guard | High |
| 4 | Adversarial Critic Rejection & Auto-Recovery | Worker introduces failing code -> Critic runs real tests -> emits FAIL-BLOCKED -> Worker retries with feedback -> Critic PASS | High |
| 5 | Mid-Execution 429 Rate Limit Abort & Resume | Worker encounters 429 -> Engine halts immediately -> Writes status to `teamwork/PROGRESS.md` -> Exits cleanly without retry loop | High |
