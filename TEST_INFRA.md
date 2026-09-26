# E2E Test Infra: Vyen Multi-Agent Architecture & Capability Enhancement

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation design.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial Testing + Real-World Workload Testing.
- Target: 100% pass across all existing test files (168 file — 2,526 tests PASS sau đợt S3/S3b; mốc lúc viết đặc tả là 128 file/1850+ test) plus all new test suites covering R1, R2, R3, R4, and R5.

## Feature Inventory Mapping
| # | Feature | Source | Tier 1 (Coverage) | Tier 2 (BVA) | Tier 3 (Cross) | Tier 4 (Scenario) |
|---|---------|--------|:-----------------:|:------------:|:--------------:|:-----------------:|
| 1 | DAG Topological Sort | DAG & song song hoá | 5 | 5 | ✓ | ✓ |
| 2 | Concurrency Limiter & Semaphore | DAG & song song hoá | 5 | 5 | ✓ | ✓ |
| 3 | Exponential Jitter Backoff | DAG & song song hoá | 5 | 5 | ✓ | ✓ |
| 4 | State Checkpointing | DAG & song song hoá | 5 | 5 | ✓ | ✓ |
| 5 | Pause & Resume Lifecycle | DAG & song song hoá | 5 | 5 | ✓ | ✓ |
| 6 | Task Idempotency Tokens | DAG & song song hoá | 5 | 5 | ✓ | ✓ |
| 7 | HITL Approval Gates | Human-in-the-loop | 5 | 5 | ✓ | ✓ |
| 8 | Interrupt Tokens | Human-in-the-loop | 5 | 5 | ✓ | ✓ |
| 9 | Visual Diff Inspection | Human-in-the-loop | 5 | 5 | ✓ | ✓ |
| 10 | ASCII / Unicode Flow Sketches | Human-in-the-loop | 5 | 5 | ✓ | ✓ |
| 11 | Code-Shape AST Outlining | Human-in-the-loop | 5 | 5 | ✓ | ✓ |
| 12 | Cybernetic Control Loop | Human-in-the-loop | 5 | 5 | ✓ | ✓ |
| 13 | Typed Zod Tool Contracts | Hợp đồng công cụ | 5 | 5 | ✓ | ✓ |
| 14 | Provenance-Gated Writes | Hợp đồng công cụ | 5 | 5 | ✓ | ✓ |
| 15 | Dual-Gate Guardrails | Hợp đồng công cụ | 5 | 5 | ✓ | ✓ |
| 16 | Environment Variable Scrubbing | Sandbox | 5 | 5 | ✓ | ✓ |
| 17 | CWD Lockdown & Temp Isolation | Sandbox | 5 | 5 | ✓ | ✓ |
| 18 | Process Tree Teardown & Deadlines | Sandbox | 5 | 5 | ✓ | ✓ |
| 19 | Bitemporal Context Ledger | Ledger bitemporal | 5 | 5 | ✓ | ✓ |
| 20 | Historical State Replay | Ledger bitemporal | 5 | 5 | ✓ | ✓ |
| 21 | Non-Destructive Compensating Rollback | Ledger bitemporal | 5 | 5 | ✓ | ✓ |
| 22 | 3-Tier Progressive Context Query | Ledger & ngữ cảnh | 5 | 5 | ✓ | ✓ |
| 23 | Semantic Knowledge Ontology | Ledger bitemporal | 5 | 5 | ✓ | ✓ |
| 24 | TeamworkEngine DAG Integration | Core Vyen Integration | 5 | 5 | ✓ | ✓ |
| 25 | ToolRunner Contract & Sandbox Integration | Core Vyen Integration | 5 | 5 | ✓ | ✓ |
| 26 | CLI & Headless Runner Upgrades | Core Vyen Integration | 5 | 5 | ✓ | ✓ |
| 27 | Full Compatibility & Zero Regression | Core Vyen Integration | 5 | 5 | ✓ | ✓ |

## Test Architecture
- Test runner: Vitest (`npx vitest run`) with pure Node.js environment
- Test suites:
  - `tests/teamwork-dag.test.ts`: Covers DAG sorting, cycles, parallel branches, concurrency semaphores, backoff jitter formulas.
  - `tests/teamwork-checkpoint.test.ts`: Covers memory & file stores, atomic persistence, pause & resume, idempotency.
  - `tests/teamwork-hitl.test.ts`: Covers approval gate interrupts, token verification, decision states (`APPROVED`, `REJECTED`, `MODIFIED`).
  - `tests/teamwork-visual.test.ts`: Covers diff rendering, flow sketches, code-shape AST outline, show-me format.
  - `tests/teamwork-contracts-sandbox.test.ts`: Covers Zod contracts, provenance chains, pre/post flight gates, env scrubber, cwd lockdown, process tree timeout.
  - `tests/teamwork-ledger-context.test.ts`: Covers bitemporal ledger ($T_v$ vs $T_t$), append-only JSONL, replay, progressive context tiers, ontology triples.
  - `tests/teamwork-engine-integrated.test.ts`: Covers full end-to-end multi-agent workflow exercising DAG, checkpoints, approval gate, contracts, and ledger in headless CLI mode.
  - Existing test files in `tests/` (168 file — 2,526 tests PASS sau đợt S3/S3b): Regression baseline (must remain 100% PASS).

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Multi-Agent Refactor with DAG & Checkpoints | F1, F2, F3, F4, F5, F6, F24 | High |
| 2 | Sensitive System Command with HITL Approval | F7, F8, F9, F10, F11, F12 | High |
| 3 | Sandboxed Tool Execution with Strict Contracts & Scrubbing | F13, F14, F15, F16, F17, F18, F25 | High |
| 4 | Multi-Milestone Bitemporal Ledger & Context Time Travel | F19, F20, F21, F22, F23 | High |
| 5 | Full Headless CLI Execution Dual-Mode with Zero Regression | F24, F25, F26, F27 + all 128 baseline suites | Ultra-High |

## Coverage Thresholds
- Tier 1: ≥5 per feature
- Tier 2: ≥5 per feature (boundary conditions, cycles, timeouts, error cascades)
- Tier 3: Pairwise coverage of major feature interactions
- Tier 4: ≥5 realistic end-to-end application scenarios
- Regression: 100% pass across all existing test files (165 tại 2026-09-24)
