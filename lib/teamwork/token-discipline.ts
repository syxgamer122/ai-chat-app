/**
 * Token Discipline & History Invariants for Teamwork Multi-Agent Runtime Engine.
 *
 * Implements context preservation and invariant guarantees:
 * 1. History Invariant 1: First message in active history MUST have role 'user'.
 * 2. History Invariant 2: No orphaned tool calls or tool results:
 *    - Tool results whose parent assistant tool call was pruned are discarded.
 *    - Assistant tool calls whose results are missing are cleanly repaired or removed.
 * 3. Token Discipline: Trims old tool outputs past the 3 most recent execution steps
 *    while preserving message envelopes and pairing IDs to prevent token explosion.
 */

export interface HistoryMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'toolResult' | string;
  content: string | unknown;
  tool_calls?: Array<{
    id: string;
    type?: string;
    function?: { name: string; arguments: string };
    name?: string;
    args?: unknown;
  }>;
  toolCalls?: Array<{
    id: string;
    name: string;
    args?: unknown;
  }>;
  tool_call_id?: string;
  toolCallId?: string;
  name?: string;
  toolResult?: {
    toolCallId: string;
    name: string;
    content: unknown;
    isError?: boolean;
    details?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface SlimToolResultsOptions {
  /**
   * Number of recent tool execution steps to keep intact.
   * Older tool outputs will be trimmed.
   * Default: 3
   */
  recentStepsToKeep?: number;

  /**
   * Max characters permitted in a slimmed tool result.
   * Default: 150
   */
  maxTrimmedChars?: number;

  /**
   * Custom placeholder generator for trimmed content.
   */
  placeholder?: (originalLength: number, toolName?: string) => string;
}

export interface TrimHistoryOptions {
  /**
   * Max messages to retain in trimmed history.
   */
  maxMessages?: number;

  /**
   * Max tokens budget if token-based trimming is used.
   */
  maxTokens?: number;

  /**
   * Number of recent tool execution steps to keep intact in slimToolResults.
   * Default: 3
   */
  recentStepsToKeep?: number;

  /**
   * Function to estimate tokens for a message (defaults to ~3.8 chars/token).
   */
  estimateTokens?: (msg: HistoryMessage) => number;
}

/**
 * Checks if a message is a tool result.
 */
export function isToolResultMessage(msg: HistoryMessage): boolean {
  if (!msg) return false;
  if (
    msg.role === 'tool' ||
    msg.role === 'toolResult' ||
    Boolean(msg.tool_call_id) ||
    Boolean(msg.toolCallId) ||
    Boolean(msg.toolResult) ||
    Boolean((msg as Record<string, unknown>).tool_use_id)
  ) {
    return true;
  }
  if (Array.isArray(msg.content)) {
    return msg.content.some(
      (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result'
    );
  }
  return false;
}

/**
 * Extracts the tool call ID associated with a tool result message.
 */
export function getToolCallIdFromResult(msg: HistoryMessage): string | undefined {
  if (!msg) return undefined;
  if (typeof msg.tool_call_id === 'string' && msg.tool_call_id.trim()) {
    return msg.tool_call_id.trim();
  }
  if (typeof msg.toolCallId === 'string' && msg.toolCallId.trim()) {
    return msg.toolCallId.trim();
  }
  if (msg.toolResult && typeof msg.toolResult.toolCallId === 'string') {
    return msg.toolResult.toolCallId.trim();
  }
  if (typeof (msg as Record<string, unknown>).tool_use_id === 'string' && ((msg as Record<string, unknown>).tool_use_id as string).trim()) {
    return ((msg as Record<string, unknown>).tool_use_id as string).trim();
  }
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b && typeof b === 'object') {
        const blk = b as Record<string, unknown>;
        if (blk.type === 'tool_result') {
          if (typeof blk.tool_use_id === 'string' && blk.tool_use_id.trim()) {
            return blk.tool_use_id.trim();
          }
          if (typeof blk.id === 'string' && blk.id.trim()) {
            return blk.id.trim();
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Collects all tool call IDs declared in an assistant message.
 */
export function getDeclaredToolCallIds(msg: HistoryMessage): string[] {
  if (!msg || msg.role !== 'assistant') return [];
  const ids: string[] = [];

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc && typeof tc.id === 'string' && tc.id.trim()) {
        ids.push(tc.id.trim());
      }
    }
  }

  if (Array.isArray(msg.toolCalls)) {
    for (const tc of msg.toolCalls) {
      if (tc && typeof tc.id === 'string' && tc.id.trim()) {
        ids.push(tc.id.trim());
      }
    }
  }

  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (b && typeof b === 'object') {
        const blk = b as Record<string, unknown>;
        if (blk.type === 'tool_use' && typeof blk.id === 'string' && blk.id.trim()) {
          ids.push(blk.id.trim());
        }
      }
    }
  }

  return ids;
}

