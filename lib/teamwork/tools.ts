/**
 * Headless Tool Runner & Safety Integration for Teamwork Multi-Agent Runtime Engine.
 * Conforms strictly to ORIGINAL_REQUEST.md R2 & R3 và PROJECT.md.
 *
 * Runs in pure Node.js without React, DOM, or Dexie IndexedDB dependencies.
 * Integrates:
 * 1. lib/path-guard.cjs: workspace boundary enforcement and path traversal blocking.
 * 2. lib/staging.ts: in-memory cumulative diff review overlay.
 * 3. lib/auto-pilot.ts: command whitelisting and destructive command blocking.
 * 4. lib/edit-blocks.ts: SEARCH/REPLACE block parsing and robust chunk application.
 * 5. lib/teamwork/file-lock.ts: exclusive file ownership check on write/edit operations.
 * 6. lib/teamwork/contracts/: Zod typed tool contracts, cryptographic provenance tracking, and dual-gate guardrails.
 * 7. lib/teamwork/sandbox/: Process sandboxing, environment variable scrubbing, CWD lockdown, and process tree teardown.
 */

import child_process from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { z } from 'zod';
import { getZeroMemStore, ZeroMemStore } from '@/lib/zeromem';
import {
  CodeSkeletonizer,
  SarsedPatcher,
  SarsedVerifier,
  SarsedSymbolIndex,
  type PatchResult,
  type VerificationResult,
  type FileSkeleton,
} from '@/lib/sarsed';

import {
  ApprovalPolicy,
  isAlwaysBlocked,
  isSafeCommand,
} from '@/lib/auto-pilot';
import {
  parseEditBlocks,
  replaceMostSimilarChunk,
} from '@/lib/edit-blocks';
import { renderUnifiedDiff } from '@/lib/naive-diff';
import {
  clearStaging,
  emptyStagingStore,
  normalizeStagingPath,
  stagedFileDiff,
  stageFile,
  stagingCount,
  type StagedFile,
  type StagingStore,
  unstageFile,
} from '@/lib/staging';
import { DualGateController } from './contracts/dual-gate';
import { ProvenanceTracker } from './contracts/provenance';
import { defineToolContract } from './contracts/tool-contract';
import { ToolExecutionContext } from './contracts/types';
import { FileLockManager } from './file-lock';
import { PermissionBroker, ProcessTreeSupervisor } from './permission-broker';
import { CwdGuard } from './sandbox/cwd-lockdown';
import { EnvScrubber } from './sandbox/env-scrubber';
import { SandboxedProcessManager } from './sandbox/process-manager';
import { TempIsolationManager } from './sandbox/temp-isolation';

// Load CJS path-guard module safely
const requireCjs = createRequire(import.meta.url);
const pathGuard = requireCjs('../path-guard.cjs') as {
  resolveWithin: (root: string, relPath: string) => string;
  isWithinRoot: (rootAbs: string, targetAbs: string) => boolean;
};

export const { resolveWithin, isWithinRoot } = pathGuard;

/**
 * Ignored directories during recursive workspace searches.
 */
const IGNORED_SEARCH_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.cache',
  'coverage',
  '.agents',
  '.system_generated',
]);

/**
 * Binary file extensions to skip during text search.
 */
const BINARY_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|tar|gz|7z|exe|dll|dylib|so|bin|lock|woff2?|ttf|eot)$/i;

export interface HeadlessToolEnvironment {
  /** Absolute path to the workspace root directory */
  workspaceRoot: string;
  /** Whether in-memory staging overlay is enabled */
  stagingEnabled?: boolean;
  /** Approval policy for command execution ('smart' | 'never' | 'always') */
  approvalPolicy?: ApprovalPolicy;
  /** Optional Exclusive File Ownership Lock Manager */
  fileLock?: FileLockManager;
  /** Optional capability-based Permission Broker */
  permissionBroker?: PermissionBroker;
  /** Optional active worker ID for scoping */
  activeWorkerId?: string;
  /** Optional approval callback for commands requiring manual consent */
  onApprovalRequest?: (command: string) => Promise<boolean>;
  /** Optional cryptographic Provenance Tracker */
  provenanceTracker?: ProvenanceTracker;
  /** Optional Dual-Gate Controller */
  dualGate?: DualGateController;
  /** Whether to enforce Dual-Gate pre-flight and post-flight guardrails */
  enableDualGate?: boolean;
  /** Whether to execute shell commands inside isolated sandbox */
  enableSandbox?: boolean;
  /** Optional environment variable scrubber */
  envScrubber?: EnvScrubber;
  /** Optional CWD lockdown guard */
  cwdGuard?: CwdGuard;
  /** Optional temporary isolation manager */
  tempManager?: TempIsolationManager;
  /** Optional active milestone ID for provenance context */
  milestoneId?: string;
}

export interface FsEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
}

export interface FsReadResult {
  content: string;
  truncated: boolean;
  totalLines?: number;
  size?: number;
  staged?: boolean;
}

export interface FsSearchResult {
  path: string;
  line: number;
  text: string;
}

export interface FsEditResult {
  applied: boolean;
  error?: string;
  staged?: boolean;
  blocksApplied?: number;
}

export interface FsWriteResult {
  written: boolean;
  error?: string;
  staged?: boolean;
  size?: number;
}

export interface ShellRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  durationMs?: number;
}

export interface GitStatusResult {
  branch: string | null;
  clean: boolean;
  status: string;
}

export interface BackgroundProcessRecord {
  processId: string;
  command: string;
  pid?: number;
  child?: child_process.ChildProcess;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  exitCode: number | null;
  startTime: number;
  endTime?: number;
  stdout: string;
  stderr: string;
  cwd: string;
  error?: string;
}

export interface ProcessStartOptions {
  cwd?: string;
  env?: Record<string, string>;
  id?: string;
  timeoutMs?: number;
}

export interface ProcessStatusResult {
  processId: string;
  pid?: number;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
  exitCode: number | null;
  uptimeMs: number;
  command?: string;
  error?: string;
}

export interface ProcessOutputResult {
  processId: string;
  stdout: string;
  stderr: string;
  status: string;
  exitCode: number | null;
}

