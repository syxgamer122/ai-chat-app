import { describe, it } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import { resolveNodeCliAbsolute, wrapWindowsBatchIfNeeded } from '../lib/safe-spawn';

describe('Windows Node Direct Bypass (Phase 5 M1)', () => {
  it('resolves npm and npx via resolveNodeCliAbsolute', () => {
    const npmResolved = resolveNodeCliAbsolute('npm');
    assert.ok(npmResolved, 'npm should resolve to direct node CLI');
    assert.strictEqual(npmResolved.execPath, process.execPath);
    assert.ok(npmResolved.argsPrefix[0].endsWith(path.join('node_modules', 'npm', 'bin', 'npm-cli.js')));

    const npmCmdResolved = resolveNodeCliAbsolute('npm.cmd');
    assert.ok(npmCmdResolved, 'npm.cmd should also resolve to direct node CLI');

    const npxResolved = resolveNodeCliAbsolute('npx');
    assert.ok(npxResolved, 'npx should resolve to direct node CLI');
    assert.ok(npxResolved.argsPrefix[0].endsWith(path.join('node_modules', 'npm', 'bin', 'npx-cli.js')));

    const nonNodeResolved = resolveNodeCliAbsolute('git');
    assert.strictEqual(nonNodeResolved, null, 'git should not resolve to node CLI');
  });

  it('bypasses cmd.exe directly for node tools in wrapWindowsBatchIfNeeded', () => {
    if (process.platform === 'win32') {
      const wrappedNpm = wrapWindowsBatchIfNeeded('npm', ['install', '--save-exact']);
      assert.strictEqual(wrappedNpm.bin, process.execPath, 'bin should be process.execPath instead of cmd.exe');
      assert.ok(wrappedNpm.args[0].endsWith('npm-cli.js'));
      assert.strictEqual(wrappedNpm.args[1], 'install');
      assert.strictEqual(wrappedNpm.args[2], '--save-exact');

      // Verify complex argument with ! and quotes is preserved cleanly without cmd.exe expansion
      const complexArgs = ['run', 'build', '--msg="Hello !VAR! World"'];
      const wrappedComplex = wrapWindowsBatchIfNeeded('npm.cmd', complexArgs);
      assert.strictEqual(wrappedComplex.bin, process.execPath);
      assert.strictEqual(wrappedComplex.args[wrappedComplex.args.length - 1], '--msg="Hello !VAR! World"');
    }
  });

  it('falls back safely for non-node batch files using cmd.exe /d /c', () => {
    if (process.platform === 'win32') {
      const customBatch = wrapWindowsBatchIfNeeded('custom-tool.cmd', ['foo', 'bar & baz', '%TEMP%']);
      assert.ok(customBatch.bin.toLowerCase().endsWith('cmd.exe'));
      assert.strictEqual(customBatch.args[0], '/d');
      assert.strictEqual(customBatch.args[1], '/c');
      assert.strictEqual(customBatch.args[2], 'custom-tool.cmd');
      assert.strictEqual(customBatch.args[3], 'foo');
      assert.strictEqual(customBatch.args[4], '"bar & baz"');
      assert.strictEqual(customBatch.args[5], '%%TEMP%%');
    }
  });
});