/**
 * Default token estimator (~3.8 characters per token).
 */
export function defaultEstimateTokens(msg: HistoryMessage): number {
  if (!msg) return 0;
  let text = '';
  if (typeof msg.content === 'string') {
    text += msg.content;
  } else if (msg.content) {
    try {
      text += JSON.stringify(msg.content);
    } catch {
      text += String(msg.content);
    }
  }
  if (msg.tool_calls) {
    text += JSON.stringify(msg.tool_calls);
  }
  if (msg.toolCalls) {
    text += JSON.stringify(msg.toolCalls);
  }
  return Math.max(1, Math.ceil(text.length / 3.8));
}

/**
 * Slims tool result outputs older than recentStepsToKeep (default: 3 recent steps).
 * Preserves message wrappers, toolCallIds, and metadata intact to prevent orphan errors.
 */
export function slimToolResults<T extends HistoryMessage>(
  messages: T[],
  options?: SlimToolResultsOptions
): T[] {
  if (!messages || messages.length === 0) {
    return [];
  }

  const recentStepsToKeep = options?.recentStepsToKeep ?? 3;
  const maxTrimmedChars = options?.maxTrimmedChars ?? 150;

  // Identify all tool result message indices
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isToolResultMessage(messages[i])) {
      toolResultIndices.push(i);
    }
  }

  // If tool result count is within the recent threshold, no trimming needed
  if (toolResultIndices.length <= recentStepsToKeep) {
    return messages.map((m) => ({ ...m }));
  }

  // Indices to keep full output (the last recentStepsToKeep results)
  const fullOutputIndices = new Set(toolResultIndices.slice(-recentStepsToKeep));

  return messages.map((msg, idx) => {
    // If not a tool result or is within recent full output threshold, keep as-is
    if (!isToolResultMessage(msg) || fullOutputIndices.has(idx)) {
      return { ...msg };
    }

    // Determine current content length and tool name
    let contentStr = '';
    if (typeof msg.content === 'string') {
      contentStr = msg.content;
    } else if (msg.content != null) {
      try {
        contentStr = JSON.stringify(msg.content);
      } catch {
        contentStr = String(msg.content);
      }
    }

    const toolName = msg.name || msg.toolResult?.name;
    const originalLen = contentStr.length;

    // If already smaller than threshold, do not truncate
    if (originalLen <= maxTrimmedChars) {
      return { ...msg };
    }

    const placeholder = options?.placeholder
      ? options.placeholder(originalLen, toolName)
      : `[Tool result trimmed: ${originalLen} chars. Older than ${recentStepsToKeep} recent steps.]`;

    const slimmed: T = { ...msg, content: placeholder };

    if (msg.toolResult) {
      slimmed.toolResult = {
        ...msg.toolResult,
        content: placeholder,
      };
    }

    return slimmed;
  });
}

/**
 * Trims message history while strictly enforcing history invariants:
 * 1. Role 'user' first: result[0].role === 'user'.
 * 2. No orphaned tool call / result:
 *    - All tool results must match an assistant tool call present in history.
 *    - All assistant tool calls must have corresponding tool results (or be sanitized).
 * 3. Trims old tool outputs past 3 recent steps via slimToolResults().
 */
