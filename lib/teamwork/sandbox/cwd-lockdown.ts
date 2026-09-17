/**
 * Working Directory (CWD) Lockdown.
 * Enforces strict workspace boundary pinning, preventing child processes or file operations from escaping root.
 */

import path from 'node:path';

export class CwdLockdownViolationError extends Error {
  public readonly workspaceRoot: string;
  public readonly attemptedPath: string;

  constructor(workspaceRoot: string, attemptedPath: string) {
    super(
      `CWD Lockdown Violation: target directory "${attemptedPath}" escapes workspaceRoot "${workspaceRoot}".`
    );
    this.name = 'CwdLockdownViolationError';
    this.workspaceRoot = workspaceRoot;
    this.attemptedPath = attemptedPath;
  }
}

export class CwdGuard {
  /**
   * Asserts that targetCwd resolves strictly within workspaceRoot.
   * Throws CwdLockdownViolationError if escaping.
   * Returns normalized absolute path within boundary.
   */
  public static assertWithinLockdown(workspaceRoot: string, targetCwd?: string): string {
    const rootAbs = path.resolve(workspaceRoot);
    const resolvedCwd = targetCwd ? path.resolve(rootAbs, targetCwd) : rootAbs;

    // Windows drive-letter / UNC paths phải bị chặn trên MỌI nền tảng:
    // trên POSIX, `path.resolve` biến chúng thành một tên thư mục hợp lệ
    // (`C:\Windows\System32`) nên dễ bỏ lọt traversal encoded. Test B8 yêu cầu
    // đúng hành vi này.
    const raw = targetCwd ?? '';
    const isWindowsAbsolute =
      /^[a-zA-Z]:[\\/]+/.test(raw) || // C:\... / C:\\... / C:/...
      /^\\\\[^\/\\]+[\\/]/.test(raw); // \\server\share\...
    if (isWindowsAbsolute) {
      throw new CwdLockdownViolationError(rootAbs, targetCwd ?? resolvedCwd);
    }

    // Normalize Windows drive letters for comparison
    const normRoot = process.platform === 'win32' ? rootAbs.toLowerCase() : rootAbs;
    const normCwd = process.platform === 'win32' ? resolvedCwd.toLowerCase() : resolvedCwd;

    const rel = path.relative(normRoot, normCwd);
    // Compare against real path separators: a plain `rel.startsWith('..')` also rejects
    // legitimate in-workspace siblings whose name begins with dots (e.g. `<root>/..foo`).
    const isEscaping = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

    if (isEscaping) {
      throw new CwdLockdownViolationError(rootAbs, targetCwd ?? resolvedCwd);
    }

    return resolvedCwd;
  }

  /**
   * Tests whether targetPath is safely within workspaceRoot without throwing.
   */
  public static isWithinLockdown(workspaceRoot: string, targetPath: string): boolean {
    try {
      this.assertWithinLockdown(workspaceRoot, targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sanitizes and normalizes a relative path within workspace root.
   */
  public static sanitizeRelativePath(workspaceRoot: string, relPath: string): string {
    const absPath = this.assertWithinLockdown(workspaceRoot, relPath);
    return path.relative(path.resolve(workspaceRoot), absPath).replace(/\\/g, '/');
  }
}
