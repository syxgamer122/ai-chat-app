import { describe, expect, it } from 'vitest';
import { FileLockManager, normalizeLockPath } from '../lib/teamwork/file-lock';

describe('normalizeLockPath', () => {
  it('normalizes standard posix paths', () => {
    expect(normalizeLockPath('lib/teamwork/types.ts')).toBe('lib/teamwork/types.ts');
  });

  it('normalizes windows backslashes to forward slashes', () => {
    expect(normalizeLockPath('lib\\teamwork\\types.ts')).toBe('lib/teamwork/types.ts');
    expect(normalizeLockPath('src\\components\\ui\\button.tsx')).toBe('src/components/ui/button.tsx');
  });

  it('strips redundant leading ./ and / and trailing slashes', () => {
    expect(normalizeLockPath('./lib/teamwork/types.ts')).toBe('lib/teamwork/types.ts');
    expect(normalizeLockPath('.\\lib\\teamwork\\types.ts')).toBe('lib/teamwork/types.ts');
    expect(normalizeLockPath('/lib/teamwork/types.ts/')).toBe('lib/teamwork/types.ts');
    expect(normalizeLockPath('///lib///teamwork///types.ts///')).toBe('lib/teamwork/types.ts');
  });

  it('resolves relative segments like . and .. safely', () => {
    expect(normalizeLockPath('lib/foo/../teamwork/types.ts')).toBe('lib/teamwork/types.ts');
    expect(normalizeLockPath('lib/./teamwork/./types.ts')).toBe('lib/teamwork/types.ts');
  });

  it('normalizes case for cross-platform and NTFS collision safety', () => {
    expect(normalizeLockPath('Lib/Teamwork/Types.TS')).toBe('lib/teamwork/types.ts');
    expect(normalizeLockPath('C:\\Project\\Lib\\A.ts', 'C:/Project')).toBe('lib/a.ts');
  });

  it('strips workspaceRoot prefix when provided', () => {
    const root = 'C:/Users/huumanh/Downloads/ai-chat-app';
    expect(normalizeLockPath('C:/Users/huumanh/Downloads/ai-chat-app/lib/teamwork/types.ts', root)).toBe(
      'lib/teamwork/types.ts'
    );
    expect(normalizeLockPath('C:\\Users\\huumanh\\Downloads\\ai-chat-app\\lib\\teamwork\\types.ts', root)).toBe(
      'lib/teamwork/types.ts'
    );
  });

  it('handles empty and whitespace inputs gracefully', () => {
    expect(normalizeLockPath('')).toBe('');
    expect(normalizeLockPath('   ')).toBe('');
  });
});

describe('FileLockManager — Exclusive File Ownership', () => {
  it('successfully acquires locks on free files', () => {
    const lockMgr = new FileLockManager();
    const files = ['lib/a.ts', 'lib/b.ts'];

    expect(lockMgr.canAcquire('worker-1', files)).toBe(true);
    lockMgr.acquire('worker-1', files);

    expect(lockMgr.isLocked('lib/a.ts')).toBe(true);
    expect(lockMgr.isLocked('lib/b.ts')).toBe(true);
    expect(lockMgr.isLocked('lib/c.ts')).toBe(false);

    expect(lockMgr.getLockOwner('lib/a.ts')).toBe('worker-1');
    expect(lockMgr.getLockOwner('lib/b.ts')).toBe('worker-1');
    expect(lockMgr.getLockOwner('lib/c.ts')).toBeUndefined();
  });

  it('detects conflicts across different path representations', () => {
    const lockMgr = new FileLockManager();
    lockMgr.acquire('worker-1', ['lib/teamwork/types.ts']);

    // Same file with backslashes
    expect(lockMgr.isLocked('lib\\teamwork\\types.ts')).toBe(true);
    expect(lockMgr.canAcquire('worker-2', ['lib\\teamwork\\types.ts'])).toBe(false);

    // Same file with case variation
    expect(lockMgr.isLocked('LIB/TEAMWORK/TYPES.TS')).toBe(true);
    expect(lockMgr.canAcquire('worker-2', ['LIB/TEAMWORK/TYPES.TS'])).toBe(false);

    // Same file with ./ prefix
    expect(lockMgr.canAcquire('worker-2', ['./lib/teamwork/types.ts'])).toBe(false);

    // Attempting to acquire throws conflict error
    expect(() => {
      lockMgr.acquire('worker-2', ['lib\\teamwork\\types.ts']);
    }).toThrow(/File lock conflict/);
  });

  it('enforces atomic acquisition — rolls back/aborts if any file is locked', () => {
    const lockMgr = new FileLockManager();
    lockMgr.acquire('worker-1', ['lib/shared.ts']);

    // worker-2 tries to acquire free file1.ts AND locked shared.ts
    expect(lockMgr.canAcquire('worker-2', ['lib/file1.ts', 'lib/shared.ts'])).toBe(false);

    expect(() => {
      lockMgr.acquire('worker-2', ['lib/file1.ts', 'lib/shared.ts']);
    }).toThrow(/File lock conflict/);

    // file1.ts must NOT have been locked by worker-2
    expect(lockMgr.isLocked('lib/file1.ts')).toBe(false);
    expect(lockMgr.getLockOwner('lib/file1.ts')).toBeUndefined();
    expect(lockMgr.getActiveWorkers()).not.toContain('worker-2');
  });

  it('allows same worker to re-acquire or expand its own file locks', () => {
    const lockMgr = new FileLockManager();
    lockMgr.acquire('worker-1', ['lib/a.ts']);

    // Re-acquiring same file by same worker is allowed (idempotent)
    expect(lockMgr.canAcquire('worker-1', ['lib/a.ts'])).toBe(true);
    expect(() => lockMgr.acquire('worker-1', ['lib/a.ts', 'lib/b.ts'])).not.toThrow();

    expect(lockMgr.isLocked('lib/a.ts')).toBe(true);
    expect(lockMgr.isLocked('lib/b.ts')).toBe(true);
    expect(lockMgr.getActiveWorkers()).toEqual(['worker-1']);
  });

  it('handles duplicate file representations within the same acquire call', () => {
    const lockMgr = new FileLockManager();
    expect(() => {
      lockMgr.acquire('worker-1', ['lib/a.ts', 'lib\\a.ts', './lib/a.ts', 'LIB/A.TS']);
    }).not.toThrow();

    expect(lockMgr.getActiveLocks().size).toBe(1);
    expect(lockMgr.getLockOwner('lib/a.ts')).toBe('worker-1');
  });
});

