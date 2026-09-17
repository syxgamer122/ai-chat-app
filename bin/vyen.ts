#!/usr/bin/env node
/**
 * Unified CLI Entrypoint for Vyen.
 *
 * Bảng lệnh (registry dữ liệu), help nhóm theo nhóm lệnh và điều phối sống ở
 * lib/cli/cli-surface.ts để test import được mà không spawn tiến trình; file
 * này chỉ là entry chạy thật qua tsx:
 *   npx tsx bin/vyen.ts            # help nhóm
 *   npx tsx bin/vyen.ts cli        # REPL tương tác (gõ /help, /tools)
 *   npx tsx bin/vyen.ts tool list  # catalog tool
 */

import { main } from '../lib/cli/cli-surface';

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
