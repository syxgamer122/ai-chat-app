/**
 * Shell Execution Policy (TypeScript wrapper).
 * Exposes compiled shell command structures, validation, and safe environment utilities.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const policy = require('./shell-policy.cjs');

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export interface CompiledCommand {
  bin: string;
  args: string[];
}

export function tokenizeCommandLine(raw: string): string[] {
  return policy.tokenizeCommandLine(raw);
}

export function compileShellCommand(raw: string): CompiledCommand {
  return policy.compileShellCommand(raw);
}

export function getSafeEnv(): NodeJS.ProcessEnv {
  return policy.getSafeEnv();
}

export function killProcessTree(child: unknown): void {
  return policy.killProcessTree(child);
}
