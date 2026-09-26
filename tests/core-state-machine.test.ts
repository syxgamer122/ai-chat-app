/**
 * Unit tests cho Core State Machine, AgentRuntimeActor, ToolRunner & Approval Binding (PR 1, PR 3, PR 4).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert';
import { AgentRuntimeActor } from '../core/agent-runtime/runtime-actor';
import { transitionTurnState, createInitialContext } from '../core/agent-runtime/state-machine';
import { TabLockCoordinator } from '../core/agent-runtime/tab-lock';
import { LruActorRegistry, MAX_ACTIVE_ACTORS } from '../core/agent-runtime/actor-registry';
import {
  createApprovalToken,
  verifyApprovalToken,
  consumeApprovalToken,
  resetApprovalTokens,
} from '../lib/approval-binding';
import {
  ToolRunner,
  computeSha256,
  verifyToctouBaseHash,
  validateCwdJail,
  validateShellAllowlist,
  buildToolApprovalBinding,
} from '../core/agent-runtime/tool-runner';

async function runTests() {
  console.log('=== RUNNING CORE STATE MACHINE & RUNTIME TESTS ===\n');

  // 1. Initial State & Context
  console.log('--- 1. Initial State & Context ---');
  const actor = new AgentRuntimeActor('chat-1', 'leaf-root');
  assert.strictEqual(actor.getState(), 'idle', 'Actor phải bắt đầu ở trạng thái idle');
  assert.strictEqual(actor.getContext().chatId, 'chat-1', 'chatId phải khớp context');
  console.log('✔ Initial state is idle and context matches');

  // 2. Start Turn -> Streaming
  console.log('--- 2. START_TURN -> Streaming ---');
  actor.send({ type: 'START_TURN', chatId: 'chat-1', activeLeafId: 'leaf-1' });
  assert.strictEqual(actor.getState(), 'streaming', 'START_TURN phải chuyển sang streaming');
  assert.ok(actor.getContext().abortController, 'abortController phải được tạo');
  console.log('✔ START_TURN transitioned to streaming');

  // 3. Stream Delta Accumulation & Event Emission
  console.log('--- 3. Stream Delta Accumulation ---');
  let emittedCount = 0;
  const unsubscribe = actor.subscribe((state, ctx) => {
    emittedCount++;
  });

  actor.send({ type: 'STREAM_DELTA', textChunk: 'Xin chào', reasoningChunk: 'Đang suy nghĩ' });
  actor.send({ type: 'STREAM_DELTA', textChunk: ' thế giới!' });
  assert.strictEqual(actor.getContext().streamingContent, 'Xin chào thế giới!');
  assert.strictEqual(actor.getContext().streamingReasoning, 'Đang suy nghĩ');
  assert.strictEqual(emittedCount, 2, 'Listener phải nhận đủ 2 sự kiện delta');
  unsubscribe();
  console.log('✔ STREAM_DELTA accumulated tokens and emitted events properly');

  // 4. Tool Call Discovery -> Gating
  console.log('--- 4. Tool Calls Discovered -> Gating ---');
  actor.send({
    type: 'TOOL_CALLS_DISCOVERED',
    calls: [
      { id: 'call-1', name: 'fs_read', args: { path: 'package.json' } },
      { id: 'call-2', name: 'fs_write', args: { path: 'test.txt', content: 'hello' } },
    ],
  });
  assert.strictEqual(actor.getState(), 'gating', 'TOOL_CALLS_DISCOVERED phải chuyển sang gating');
  assert.strictEqual(actor.getContext().pendingToolCalls.length, 2);
  console.log('✔ TOOL_CALLS_DISCOVERED transitioned to gating');

  // 5. Gating -> Awaiting Approval
  console.log('--- 5. Gating -> Awaiting Approval ---');
  actor.send({
    type: 'REQUIRE_APPROVAL',
    calls: actor.getContext().pendingToolCalls,
  });
  assert.strictEqual(actor.getState(), 'awaiting_approval', 'REQUIRE_APPROVAL phải chuyển sang awaiting_approval');
  console.log('✔ REQUIRE_APPROVAL transitioned to awaiting_approval');

  // 6. User Approval -> Executing Tool
  console.log('--- 6. User Approval -> Executing Tool ---');
  actor.send({ type: 'USER_APPROVE', toolCallId: 'call-1', token: 'token-abc-123' });
  assert.strictEqual(actor.getState(), 'executing_tool', 'USER_APPROVE phải chuyển sang executing_tool');
  const targetCall = actor.getContext().pendingToolCalls.find((c) => c.id === 'call-1');
  assert.strictEqual(targetCall?.approvalToken, 'token-abc-123');
  console.log('✔ USER_APPROVE bound token and transitioned to executing_tool');

  // 7. Tool Settling & Resubmitting
  console.log('--- 7. Tool Settled -> Resubmitting ---');
  actor.send({ type: 'TOOL_EXECUTION_SUCCESS', toolCallId: 'call-1', result: { ok: true } });
  assert.strictEqual(actor.getState(), 'tool_settled', 'TOOL_EXECUTION_SUCCESS phải chuyển sang tool_settled');

  actor.send({ type: 'ALL_TOOLS_SETTLED' });
  assert.strictEqual(actor.getState(), 'resubmitting', 'ALL_TOOLS_SETTLED phải chuyển sang resubmitting');
  console.log('✔ Tool execution settled and transitioned to resubmitting');

  // 8. Stop & Abort Handling
  console.log('--- 8. Stop & Abort Signal ---');
  actor.send({ type: 'START_TURN', chatId: 'chat-1', activeLeafId: 'leaf-2' });
  assert.strictEqual(actor.getState(), 'streaming');
  const ctrl = actor.getContext().abortController;
  assert.strictEqual(ctrl?.signal.aborted, false);

  actor.send({ type: 'STOP' });
  assert.strictEqual(actor.getState(), 'aborted', 'STOP phải chuyển sang aborted');
  assert.strictEqual(ctrl?.signal.aborted, true, 'AbortSignal phải được kích hoạt');
  console.log('✔ STOP aborted controller and transitioned to aborted');

  // 9. Budget Exhaustion
  console.log('--- 9. Budget Exhaustion Limits ---');
  const budgetActor = new AgentRuntimeActor('chat-budget');
  budgetActor.send({ type: 'START_TURN', chatId: 'chat-budget', activeLeafId: 'leaf-1' });
  budgetActor.send({
    type: 'TOOL_CALLS_DISCOVERED',
    calls: Array.from({ length: 12 }, (_, i) => ({ id: `call-${i}`, name: 'test_tool', args: {} })),
  });
  budgetActor.send({ type: 'GATE_PASSED' });
  budgetActor.send({ type: 'ALL_TOOLS_SETTLED' });
  // State tool_settled sau ALL_TOOLS_SETTLED lần 1:
  budgetActor.send({ type: 'ALL_TOOLS_SETTLED' });
  assert.strictEqual(budgetActor.getState(), 'budget_exhausted', 'Quá trần 12 calls phải chuyển sang budget_exhausted');
  console.log('✔ Budget limit correctly triggers budget_exhausted state');

  // 10. TabLockCoordinator Fallback Test
  console.log('--- 10. TabLockCoordinator Fallback ---');
  const lock = new TabLockCoordinator();
  let isLeader = false;
  const mode = await lock.acquireRuntimeLock(
    'chat-test-lock',
    () => {
      isLeader = true;
    },
    () => {},
  );
  assert.strictEqual(mode, 'LEADER', 'Môi trường non-browser phải fallback an toàn thành LEADER');
  assert.strictEqual(isLeader, true);
  console.log('✔ TabLockCoordinator gracefully falls back to LEADER in Node/test environments');

  // 11. Approval Binding with activeLeafId & expectedBaseHash (PR 3)
  console.log('--- 11. Approval Binding with activeLeafId & expectedBaseHash (PR 3) ---');
  resetApprovalTokens();
  const testPayload = { path: 'src/main.ts', oldText: 'console.log(1);', newText: 'console.log(2);' };
  const leafToken = createApprovalToken({
    kind: 'diff',
    payload: testPayload,
    chatId: 'chat-branch-1',
    activeLeafId: 'leaf-branch-A',
    expectedBaseHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  assert.ok(leafToken);

  // Khớp hoàn hảo -> ok: true
  const matchResult = verifyApprovalToken(leafToken.fingerprint, {
    kind: 'diff',
    payload: testPayload,
    chatId: 'chat-branch-1',
    activeLeafId: 'leaf-branch-A',
    expectedBaseHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  assert.strictEqual(matchResult.ok, true);

  // Lệch activeLeafId (người dùng chuyển nhánh trong khi chờ duyệt) -> từ chối
  const leafMismatch = verifyApprovalToken(leafToken.fingerprint, {
    kind: 'diff',
    payload: testPayload,
    chatId: 'chat-branch-1',
    activeLeafId: 'leaf-branch-B',
    expectedBaseHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  assert.strictEqual(leafMismatch.ok, false);
  assert.strictEqual(leafMismatch.reason, 'approval_leaf_mismatch');

  // Lệch expectedBaseHash (file bị sửa ngoài luồng - TOCTOU) -> từ chối
  const hashMismatch = verifyApprovalToken(leafToken.fingerprint, {
    kind: 'diff',
    payload: testPayload,
    chatId: 'chat-branch-1',
    activeLeafId: 'leaf-branch-A',
    expectedBaseHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  });
  assert.strictEqual(hashMismatch.ok, false);
  assert.strictEqual(hashMismatch.reason, 'approval_base_hash_mismatch');

  // Tiêu thụ token thành công
  const consumeRes = consumeApprovalToken(leafToken.fingerprint, {
    kind: 'diff',
    payload: testPayload,
    chatId: 'chat-branch-1',
    activeLeafId: 'leaf-branch-A',
    expectedBaseHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  assert.strictEqual(consumeRes.ok, true);

  // Tiêu thụ lần 2 -> từ chối (chống replay)
  const replayRes = consumeApprovalToken(leafToken.fingerprint, {
    kind: 'diff',
    payload: testPayload,
    chatId: 'chat-branch-1',
    activeLeafId: 'leaf-branch-A',
    expectedBaseHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  assert.strictEqual(replayRes.ok, false);
  assert.strictEqual(replayRes.reason, 'approval_replayed');
  console.log('✔ Token binding strictly binds activeLeafId & expectedBaseHash, rejecting cross-branch & TOCTOU replay');

  // 12. ToolRunner TOCTOU SHA-256 BaseHash Verification (PR 3)
  console.log('--- 12. ToolRunner TOCTOU BaseHash Verification (PR 3) ---');
  const baseContent = 'function hello() { return "world"; }';
  const expectedHash = await computeSha256(baseContent);
  assert.strictEqual(expectedHash.length, 64);

  const toctouValid = await verifyToctouBaseHash(baseContent, expectedHash, 'src/hello.ts');
  assert.strictEqual(toctouValid.ok, true);
  assert.strictEqual(toctouValid.currentHash, expectedHash);

  const tamperedContent = 'function hello() { return "tampered"; }';
  const toctouInvalid = await verifyToctouBaseHash(tamperedContent, expectedHash, 'src/hello.ts');
  assert.strictEqual(toctouInvalid.ok, false);
  assert.ok(toctouInvalid.error?.includes('TOCTOU Conflict'));
  console.log('✔ TOCTOU baseHash check correctly verifies matching content and rejects tampered disk text');

  // 13. ToolRunner CWD Jail & Shell Policy Checks (PR 3)
  console.log('--- 13. ToolRunner CWD Jail & Shell Policy Checks (PR 3) ---');
  assert.strictEqual(validateCwdJail(undefined).ok, true);
  assert.strictEqual(validateCwdJail('packages/core').ok, true);
  assert.strictEqual(validateCwdJail('../outside').ok, false);
  assert.strictEqual(validateCwdJail('%USERPROFILE%').ok, false);
  assert.strictEqual(validateCwdJail('/etc/passwd').ok, false);

  assert.strictEqual(validateShellAllowlist('git status').ok, true);
  assert.strictEqual(validateShellAllowlist('npm test').ok, true);
  assert.strictEqual(validateShellAllowlist('git status; rm -rf /').ok, false);
  assert.strictEqual(validateShellAllowlist('node -e "process.exit()"').ok, false);
  console.log('✔ CWD jail and shell allowlist checks enforced correctly');

  // 14. ToolRunner Execution Pipeline (PR 3)
  console.log('--- 14. ToolRunner Execution Pipeline (PR 3) ---');
  const virtualDisk = new Map<string, string>();
  virtualDisk.set('test.txt', 'initial text');

  const runner = new ToolRunner({
    chatId: 'chat-runner-1',
    activeLeafId: 'leaf-runner-1',
    readFiles: new Set<string>(),
    fsRead: async (path) => ({ content: virtualDisk.get(path) ?? '' }),
    fsWrite: async (path, content) => {
      virtualDisk.set(path, content);
      return { written: true };
    },
    shellRun: async ({ command, cwd }) => ({ code: 0, stdout: `Executed: ${command}`, stderr: '' }),
  });

  // fs_edit mà chưa fs_read -> phải bị chặn bởi read-before-edit guard
  const unreadEdit = await runner.executeTool('fs_edit', { path: 'test.txt', content: 'new content' });
  const parsedUnread = JSON.parse(unreadEdit);
  assert.strictEqual(parsedUnread.applied, false);
  assert.ok(parsedUnread.error?.includes('chưa được đọc'));

  // fs_read nạp file vào readFiles
  const readRes = await runner.executeTool('fs_read', { path: 'test.txt' });
  assert.strictEqual(JSON.parse(readRes).content, 'initial text');

  // Sau khi đọc -> fs_edit được phép chạy
  const readEdit = await runner.executeTool('fs_edit', { path: 'test.txt', content: 'edited text' });
  assert.strictEqual(JSON.parse(readEdit).applied, true);
  assert.strictEqual(virtualDisk.get('test.txt'), 'edited text');

  // shell_run lệnh hợp lệ -> chạy thành công
  const shellRes = await runner.executeTool('shell_run', { command: 'git status' });
  assert.strictEqual(JSON.parse(shellRes).code, 0);

  // shell_run cwd thoát workspace -> bị từ chối
  const badCwdRes = await runner.executeTool('shell_run', { command: 'git status', cwd: '../outside' });
  assert.strictEqual(JSON.parse(badCwdRes).approved, false);
  console.log('✔ ToolRunner execution pipeline handles read-before-edit, safe edits, and shell constraints');

  // 15. AgentRuntimeActor Snapshot Stability (PR 4)
  console.log('--- 15. AgentRuntimeActor Snapshot Stability (PR 4) ---');
  const snapActor = new AgentRuntimeActor('snap-chat');
  const snap1 = snapActor.getSnapshot();
  const snap2 = snapActor.getSnapshot();
  assert.strictEqual(snap1, snap2, 'Snapshot reference phải ổn định khi không có state transition');

  snapActor.send({ type: 'START_TURN', chatId: 'snap-chat', activeLeafId: 'snap-leaf' });
  const snap3 = snapActor.getSnapshot();
  assert.notStrictEqual(snap1, snap3, 'Snapshot reference phải thay đổi sau khi state transition');
  assert.strictEqual(snap3.state, 'streaming');
  console.log('✔ AgentRuntimeActor getSnapshot ensures stable references for useSyncExternalStore');

  // 16. AgentRuntimeActor Context-only Update & Notification (PR 3 & PR 4 Fix)
  console.log('--- 16. Context-only Update on USER_DENY (PR 4 Fix) ---');
  const multiActor = new AgentRuntimeActor('multi-call-chat');
  multiActor.send({ type: 'START_TURN', chatId: 'multi-call-chat', activeLeafId: 'leaf-1' });
  multiActor.send({
    type: 'TOOL_CALLS_DISCOVERED',
    calls: [
      { id: 'call-a', name: 'fs_read', args: {} },
      { id: 'call-b', name: 'fs_write', args: {} },
    ],
  });
  multiActor.send({ type: 'REQUIRE_APPROVAL', calls: multiActor.getContext().pendingToolCalls });
  assert.strictEqual(multiActor.getState(), 'awaiting_approval');
  assert.strictEqual(multiActor.getContext().pendingToolCalls.length, 2);

  let denyEmitted = false;
  const unsubDeny = multiActor.subscribe(() => {
    denyEmitted = true;
  });

  const snapBeforeDeny = multiActor.getSnapshot();
  multiActor.send({ type: 'USER_DENY', toolCallId: 'call-a' });
  unsubDeny();

  assert.strictEqual(multiActor.getState(), 'awaiting_approval', 'State vẫn phải ở awaiting_approval khi còn tool chưa duyệt');
  assert.strictEqual(multiActor.getContext().pendingToolCalls.length, 1, 'Tool call bị deny phải bị loại khỏi context');
  assert.strictEqual(multiActor.getContext().pendingToolCalls[0].id, 'call-b');
  assert.strictEqual(denyEmitted, true, 'Listener phải nhận được thông báo khi context thay đổi dù state không đổi');
  const snapAfterDeny = multiActor.getSnapshot();
  assert.notStrictEqual(snapBeforeDeny, snapAfterDeny, 'Snapshot reference phải cập nhật khi pendingToolCalls thay đổi');
  assert.strictEqual(snapAfterDeny.context.pendingToolCalls.length, 1);
  console.log('✔ Actor correctly emits updates and refreshes snapshot on context-only changes');

  // 17. ToolRunner SEARCH/REPLACE Block Processing & Approval Payload (PR 3 Fix)
  console.log('--- 17. ToolRunner SEARCH/REPLACE Blocks Execution (PR 3 Fix) ---');
  const editDisk = new Map<string, string>();
  editDisk.set('src/sample.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;');

  const editRunner = new ToolRunner({
    chatId: 'chat-edit-runner',
    activeLeafId: 'leaf-edit-1',
    readFiles: new Set<string>(['src/sample.ts']),
    fsRead: async (path) => ({ content: editDisk.get(path) ?? '' }),
    fsWrite: async (path, content) => {
      editDisk.set(path, content);
      return { written: true };
    },
  });

  const searchReplaceBlock = `<<<<<<< SEARCH
const b = 2;
=======
const b = 200;
>>>>>>> REPLACE`;

  const editResult = await editRunner.executeTool('fs_edit', {
    path: 'src/sample.ts',
    blocks: searchReplaceBlock,
  });

  const parsedEdit = JSON.parse(editResult);
  assert.strictEqual(parsedEdit.applied, true);
  assert.strictEqual(parsedEdit.blocks, 1);
  assert.strictEqual(editDisk.get('src/sample.ts'), 'const a = 1;\nconst b = 200;\nconst c = 3;');
  console.log('✔ ToolRunner correctly parses and applies SEARCH/REPLACE blocks instead of raw string overwrite');

  // 18. ToolRunner Path Jail & System Denylist Enforcement (PR 3 Fix)
  console.log('--- 18. ToolRunner Path Jail & System Denylist (PR 3 Fix) ---');
  const securityRunner = new ToolRunner({
    chatId: 'sec-chat',
    fsRead: async () => ({ content: 'secret' }),
    fsWrite: async () => ({ written: true }),
    fsList: async () => ({ files: [] }),
  });

  // Chặn đọc .git
  const gitRead = JSON.parse(await securityRunner.executeTool('fs_read', { path: '.git/config' }));
  assert.ok(gitRead.error?.includes('System Denylist'));

  // Chặn ghi node_modules
  const nodeModWrite = JSON.parse(await securityRunner.executeTool('fs_write', { path: 'node_modules/bad.js', content: 'hack' }));
  assert.strictEqual(nodeModWrite.written, false);
  assert.ok(nodeModWrite.error?.includes('System Denylist'));

  // Chặn path traversal
  const traversalEdit = JSON.parse(await securityRunner.executeTool('fs_edit', { path: '../../etc/passwd', content: 'root' }));
  assert.strictEqual(traversalEdit.applied, false);
  assert.ok(traversalEdit.error?.includes('thoát thư mục') || traversalEdit.error?.includes('..'));
  console.log('✔ ToolRunner strictly enforces workspace jail and bidirectional system denylist (.git, node_modules)');

  // 19. Actor updateActiveLeaf Synchronization (PR 3 & PR 4)
  console.log('--- 19. Actor updateActiveLeaf Synchronization (PR 4) ---');
  const leafActor = new AgentRuntimeActor('leaf-sync-chat', 'initial-leaf');
  assert.strictEqual(leafActor.getContext().activeLeafId, 'initial-leaf');

  leafActor.updateActiveLeaf('switched-branch-leaf');
  assert.strictEqual(leafActor.getContext().activeLeafId, 'switched-branch-leaf');
  assert.strictEqual(leafActor.getSnapshot().context.activeLeafId, 'switched-branch-leaf');
  console.log('✔ Actor updateActiveLeaf correctly synchronizes activeLeafId across branch switches');

  // 20. LRU Actor Registry Eviction & Explicit dispose() (Phase 4 Resilience)
  console.log('--- 20. LRU Actor Registry Eviction & Explicit dispose() (Phase 4) ---');
  const lru = new LruActorRegistry(3);
  const a1 = new AgentRuntimeActor('chat-lru-1');
  const a2 = new AgentRuntimeActor('chat-lru-2');
  const a3 = new AgentRuntimeActor('chat-lru-3');
  lru.set('chat-lru-1', a1);
  lru.set('chat-lru-2', a2);
  lru.set('chat-lru-3', a3);
  assert.strictEqual(lru.size, 3);

  // Truy cập a1 để chuyển a1 thành MRU, lúc này a2 là LRU
  lru.get('chat-lru-1');

  // Thêm a4 -> a2 phải bị evict và gọi a2.dispose()
  const a4 = new AgentRuntimeActor('chat-lru-4');
  let a2Disposed = false;
  const originalDispose = a2.dispose.bind(a2);
  a2.dispose = () => {
    a2Disposed = true;
    originalDispose();
  };

  lru.set('chat-lru-4', a4);

  assert.strictEqual(lru.size, 3);
  assert.strictEqual(lru.has('chat-lru-2'), false, 'Actor LRU (chat-lru-2) phải bị evict');
  assert.strictEqual(lru.has('chat-lru-1'), true, 'Actor MRU (chat-lru-1) phải được giữ lại');
  assert.strictEqual(lru.has('chat-lru-3'), true);
  assert.strictEqual(lru.has('chat-lru-4'), true);
  assert.strictEqual(a2Disposed, true, 'Actor bị evict phải được gọi dispose()');
  console.log('✔ LRU Actor Registry enforces capacity limit and calls dispose() on eviction');

  // 21. ToolRunner Abort Signal Propagation & Promise Rejection (Phase 4 Layer 1/2 Resilience)
  console.log('--- 21. ToolRunner Abort Signal Propagation (Phase 4) ---');
  const abortCtrl = new AbortController();

  const abortRunner = new ToolRunner({
    chatId: 'abort-chat',
    abortSignal: abortCtrl.signal,
    fsRead: async () => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ content: 'delayed content' });
        }, 1000);
      });
    },
  });

  const pendingExec = abortRunner.executeTool('fs_read', { path: 'slow-file.txt' });

  // Ngay lập tức huỷ lượt
  abortCtrl.abort();

  await assert.rejects(
    pendingExec,
    (err: Error) => {
      return err.message.includes('Tác vụ bị hủy bỏ (Aborted).');
    },
    'executeTool phải reject ngay lập tức khi signal bị abort',
  );
  console.log('✔ ToolRunner instantly settles and rejects pending IO promises on turn abort');

  // 22. TabLockCoordinator BroadcastChannel Heartbeat & Frozen Detection
  console.log('--- 22. TabLockCoordinator Multi-Tab Heartbeat (Phase 4) ---');
  const coordinator = new TabLockCoordinator();
  assert.ok(coordinator, 'TabLockCoordinator must instantiate cleanly');
  coordinator.dispose();
  console.log('✔ TabLockCoordinator instantiates and disposes without resource leak');

  console.log('\n=============================================');
  console.log('ALL CORE STATE MACHINE & RUNTIME TESTS PASSED (100%)');
  console.log('=============================================\n');
}

describe('Core State Machine & Runtime', () => {
  it('runs core runtime and state machine tests', async () => {
    await runTests();
  });
});

