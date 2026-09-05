/**
 * Comprehensive Unit Tests for AutonomousCliAgent (Claude Code & Codex architecture).
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  AutonomousCliAgent,
  CliCodingHarness,
  loadEnvFiles,
  startInteractiveCli,
} from '../lib/cli/interactive-agent';

describe('AutonomousCliAgent (Claude Code / Codex Architecture)', () => {
  const workspaceRoot = process.cwd();

  it('khởi tạo agent thành công với cấu hình mặc định', () => {
    const agent = new AutonomousCliAgent({ workspaceRoot });
    const cfg = agent.getConfig();
    expect(cfg.workspace).toBe(path.resolve(workspaceRoot));
    expect(cfg.model).toBeDefined();
    expect(cfg.baseUrl).toBeDefined();
    expect(agent.getHarness()).toBeInstanceOf(CliCodingHarness);
  });

  it('hỗ trợ cập nhật API key, model, provider base URL và reset lịch sử', () => {
    const agent = new AutonomousCliAgent({ workspaceRoot });
    agent.setApiKey('sk-test-custom-key-12345');
    agent.setModel('claude-3-5-sonnet');
    agent.setBaseUrl('https://openrouter.ai/api/v1');

    const cfg = agent.getConfig();
    expect(cfg.hasKey).toBe(true);
    expect(cfg.model).toBe('claude-3-5-sonnet');
    expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1');

    agent.clearHistory();
    expect(agent.getHistory()).toEqual([]);
  });

  it('chạy luồng streaming turn giả lập (Simulated/Mock Mode) với tool read_file', async () => {
    const agent = new AutonomousCliAgent({
      workspaceRoot,
      mockMode: true,
    });

    const tokens: string[] = [];
    let toolCalled: string | null = null;
    let toolResultReceived: unknown = null;

    const res = await agent.streamTurn('Hãy đọc file package.json', {
      onToken: (tok) => tokens.push(tok),
      onToolCall: (name) => {
        toolCalled = name;
      },
      onToolResult: (name, result) => {
        toolResultReceived = result;
      },
    });

    expect(toolCalled).toBe('read_file');
    expect(toolResultReceived).toBeDefined();
    expect(res.toolCallsCount).toBe(1);
    expect(tokens.join('')).toContain('read_file');
    expect(agent.getHistory().length).toBe(2);
  });

  it('chạy luồng streaming turn với tool security_audit (MonkeyCode SAST)', async () => {
    const agent = new AutonomousCliAgent({
      workspaceRoot,
      mockMode: true,
    });

    let toolCalled: string | null = null;
    let toolResult: unknown = null;

    const res = await agent.streamTurn('Kiểm tra an ninh mã nguồn', {
      onToolCall: (name) => {
        toolCalled = name;
      },
      onToolResult: (name, result) => {
        toolResult = result;
      },
    });

    expect(toolCalled).toBe('security_audit');
    expect(typeof toolResult).toBe('string');
    expect(toolResult).toContain('Vyen Security & Code Audit');
    expect(res.toolCallsCount).toBe(1);
  }, 20000);

  it('chạy luồng streaming turn với tool git_status', async () => {
    const agent = new AutonomousCliAgent({
      workspaceRoot,
      mockMode: true,
    });

    let toolCalled: string | null = null;
    const res = await agent.streamTurn('Kiểm tra git status', {
      onToolCall: (name) => {
        toolCalled = name;
      },
    });

    expect(toolCalled).toBe('git_status');
    expect(res.toolCallsCount).toBe(1);
  });

  it('chạy luồng streaming turn với tool find', async () => {
    const agent = new AutonomousCliAgent({
      workspaceRoot,
      mockMode: true,
    });

    let toolCalled: string | null = null;
    const res = await agent.streamTurn('Tìm file "*.json"', {
      onToolCall: (name) => {
        toolCalled = name;
      },
    });

    expect(toolCalled).toBe('find');
    expect(res.toolCallsCount).toBe(1);
  });

  it('hướng dẫn thiết lập API key rõ ràng khi chưa có key và không ở mock mode', async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.VYEN_API_KEY;

    try {
      const agent = new AutonomousCliAgent({
        workspaceRoot,
        apiKey: '',
        skipEnvLoad: true,
        mockMode: false,
      });

      const tokens: string[] = [];
      const res = await agent.streamTurn('Bạn có thể giải thích mã nguồn này không?', {
        onToken: (tok) => tokens.push(tok),
      });

      const fullOutput = tokens.join('');
      expect(fullOutput).toContain('Chưa phát hiện API Key');
      expect(fullOutput).toContain('/key <your-api-key>');
      expect(res.toolCallsCount).toBe(0);
    } finally {
      if (prevKey) process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it('thực thi lệnh shell fallback khi chưa có API key nhưng người dùng gõ lệnh trực tiếp', async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.VYEN_API_KEY;

    try {
      const agent = new AutonomousCliAgent({
        workspaceRoot,
        apiKey: '',
        skipEnvLoad: true,
        mockMode: false,
      });

      const tokens: string[] = [];
      const res = await agent.streamTurn('echo test-cli-bash-fallback', {
        onToken: (tok) => tokens.push(tok),
      });

      expect(tokens.join('')).toContain('test-cli-bash-fallback');
      expect(tokens.join('')).not.toContain('Chưa phát hiện API Key');
      expect(res.toolCallsCount).toBe(1);
    } finally {
      if (prevKey) process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it('harness.find hỗ trợ chuẩn xác glob wildcard (*.json) và strip quotes', () => {
    const harness = new CliCodingHarness(workspaceRoot);
    const res = harness.find('*.json');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('package.json');
    expect(res.output).toContain('tsconfig.json');

    // Hỗ trợ cả khi bọc quotes
    const resQuotes = harness.find('"*.json"');
    expect(resQuotes.ok).toBe(true);
    expect(resQuotes.output).toContain('package.json');
  });

  it('harness.read xử lý an toàn khi truyền đường dẫn thư mục', () => {
    const harness = new CliCodingHarness(workspaceRoot);
    const res = harness.read('lib');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('thư mục');
    expect(res.error).not.toContain('EISDIR');
  });

  it('harness.edit bảo toàn các ký tự đặc biệt ($&, $$, $1) không bị String.replace biến dạng', () => {
    const harness = new CliCodingHarness(workspaceRoot);
    const tempFile = 'tmp-test-dollar-replace.txt';
    try {
      harness.write(tempFile, 'const val = "OLD_TOKEN";');
      const editRes = harness.edit(tempFile, 'OLD_TOKEN', 'NEW_$&_$$1_$2');
      expect(editRes.ok).toBe(true);
      const readRes = harness.read(tempFile);
      expect(readRes.output).toContain('NEW_$&_$$1_$2');
    } finally {
      const fs = require('node:fs');
      const p = require('node:path').join(workspaceRoot, tempFile);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('tự động nhận diện provider OpenRouter, Gemini, Groq theo format API key', () => {
    const agent = new AutonomousCliAgent({ workspaceRoot });

    // OpenRouter prefix
    agent.setApiKey('sk-or-v1-abcdef123456');
    let cfg = agent.getConfig();
    expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(cfg.model).toBe('anthropic/claude-3.5-sonnet');

    // Gemini prefix
    agent.setBaseUrl('https://api.openai.com/v1');
    agent.setModel('gpt-4o');
    agent.setApiKey('AIzaSyD-1234567890abcdef');
    cfg = agent.getConfig();
    expect(cfg.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai/');
    expect(cfg.model).toBe('gemini-2.0-flash');
  });

  it('loadEnvFiles không ném lỗi kể cả khi file không tồn tại', () => {
    expect(() => loadEnvFiles(workspaceRoot)).not.toThrow();
  });

  it('startInteractiveCli hỗ trợ thực thi non-interactive initialPrompt', async () => {
    // Không bị treo hay lỗi khi truyền initialPrompt trong môi trường test (non-TTY)
    await expect(
      startInteractiveCli(workspaceRoot, 'Kiểm tra trạng thái git', { mockMode: true })
    ).resolves.toBeUndefined();
  });
});
