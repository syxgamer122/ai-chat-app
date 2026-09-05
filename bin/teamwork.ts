#!/usr/bin/env node
/**
 * Headless CLI Entrypoint for Teamwork Multi-Agent Runtime Engine.
 * Conforms strictly to ORIGINAL_REQUEST.md R2 & PROJECT.md.
 */

import { main } from '../lib/teamwork/cli';

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