describe('FileLockManager — Concurrency Ceiling (Max 2 Parallel Workers)', () => {
  it('allows 2 disjoint workers to run concurrently', () => {
    const lockMgr = new FileLockManager(2);

    expect(lockMgr.canAcquire('worker-1', ['lib/a.ts'])).toBe(true);
    lockMgr.acquire('worker-1', ['lib/a.ts']);

    expect(lockMgr.canAcquire('worker-2', ['lib/b.ts'])).toBe(true);
    lockMgr.acquire('worker-2', ['lib/b.ts']);

    expect(lockMgr.getActiveWorkers().sort()).toEqual(['worker-1', 'worker-2']);
    expect(lockMgr.getActiveLocks().size).toBe(2);
  });

  it('strictly blocks a 3rd worker when concurrency cap of 2 is reached', () => {
    const lockMgr = new FileLockManager(2);
    lockMgr.acquire('worker-1', ['lib/a.ts']);
    lockMgr.acquire('worker-2', ['lib/b.ts']);

    // worker-3 touches completely disjoint lib/c.ts, but cap is reached!
    expect(lockMgr.canAcquire('worker-3', ['lib/c.ts'])).toBe(false);
    expect(() => {
      lockMgr.acquire('worker-3', ['lib/c.ts']);
    }).toThrow(/Concurrency limit reached/);

    // Existing active workers are unaffected
    expect(lockMgr.getActiveWorkers().sort()).toEqual(['worker-1', 'worker-2']);
    expect(lockMgr.isLocked('lib/c.ts')).toBe(false);
  });

  it('allows an already active worker to acquire more files even when concurrency cap is reached', () => {
    const lockMgr = new FileLockManager(2);
    lockMgr.acquire('worker-1', ['lib/a.ts']);
    lockMgr.acquire('worker-2', ['lib/b.ts']);

    // worker-1 is already 1 of the 2 active workers, acquiring another free file does not increase active workers
    expect(lockMgr.canAcquire('worker-1', ['lib/extra.ts'])).toBe(true);
    expect(() => lockMgr.acquire('worker-1', ['lib/extra.ts'])).not.toThrow();

    expect(lockMgr.getActiveWorkers().length).toBe(2);
    expect(lockMgr.getLockOwner('lib/extra.ts')).toBe('worker-1');
  });

  it('allows 3rd worker to acquire as soon as one worker releases', () => {
    const lockMgr = new FileLockManager(2);
    lockMgr.acquire('worker-1', ['lib/a.ts']);
    lockMgr.acquire('worker-2', ['lib/b.ts']);

    // worker-1 releases
    lockMgr.release('worker-1');
    expect(lockMgr.getActiveWorkers()).toEqual(['worker-2']);
    expect(lockMgr.isLocked('lib/a.ts')).toBe(false);

    // worker-3 can now acquire
    expect(lockMgr.canAcquire('worker-3', ['lib/c.ts'])).toBe(true);
    lockMgr.acquire('worker-3', ['lib/c.ts']);
    expect(lockMgr.getActiveWorkers().sort()).toEqual(['worker-2', 'worker-3']);
  });
});