export interface ProcessStopResult {
  processId: string;
  stopped: boolean;
  error?: string;
}

/**
 * Commits a single staged file to disk within workspaceRoot.
 */
export async function commitStagedFile(
  workspaceRoot: string,
  staged: StagedFile,
): Promise<void> {
  const absPath = resolveWithin(workspaceRoot, staged.path);
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, staged.content, 'utf8');
}

/**
 * Global background process registry for headless execution sessions.
 */
export const defaultProcessRegistry = new Map<string, BackgroundProcessRecord>();

/**
 * Headless Tool Runner executing filesystem, shell, and git operations
 * in a pure Node.js environment without UI or browser dependencies.
 */
export class HeadlessToolRunner {
  public readonly workspaceRoot: string;
  public stagingStore: StagingStore;
  public stagingEnabled: boolean;
  public approvalPolicy: ApprovalPolicy;
  public fileLock?: FileLockManager;
  public permissionBroker?: PermissionBroker;
  public activeWorkerId?: string;
  public milestoneId?: string;
  public provenanceTracker: ProvenanceTracker;
  public dualGate: DualGateController;
  public enableDualGate: boolean;
  public enableSandbox: boolean;
  public envScrubber?: EnvScrubber;
  public cwdGuard?: CwdGuard;
  public readonly backgroundProcesses: Map<string, BackgroundProcessRecord>;
  private readonly onApprovalRequest?: (command: string) => Promise<boolean>;

  constructor(env: HeadlessToolEnvironment) {
    if (!env || !env.workspaceRoot) {
      throw new Error('HeadlessToolRunner requires a valid workspaceRoot.');
    }
    this.workspaceRoot = path.resolve(env.workspaceRoot);
    this.stagingEnabled = env.stagingEnabled ?? false;
    this.approvalPolicy = env.approvalPolicy ?? 'smart';
    this.fileLock = env.fileLock;
    this.permissionBroker = env.permissionBroker;
    this.activeWorkerId = env.activeWorkerId;
    this.milestoneId = env.milestoneId;
    this.onApprovalRequest = env.onApprovalRequest;
    this.stagingStore = emptyStagingStore();
    this.backgroundProcesses = new Map<string, BackgroundProcessRecord>();

    this.provenanceTracker = env.provenanceTracker || new ProvenanceTracker();
    this.dualGate = env.dualGate || new DualGateController();
    this.enableDualGate = env.enableDualGate ?? false;
    this.enableSandbox = env.enableSandbox ?? false;
    this.envScrubber = env.envScrubber;
    this.cwdGuard = env.cwdGuard;
  }

  /**
   * Creates a sub-runner scoped to a specific worker and optional isolated directory (e.g. worktree).
   */
  public createScopedRunner(
    workerId: string,
    scopedRoot?: string,
    milestoneId?: string
  ): HeadlessToolRunner {
    return new HeadlessToolRunner({
      workspaceRoot: scopedRoot || this.workspaceRoot,
      stagingEnabled: this.stagingEnabled,
      approvalPolicy: this.approvalPolicy,
      fileLock: this.fileLock,
      permissionBroker: this.permissionBroker,
      activeWorkerId: workerId,
      milestoneId: milestoneId || this.milestoneId,
      onApprovalRequest: this.onApprovalRequest,
      provenanceTracker: this.provenanceTracker,
      dualGate: this.dualGate,
      enableDualGate: this.enableDualGate,
      enableSandbox: this.enableSandbox,
      envScrubber: this.envScrubber,
      cwdGuard: this.cwdGuard,
    });
  }

  public getProvenanceTracker(): ProvenanceTracker {
    return this.provenanceTracker;
  }

  public getDualGate(): DualGateController {
    return this.dualGate;
  }

  public setMilestoneId(milestoneId: string): void {
    this.milestoneId = milestoneId;
  }

  /* ------------------------------------------------------------------ */
  /* Staging Management Methods                                          */
  /* ------------------------------------------------------------------ */

  public getStagingStore(): StagingStore {
    return this.stagingStore;
  }

  public clearStaging(): void {
    this.stagingStore = clearStaging(this.stagingStore);
  }

  public getStagedCount(): number {
    return stagingCount(this.stagingStore);
  }

  /**
   * Commits a single staged file to physical disk and removes it from staging.
   */
  public async commitStaged(relPath: string): Promise<void> {
    const key = normalizeStagingPath(relPath);
    const staged = this.stagingStore[key];
    if (!staged) return;
    await commitStagedFile(this.workspaceRoot, staged);
    this.stagingStore = unstageFile(this.stagingStore, relPath);
  }

  /**
   * Commits all currently staged files to physical disk and clears the staging store.
   */
  public async commitAllStaged(): Promise<void> {
    for (const staged of Object.values(this.stagingStore)) {
      await commitStagedFile(this.workspaceRoot, staged);
    }
    this.stagingStore = clearStaging(this.stagingStore);
  }

