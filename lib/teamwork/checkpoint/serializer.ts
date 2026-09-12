import crypto from 'node:crypto';
import {
  CheckpointSerializationError,
  WorkflowCheckpoint,
} from './types';

/**
 * Creates a JSON replacer function that handles circular references, BigInts, Sets, Maps, and Errors.
 *
 * Circularity is tracked with an ANCESTOR STACK rather than a global "seen" set: a plain
 * `WeakSet` that is never pruned mislabels legitimately shared (non-circular) references —
 * e.g. the same output object stored for two nodes — as `"[Circular]"`, corrupting the
 * checkpoint. The stack is unwound back to the current holder on every call, so only
 * genuine back-references to an ancestor are replaced.
 */
function createSafeReplacer() {
  const ancestorStack: unknown[] = [];

  return function (this: unknown, key: string, value: unknown) {
    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    if (value instanceof Map) {
      return Object.fromEntries(value.entries());
    }

    if (value instanceof Set) {
      return Array.from(value.values());
    }

    if (typeof value === 'object' && value !== null) {
      // Unwind to the holder of this key: anything deeper is a sibling subtree already closed.
      while (ancestorStack.length > 0 && ancestorStack[ancestorStack.length - 1] !== this) {
        ancestorStack.pop();
      }

      if (ancestorStack.includes(value)) {
        return '[Circular]';
      }

      ancestorStack.push(value);
    }

    return value;
  };
}

/**
 * Serializes a WorkflowCheckpoint into a safe JSON string with circular reference protection.
 */
export function serializeCheckpoint(
  checkpoint: WorkflowCheckpoint,
  pretty: boolean = false
): string {
  try {
    return JSON.stringify(checkpoint, createSafeReplacer(), pretty ? 2 : undefined);
  } catch (err) {
    throw new CheckpointSerializationError(
      `Failed to serialize workflow checkpoint: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }
}

/**
 * Deserializes and validates a WorkflowCheckpoint from a JSON string.
 */
export function deserializeCheckpoint(rawJson: string): WorkflowCheckpoint {
  try {
    const parsed = JSON.parse(rawJson);

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Parsed payload is not an object.');
    }

    if (typeof parsed.runId !== 'string' || !parsed.runId) {
      throw new Error('Missing or invalid "runId" in checkpoint.');
    }

    if (typeof parsed.dagId !== 'string' || !parsed.dagId) {
      throw new Error('Missing or invalid "dagId" in checkpoint.');
    }

    if (!parsed.nodes || typeof parsed.nodes !== 'object') {
      throw new Error('Missing or invalid "nodes" record in checkpoint.');
    }

    if (typeof parsed.status !== 'string') {
      throw new Error('Missing or invalid "status" in checkpoint.');
    }

    return {
      version: parsed.version ?? '1.0.0',
      runId: parsed.runId,
      dagId: parsed.dagId,
      dagDefinitionHash: parsed.dagDefinitionHash,
      status: parsed.status,
      createdAt: Number(parsed.createdAt ?? Date.now()),
      updatedAt: Number(parsed.updatedAt ?? Date.now()),
      pausedAt: parsed.pausedAt ? Number(parsed.pausedAt) : undefined,
      resumedAt: parsed.resumedAt ? Number(parsed.resumedAt) : undefined,
      pauseReason: parsed.pauseReason,
      completedNodeIds: Array.isArray(parsed.completedNodeIds)
        ? parsed.completedNodeIds
        : [],
      failedNodeIds: Array.isArray(parsed.failedNodeIds)
        ? parsed.failedNodeIds
        : [],
      blockedNodeIds: Array.isArray(parsed.blockedNodeIds)
        ? parsed.blockedNodeIds
        : [],
      nodes: parsed.nodes,
      context: parsed.context ?? {},
      fileStats: Array.isArray(parsed.fileStats) ? parsed.fileStats : undefined,
    };
  } catch (err) {
    throw new CheckpointSerializationError(
      `Failed to deserialize checkpoint: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }
}

/**
 * Computes a deterministic SHA-256 fingerprint of a DAG's topology to detect schema/definition drift.
 */
export function computeDagDefinitionHash(
  nodes: Array<{ id: string; dependsOn: string[] }>
): string {
  const normalized = [...nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      dependsOn: [...n.dependsOn].sort((a, b) => a.localeCompare(b)),
    }));

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

/**
 * Generates an idempotency token for a specific node execution attempt.
 */
export function generateIdempotencyToken(
  runId: string,
  nodeId: string,
  attempt: number = 1
): string {
  return `${runId}:${nodeId}:${attempt}`;
}

/**
 * Parses an idempotency token back into runId, nodeId, and attempt.
 */
export function parseIdempotencyToken(token: string): {
  runId: string;
  nodeId: string;
  attempt: number;
} | null {
  const parts = token.split(':');
  if (parts.length < 3) return null;
  const attempt = parseInt(parts[2], 10);
  if (isNaN(attempt)) return null;

  return {
    runId: parts[0],
    nodeId: parts[1],
    attempt,
  };
}
