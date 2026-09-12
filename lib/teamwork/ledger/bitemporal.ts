/**
 * Bitemporal Algebra & Interval Reasoning.
 * Evaluates points in time across Valid Time (Tv) and Transaction Time (Tt).
 */

import { BitemporalRecord } from './types';

export class BitemporalAlgebra {
  /**
   * Normalizes the valid time range from record properties.
   *
   * Nếu bản ghi có object `validTime` cấu trúc thì nó là NGUỒN CHÂN LÝ: `to` thiếu
   * nghĩa là mở (null). Trước đây `to` fallback sang `validTo` cũ, trộn hai mô hình
   * thời gian và tạo khoảng bị đảo — vd `{ validFrom: 0, validTo: 500,
   * validTime: { from: 1000 } }` cho ra [1000, 500) nên bản ghi không bao giờ active.
   */
  public static getValidRange(record: BitemporalRecord<any>): { from: number; to: number | null } {
    if (record.validTime) {
      return { from: record.validTime.from, to: record.validTime.to ?? null };
    }
    return { from: record.validFrom, to: record.validTo ?? null };
  }

  /**
   * Normalizes the transaction time range from record properties.
   * Cùng lý do như `getValidRange`: object cấu trúc là nguồn chân lý.
   */
  public static getTxRange(record: BitemporalRecord<any>): { from: number; to: number | null } {
    if (record.transactionTime) {
      return {
        from: record.transactionTime.recordedAt,
        to: record.transactionTime.supersededAt ?? null,
      };
    }
    return { from: record.txFrom, to: record.txTo ?? null };
  }

  /**
   * Determines if a bitemporal record is active at the given (validTime, txTime) coordinates.
   * Tv interval is half-open: [from, to). null 'to' means infinity.
   * Tt interval is half-open: [from, to). null 'to' means infinity (current system knowledge).
   */
  public static isActiveAt(
    record: BitemporalRecord<any>,
    validTime: number,
    txTime: number = Date.now()
  ): boolean {
    const { from: validFrom, to: validTo } = this.getValidRange(record);
    const { from: txFrom, to: txTo } = this.getTxRange(record);

    const validMatch = validFrom <= validTime && (validTo === null || validTime < validTo);
    const txMatch = txFrom <= txTime && (txTo === null || txTime < txTo);

    return validMatch && txMatch;
  }

  /**
   * Queries records that were active at a point in time (validTime, txTime).
   */
  public static queryAsOf<T>(
    records: BitemporalRecord<T>[],
    validTime: number,
    txTime: number = Date.now()
  ): BitemporalRecord<T>[] {
    return records.filter((r) => this.isActiveAt(r, validTime, txTime));
  }

  /**
   * Queries records that are valid at a specific valid time according to current system knowledge (Tt = now).
   */
  public static queryByValidTime<T>(
    records: BitemporalRecord<T>[],
    validTime: number
  ): BitemporalRecord<T>[] {
    return this.queryAsOf(records, validTime, Date.now());
  }

  /**
   * Queries records as they were recorded at a specific transaction time Tt.
   */
  public static queryByTxTime<T>(
    records: BitemporalRecord<T>[],
    txTime: number
  ): BitemporalRecord<T>[] {
    return records.filter((r) => {
      const { from: txFrom, to: txTo } = this.getTxRange(r);
      return txFrom <= txTime && (txTo === null || txTime < txTo);
    });
  }

  /**
   * Checks if two half-open intervals [s1, e1) and [s2, e2) overlap.
   */
  public static isIntervalOverlapping(
    s1: number,
    e1: number | null,
    s2: number,
    e2: number | null
  ): boolean {
    const left1 = s1;
    const right1 = e1 === null ? Number.POSITIVE_INFINITY : e1;
    const left2 = s2;
    const right2 = e2 === null ? Number.POSITIVE_INFINITY : e2;

    return Math.max(left1, left2) < Math.min(right1, right2);
  }

  /**
   * Checks if two records overlap in valid time.
   */
  public static isValidOverlapping(
    r1: BitemporalRecord<any>,
    r2: BitemporalRecord<any>
  ): boolean {
    const range1 = this.getValidRange(r1);
    const range2 = this.getValidRange(r2);
    return this.isIntervalOverlapping(range1.from, range1.to, range2.from, range2.to);
  }

  /**
   * Sorts records chronologically by validFrom asc, then txFrom asc, then sequence asc.
   */
  public static sortChronologically<T>(records: BitemporalRecord<T>[]): BitemporalRecord<T>[] {
    return [...records].sort((a, b) => {
      const aValid = this.getValidRange(a).from;
      const bValid = this.getValidRange(b).from;
      if (aValid !== bValid) return aValid - bValid;

      const aTx = this.getTxRange(a).from;
      const bTx = this.getTxRange(b).from;
      if (aTx !== bTx) return aTx - bTx;

      return a.sequence - b.sequence;
    });
  }
}