describe('FileLockManager — Release and Query APIs', () => {
  it('releases all files for a worker on release()', () => {
    const lockMgr = new FileLockManager();
    lockMgr.acquire('worker-1', ['lib/a.ts', 'lib/b.ts']);
    expect(lockMgr.getActiveLocks().size).toBe(2);

    lockMgr.release('worker-1');
    expect(lockMgr.getActiveLocks().size).toBe(0);
    expect(lockMgr.getActiveWorkers().length).toBe(0);
    expect(lockMgr.isLocked('lib/a.ts')).toBe(false);
    expect(lockMgr.isLocked('lib/b.ts')).toBe(false);
  });

  it('releases individual files via releaseFile()', () => {
    const lockMgr = new FileLockManager();
    lockMgr.acquire('worker-1', ['lib/a.ts', 'lib/b.ts']);

    expect(lockMgr.releaseFile('worker-1', 'lib/a.ts')).toBe(true);
    expect(lockMgr.isLocked('lib/a.ts')).toBe(false);
    expect(lockMgr.isLocked('lib/b.ts')).toBe(true);
    expect(lockMgr.getActiveWorkers()).toEqual(['worker-1']);

    // Another worker can now acquire lib/a.ts
    expect(lockMgr.canAcquire('worker-2', ['lib/a.ts'])).toBe(true);
    lockMgr.acquire('worker-2', ['lib/a.ts']);
    expect(lockMgr.getLockOwner('lib/a.ts')).toBe('worker-2');

    // Releasing b unregisters worker-1
    expect(lockMgr.releaseFile('worker-1', 'lib/b.ts')).toBe(true);
    expect(lockMgr.getActiveWorkers()).toEqual(['worker-2']);
  });

  it('rejects releaseFile() if called by wrong worker or non-existent file', () => {
    const lockMgr = new FileLockManager();
    lockMgr.acquire('worker-1', ['lib/a.ts']);

    expect(lockMgr.releaseFile('worker-2', 'lib/a.ts')).toBe(false);
    expect(lockMgr.releaseFile('worker-1', 'lib/nonexistent.ts')).toBe(false);
    expect(lockMgr.isLocked('lib/a.ts')).toBe(true);
  });

  it('provides getDetailedLocks() with timestamp and original path', () => {
    const lockMgr = new FileLockManager();
    lockMgr.acquire('worker-1', ['lib\\MyPath.ts']);

    const detailed = lockMgr.getDetailedLocks();
    const entry = detailed.get('lib/mypath.ts');
    expect(entry).toBeDefined();
    expect(entry?.filePath).toBe('lib\\MyPath.ts');
    expect(entry?.normalizedPath).toBe('lib/mypath.ts');
    expect(entry?.workerId).toBe('worker-1');
    expect(entry?.acquiredAt).toBeGreaterThan(0);
  });

  it('clears all state cleanly via clear()', () => {
    const lockMgr = new FileLockManager();
    lockMgr.acquire('worker-1', ['lib/a.ts']);
    lockMgr.acquire('worker-2', ['lib/b.ts']);

    lockMgr.clear();
    expect(lockMgr.getActiveWorkers()).toEqual([]);
    expect(lockMgr.getActiveLocks().size).toBe(0);
  });
});

describe('FileLockManager — Disjointness & Parallel Execution Verification', () => {
  it('correctly validates disjoint file sets', () => {
    const lockMgr = new FileLockManager();

    expect(lockMgr.canRunInParallel(['lib/a.ts', 'lib/b.ts'], ['lib/c.ts', 'lib/d.ts'])).toBe(true);
    expect(lockMgr.canRunInParallel(['lib/a.ts', 'lib/b.ts'], ['lib/b.ts', 'lib/c.ts'])).toBe(false);
    expect(lockMgr.canRunInParallel(['lib/a.ts'], ['lib\\a.ts'])).toBe(false);
    expect(lockMgr.canRunInParallel(['./lib/a.ts'], ['lib/a.ts'])).toBe(false);
  });

  it('verifies multi-set disjointness via verifyDisjoint()', () => {
    const lockMgr = new FileLockManager();

    expect(
      lockMgr.verifyDisjoint([
        ['lib/a.ts'],
        ['lib/b.ts'],
        ['lib/c.ts'],
      ])
    ).toBe(true);

    expect(
      lockMgr.verifyDisjoint([
        ['lib/a.ts', 'lib/b.ts'],
        ['lib/c.ts'],
        ['lib/b.ts'], // collision with first set
      ])
    ).toBe(false);
  });
});

