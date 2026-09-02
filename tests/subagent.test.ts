/**
 * Tests for Subagent Delegation system.
 *
 * Covers:
 * - System prompt generation (buildSubagentSystemPrompt)
 * - Constants validation
 * - Result type structure
 * - No recursive delegation (delegate excluded from subagent tools)
 */

import { describe, it, expect } from 'vitest';
import {
  buildSubagentSystemPrompt,
  SUBAGENT_DEFAULT_MAX_TURNS,
  SUBAGENT_ABSOLUTE_MAX_TURNS,
  SUBAGENT_DEFAULT_TIMEOUT_SECS,
  type SubagentResult,
} from '@/lib/subagent';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

describe('subagent constants', () => {
  it('default max turns is reasonable', () => {
    expect(SUBAGENT_DEFAULT_MAX_TURNS).toBe(10);
  });

  it('absolute max turns caps at 25 (Goose default)', () => {
    expect(SUBAGENT_ABSOLUTE_MAX_TURNS).toBe(25);
  });

  it('default timeout is 5 minutes', () => {
    expect(SUBAGENT_DEFAULT_TIMEOUT_SECS).toBe(300);
  });

  it('default <= absolute max', () => {
    expect(SUBAGENT_DEFAULT_MAX_TURNS).toBeLessThanOrEqual(SUBAGENT_ABSOLUTE_MAX_TURNS);
  });
});

/* ------------------------------------------------------------------ */
/* System prompt builder                                               */
/* ------------------------------------------------------------------ */

describe('buildSubagentSystemPrompt', () => {
  const baseSystem = 'You are Koda, an AI coding assistant.';
  const instructions = 'Refactor the auth module to use JWT tokens.';

  it('includes base system prompt', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 10);
    expect(result).toContain(baseSystem);
  });

  it('includes task instructions', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 10);
    expect(result).toContain(instructions);
  });

  it('includes max turns limit', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 15);
    expect(result).toContain('15');
    expect(result).toContain('MAXIMUM');
  });

  it('explicitly forbids delegate tool (no recursion)', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 10);
    expect(result).toContain('CANNOT call `delegate`');
    expect(result).toContain('NO Delegation');
  });

  it('includes subagent role definition', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 10);
    expect(result).toContain('SPECIALIZED SUBAGENT');
    expect(result).toContain('Independence');
    expect(result).toContain('Bounded Operation');
  });

  it('includes tool efficiency rules', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 10);
    expect(result).toContain('Tool Efficiency');
    expect(result).toContain('minimum tools');
  });

  it('includes completion guidance', () => {
    const result = buildSubagentSystemPrompt(baseSystem, instructions, 10);
    expect(result).toContain('Clear Completion');
    expect(result).toContain('summarize');
  });

  it('handles empty instructions gracefully', () => {
    const result = buildSubagentSystemPrompt(baseSystem, '', 10);
    expect(result).toContain(baseSystem);
    expect(result).toContain('SPECIALIZED SUBAGENT');
  });

  it('handles long instructions without truncation', () => {
    const longInstructions = 'A'.repeat(5000);
    const result = buildSubagentSystemPrompt(baseSystem, longInstructions, 10);
    expect(result).toContain(longInstructions);
  });
});

/* ------------------------------------------------------------------ */
/* Result type structure                                                 */
/* ------------------------------------------------------------------ */

describe('SubagentResult type', () => {
  it('done result has required fields', () => {
    const result: SubagentResult = {
      result: 'Task completed successfully.',
      turnsUsed: 3,
      toolCalls: 5,
      status: 'done',
    };
    expect(result.status).toBe('done');
    expect(result.result).toBeTruthy();
    expect(result.turnsUsed).toBeGreaterThan(0);
  });

  it('error result includes error message', () => {
    const result: SubagentResult = {
      result: '',
      turnsUsed: 0,
      toolCalls: 0,
      status: 'error',
      error: 'Model API timeout',
    };
    expect(result.status).toBe('error');
    expect(result.error).toBeDefined();
  });

  it('max-turns result indicates truncation', () => {
    const result: SubagentResult = {
      result: 'Partial results...',
      turnsUsed: 25,
      toolCalls: 40,
      status: 'max-turns',
    };
    expect(result.status).toBe('max-turns');
    expect(result.turnsUsed).toBe(SUBAGENT_ABSOLUTE_MAX_TURNS);
  });

  it('aborted result for cancellation', () => {
    const result: SubagentResult = {
      result: '(subagent aborted)',
      turnsUsed: 2,
      toolCalls: 3,
      status: 'aborted',
    };
    expect(result.status).toBe('aborted');
  });
});
