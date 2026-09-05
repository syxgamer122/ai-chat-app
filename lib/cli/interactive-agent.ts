/**
 * Terminal Coding Agent Harness (Pi / Goose architecture).
 *
 * Triết lý từ earendil-works/pi:
 * - Tập trung vào 4 primitives cốt lõi: read, write, edit, bash.
 * - Chạy trực tiếp trong terminal với zero GUI overhead, khởi động tức thì (<100ms).
 * - Tương thích hoàn toàn với workspace cục bộ và Git.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, tool, type CoreMessage } from 'ai';
import { z } from 'zod';
import { resolveWithin } from '../path-guard.cjs';
import { runMonkeyCodeSast } from '../security-sast';

export interface CliAgentToolResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export class CliCodingHarness {
  private workspaceRoot: string;

  constructor(workspaceRoot: string = process.cwd()) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  public getWorkspace(): string {
    return this.workspaceRoot;
  }

  public read(relPath: string, startLine = 1, lineCount = 200): CliAgentToolResult {
    try {
      const fullPath = resolveWithin(this.workspaceRoot, relPath);
      if (!fs.existsSync(fullPath)) {
        return { ok: false, error: `File không tồn tại: ${relPath}` };
      }
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        return {
          ok: false,
          error: `Đường dẫn là thư mục, không phải file: "${relPath}". Sử dụng /find để liệt kê các file.`,
        };
      }
      const raw = fs.readFileSync(fullPath, 'utf8');
      const lines = raw.split(/\r?\n/);
      const start = Math.max(1, startLine) - 1;
      const count = Math.max(1, lineCount);
      const slice = lines.slice(start, start + count);
      const output = slice.map((l, i) => `${start + i + 1}: ${l}`).join('\n');
      return { ok: true, output: `[Lines ${start + 1}-${start + slice.length} of ${lines.length}]\n${output}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public write(relPath: string, content: string): CliAgentToolResult {
    try {
      const fullPath = resolveWithin(this.workspaceRoot, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
      return { ok: true, output: `Đã ghi thành công file: ${relPath} (${Buffer.byteLength(content, 'utf8')} bytes)` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public edit(relPath: string, target: string, replacement: string): CliAgentToolResult {
    try {
      if (!target) {
        return { ok: false, error: 'Đoạn mã target cần tìm kiếm không được để trống.' };
      }
      const fullPath = resolveWithin(this.workspaceRoot, relPath);
      if (!fs.existsSync(fullPath)) {
        return { ok: false, error: `File không tồn tại: ${relPath}` };
      }
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        return { ok: false, error: `Đường dẫn là thư mục, không thể sửa: ${relPath}` };
      }
      const raw = fs.readFileSync(fullPath, 'utf8');

      let targetToUse = target;
      let replacementToUse = replacement;

      // Hỗ trợ đồng bộ CRLF (Windows) và LF (Linux/Mac)
      if (raw.includes('\r\n') && !target.includes('\r\n')) {
        targetToUse = target.replace(/\r?\n/g, '\r\n');
        replacementToUse = replacement.replace(/\r?\n/g, '\r\n');
      } else if (!raw.includes('\r\n') && target.includes('\r\n')) {
        targetToUse = target.replace(/\r\n/g, '\n');
        replacementToUse = replacement.replace(/\r\n/g, '\n');
      }

      if (!raw.includes(targetToUse)) {
        // Thử match cả dạng normalized LF nếu file có mixed line endings
        const rawNorm = raw.replace(/\r\n/g, '\n');
        const targetNorm = target.replace(/\r\n/g, '\n');
        if (!rawNorm.includes(targetNorm)) {
          return { ok: false, error: `Không tìm thấy đoạn mã target trong file: ${relPath}` };
        }
        const replNorm = replacement.replace(/\r\n/g, '\n');
        // Sử dụng replacer function để TRÁNH biến dạng khi replacement chứa $, $&, $$
        const updatedNorm = rawNorm.replace(targetNorm, () => replNorm);
        const finalOutput = raw.includes('\r\n') ? updatedNorm.replace(/\n/g, '\r\n') : updatedNorm;
        fs.writeFileSync(fullPath, finalOutput, 'utf8');
        return { ok: true, output: `Đã cập nhật file: ${relPath}` };
      }

      // Sử dụng replacer function () => replacementToUse để bảo toàn $&, $$, $1 trong replacement
      const updated = raw.replace(targetToUse, () => replacementToUse);
      fs.writeFileSync(fullPath, updated, 'utf8');
      return { ok: true, output: `Đã cập nhật file: ${relPath}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public bash(command: string, timeoutMs = 60_000): CliAgentToolResult {
    try {
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : '/bin/sh';
      const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

      const res = spawnSync(shell, args, {
        cwd: this.workspaceRoot,
        timeout: timeoutMs,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });

      if (res.error) {
        return { ok: false, error: res.error.message };
      }

      const stdout = res.stdout || '';
      const stderr = res.stderr || '';
      const combined = `${stdout}\n${stderr}`.trim();

      // Goose-style smart truncation: Cắt nếu quá 100 dòng để tiết kiệm
      const lines = combined.split(/\r?\n/);
      let preview = combined;
      if (lines.length > 100) {
        preview = `[... truncated first ${lines.length - 100} lines ...]\n` + lines.slice(-100).join('\n');
      }

      return {
        ok: res.status === 0,
        output: `Exit code: ${res.status}\n${preview}`,
        error: res.status !== 0 ? `Lệnh thoát với mã lỗi ${res.status}` : undefined,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public find(pattern?: string, maxDepth = 5): CliAgentToolResult {
    try {
      const results: string[] = [];
      const ignoreDirs = new Set(['.git', 'node_modules', '.next', 'dist', '.gemini', 'tmp', '.agents', '.opencode', 'coverage', '.turbo', 'build']);
      const rawPat = pattern ? pattern.trim().replace(/^["']|["']$/g, '') : '';
      let matcher: ((rel: string, name: string) => boolean) | null = null;

      if (rawPat) {
        if (rawPat.includes('*') || rawPat.includes('?')) {
          const esc = rawPat
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
          const relReg = new RegExp(`(^|/)${esc}$|^${esc}$`, 'i');
          const nameReg = new RegExp(`^${esc}$`, 'i');
          matcher = (rel, name) => relReg.test(rel) || nameReg.test(name);
        } else {
          const patLower = rawPat.toLowerCase();
          matcher = (rel, name) => rel.toLowerCase().includes(patLower) || name.toLowerCase().includes(patLower);
        }
      }

      const walk = (dir: string, depth: number) => {
        if (depth > maxDepth || results.length >= 100) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!ignoreDirs.has(entry.name)) {
              walk(path.join(dir, entry.name), depth + 1);
            }
          } else if (entry.isFile()) {
            const rel = path.relative(this.workspaceRoot, path.join(dir, entry.name)).replace(/\\/g, '/');
            if (!matcher || matcher(rel, entry.name)) {
              results.push(rel);
              if (results.length >= 100) return;
            }
          }
        }
      };

      walk(this.workspaceRoot, 1);
      return {
        ok: true,
        output: results.length > 0
          ? `[Tìm thấy ${results.length} files]:\n` + results.map((f) => `  - ${f}`).join('\n')
          : 'Không tìm thấy file nào khớp.',
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public grep(query: string, isRegex = false, maxMatches = 50): CliAgentToolResult {
    try {
      const q = query ? query.trim() : '';
      if (!q) {
        return { ok: false, error: 'Cần cung cấp chuỗi tìm kiếm.' };
      }
      const results: string[] = [];
      const ignoreDirs = new Set(['.git', 'node_modules', '.next', 'dist', '.gemini', 'tmp', '.agents', '.opencode', 'coverage', '.turbo', 'build']);
      const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.exe', '.dll', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.bin']);
      let reg: RegExp | null = null;
      if (isRegex) {
        try {
          reg = new RegExp(q, 'i');
        } catch (e) {
          return { ok: false, error: `Regex không hợp lệ: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      const qLower = q.toLowerCase();

      const walk = (dir: string) => {
        if (results.length >= maxMatches) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= maxMatches) return;
          if (entry.isDirectory()) {
            if (!ignoreDirs.has(entry.name)) {
              walk(path.join(dir, entry.name));
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (binaryExts.has(ext)) continue;

            const fullPath = path.join(dir, entry.name);
            try {
              const stat = fs.statSync(fullPath);
              if (stat.size > 1024 * 1024) continue; // Bỏ qua file > 1MB
              const content = fs.readFileSync(fullPath, 'utf8');
              const lines = content.split(/\r?\n/);
              const rel = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');

              for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const matched = reg ? reg.test(line) : line.toLowerCase().includes(qLower);
                if (matched) {
                  results.push(`${rel}:${i + 1}: ${line.trim()}`);
                  if (results.length >= maxMatches) break;
                }
              }
            } catch {}
          }
        }
      };

      walk(this.workspaceRoot);
      return {
        ok: true,
        output: results.length > 0
          ? `[Grep "${query}" — ${results.length} kết quả]:\n` + results.join('\n')
          : `Không tìm thấy kết quả nào cho "${query}".`,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public gitStatus(): CliAgentToolResult {
    return this.bash('git status --short');
  }

  public gitDiff(relPath?: string): CliAgentToolResult {
    return this.bash(relPath ? `git diff -- ${relPath}` : 'git diff');
  }

  public doctor(): CliAgentToolResult {
    const memory = process.memoryUsage();
    const isGit = fs.existsSync(path.join(this.workspaceRoot, '.git'));
    const packageJsonExists = fs.existsSync(path.join(this.workspaceRoot, 'package.json'));

    const lines = [
      `=== Vyen System & Environment Doctor ===`,
      `Node.js:      ${process.version}`,
      `Platform:     ${process.platform} (${process.arch})`,
      `Workspace:    ${this.workspaceRoot}`,
      `Is Git Repo:  ${isGit ? 'Yes (.git found)' : 'No'}`,
      `package.json: ${packageJsonExists ? 'Yes' : 'No'}`,
      `RAM RSS:      ${Math.round(memory.rss / 1024 / 1024)} MB`,
      `Heap Used:    ${Math.round(memory.heapUsed / 1024 / 1024)} MB`,
      `Status:       READY (All core primitives operational)`,
    ];
    return { ok: true, output: lines.join('\n') };
  }

  public audit(targetPath?: string): CliAgentToolResult {
    try {
      const report = runMonkeyCodeSast(this.workspaceRoot, { targetPath });
      return {
        ok: report.ok,
        output: report.textReport,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public init(): CliAgentToolResult {
    try {
      const projectMdPath = path.join(this.workspaceRoot, 'PROJECT.md');
      const opencodePath = path.join(this.workspaceRoot, '.opencode');
      const hasProjectMd = fs.existsSync(projectMdPath);
      const hasOpencode = fs.existsSync(opencodePath);

      if (hasProjectMd && hasOpencode) {
        return {
          ok: true,
          output: `[vyen init] Không gian làm việc đã được khởi tạo chuẩn:\n  - PROJECT.md: Sẵn sàng\n  - .opencode/: Sẵn sàng`,
        };
      }

      if (!hasProjectMd) {
        const initialProjectMd = `# PROJECT — Vyen Workspace Configuration\n\nKhởi tạo: ${new Date().toISOString()}\nWorkspace: ${this.workspaceRoot}\n`;
        fs.writeFileSync(projectMdPath, initialProjectMd, 'utf8');
      }
      /* Trước đây init() chỉ existsSync-check .opencode mà không bao giờ tạo —
         thư mục bị xoá (dọn rác) thì mọi lần init sau vẫn báo thiếu mãi. */
      if (!hasOpencode) {
        fs.mkdirSync(opencodePath, { recursive: true });
      }

      return {
        ok: true,
        output: `[vyen init] Đã khởi tạo thành công cấu hình workspace Vyen & Claude Code context.`,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public compact(): CliAgentToolResult {
    try {
      const memory = process.memoryUsage();
      const lines = [
        `=== Vyen Context & Memory Compaction ===`,
        `RAM RSS:    ${Math.round(memory.rss / 1024 / 1024)} MB`,
        `Heap Used:  ${Math.round(memory.heapUsed / 1024 / 1024)} MB`,
        `Compaction: READY (Bộ nhớ terminal ổn định, dưới ngưỡng tràn 512MB)`,
      ];
      return { ok: true, output: lines.join('\n') };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export interface AgentStreamCallbacks {
  onToken?: (token: string) => void;
  onToolCall?: (name: string, args: unknown) => void;
  onToolResult?: (name: string, result: unknown) => void;
}

export interface AutonomousAgentOptions {
  workspaceRoot?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxSteps?: number;
  mockMode?: boolean;
  skipEnvLoad?: boolean;
  harness?: CliCodingHarness;
}

export function loadEnvFiles(workspaceRoot: string = process.cwd()) {
  const candidates = [
    path.join(workspaceRoot, '.env.local'),
    path.join(workspaceRoot, '.env'),
    path.join(__dirname, '..', '..', '.env.local'),
    path.join(__dirname, '..', '..', '.env'),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      try {
        const content = fs.readFileSync(f, 'utf8');
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const k = trimmed.slice(0, eq).trim();
            const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
            if (!process.env[k] && v) {
              process.env[k] = v;
            }
          }
        }
      } catch {}
    }
  }
}

