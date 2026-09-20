import { describe, it, expect, vi } from 'vitest';
import { isSafeCommand, shouldAutoApprove, targetsProtectedPath } from '@/lib/auto-pilot';
import { validateSafeRelativePath, isProtectedPath } from '@/lib/path-utils';
import { computeSha256, verifyDiskHash, stageFile, emptyStagingStore, serializeStaging, parseStaging } from '@/lib/staging';
import { ApprovalQueue } from '@/lib/approval-queue';

describe('P0 Security and Data-Integrity Fixes', () => {
  describe('P0.1: Disallow arbitrary code execution and command chaining in SAFE_COMMAND_PATTERNS', () => {
    it('rejects node -e and node --eval from safe command patterns', () => {
      expect(isSafeCommand('node -e "console.log(1)"')).toBe(false);
      expect(isSafeCommand('node -e "require(\'fs\').rmSync(\'file\')"')).toBe(false);
      expect(isSafeCommand('node --eval "process.exit()"')).toBe(false);
      expect(isSafeCommand('NODE -E "evil()"')).toBe(false);
    });

    it('rejects python -c from safe command patterns', () => {
      expect(isSafeCommand('python -c "import os; os.system(\'whoami\')"')).toBe(false);
      expect(isSafeCommand('python3 -c "print(1)"')).toBe(false);
      expect(isSafeCommand('PYTHON -c "exit() stand"')).toBe(false);
    });

    it('rejects command chaining, piping, redirection, and subshells in safe commands', () => {
      expect(isSafeCommand('git status && rm -rf /')).toBe(false);
      expect(isSafeCommand('node -v && node -e "evil()"')).toBe(false);
      expect(isSafeCommand('cat file | sh')).toBe(false);
      expect(isSafeCommand('git status; evil')).toBe(false);
      expect(isSafeCommand('git status\nevil')).toBe(false);
      expect(isSafeCommand('cat file > /etc/shadow')).toBe(false);
      expect(isSafeCommand('cat file < /dev/urandom')).toBe(false);
      expect(isSafeCommand('node -v -e "console.log(1)"')).toBe(false);
      expect(isSafeCommand('node -v `evil`')).toBe(false);
      expect(isSafeCommand('python3 -V $(evil)')).toBe(false);
    });

    it('still allows safe version checks strictly without extra arguments', () => {
      expect(isSafeCommand('node -v')).toBe(true);
      expect(isSafeCommand('node --version')).toBe(true);
      expect(isSafeCommand('python --version')).toBe(true);
      expect(isSafeCommand('python3 -V')).toBe(true);
      expect(isSafeCommand('python3 --version')).toBe(true);
    });
  });

  describe('P0.2: Shell cwd lockdown and validation', () => {
    it('rejects cwd path escapes (parent traversal)', () => {
      expect(validateSafeRelativePath('..').ok).toBe(false);
      expect(validateSafeRelativePath('../outside').ok).toBe(false);
      expect(validateSafeRelativePath('../../etc').ok).toBe(false);
      expect(validateSafeRelativePath('sub/../../outside').ok).toBe(false);
      expect(validateSafeRelativePath('..../trick').ok).toBe(false);
      expect(validateSafeRelativePath('.. ').ok).toBe(false);
      expect(validateSafeRelativePath('sub/.. /evil').ok).toBe(false);
    });

    it('rejects absolute paths on Windows and POSIX', () => {
      expect(validateSafeRelativePath('/etc/passwd').ok).toBe(false);
      expect(validateSafeRelativePath('/var/log').ok).toBe(false);
      expect(validateSafeRelativePath('C:\\Windows').ok).toBe(false);
      expect(validateSafeRelativePath('D:/data').ok).toBe(false);
      expect(validateSafeRelativePath('\\\\server\\share').ok).toBe(false);
      expect(validateSafeRelativePath('//network/share').ok).toBe(false);
      expect(validateSafeRelativePath('\\Windows\\System32').ok).toBe(false);
    });

    it('rejects home directory escapes (~)', () => {
      expect(validateSafeRelativePath('~').ok).toBe(false);
      expect(validateSafeRelativePath('~/ssh').ok).toBe(false);
      expect(validateSafeRelativePath('~root/secret').ok).toBe(false);
      expect(validateSafeRelativePath('~/.bashrc').ok).toBe(false);
    });

    it('rejects environment variable expansions', () => {
      expect(validateSafeRelativePath('%USERPROFILE%').ok).toBe(false);
      expect(validateSafeRelativePath('%WINDIR%\\System32').ok).toBe(false);
      expect(validateSafeRelativePath('$HOME').ok).toBe(false);
      expect(validateSafeRelativePath('${HOME}/.ssh').ok).toBe(false);
      expect(validateSafeRelativePath('sub/$VAR').ok).toBe(false);
    });

    it('rejects NUL bytes and excessively long paths', () => {
      expect(validateSafeRelativePath('sub\0dir').ok).toBe(false);
      expect(validateSafeRelativePath('a'.repeat(1025)).ok).toBe(false);
    });

    it('allows valid relative directories within workspace', () => {
      expect(validateSafeRelativePath(undefined).ok).toBe(true);
      expect(validateSafeRelativePath('').ok).toBe(true);
      expect(validateSafeRelativePath('.').ok).toBe(true);
      expect(validateSafeRelativePath('./src').ok).toBe(true);
      expect(validateSafeRelativePath('packages/core').ok).toBe(true);
      expect(validateSafeRelativePath('src/components/ui').ok).toBe(true);
    });
  });

  describe('P0.3: Protection of auto-execute and sensitive config files', () => {
    const sensitivePaths = [
      'package.json',
      './package.json',
      'packages/frontend/package.json',
      '.git/hooks/pre-commit',
      '.git/config',
      'sub/.git/HEAD',
      'sub/.git',
      '.vscode/settings.json',
      '.vscode/tasks.json',
      'nested/.vscode/launch.json',
      'nested/.vscode',
      '.env',
      '.env.local',
      '.env.production',
      'config/.env.test',
      '.vyen/rules.json',
      '.vyen/credentials.json',
      'deep/.vyen',
    ];

    it('identifies all sensitive and auto-execute paths via isProtectedPath (including nested directories)', () => {
      for (const p of sensitivePaths) {
        expect(isProtectedPath(p), `Path should be protected: ${p}`).toBe(true);
      }
    });

    it('does not falsely flag non-sensitive files', () => {
      expect(isProtectedPath('src/index.ts')).toBe(false);
      expect(isProtectedPath('README.md')).toBe(false);
      expect(isProtectedPath('components/button.tsx')).toBe(false);
      expect(isProtectedPath('docs/guide.md')).toBe(false);
    });

    it('forces shouldAutoApprove to false for sensitive files in never (Autonomous) mode', () => {
      for (const p of sensitivePaths) {
        expect(
          shouldAutoApprove({
            toolName: 'fs_write',
            args: { path: p, content: 'tampered' },
            policy: 'never',
            autoPilotEnabled: true,
          }),
          `fs_write to ${p} should require approval in never mode`,
        ).toBe(false);

        expect(
          shouldAutoApprove({
            toolName: 'fs_edit',
            args: { path: p },
            policy: 'never',
            autoPilotEnabled: true,
          }),
          `fs_edit to ${p} should require approval in never mode`,
        ).toBe(false);
      }
    });

    it('protects code_patch when modifying protected files like package.json or .env', () => {
      expect(targetsProtectedPath('code_patch', { file_path: 'package.json' })).toBe(true);
      expect(targetsProtectedPath('code_patch', { file_path: '.env' })).toBe(true);
      expect(
        shouldAutoApprove({
          toolName: 'code_patch',
          args: { file_path: 'package.json', hunks: [] },
          policy: 'never',
          autoPilotEnabled: true,
        }),
      ).toBe(false);
    });

    it('protects git_add when staging sensitive files', () => {
      expect(
        shouldAutoApprove({
          toolName: 'git_add',
          args: { paths: ['.env'] },
          policy: 'never',
          autoPilotEnabled: true,
        }),
      ).toBe(false);

      expect(targetsProtectedPath('git_add', { paths: ['src/app.ts', 'package.json'] })).toBe(true);
      expect(targetsProtectedPath('git_add', { paths: ['src/app.ts'] })).toBe(false);
    });
  });

  describe('P0.4: TOCTOU race condition prevention via SHA-256 base hashes', () => {
    it('computes sha-256 hash consistently (including empty strings)', async () => {
      const hash1 = await computeSha256('test content');
      const hash2 = await computeSha256('test content');
      const hash3 = await computeSha256('different content');
      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1).toHaveLength(64);

      // Empty string hash is a valid 64-char string (not null)
      const emptyHash = await computeSha256('');
      expect(emptyHash).toHaveLength(64);
      expect(await computeSha256(null)).toBeNull();
    });

    it('stores baseHash in staging and detects disk changes before write', async () => {
      const diskContent = 'export const API_URL = "http://localhost:3000";';
      const baseHash = await computeSha256(diskContent);

      const store = stageFile(emptyStagingStore(), 'config.ts', diskContent, 'export const API_URL = "https://prod";', baseHash);
      expect(store['config.ts'].baseHash).toBe(baseHash);

      // Verify matching disk hash
      const okCheck = await verifyDiskHash(diskContent, store['config.ts'].baseHash);
      expect(okCheck.matches).toBe(true);

      // Verify mismatch when file changes on disk concurrently
      const modifiedContent = 'export const API_URL = "http://localhost:8080";';
      const failCheck = await verifyDiskHash(modifiedContent, store['config.ts'].baseHash);
      expect(failCheck.matches).toBe(false);
    });

    it('correctly handles empty files without false TOCTOU conflicts', async () => {
      const emptyHash = await computeSha256('');
      const check = await verifyDiskHash('', emptyHash);
      expect(check.matches).toBe(true);

      const modifiedCheck = await verifyDiskHash('some new text', emptyHash);
      expect(modifiedCheck.matches).toBe(false);
    });

    it('persists baseHash through staging serialization and restoration', async () => {
      const original = 'original text';
      const hash = await computeSha256(original);
      const store = stageFile(emptyStagingStore(), 'file.txt', original, 'new text', hash);

      const serialized = serializeStaging(store);
      const restored = parseStaging(serialized);

      expect(restored['file.txt'].baseHash).toBe(hash);
    });
  });

  describe('P0.5: ApprovalQueue abortAll avoids deadlocks and resolves pending promises', () => {
    it('resolves all active and waiting promises with false upon abortAll', () => {
      const presented: unknown[] = [];
      let drained = false;

      const queue = new ApprovalQueue<string>({
        onPresent: (item) => presented.push(item),
        onDrained: () => { drained = true; },
      });

      const resolve1 = vi.fn();
      const resolve2 = vi.fn();
      const resolve3 = vi.fn();

      queue.request('dialog-1', resolve1);
      queue.request('dialog-2', resolve2);
      queue.request('dialog-3', resolve3);

      expect(queue.isBusy).toBe(true);
      expect(queue.pending).toBe(2);

      queue.abortAll(false);

      expect(resolve1).toHaveBeenCalledWith(false);
      expect(resolve2).toHaveBeenCalledWith(false);
      expect(resolve3).toHaveBeenCalledWith(false);
      expect(queue.isBusy).toBe(false);
      expect(queue.pending).toBe(0);
      expect(presented[presented.length - 1]).toBeNull();
      expect(drained).toBe(true);
    });
  });
});