  /* ------------------------------------------------------------------ */
  /* Filesystem Operations                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Lists entries in a workspace directory.
   */
  public async fsList(relPath: string = ''): Promise<FsEntry[]> {
    if (this.permissionBroker) {
      const perm = await this.permissionBroker.checkReadPermission(
        this.activeWorkerId || 'anonymous',
        relPath || '.',
      );
      if (!perm.granted) {
        throw new Error(perm.reason || `Permission Denied: list of "${relPath || '.'}" is unauthorized.`);
      }
    }
    const absPath = resolveWithin(this.workspaceRoot, relPath);
    const stat = await fsp.stat(absPath);
    if (!stat.isDirectory()) {
      throw new Error(`Target path is not a directory: ${relPath || '.'}`);
    }

    const dirents = await fsp.readdir(absPath, { withFileTypes: true });
    const results: FsEntry[] = [];
    const seenNames = new Set<string>();

    for (const d of dirents) {
      seenNames.add(d.name);
      let size: number | undefined = undefined;
      if (d.isFile()) {
        try {
          const s = await fsp.stat(path.join(absPath, d.name));
          size = s.size;
        } catch {
          // ignore stat errors
        }
      }
      results.push({
        name: d.name,
        type: d.isDirectory() ? 'dir' : 'file',
        size,
      });
    }

    // Overlay staged files if staging is enabled
    if (this.stagingEnabled) {
      const dirNorm = normalizeStagingPath(relPath);
      for (const staged of Object.values(this.stagingStore)) {
        const parts = staged.path.split('/');
        const stagedFileName = parts[parts.length - 1];
        const stagedDir = parts.slice(0, -1).join('/');

        if (stagedDir === dirNorm && !seenNames.has(stagedFileName)) {
          results.push({
            name: stagedFileName,
            type: 'file',
            size: Buffer.byteLength(staged.content, 'utf8'),
          });
          seenNames.add(stagedFileName);
        }
      }
    }

    // Sort: directories first, then alphabetically
    return results.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'dir' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Reads file content with optional line window slicing and staging overlay priority.
   */
  public async fsRead(
    relPath: string,
    opts?: { startLine?: number; lineCount?: number },
  ): Promise<FsReadResult> {
    if (this.permissionBroker) {
      const perm = await this.permissionBroker.checkReadPermission(
        this.activeWorkerId || 'anonymous',
        relPath,
      );
      if (!perm.granted) {
        throw new Error(perm.reason || `Permission Denied: read of "${relPath}" is unauthorized.`);
      }
    }
    const absPath = resolveWithin(this.workspaceRoot, relPath);
    const normKey = normalizeStagingPath(relPath);
    let content: string;
    let isStaged = false;

    // Check staging overlay first
    if (this.stagingEnabled && this.stagingStore[normKey]) {
      content = this.stagingStore[normKey].content;
      isStaged = true;
    } else {
      content = await fsp.readFile(absPath, 'utf8');
    }

    const lines = content.split('\n');
    const totalLines = lines.length;

    if (opts?.startLine !== undefined || opts?.lineCount !== undefined) {
      const startLine = typeof opts.startLine === 'number' ? Math.max(1, opts.startLine) : 1;
      const lineCount = typeof opts.lineCount === 'number' ? Math.max(0, opts.lineCount) : undefined;

      const startIndex = startLine - 1;
      const endIndex = lineCount !== undefined ? startIndex + lineCount : lines.length;
      const sliced = lines.slice(startIndex, endIndex);
      const truncated = endIndex < lines.length;

      return {
        content: sliced.join('\n'),
        truncated,
        totalLines,
        size: Buffer.byteLength(content, 'utf8'),
        staged: isStaged,
      };
    }

    return {
      content,
      truncated: false,
      totalLines,
      size: Buffer.byteLength(content, 'utf8'),
      staged: isStaged,
    };
  }

  /**
   * Searches text across workspace files matching string or regex query.
   */
  public async fsSearch(
    query: string,
    isRegex: boolean = false,
  ): Promise<FsSearchResult[]> {
    if (!query || typeof query !== 'string') return [];

    let matcher: (line: string) => boolean;
    if (isRegex) {
      try {
        const re = new RegExp(query, 'i');
        matcher = (line: string) => re.test(line);
      } catch (err) {
        throw new Error(`Invalid search regex pattern: ${String(err)}`);
      }
    } else {
      const needle = query.toLowerCase();
      matcher = (line: string) => line.toLowerCase().includes(needle);
    }

    const results: FsSearchResult[] = [];
    const maxResults = 100;
    const scannedStagedPaths = new Set<string>();

    const walk = async (currentAbs: string, prefix: string) => {
      if (results.length >= maxResults) return;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(currentAbs, { withFileTypes: true });
      } catch {
        return;
      }

      for (const ent of entries) {
        if (results.length >= maxResults) return;
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;

        if (ent.isDirectory()) {
          if (!IGNORED_SEARCH_DIRS.has(ent.name) && !ent.name.startsWith('.')) {
            await walk(path.join(currentAbs, ent.name), rel);
          }
          continue;
        }

        if (!ent.isFile() || BINARY_FILE_RE.test(ent.name)) {
          continue;
        }

        // Quyền đọc theo scope: bỏ qua file ngoài `allowedReadGlobs`. Trước đây
        // capability này không hề được kiểm tra nên fs_search rò nội dung file
        // mà worker không được phép đọc.
        if (this.permissionBroker) {
          const perm = await this.permissionBroker.checkReadPermission(
            this.activeWorkerId || 'anonymous',
            rel,
          );
          if (!perm.granted) continue;
        }

        const normKey = normalizeStagingPath(rel);
        scannedStagedPaths.add(normKey);

        let fileText: string;
        try {
          if (this.stagingEnabled && this.stagingStore[normKey]) {
            fileText = this.stagingStore[normKey].content;
          } else {
            fileText = await fsp.readFile(path.join(currentAbs, ent.name), 'utf8');
          }
        } catch {
          continue;
        }

        const lines = fileText.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matcher(lines[i])) {
            results.push({
              path: rel,
              line: i + 1,
              text: lines[i].trim().slice(0, 200),
            });
            if (results.length >= maxResults) return;
          }
        }
      }
    };

    await walk(this.workspaceRoot, '');

    // Also check any new staged files that are not yet on physical disk
    if (this.stagingEnabled) {
      for (const [key, staged] of Object.entries(this.stagingStore)) {
        if (results.length >= maxResults) break;
        if (scannedStagedPaths.has(key)) continue;

        if (this.permissionBroker) {
          const perm = await this.permissionBroker.checkReadPermission(
            this.activeWorkerId || 'anonymous',
            staged.path,
          );
          if (!perm.granted) continue;
        }

        const lines = staged.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matcher(lines[i])) {
            results.push({
              path: staged.path,
              line: i + 1,
              text: lines[i].trim().slice(0, 200),
            });
            if (results.length >= maxResults) break;
          }
        }
      }
    }

    return results;
  }

  /**
   * Writes content to a file, verifying exclusive file lock ownership,
   * applying dual-gate guardrails, and tracking cryptographic provenance.
   */
  public async fsWrite(
    relPath: string,
    content: string,
    workerId?: string,
    opts?: { authorizationToken?: string; milestoneId?: string; bypassDualGate?: boolean },
  ): Promise<FsWriteResult> {
    // 1. Path safety guard
    const absPath = resolveWithin(this.workspaceRoot, relPath);

    // 2. Exclusive File Ownership Lock Verification
    if (this.fileLock && this.fileLock.isLocked(relPath)) {
      const owner = this.fileLock.getLockOwner(relPath);
      if (owner && owner !== workerId) {
        return {
          written: false,
          error: `File "${relPath}" is exclusively locked by worker "${owner}" (access denied for "${workerId ?? 'anonymous'}")`,
        };
      }
    }

    // 2b. Capability Permission Broker check
    if (this.permissionBroker) {
      const targetWorker = workerId || this.activeWorkerId || 'anonymous';
      const perm = await this.permissionBroker.checkWritePermission(targetWorker, relPath);
      if (!perm.granted) {
        return {
          written: false,
          error: perm.reason || `Permission Denied: write to "${relPath}" is unauthorized.`,
        };
      }
    }

    const effectiveWorker = workerId || this.activeWorkerId || 'anonymous';
    const effectiveMilestone = opts?.milestoneId || this.milestoneId || 'M1';
    const toolCtx: ToolExecutionContext = {
      workerId: effectiveWorker,
      milestoneId: effectiveMilestone,
      role: 'worker',
      workspaceRoot: this.workspaceRoot,
      authorizationToken: opts?.authorizationToken || '',
    };

    // 2c. Gate 1 Pre-Flight Check (if enabled)
    if (this.enableDualGate && !opts?.bypassDualGate) {
      const writeContract = defineToolContract({
        name: 'fsWrite',
        description: 'Write file to disk or staging',
        category: 'fs_write',
        riskLevel: 'write',
        inputSchema: z.object({ filePath: z.string(), content: z.string() }),
        outputSchema: z.object({ written: z.boolean() }),
        execute: async () => ({ written: true }),
      });

      const preFlight = await this.dualGate.evaluatePreFlight({
        contract: writeContract,
        rawInput: { filePath: relPath, content },
        context: toolCtx,
        checkLock: (target, wid) =>
          !this.fileLock || !this.fileLock.isLocked(target) || this.fileLock.getLockOwner(target) === wid,
        checkPermission: async (wid, target) => {
          if (!this.permissionBroker) return true;
          const p = await this.permissionBroker.checkWritePermission(wid, target);
          return p.granted;
        },
      });

      if (!preFlight.passed) {
        return {
          written: false,
          error: preFlight.reason || 'Pre-flight check failed.',
        };
      }
    }

    // 3. Staging overlay or physical disk write
    const normKey = normalizeStagingPath(relPath);
    const existing = this.stagingStore[normKey];
    let diskOriginal: string | null = existing ? existing.original : null;
    if (diskOriginal === null) {
      try {
        diskOriginal = await fsp.readFile(absPath, 'utf8');
      } catch {
        diskOriginal = null;
      }
    }

    if (this.stagingEnabled) {
      this.stagingStore = stageFile(this.stagingStore, relPath, diskOriginal, content);
    } else {
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      await fsp.writeFile(absPath, content, 'utf8');
    }

    // 4. Cryptographic Provenance Tracking
    try {
      this.provenanceTracker.createRecord({
        context: toolCtx,
        filePath: relPath,
        action: diskOriginal === null ? 'create' : 'modify',
        contentBefore: diskOriginal ?? '',
        contentAfter: content,
      });
    } catch {
      // Best effort provenance recording
    }

    // 5. Gate 2 Post-Flight Check (if enabled)
    if (this.enableDualGate && !opts?.bypassDualGate) {
      const writeContract = defineToolContract({
        name: 'fsWrite',
        description: 'Write file to disk or staging',
        category: 'fs_write',
        riskLevel: 'write',
        inputSchema: z.object({ filePath: z.string(), content: z.string() }),
        outputSchema: z.object({ written: z.boolean() }),
        execute: async () => ({ written: true }),
      });

      const postFlight = await this.dualGate.evaluatePostFlight({
        contract: writeContract,
        output: { written: true },
        context: toolCtx,
        newContent: content,
        oldContent: diskOriginal ?? undefined,
      });

      if (!postFlight.passed && postFlight.verdict === 'FAIL-BLOCKED') {
        const issuesMsg = postFlight.issues.map((i) => i.description).join('; ');
        return {
          written: false,
          error: `Post-flight review failed: ${issuesMsg || 'Integrity check failed.'}`,
          staged: this.stagingEnabled,
        };
      }
    }

    return {
      written: true,
      staged: this.stagingEnabled,
      size: Buffer.byteLength(content, 'utf8'),
    };
  }

  /**
   * Applies SEARCH/REPLACE edit blocks to a file, verifying exclusive ownership,
   * tracking provenance, and optionally checking dual-gate guardrails.
   */
  public async fsEdit(
    relPath: string,
    blocksText: string,
    workerId?: string,
    opts?: { authorizationToken?: string; milestoneId?: string; bypassDualGate?: boolean },
  ): Promise<FsEditResult> {
    // 1. Path safety guard
    const absPath = resolveWithin(this.workspaceRoot, relPath);

    // 2. Exclusive File Ownership Lock Verification
    if (this.fileLock && this.fileLock.isLocked(relPath)) {
      const owner = this.fileLock.getLockOwner(relPath);
      if (owner && owner !== workerId) {
        return {
          applied: false,
          error: `File "${relPath}" is exclusively locked by worker "${owner}" (access denied for "${workerId ?? 'anonymous'}")`,
        };
      }
    }

    // 2b. Capability Permission Broker check
    if (this.permissionBroker) {
      const targetWorker = workerId || this.activeWorkerId || 'anonymous';
      const perm = await this.permissionBroker.checkWritePermission(targetWorker, relPath);
      if (!perm.granted) {
        return {
          applied: false,
          error: perm.reason || `Permission Denied: edit to "${relPath}" is unauthorized.`,
        };
      }
    }

    const effectiveWorker = workerId || this.activeWorkerId || 'anonymous';
    const effectiveMilestone = opts?.milestoneId || this.milestoneId || 'M1';
    const toolCtx: ToolExecutionContext = {
      workerId: effectiveWorker,
      milestoneId: effectiveMilestone,
      role: 'worker',
      workspaceRoot: this.workspaceRoot,
      authorizationToken: opts?.authorizationToken || '',
    };

    // 3. Parse edit blocks (supply relPath header if omitted by model/caller)
    let parsed = parseEditBlocks(blocksText);
    if ((parsed.error || parsed.blocks.length === 0) && relPath) {
      const withFile = `${relPath}\n${blocksText}`;
      const retryParsed = parseEditBlocks(withFile);
      if (!retryParsed.error && retryParsed.blocks.length > 0) {
        parsed = retryParsed;
      }
    }
    if (parsed.error || parsed.blocks.length === 0) {
      return {
        applied: false,
        error: parsed.error ?? 'Failed to parse SEARCH/REPLACE edit blocks.',
      };
    }

    // 4. Retrieve base content
    const normKey = normalizeStagingPath(relPath);
    const existingStaged = this.stagingStore[normKey];
    let beforeText: string;

    if (this.stagingEnabled && existingStaged) {
      beforeText = existingStaged.content;
    } else {
      try {
        beforeText = await fsp.readFile(absPath, 'utf8');
      } catch (err) {
        return {
          applied: false,
          error: `Cannot read target file "${relPath}" for editing: ${String(err)}`,
        };
      }
    }

    // 5. Apply each edit block sequentially
    let current = beforeText;
    let appliedCount = 0;
    for (const block of parsed.blocks) {
      const r = replaceMostSimilarChunk(current, block.search, block.replace);
      if (!r.ok) {
        return {
          applied: false,
          error: r.hint ?? `SEARCH chunk did not match in "${relPath}".`,
        };
      }
      current = r.text!;
      appliedCount++;
    }

    // 6. Write or stage updated content
    if (this.stagingEnabled) {
      const diskOriginal = existingStaged ? existingStaged.original : beforeText;
      this.stagingStore = stageFile(this.stagingStore, relPath, diskOriginal, current);
    } else {
      await fsp.writeFile(absPath, current, 'utf8');
    }

    // 7. Track Provenance
    try {
      this.provenanceTracker.createRecord({
        context: toolCtx,
        filePath: relPath,
        action: 'modify',
        contentBefore: beforeText,
        contentAfter: current,
      });
    } catch {
      // Best effort provenance
    }

    // 8. Gate 2 Post-Flight Check if enabled
    if (this.enableDualGate && !opts?.bypassDualGate) {
      const editContract = defineToolContract({
        name: 'fsEdit',
        description: 'Edit file chunks',
        category: 'fs_write',
        riskLevel: 'write',
        inputSchema: z.object({ filePath: z.string(), blocksText: z.string() }),
        outputSchema: z.object({ applied: z.boolean() }),
        execute: async () => ({ applied: true }),
      });

      const postFlight = await this.dualGate.evaluatePostFlight({
        contract: editContract,
        output: { applied: true },
        context: toolCtx,
        newContent: current,
        oldContent: beforeText,
      });

      if (!postFlight.passed && postFlight.verdict === 'FAIL-BLOCKED') {
        const issuesMsg = postFlight.issues.map((i) => i.description).join('; ');
        return {
          applied: false,
          error: `Post-flight review failed: ${issuesMsg || 'Integrity check failed.'}`,
          staged: this.stagingEnabled,
          blocksApplied: appliedCount,
        };
      }
    }

    return {
      applied: true,
      staged: this.stagingEnabled,
      blocksApplied: appliedCount,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Shell & Command Execution                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Executes a shell command with auto-pilot safety filtering, timeout, output capping,
   * and optional process sandboxing.
   */
  public async shellRun(
    command: string,
    cwd?: string,
    timeoutMs?: number,
    envOverrides?: Record<string, string>,
  ): Promise<ShellRunResult> {
    if (!command || typeof command !== 'string') {
      throw new Error('shellRun requires a valid command string.');
    }

    // 1. Hard Safety Gate: Destructive commands ALWAYS blocked regardless of policy
    if (isAlwaysBlocked(command)) {
      throw new Error(
        `Command blocked by auto-pilot safety policy: dangerous command pattern detected ("${command.slice(0, 100)}")`,
      );
    }

    // 2. Policy check
    if (this.approvalPolicy === 'always') {
      if (this.onApprovalRequest) {
        const approved = await this.onApprovalRequest(command);
        if (!approved) {
          throw new Error(`Command execution rejected by user under 'always' approval policy.`);
        }
      } else {
        throw new Error(`Command execution requires explicit approval in 'always' policy mode.`);
      }
    } else if (this.approvalPolicy === 'smart') {
      if (!isSafeCommand(command)) {
        if (this.onApprovalRequest) {
          const approved = await this.onApprovalRequest(command);
          if (!approved) {
            throw new Error(`Command execution rejected by user under 'smart' approval policy.`);
          }
        }
        // In headless runner without onApprovalRequest callback, non-destructive commands are permitted
      }
    }

    // 2b. Capability Permission Broker check
    if (this.permissionBroker) {
      const targetWorker = this.activeWorkerId || 'anonymous';
      const perm = await this.permissionBroker.checkExecPermission(targetWorker, command);
      if (!perm.granted) {
        throw new Error(perm.reason || `Permission Denied: execution of "${command}" is unauthorized.`);
      }
    }

    // 3. Resolve execution working directory
    const execCwd = cwd ? resolveWithin(this.workspaceRoot, cwd) : this.workspaceRoot;
    const timeout = timeoutMs ?? 30_000;

    // 4. If Sandboxing is enabled, delegate to SandboxedProcessManager
    if (this.enableSandbox) {
      const sandboxed = await SandboxedProcessManager.executeSandboxed(this.workspaceRoot, {
        command,
        cwd: execCwd,
        timeoutMs: timeout,
        workerId: this.activeWorkerId,
        env: envOverrides,
        scrubSensitiveEnv: true,
        isolatedTemp: true,
      });

      return {
        code: sandboxed.code,
        stdout: sandboxed.stdout,
        stderr: sandboxed.stderr,
        durationMs: sandboxed.durationMs,
        truncated: sandboxed.stdout.length >= 100_000 || sandboxed.stderr.length >= 100_000,
      };
    }

    // 5. Standard execution with supervised process tree teardown
    const isWin = process.platform === 'win32';
    const shellExe = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

    let effectiveEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (envOverrides) {
      Object.assign(effectiveEnv, envOverrides);
    }
    if (this.envScrubber) {
      effectiveEnv = EnvScrubber.scrub(effectiveEnv);
    }

    return new Promise((resolve) => {
      const startTime = Date.now();
      const child = child_process.spawn(shellExe, shellArgs, {
        cwd: execCwd,
        windowsHide: true,
        windowsVerbatimArguments: isWin,
        env: effectiveEnv as NodeJS.ProcessEnv,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const maxChars = 100_000;
      const appendCap = (current: string, chunk: string): string => {
        if (current.length >= maxChars) return current;
        return (current + chunk).slice(0, maxChars);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.killProcess(child);
      }, timeout);

      child.stdout?.on('data', (d: Buffer) => {
        stdout = appendCap(stdout, d.toString());
      });

      child.stderr?.on('data', (d: Buffer) => {
        stderr = appendCap(stderr, d.toString());
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code: null,
          stdout,
          stderr: `${stderr}\n${String(err)}`.trim(),
          durationMs: Date.now() - startTime,
          truncated: stdout.length >= maxChars || stderr.length >= maxChars,
        });
      });

      child.on('exit', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (timedOut) {
          stderr = `${stderr}\nCommand timed out after ${timeout}ms`.trim();
        }
        resolve({
          code: timedOut ? 124 : code,
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
          truncated: stdout.length >= maxChars || stderr.length >= maxChars,
        });
      });
    });
  }

  /**
   * Safely terminates a running child process and its entire process tree.
   */
  private killProcess(child: child_process.ChildProcess): void {
    if (!child || child.exitCode !== null || !child.pid) return;
    SandboxedProcessManager.killProcessTree(child.pid);
  }

  /* ------------------------------------------------------------------ */
  /* Background Process Management                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Starts a long-running or asynchronous command in the background.
   */
  public async process_start(
    command: string,
    options?: ProcessStartOptions,
  ): Promise<{ processId: string; pid?: number; status: 'running' | 'completed' | 'failed'; error?: string }> {
    if (!command || typeof command !== 'string' || !command.trim()) {
      throw new Error('process_start requires a non-empty command string.');
    }

    if (isAlwaysBlocked(command)) {
      throw new Error(
        `Command blocked by auto-pilot safety policy: dangerous command pattern detected ("${command.slice(0, 100)}")`,
      );
    }

    if (this.permissionBroker) {
      const targetWorker = this.activeWorkerId || 'anonymous';
      const perm = await this.permissionBroker.checkExecPermission(targetWorker, command);
      if (!perm.granted) {
        throw new Error(perm.reason || `Permission Denied: execution of "${command}" is unauthorized.`);
      }
    }

    const execCwd = options?.cwd ? resolveWithin(this.workspaceRoot, options.cwd) : this.workspaceRoot;
    const processId = options?.id || `proc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const isWin = process.platform === 'win32';
    const shellExe = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

    let effectiveEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...options?.env };
    if (this.envScrubber) {
      effectiveEnv = EnvScrubber.scrub(effectiveEnv);
    }

    const child = child_process.spawn(shellExe, shellArgs, {
      cwd: execCwd,
      windowsHide: true,
      windowsVerbatimArguments: isWin,
      env: effectiveEnv as NodeJS.ProcessEnv,
      detached: !isWin,
    });

    const record: BackgroundProcessRecord = {
      processId,
      command,
      pid: child.pid,
      child,
      status: 'running',
      exitCode: null,
      startTime: Date.now(),
      stdout: '',
      stderr: '',
      cwd: execCwd,
    };

    this.backgroundProcesses.set(processId, record);
    defaultProcessRegistry.set(processId, record);

    const maxChars = 500_000;
    child.stdout?.on('data', (d: Buffer) => {
      record.stdout = (record.stdout + d.toString()).slice(-maxChars);
    });

    child.stderr?.on('data', (d: Buffer) => {
      record.stderr = (record.stderr + d.toString()).slice(-maxChars);
    });

    child.on('error', (err: Error) => {
      record.status = 'failed';
      record.error = err.message;
      record.endTime = Date.now();
    });

    child.on('exit', (code: number | null) => {
      if (record.status === 'running') {
        record.status = code === 0 ? 'completed' : 'failed';
      }
      record.exitCode = code;
      record.endTime = Date.now();
    });

    if (options?.timeoutMs && options.timeoutMs > 0) {
      setTimeout(() => {
        if (record.status === 'running') {
          void this.process_stop(processId, 'SIGKILL');
        }
      }, options.timeoutMs);
    }

    return { processId, pid: child.pid, status: 'running' };
  }

  /**
   * Inspects status, pid, exitCode, uptime of a background process.
   */
  public process_status(processId: string): ProcessStatusResult {
    const record = this.backgroundProcesses.get(processId) || defaultProcessRegistry.get(processId);
    if (!record) {
      return {
        processId,
        status: 'unknown',
        exitCode: null,
        uptimeMs: 0,
        error: `Process with ID "${processId}" not found.`,
      };
    }

    const uptimeMs = (record.endTime ?? Date.now()) - record.startTime;
    return {
      processId,
      pid: record.pid,
      status: record.status,
      exitCode: record.exitCode,
      uptimeMs,
      command: record.command,
      error: record.error,
    };
  }

  /**
   * Retrieves buffered stdout and stderr of a background process.
   */
  public process_output(
    processId: string,
    options?: { tail?: number; clear?: boolean },
  ): ProcessOutputResult {
    const record = this.backgroundProcesses.get(processId) || defaultProcessRegistry.get(processId);
    if (!record) {
      return {
        processId,
        stdout: '',
        stderr: '',
        status: 'unknown',
        exitCode: null,
      };
    }

    let stdout = record.stdout;
    let stderr = record.stderr;

    if (options?.tail && options.tail > 0) {
      if (stdout) {
        const outLines = stdout.trimEnd().split(/\r?\n/);
        stdout = outLines.slice(-options.tail).join('\n');
      }
      if (stderr) {
        const errLines = stderr.trimEnd().split(/\r?\n/);
        stderr = errLines.slice(-options.tail).join('\n');
      }
    }

    if (options?.clear) {
      record.stdout = '';
      record.stderr = '';
    }

    return {
      processId,
      stdout,
      stderr,
      status: record.status,
      exitCode: record.exitCode,
    };
  }

  /**
   * Stops a running background process utilizing SandboxedProcessManager.killProcessTree.
   */
  public async process_stop(
    processId: string,
    signal: NodeJS.Signals = 'SIGTERM',
  ): Promise<ProcessStopResult> {
    const record = this.backgroundProcesses.get(processId) || defaultProcessRegistry.get(processId);
    if (!record) {
      return { processId, stopped: false, error: `Process with ID "${processId}" not found.` };
    }

    if (record.status !== 'running') {
      return { processId, stopped: true };
    }

    if (record.pid) {
      SandboxedProcessManager.killProcessTree(record.pid, signal);
    }

    record.status = 'stopped';
    record.endTime = Date.now();
    return { processId, stopped: true };
  }

  /**
   * Terminates all background processes currently tracked by this runner.
   */
  public async cleanupAllProcesses(): Promise<void> {
    for (const [id, rec] of this.backgroundProcesses) {
      if (rec.status === 'running') {
        await this.process_stop(id, 'SIGKILL');
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Git Operations                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Retrieves git branch and repository status.
   */
  public async gitStatus(): Promise<GitStatusResult> {
    try {
      const res = await this.gitRun(['status', '--porcelain=v1', '-b']);
      const lines = res.split('\n').filter((l) => l.length > 0);
      let branch: string | null = null;
      let start = 0;

      if (lines[0] && lines[0].startsWith('##')) {
        branch = lines[0].slice(2).trim().split('...')[0].trim() || null;
        start = 1;
      }

      const fileEntries = lines.slice(start);
      const clean = fileEntries.length === 0;
      return {
        branch,
        clean,
        status: res.trim(),
      };
    } catch {
      // Gracefully handle non-git workspace
      return {
        branch: null,
        clean: true,
        status: '',
      };
    }
  }

  /**
   * Retrieves unified diff from git or from in-memory staging overlay.
   */
  public async gitDiff(relPath?: string, staged?: boolean): Promise<string> {
    // 1. If staging is enabled and staged diff requested, check in-memory overlay
    if (staged && this.stagingEnabled) {
      if (relPath) {
        const key = normalizeStagingPath(relPath);
        const stagedEntry = this.stagingStore[key];
        if (stagedEntry) {
          const lines = stagedFileDiff(stagedEntry);
          const diff = renderUnifiedDiff(lines);
          if (diff.text) {
            return `--- a/${stagedEntry.path}\n+++ b/${stagedEntry.path}\n${diff.text}`;
          }
          return '';
        }
      } else if (stagingCount(this.stagingStore) > 0) {
        const diffChunks: string[] = [];
        for (const stagedEntry of Object.values(this.stagingStore)) {
          const lines = stagedFileDiff(stagedEntry);
          const diff = renderUnifiedDiff(lines);
          if (diff.text) {
            diffChunks.push(`--- a/${stagedEntry.path}\n+++ b/${stagedEntry.path}\n${diff.text}`);
          }
        }
        if (diffChunks.length > 0) {
          return diffChunks.join('\n');
        }
      }
    }

    // 2. Fallback to git diff command
    try {
      const args = ['diff'];
      if (staged) args.push('--cached');
      args.push('--');
      if (relPath) args.push(relPath);
      return await this.gitRun(args);
    } catch {
      return '';
    }
  }

  /**
   * Resolves the current git HEAD commit hash (short form), or null outside a git repo.
   */
  public async gitHead(): Promise<string | null> {
    try {
      const out = await this.gitRun(['rev-parse', '--short', 'HEAD']);
      const head = out.trim();
      return head || null;
    } catch {
      return null;
    }
  }

  /**
   * Helper to execute git command safely within workspace root.
   */
  private gitRun(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = child_process.spawn(
        'git',
        ['--no-optional-locks', '-C', this.workspaceRoot, ...args],
        { windowsHide: true },
      );

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (d) => {
        stdout += d.toString();
      });

      child.stderr?.on('data', (d) => {
        stderr += d.toString();
      });

      child.on('error', (err) => {
        reject(err);
      });

      child.on('exit', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`git command failed (code ${code}): ${stderr.trim()}`));
        }
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Zero-Mem Operations                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Access the deterministic Zero-Mem store for this workspace.
   */
  public getZeroMemStore(): ZeroMemStore {
    return getZeroMemStore(path.basename(this.workspaceRoot));
  }

  /**
   * Deterministic zero-token retrieval of past conversation traces & entity context.
   */
  public async zeroMemQuery(query: string, options: { maxResults?: number; mode?: 'hybrid' | 'lexical' | 'graph'; episodeId?: string } = {}) {
    const store = this.getZeroMemStore();
    return store.query({
      query,
      maxResults: options.maxResults,
      mode: options.mode,
      episodeId: options.episodeId,
    });
  }

  /**
   * Append raw trace to Zero-Mem with zero-token entity extraction.
   */
  public async zeroMemLog(content: string, role: 'user' | 'assistant' | 'tool' = 'tool', toolName?: string) {
    const store = this.getZeroMemStore();
    return store.appendTrace({
      sessionId: 'headless-teamwork',
      role,
      content,
      toolName,
    });
  }

  /**
   * Retrieve Zero-Mem statistics and estimated token savings.
   */
  public zeroMemStats() {
    return this.getZeroMemStore().getStats();
  }

  /* ------------------------------------------------------------------ */
  /* Sarsed-Code Operations                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Extract token-efficient AST skeleton of a workspace file.
   */
  public async codeSkeleton(relPath: string, options: { preserveComments?: boolean } = {}): Promise<FileSkeleton> {
    const absPath = resolveWithin(this.workspaceRoot, relPath);
    const normKey = normalizeStagingPath(relPath);
    let content: string;
    if (this.stagingEnabled && this.stagingStore[normKey]) {
      content = this.stagingStore[normKey].content;
    } else {
      content = await fsp.readFile(absPath, 'utf8');
    }
    const skeletonizer = new CodeSkeletonizer();
    return skeletonizer.skeletonize(relPath, content, options);
  }

  /**
   * Search symbols across workspace files.
   */
  public async codeSymbols(query?: string, kind?: any) {
    const files = await this.collectTextFiles(this.workspaceRoot, 100);
    const indexer = new SarsedSymbolIndex();
    indexer.indexFiles(files);
    return indexer.findSymbols({ name: query, kind });
  }

  /**
   * Apply atomic multi-hunk semantic patch with indentation auto-alignment.
   */
  public async codePatch(
    relPath: string,
    hunks: Array<{ search: string; replace: string; lineHint?: number }>,
    atomic: boolean = true,
  ): Promise<PatchResult> {
    const absPath = resolveWithin(this.workspaceRoot, relPath);
    const normKey = normalizeStagingPath(relPath);
    let diskOriginal = '';
    try {
      diskOriginal = await fsp.readFile(absPath, 'utf8');
    } catch {
      // file might not exist on disk yet
    }

    const stagedEntry = this.stagingEnabled ? this.stagingStore[normKey] : undefined;
    const baseContent = stagedEntry ? stagedEntry.content : diskOriginal;
    const patcher = new SarsedPatcher();

    const res = patcher.applyPatch(relPath, baseContent, {
      file: relPath,
      hunks,
      atomic,
    });

    if (res.success && res.modifiedContent !== undefined) {
      if (this.stagingEnabled) {
        this.stagingStore = stageFile(
          this.stagingStore,
          relPath,
          stagedEntry ? stagedEntry.original : diskOriginal,
          res.modifiedContent,
        );
      } else {
        await fsp.writeFile(absPath, res.modifiedContent, 'utf8');
      }
    }

    return res;
  }

  /**
   * Run verification command and return structured diagnostics.
   */
  public async codeVerify(command: string = 'npm test', touchedFiles?: string[]): Promise<VerificationResult> {
    const startTime = Date.now();
    const runRes = await this.shellRun(command, undefined, 60_000);
    const verifier = new SarsedVerifier();

    const output = `${runRes.stdout}\n${runRes.stderr}`.trim();
    const allDiags = verifier.parseDiagnostics(output);
    const relevantDiags = touchedFiles ? verifier.filterByFiles(allDiags, touchedFiles) : allDiags;

    const errorCount = relevantDiags.filter((d) => d.severity === 'error').length;
    const warningCount = relevantDiags.filter((d) => d.severity === 'warning').length;

    return {
      ok: runRes.code === 0 && errorCount === 0,
      command,
      exitCode: runRes.code ?? 1,
      diagnostics: relevantDiags,
      errorCount,
      warningCount,
      output,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Helper to collect text files for symbol indexing.
   */
  private async collectTextFiles(dir: string, maxFiles: number): Promise<Array<{ path: string; content: string }>> {
    const results: Array<{ path: string; content: string }> = [];
    const walk = async (currDir: string) => {
      if (results.length >= maxFiles) return;
      const entries = await fsp.readdir(currDir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxFiles) return;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(currDir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && /\.(ts|tsx|js|jsx|py|go|rs)$/i.test(entry.name)) {
          try {
            const content = await fsp.readFile(full, 'utf8');
            results.push({ path: path.relative(this.workspaceRoot, full).replace(/\\/g, '/'), content });
          } catch {
            // ignore read error
          }
        }
      }
    };
    await walk(dir);
    return results;
  }
}

/**
 * Starts a long-running or asynchronous command in the background.
 */
export async function process_start(
  command: string,
  options?: ProcessStartOptions & { workspaceRoot?: string },
): Promise<{ processId: string; pid?: number; status: 'running' | 'completed' | 'failed'; error?: string }> {
  const runner = new HeadlessToolRunner({ workspaceRoot: options?.workspaceRoot || process.cwd() });
  return runner.process_start(command, options);
}

/**
 * Inspects status, pid, exitCode, uptime of a background process.
 */
export function process_status(processId: string): ProcessStatusResult {
  const record = defaultProcessRegistry.get(processId);
  if (!record) {
    return {
      processId,
      status: 'unknown',
      exitCode: null,
      uptimeMs: 0,
      error: `Process with ID "${processId}" not found.`,
    };
  }
  const uptimeMs = (record.endTime ?? Date.now()) - record.startTime;
  return {
    processId,
    pid: record.pid,
    status: record.status,
    exitCode: record.exitCode,
    uptimeMs,
    command: record.command,
    error: record.error,
  };
}

/**
 * Retrieves buffered stdout and stderr of a background process.
 */
export function process_output(
  processId: string,
  options?: { tail?: number; clear?: boolean },
): ProcessOutputResult {
  const record = defaultProcessRegistry.get(processId);
  if (!record) {
    return {
      processId,
      stdout: '',
      stderr: '',
      status: 'unknown',
      exitCode: null,
    };
  }

  let stdout = record.stdout;
  let stderr = record.stderr;

  if (options?.tail && options.tail > 0) {
    if (stdout) {
      const outLines = stdout.trimEnd().split(/\r?\n/);
      stdout = outLines.slice(-options.tail).join('\n');
    }
    if (stderr) {
      const errLines = stderr.trimEnd().split(/\r?\n/);
      stderr = errLines.slice(-options.tail).join('\n');
    }
  }

  if (options?.clear) {
    record.stdout = '';
    record.stderr = '';
  }

  return {
    processId,
    stdout,
    stderr,
    status: record.status,
    exitCode: record.exitCode,
  };
}

/**
 * Stops a running background process utilizing SandboxedProcessManager.killProcessTree.
 */
export async function process_stop(
  processId: string,
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<ProcessStopResult> {
  const record = defaultProcessRegistry.get(processId);
  if (!record) {
    return { processId, stopped: false, error: `Process with ID "${processId}" not found.` };
  }

  if (record.status !== 'running') {
    return { processId, stopped: true };
  }

  if (record.pid) {
    SandboxedProcessManager.killProcessTree(record.pid, signal);
  }

  record.status = 'stopped';
  record.endTime = Date.now();
  return { processId, stopped: true };
}