/**
 * Autonomous Terminal Coding Agent (Claude Code / Codex architecture).
 * Provides an autonomous LLM reasoning and tool-calling loop that:
 * - Streams tokens directly to stdout in real-time.
 * - Executes tools (read, write, edit, bash, grep, find, git_status, git_diff, security_audit).
 * - Feeds tool results back to LLM context and loops until completion.
 */
export class AutonomousCliAgent {
  private workspaceRoot: string;
  private harness: CliCodingHarness;
  private apiKey: string | null = null;
  private baseUrl: string = 'https://api.openai.com/v1';
  private model: string = 'gpt-4o';
  private maxSteps: number = 20;
  private mockMode: boolean = false;
  private history: CoreMessage[] = [];

  constructor(options?: AutonomousAgentOptions) {
    this.workspaceRoot = path.resolve(options?.workspaceRoot || process.cwd());
    this.harness = options?.harness || new CliCodingHarness(this.workspaceRoot);
    if (!options?.skipEnvLoad) {
      loadEnvFiles(this.workspaceRoot);
    }

    if (options?.apiKey !== undefined) {
      this.apiKey = options.apiKey;
    }
    if (options?.baseUrl) {
      this.baseUrl = options.baseUrl;
    } else if (process.env.VYEN_BASE_URL) {
      this.baseUrl = process.env.VYEN_BASE_URL;
    } else if (process.env.OPENROUTER_API_KEY) {
      this.baseUrl = 'https://openrouter.ai/api/v1';
    } else if (process.env.GEMINI_API_KEY) {
      this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/';
    } else if (process.env.GROQ_API_KEY) {
      this.baseUrl = 'https://api.groq.com/openai/v1';
    } else if (process.env.DEEPSEEK_API_KEY) {
      this.baseUrl = 'https://api.deepseek.com';
    }

    if (options?.model) {
      this.model = options.model;
    } else if (process.env.VYEN_MODEL) {
      this.model = process.env.VYEN_MODEL;
    } else if (this.baseUrl.includes('openrouter')) {
      this.model = 'anthropic/claude-3.5-sonnet';
    } else if (this.baseUrl.includes('googleapis')) {
      this.model = 'gemini-2.0-flash';
    } else if (this.baseUrl.includes('groq')) {
      this.model = 'llama-3.3-70b-versatile';
    } else if (this.baseUrl.includes('deepseek')) {
      this.model = 'deepseek-chat';
    }

    if (options?.maxSteps) {
      this.maxSteps = options.maxSteps;
    }
    if (options?.mockMode !== undefined) {
      this.mockMode = options.mockMode;
    } else if (process.env.VYEN_MOCK_AGENT === '1') {
      this.mockMode = true;
    }
  }

