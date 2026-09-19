/**
 * Headless CLI Runner for Teamwork Multi-Agent Runtime Engine.
 * Conforms strictly to ORIGINAL_REQUEST.md R2 và PROJECT.md.
 *
 * Runs entirely in pure Node.js without React, DOM, or IndexedDB/Dexie dependencies.
 * Exit codes:
 * - 0: Complete pass, --help, --version, --dry-run, or --ledger-replay.
 * - 1: Unrecoverable failure, Critic rejection, rate-limit halt (429), syntax error, or rejected plan.
 */

import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { FileCheckpointStore } from './checkpoint';
import { TeamworkEngine } from './engine';
import { FileLockManager } from './file-lock';
import { HitlPolicy } from './hitl';
import { AppendOnlyLedger } from './ledger';
import { PointInTimeReplayEngine } from './ledger/replay';
import { IntegrityMode, TeamworkRunSummary } from './types';
import { GitWorktreeManager } from './worktree';

export interface CliParsedArgs {
  goal?: string;
  workspace: string;
  autoApprove: boolean;
  dryRun: boolean;
  worktrees: boolean;
  boost: boolean;
  repoGraph: boolean;
  integrityMode: IntegrityMode;
  concurrency: number;
  help: boolean;
  version: boolean;
  errors: string[];
  // Modular M1-M4 Flags
  dag: boolean;
  resume?: string;
  approval: HitlPolicy;
  ledgerReplay?: string;
}

/**
 * Parses CLI arguments conforming to project specifications.
 */
