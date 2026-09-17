/**
 * Provenance Tracking & Cryptographic Hash Chaining.
 * Implements immutable audit trails for file writes and modifications.
 * Yêu cầu an ninh cho thao tác ghi dữ liệu.
 */

import crypto from 'node:crypto';
import { ProvenanceRecord, ToolExecutionContext } from './types';

export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Calculates SHA-256 digest of utf8 text or buffer.
 */
export function calculateSha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export interface CreateProvenanceRecordOptions {
  context: ToolExecutionContext;
  filePath: string;
  action: ProvenanceRecord['action'];
  contentBefore?: string;
  contentAfter?: string;
  timestamp?: number;
  id?: string;
}

export class ProvenanceTracker {
  private lastRecordHash = GENESIS_HASH;
  private readonly records: ProvenanceRecord[] = [];

  /**
   * Computes the canonical record hash given record fields and the previous record hash.
   *
   * `role` và `parentRecordId` nằm trong hash: nếu bỏ ra ngoài, kẻ tấn công đổi được
   * vai trò (worker → orchestrator) hoặc mối liên kết chuỗi mà `verifyChainIntegrity()`
   * vẫn báo hợp lệ — lỗ hổng với một "audit trail bất biến".
   */
  public static computeRecordHash(
    prevRecordHash: string,
    id: string,
    timestamp: number,
    workerId: string,
    milestoneId: string,
    filePath: string,
    action: string,
    contentHashBefore?: string,
    contentHashAfter?: string,
    authorizationToken?: string,
    role?: string,
    parentRecordId?: string
  ): string {
    const payload = `${prevRecordHash}:${id}:${timestamp}:${workerId}:${milestoneId}:${filePath}:${action}:${contentHashBefore ?? ''}:${contentHashAfter ?? ''}:${authorizationToken ?? ''}:${role ?? ''}:${parentRecordId ?? ''}`;
    return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  }

  /**
   * Generates, cryptographically hashes, and chains a new ProvenanceRecord.
   */
  public createRecord(options: CreateProvenanceRecordOptions): ProvenanceRecord {
    const { context, filePath, action, contentBefore, contentAfter } = options;

    const id = options.id ?? crypto.randomUUID();
    const timestamp = options.timestamp ?? Date.now();

    const contentHashBefore = contentBefore !== undefined ? calculateSha256(contentBefore) : undefined;
    const contentHashAfter = contentAfter !== undefined ? calculateSha256(contentAfter) : undefined;

    // Use contentHashAfter as contentSha256, or fallback to contentHashBefore or empty hash
    const contentSha256 = contentHashAfter ?? contentHashBefore ?? GENESIS_HASH;

    // Phải xác định parentRecordId TRƯỚC khi hash vì nó nằm trong payload hash.
    const parentRecordId =
      this.records.length > 0 ? this.records[this.records.length - 1].id : undefined;

    const recordHash = ProvenanceTracker.computeRecordHash(
      this.lastRecordHash,
      id,
      timestamp,
      context.workerId,
      context.milestoneId,
      filePath,
      action,
      contentHashBefore,
      contentHashAfter,
      context.authorizationToken,
      context.role,
      parentRecordId
    );

    const record: ProvenanceRecord = {
      id,
      timestamp,
      workerId: context.workerId,
      originatorId: context.workerId,
      milestoneId: context.milestoneId,
      role: context.role,
      filePath,
      targetResource: filePath,
      action,
      actionType: action,
      contentSha256,
      contentHashBefore,
      contentHashAfter,
      authorizationToken: context.authorizationToken || '',
      prevRecordHash: this.lastRecordHash,
      recordHash,
      parentRecordId,
    };

    this.lastRecordHash = recordHash;
    this.records.push(record);
    return record;
  }

  /**
   * Returns read-only slice of all provenance records in chronological order.
   */
  public getHistory(): readonly ProvenanceRecord[] {
    return [...this.records];
  }