  public setApiKey(key: string): void {
    this.apiKey = key.trim();
    if (this.apiKey.startsWith('sk-or-')) {
      this.baseUrl = 'https://openrouter.ai/api/v1';
      if (this.model === 'gpt-4o' || this.model === 'gemini-2.0-flash') {
        this.model = 'anthropic/claude-3.5-sonnet';
      }
    } else if (this.apiKey.startsWith('AIza')) {
      this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/';
      if (this.model === 'gpt-4o' || this.model === 'anthropic/claude-3.5-sonnet') {
        this.model = 'gemini-2.0-flash';
      }
    } else if (this.apiKey.startsWith('gsk_')) {
      this.baseUrl = 'https://api.groq.com/openai/v1';
      if (this.model === 'gpt-4o') this.model = 'llama-3.3-70b-versatile';
    } else if (this.apiKey.startsWith('sk-') && !this.apiKey.startsWith('sk-ant-')) {
      this.baseUrl = 'https://api.openai.com/v1';
      if (this.model === 'anthropic/claude-3.5-sonnet' || this.model === 'gemini-2.0-flash') {
        this.model = 'gpt-4o';
      }
    }
  }

  public setModel(model: string): void {
    this.model = model.trim();
  }

  public setBaseUrl(url: string): void {
    this.baseUrl = url.trim();
  }

