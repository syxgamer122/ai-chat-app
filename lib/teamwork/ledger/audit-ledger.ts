/**
 * Production-Grade Append-Only Bitemporal Audit Ledger.
 * Provides SHA-256 Merkle hash chain verification, point-in-time querying,
 * and non-destructive compensating rollback.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BitemporalAlgebra } from './bitemporal';
import {
  AppendRecordInput,
  BitemporalRecord,
  CompensateOptions,
  IntegrityVerificationResult,
  LedgerEventType,
  LedgerQueryOptions,
} from './types';

export const GENESIS_PREV_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export class AppendOnlyLedger {
  private readonly ledgerPath: string;
  private readonly records: BitemporalRecord<any>[] = [];
  private sequenceCounter = 0;
  private lastHash = GENESIS_PREV_HASH;
  /** Mốc transaction time lớn nhất đã ghi — xem chú thích trong appendRecord(). */
  private lastTxFrom = 0;
  private appendQueue: Promise<any> = Promise.resolve();
  private lastVerification: IntegrityVerificationResult | null = null;

  constructor(workspaceRoot: string, options?: { ledgerRelativePath?: string }) {
    const rel = options?.ledgerRelativePath ?? path.join('.teamwork', 'ledger', 'records.jsonl');
    this.ledgerPath = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
  }

  public getLedgerPath(): string {
    return this.ledgerPath;
  }

  /**
   * Initializes the ledger by loading and verifying existing records.
   */
  public async initialize(): Promise<void> {
    await fsp.mkdir(path.dirname(this.ledgerPath), { recursive: true });
    if (!fs.existsSync(this.ledgerPath)) {
      return;
    }

    const content = await fsp.readFile(this.ledgerPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    this.records.length = 0;
    this.sequenceCounter = 0;
    this.lastHash = GENESIS_PREV_HASH;
    this.lastTxFrom = 0;

    for (const line of lines) {
      const record = JSON.parse(line) as BitemporalRecord<any>;
      this.records.push(record);
      this.sequenceCounter = Math.max(this.sequenceCounter, record.sequence);
      this.lastHash = record.recordHash;
      this.lastTxFrom = Math.max(this.lastTxFrom, record.txFrom);

      // If this record superseded or compensated an earlier record, update in-memory txTo
      if (record.parentRecordId) {
        const parent = this.records.find((r) => r.id === record.parentRecordId);
        if (parent && parent.txTo === null) {
          parent.txTo = record.txFrom;
          if (parent.transactionTime) {
            parent.transactionTime.supersededAt = record.txFrom;
          }
        }
      }
    }

    // Actually verify the loaded chain (previously loaded blindly). We do NOT throw so that
    // callers can still inspect a corrupted ledger; the result is retained and exposed.
    this.lastVerification = this.verifyIntegrity();
    if (!this.lastVerification.valid) {
      console.warn(
        `[AppendOnlyLedger] Integrity verification failed for "${this.ledgerPath}": ${this.lastVerification.errors
          .slice(0, 5)
          .join('; ')}${this.lastVerification.errors.length > 5 ? ' …' : ''}`
      );
    }
  }

  /**
   * Returns the result of the integrity check performed during the last initialize() call,
   * or null when initialize() has not run (or the ledger file did not exist).
   */
  public getLastVerification(): IntegrityVerificationResult | null {
    return this.lastVerification;
  }

  /**
   * Computes a deterministic SHA-256 hash for a record.
   */
  public static computeRecordHash(
    prevHash: string,
    sequence: number,
    eventType: LedgerEventType,
    action: string,
    milestoneId: string,
    workerId: string,
    validFrom: number,
    validTo: number | null,
    txFrom: number,
    entityId: string = '',
    payload: unknown
  ): string {
    const payloadJson = JSON.stringify(payload ?? null);
    const payloadHash = crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');
    const hashData = `${prevHash}:${sequence}:${eventType}:${action}:${milestoneId}:${workerId}:${validFrom}:${validTo ?? ''}:${txFrom}:${entityId}:${payloadHash}`;
    return crypto.createHash('sha256').update(hashData, 'utf8').digest('hex');
  }

  /**
   * Appends an immutable bitemporal record to the ledger.
   * Thread-safe / serialized via appendQueue.
   */
  public async appendRecord<T>(input: AppendRecordInput<T>): Promise<BitemporalRecord<T>> {
    return new Promise<BitemporalRecord<T>>((resolve, reject) => {
      this.appendQueue = this.appendQueue
        .then(async () => {
          const id = crypto.randomUUID();
          const sequence = ++this.sequenceCounter;
          const validFrom = input.validFrom ?? Date.now();
          const validTo = input.validTo ?? null;
          /* Transaction time phải ĐƠN ĐIỆU TĂNG. Khoảng Tt là half-open [from, to)
             và khi một bản ghi bị supersede/compensate, `txTo` của nó bị đóng
             bằng chính `txFrom` của bản ghi mới — nếu hai lần ghi rơi vào cùng
             một mili-giây thì khoảng co thành rỗng [T, T): bản ghi không còn
             active ở BẤT KỲ Tt nào nên replay trả null (test ledger e2e ĐỎ ngẫu
             nhiên tuỳ timing). Chỉ nhích +1ms khi Date.now() không tăng, nên thứ
             tự tx luôn khớp thứ tự ghi mà vẫn giữ nguyên giá trị thật khi có thể. */
          const txFrom = Math.max(Date.now(), this.lastTxFrom + 1);
          this.lastTxFrom = txFrom;
          const txTo = null;
          const action = input.action ?? 'INSERT';
          const eventType = input.eventType ?? 'entity_state';
          const milestoneId = input.milestoneId ?? 'M0';
          const workerId = input.workerId ?? input.author ?? 'system';

          const recordHash = AppendOnlyLedger.computeRecordHash(
            this.lastHash,
            sequence,
            eventType,
            action,
            milestoneId,
            workerId,
            validFrom,
            validTo,
            txFrom,
            input.entityId,
            input.payload
          );

          const record: BitemporalRecord<T> = {
            id,
            sequence,
            entityId: input.entityId,
            validFrom,
            validTo,
            validTime: { from: validFrom, to: validTo ?? undefined },
            txFrom,
            txTo,
            transactionTime: { recordedAt: txFrom, supersededAt: undefined },
            eventType,
            action,
            milestoneId,
            workerId,
            payload: input.payload,
            prevHash: this.lastHash,
            recordHash,
            merkleHash: recordHash,
            parentRecordId: input.parentRecordId,
            metadata: input.metadata,
          };

          // If updating/superseding an earlier record, close its in-memory txTo
          if (input.parentRecordId) {
            const parent = this.records.find((r) => r.id === input.parentRecordId);
            if (parent && parent.txTo === null) {
              parent.txTo = txFrom;
              if (parent.transactionTime) {
                parent.transactionTime.supersededAt = txFrom;
              }
            }
          }

          this.lastHash = recordHash;
          this.records.push(record);

          await fsp.mkdir(path.dirname(this.ledgerPath), { recursive: true });
          await fsp.appendFile(this.ledgerPath, JSON.stringify(record) + '\n', 'utf8');

          resolve(record);
        })
        .catch(reject);
    });
  }

  /**
   * Supersedes an existing record without destructive modification, recording the new version
   * and linking back to the target record.
   */
  public async supersedeRecord<T>(
    targetRecordId: string,
    newRecordInput: AppendRecordInput<T>
  ): Promise<{ superseded: BitemporalRecord<any>; replacement: BitemporalRecord<T> }> {
    const target = this.records.find((r) => r.id === targetRecordId);
    if (!target) {
      throw new Error(`Record with id "${targetRecordId}" not found in ledger.`);
    }

    const replacement = await this.appendRecord<T>({
      ...newRecordInput,
      entityId: newRecordInput.entityId ?? target.entityId,
      action: newRecordInput.action ?? 'UPDATE',
      parentRecordId: targetRecordId,
      validFrom: newRecordInput.validFrom ?? target.validFrom,
      validTo: newRecordInput.validTo !== undefined ? newRecordInput.validTo : target.validTo,
    });

    return { superseded: target, replacement };
  }

  /**
   * Executes a non-destructive compensating rollback.
   * Appends an inverse compensating action to the append-only ledger.
   */
  public async compensate(options: CompensateOptions): Promise<BitemporalRecord<unknown>> {
    const target = this.records.find((r) => r.id === options.targetRecordId);
    if (!target) {
      throw new Error(`Cannot compensate record "${options.targetRecordId}": record not found.`);
    }

    const now = Date.now();
    const compensatingPayload = options.inversePayload ?? {
      revertedRecordId: target.id,
      revertedSequence: target.sequence,
      revertedEventType: target.eventType,
      originalPayload: target.payload,
      reason: options.reason ?? `Compensating rollback of record ${target.id}`,
    };

    return await this.appendRecord({
      entityId: target.entityId,
      eventType: 'revert',
      action: 'COMPENSATE',
      milestoneId: options.milestoneId ?? target.milestoneId,
      workerId: options.workerId ?? options.author ?? 'system',
      validFrom: now,
      validTo: null,
      parentRecordId: target.id,
      payload: compensatingPayload,
      metadata: {
        reason: options.reason,
        targetSequence: target.sequence,
      },
    });
  }

  /**
   * Queries the ledger with bitemporal filtering.
   */
  public query(options: LedgerQueryOptions): BitemporalRecord<any>[] {
    let result = [...this.records];

    const validTime = options.validTime ?? options.asOfValidTime;
    const txTime = options.txTime ?? options.asOfTransactionTime;

    if (validTime !== undefined) {
      result = BitemporalAlgebra.queryAsOf(result, validTime, txTime ?? Date.now());
    } else if (txTime !== undefined) {
      result = BitemporalAlgebra.queryByTxTime(result, txTime);
    }

    if (options.entityId) {
      result = result.filter((r) => r.entityId === options.entityId);
    }

    if (options.milestoneId) {
      result = result.filter((r) => r.milestoneId === options.milestoneId);
    }

    if (options.eventType) {
      result = result.filter((r) => r.eventType === options.eventType);
    }

    if (options.action) {
      result = result.filter((r) => r.action === options.action);
    }

    if (options.limit && options.limit > 0) {
      result = result.slice(-options.limit);
    }

    return result;
  }

  /**
   * Verifies the cryptographic Merkle hash chain integrity of the ledger.
   */
  public verifyIntegrity(): IntegrityVerificationResult {
    const errors: string[] = [];
    let expectedPrevHash = GENESIS_PREV_HASH;

    for (let i = 0; i < this.records.length; i++) {
      const record = this.records[i];
      const expectedSequence = i + 1;

      if (record.sequence !== expectedSequence) {
        errors.push(
          `Sequence mismatch at index ${i}: expected ${expectedSequence}, found ${record.sequence}`
        );
      }

      if (record.prevHash !== expectedPrevHash) {
        errors.push(
          `Broken hash chain at sequence ${record.sequence}: prevHash ${record.prevHash} != expected ${expectedPrevHash}`
        );
      }

      const recomputedHash = AppendOnlyLedger.computeRecordHash(
        record.prevHash,
        record.sequence,
        record.eventType,
        record.action,
        record.milestoneId,
        record.workerId,
        record.validFrom,
        record.validTo,
        record.txFrom,
        record.entityId,
        record.payload
      );

      if (record.recordHash !== recomputedHash) {
        errors.push(
          `Record hash mismatch at sequence ${record.sequence}: hash ${record.recordHash} != recomputed ${recomputedHash}`
        );
      }

      expectedPrevHash = record.recordHash;
    }

    return {
      valid: errors.length === 0,
      chainLength: this.records.length,
      errors,
      tipHash: this.lastHash,
    };
  }

  /**
   * Returns a read-only view of all recorded entries.
   */
  public getAllRecords(): readonly BitemporalRecord<any>[] {
    return this.records;
  }

  /**
   * Returns the most recent record appended to the ledger.
   */
  public getLatestRecord(): BitemporalRecord<any> | undefined {
    return this.records.length > 0 ? this.records[this.records.length - 1] : undefined;
  }

  /**
   * Returns total count of records.
   */
  public count(): number {
    return this.records.length;
  }
}