  /**
   * Returns the most recent record in the chain, if any.
   */
  public getLastRecord(): ProvenanceRecord | undefined {
    return this.records.length > 0 ? this.records[this.records.length - 1] : undefined;
  }

  /**
   * Retrieves all provenance records affecting a specific file path.
   */
  public getRecordsForFile(filePath: string): ProvenanceRecord[] {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    return this.records.filter((r) => r.filePath.replace(/\\/g, '/').toLowerCase() === normalized);
  }

  /**
   * Retrieves all provenance records authored by a specific worker.
   */
  public getRecordsForWorker(workerId: string): ProvenanceRecord[] {
    return this.records.filter((r) => r.workerId === workerId);
  }

  /**
   * Retrieves all provenance records belonging to a milestone.
   */
  public getRecordsForMilestone(milestoneId: string): ProvenanceRecord[] {
    return this.records.filter((r) => r.milestoneId === milestoneId);
  }

  /**
   * Validates cryptographic hash chain integrity across all historical records.
   */
  public verifyChainIntegrity(): { valid: boolean; brokenAt?: number; reason?: string } {
    let expectedPrevHash = GENESIS_HASH;

    for (let i = 0; i < this.records.length; i++) {
      const record = this.records[i];

      // 1. Verify previous hash chaining
      if (record.prevRecordHash !== expectedPrevHash) {
        return {
          valid: false,
          brokenAt: i,
          reason: `Broken chain link at index ${i} (record ID: ${record.id}): expected prevHash ${expectedPrevHash}, found ${record.prevRecordHash}`,
        };
      }

      // 2. Recompute recordHash and verify matches stored hash
      const recomputedHash = ProvenanceTracker.computeRecordHash(
        expectedPrevHash,
        record.id,
        record.timestamp,
        record.workerId,
        record.milestoneId,
        record.filePath,
        record.action,
        record.contentHashBefore,
        record.contentHashAfter,
        record.authorizationToken,
        record.role,
        record.parentRecordId
      );

      if (recomputedHash !== record.recordHash) {
        return {
          valid: false,
          brokenAt: i,
          reason: `Tampered record detected at index ${i} (record ID: ${record.id}): recomputed hash ${recomputedHash} does not match recorded ${record.recordHash}`,
        };
      }

      expectedPrevHash = record.recordHash;
    }

    return { valid: true };
  }

  /**
   * Exports chain to JSON string.
   */
  public exportToJson(): string {
    return JSON.stringify(this.records, null, 2);
  }

  /**
   * Imports chain from JSON string and validates integrity.
   * Atomic: state chỉ được commit khi chuỗi đã verify thành công.
   */
  public importFromJson(jsonStr: string): void {
    const parsed = JSON.parse(jsonStr) as ProvenanceRecord[];
    if (!Array.isArray(parsed)) {
      throw new Error('Imported provenance payload must be a JSON array of records.');
    }

    // Bản cũ ghi đè records + lastRecordHash RỒI mới verify: khi verify thất bại,
    // tracker vẫn giữ chuỗi giả mạo và `createRecord()` kế tiếp nối lên tip đã bị
    // sửa. Sao lưu state để khôi phục nếu verify fail.
    const prevRecords = [...this.records];
    const prevLastHash = this.lastRecordHash;

    this.records.length = 0;
    this.lastRecordHash = GENESIS_HASH;

    for (const record of parsed) {
      this.records.push(record);
      this.lastRecordHash = record.recordHash;
    }

    const check = this.verifyChainIntegrity();
    if (!check.valid) {
      this.records.length = 0;
      this.records.push(...prevRecords);
      this.lastRecordHash = prevLastHash;
      throw new Error(`Imported provenance chain failed integrity verification: ${check.reason}`);
    }
  }

  /**
   * Clears all recorded provenance records.
   */
  public clear(): void {
    this.records.length = 0;
    this.lastRecordHash = GENESIS_HASH;
  }
}