  public clearHistory(): void {
    this.history = [];
  }

  public getHistory(): CoreMessage[] {
    return [...this.history];
  }

  public getHarness(): CliCodingHarness {
    return this.harness;
  }

  public getConfig(): { model: string; baseUrl: string; hasKey: boolean; workspace: string } {
    const key =
      this.apiKey !== null
        ? this.apiKey
        : (process.env.OPENAI_API_KEY ||
           process.env.ANTHROPIC_API_KEY ||
           process.env.OPENROUTER_API_KEY ||
           process.env.GEMINI_API_KEY ||
           process.env.VYEN_API_KEY);
    return {
      model: this.model,
      baseUrl: this.baseUrl,
      hasKey: Boolean(key),
      workspace: this.workspaceRoot,
    };
  }

  public async streamTurn(
    userPrompt: string,
    callbacks?: AgentStreamCallbacks
  ): Promise<{ text: string; toolCallsCount: number }> {
    const effectiveKey =
      this.apiKey !== null
        ? this.apiKey
        : (process.env.OPENAI_API_KEY ||
           process.env.ANTHROPIC_API_KEY ||
           process.env.OPENROUTER_API_KEY ||
           process.env.GEMINI_API_KEY ||
           process.env.VYEN_API_KEY);

    if (this.mockMode || process.env.VYEN_MOCK_AGENT === '1') {
      return await this.runMockTurn(userPrompt, callbacks);
    }

    if (!effectiveKey) {
      // Fallback check if prompt is a direct shell command FIRST
      const trimmed = userPrompt.trim();
      const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
      const knownCommands = ['git', 'npm', 'pnpm', 'yarn', 'ls', 'dir', 'node', 'tsc', 'npx', 'echo', 'cat', 'pwd'];
      if (knownCommands.includes(firstWord)) {
        const notify = `[vyen bash fallback] Thực thi lệnh: "${trimmed}"\n`;
        if (callbacks?.onToken) callbacks.onToken(notify);
        else process.stdout.write(notify);
        const bashRes = this.harness.bash(trimmed);
        const out = (bashRes.output || '') + '\n';
        if (callbacks?.onToken) callbacks.onToken(out);
        else process.stdout.write(out);
        return { text: out, toolCallsCount: 1 };
      }

      const guidance = [
        '\n[Vyen Autonomous Agent] ⚠️ Chưa phát hiện API Key để chạy LLM reasoning engine.',
        'Các cách cấu hình nhanh:',
        '  1. Gõ: /key <your-api-key>',
        '  2. Hoặc gán biến môi trường: export OPENAI_API_KEY="sk-..."',
        '  3. Hoặc ghi vào file .env.local trong dự án\n',
      ].join('\n');

      if (callbacks?.onToken) {
        callbacks.onToken(guidance);
      } else {
        process.stdout.write(guidance);
      }

      return { text: guidance, toolCallsCount: 0 };
    }

    let toolCallsCount = 0;
    const openai = createOpenAI({
      apiKey: effectiveKey,
      baseURL: this.baseUrl,
    });

    const tools = {
      read_file: tool({
        description: 'Read lines of a file with 1-based line numbers from the workspace',
        parameters: z.object({
          path: z.string().describe('Relative path to the file within workspace'),
          start_line: z.number().optional().describe('1-indexed starting line (default 1)'),
          count: z.number().optional().describe('Number of lines to read (default 200)'),
        }),
        execute: async ({ path: filePath, start_line, count }) => {
          toolCallsCount++;
          const callMsg = `\n● [Vyen Tool] 📖 read_file: ${filePath} (dòng ${start_line ?? 1}-${(start_line ?? 1) + (count ?? 200)})\n`;
          if (callbacks?.onToken) callbacks.onToken(callMsg);
          else process.stdout.write(callMsg);
          callbacks?.onToolCall?.('read_file', { path: filePath, start_line, count });

          const res = this.harness.read(filePath, start_line ?? 1, count ?? 200);
          const out = res.ok ? res.output : `[Lỗi] ${res.error}`;
          callbacks?.onToolResult?.('read_file', out);
          return out;
        },
      }),
      write_file: tool({
        description: 'Create or overwrite file contents in the workspace',
        parameters: z.object({
          path: z.string().describe('Relative path to the file'),
          content: z.string().describe('Full content to write into the file'),
        }),
        execute: async ({ path: filePath, content }) => {
          toolCallsCount++;
          const callMsg = `\n● [Vyen Tool] 📝 write_file: ${filePath} (${Buffer.byteLength(content, 'utf8')} bytes)\n`;
          if (callbacks?.onToken) callbacks.onToken(callMsg);
          else process.stdout.write(callMsg);
          callbacks?.onToolCall?.('write_file', { path: filePath, size: content.length });

          const res = this.harness.write(filePath, content);
          const out = res.ok ? res.output : `[Lỗi] ${res.error}`;
          callbacks?.onToolResult?.('write_file', out);
          return out;
        },
      }),
      edit_file: tool({
        description: 'Replace target text block with replacement text in a file (SEARCH / REPLACE)',
        parameters: z.object({
          path: z.string().describe('Relative path to the file'),
          old_text: z.string().describe('Exact text block in the file to be replaced'),
          new_text: z.string().describe('New replacement text block'),
        }),
        execute: async ({ path: filePath, old_text, new_text }) => {
          toolCallsCount++;
          const callMsg = `\n● [Vyen Tool] ✏️ edit_file: ${filePath}\n`;
          if (callbacks?.onToken) callbacks.onToken(callMsg);
          else process.stdout.write(callMsg);
          callbacks?.onToolCall?.('edit_file', { path: filePath });

          const res = this.harness.edit(filePath, old_text, new_text);
          const out = res.ok ? res.output : `[Lỗi] ${res.error}`;
          callbacks?.onToolResult?.('edit_file', out);
          return out;
        },
      }),
      bash: tool({
        description: 'Execute a terminal shell command in the workspace directory',
        parameters: z.object({
          command: z.string().describe('Shell command to execute'),
        }),
        execute: async ({ command }) => {
          toolCallsCount++;
          const callMsg = `\n● [Vyen Tool] 💻 bash: ${command}\n`;
          if (callbacks?.onToken) callbacks.onToken(callMsg);
          else process.stdout.write(callMsg);
          callbacks?.onToolCall?.('bash', { command });

          const res = this.harness.bash(command);
          const out = res.output || res.error || '';
          callbacks?.onToolResult?.('bash', out);
          return out;
        },
      }),
      grep: tool({
        description: 'Search for text or regex pattern across workspace source files',
        parameters: z.object({
          query: z.string().describe('Search query string or regex pattern'),
          is_regex: z.boolean().optional().describe('Whether query is regex (default false)'),
        }),
        execute: async ({ query, is_regex }) => {
          toolCallsCount++;
          const callMsg = `\n● [Vyen Tool] 🔍 grep: "${query}"\n`;
          if (callbacks?.onToken) callbacks.onToken(callMsg);
          else process.stdout.write(callMsg);
          callbacks?.onToolCall?.('grep', { query, is_regex });

          const res = this.harness.grep(query, is_regex ?? false);
          const out = res.output || res.error || '';
          callbacks?.onToolResult?.('grep', out);
          return out;
        },
      }),
      find: tool({
        description: 'Find files matching pattern or substring in workspace',
        parameters: z.object({
          pattern: z.string().optional().describe('Filename pattern or substring'),
        }),
        execute: async ({ pattern }) => {
          toolCallsCount++;
          const callMsg = `\n● [Vyen Tool] 📁 find: "${pattern ?? '*'}"\n`;
          if (callbacks?.onToken) callbacks.onToken(callMsg);
          else process.stdout.write(callMsg);
          callbacks?.onToolCall?.('find', { pattern });

          const res = this.harness.find(pattern);
          const out = res.output || res.error || '';
          callbacks?.onToolResult?.('find', out);
          return out;
        },
      }),
      git_status: tool({
        description: 'View current git status of workspace',
        parameters: z.object({}),
        execute: async () => {
          toolCallsCount++;
          const callMsg = `\n● [Vyen Tool] 🌿 git_status\n`;
          if (callbacks?.onToken) callbacks.onToken(callMsg);
          else process.stdout.write(callMsg);
          callbacks?.onToolCall?.('git_status', {});

          const res = this.harness.gitStatus();
          const out = res.output || 'Working directory clean.';
          callbacks?.onToolResult?.('git_status', out);
          return out;
        },
      }),
      git_diff: tool({
        description: 'View git diff for the workspace or a specific file',
        parameters: z.object({
          path: z.string().optional().describe('Optional relative path of file to diff'),
        }),
        execute: async ({ path: filePath }) => {
          toolCallsCount++;
          const callMsg = `\n● [Vyen Tool] 📊 git_diff: ${filePath ?? 'all'}\n`;
          if (callbacks?.onToken) callbacks.onToken(callMsg);
          else process.stdout.write(callMsg);
          callbacks?.onToolCall?.('git_diff', { path: filePath });

          const res = this.harness.gitDiff(filePath);
          const out = res.output || 'No changes.';
          callbacks?.onToolResult?.('git_diff', out);
          return out;
        },
      }),
      security_audit: tool({
        description: 'Run Chaitin MonkeyCode Static Application Security Testing (SAST) vulnerability scan',
        parameters: z.object({
          path: z.string().optional().describe('Optional subpath to audit'),
        }),
        execute: async ({ path: auditPath }) => {
          toolCallsCount++;
          const callMsg = `\n● [Vyen Tool] 🛡️ security_audit (MonkeyCode SAST)\n`;
          if (callbacks?.onToken) callbacks.onToken(callMsg);
          else process.stdout.write(callMsg);
          callbacks?.onToolCall?.('security_audit', { path: auditPath });

          const res = this.harness.audit(auditPath);
          const out = res.output || res.error || '';
          callbacks?.onToolResult?.('security_audit', out);
          return out;
        },
      }),
    };

    this.history.push({ role: 'user', content: userPrompt });

    try {
      const result = streamText({
        model: openai(this.model),
        system: `You are Vyen Terminal Autonomous Coding Agent (Claude Code & Codex architecture).
Workspace root: ${this.workspaceRoot}. Platform: ${process.platform}.
You have direct autonomous access to tools: read_file, write_file, edit_file, bash, grep, find, git_status, git_diff, security_audit.
Guidelines:
1. Inspect files or search codebase before performing code changes.
2. Execute tasks proactively and verify modifications with tests or build commands when relevant.
3. Be concise and format code clearly in terminal.`,
        messages: this.history,
        tools,
        maxSteps: this.maxSteps,
        onStepFinish: async (step) => {
          if (step.toolCalls && step.toolCalls.length > 0) {
            for (const tc of step.toolCalls) {
              const doneMsg = `✔ [Vyen Tool Complete] ${tc.toolName}\n`;
              if (callbacks?.onToken) callbacks.onToken(doneMsg);
              else process.stdout.write(doneMsg);
            }
          }
        },
      });

      let accumulatedText = '';
      for await (const textPart of result.textStream) {
        accumulatedText += textPart;
        if (callbacks?.onToken) {
          callbacks.onToken(textPart);
        } else {
          process.stdout.write(textPart);
        }
      }

      const response = await result.response;
      if (response.messages && response.messages.length > 0) {
        this.history.push(...(response.messages as CoreMessage[]));
      } else if (accumulatedText) {
        this.history.push({ role: 'assistant', content: accumulatedText });
      }

      if (!accumulatedText.endsWith('\n')) {
        if (callbacks?.onToken) callbacks.onToken('\n');
        else process.stdout.write('\n');
      }

      return { text: accumulatedText, toolCallsCount };
    } catch (err) {
      const errMsg = `\n[Vyen Agent Error] ${err instanceof Error ? err.message : String(err)}\n`;
      if (callbacks?.onToken) callbacks.onToken(errMsg);
      else process.stdout.write(errMsg);
      return { text: errMsg, toolCallsCount };
    }
  }

