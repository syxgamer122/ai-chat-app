import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppendOnlyLedger,
  BitemporalAlgebra,
  GENESIS_PREV_HASH,
  PointInTimeReplayEngine,
} from '../lib/teamwork/ledger';
import {
  KnowledgeOntology,
  TemporalContextManager,
} from '../lib/teamwork/context';
import type {
  BitemporalRecord,
  LedgerEventType,
} from '../lib/teamwork/ledger/types';
import type {
  ArchitecturalDecision,
  MilestoneIndexItem,
  SemanticTriple,
} from '../lib/teamwork/context/types';

describe('Bitemporal Algebra (Tv vs Tt)', () => {
  const baseTime = 1000000;

  it('determines record activity across valid time and transaction time intervals', () => {
    const record: BitemporalRecord<string> = {
      id: 'rec-1',
      sequence: 1,
      validFrom: baseTime,
      validTo: baseTime + 500,
      txFrom: baseTime + 100,
      txTo: baseTime + 600,
      eventType: 'milestone_init',
      action: 'INSERT',
      milestoneId: 'M1',
      workerId: 'worker-1',
      payload: 'initial payload',
      prevHash: GENESIS_PREV_HASH,
      recordHash: 'hash-1',
      merkleHash: 'hash-1',
    };

    // Before valid time
    expect(BitemporalAlgebra.isActiveAt(record, baseTime - 1, baseTime + 200)).toBe(false);
    // At validFrom and active txTime
    expect(BitemporalAlgebra.isActiveAt(record, baseTime, baseTime + 200)).toBe(true);
    // Inside valid range [1000000, 1000500) and inside tx range [1000100, 1000600)
    expect(BitemporalAlgebra.isActiveAt(record, baseTime + 250, baseTime + 300)).toBe(true);
    // At validTo (half-open, should be false)
    expect(BitemporalAlgebra.isActiveAt(record, baseTime + 500, baseTime + 300)).toBe(false);
    // Inside valid range but before txFrom
    expect(BitemporalAlgebra.isActiveAt(record, baseTime + 200, baseTime + 50)).toBe(false);
    // Inside valid range but at or after txTo
    expect(BitemporalAlgebra.isActiveAt(record, baseTime + 200, baseTime + 600)).toBe(false);
  });

  it('handles infinite intervals (validTo = null and txTo = null)', () => {
    const record: BitemporalRecord<{ state: string }> = {
      id: 'rec-inf',
      sequence: 2,
      validFrom: baseTime,
      validTo: null,
      txFrom: baseTime + 50,
      txTo: null,
      eventType: 'entity_state',
      action: 'INSERT',
      milestoneId: 'M1',
      workerId: 'worker-1',
      payload: { state: 'eternal' },
      prevHash: 'prev',
      recordHash: 'curr',
      merkleHash: 'curr',
    };

    expect(BitemporalAlgebra.isActiveAt(record, baseTime + 999999, baseTime + 999999)).toBe(true);
    expect(BitemporalAlgebra.isActiveAt(record, baseTime - 10, baseTime + 100)).toBe(false);
  });

  it('supports structured validTime and transactionTime sub-objects', () => {
    const record: BitemporalRecord = {
      id: 'rec-structured',
      sequence: 3,
      validFrom: 0,
      validTo: 0,
      validTime: { from: baseTime, to: baseTime + 300 },
      txFrom: 0,
      txTo: 0,
      transactionTime: { recordedAt: baseTime + 10, supersededAt: baseTime + 400 },
      eventType: 'file_snapshot',
      action: 'INSERT',
      milestoneId: 'M1',
      workerId: 'worker-1',
      payload: {},
      prevHash: 'prev',
      recordHash: 'curr',
      merkleHash: 'curr',
    };

    expect(BitemporalAlgebra.isActiveAt(record, baseTime + 100, baseTime + 200)).toBe(true);
    expect(BitemporalAlgebra.isActiveAt(record, baseTime + 300, baseTime + 200)).toBe(false);
  });

  it('object cấu trúc là NGUỒN CHÂN LÝ — to thiếu nghĩa là mở, không fallback sang field cũ', () => {
    // Trước đây `{ validTime: { from } }` vẫn fallback `to` sang validTo cũ,
    // trộn hai mô hình thời gian và tạo khoảng bị đảo (from > to) nên bản
    // ghi không bao giờ active.
    const record: BitemporalRecord = {
      id: 'rec-open-valid',
      sequence: 4,
      validFrom: 0,
      validTo: 500, // field cũ — PHẢI bị bỏ qua khi validTime có mặt
      validTime: { from: 1000 }, // to thiếu → mở vô hạn
      txFrom: 0,
      txTo: 900, // field cũ — phải bị bỏ qua khi transactionTime có mặt
      transactionTime: { recordedAt: 10 }, // supersededAt thiếu → còn hiệu lực
      eventType: 'entity_state',
      action: 'INSERT',
      milestoneId: 'M1',
      workerId: 'worker-1',
      payload: {},
      prevHash: 'prev',
      recordHash: 'curr',
      merkleHash: 'curr',
    };

    // valid mở từ 1000: trước đó inactive, sau đó active mãi (tx cũng mở).
    expect(BitemporalAlgebra.isActiveAt(record, 999, 2000)).toBe(false);
    expect(BitemporalAlgebra.isActiveAt(record, 1000, 2000)).toBe(true);
    expect(BitemporalAlgebra.isActiveAt(record, 5000, 2000)).toBe(true);

    // getValidRange/getTxRange trực tiếp: KHÔNG dùng validTo/txTo cũ.
    expect(BitemporalAlgebra.getValidRange(record)).toEqual({ from: 1000, to: null });
    expect(BitemporalAlgebra.getTxRange(record)).toEqual({ from: 10, to: null });
  });

  it('KHÔNG có object cấu trúc → giữ hành vi field cũ (validFrom/validTo)', () => {
    const record: BitemporalRecord = {
      id: 'rec-legacy',
      sequence: 5,
      validFrom: 100,
      validTo: 200,
      txFrom: 50,
      txTo: null,
      eventType: 'entity_state',
      action: 'INSERT',
      milestoneId: 'M1',
      workerId: 'worker-1',
      payload: {},
      prevHash: 'prev',
      recordHash: 'curr',
      merkleHash: 'curr',
    };
    expect(BitemporalAlgebra.getValidRange(record)).toEqual({ from: 100, to: 200 });
    expect(BitemporalAlgebra.getTxRange(record)).toEqual({ from: 50, to: null });
    expect(BitemporalAlgebra.isActiveAt(record, 150, 60)).toBe(true);
    expect(BitemporalAlgebra.isActiveAt(record, 200, 60)).toBe(false);
  });

  it('detects interval overlaps accurately', () => {
    // [100, 200) and [150, 250) overlap
    expect(BitemporalAlgebra.isIntervalOverlapping(100, 200, 150, 250)).toBe(true);
    // [100, 200) and [200, 300) do NOT overlap (half-open)
    expect(BitemporalAlgebra.isIntervalOverlapping(100, 200, 200, 300)).toBe(false);
    // [100, 200) and [50, 90) do NOT overlap
    expect(BitemporalAlgebra.isIntervalOverlapping(100, 200, 50, 90)).toBe(false);
    // [100, null) and [500, 600) overlap
    expect(BitemporalAlgebra.isIntervalOverlapping(100, null, 500, 600)).toBe(true);
  });

  it('sorts records chronologically by validFrom, txFrom, and sequence', () => {
    const records: BitemporalRecord[] = [
      {
        id: 'r3',
        sequence: 3,
        validFrom: 200,
        validTo: null,
        txFrom: 50,
        txTo: null,
        eventType: 'entity_state',
        action: 'INSERT',
        milestoneId: 'M1',
        workerId: 'w',
        payload: null,
        prevHash: '',
        recordHash: '',
        merkleHash: '',
      },
      {
        id: 'r1',
        sequence: 1,
        validFrom: 100,
        validTo: null,
        txFrom: 10,
        txTo: null,
        eventType: 'entity_state',
        action: 'INSERT',
        milestoneId: 'M1',
        workerId: 'w',
        payload: null,
        prevHash: '',
        recordHash: '',
        merkleHash: '',
      },
      {
        id: 'r2',
        sequence: 2,
        validFrom: 100,
        validTo: null,
        txFrom: 20,
        txTo: null,
        eventType: 'entity_state',
        action: 'UPDATE',
        milestoneId: 'M1',
        workerId: 'w',
        payload: null,
        prevHash: '',
        recordHash: '',
        merkleHash: '',
      },
    ];

    const sorted = BitemporalAlgebra.sortChronologically(records);
    expect(sorted.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('Append-Only Bitemporal Ledger (Audit Trail & Merkle Chains)', () => {
  let tempDir: string;
  let ledger: AppendOnlyLedger;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamwork-ledger-test-'));
    ledger = new AppendOnlyLedger(tempDir);
    await ledger.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('initializes cleanly and starts with sequence 0 and genesis hash', () => {
    expect(ledger.count()).toBe(0);
    expect(ledger.getLatestRecord()).toBeUndefined();
    const verification = ledger.verifyIntegrity();
    expect(verification.valid).toBe(true);
    expect(verification.chainLength).toBe(0);
    expect(verification.tipHash).toBe(GENESIS_PREV_HASH);
  });

  it('appends records with strictly monotonic sequences and Merkle hash chaining', async () => {
    const r1 = await ledger.appendRecord({
      entityId: 'config',
      eventType: 'milestone_init',
      action: 'INSERT',
      milestoneId: 'M1',
      workerId: 'worker-1',
      payload: { mode: 'strict', version: 1 },
      validFrom: 1000,
    });

    expect(r1.sequence).toBe(1);
    expect(r1.prevHash).toBe(GENESIS_PREV_HASH);
    expect(r1.recordHash.length).toBe(64);
    expect(r1.merkleHash).toBe(r1.recordHash);
    expect(r1.txTo).toBeNull();

    const r2 = await ledger.appendRecord({
      entityId: 'config',
      eventType: 'entity_state',
      action: 'UPDATE',
      milestoneId: 'M1',
      workerId: 'worker-1',
      payload: { mode: 'strict', version: 2 },
      validFrom: 2000,
    });

    expect(r2.sequence).toBe(2);
    expect(r2.prevHash).toBe(r1.recordHash);
    expect(r2.recordHash.length).toBe(64);

    const r3 = await ledger.appendRecord({
      entityId: 'file:lib/types.ts',
      eventType: 'file_snapshot',
      action: 'INSERT',
      milestoneId: 'M1',
      workerId: 'worker-2',
      payload: { content: 'export interface Foo {}' },
      validFrom: 3000,
    });

    expect(r3.sequence).toBe(3);
    expect(r3.prevHash).toBe(r2.recordHash);

    // Verify hash chain
    const verify = ledger.verifyIntegrity();
    expect(verify.valid).toBe(true);
    expect(verify.chainLength).toBe(3);
    expect(verify.errors).toEqual([]);
    expect(verify.tipHash).toBe(r3.recordHash);

    // Verify written to JSONL disk file
    const fileContent = await fs.readFile(ledger.getLedgerPath(), 'utf8');
    const lines = fileContent.trim().split('\n');
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]).id).toBe(r1.id);
    expect(JSON.parse(lines[1]).id).toBe(r2.id);
    expect(JSON.parse(lines[2]).id).toBe(r3.id);
  });

  it('re-initializes from disk and restores state and hash continuity', async () => {
    await ledger.appendRecord({
      eventType: 'milestone_init',
      milestoneId: 'M1',
      workerId: 'worker-1',
      payload: { title: 'First' },
    });
    await ledger.appendRecord({
      eventType: 'critic_verdict',
      milestoneId: 'M1',
      workerId: 'critic',
      payload: { verdict: 'PASS' },
    });

    // Create a new ledger instance pointing to the same directory
    const reloaded = new AppendOnlyLedger(tempDir);
    await reloaded.initialize();

    expect(reloaded.count()).toBe(2);
    const verify = reloaded.verifyIntegrity();
    expect(verify.valid).toBe(true);
    expect(verify.chainLength).toBe(2);

    // Next append continues sequence 3 and continues hash chain
    const r3 = await reloaded.appendRecord({
      eventType: 'milestone_init',
      milestoneId: 'M2',
      workerId: 'worker-2',
      payload: { title: 'Second' },
    });

    expect(r3.sequence).toBe(3);
    expect(reloaded.verifyIntegrity().valid).toBe(true);
  });

  it('detects tampering when a record payload or hash is modified on disk', async () => {
    await ledger.appendRecord({
      eventType: 'milestone_init',
      milestoneId: 'M1',
      workerId: 'worker-1',
      payload: { auth: 'safe' },
    });
    await ledger.appendRecord({
      eventType: 'entity_state',
      milestoneId: 'M1',
      workerId: 'worker-1',
      payload: { balance: 100 },
    });

    // Tamper with the ledger file: mutate balance to 999999 without updating hash
    const filePath = ledger.getLedgerPath();
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n');
    const rec2 = JSON.parse(lines[1]);
    rec2.payload.balance = 999999;
    lines[1] = JSON.stringify(rec2);
    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8');

    // Reload ledger
    const tamperedLedger = new AppendOnlyLedger(tempDir);
    await tamperedLedger.initialize();
    const audit = tamperedLedger.verifyIntegrity();

    expect(audit.valid).toBe(false);
    expect(audit.errors.length).toBeGreaterThan(0);
    expect(audit.errors.some((e) => e.includes('Record hash mismatch'))).toBe(true);
  });

  it('supports superseding an existing record without destructive modification', async () => {
    const original = await ledger.appendRecord({
      entityId: 'architecture',
      eventType: 'architectural_decision',
      action: 'INSERT',
      milestoneId: 'M1',
      workerId: 'worker-1',
      payload: { database: 'SQLite' },
      validFrom: 1000,
    });

    expect(original.txTo).toBeNull();

    const { superseded, replacement } = await ledger.supersedeRecord(original.id, {
      eventType: 'architectural_decision',
      action: 'UPDATE',
      milestoneId: 'M2',
      workerId: 'worker-2',
      payload: { database: 'PostgreSQL' },
      validFrom: 2000,
    });

    expect(replacement.sequence).toBe(2);
    expect(replacement.parentRecordId).toBe(original.id);
    expect(superseded.txTo).toBe(replacement.txFrom);
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });

  it('performs non-destructive compensating rollback via inverse records', async () => {
    const r1 = await ledger.appendRecord({
      entityId: 'feature_flag',
      eventType: 'entity_state',
      action: 'INSERT',
      milestoneId: 'M1',
      workerId: 'worker-1',
      payload: { enableExperimental: true },
      validFrom: 1000,
    });

    const rollback = await ledger.compensate({
      targetRecordId: r1.id,
      workerId: 'critic',
      reason: 'Feature caused performance regression',
      inversePayload: { enableExperimental: false, rolledBack: true },
    });

    expect(rollback.eventType).toBe('revert');
    expect(rollback.action).toBe('COMPENSATE');
    expect(rollback.parentRecordId).toBe(r1.id);
    expect((rollback.payload as any).enableExperimental).toBe(false);

    // Original record remains in ledger
    const queryOriginal = ledger.query({ entityId: 'feature_flag', action: 'INSERT' });
    expect(queryOriginal.length).toBe(1);
    expect(queryOriginal[0].id).toBe(r1.id);

    // Ledger integrity is maintained
    expect(ledger.verifyIntegrity().valid).toBe(true);
  });

  /* Regression: khoảng transaction time là half-open [from, to) và bị đóng bằng
     chính `txFrom` của bản ghi kế tiếp (supersede/compensate). Khi `txFrom` chỉ
     là `Date.now()`, hai lần ghi trong CÙNG một mili-giây tạo khoảng rỗng [T, T)
     — bản ghi không còn active ở bất kỳ Tt nào nên replay trả null (đây là
     nguyên nhân test e2e ledger ĐỎ ngẫu nhiên tuỳ timing máy chạy). */
  it('txFrom tăng đơn điệu: ghi trong cùng 1ms vẫn replay được điểm giữa', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    try {
      const m1 = await ledger.appendRecord({
        entityId: 'app.config',
        eventType: 'entity_state',
        action: 'INSERT',
        milestoneId: 'M1',
        workerId: 'worker-1',
        payload: { port: 3000, authStrategy: 'jwt' },
        validFrom: 1000,
      });
      const m2 = await ledger.appendRecord({
        entityId: 'app.config',
        eventType: 'entity_state',
        action: 'UPDATE',
        milestoneId: 'M2',
        workerId: 'worker-2',
        parentRecordId: m1.id,
        payload: { port: 8080, authStrategy: 'none' },
        validFrom: 2000,
      });
      const comp = await ledger.compensate({
        targetRecordId: m2.id,
        milestoneId: 'M3',
        author: 'security_auditor',
        reason: 'Revert unauthenticated authStrategy',
      });

      // Cùng mili-giây nhưng tx PHẢI đơn điệu tăng ⇒ khoảng Tt không bao giờ rỗng.
      expect(m1.txFrom).toBeLessThan(m2.txFrom);
      expect(m2.txFrom).toBeLessThan(comp.txFrom);
      expect(m2.txTo).toBe(comp.txFrom);
      expect(m2.txTo as number).toBeGreaterThan(m2.txFrom);

      const replayer = new PointInTimeReplayEngine(ledger.getAllRecords());
      const before = replayer.replayEntityState('app.config', { validTime: 1500, txTime: m1.txFrom });
      expect((before?.state as any)?.authStrategy).toBe('jwt');
      const during = replayer.replayEntityState('app.config', { validTime: 2500, txTime: m2.txFrom });
      expect((during?.state as any)?.authStrategy).toBe('none');
      expect(ledger.verifyIntegrity().valid).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /* Regression: đồng hồ hệ thống nhảy LÙI (NTP step / clock smear khi máy tải
     nặng). Trước đây `replayEntityState()` không truyền toạ độ sẽ lấy
     `Date.now()`; nếu lúc replay `Date.now()` tụt xuống dưới `validFrom` của
     bản ghi COMPENSATE (ghi bằng Date.now() lúc append) thì bản ghi đó bị
     `queryAsOf` loại → replay trả lại CHÍNH state vừa bị rollback (test
     adversarial đỏ ngẫu nhiên ~1/5 lần). Mốc mặc định nay lấy từ ledger
     (max txFrom) nên hoàn toàn không phụ thuộc đồng hồ tường. */
  it('đồng hồ nhảy lùi vẫn replay đúng state sau COMPENSATE (mốc mặc định từ ledger)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_700_000_000_000);
      const r1 = await ledger.appendRecord({
        entityId: 'service.config',
        eventType: 'entity_state',
        action: 'INSERT',
        milestoneId: 'M1',
        workerId: 'worker-1',
        payload: { maxConns: 50 },
      });
      vi.setSystemTime(1_700_000_001_000);
      const r2 = await ledger.appendRecord({
        entityId: 'service.config',
        eventType: 'entity_state',
        action: 'UPDATE',
        milestoneId: 'M2',
        workerId: 'worker-2',
        parentRecordId: r1.id,
        payload: { maxConns: 500 },
      });
      const comp = await ledger.compensate({
        targetRecordId: r2.id,
        workerId: 'critic-lead',
        reason: 'Rollback cấu hình nguy hiểm',
        inversePayload: { restoredState: { maxConns: 50 } },
      });

      // Đồng hồ nhảy lùi 1 giờ so với thời điểm ghi.
      vi.setSystemTime(1_700_000_000_000 - 3_600_000);

      const replayer = new PointInTimeReplayEngine(ledger);
      const state = replayer.replayEntityState<any>('service.config');
      expect(state?.state).toEqual({ maxConns: 50 });
      expect(state?.active).toBe(true);
      expect(state?.history.map((h) => h.action)).toEqual(['COMPENSATE']);
      expect(comp.action).toBe('COMPENSATE');
      expect(ledger.verifyIntegrity().valid).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters records by milestoneId, eventType, and action', async () => {
    await ledger.appendRecord({
      eventType: 'milestone_init',
      milestoneId: 'M1',
      workerId: 'w1',
      payload: 'M1 start',
    });
    await ledger.appendRecord({
      eventType: 'file_patch',
      milestoneId: 'M1',
      workerId: 'w1',
      payload: 'patch 1',
    });
    await ledger.appendRecord({
      eventType: 'milestone_init',
      milestoneId: 'M2',
      workerId: 'w2',
      payload: 'M2 start',
    });

    const m1Records = ledger.query({ milestoneId: 'M1' });
    expect(m1Records.length).toBe(2);

    const initRecords = ledger.query({ eventType: 'milestone_init' });
    expect(initRecords.length).toBe(2);

    const limited = ledger.query({ limit: 1 });
    expect(limited.length).toBe(1);
    expect(limited[0].milestoneId).toBe('M2');
  });

  it('maintains consistency under concurrent append operations', async () => {
    const promises = Array.from({ length: 15 }, (_, i) =>
      ledger.appendRecord({
        eventType: 'entity_state',
        milestoneId: `M-${i % 3}`,
        workerId: `worker-${i % 2}`,
        payload: { itemIndex: i },
      })
    );

    const results = await Promise.all(promises);
    expect(results.length).toBe(15);
    expect(ledger.count()).toBe(15);

    // Sequences are strictly 1 through 15
    const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));

    // Hash chain is unbroken
    const verify = ledger.verifyIntegrity();
    expect(verify.valid).toBe(true);
    expect(verify.chainLength).toBe(15);
  });
});

describe('Point-in-Time State Replay Engine', () => {
  it('reconstructs entity states across time steps (Tv and Tt)', () => {
    const records: BitemporalRecord[] = [
      {
        id: 'r1',
        sequence: 1,
        entityId: 'service_config',
        validFrom: 1000,
        validTo: null,
        txFrom: 1000,
        txTo: 2500, // Superseded at tx 2500
        eventType: 'entity_state',
        action: 'INSERT',
        milestoneId: 'M1',
        workerId: 'w1',
        payload: { port: 3000, workers: 2 },
        prevHash: '',
        recordHash: 'h1',
        merkleHash: 'h1',
      },
      {
        id: 'r2',
        sequence: 2,
        entityId: 'service_config',
        validFrom: 2000,
        validTo: null,
        txFrom: 2000,
        txTo: null,
        eventType: 'entity_state',
        action: 'UPDATE',
        milestoneId: 'M2',
        workerId: 'w2',
        payload: { port: 3000, workers: 4 },
        prevHash: 'h1',
        recordHash: 'h2',
        merkleHash: 'h2',
      },
      {
        id: 'r3',
        sequence: 3,
        entityId: 'service_config',
        validFrom: 1000,
        validTo: null,
        txFrom: 2500, // Retrospective correction of r1 recorded at 2500
        txTo: null,
        eventType: 'entity_state',
        action: 'UPDATE',
        milestoneId: 'M3',
        workerId: 'w3',
        payload: { port: 3001, workers: 2 },
        prevHash: 'h2',
        recordHash: 'h3',
        merkleHash: 'h3',
      },
    ];

    const replayEngine = new PointInTimeReplayEngine(records);

    // As of ValidTime 1500, TransactionTime 1500: see original r1 { port: 3000, workers: 2 }
    const stateAt1500 = replayEngine.replayEntityValue<any>('service_config', {
      validTime: 1500,
      txTime: 1500,
    });
    expect(stateAt1500).toEqual({ port: 3000, workers: 2 });

    // As of ValidTime 1500, TransactionTime 3000: retrospective correction took effect -> { port: 3001, workers: 2 }
    const stateAt1500NewTx = replayEngine.replayEntityValue<any>('service_config', {
      validTime: 1500,
      txTime: 3000,
    });
    expect(stateAt1500NewTx).toEqual({ port: 3001, workers: 2 });

    // As of ValidTime 2500, TransactionTime 3000: M2 update is active -> { port: 3000, workers: 4 }
    const stateAt2500 = replayEngine.replayEntityValue<any>('service_config', {
      validTime: 2500,
      txTime: 3000,
    });
    expect(stateAt2500).toEqual({ port: 3000, workers: 4 });
  });

  it('handles DELETE action and sets entity state to null/inactive', () => {
    const records: BitemporalRecord[] = [
      {
        id: 'r1',
        sequence: 1,
        entityId: 'temp_token',
        validFrom: 100,
        validTo: null,
        txFrom: 100,
        txTo: null,
        eventType: 'entity_state',
        action: 'INSERT',
        milestoneId: 'M1',
        workerId: 'w1',
        payload: { token: 'secret-123' },
        prevHash: '',
        recordHash: 'h1',
        merkleHash: 'h1',
      },
      {
        id: 'r2',
        sequence: 2,
        entityId: 'temp_token',
        validFrom: 200,
        validTo: null,
        txFrom: 200,
        txTo: null,
        eventType: 'entity_state',
        action: 'DELETE',
        milestoneId: 'M1',
        workerId: 'w1',
        payload: null,
        prevHash: 'h1',
        recordHash: 'h2',
        merkleHash: 'h2',
      },
    ];

    const replayEngine = new PointInTimeReplayEngine(records);

    const activeBefore = replayEngine.replayEntityState('temp_token', { validTime: 150 });
    expect(activeBefore?.active).toBe(true);
    expect(activeBefore?.state).toEqual({ token: 'secret-123' });

    const activeAfter = replayEngine.replayEntityState('temp_token', { validTime: 250 });
    expect(activeAfter?.active).toBe(false);
    expect(activeAfter?.state).toBeNull();
  });

  it('reconstructs virtual file tree across multiple snapshots and patches', () => {
    const records: BitemporalRecord[] = [
      {
        id: 'f1',
        sequence: 1,
        entityId: 'lib/app.ts',
        validFrom: 100,
        validTo: null,
        txFrom: 100,
        txTo: null,
        eventType: 'file_snapshot',
        action: 'INSERT',
        milestoneId: 'M1',
        workerId: 'w1',
        payload: { filePath: 'lib/app.ts', content: 'console.log("v1");' },
        prevHash: '',
        recordHash: 'h1',
        merkleHash: 'h1',
      },
      {
        id: 'f2',
        sequence: 2,
        entityId: 'lib/util.ts',
        validFrom: 150,
        validTo: null,
        txFrom: 150,
        txTo: null,
        eventType: 'file_snapshot',
        action: 'INSERT',
        milestoneId: 'M1',
        workerId: 'w1',
        payload: { filePath: 'lib/util.ts', content: 'export const x = 1;' },
        prevHash: 'h1',
        recordHash: 'h2',
        merkleHash: 'h2',
      },
      {
        id: 'f3',
        sequence: 3,
        entityId: 'lib/app.ts',
        validFrom: 200,
        validTo: null,
        txFrom: 200,
        txTo: null,
        eventType: 'file_patch',
        action: 'UPDATE',
        milestoneId: 'M2',
        workerId: 'w2',
        payload: { filePath: 'lib/app.ts', content: 'console.log("v2");' },
        prevHash: 'h2',
        recordHash: 'h3',
        merkleHash: 'h3',
      },
      {
        id: 'f4',
        sequence: 4,
        entityId: 'lib/util.ts',
        validFrom: 250,
        validTo: null,
        txFrom: 250,
        txTo: null,
        eventType: 'revert',
        action: 'DELETE',
        milestoneId: 'M2',
        workerId: 'w2',
        payload: { filePath: 'lib/util.ts' },
        prevHash: 'h3',
        recordHash: 'h4',
        merkleHash: 'h4',
      },
    ];

    const replayEngine = new PointInTimeReplayEngine(records);

    // At validTime 120: only lib/app.ts v1 exists
    const tree120 = replayEngine.replayFileTree({ validTime: 120 });
    expect(tree120.size).toBe(1);
    expect(tree120.get('lib/app.ts')).toBe('console.log("v1");');

    // At validTime 180: both lib/app.ts v1 and lib/util.ts exist
    const tree180 = replayEngine.replayFileTree({ validTime: 180 });
    expect(tree180.size).toBe(2);
    expect(tree180.get('lib/app.ts')).toBe('console.log("v1");');
    expect(tree180.get('lib/util.ts')).toBe('export const x = 1;');

    // At validTime 220: lib/app.ts is updated to v2, lib/util.ts still exists
    const tree220 = replayEngine.replayFileTree({ validTime: 220 });
    expect(tree220.get('lib/app.ts')).toBe('console.log("v2");');
    expect(tree220.get('lib/util.ts')).toBe('export const x = 1;');

    // At validTime 300: lib/util.ts is deleted, lib/app.ts v2 remains
    const tree300 = replayEngine.replayFileTree({ validTime: 300 });
    expect(tree300.size).toBe(1);
    expect(tree300.has('lib/util.ts')).toBe(false);
    expect(tree300.get('lib/app.ts')).toBe('console.log("v2");');
  });

  it('generates entity audit timeline accurately', () => {
    const records: BitemporalRecord[] = [
      {
        id: 'r1',
        sequence: 1,
        entityId: 'task-1',
        validFrom: 100,
        validTo: null,
        txFrom: 105,
        txTo: null,
        eventType: 'entity_state',
        action: 'INSERT',
        milestoneId: 'M1',
        workerId: 'w1',
        payload: { status: 'pending' },
        prevHash: '',
        recordHash: 'h1',
        merkleHash: 'h1',
      },
      {
        id: 'r2',
        sequence: 2,
        entityId: 'task-1',
        validFrom: 200,
        validTo: null,
        txFrom: 205,
        txTo: null,
        eventType: 'entity_state',
        action: 'UPDATE',
        milestoneId: 'M1',
        workerId: 'w1',
        payload: { status: 'completed' },
        prevHash: 'h1',
        recordHash: 'h2',
        merkleHash: 'h2',
      },
    ];

    const replayEngine = new PointInTimeReplayEngine(records);
    const timeline = replayEngine.getEntityTimeline('task-1');

    expect(timeline.length).toBe(2);
    expect(timeline[0].sequence).toBe(1);
    expect(timeline[0].validTime).toBe(100);
    expect((timeline[0].payload as any).status).toBe('pending');
    expect(timeline[1].sequence).toBe(2);
    expect((timeline[1].payload as any).status).toBe('completed');
  });
});

describe('3-Tier Progressive Context Memory (TemporalContextManager)', () => {
  let contextManager: TemporalContextManager;

  beforeEach(() => {
    contextManager = new TemporalContextManager();
  });

  it('renders Tier 1 Index within ~100 tokens budget', () => {
    contextManager.recordMilestone({
      id: 'M1',
      title: 'DAG Task Dependencies',
      status: 'COMPLETED',
      worker: 'worker-1',
      filesTouched: ['lib/dag.ts', 'lib/types.ts'],
      criticVerdict: 'PASS',
    });
    contextManager.recordMilestone({
      id: 'M2',
      title: 'HITL Approvals',
      status: 'RUNNING',
      worker: 'worker-2',
      filesTouched: ['lib/hitl.ts'],
    });

    const summary = contextManager.renderContext({ tier: 1 });
    expect(summary.activeTier).toBe(1);
    expect(summary.tier1Index).toContain('### Milestone Index');
    expect(summary.tier1Index).toContain('M1');
    expect(summary.tier1Index).toContain('M2');
    expect(summary.tier1Index).toContain('PASS');
    expect(summary.tier2Decisions).toBe('');
    expect(summary.tier3Diffs).toBeUndefined();
    expect(summary.totalEstimatedTokens).toBeLessThan(120);
  });

  it('renders Tier 2 Decisions and Constraints within ~400 tokens budget', () => {
    contextManager.recordMilestone({
      id: 'M1',
      title: 'Foundation',
      status: 'COMPLETED',
      filesTouched: ['lib/core.ts'],
    });

    contextManager.recordDecision({
      id: 'DEC-01',
      milestoneId: 'M1',
      title: 'Decouple Tv and Tt',
      rationale: 'Allows retrospective audit without destroying historical reality',
      constraints: ['Append-only storage required', 'SHA256 hash chaining required'],
      rejectedAlternatives: ['Overwriting records in-place', 'Single-timestamp git commits'],
      interfaceChanges: ['BitemporalRecord includes validFrom and txFrom'],
      timestamp: 1000,
    });

    const summary = contextManager.renderContext({ tier: 2 });
    expect(summary.activeTier).toBe(2);
    expect(summary.tier1Index).toContain('M1');
    expect(summary.tier2Decisions).toContain('### Key Decisions & Constraints');
    expect(summary.tier2Decisions).toContain('Decouple Tv and Tt');
    expect(summary.tier2Decisions).toContain('Append-only storage required');
    expect(summary.tier2Decisions).toContain('Overwriting records in-place');
    expect(summary.tier3Diffs).toBeUndefined();
    expect(summary.totalEstimatedTokens).toBeLessThan(400);
  });

  it('renders Tier 3 targeted file diffs on-demand within budget', () => {
    contextManager.recordMilestone({
      id: 'M1',
      title: 'Setup',
      status: 'COMPLETED',
      filesTouched: ['lib/sample.ts'],
    });

    const sampleDiff = `@@ -1,4 +1,6 @@
+import { z } from 'zod';
-export const version = '1.0';
+export const version = '2.0';
+export const isReady = true;`;

    contextManager.recordDiff('lib/sample.ts', sampleDiff, 'M1');

    const summary = contextManager.renderContext({
      tier: 3,
      requestedFiles: ['lib/sample.ts'],
    });

    expect(summary.activeTier).toBe(3);
    expect(summary.tier3Diffs).toBeDefined();
    expect(summary.tier3Diffs).toContain('#### Diff: lib/sample.ts');
    expect(summary.tier3Diffs).toContain('+export const version = \'2.0\';');
  });

  it('truncates oversized diffs to strictly enforce token budget ceilings', () => {
    // Generate large 50KB diff
    const hugeDiff = Array.from({ length: 500 }, (_, i) => `+line_${i}: payload modification block value`).join('\n');
    contextManager.recordDiff('large-file.ts', hugeDiff);

    const smallBudget = { tier3Tokens: 100, maxTotalTokens: 300 };
    const summary = contextManager.renderContext({
      tier: 3,
      requestedFiles: ['large-file.ts'],
      budget: smallBudget,
    });

    expect(summary.tier3Diffs).toContain('... [diff truncated to stay within budget]');
    expect(summary.totalEstimatedTokens).toBeLessThan(350);
  });
});

describe('Semantic Knowledge Ontology (Triples & Graph Reasoning)', () => {
  let ontology: KnowledgeOntology;

  beforeEach(() => {
    ontology = new KnowledgeOntology();
  });

  it('stores and queries semantic triples with temporal validity', () => {
    const t1: SemanticTriple = {
      subject: 'module:lib/teamwork/ledger',
      predicate: 'DEFINES_SYMBOL',
      object: 'AppendOnlyLedger',
      validFrom: 1000,
      validTo: null,
      confidence: 1.0,
      sourceMilestone: 'M4',
    };

    const t2: SemanticTriple = {
      subject: 'milestone:M4',
      predicate: 'SATISFIES_REQUIREMENT',
      object: 'requirement:R4',
      validFrom: 1200,
      validTo: 2000, // Valid only until 2000
      confidence: 0.95,
      sourceMilestone: 'M4',
    };

    ontology.addTriples([t1, t2]);

    // Active at 1500: both returned
    const activeAt1500 = ontology.queryTriples({ asOf: 1500 });
    expect(activeAt1500.length).toBe(2);

    // Active at 2500: only t1 is valid (t2 expired at 2000)
    const activeAt2500 = ontology.queryTriples({ asOf: 2500 });
    expect(activeAt2500.length).toBe(1);
    expect(activeAt2500[0].object).toBe('AppendOnlyLedger');
  });

  it('filters triples by subject, predicate, object, and confidence', () => {
    ontology.addTriples([
      {
        subject: 'module:A',
        predicate: 'DEPENDS_ON',
        object: 'module:B',
        validFrom: 100,
        confidence: 0.9,
        sourceMilestone: 'M1',
      },
      {
        subject: 'module:A',
        predicate: 'DEPENDS_ON',
        object: 'module:C',
        validFrom: 100,
        confidence: 0.6,
        sourceMilestone: 'M1',
      },
      {
        subject: 'module:B',
        predicate: 'DEFINES_SYMBOL',
        object: 'SymbolB',
        validFrom: 100,
        confidence: 1.0,
        sourceMilestone: 'M1',
      },
    ]);

    const highConf = ontology.queryTriples({ minConfidence: 0.8 });
    expect(highConf.length).toBe(2);

    const forA = ontology.queryTriples({ subject: 'module:A', predicate: 'DEPENDS_ON' });
    expect(forA.length).toBe(2);

    const reverse = ontology.findReverseRelations('module:B');
    expect(reverse.length).toBe(1);
    expect(reverse[0].subject).toBe('module:A');
  });

  it('supersedes an existing triple without destroying historical record', () => {
    ontology.addTriple({
      subject: 'service:auth',
      predicate: 'USES_ALGORITHM',
      object: 'SHA1',
      validFrom: 1000,
      validTo: null,
      confidence: 1.0,
      sourceMilestone: 'M1',
    });

    const replacement = ontology.supersedeTriple(
      'service:auth',
      'USES_ALGORITHM',
      'SHA1',
      'SHA256',
      { timestamp: 2000, milestoneId: 'M3' }
    );

    expect(replacement.object).toBe('SHA256');
    expect(replacement.validFrom).toBe(2000);

    // Query at timestamp 1500 sees SHA1
    const past = ontology.queryTriples({ subject: 'service:auth', asOf: 1500 });
    expect(past.length).toBe(1);
    expect(past[0].object).toBe('SHA1');

    // Query at timestamp 2500 sees SHA256
    const present = ontology.queryTriples({ subject: 'service:auth', asOf: 2500 });
    expect(present.length).toBe(1);
    expect(present[0].object).toBe('SHA256');

    // Total history has 2 triples
    expect(ontology.totalTriplesCount()).toBe(2);
  });

  it('traverses connected entities and avoids circular dependency loops', () => {
    // Construct circular graph: A -> B -> C -> A
    ontology.addTriples([
      {
        subject: 'node:A',
        predicate: 'DEPENDS_ON',
        object: 'node:B',
        validFrom: 100,
        confidence: 1.0,
        sourceMilestone: 'M1',
      },
      {
        subject: 'node:B',
        predicate: 'DEPENDS_ON',
        object: 'node:C',
        validFrom: 100,
        confidence: 1.0,
        sourceMilestone: 'M1',
      },
      {
        subject: 'node:C',
        predicate: 'DEPENDS_ON',
        object: 'node:A',
        validFrom: 100,
        confidence: 1.0,
        sourceMilestone: 'M1',
      },
    ]);

    // Should complete without infinite recursion
    const connected = ontology.findConnectedEntities('node:A', { maxDepth: 5 });
    expect(connected).toEqual(new Set(['node:A', 'node:B', 'node:C']));
  });

  it('automatically derives facts from milestone and architectural decisions', () => {
    const milestone: MilestoneIndexItem = {
      id: 'M4',
      title: 'Bitemporal Ledger & Context',
      status: 'COMPLETED',
      filesTouched: ['lib/teamwork/ledger/types.ts', 'lib/teamwork/context/types.ts'],
    };

    const decisions: ArchitecturalDecision[] = [
      {
        id: 'DEC-M4-01',
        milestoneId: 'M4',
        title: 'Append-Only JSONL',
        rationale: 'Prevent history tampering',
        constraints: ['Immutable rows', 'Sha256 hash chaining'],
        timestamp: 1500,
      },
    ];

    const derived = ontology.deriveFactsFromMilestone(milestone, decisions, 1500);

    expect(derived.length).toBe(5); // 2 MODIFIES_FILE + 1 DEFINES_SYMBOL + 2 ENFORCES_RULE = 5
    const files = ontology.queryTriples({ subject: 'milestone:M4', predicate: 'MODIFIES_FILE' });
    expect(files.length).toBe(2);

    const rules = ontology.queryTriples({ predicate: 'ENFORCES_RULE' });
    expect(rules.length).toBe(2);
    expect(rules.map((r) => r.object)).toContain('constraint:Immutable rows');
    expect(rules.map((r) => r.object)).toContain('constraint:Sha256 hash chaining');

    const markdown = ontology.renderKnowledgeTriples();
    expect(markdown).toContain('(milestone:M4) --[MODIFIES_FILE]--> (file:lib/teamwork/ledger/types.ts)');
    expect(markdown).toContain('(decision:DEC-M4-01) --[ENFORCES_RULE]--> (constraint:Immutable rows)');
  });
});