export function trimHistory<T extends HistoryMessage>(
  messages: T[],
  options?: TrimHistoryOptions
): T[] {
  if (!messages || messages.length === 0) {
    return [];
  }

  const recentStepsToKeep = options?.recentStepsToKeep ?? 3;
  const tokenEstimator = options?.estimateTokens ?? defaultEstimateTokens;

  // Step 1: Apply token discipline on tool results (trim older than 3 recent steps)
  let processed = slimToolResults(messages, { recentStepsToKeep });

  // Step 2: Slice to maxMessages / maxTokens if budget constraints are specified
  let sliceStart = 0;

  if (options?.maxMessages && options.maxMessages > 0 && processed.length > options.maxMessages) {
    sliceStart = processed.length - options.maxMessages;
  }

  if (options?.maxTokens && options.maxTokens > 0) {
    let accTokens = 0;
    let tokenSliceStart = processed.length;
    for (let i = processed.length - 1; i >= 0; i--) {
      const t = tokenEstimator(processed[i]);
      if (accTokens + t > options.maxTokens && i < processed.length - 1) {
        break;
      }
      accTokens += t;
      tokenSliceStart = i;
    }
    sliceStart = Math.max(sliceStart, tokenSliceStart);
  }

  // Step 3: Invariant 1 enforcement: History MUST start with role 'user'
  let userStart = -1;
  for (let i = sliceStart; i < processed.length; i++) {
    if (processed[i].role === 'user') {
      userStart = i;
      break;
    }
  }

  if (userStart === -1) {
    // Look backwards from sliceStart for the nearest preceding user message
    for (let i = sliceStart - 1; i >= 0; i--) {
      if (processed[i].role === 'user') {
        userStart = i;
        break;
      }
    }
  }

  let workingSlice: T[];
  if (userStart !== -1) {
    workingSlice = processed.slice(userStart);
  } else {
    // If no user message exists in entire list, synthesize an initial user anchor message
    const syntheticUser = {
      role: 'user',
      content: 'Start requested task.',
    } as T;
    workingSlice = [syntheticUser, ...processed.slice(sliceStart)];
  }

  // Step 4: Invariant 2 enforcement: No orphaned tool call / result
  // 4a. Identify all declared tool call IDs in assistant messages within workingSlice
  const declaredToolCallIds = new Set<string>();
  for (const msg of workingSlice) {
    if (msg.role === 'assistant') {
      for (const id of getDeclaredToolCallIds(msg)) {
        declaredToolCallIds.add(id);
      }
    }
  }

  // 4b. Remove orphaned tool results (tool results with no preceding assistant tool call)
  const withoutOrphanResults = workingSlice.filter((msg) => {
    if (!isToolResultMessage(msg)) {
      return true;
    }
    const resultId = getToolCallIdFromResult(msg);
    // If a tool result has an ID, it must match one of the declared tool call IDs in the slice
    if (resultId) {
      return declaredToolCallIds.has(resultId);
    }
    // If it has no tool call id but is marked as tool/toolResult without assistant, discard
    return false;
  });

  // 4c. Identify which declared tool call IDs actually received a tool result
  const resolvedToolCallIds = new Set<string>();
  for (const msg of withoutOrphanResults) {
    if (isToolResultMessage(msg)) {
      const id = getToolCallIdFromResult(msg);
      if (id) {
        resolvedToolCallIds.add(id);
      }
    }
  }

  // 4d. Clean up any assistant tool calls that have no matching result
  const cleanedMessages: T[] = [];

  for (const msg of withoutOrphanResults) {
    if (msg.role !== 'assistant') {
      cleanedMessages.push(msg);
      continue;
    }

    const declaredIds = getDeclaredToolCallIds(msg);
    if (declaredIds.length === 0) {
      cleanedMessages.push(msg);
      continue;
    }

    // Check if any tool calls are orphaned (missing tool result)
    const hasUnresolved = declaredIds.some((id) => !resolvedToolCallIds.has(id));
    if (!hasUnresolved) {
      cleanedMessages.push(msg);
      continue;
    }

    // Filter out unresolved tool calls from the assistant message
    const updatedMsg = { ...msg };

    if (Array.isArray(updatedMsg.tool_calls)) {
      updatedMsg.tool_calls = updatedMsg.tool_calls.filter(
        (tc) => tc?.id && resolvedToolCallIds.has(tc.id.trim())
      );
      if (updatedMsg.tool_calls.length === 0) {
        delete updatedMsg.tool_calls;
      }
    }

    if (Array.isArray(updatedMsg.toolCalls)) {
      updatedMsg.toolCalls = updatedMsg.toolCalls.filter(
        (tc) => tc?.id && resolvedToolCallIds.has(tc.id.trim())
      );
      if (updatedMsg.toolCalls.length === 0) {
        delete updatedMsg.toolCalls;
      }
    }

    // If assistant had only tool calls (no text content) and all were orphaned, drop message
    const contentText = typeof updatedMsg.content === 'string' ? updatedMsg.content.trim() : '';
    const hasRemainingCalls = Boolean(updatedMsg.tool_calls?.length || updatedMsg.toolCalls?.length);

    if (!contentText && !hasRemainingCalls) {
      continue;
    }

    cleanedMessages.push(updatedMsg);
  }

  // Step 5: Final pass: Re-verify Invariant 1 (role 'user' first)
  while (cleanedMessages.length > 0 && cleanedMessages[0].role !== 'user') {
    cleanedMessages.shift();
  }

  if (cleanedMessages.length === 0) {
    return [{ role: 'user', content: 'Start requested task.' } as T];
  }

  return cleanedMessages;
}
