import { describe, it } from 'vitest';
import assert from 'node:assert';
import { StorageFencing, FencingConflictError } from '../core/agent-runtime/fencing';

console.log('=== RUNNING STORAGE FENCING & SPLIT-BRAIN TESTS (PHASE 5 M1) ===\n');

StorageFencing.reset();

// 1. Initial State
console.log('--- 1. Initial State ---');
assert.strictEqual(StorageFencing.getLocalEpoch('chat-1'), 0);
console.log('✔ Initial local epoch is 0');

// 2. bumpEpoch
console.log('--- 2. bumpEpoch increments epoch ---');
async function testBump() {
  const epoch1 = await StorageFencing.bumpEpoch('chat-1');
  assert.ok(epoch1 > 0);
  assert.strictEqual(StorageFencing.getLocalEpoch('chat-1'), epoch1);

  // Assert leader is valid for its own epoch
  await StorageFencing.assertValidLeader('chat-1');
  console.log('✔ bumpEpoch sets local and storage epoch, assertValidLeader passes');
}

// 3. Split-Brain Simulation (Resurrected Zombie Leader)
console.log('--- 3. Split-brain detection when another tab steals lock ---');
async function testSplitBrain() {
  const chatId = 'chat-race-1';
  // Tab A acquires lock
  const tabAEpoch = await StorageFencing.bumpEpoch(chatId);
  assert.strictEqual(StorageFencing.getLocalEpoch(chatId), tabAEpoch);

  // Tab B steals lock later in time -> increments epoch in storage
  await new Promise((r) => setTimeout(r, 10));
  const tabBEpoch = Date.now() + 100;
  // Simulate Tab B writing new epoch to storage
  (StorageFencing as any).storageEpochs.set(chatId, tabBEpoch);

  // Now Tab A wakes up and attempts to write with its stale epoch
  try {
    await StorageFencing.assertValidLeader(chatId);
    assert.fail('Expected FencingConflictError but none was thrown');
  } catch (err) {
    assert.ok(err instanceof FencingConflictError);
    assert.strictEqual(err.chatId, chatId);
    assert.strictEqual(err.currentEpoch, tabAEpoch);
    assert.strictEqual(err.storageEpoch, tabBEpoch);
    console.log('✔ FencingConflictError successfully thrown on stale tab write');
  }
}

// 4. Reset
console.log('--- 4. Reset ---');
async function testReset() {
  await StorageFencing.bumpEpoch('chat-to-reset');
  StorageFencing.reset('chat-to-reset');
  assert.strictEqual(StorageFencing.getLocalEpoch('chat-to-reset'), 0);
  console.log('✔ Reset clears epoch for specified chat');
}

async function run() {
  await testBump();
  await testSplitBrain();
  await testReset();
  console.log('\n======================================================');
  console.log('ALL STORAGE FENCING TESTS PASSED (100%)');
  console.log('======================================================\n');
}

describe('Storage Fencing & Split-Brain Prevention', () => {
  it('runs storage fencing tests', async () => {
    await run();
  });
});
