/**
 * Point-in-Time State Replay Engine.
 * Reconstructs virtual codebase and entity states at any (Tv, Tt) bitemporal coordinate.
 */

import { AppendOnlyLedger } from './audit-ledger';
import { BitemporalAlgebra } from './bitemporal';
import {
  BitemporalRecord,
  ReplayEntityState,
  ReplayOptions,
} from './types';

export class PointInTimeReplayEngine {
  private readonly getRecords: () => readonly BitemporalRecord<any>[];

  constructor(source: AppendOnlyLedger | readonly BitemporalRecord<any>[]) {
    if (source instanceof AppendOnlyLedger) {
      this.getRecords = () => source.getAllRecords();
    } else {
      this.getRecords = () => source;
    }
  }

  /**
   * Replays and reconstructs the state of a single entity at coordinate (validTime, txTime).
   */
  public replayEntityState<T = unknown>(
    entityId: string,
    options?: number | ReplayOptions
  ): ReplayEntityState<T> | null {
    const opts: ReplayOptions | undefined = typeof options === 'number' ? { asOfValidTime: options } : options;
    const validTime = opts?.validTime ?? opts?.asOfValidTime ?? Date.now();
    const txTime = opts?.txTime ?? opts?.asOfTransactionTime ?? Date.now();

    const all = this.getRecords();
    const entityRecords = all.filter((r) => r.entityId === entityId);
    if (entityRecords.length === 0) {
      return null;
    }

    // Filter active records at (validTime, txTime)
    const activeRecords = BitemporalAlgebra.queryAsOf(entityRecords, validTime, txTime);
    const sortedHistory = BitemporalAlgebra.sortChronologically(activeRecords);

    if (sortedHistory.length === 0) {
      return null;
    }

    let currentState: T | null = null;
    let isActive = false;
    let lastValidTime = 0;
    let lastTxTime = 0;
    let version = 0;

    for (const record of sortedHistory) {
      const { from: vFrom } = BitemporalAlgebra.getValidRange(record);
      const { from: tFrom } = BitemporalAlgebra.getTxRange(record);

      lastValidTime = vFrom;
      lastTxTime = tFrom;
      version++;

      switch (record.action) {
        case 'INSERT':
        case 'UPDATE':
          currentState = record.payload as T;
          isActive = true;
          break;

        case 'DELETE':
          currentState = null;
          isActive = false;
          break;

        case 'COMPENSATE': {
          // If compensating payload provides an explicit inverse or restore
          const compPayload = record.payload as any;
          if (compPayload?.restoredState !== undefined) {
            currentState = compPayload.restoredState as T;
            isActive = currentState !== null;
          } else if (compPayload?.revertedRecordId) {
            // Roll back to the state immediately before the reverted record.
            // NOTE: `sortedHistory` only contains records still *active* at (Tv, Tt), and a
            // superseded predecessor is already inactive by then — so we must search the
            // entity's full history to find the pre-revert state.
            const priorHistory = entityRecords
              .filter(
                (r) =>
                  r.id !== compPayload.revertedRecordId &&
                  r.sequence < record.sequence &&
                  (r.action === 'INSERT' || r.action === 'UPDATE')
              )
              .sort((a, b) => a.sequence - b.sequence);
            if (priorHistory.length > 0) {
              currentState = priorHistory[priorHistory.length - 1].payload as T;
              isActive = true;
            } else {
              currentState = null;
              isActive = false;
            }
          } else {
            currentState = null;
            isActive = false;
          }
          break;
        }

        default:
          currentState = record.payload as T;
          isActive = true;
          break;
      }
    }

    return {
      entityId,
      state: currentState,
      active: isActive,
      lastModifiedValidTime: lastValidTime,
      lastModifiedTxTime: lastTxTime,
      version,
      history: sortedHistory,
    };
  }

  /**
   * Helper to retrieve only the resolved value of an entity at (validTime, txTime).
   */
  public replayEntityValue<T = unknown>(
    entityId: string,
    options?: ReplayOptions
  ): T | null {
    const replay = this.replayEntityState<T>(entityId, options);
    return replay ? replay.state : null;
  }

  /**
   * Replays and returns all active entity states at coordinate (validTime, txTime).
   */
  public replayAllEntities(options?: ReplayOptions): Map<string, unknown> {
    const all = this.getRecords();
    const entityIds = new Set<string>();

    for (const r of all) {
      if (r.entityId) {
        entityIds.add(r.entityId);
      }
    }

    const resultMap = new Map<string, unknown>();
    for (const entityId of entityIds) {
      const replay = this.replayEntityState(entityId, options);
      if (replay && replay.active && replay.state !== null) {
        resultMap.set(entityId, replay.state);
      }
    }

    return resultMap;
  }

  /**
   * Reconstructs the virtual file tree (mapping of filePath -> content) at (validTime, txTime).
   */
  public replayFileTree(options?: ReplayOptions): Map<string, string> {
    const validTime = options?.validTime ?? options?.asOfValidTime ?? Date.now();
    const txTime = options?.txTime ?? options?.asOfTransactionTime ?? Date.now();

    const all = this.getRecords();
    const fileRecords = all.filter(
      (r) =>
        r.eventType === 'file_snapshot' ||
        r.eventType === 'file_patch' ||
        (r.eventType === 'revert' && r.entityId)
    );

    const activeRecords = BitemporalAlgebra.queryAsOf(fileRecords, validTime, txTime);
    const sorted = BitemporalAlgebra.sortChronologically(activeRecords);

    const fileMap = new Map<string, string>();

    for (const record of sorted) {
      const filePath = record.entityId ?? (record.payload as any)?.filePath;
      if (!filePath) continue;

      if (record.action === 'DELETE') {
        fileMap.delete(filePath);
        continue;
      }

      if (record.action === 'COMPENSATE') {
        const comp = record.payload as any;
        if (comp?.restoredContent !== undefined) {
          fileMap.set(filePath, comp.restoredContent);
        } else if (comp?.revertedRecordId) {
          // Revert to the snapshot prior to the reverted record.
          // `sorted` is time-filtered, so search the full file-record history instead.
          const prior = fileRecords
            .filter((r) => r.id !== comp.revertedRecordId && r.sequence < record.sequence)
            .sort((a, b) => a.sequence - b.sequence);
          const lastFileRec = [...prior].reverse().find(
            (r) => (r.entityId === filePath || (r.payload as any)?.filePath === filePath)
          );
          if (lastFileRec && (lastFileRec.payload as any)?.content !== undefined) {
            fileMap.set(filePath, (lastFileRec.payload as any).content);
          } else {
            fileMap.delete(filePath);
          }
        }
        continue;
      }

      // Snapshot or patch
      const payloadContent = (record.payload as any)?.content;
      if (typeof payloadContent === 'string') {
        fileMap.set(filePath, payloadContent);
      }
    }

    return fileMap;
  }

  /**
   * Generates chronological timeline entries for an entity across all its recorded history.
   */
  public getEntityTimeline(entityId: string): Array<{
    sequence: number;
    validTime: number;
    txTime: number;
    eventType: string;
    action: string;
    payload: unknown;
  }> {
    const all = this.getRecords();
    const records = all.filter((r) => r.entityId === entityId);
    const sorted = BitemporalAlgebra.sortChronologically(records);

    return sorted.map((r) => ({
      sequence: r.sequence,
      validTime: BitemporalAlgebra.getValidRange(r).from,
      txTime: BitemporalAlgebra.getTxRange(r).from,
      eventType: r.eventType,
      action: r.action,
      payload: r.payload,
    }));
  }
}