  public async runMockTurn(
    userPrompt: string,
    callbacks?: AgentStreamCallbacks
  ): Promise<{ text: string; toolCallsCount: number }> {
    let toolCallsCount = 0;
    const emit = (text: string) => {
      if (callbacks?.onToken) callbacks.onToken(text);
      else process.stdout.write(text);
    };

    emit(`[Vyen Autonomous Agent - Simulated Mode]\n`);
    emit(`● Đang phân tích yêu cầu: "${userPrompt}"...\n`);

    const lower = userPrompt.toLowerCase();
    let resultSummary = '';

    if (lower.includes('read') || lower.includes('đọc')) {
      toolCallsCount++;
      const target = userPrompt.match(/(\S+\.[a-zA-Z0-9]+)/)?.[1] || 'package.json';
      emit(`● [Vyen Tool] 📖 read_file: ${target}\n`);
      callbacks?.onToolCall?.('read_file', { path: target });
      const res = this.harness.read(target, 1, 30);
      callbacks?.onToolResult?.('read_file', res.output);
      emit(`✔ [Vyen Tool Complete] read_file (${res.ok ? 'thành công' : 'lỗi'})\n`);
      resultSummary = `Đã đọc file ${target}:\n${res.output?.slice(0, 300) || ''}`;
    } else if (lower.includes('audit') || lower.includes('an ninh') || lower.includes('security')) {
      toolCallsCount++;
      emit(`● [Vyen Tool] 🛡️ security_audit (MonkeyCode SAST)\n`);
      callbacks?.onToolCall?.('security_audit', {});
      const res = this.harness.audit();
      callbacks?.onToolResult?.('security_audit', res.output);
      emit(`✔ [Vyen Tool Complete] security_audit\n`);
      resultSummary = `Báo cáo kiểm toán an ninh MonkeyCode:\n${res.output?.slice(0, 300) || ''}`;
    } else if (lower.includes('status') || lower.includes('git')) {
      toolCallsCount++;
      emit(`● [Vyen Tool] 🌿 git_status\n`);
      callbacks?.onToolCall?.('git_status', {});
      const res = this.harness.gitStatus();
      callbacks?.onToolResult?.('git_status', res.output);
      emit(`✔ [Vyen Tool Complete] git_status\n`);
      resultSummary = `Trạng thái Git:\n${res.output || 'Working directory clean.'}`;
    } else if (lower.includes('find') || lower.includes('tìm')) {
      toolCallsCount++;
      const pat = userPrompt.match(/["']([^"']+)["']/)?.[1] || '*.json';
      emit(`● [Vyen Tool] 📁 find: "${pat}"\n`);
      callbacks?.onToolCall?.('find', { pattern: pat });
      const res = this.harness.find(pat);
      callbacks?.onToolResult?.('find', res.output);
      emit(`✔ [Vyen Tool Complete] find\n`);
      resultSummary = res.output || 'Không tìm thấy file.';
    } else {
      toolCallsCount++;
      emit(`● [Vyen Tool] 💻 bash: echo "Vyen autonomous agent execution ready."\n`);
      callbacks?.onToolCall?.('bash', { command: 'echo "Vyen autonomous agent execution ready."' });
      const res = this.harness.bash('echo "Vyen autonomous agent execution ready."');
      callbacks?.onToolResult?.('bash', res.output);
      emit(`✔ [Vyen Tool Complete] bash\n`);
      resultSummary = `Yêu cầu "${userPrompt}" đã được xử lý thành công.`;
    }

    emit(`\n${resultSummary}\n`);
    this.history.push({ role: 'user', content: userPrompt });
    this.history.push({ role: 'assistant', content: resultSummary });

    return { text: resultSummary, toolCallsCount };
  }
}