export function parseCliArgs(argv: string[], cwd: string = process.cwd()): CliParsedArgs {
  const result: CliParsedArgs = {
    workspace: path.resolve(cwd),
    autoApprove: false,
    dryRun: false,
    worktrees: false,
    boost: false,
    repoGraph: false,
    integrityMode: 'development',
    concurrency: 2,
    help: false,
    version: false,
    errors: [],
    dag: false,
    approval: 'smart',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      return result;
    }

    if (arg === '--version' || arg === '-v') {
      result.version = true;
      return result;
    }

    if (arg === '--goal' || arg === '-g') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        result.errors.push('Option --goal requires a non-empty string argument.');
      } else {
        result.goal = argv[++i];
      }
    } else if (arg.startsWith('--goal=')) {
      const val = arg.slice('--goal='.length).trim();
      if (!val) {
        result.errors.push('Option --goal requires a non-empty string argument.');
      } else {
        result.goal = val;
      }
    } else if (arg === '--workspace' || arg === '-w') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        result.errors.push('Option --workspace requires a valid directory path.');
      } else {
        result.workspace = path.resolve(argv[++i]);
      }
    } else if (arg.startsWith('--workspace=')) {
      const val = arg.slice('--workspace='.length).trim();
      if (!val) {
        result.errors.push('Option --workspace requires a valid directory path.');
      } else {
        result.workspace = path.resolve(val);
      }
    } else if (arg === '--auto-approve') {
      result.autoApprove = true;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--worktrees') {
      result.worktrees = true;
    } else if (arg === '--boost' || arg === '/boost') {
      result.boost = true;
    } else if (arg.startsWith('/boost ')) {
      result.boost = true;
      const val = arg.slice('/boost '.length).trim();
      if (val) {
        result.goal = val;
      }
    } else if (arg.startsWith('--boost=')) {
      result.boost = true;
      const val = arg.slice('--boost='.length).trim();
      if (val) {
        result.goal = val;
      }
    } else if (arg === '--repo-graph') {
      result.repoGraph = true;
    } else if (arg === '--dag') {
      result.dag = true;
    } else if (arg === '--resume') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        result.errors.push('Option --resume requires a checkpoint ID.');
      } else {
        result.resume = argv[++i];
      }
    } else if (arg.startsWith('--resume=')) {
      const val = arg.slice('--resume='.length).trim();
      if (!val) {
        result.errors.push('Option --resume requires a checkpoint ID.');
      } else {
        result.resume = val;
      }
    } else if (arg === '--approval') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        result.errors.push('Option --approval requires one of: smart, always, never.');
      } else {
        const mode = argv[++i];
        if (mode === 'smart' || mode === 'always' || mode === 'never') {
          result.approval = mode;
        } else {
          result.errors.push(`Invalid approval mode: "${mode}". Expected "smart", "always", or "never".`);
        }
      }
    } else if (arg.startsWith('--approval=')) {
      const mode = arg.slice('--approval='.length).trim();
      if (mode === 'smart' || mode === 'always' || mode === 'never') {
        result.approval = mode;
      } else {
        result.errors.push(`Invalid approval mode: "${mode}". Expected "smart", "always", or "never".`);
      }
    } else if (arg === '--ledger-replay') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        result.errors.push('Option --ledger-replay requires a milestone ID or entity name.');
      } else {
        result.ledgerReplay = argv[++i];
      }
    } else if (arg.startsWith('--ledger-replay=')) {
      const val = arg.slice('--ledger-replay='.length).trim();
      if (!val) {
        result.errors.push('Option --ledger-replay requires a milestone ID or entity name.');
      } else {
        result.ledgerReplay = val;
      }
    } else if (arg === '--integrity-mode') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        result.errors.push('Option --integrity-mode requires one of: development, demo, benchmark.');
      } else {
        const mode = argv[++i];
        if (mode === 'development' || mode === 'demo' || mode === 'benchmark') {
          result.integrityMode = mode;
        } else {
          result.errors.push(
            `Invalid integrity-mode: "${mode}". Expected "development", "demo", or "benchmark".`
          );
        }
      }
    } else if (arg.startsWith('--integrity-mode=')) {
      const mode = arg.slice('--integrity-mode='.length).trim();
      if (mode === 'development' || mode === 'demo' || mode === 'benchmark') {
        result.integrityMode = mode;
      } else {
        result.errors.push(
          `Invalid integrity-mode: "${mode}". Expected "development", "demo", or "benchmark".`
        );
      }
    } else if (arg === '--concurrency' || arg === '-c') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        result.errors.push('Option --concurrency requires a positive integer (1 or 2).');
      } else {
        const num = parseInt(argv[++i], 10);
        if (isNaN(num) || num <= 0) {
          result.errors.push('Option --concurrency must be a positive integer.');
        } else if (num > 2) {
          result.errors.push('Option --concurrency exceeds maximum allowed ceiling of 2.');
        } else {
          result.concurrency = num;
        }
      }
    } else if (arg.startsWith('--concurrency=')) {
      const num = parseInt(arg.slice('--concurrency='.length), 10);
      if (isNaN(num) || num <= 0) {
        result.errors.push('Option --concurrency must be a positive integer.');
      } else if (num > 2) {
        result.errors.push('Option --concurrency exceeds maximum allowed ceiling of 2.');
      } else {
        result.concurrency = num;
      }
    } else if (arg.startsWith('-')) {
      result.errors.push(`Unknown option: "${arg}".`);
    } else if (!result.goal) {
      if (arg.startsWith('/boost ')) {
        result.boost = true;
        result.goal = arg.slice('/boost '.length).trim();
      } else if (arg === '/boost') {
        result.boost = true;
      } else {
        result.goal = arg;
      }
    }
  }

  if (result.goal?.startsWith('/boost ')) {
    result.boost = true;
    result.goal = result.goal.slice('/boost '.length).trim();
  } else if (result.goal === '/boost') {
    result.boost = true;
    result.goal = undefined;
  }

  if (!result.help && !result.version && !result.ledgerReplay && (!result.goal || !result.goal.trim())) {
    result.errors.push('Missing required goal. Provide --goal <description> or pass as argument.');
  }

  return result;
}

export interface CliRunOptions {
  userConfirm?: boolean;
  workspaceRoot?: string;
  engine?: TeamworkEngine;
  engineFactory?: (workspaceRoot: string) => TeamworkEngine;
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  summary?: TeamworkRunSummary;
}

/**
 * Prompts user for approval via readline in interactive terminal.
 */
