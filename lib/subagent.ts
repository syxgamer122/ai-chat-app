/**
 * Subagent Delegation — Goose-style lightweight subagent as emulated loop fork.
 *
 * Design principles (from Goose subagent_handler.rs + subagent_system.md):
 * 1. Context isolation: subagent gets FRESH message array (no parent history)
 * 2. No recursive spawning: subagent CANNOT call delegate (enforced by excluding
 *    'delegate' from its tool set)
 * 3. Bounded execution: max_turns cap (default 10, max 25)
 * 4. Same safety layers: guarded(), doom-loop detection, path-guard all apply
 * 5. Result extraction: last assistant text = subagent's answer
 *
 * Execution model: Fork runEmulatedLoop() with isolated messages + reduced tools.
 * Runs entirely CLIENT-side (like fs_*, shell_run) because it needs LLM access.
 */

import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import {
  runEmulatedLoop,
  type EmulatedLoopOptions,
  type EmulatedLoopResult,
} from '@/lib/emulated-agent';
import type { AgentToolSet } from '@/lib/agent-tools';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const SUBAGENT_DEFAULT_MAX_TURNS = 10;
export const SUBAGENT_ABSOLUTE_MAX_TURNS = 25;
export const SUBAGENT_DEFAULT_TIMEOUT_SECS = 300; // 5 minutes

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface SubagentOptions {
  /** Task instructions for the subagent. */
  instructions: string;
  /** Max turns (rounds) the subagent can use. Default 10, max 25. */
  maxTurns?: number;
  /** Timeout in seconds. Default 300 (5 min). */
  timeoutSecs?: number;
  /** Model to use (same as parent by default). */
  model: LanguageModel;
  /** System prompt base (workspace context, persona, etc.) — WITHOUT delegation guidance. */
  systemBase: string;
  /** Server tools available (web_search, memory, etc.). */
  serverTools: AgentToolSet;
  /** Client tool names available (fs_*, shell_run, git_*). NO 'delegate'. */
  clientToolNames: ReadonlySet<string>;
  /** Callback for client tool calls (same as parent's onClientToolCall). */
  onClientToolCall?: (call: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }) => void;
  /** Abort signal from parent. */
  abortSignal?: AbortSignal;
  /** Temperature override. */
  temperature?: number;
  /** Max tokens override. */
  maxTokens?: number;
  /** Progress callback for streaming annotations to UI. */
  onProgress?: (phase: 'start' | 'progress' | 'done', detail: Record<string, unknown>) => void;
}

