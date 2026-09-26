import { describe, it } from 'vitest';
import assert from 'node:assert';
import { SqliteStorageEngine } from '../core/storage/sqlite-driver';

console.log('=== RUNNING SQLITE WASM & RECURSIVE CTE TESTS (PHASE 5 M3) ===\n');

const engine = new SqliteStorageEngine();

// 1. Recursive CTE Traversal
console.log('--- 1. Recursive CTE Message Tree Traversal ---');
async function testCte() {
  // Setup branch: Root (msg-1) -> msg-2 -> msg-3 (Leaf)
  await engine.saveMessage({
    id: 'msg-1',
    chatId: 'chat-tree-1',
    parentId: '__ROOT__',
    role: 'user',
    content: 'Root prompt',
    createdAt: 1000,
  });

  await engine.saveMessage({
    id: 'msg-2',
    chatId: 'chat-tree-1',
    parentId: 'msg-1',
    role: 'assistant',
    content: 'First response',
    createdAt: 2000,
  });

  await engine.saveMessage({
    id: 'msg-3',
    chatId: 'chat-tree-1',
    parentId: 'msg-2',
    role: 'user',
    content: 'Follow-up question (Leaf)',
    createdAt: 3000,
  });

  // Query path from Leaf to Root
  const thread = await engine.getActiveThread('msg-3');
  assert.strictEqual(thread.length, 3);
  assert.strictEqual(thread[0].id, 'msg-1', 'First item in thread must be Root');
  assert.strictEqual(thread[1].id, 'msg-2', 'Second item must be child of Root');
  assert.strictEqual(thread[2].id, 'msg-3', 'Last item must be the Leaf');
  console.log('✔ Recursive CTE retrieves full thread from root to leaf in chronological order');
}

// 2. FTS5 Search with Vietnamese diacritics removal
console.log('--- 2. FTS5 Vietnamese Search ---');
async function testFts() {
  await engine.saveMessage({
    id: 'msg-vn-1',
    chatId: 'chat-vn',
    parentId: '__ROOT__',
    role: 'user',
    content: 'Thiết kế hệ thống bóc tách God Component và máy trạng thái',
    createdAt: 4000,
  });

  // Search without diacritics
  const results = await engine.searchFts('thiet ke he thong');
  assert.ok(results.length > 0);
  assert.strictEqual(results[0].id, 'msg-vn-1');

  const resultsPartial = await engine.searchFts('boc tach');
  assert.ok(resultsPartial.length > 0);
  assert.strictEqual(resultsPartial[0].id, 'msg-vn-1');
  console.log('✔ FTS5 search correctly finds content matching unaccented Vietnamese queries');
}

// 3. Dexie to SQLite Migration
console.log('--- 3. Dexie to SQLite Migration ---');
async function testMigration() {
  const dexieLegacy = [
    { id: 'dexie-1', chatId: 'c1', parentId: '__ROOT__', role: 'user', content: 'Legacy 1' },
    { id: 'dexie-2', chatId: 'c1', parentId: 'dexie-1', role: 'assistant', content: 'Legacy 2' },
  ];

  const migratedCount = await engine.migrateDexieToSqlite(dexieLegacy);
  assert.strictEqual(migratedCount, 2);

  const thread = await engine.getActiveThread('dexie-2');
  assert.strictEqual(thread.length, 2);
  assert.strictEqual(thread[0].id, 'dexie-1');
  assert.strictEqual(thread[1].id, 'dexie-2');
  console.log('✔ migrateDexieToSqlite correctly imports and structures legacy message history');
}

async function run() {
  await testCte();
  await testFts();
  await testMigration();
  console.log('\n======================================================');
  console.log('ALL SQLITE WASM & RECURSIVE CTE TESTS PASSED (100%)');
  console.log('======================================================\n');
}

describe('SQLite WASM & Recursive CTE', () => {
  it('runs sqlite wasm & recursive cte tests', async () => {
    await run();
  });
});
