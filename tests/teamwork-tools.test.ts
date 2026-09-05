/**
 * Comprehensive Unit Test Suite for HeadlessToolRunner & Tool Safety Layers
 * Conforms strictly to ORIGINAL_REQUEST.md R2, PROJECT.md, and M2 specifications.
 *
 * Covers:
 * 1. Pure Node.js headless environment isolation (no React, DOM, or IndexedDB)
 * 2. Filesystem methods: fsList, fsRead, fsSearch, fsWrite, fsEdit
 * 3. Path-guard workspace boundary enforcement & traversal blocking
 * 4. Staging Diff Sandbox (in-memory overlay, diff generation, commit)
 * 5. Edit blocks replacement via replaceMostSimilarChunk
 * 6. Auto-pilot policy & shell command execution safety
 * 7. Git status and diff operations
 * 8. Exclusive file ownership integration with FileLockManager
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileLockManager } from '@/lib/teamwork/file-lock';
import {
  commitStagedFile,
  HeadlessToolRunner,
  isWithinRoot,
  resolveWithin,
} from '@/lib/teamwork/tools';

describe('HeadlessToolRunner — Environment & Initialization', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'teamwork-tools-env-'));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('runs in pure Node.js headless environment without DOM or IndexedDB', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    expect(typeof indexedDB).toBe('undefined');
  });

  it('initializes with default options and resolved workspaceRoot', () => {
    const runner = new HeadlessToolRunner({ workspaceRoot: tempDir });
    expect(runner.workspaceRoot).toBe(path.resolve(tempDir));
    expect(runner.stagingEnabled).toBe(false);
    expect(runner.approvalPolicy).toBe('smart');
    expect(runner.getStagedCount()).toBe(0);
  });

  it('throws an error if initialized without workspaceRoot', () => {
    expect(() => new HeadlessToolRunner({ workspaceRoot: '' })).toThrow(/requires a valid workspaceRoot/i);
  });
});

describe('HeadlessToolRunner — Path-Guard Safety Integration', () => {
  let tempDir: string;
  let runner: HeadlessToolRunner;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'teamwork-guard-'));
    runner = new HeadlessToolRunner({ workspaceRoot: tempDir });
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('resolves safe relative paths inside workspace root', () => {
    const p1 = resolveWithin(tempDir, 'file.txt');
    expect(p1).toBe(path.resolve(tempDir, 'file.txt'));

    const p2 = resolveWithin(tempDir, 'nested/dir/app.ts');
    expect(p2).toBe(path.resolve(tempDir, 'nested/dir/app.ts'));

    const p3 = resolveWithin(tempDir, '');
    expect(p3).toBe(path.resolve(tempDir));
  });

  it('blocks directory traversal escaping workspace root (../outside.txt)', async () => {
    expect(() => resolveWithin(tempDir, '../outside.txt')).toThrow(/thoát khỏi workspace/i);
    expect(() => resolveWithin(tempDir, 'sub/../../outside.txt')).toThrow(/thoát khỏi workspace/i);

    await expect(runner.fsRead('../outside.txt')).rejects.toThrow(/thoát khỏi workspace/i);
    await expect(runner.fsWrite('../outside.txt', 'evil content')).rejects.toThrow(/thoát khỏi workspace/i);
  });

  it('blocks absolute paths', async () => {
    const abs = process.platform === 'win32' ? 'C:\\Windows\\System32\\calc.exe' : '/etc/passwd';
    expect(() => resolveWithin(tempDir, abs)).toThrow(/tuyệt đối/i);
    await expect(runner.fsRead(abs)).rejects.toThrow(/tuyệt đối/i);
    await expect(runner.fsWrite(abs, 'content')).rejects.toThrow(/tuyệt đối/i);
  });

  it('blocks NUL bytes in file paths', async () => {
    expect(() => resolveWithin(tempDir, 'foo\0bar.txt')).toThrow(/NUL/i);
    await expect(runner.fsRead('foo\0bar.txt')).rejects.toThrow(/NUL/i);
    await expect(runner.fsWrite('foo\0bar.txt', 'data')).rejects.toThrow(/NUL/i);
  });

  it('verifies isWithinRoot helper accurately', () => {
    const isWin = process.platform === 'win32';
    const root = isWin ? 'C:\\workspace' : '/workspace';
    const child = isWin ? 'C:\\workspace\\src\\lib.ts' : '/workspace/src/lib.ts';
    const sibling = isWin ? 'C:\\workspace2\\src\\lib.ts' : '/workspace2/src/lib.ts';

    expect(isWithinRoot(root, child)).toBe(true);
    expect(isWithinRoot(root, sibling)).toBe(false);
  });
});

describe('HeadlessToolRunner — Filesystem Operations (fsList, fsRead, fsWrite, fsSearch)', () => {
  let tempDir: string;
  let runner: HeadlessToolRunner;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'teamwork-fs-'));
    runner = new HeadlessToolRunner({ workspaceRoot: tempDir });

    // Populate sample workspace files
    await fsp.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'README.md'), '# Vyen Project\nWelcome to headless runner.\n', 'utf8');
    await fsp.writeFile(
      path.join(tempDir, 'src', 'index.ts'),
      'export function hello(): string {\n  return "hello world";\n}\n',
      'utf8',
    );
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('fsList lists files and directories accurately', async () => {
    const entries = await runner.fsList('');
    const names = entries.map((e) => e.name);

    expect(names).toContain('README.md');
    expect(names).toContain('src');

    const srcDir = entries.find((e) => e.name === 'src');
    expect(srcDir?.type).toBe('dir');

    const readme = entries.find((e) => e.name === 'README.md');
    expect(readme?.type).toBe('file');
    expect(readme?.size).toBeGreaterThan(0);
  });

  it('fsList lists subdirectories', async () => {
    const entries = await runner.fsList('src');
    expect(entries.map((e) => e.name)).toEqual(['index.ts']);
    expect(entries[0].type).toBe('file');
  });

  it('fsList throws on non-directory target', async () => {
    await expect(runner.fsList('README.md')).rejects.toThrow(/not a directory/i);
  });

  it('fsRead reads full file content', async () => {
    const res = await runner.fsRead('README.md');
    expect(res.content).toBe('# Vyen Project\nWelcome to headless runner.\n');
    expect(res.truncated).toBe(false);
    expect(res.totalLines).toBe(3);
    expect(res.staged).toBe(false);
  });

  it('fsRead supports startLine and lineCount pagination', async () => {
    const multiLine = 'line 1\nline 2\nline 3\nline 4\nline 5';
    await fsp.writeFile(path.join(tempDir, 'lines.txt'), multiLine, 'utf8');

    const res = await runner.fsRead('lines.txt', { startLine: 2, lineCount: 2 });
    expect(res.content).toBe('line 2\nline 3');
    expect(res.truncated).toBe(true);
    expect(res.totalLines).toBe(5);

    const fullRes = await runner.fsRead('lines.txt', { startLine: 1, lineCount: 10 });
    expect(fullRes.content).toBe(multiLine);
    expect(fullRes.truncated).toBe(false);
  });

  it('fsWrite writes a new file to disk', async () => {
    const writeRes = await runner.fsWrite('newfile.txt', 'console.log("created");');
    expect(writeRes.written).toBe(true);
    expect(writeRes.staged).toBe(false);

    const onDisk = await fsp.readFile(path.join(tempDir, 'newfile.txt'), 'utf8');
    expect(onDisk).toBe('console.log("created");');
  });

  it('fsWrite creates nested subdirectories automatically', async () => {
    const res = await runner.fsWrite('deep/nested/sub/module.ts', 'export const x = 1;');
    expect(res.written).toBe(true);

    const onDisk = await fsp.readFile(path.join(tempDir, 'deep/nested/sub/module.ts'), 'utf8');
    expect(onDisk).toBe('export const x = 1;');
  });

  it('fsSearch performs literal search across files', async () => {
    const results = await runner.fsSearch('hello world');
    expect(results.length).toBe(1);
    expect(results[0].path).toBe('src/index.ts');
    expect(results[0].line).toBe(2);
    expect(results[0].text).toContain('return "hello world";');
  });

  it('fsSearch performs regex search across files', async () => {
    const results = await runner.fsSearch('export\\s+function\\s+\\w+', true);
    expect(results.length).toBe(1);
    expect(results[0].path).toBe('src/index.ts');
    expect(results[0].line).toBe(1);
  });

  it('fsSearch returns empty array for non-matching queries or empty string', async () => {
    const noMatch = await runner.fsSearch('non_existent_text_phrase_xyz');
    expect(noMatch).toEqual([]);

    const empty = await runner.fsSearch('');
    expect(empty).toEqual([]);
  });
});

describe('HeadlessToolRunner — Staging Diff Sandbox (In-Memory Overlay)', () => {
  let tempDir: string;
  let runner: HeadlessToolRunner;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'teamwork-staging-'));
    runner = new HeadlessToolRunner({
      workspaceRoot: tempDir,
      stagingEnabled: true, // Enable in-RAM staging overlay
    });

    await fsp.writeFile(path.join(tempDir, 'file.txt'), 'original line 1\noriginal line 2\n', 'utf8');
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('fsWrite in staging mode does not touch disk', async () => {
    const res = await runner.fsWrite('file.txt', 'staged line 1\nstaged line 2\n');
    expect(res.written).toBe(true);
    expect(res.staged).toBe(true);

    // Disk content remains unaltered
    const onDisk = await fsp.readFile(path.join(tempDir, 'file.txt'), 'utf8');
    expect(onDisk).toBe('original line 1\noriginal line 2\n');

    // Staging store contains the staged change
    expect(runner.getStagedCount()).toBe(1);
  });

  it('fsRead reads staged in-memory content first before disk (overlay priority)', async () => {
    await runner.fsWrite('file.txt', 'staged modified content');

    const readRes = await runner.fsRead('file.txt');
    expect(readRes.content).toBe('staged modified content');
    expect(readRes.staged).toBe(true);

    // Disk is still original
    const onDisk = await fsp.readFile(path.join(tempDir, 'file.txt'), 'utf8');
    expect(onDisk).toBe('original line 1\noriginal line 2\n');
  });

  it('fsList includes newly staged files that do not exist on disk', async () => {
    await runner.fsWrite('staged-new-file.txt', 'new in-memory file');

    const entries = await runner.fsList('');
    const names = entries.map((e) => e.name);
    expect(names).toContain('staged-new-file.txt');
    expect(names).toContain('file.txt');
  });

  it('fsSearch finds text in staged overlay files', async () => {
    await runner.fsWrite('new-feature.ts', 'export function stagedSearchTarget() {}');

    const results = await runner.fsSearch('stagedSearchTarget');
    expect(results.length).toBe(1);
    expect(results[0].text).toContain('export function stagedSearchTarget');
  });

  it('gitDiff generates unified diff from in-memory staged files', async () => {
    await runner.fsWrite('file.txt', 'original line 1\nmodified line 2\nadded line 3\n');

    const diff = await runner.gitDiff('file.txt', true);
    expect(diff).toContain('--- a/file.txt');
    expect(diff).toContain('+++ b/file.txt');
    expect(diff).toContain('+ added line 3');
  });

  it('commitStaged persists single staged file to disk and clears it from overlay', async () => {
    await runner.fsWrite('file.txt', 'committed content 1');
    expect(runner.getStagedCount()).toBe(1);

    await runner.commitStaged('file.txt');
    expect(runner.getStagedCount()).toBe(0);

    const onDisk = await fsp.readFile(path.join(tempDir, 'file.txt'), 'utf8');
    expect(onDisk).toBe('committed content 1');
  });

  it('commitAllStaged persists all staged files to disk', async () => {
    await runner.fsWrite('file.txt', 'committed multi 1');
    await runner.fsWrite('extra.txt', 'committed extra 2');
    expect(runner.getStagedCount()).toBe(2);

    await runner.commitAllStaged();
    expect(runner.getStagedCount()).toBe(0);

    const disk1 = await fsp.readFile(path.join(tempDir, 'file.txt'), 'utf8');
    const disk2 = await fsp.readFile(path.join(tempDir, 'extra.txt'), 'utf8');
    expect(disk1).toBe('committed multi 1');
    expect(disk2).toBe('committed extra 2');
  });

  it('commitStagedFile helper directly writes staged object to disk', async () => {
    await commitStagedFile(tempDir, {
      path: 'helper-test.txt',
      original: null,
      content: 'helper content',
      stagedAt: Date.now(),
    });

    const onDisk = await fsp.readFile(path.join(tempDir, 'helper-test.txt'), 'utf8');
    expect(onDisk).toBe('helper content');
  });
});

describe('HeadlessToolRunner — Edit Blocks Replacement (fsEdit)', () => {
  let tempDir: string;
  let runner: HeadlessToolRunner;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'teamwork-edit-'));
    runner = new HeadlessToolRunner({ workspaceRoot: tempDir });

    const source = `function calculate(x: number): number {
  const result = x * 2;
  return result;
}
`;
    await fsp.writeFile(path.join(tempDir, 'calc.ts'), source, 'utf8');
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('applies a single SEARCH/REPLACE edit block to disk file', async () => {
    const blocks = `<<<<<<< SEARCH
  const result = x * 2;
=======
  const result = x * 10;
>>>>>>> REPLACE`;

    const res = await runner.fsEdit('calc.ts', blocks);
    expect(res.applied).toBe(true);
    expect(res.blocksApplied).toBe(1);

    const updated = await fsp.readFile(path.join(tempDir, 'calc.ts'), 'utf8');
    expect(updated).toContain('const result = x * 10;');
  });

  it('applies multiple SEARCH/REPLACE blocks sequentially', async () => {
    const blocks = `<<<<<<< SEARCH
function calculate(x: number): number {
=======
function computeTotal(x: number): number {
>>>>>>> REPLACE
<<<<<<< SEARCH
  const result = x * 2;
=======
  const result = x + 100;
>>>>>>> REPLACE`;

    const res = await runner.fsEdit('calc.ts', blocks);
    expect(res.applied).toBe(true);
    expect(res.blocksApplied).toBe(2);

    const updated = await fsp.readFile(path.join(tempDir, 'calc.ts'), 'utf8');
    expect(updated).toContain('function computeTotal(x: number): number');
    expect(updated).toContain('const result = x + 100;');
  });

  it('handles whitespace / outdent variations via aider fallback', async () => {
    // Search chunk has stripped leading indentation
    const blocks = `<<<<<<< SEARCH
const result = x * 2;
=======
const result = x * 50;
>>>>>>> REPLACE`;

    const res = await runner.fsEdit('calc.ts', blocks);
    expect(res.applied).toBe(true);

    const updated = await fsp.readFile(path.join(tempDir, 'calc.ts'), 'utf8');
    expect(updated).toContain('const result = x * 50;');
  });

  it('returns error and hint if SEARCH block is not found', async () => {
    const blocks = `<<<<<<< SEARCH
this line does not exist anywhere in the file
=======
new replacement
>>>>>>> REPLACE`;

    const res = await runner.fsEdit('calc.ts', blocks);
    expect(res.applied).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/không tìm thấy|search/i);
  });

  it('rejects invalid or empty edit blocks', async () => {
    const res = await runner.fsEdit('calc.ts', 'just random text without delimiters');
    expect(res.applied).toBe(false);
    expect(res.error).toBeDefined();
  });

  it('stages edits in-memory when staging is enabled', async () => {
    const stagingRunner = new HeadlessToolRunner({
      workspaceRoot: tempDir,
      stagingEnabled: true,
    });

    const blocks = `<<<<<<< SEARCH
  const result = x * 2;
=======
  const result = x * 99;
>>>>>>> REPLACE`;

    const res = await stagingRunner.fsEdit('calc.ts', blocks);
    expect(res.applied).toBe(true);
    expect(res.staged).toBe(true);

    // Disk remains unchanged
    const onDisk = await fsp.readFile(path.join(tempDir, 'calc.ts'), 'utf8');
    expect(onDisk).toContain('const result = x * 2;');

    // Headless read returns staged edit
    const read = await stagingRunner.fsRead('calc.ts');
    expect(read.content).toContain('const result = x * 99;');
  });
});

describe('HeadlessToolRunner — Auto-Pilot & Command Safety in shellRun', () => {
  let tempDir: string;
  let runner: HeadlessToolRunner;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'teamwork-shell-'));
    runner = new HeadlessToolRunner({
      workspaceRoot: tempDir,
      approvalPolicy: 'smart',
    });
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('blocks dangerous commands (rm -rf /, rm -rf ~, mkfs, format C:, fork bombs)', async () => {
    const dangerousCommands = [
      'rm -rf /',
      'rm -r /',
      'rm -rf ~',
      'rm -rf ~/projects',
      'mkfs.ext4 /dev/sda1',
      'format C:',
      ':(){ :|:& };:',
      'chmod 777 /',
    ];

    for (const cmd of dangerousCommands) {
      await expect(runner.shellRun(cmd)).rejects.toThrow(/dangerous command pattern detected/i);
    }
  });

  it('blocks dangerous commands even when approvalPolicy is "never" (hard safety backstop)', async () => {
    const yoloRunner = new HeadlessToolRunner({
      workspaceRoot: tempDir,
      approvalPolicy: 'never',
    });

    await expect(yoloRunner.shellRun('rm -rf /')).rejects.toThrow(/dangerous command pattern detected/i);
    await expect(yoloRunner.shellRun('format C:')).rejects.toThrow(/dangerous command pattern detected/i);
  });

  it('executes safe commands and captures exit code and stdout', async () => {
    const res = await runner.shellRun('node -e "console.log(\'headless shell ok\')"');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('headless shell ok');
  });

  it('executes command inside custom relative cwd within workspace', async () => {
    await fsp.mkdir(path.join(tempDir, 'subpkg'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'subpkg', 'test.txt'), 'subpkg content', 'utf8');

    const res = await runner.shellRun('node -e "console.log(process.cwd())"', 'subpkg');
    expect(res.code).toBe(0);
    expect(path.normalize(res.stdout.trim()).toLowerCase()).toBe(path.normalize(path.join(tempDir, 'subpkg')).toLowerCase());
  });

  it('rejects custom cwd escaping workspace root', async () => {
    await expect(runner.shellRun('npm test', '../outside')).rejects.toThrow(/thoát khỏi workspace/i);
  });

  it('captures command failures with non-zero exit codes', async () => {
    const res = await runner.shellRun('node -e "process.exit(42)"');
    expect(res.code).toBe(42);
  });

  it('handles approval callback in onApprovalRequest when user rejects command', async () => {
    const askingRunner = new HeadlessToolRunner({
      workspaceRoot: tempDir,
      approvalPolicy: 'always',
      onApprovalRequest: async () => false, // User denies
    });

    await expect(askingRunner.shellRun('node -e "console.log(1)"')).rejects.toThrow(/rejected by user/i);
  });
});

describe('HeadlessToolRunner — Git Methods (gitStatus & gitDiff)', () => {
  let tempDir: string;
  let runner: HeadlessToolRunner;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'teamwork-git-'));
    runner = new HeadlessToolRunner({ workspaceRoot: tempDir });
  });

  afterEach(async () => {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort on Windows
    }
  });

  it('gitStatus handles non-git directory gracefully without throwing', async () => {
    const status = await runner.gitStatus();
    expect(status.branch).toBeNull();
    expect(status.clean).toBe(true);
    expect(status.status).toBe('');
  });

  it('gitDiff returns empty string on non-git directory', async () => {
    const diff = await runner.gitDiff();
    expect(diff).toBe('');
  });

  it('gitStatus and gitDiff operate in an initialized git repository', async () => {
    // Initialize git repository in tempDir
    const initRunner = new HeadlessToolRunner({
      workspaceRoot: tempDir,
      approvalPolicy: 'never',
    });

    await initRunner.shellRun('git init -b main');
    await initRunner.shellRun('git config user.name "Test Runner"');
    await initRunner.shellRun('git config user.email "test@example.com"');

    await fsp.writeFile(path.join(tempDir, 'repo.txt'), 'initial git file', 'utf8');

    const status1 = await initRunner.gitStatus();
    expect(status1.clean).toBe(false);
    expect(status1.status).toContain('repo.txt');

    await initRunner.shellRun('git add repo.txt');
    await initRunner.shellRun('git commit -m "initial commit"');

    const status2 = await initRunner.gitStatus();
    expect(status2.clean).toBe(true);

    // Modify file
    await fsp.writeFile(path.join(tempDir, 'repo.txt'), 'modified git file', 'utf8');
    const diff = await initRunner.gitDiff('repo.txt');
    expect(diff).toContain('+modified git file');
    expect(diff).toContain('-initial git file');
  }, 20000);
});

describe('HeadlessToolRunner — Exclusive File Ownership Lock Integration', () => {
  let tempDir: string;
  let fileLock: FileLockManager;
  let runner: HeadlessToolRunner;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'teamwork-lock-'));
    fileLock = new FileLockManager({ workspaceRoot: tempDir, concurrencyCap: 2 });
    runner = new HeadlessToolRunner({
      workspaceRoot: tempDir,
      fileLock,
    });

    await fsp.writeFile(path.join(tempDir, 'locked-by-w1.ts'), 'export const a = 1;', 'utf8');
    await fsp.writeFile(path.join(tempDir, 'unlocked.ts'), 'export const b = 2;', 'utf8');

    // Worker 1 acquires lock on locked-by-w1.ts
    fileLock.acquire('worker-1', ['locked-by-w1.ts']);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('rejects fsWrite if target file is locked by a different worker', async () => {
    const res = await runner.fsWrite('locked-by-w1.ts', 'worker-2 trying to write', 'worker-2');
    expect(res.written).toBe(false);
    expect(res.error).toContain('is exclusively locked by worker "worker-1"');

    // Disk content unchanged
    const onDisk = await fsp.readFile(path.join(tempDir, 'locked-by-w1.ts'), 'utf8');
    expect(onDisk).toBe('export const a = 1;');
  });

  it('allows fsWrite if target file is locked by the calling worker', async () => {
    const res = await runner.fsWrite('locked-by-w1.ts', 'worker-1 authorized write', 'worker-1');
    expect(res.written).toBe(true);

    const onDisk = await fsp.readFile(path.join(tempDir, 'locked-by-w1.ts'), 'utf8');
    expect(onDisk).toBe('worker-1 authorized write');
  });

  it('allows fsWrite if target file is not locked by any worker', async () => {
    const res = await runner.fsWrite('unlocked.ts', 'new content', 'worker-2');
    expect(res.written).toBe(true);

    const onDisk = await fsp.readFile(path.join(tempDir, 'unlocked.ts'), 'utf8');
    expect(onDisk).toBe('new content');
  });

  it('rejects fsEdit if target file is locked by a different worker', async () => {
    const blocks = `<<<<<<< SEARCH
export const a = 1;
=======
export const a = 999;
>>>>>>> REPLACE`;

    const res = await runner.fsEdit('locked-by-w1.ts', blocks, 'worker-2');
    expect(res.applied).toBe(false);
    expect(res.error).toContain('is exclusively locked by worker "worker-1"');

    const onDisk = await fsp.readFile(path.join(tempDir, 'locked-by-w1.ts'), 'utf8');
    expect(onDisk).toBe('export const a = 1;');
  });

  it('allows fsEdit if target file is locked by the calling worker', async () => {
    const blocks = `<<<<<<< SEARCH
export const a = 1;
=======
export const a = 999;
>>>>>>> REPLACE`;

    const res = await runner.fsEdit('locked-by-w1.ts', blocks, 'worker-1');
    expect(res.applied).toBe(true);

    const onDisk = await fsp.readFile(path.join(tempDir, 'locked-by-w1.ts'), 'utf8');
    expect(onDisk).toBe('export const a = 999;');
  });
});
