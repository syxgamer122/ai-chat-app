import { describe, it } from 'vitest';
import assert from 'node:assert';
import { escapeWindowsBatchArg, wrapWindowsBatchIfNeeded, ArgvPolicyError } from '../lib/safe-spawn';

async function runTests() {
  console.log('=== RUNNING WINDOWS BATCH ESCAPING TESTS (PHASE 4 BLIND SPOT 1) ===\n');

  // 1. Control character rejection
  console.log('--- 1. Control characters rejection (\\0, \\r, \\n) ---');
  assert.throws(() => escapeWindowsBatchArg('hello\0world'), ArgvPolicyError);
  assert.throws(() => escapeWindowsBatchArg('hello\rworld'), ArgvPolicyError);
  assert.throws(() => escapeWindowsBatchArg('hello\nworld'), ArgvPolicyError);
  console.log('✔ Correctly throws ArgvPolicyError on null bytes and newlines');

  // 2. Double percent signs for %VAR% expansion prevention
  console.log('--- 2. %VAR% environment variable expansion prevention ---');
  assert.strictEqual(escapeWindowsBatchArg('%PATH%'), '%%PATH%%');
  assert.strictEqual(escapeWindowsBatchArg('echo %USERPROFILE%'), '"echo %%USERPROFILE%%"');
  assert.strictEqual(escapeWindowsBatchArg('%COMSPEC% & calc.exe'), '"%%COMSPEC%% & calc.exe"');
  console.log('✔ Correctly doubles % signs to prevent cmd.exe variable expansion');

  // 3. Metacharacters and spaces quoting
  console.log('--- 3. Metacharacters and whitespace double-quoting ---');
  assert.strictEqual(escapeWindowsBatchArg('hello world'), '"hello world"');
  assert.strictEqual(escapeWindowsBatchArg('a\tb'), '"a\tb"');
  assert.strictEqual(escapeWindowsBatchArg('a&b'), '"a&b"');
  assert.strictEqual(escapeWindowsBatchArg('a|b'), '"a|b"');
  assert.strictEqual(escapeWindowsBatchArg('a^b'), '"a^b"');
  assert.strictEqual(escapeWindowsBatchArg('a<b'), '"a<b"');
  assert.strictEqual(escapeWindowsBatchArg('a>b'), '"a>b"');
  assert.strictEqual(escapeWindowsBatchArg('(a)'), '"(a)"');
  console.log('✔ Correctly quotes arguments with metacharacters or whitespace');

  // 4. Double quote escaping
  console.log('--- 4. Internal double quote escaping ---');
  assert.strictEqual(escapeWindowsBatchArg('param"value'), '"param""value"');
  assert.strictEqual(escapeWindowsBatchArg('"already_quoted"'), '"""already_quoted"""');
  console.log('✔ Correctly doubles internal double quotes');

  // 5. Alphanumeric simplicity
  console.log('--- 5. Simple arguments unchanged ---');
  assert.strictEqual(escapeWindowsBatchArg('build'), 'build');
  assert.strictEqual(escapeWindowsBatchArg('--filter=package-a'), '--filter=package-a');
  assert.strictEqual(escapeWindowsBatchArg('file_name.ts'), 'file_name.ts');
  console.log('✔ Preserves plain safe arguments untouched');

  // 6. wrapWindowsBatchIfNeeded on Windows
  console.log('--- 6. wrapWindowsBatchIfNeeded wrapping ---');
  const origPlatform = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const wrapped = wrapWindowsBatchIfNeeded('C:\\tools\\run.cmd', ['--arg', '%EVIL%', 'hello world']);
    assert.ok(wrapped.bin.toLowerCase().includes('cmd.exe'));
    assert.strictEqual(wrapped.args[0], '/d');
    assert.strictEqual(wrapped.args[1], '/c');
    assert.strictEqual(wrapped.args[2], 'C:\\tools\\run.cmd');
    assert.strictEqual(wrapped.args[3], '--arg');
    assert.strictEqual(wrapped.args[4], '%%EVIL%%');
    assert.strictEqual(wrapped.args[5], '"hello world"');
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform });
  }

  const normalWrapped = wrapWindowsBatchIfNeeded('C:\\tools\\node.exe', ['index.js']);
  assert.strictEqual(normalWrapped.bin, 'C:\\tools\\node.exe');
  assert.deepStrictEqual(normalWrapped.args, ['index.js']);
  console.log('✔ wrapWindowsBatchIfNeeded wraps .cmd/.bat safely and ignores binaries');

  console.log('\n======================================================');
  console.log('ALL WINDOWS BATCH ESCAPING TESTS PASSED (100%)');
  console.log('======================================================\n');
}

describe('Windows Batch Escaping & Safe Invocation', () => {
  it('runs windows batch escaping checks', async () => {
    await runTests();
  });
});
