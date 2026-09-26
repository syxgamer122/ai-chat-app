import { describe, it } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { isProtectedPath } from '../lib/path-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { compileShellCommand, PolicyError } = require('../lib/shell-policy.cjs');

async function runTests() {
  console.log('=== RUNNING GIT INDIRECT ESCALATION & SHADOW FILE TESTS (PHASE 4 BLIND SPOT 2) ===\n');

  // 1. Attached -c flags rejection
  console.log('--- 1. Attached -c flag rejection in git CLI ---');
  assert.throws(() => compileShellCommand('git -cfoo=bar status'), PolicyError);
  assert.throws(() => compileShellCommand('git -cfsmonitor=evil.exe status'), PolicyError);
  assert.throws(() => compileShellCommand('git -ccore.editor=calc status'), PolicyError);
  assert.throws(() => compileShellCommand('git -c include.path=/etc/shadow status'), PolicyError);
  assert.throws(() => compileShellCommand('git -c"user.name=attacker" status'), PolicyError);
  console.log('✔ Correctly blocks -c attached and spaced options');

  // 2. Dangerous --config options rejection
  console.log('--- 2. Dangerous --config options rejection ---');
  assert.throws(() => compileShellCommand('git --config=foo status'), PolicyError);
  assert.throws(() => compileShellCommand('git --config-env=foo status'), PolicyError);
  assert.throws(() => compileShellCommand('git --exec-path=/bin status'), PolicyError);
  assert.throws(() => compileShellCommand('git --git-dir=/tmp/git status'), PolicyError);
  assert.throws(() => compileShellCommand('git --work-tree=/tmp status'), PolicyError);
  console.log('✔ Correctly blocks dangerous --config and execution flags');

  // 3. Safe git commands allowed
  console.log('--- 3. Safe git commands allowed ---');
  const res1 = compileShellCommand('git status');
  assert.strictEqual(res1.bin, 'git');

  const res2 = compileShellCommand('git diff');
  assert.strictEqual(res2.bin, 'git');

  const res3 = compileShellCommand('git -C subfolder status');
  assert.strictEqual(res3.bin, 'git');
  assert.deepStrictEqual(res3.args, ['-C', 'subfolder', 'status']);

  const res4 = compileShellCommand('git --no-optional-locks status');
  assert.strictEqual(res4.bin, 'git');
  console.log('✔ Allows legitimate git commands including -C and safe flags');

  // 4. Shadow git configuration files protection in path-utils
  console.log('--- 4. Protection of .gitconfig* and .gitmodules in path-utils ---');
  assert.strictEqual(isProtectedPath('.gitconfig'), true);
  assert.strictEqual(isProtectedPath('.gitconfig.local'), true);
  assert.strictEqual(isProtectedPath('subdir/.gitconfig'), true);

  assert.strictEqual(isProtectedPath('.gitmodules'), true);
  assert.strictEqual(isProtectedPath('subdir/.gitmodules'), true);
  assert.strictEqual(isProtectedPath('nested/.gitmodules'), true);

  assert.strictEqual(isProtectedPath('src/main.ts'), false);
  console.log('✔ Correctly protects .gitconfig* and .gitmodules in path-utils');

  // 5. Verify fs-access.ts parity with path-utils for .gitconfig and .gitmodules
  console.log('--- 5. Verify fs-access.ts parity for .gitconfig and .gitmodules ---');
  const fsAccessSource = fs.readFileSync(path.join(__dirname, '../lib/fs-access.ts'), 'utf8');
  assert.ok(fsAccessSource.includes("basename === '.gitconfig'"), 'fs-access.ts must check .gitconfig');
  assert.ok(fsAccessSource.includes("basename.startsWith('.gitconfig')"), 'fs-access.ts must check .gitconfig*');
  assert.ok(fsAccessSource.includes("basename === '.gitmodules'"), 'fs-access.ts must check .gitmodules');
  console.log('✔ fs-access.ts contains exact matching .gitconfig and .gitmodules protection');

  console.log('\n======================================================');
  console.log('ALL GIT INDIRECT ESCALATION TESTS PASSED (100%)');
  console.log('======================================================\n');
}

describe('Git Indirect Escalation & Shadow File Protection', () => {
  it('runs git indirect escalation checks', async () => {
    await runTests();
  });
});