async function promptConfirmation(promptText: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return true;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${promptText} [y/N]: `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

/**
 * Runs the headless CLI execution cycle.
 */
export async function runCli(argv: string[], options?: CliRunOptions): Promise<CliRunResult> {
  const parsed = parseCliArgs(argv, options?.workspaceRoot);
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  if (parsed.help) {
    stdoutLines.push('Usage: teamwork-cli --goal <goal> [options]');
    stdoutLines.push('');
    stdoutLines.push('Options:');
    stdoutLines.push('  --goal, -g            Task objective description');
    stdoutLines.push('  --workspace, -w       Workspace root directory path (default: current directory)');
    stdoutLines.push('  --auto-approve        Auto-approve Phase 1 plan and safe tool executions');
    stdoutLines.push('  --dry-run             Generate Phase 1 plan only, skip Phase 2 code modification');
    stdoutLines.push('  --integrity-mode      development | demo | benchmark (default: development)');
    stdoutLines.push('  --concurrency, -c     Max concurrent workers (1-2, default: 2)');
    stdoutLines.push('  --dag                 Enable durable DAG task dependency execution mode');
    stdoutLines.push('  --resume <id>         Resume workflow from specified checkpoint ID');
    stdoutLines.push('  --approval <mode>     HITL approval gate policy: smart | always | never (default: smart)');
    stdoutLines.push('  --ledger-replay <id>  Inspect and replay bitemporal ledger history for milestone/entity');
    stdoutLines.push('  --worktrees           Execute workers in isolated Git worktrees');
    stdoutLines.push('  --boost, /boost       Execute task in isolated Git Worktree with diff review & merge gate');
    stdoutLines.push('  --repo-graph          Analyze workspace dependency graph for targeted verification');
    stdoutLines.push('  --help, -h            Show help');
    stdoutLines.push('  --version, -v         Show version');
    return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: '' };
  }

  if (parsed.version) {
    stdoutLines.push('teamwork-cli v1.0.0 (Vyen compliant)');
    return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: '' };
  }

  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      stderrLines.push(`Error: ${err}`);
    }
    return { exitCode: 1, stdout: '', stderr: stderrLines.join('\n') };
  }

  const workspaceRoot = parsed.workspace;

  // Handle Ledger Replay inspection command
  if (parsed.ledgerReplay) {
    try {
      const ledger = new AppendOnlyLedger(workspaceRoot);
      await ledger.initialize();
      const targetEntity = parsed.ledgerReplay.startsWith('milestone:')
        ? parsed.ledgerReplay
        : `milestone:${parsed.ledgerReplay}`;

      let records = ledger.query({ entityId: targetEntity });
      if (records.length === 0) {
        records = ledger.query({ entityId: parsed.ledgerReplay });
      }
      if (records.length === 0 && (parsed.ledgerReplay === 'all' || parsed.ledgerReplay === '*')) {
        records = [...ledger.getAllRecords()];
      }

      stdoutLines.push(`[Ledger Replay] Historical records for: "${parsed.ledgerReplay}"`);
      if (records.length === 0) {
        stdoutLines.push(`No ledger records found matching "${parsed.ledgerReplay}". Total records in ledger: ${ledger.getAllRecords().length}`);
      } else {
        for (const rec of records) {
          const timeMs = rec.validTime?.from ?? rec.validFrom ?? Date.now();
          const timeStr = new Date(timeMs).toISOString();
          stdoutLines.push(`- [${timeStr}] Action: ${rec.action} | Entity: ${rec.entityId} | Hash: ${rec.recordHash?.slice(0, 8) ?? 'none'}`);
          if (rec.payload) {
            stdoutLines.push(`  Payload: ${JSON.stringify(rec.payload)}`);
          }
        }
      }
      return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: '' };
    } catch (ledgerErr) {
      stderrLines.push(`Error during ledger replay: ${String(ledgerErr)}`);
      return { exitCode: 1, stdout: '', stderr: stderrLines.join('\n') };
    }
  }

  let boostManager: GitWorktreeManager | undefined;
  let boostWorkerId: string | undefined;
  let effectiveWorkspace = workspaceRoot;

  if (parsed.boost) {
    boostManager = new GitWorktreeManager({
      workspaceRoot,
      baseWorktreeDir: path.join(os.tmpdir(), 'teamwork-boost-worktrees'),
      branchPrefix: 'teamwork/boost',
    });

    if (!boostManager.isGitRepo()) {
      stderrLines.push('Error: Cannot run --boost outside of a git repository.');
      return { exitCode: 1, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
    }

    try {
      boostWorkerId = `boost-${Date.now()}`;
      const boostContext = await boostManager.createWorktree(boostWorkerId);
      effectiveWorkspace = boostContext.worktreePath;
      stdoutLines.push(`[Boost Mode] Running in isolated Git Worktree at: "${effectiveWorkspace}"`);
    } catch (wtErr) {
      stderrLines.push(`Error creating boost worktree: ${String(wtErr)}`);
      return { exitCode: 1, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
    }
  }

  const lockManager = new FileLockManager({
    concurrencyCap: parsed.concurrency,
    workspaceRoot: effectiveWorkspace,
  });

  // Durable checkpoint store. Without this the engine could never persist a checkpoint,
  // which made `--resume <id>` a silent no-op.
  const checkpointStore = new FileCheckpointStore({
    workspaceRoot: effectiveWorkspace,
    directory: '.teamwork/checkpoints',
  });

  const confirmPrompt = async () => {
    if (parsed.autoApprove) return true;
    if (options?.userConfirm !== undefined) return options.userConfirm;
    return promptConfirmation('[Phase 1 Pause Gate] Approve proposed plan to proceed to Phase 2?');
  };

  let engine: TeamworkEngine;
  if (options?.engineFactory) {
    engine = options.engineFactory(effectiveWorkspace);
  } else if (options?.engine) {
    engine = options.engine;
    if (parsed.boost && (engine as any).workspaceRoot !== effectiveWorkspace) {
      (engine as any).workspaceRoot = effectiveWorkspace;
    }
  } else {
    engine = new TeamworkEngine({
      workspaceRoot: effectiveWorkspace,
      integrityMode: parsed.integrityMode,
      concurrencyCap: parsed.concurrency,
      useWorktrees: parsed.worktrees,
      enableRepoGraph: parsed.repoGraph,
      enableDag: parsed.dag,
      checkpointStore,
      approvalPolicy: parsed.approval,
      lockManager,
      confirmPrompt,
      onEvent: (event) => {
        if (event.type === 'plan_created') {
          stdoutLines.push('[Phase 1] Generated teamwork/REQUEST.md, teamwork/PLAN.md, teamwork/PROGRESS.md');
        } else if (event.type === 'plan_confirmed') {
          stdoutLines.push('[Phase 2] User confirmed plan. Dispatching workers...');
        } else if (event.type === 'critic_verdict') {
          const verdict = event.payload?.verdict || event.message;
          if (verdict === 'PASS') {
            stdoutLines.push('[Phase 2] Critic verified test execution: PASS.');
          } else {
            stderrLines.push(`[Phase 2] Critic verification failed: ${verdict}.`);
          }
        } else if (event.type === 'milestone_completed') {
          stdoutLines.push('[Phase 2] Milestone completed successfully.');
        } else if (event.type === 'milestone_retry') {
          stdoutLines.push(`[Phase 2] Retrying milestone ${event.milestoneId}: ${event.message || ''}`);
        } else if (event.type === 'hitl_interrupt') {
          stdoutLines.push(`[HITL Gate] Approval required for ${event.milestoneId || 'action'}.`);
        } else if (event.type === 'rate_limit_paused') {
          stderrLines.push('[Phase 2] Rate limit encountered: HTTP 429 Too Many Requests.');
          stderrLines.push('[Phase 2] Halting execution and logging status to teamwork/PROGRESS.md.');
        }
      },
    });
  }

  stdoutLines.push(`[Phase 1] Analyzing goal: "${parsed.goal}"`);

  // Deterministic checkpoint run id derived from the goal (matches TeamworkEngine's save key).
  const checkpointRunId = `run-${(parsed.goal || '').trim().replace(/\s+/g, '-').toLowerCase()}`;

  try {
    const summary = await engine.run(parsed.goal!, {
      dryRun: parsed.dryRun,
      userConfirm: options?.userConfirm,
      dag: parsed.dag,
      resumeCheckpointId: parsed.resume,
      approvalPolicy: parsed.approval,
    });

    if (parsed.dryRun) {
      if (parsed.boost && boostManager && boostWorkerId) {
        await boostManager.removeWorktree(boostWorkerId, { force: true, deleteBranch: true });
      }
      stdoutLines.push('[Dry Run] Planning phase complete. Exiting without modifying source files.');
      return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: '', summary };
    }

    if (summary.status === 'BLOCKED_429') {
      if (parsed.boost && boostManager && boostWorkerId) {
        await boostManager.removeWorktree(boostWorkerId, { force: true, deleteBranch: true });
      }
      return { exitCode: 1, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') || summary.summaryText, summary };
    }

    if (summary.status === 'FAILED') {
      if (parsed.boost && boostManager && boostWorkerId) {
        await boostManager.removeWorktree(boostWorkerId, { force: true, deleteBranch: true });
      }
      if (summary.summaryText.includes('rejected')) {
        stderrLines.push('[Phase 1] User rejected the proposed plan. Aborting execution.');
      } else if (!stderrLines.some((l) => l.includes('Critic verification failed'))) {
        stderrLines.push(`[Phase 2] Execution failed: ${summary.summaryText}`);
      }
      stderrLines.push(`[Checkpoint] Resume with: --resume "${checkpointRunId}"`);
      return { exitCode: 1, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n'), summary };
    }

    // Boost completion: Show diff stat and prompt for merge confirmation
    if (parsed.boost && boostManager && boostWorkerId) {
      const statRes = boostManager.getDiffStat(boostWorkerId, `teamwork(boost): ${parsed.goal}`);
      stdoutLines.push('[Boost Diff Stat]');
      if (statRes.success && statRes.stat) {
        stdoutLines.push(statRes.stat);
      } else {
        stdoutLines.push('No file modifications detected.');
      }

      let shouldMerge = false;
      if (parsed.autoApprove) {
        shouldMerge = true;
      } else if (options?.userConfirm !== undefined) {
        shouldMerge = options.userConfirm;
      } else {
        shouldMerge = await promptConfirmation('[Boost Merge Gate] Apply and merge boost changes into main workspace?');
      }

      if (shouldMerge) {
        const mergeRes = await boostManager.mergeWorktree(boostWorkerId, {
          commitMessage: `teamwork(boost): ${parsed.goal}`,
          autoCommit: true,
        });
        if (mergeRes.success) {
          stdoutLines.push(`[Boost Merge Gate] Successfully merged boost changes (commit ${mergeRes.mergedCommit || 'HEAD'}).`);
        } else {
          stderrLines.push(`[Boost Merge Gate] Merge failed: ${mergeRes.error}`);
          await boostManager.removeWorktree(boostWorkerId, { force: true, deleteBranch: true });
          return { exitCode: 1, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n'), summary };
        }
      } else {
        stdoutLines.push('[Boost Merge Gate] Boost changes rejected. Discarding worktree without merging.');
      }

      await boostManager.removeWorktree(boostWorkerId, { force: true, deleteBranch: true });
    }

    stdoutLines.push(summary.summaryText);
    stdoutLines.push(`[Checkpoint] Saved run ID: "${checkpointRunId}" (resume with --resume "${checkpointRunId}")`);
    return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: '', summary };
  } catch (err: unknown) {
    if (parsed.boost && boostManager && boostWorkerId) {
      try {
        await boostManager.removeWorktree(boostWorkerId, { force: true, deleteBranch: true });
      } catch {
        // Best-effort cleanup
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    stderrLines.push(`Error: ${errMsg}`);
    return { exitCode: 1, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
  }
}

/**
 * CLI binary entrypoint function.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const result = await runCli(argv);
  if (result.stdout) {
    console.log(result.stdout);
  }
  if (result.stderr) {
    console.error(result.stderr);
  }
  process.exitCode = result.exitCode;
}
