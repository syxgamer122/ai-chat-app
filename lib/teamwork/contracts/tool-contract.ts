/**
 * Tool Contract Definition & Validation Factory.
 * Conforms to Anthropic Commerce-Agents pattern separating static schema rules from dynamic runtime context.
 */

import { z } from 'zod';
import {
  PreFlightGateResult,
  PostFlightReviewResult,
  RiskLevel,
  ToolCategory,
  ToolContract,
  ToolExecutionContext,
  ToolKind,
} from './types';

export interface DefineToolOptions<TInput, TOutput> {
  name: string;
  description: string;
  version?: string;
  kind?: ToolKind;
  category: ToolCategory;
  riskLevel?: RiskLevel;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  preFlightCheck?: (input: TInput, ctx: ToolExecutionContext) => Promise<PreFlightGateResult> | PreFlightGateResult;
  postFlightReview?: (output: TOutput, ctx: ToolExecutionContext) => Promise<PostFlightReviewResult> | PostFlightReviewResult;
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TOutput>;
}

/**
 * Creates a strongly-typed tool contract.
 */
export function defineToolContract<TInput, TOutput>(
  options: DefineToolOptions<TInput, TOutput>
): ToolContract<TInput, TOutput> {
  return {
    name: options.name,
    description: options.description,
    version: options.version ?? '1.0.0',
    kind: options.kind ?? 'execution',
    category: options.category,
    riskLevel: options.riskLevel ?? 'read',
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    preFlightCheck: options.preFlightCheck,
    postFlightReview: options.postFlightReview,
    execute: options.execute,
  };
}

/**
 * Defines a Presentation tool contract that emits visual or structured event annotations
 * without triggering destructive disk side-effects.
 */
export function definePresentationToolContract<TInput, TOutput>(
  options: Omit<DefineToolOptions<TInput, TOutput>, 'kind' | 'riskLevel'>
): ToolContract<TInput, TOutput> {
  return defineToolContract({
    ...options,
    kind: 'presentation',
    riskLevel: 'read',
  });
}

/**
 * Checks whether a tool contract is a pure presentation tool.
 */
export function isPresentationTool(contract: ToolContract<any, any>): boolean {
  return contract.kind === 'presentation';
}

/**
 * Validates raw input against the contract's static inputSchema.
 */
export function validateToolInput<TInput>(
  contract: ToolContract<TInput, any>,
  rawInput: unknown
): { success: true; data: TInput } | { success: false; error: z.ZodError; formattedError: string } {
  const parsed = contract.inputSchema.safeParse(rawInput);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  const formattedError = parsed.error.issues
    .map((issue) => `[${issue.path.join('.')}]: ${issue.message}`)
    .join('; ');
  return { success: false, error: parsed.error, formattedError };
}

/**
 * Validates tool execution output against the contract's static outputSchema.
 */
export function validateToolOutput<TOutput>(
  contract: ToolContract<any, TOutput>,
  output: unknown
): { success: true; data: TOutput } | { success: false; error: z.ZodError; formattedError: string } {
  const parsed = contract.outputSchema.safeParse(output);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  const formattedError = parsed.error.issues
    .map((issue) => `[${issue.path.join('.')}]: ${issue.message}`)
    .join('; ');
  return { success: false, error: parsed.error, formattedError };
}
