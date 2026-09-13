/**
 * Code Mode — Thực thi mã JavaScript on-demand gọi MCP tools (Port từ Goose).
 *
 * Thay vì đăng ký hàng chục/hàng trăm tool MCP riêng lẻ vào LLM context,
 * Code Mode cung cấp duy nhất 1 công cụ `run_code(code)`.
 *
 * Trong môi trường sandbox:
 * - Inject sẵn đối tượng `mcp.call(serverId, toolName, args)`.
 * - Hỗ trợ top-level await và console.log.
 * - Giới hạn thời gian (timeout mặc định 30s).
 * - Output được cắt tối đa 24.000 ký tự (quy chuẩn Vyen / Goose).
 * - Vẫn tuân thủ đầy đủ cổng phê duyệt an toàn (auto-pilot / modal).
 */

import vm from 'node:vm';
import { z } from 'zod';
import { tool } from 'ai';

export const CODE_MODE_MAX_OUTPUT_CHARS = 24_000;
export const CODE_MODE_DEFAULT_TIMEOUT_MS = 30_000;

export interface CodeModeExecutionOptions {
  mcpCaller?: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface CodeModeResult {
  ok: boolean;
  output: string;
  returnValue?: unknown;
  error?: string;
  durationMs: number;
  truncated?: boolean;
}

/**
 * Truncate chuỗi output nếu vượt quá trần ký tự (24.000).
 */
export function truncateCodeOutput(
  text: string,
  maxChars = CODE_MODE_MAX_OUTPUT_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const notice = `\n\n[... Cắt ngắn: Kết quả vượt quá ${maxChars} ký tự quy chuẩn ...]`;
  return {
    text: text.slice(0, maxChars - notice.length) + notice,
    truncated: true,
  };
}

/**
 * Thực thi đoạn mã JavaScript trong sandbox Node.js VM.
 */
export async function executeCodeMode(
  code: string,
  options: CodeModeExecutionOptions = {},
): Promise<CodeModeResult> {
  const startTime = Date.now();
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? CODE_MODE_DEFAULT_TIMEOUT_MS, 1_000), 120_000);
  const maxChars = options.maxOutputChars ?? CODE_MODE_MAX_OUTPUT_CHARS;

  const logs: string[] = [];

  const captureLog = (...args: unknown[]) => {
    const line = args
      .map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a, null, 2) : String(a)))
      .join(' ');
    logs.push(line);
  };

  // Mock hoặc bridge cho mcp.call
  const mcpBridge = {
    call: async (serverId: string, toolName: string, args: Record<string, unknown> = {}) => {
      if (!options.mcpCaller) {
        throw new Error(`MCP caller chưa được cấu hình cho Code Mode khi gọi ${serverId}/${toolName}.`);
      }
      return await options.mcpCaller(serverId, toolName, args);
    },
  };

  const sandbox = {
    mcp: mcpBridge,
    console: {
      log: captureLog,
      info: captureLog,
      warn: captureLog,
      error: captureLog,
    },
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Promise,
    Map,
    Set,
    setTimeout,
    clearTimeout,
  };

  const context = vm.createContext(sandbox);

  // Đóng gói code vào async IIFE để hỗ trợ top-level await và return
  const wrappedScript = `(async () => {\n${code}\n})()`;

  try {
    const script = new vm.Script(wrappedScript, {
      filename: 'code-mode.js',
    });

    // Thực thi script trả về Promise
    const promise = script.runInContext(context, {
      timeout: timeoutMs,
      displayErrors: true,
    }) as Promise<unknown>;

    // Chờ promise với timeout race
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Thực thi mã quá thời gian cho phép (${timeoutMs / 1000}s).`));
      }, timeoutMs);
    });

    let rawResult: unknown;
    try {
      rawResult = await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const durationMs = Date.now() - startTime;
    const logOutput = logs.join('\n').trim();

    let combinedOutput = '';
    if (logOutput) {
      combinedOutput += logOutput;
    }
    if (rawResult !== undefined) {
      const returnFormatted =
        typeof rawResult === 'object' && rawResult !== null
          ? JSON.stringify(rawResult, null, 2)
          : String(rawResult);
      if (combinedOutput) combinedOutput += '\n\n[Return Value]:\n';
      combinedOutput += returnFormatted;
    }

    if (!combinedOutput) {
      combinedOutput = '(Mã thực thi thành công không có output)';
    }

    const { text: finalOutput, truncated } = truncateCodeOutput(combinedOutput, maxChars);

    return {
      ok: true,
      output: finalOutput,
      returnValue: rawResult,
      durationMs,
      truncated,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMsg = String(err instanceof Error ? err.message : err);
    const logOutput = logs.join('\n').trim();
    const errorOutput = logOutput ? `${logOutput}\n\n[Lỗi]: ${errorMsg}` : `[Lỗi]: ${errorMsg}`;
    const { text: finalOutput, truncated } = truncateCodeOutput(errorOutput, maxChars);

    return {
      ok: false,
      output: finalOutput,
      error: errorMsg,
      durationMs,
      truncated,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tool Definition                                                    */
/* ------------------------------------------------------------------ */

export const CODE_MODE_TOOL_NAME = 'run_code';

export const RUN_CODE_DEF = tool({
  description:
    'Thực thi đoạn mã JavaScript trong môi trường Node.js. ' +
    'Cung cấp sẵn `mcp.call(serverId, toolName, args)` (trả về Promise) để gọi các công cụ MCP theo kịch bản ' +
    'và xử lý kết quả trực tiếp mà không cần nhiều lượt hội thoại với LLM. ' +
    'Có sẵn console.log(...) để in kết quả.',
  parameters: z.object({
    code: z
      .string()
      .describe('Đoạn mã JavaScript cần thực thi. Hỗ trợ top-level await, mcp.call(...), console.log(...).'),
  }),
});