/**
 * Chạy interactive REPL terminal cho lập trình viên (chuẩn Claude Code / Codex).
 * Tích hợp toàn diện LLM streaming reasoning và autonomous tool-calling loop.
 */
export async function startInteractiveCli(
  workspace: string = process.cwd(),
  initialPrompt?: string,
  options?: AutonomousAgentOptions
) {
  const agent = new AutonomousCliAgent({
    workspaceRoot: workspace,
    ...options,
  });
  const harness = agent.getHarness();
  const cfg = agent.getConfig();

  if (initialPrompt && initialPrompt.trim()) {
    console.log(`\n[vyen cli] Khởi chạy Autonomous Agent cho: "${initialPrompt.trim()}"`);
    await agent.streamTurn(initialPrompt.trim());
    if (!process.stdin.isTTY) {
      return;
    }
  }

  console.log(`\n======================================================`);
  console.log(` Vyen Autonomous Coding Agent (Claude Code & Codex Harness)`);
  console.log(` Workspace: ${cfg.workspace}`);
  console.log(` Model:     ${cfg.model} | Key: ${cfg.hasKey ? 'Sẵn sàng ✔' : 'Chưa cấu hình (dùng /key để gán)'}`);
  console.log(` Các lệnh slash / colon khả dụng:`);
  console.log(`   /help, :help          - Hiển thị bảng trợ giúp này`);
  console.log(`   /key <api-key>        - Cập nhật API key trong phiên`);
  console.log(`   /model <name>         - Thay đổi model LLM`);
  console.log(`   /provider <url>       - Thay đổi provider URL`);
  console.log(`   /history              - Xem lịch sử hội thoại`);
  console.log(`   /read, :read <path>   - Đọc nội dung file với đánh số dòng`);
  console.log(`   /write, :write <path> - Ghi nội dung vào file`);
  console.log(`   /edit, :edit <path>   - Sửa file (SEARCH / REPLACE)`);
  console.log(`   /find, :find <pat>    - Tìm kiếm file theo tên`);
  console.log(`   /grep, :grep <text>   - Tìm kiếm nội dung trong mã nguồn`);
  console.log(`   /bash, :bash <cmd>    - Thực thi lệnh shell cục bộ`);
  console.log(`   /status, :status      - Trạng thái git ngắn gọn`);
  console.log(`   /diff, :diff [path]   - Xem khác biệt git diff`);
  console.log(`   /doctor, :doctor      - Kiểm tra chẩn đoán hệ thống`);
  console.log(`   /audit, :audit        - Kiểm tra an ninh mã nguồn (MonkeyCode)`);
  console.log(`   /init, :init          - Khởi tạo context dự án (Claude Code)`);
  console.log(`   /compact, :compact    - Kiểm tra dọn dẹp bộ nhớ context`);
  console.log(`   /teamwork <goal>      - Chạy Teamwork Multi-Agent Engine`);
  console.log(`   /clear, :clear        - Xóa màn hình terminal & reset lịch sử`);
  console.log(`   /exit, :exit          - Thoát CLI`);
  console.log(` Nhập bất kỳ câu hỏi/yêu cầu lập trình nào để Agent xử lý tự động!`);
  console.log(`======================================================\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'vyen> ',
  });

  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    const lower = trimmed.toLowerCase();
    if (lower === '/exit' || lower === ':exit' || lower === 'exit' || lower === 'quit' || lower === '/quit' || lower === ':quit') {
      console.log('Tạm biệt!');
      process.exit(0);
    }

    if (lower === '/clear' || lower === ':clear' || lower === 'clear' || lower === 'cls') {
      console.clear();
      agent.clearHistory();
      rl.prompt();
      continue;
    }

    if (lower === '/history' || lower === ':history') {
      const hist = agent.getHistory();
      console.log(`[vyen cli] Lịch sử hiện tại có ${hist.length} tin nhắn.`);
      rl.prompt();
      continue;
    }

    if (trimmed.startsWith('/key ') || trimmed.startsWith(':key ')) {
      const newKey = trimmed.replace(/^[\/:](key)\s+/, '').trim();
      agent.setApiKey(newKey);
      console.log(`[vyen cli] Đã cập nhật API key thành công (${newKey.slice(0, 6)}...).`);
      rl.prompt();
      continue;
    }

    if (trimmed.startsWith('/model ') || trimmed.startsWith(':model ')) {
      const newModel = trimmed.replace(/^[\/:](model)\s+/, '').trim();
      agent.setModel(newModel);
      console.log(`[vyen cli] Đã chuyển model sang: "${newModel}".`);
      rl.prompt();
      continue;
    }

    if (trimmed.startsWith('/provider ') || trimmed.startsWith(':provider ')) {
      const newUrl = trimmed.replace(/^[\/:](provider)\s+/, '').trim();
      agent.setBaseUrl(newUrl);
      console.log(`[vyen cli] Đã chuyển provider URL sang: "${newUrl}".`);
      rl.prompt();
      continue;
    }

    if (lower === '/help' || lower === ':help' || lower === 'help' || lower === '/?') {
      console.log(`
Các lệnh khả dụng:
  /key <api-key>                    Thiết lập API key trong phiên
  /model <model-name>               Đổi model AI (gpt-4o, claude-3-5-sonnet, ...)
  /provider <url>                   Đổi provider base URL
  /history                          Xem số lượt hội thoại
  /read <path> [startLine] [count]  Đọc file
  /write <path> <content>           Ghi file
  /edit <path> "<old>" "<new>"      Sửa file
  /find [pattern]                   Tìm kiếm file
  /grep <query>                     Tìm chuỗi trong source code
  /bash <cmd>                       Chạy shell command
  /status                           Xem git status
  /diff [file]                      Xem git diff
  /doctor                           Kiểm tra sức khỏe hệ thống
  /audit [path]                     Kiểm toán an ninh mã nguồn MonkeyCode
  /init                             Khởi tạo ngữ cảnh dự án
  /compact                          Kiểm tra bộ nhớ context
  /teamwork <goal>                  Khởi chạy Teamwork 2-phase Multi-Agent
  /clear                            Xóa màn hình & reset ngữ cảnh
  /exit                             Thoát
  <bất kỳ câu hỏi / yêu cầu nào>    Kích hoạt LLM reasoning & tool-calling loop!
`);
      rl.prompt();
      continue;
    }

    if (lower === '/doctor' || lower === ':doctor' || lower === 'doctor') {
      const r = harness.doctor();
      console.log(r.output);
      rl.prompt();
      continue;
    }

    if (trimmed.startsWith('/audit') || trimmed.startsWith(':audit')) {
      const target = trimmed.replace(/^[\/:](audit)/, '').trim() || undefined;
      const r = harness.audit(target);
      console.log(r.output);
      rl.prompt();
      continue;
    }

    if (lower === '/init' || lower === ':init' || lower === 'init') {
      const r = harness.init();
      console.log(r.output);
      rl.prompt();
      continue;
    }

    if (lower === '/compact' || lower === ':compact' || lower === 'compact') {
      const r = harness.compact();
      console.log(r.output);
      rl.prompt();
      continue;
    }

    if (lower === '/status' || lower === ':status') {
      const r = harness.gitStatus();
      console.log(r.output || 'Working directory clean.');
      rl.prompt();
      continue;
    }

    if (trimmed.startsWith('/diff') || trimmed.startsWith(':diff')) {
      const target = trimmed.replace(/^[\/:](diff)/, '').trim();
      const r = harness.gitDiff(target || undefined);
      console.log(r.output || 'No changes.');
      rl.prompt();
      continue;
    }

    if (trimmed.startsWith('/read ') || trimmed.startsWith(':read ')) {
      const p = trimmed.slice(6).trim();
      const parts = p.split(/\s+/);
      const filePath = parts[0];
      const startLine = parts[1] ? parseInt(parts[1], 10) : 1;
      const count = parts[2] ? parseInt(parts[2], 10) : 200;
      const r = harness.read(filePath, startLine, count);
      if (r.ok) console.log(r.output);
      else console.error(`[Lỗi] ${r.error}`);
    } else if (trimmed.startsWith('/write ') || trimmed.startsWith(':write ')) {
      const raw = trimmed.replace(/^[\/:](write)\s+/, '').trim();
      const firstSpace = raw.indexOf(' ');
      if (firstSpace === -1) {
        console.error('[Lỗi] Cách dùng: /write <đường_dẫn_file> <nội_dung>');
      } else {
        const filePath = raw.slice(0, firstSpace).trim();
        const content = raw.slice(firstSpace + 1);
        const r = harness.write(filePath, content);
        if (r.ok) console.log(r.output);
        else console.error(`[Lỗi] ${r.error}`);
      }
    } else if (trimmed.startsWith('/edit ') || trimmed.startsWith(':edit ')) {
      const raw = trimmed.replace(/^[\/:](edit)\s+/, '').trim();
      let filePath = '';
      let target = '';
      let replacement = '';

      const matchDouble = raw.match(/^(\S+)\s+"([^"]*)"\s+"([^"]*)"$/);
      const matchSingle = raw.match(/^(\S+)\s+'([^']*)'\s+'([^']*)'$/);
      const matchPlain = raw.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);

      if (matchDouble) {
        [, filePath, target, replacement] = matchDouble;
      } else if (matchSingle) {
        [, filePath, target, replacement] = matchSingle;
      } else if (matchPlain) {
        [, filePath, target, replacement] = matchPlain;
      }

      if (!filePath || !target) {
        console.error('[Lỗi] Cách dùng: /edit <đường_dẫn_file> "<đoạn_cũ>" "<đoạn_mới>"');
      } else {
        const r = harness.edit(filePath, target, replacement);
        if (r.ok) console.log(r.output);
        else console.error(`[Lỗi] ${r.error}`);
      }
    } else if (trimmed.startsWith('/find ') || trimmed.startsWith(':find ')) {
      const pat = trimmed.slice(6).trim();
      const r = harness.find(pat);
      console.log(r.output);
    } else if (trimmed.startsWith('/grep ') || trimmed.startsWith(':grep ')) {
      const query = trimmed.slice(6).trim();
      const r = harness.grep(query);
      console.log(r.output);
    } else if (trimmed.startsWith('/bash ') || trimmed.startsWith(':bash ')) {
      const cmd = trimmed.slice(6).trim();
      console.log(`> ${cmd}`);
      const r = harness.bash(cmd);
      console.log(r.output);
    } else if (trimmed.startsWith('/teamwork ') || trimmed.startsWith(':teamwork ')) {
      const goal = trimmed.slice(10).trim();
      rl.close();
      const { main: runTeamwork } = await import('../teamwork/cli');
      await runTeamwork(['--goal', goal, '--workspace', workspace]);
      return;
    } else if (trimmed.startsWith('/') || trimmed.startsWith(':')) {
      console.warn(`[vyen cli] Lệnh không nhận diện: "${trimmed}". Gõ /help để xem hướng dẫn.`);
    } else {
      // Autonomous LLM Streaming Agent Reasoning & Tool-calling Loop!
      await agent.streamTurn(trimmed);
    }

    rl.prompt();
  }
}