export interface SubagentResult {
  /** The subagent's final answer/text. */
  result: string;
  /** Number of rounds used. */
  turnsUsed: number;
  /** Total tool calls made. */
  toolCalls: number;
  /** Whether the subagent completed normally or was cut off. */
  status: 'done' | 'max-turns' | 'aborted' | 'error';
  /** Error message if status is 'error'. */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* System prompt builder                                               */
/* ------------------------------------------------------------------ */

/**
 * Build subagent system prompt. Port from Goose subagent_system.md template.
 * Key rules: specialized, independent, bounded, NO recursive delegation.
 */
export function buildSubagentSystemPrompt(
  baseSystem: string,
  instructions: string,
  maxTurns: number,
): string {
  return [
    baseSystem,
    '',
    '# Subagent Role',
    '',
    'You are a SPECIALIZED SUBAGENT running within Vyen. Your purpose is to complete',
    'a specific, bounded task independently.',
    '',
    '## Rules',
    '',
    '- **Independence**: Make decisions and execute tools within your scope.',
    '- **Bounded Operation**: You have a MAXIMUM of ' + maxTurns + ' turns. Be efficient.',
    '- **NO Delegation**: You CANNOT call `delegate`. You are a leaf worker.',
    '- **Tool Efficiency**: Use minimum tools needed. No exploratory/curiosity usage.',
    '- **Clear Completion**: When done, provide a clear summary of what you accomplished.',
    '- **Markdown**: Format your response in markdown for readability.',
    '',
    '## Your Task',
    '',
    instructions,
    '',
    'Complete this task using available tools. When finished, summarize results clearly.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Core execution                                                      */
/* ------------------------------------------------------------------ */

/**
 * Run a subagent with isolated context. Forks runEmulatedLoop with:
 * - Fresh message array (only user task instruction)
 * - Reduced tool set (NO delegate — prevents recursion)
 * - Own maxRounds limit
 * - Own timeout
 *
 * Returns structured result with final text, turns used, tool calls count.
 */
export async function runSubagent(opts: SubagentOptions): Promise<SubagentResult> {
  const maxTurns = Math.min(
    Math.max(1, opts.maxTurns ?? SUBAGENT_DEFAULT_MAX_TURNS),
    SUBAGENT_ABSOLUTE_MAX_TURNS,
  );
  const timeoutMs = (opts.timeoutSecs ?? SUBAGENT_DEFAULT_TIMEOUT_SECS) * 1000;

  // Notify start
  opts.onProgress?.('start', { maxTurns, instructions: opts.instructions.slice(0, 200) });

  // Create abort controller with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Link parent abort signal
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  // Build isolated system prompt
  const system = buildSubagentSystemPrompt(
    opts.systemBase,
    opts.instructions,
    maxTurns,
  );

  // Collect text deltas to extract final answer
  const textParts: string[] = [];
  let lastAnnotation: Record<string, unknown> | null = null;

  try {
    const loopOpts: EmulatedLoopOptions = {
      model: opts.model,
      // ISOLATED messages — only the task instruction, no parent history
      messages: [
        { role: 'user', content: opts.instructions },
      ],
      system,
      tools: opts.serverTools,
      clientTools: opts.clientToolNames, // Already excludes 'delegate'
      onClientToolCall: opts.onClientToolCall,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      abortSignal: controller.signal,
      maxRounds: maxTurns,
      onTextDelta: (delta) => {
        textParts.push(delta);
        opts.onProgress?.('progress', { type: 'text', length: delta.length });
      },
      onReasoningLine: (line) => {
        opts.onProgress?.('progress', { type: 'reasoning', preview: line.slice(0, 100) });
      },
      onAnnotation: (payload) => {
        lastAnnotation = payload;
        opts.onProgress?.('progress', { type: 'tool', annotation: payload });
      },
    };

    const loopResult: EmulatedLoopResult = await runEmulatedLoop(loopOpts);

    clearTimeout(timeoutId);

    const resultText = textParts.join('').trim();

    if (controller.signal.aborted && opts.abortSignal?.aborted) {
      return {
        result: resultText || '(subagent aborted by parent)',
        turnsUsed: loopResult.roundsUsed,
        toolCalls: loopResult.totalCalls,
        status: 'aborted',
      };
    }

    if (loopResult.roundsUsed >= maxTurns && loopResult.status === 'done') {
      // Hit max turns but completed — might be truncated
      opts.onProgress?.('done', {
        turnsUsed: loopResult.roundsUsed,
        toolCalls: loopResult.totalCalls,
        hitMaxTurns: true,
      });
      return {
        result: resultText || '(subagent reached max turns without final answer)',
        turnsUsed: loopResult.roundsUsed,
        toolCalls: loopResult.totalCalls,
        status: 'max-turns',
      };
    }

    opts.onProgress?.('done', {
      turnsUsed: loopResult.roundsUsed,
      toolCalls: loopResult.totalCalls,
    });

    return {
      result: resultText || '(subagent completed with no text output)',
      turnsUsed: loopResult.roundsUsed,
      toolCalls: loopResult.totalCalls,
      status: 'done',
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (controller.signal.aborted) {
      return {
        result: textParts.join('').trim() || '(subagent timed out or aborted)',
        turnsUsed: 0,
        toolCalls: 0,
        status: controller.signal.aborted && !opts.abortSignal?.aborted ? 'aborted' : 'aborted',
      };
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    opts.onProgress?.('done', { error: errorMsg });
    return {
      result: '',
      turnsUsed: 0,
      toolCalls: 0,
      status: 'error',
      error: errorMsg,
    };
  }
}
