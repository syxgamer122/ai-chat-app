/**
 * Bảo vệ SecretRegistry (lib/secret-registry.ts) — bịt đường rò
 * bí mật vào NGỮ CẢNH MODEL (trước đây không lớp nào che kết quả tool):
 *  - tầng VALUE: khoá đã đăng ký bị che ở mọi chỗ, kể cả khi pattern không nhận ra
 *  - tầng PATTERN: khoá chưa đăng ký vẫn bị che (sk-, ghp_, AKIA, PEM, JWT, DSN…)
 *  - hợp nhất: 5 bản SECRET_REGEX copy-paste đã bị gỡ, route/fs-access dùng chung
 *  - phủ CẢ đường autonomous, không chỉ đường web: agent loop (transcript +
 *    event tool_execution_end) và CLI (mọi `execute` của AI SDK + history được
 *    ghi xuống file session)
 *  - KHÔNG phá nội dung: code thường (`key = sessionStorage…`) phải đi qua nguyên vẹn,
 *    nếu không agent đọc file xong sẽ ghi lại nội dung đã bị che
 *  - chống drift với security-sast.ts: cùng fixture, hai bộ rule phải cùng khớp
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DISABLE_REDACTION_ENV,
  REDACT_PLACEHOLDER,
  SECRET_PATTERN_RULES,
  SecretRegistry,
  __resetDefaultSecretRegistry,
  getDefaultSecretRegistry,
  redactSecretPatterns,
  redactSecretText,
  redactSecretsDeep,
} from '@/lib/secret-registry';
import { serializeToolResult } from '@/lib/tool-limits';
import { buildAgentTools, type MemoryItem } from '@/lib/agent-tools';
import { __clearAllToolCallBudgets } from '@/lib/tool-call-budget';
import { SAST_RULES } from '@/lib/security-sast';
import {
  agentLoop,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentStreamFn,
} from '@/lib/agent/loop';
import {
  AutonomousCliAgent,
  CliCodingHarness,
  withSecretRedaction,
} from '@/lib/cli/interactive-agent';

const GHP = `ghp_${'a'.repeat(36)}`;
const FINE_PAT = `github_pat_${'b'.repeat(60)}`;
// Slack: ghép từ mảnh có chủ đích. Chuỗi literal "xoxb-<số>-<chữ>" bị GitHub Push
// Protection coi là token Slack thật và chặn push, dù đây chỉ là fixture test.
// Giá trị lúc chạy không đổi nên rule PATTERN vẫn được đo đúng.
const SLACK = `xox${'b'}-1234567890-abcdefghijklmno`;
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';

afterEach(() => {
  delete process.env[DISABLE_REDACTION_ENV];
  __resetDefaultSecretRegistry();
  __clearAllToolCallBudgets();
});

describe('tầng PATTERN — khoá chưa từng đăng ký vẫn bị che', () => {
  const cases: Array<[label: string, secret: string]> = [
    ['openai', 'sk-proj-abcdefghijklmnopqrstuvwx'],
    ['openai-cổ điển', 'sk-abcdefghijklmnopqrstuvwx'],
    ['anthropic', 'sk-ant-api03-abcdefghijklmnopqrst'],
    ['google', 'AIzaSy-abcdefghijklmnopqrstuvwxyz1234'],
    ['aws', 'AKIAIOSFODNN7EXAMPLE'],
    ['github', GHP],
    ['github-fine-grained', FINE_PAT],
    ['slack', SLACK],
    ['jwt', JWT],
    ['bearer', 'Bearer abcdefghijklmno'],
    ['pem', PEM],
  ];

  for (const [label, secret] of cases) {
    it(`che khoá ${label}`, () => {
      const res = redactSecretPatterns(`giá trị nhận được: ${secret} (hết)`);
      expect(res.text).not.toContain(secret);
      expect(res.text).toContain(REDACT_PLACEHOLDER);
      expect(res.total).toBeGreaterThan(0);
    });
  }

  it('che ĐỦ MỌI vị trí trong cùng chuỗi (bản cũ thiếu cờ g nên chỉ thay vị trí đầu)', () => {
    const a = 'sk-aaaaaaaaaaaaaaaa';
    const b = 'sk-bbbbbbbbbbbbbbbb';
    const res = redactSecretPatterns(`line1=${a}\nline2=${b}`);
    expect(res.text).not.toContain(a);
    expect(res.text).not.toContain(b);
    expect(res.total).toBe(2);
  });

  it('DSN: chỉ che mật khẩu, GIỮ host để thông điệp lỗi còn dùng được', () => {
    const res = redactSecretPatterns(
      'không kết nối được tới postgres://admin:s3cr3t-p4ss@db.internal:5432/vyen',
    );
    expect(res.text).toContain('postgres://admin:' + REDACT_PLACEHOLDER + '@db.internal:5432/vyen');
    expect(res.text).not.toContain('s3cr3t-p4ss');
  });

  it('gán trong nháy bị che nhưng GIỮ tên biến', () => {
    const res = redactSecretPatterns(`OPENAI_API_KEY="abcdefghijklmnopqrstuvwx"`);
    expect(res.text).toBe(`OPENAI_API_KEY="${REDACT_PLACEHOLDER}"`);
  });
});

describe('tầng PATTERN — không bắt oan nội dung code', () => {
  const benign = [
    'const key = sessionStorage.getItem("vyen-settings")',
    'const skip = analyzeSkipCounter(candidates)',
    'if (payload.skip === true) return earlyExit(path)',
    'const password = await bcrypt.hash(raw, 10)',
    'appSecret = "short"',
    'sessionToken: shortValue',
  ];

  for (const line of benign) {
    it(`đi qua nguyên vẹn: ${line.slice(0, 40)}`, () => {
      expect(redactSecretPatterns(line).text).toBe(line);
    });
  }
});

describe('tầng VALUE — giá trị đã đăng ký (lõi SecretRegistry)', () => {
  const CRED = 'gw-9f8e7d6c5b4a39281706';

  it('che giá trị đã đăng ký dù pattern không nhận dạng được nó', () => {
    const reg = new SecretRegistry();
    expect(reg.register(CRED, 'VYEN_API_KEY')).toBe(true);
    expect(reg.register(CRED)).toBe(false); // trùng
    expect(reg.register('short')).toBe(false); // dưới ngưỡng
    expect(reg.labelOf(CRED)).toBe('VYEN_API_KEY');

    const res = reg.redact(`401 từ gateway: token ${CRED} không hợp lệ`);
    expect(res.text).toBe(`401 từ gateway: token ${REDACT_PLACEHOLDER} không hợp lệ`);
    expect(res.hits).toEqual([{ rule: 'registered-value', count: 1 }]);
  });

  it('che giá trị DÀI trước giá trị NGẮN (khoá ngắn là substring)', () => {
    const reg = new SecretRegistry();
    reg.registerAll(['abcdefghijklmnop', 'abcdefgh']);
    expect(reg.redact('abcdefghijklmnop').text).toBe(REDACT_PLACEHOLDER);
  });

  it('registerFromEnv phủ danh sách deny chuẩn LẪN đuôi *_KEY/*_TOKEN riêng của Vyen', () => {
    const reg = new SecretRegistry();
    const added = reg.registerFromEnv({
      OPENAI_API_KEY: 'sk-proj-env-abcdefghijklmnop',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-xyz123456',
      CUSTOM_ACME_TOKEN: 'acme-token-abcdefghijkl',
      ACCESS_CODE: 'code-abcdefghijkl',
      DIAG_SECRET: 'diag-abcdefghijkl',
      PATH: '/usr/bin:/bin',
      NODE_ENV: 'test',
      TINY: 'abc',
      SHELL: '/bin/bash',
    });
    expect(added).toBe(5);
    // 'aws-secret-xyz123456' KHÔNG khớp pattern nào → chỉ tầng VALUE bắt được.
    expect(reg.redact('env: aws-secret-xyz123456').text).toBe(`env: ${REDACT_PLACEHOLDER}`);
    expect(reg.labelOf('acme-token-abcdefghijkl')).toBe('CUSTOM_ACME_TOKEN');
    expect(reg.labelOf('code-abcdefghijkl')).toBe('ACCESS_CODE');
  });

  it('registry MẶC ĐỊNH tự nạp bí mật từ env tiến trình', () => {
    process.env.CUSTOM_ACME_TOKEN = 'zzzz-secret-value-1234';
    try {
      __resetDefaultSecretRegistry();
      expect(redactSecretText('dùng zzzz-secret-value-1234 để gọi')).toBe(
        `dùng ${REDACT_PLACEHOLDER} để gọi`,
      );
      expect(getDefaultSecretRegistry().size).toBeGreaterThan(0);
    } finally {
      delete process.env.CUSTOM_ACME_TOKEN;
    }
  });

  it('containsSecret không ghi số liệu; redact thì ghi', () => {
    const reg = new SecretRegistry();
    expect(reg.containsSecret('sk-aaaaaaaaaaaaaaaa')).toBe(true);
    expect(reg.stats().totalRedactions).toBe(0);
    reg.redact('sk-aaaaaaaaaaaaaaaa');
    expect(reg.stats().totalRedactions).toBe(1);
    expect(reg.stats().hits['openai-key']).toBe(1);
    reg.resetStats();
    expect(reg.stats().totalRedactions).toBe(0);
    expect(reg.stats().hits).toEqual({});
  });

  it('env VYEN_DISABLE_SECRET_REDACTION là lối thoát khẩn cấp', () => {
    process.env[DISABLE_REDACTION_ENV] = 'true';
    const reg = new SecretRegistry({ extraValues: ['gw-9f8e7d6c5b4a39281706'] });
    expect(reg.redact('sk-aaaaaaaaaaaaaaaa gw-9f8e7d6c5b4a39281706').total).toBe(0);
    expect(reg.containsSecret('sk-aaaaaaaaaaaaaaaa')).toBe(false);
  });
});

describe('redactDeep — che đệ quy kết quả tool', () => {
  it('che trong object/array lồng nhau, giữ nguyên phần vô hại', () => {
    const reg = new SecretRegistry();
    const out = reg.redactDeep({
      results: [{ url: 'https://e.com', snippet: 'key sk-proj-abcdefghijklmnopqrstuvwx lộ' }],
      count: 2,
    });
    expect(JSON.stringify(out)).not.toContain('sk-proj-abcdefghijklmnopqrstuvwx');
    expect(out.count).toBe(2);
    expect(out.results[0].url).toBe('https://e.com');
    expect(out.results[0].snippet).toContain(REDACT_PLACEHOLDER);
  });

  it('không ném với vòng lặp và giữ nguyên instance lạ (Date)', () => {
    const reg = new SecretRegistry();
    const cyc: Record<string, unknown> = { a: 'sk-aaaaaaaaaaaaaaaa' };
    cyc.self = cyc;
    const out = reg.redactDeep(cyc) as Record<string, unknown>;
    expect(out.a).not.toContain('sk-aaaaaaaaaaaaaaaa');
    expect(String(out.self)).toMatch(/vòng lặp/);

    const when = new Date(0);
    expect(reg.redactDeep({ when }).when).toBe(when);
  });
});

describe('chống drift với security-sast.ts (cùng fixture, hai bộ rule)', () => {
  const samples: Array<[ruleId: string, token: string]> = [
    ['SECRET-OPENAI-001', 'sk-abcdefghijklmnopqrstuvwx'],
    ['SECRET-ANTHROPIC-001', 'sk-ant-api03-abcdefghijklmnopqrst'],
    ['SECRET-GITHUB-001', GHP],
    ['SECRET-AWS-001', 'AKIAIOSFODNN7EXAMPLE'],
    ['SECRET-PRIVKEY-001', '-----BEGIN RSA PRIVATE KEY-----'],
    ['SECRET-GENERIC-001', 'abcdefghijklmnopqrstuvwx'],
  ];

  for (const [ruleId, token] of samples) {
    it(`${ruleId}: SAST bắt được thì registry cũng phải che`, () => {
      const rule = SAST_RULES.find((r) => r.id === ruleId);
      expect(rule, `rule ${ruleId} biến mất khỏi lib/security-sast.ts`).toBeDefined();
      const line =
        ruleId === 'SECRET-GENERIC-001' ? `apiKey = '${token}'` : `const x = "${token}";`;
      expect(rule!.match(line, 0, line, 'src/lib/thing.ts')).toBe(true);

      const res = redactSecretPatterns(line);
      expect(res.total).toBeGreaterThan(0);
      expect(res.text).not.toContain(token);
    });
  }

  it('bộ rule không bị rỗng sau refactor', () => {
    const ids = SECRET_PATTERN_RULES.map((r) => r.id);
    for (const id of [
      'openai-key',
      'anthropic-key',
      'github-token',
      'aws-access-key-id',
      'private-key-block',
      'dsn-password',
    ]) {
      expect(ids).toContain(id);
    }
  });
});

describe('hợp nhất vào đường đi thật của kết quả tool', () => {
  const SECRET = 'sk-proj-abcdefghijklmnopqrstuvwx';

  it('đường emulated: serializeToolResult che TRƯỚC khi cắt trần', () => {
    const out = serializeToolResult({ content: `OPENAI_API_KEY=${SECRET}` });
    expect(out).not.toContain(SECRET);
    expect(out).toContain(REDACT_PLACEHOLDER);

    /* Khoá nằm ngay đầu khối khổng lồ: nếu cắt trần chạy TRƯỚC redact thì khoá
       vẫn còn trong phần đầu giữ lại → test này khoá thứ tự đó. Filler là "x "
       (có dấu cách): nếu viết "x" liền, class [A-Za-z0-9_-]{8,} của rule sk- sẽ
       nuốt luôn cả 40k ký tự và không còn gì để cắt — mất luôn phép kiểm thứ tự. */
    const huge = serializeToolResult({ blob: `${SECRET}${'x '.repeat(20_000)}` });
    expect(huge).not.toContain(SECRET);
    expect(huge).toContain('đã cắt bớt');
  });

  it('đường native: kết quả tool SERVER đi qua guarded() cũng bị che', async () => {
    const memories: MemoryItem[] = [
      { id: 'm1', text: `gateway token của tôi là ${SECRET}` },
    ];
    const tools = buildAgentTools({ memories, conversationId: 'secret-native-1' });
    const res = await tools.memory_search!.execute!(
      { query: 'gateway token' },
      {} as never,
    );
    const asText = JSON.stringify(res);
    expect(asText).not.toContain(SECRET);
    expect(asText).toContain(REDACT_PLACEHOLDER);
  });

  it('redactSecretsDeep là hàm dùng ở route khi gắn lại kết quả client tool', () => {
    const out = redactSecretsDeep({ content: `DB_PASSWORD="${'p'.repeat(20)}"` });
    expect(JSON.stringify(out)).not.toContain('p'.repeat(20));
  });
});

describe('chi phí che phải TUYẾN TÍNH trên kết quả tool dài (chốt chặn ReDoS)', () => {
  /* Ngân sách rộng (500ms cho 200k ký tự) nhưng vẫn bắt được hồi quy: bản rule
     gán khoá dùng quantifier TRẦN (`[A-Za-z0-9_-]*`, `\s*`) tốn >5s chỉ cho 24k
     ký tự — đúng ca tests/mcp-tool-mapper.test.ts timeout ở lần chạy đầu. Test
     này đỏ ngay khi ai đó bỏ các trần {0,64}/\s{0,16} trong SECRET_PATTERN_RULES
     (che chậm 5s mỗi kết quả tool = treo agent, nên đây là yêu cầu an toàn). */
  const BUDGET_MS = 500;
  const PATHOLOGICAL: Record<string, string> = {
    'toàn chữ thường (thử alternation của rule gán khoá)': 'x'.repeat(200_000),
    'toàn khoảng trắng (thử phần \\s{0,16} trước [:=])': ' '.repeat(200_000),
    'toàn dấu chấm phẩy (không khớp rule nào)': ';'.repeat(200_000),
    'DSN dài không có dấu @ (thử lookahead của rule mật khẩu DSN)': `postgres://user:${'p'.repeat(200_000)}`,
    'chuỗi có nháy mở mà không có nháy đóng': `API_KEY="${'k'.repeat(200_000)}`,
  };

  for (const [name, input] of Object.entries(PATHOLOGICAL)) {
    it(`xong trong ngân sách: ${name}`, () => {
      const started = performance.now();
      redactSecretText(input);
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    });
  }

  it('không hy sinh tính đúng: bí mật GIỮA payload khổng lồ vẫn bị che', () => {
    const filler = 'x '.repeat(20_000);
    const out = redactSecretText(`api_key = "sk-proj-abcdefghijklmnopqrstuvwx" ${filler}`);
    expect(out).not.toContain('sk-proj-abcdefghijklmnopqrstuvwx');
    expect(out).toContain(REDACT_PLACEHOLDER);
  });
});

describe('hợp nhất vào đường đi THẬT của kết quả tool — agent loop & CLI', () => {
  /* Giá trị CỐ Ý không khớp rule pattern nào (không sk-/ghp_/AIza/AKIA/=…): nhờ
     vậy khẳng định "chưa đăng ký thì đi qua nguyên vẹn" mới đo đúng tầng VALUE
     thay vì ăn may từ tầng PATTERN. */
  const REGISTERED = 'vyen-registered-token-0123456789abcdef';

  /** Chạy hết generator, gom event + result (cùng kiểu tests/agent-loop.test.ts). */
  async function runLoop(config: Partial<AgentLoopConfig> & { streamFn: AgentStreamFn }) {
    const events: AgentEvent[] = [];
    const gen = agentLoop({
      initialMessages: [{ id: 'u1', role: 'user', content: 'đọc cấu hình' }],
      ...config,
    });
    for (;;) {
      const item = await gen.next();
      if (item.done) return { events, result: item.value };
      events.push(item.value);
    }
  }

  /** streamFn hai bước: gọi 1 tool rồi trả lời (đủ để loop ghi toolResult).
     PHẢI là factory: bộ đếm nằm trong closure, dùng chung một instance giữa các
     test thì test sau bắt đầu ở bước 3 và không gọi tool nào. */
  function toolThenAnswer(): AgentStreamFn {
    let call = 0;
    return async () => {
      call++;
      if (call === 1) {
        return {
          id: 'a1',
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'fs_read', args: { path: '.env.local' } }],
        };
      }
      return { id: `a${call}`, role: 'assistant', content: 'xong' };
    };
  }

  it('agent loop: transcript + event tool_execution_end chỉ nhận bản ĐÃ CHE', async () => {
    getDefaultSecretRegistry().register(REGISTERED, 'test-secret');
    /* Kết quả tool chứa CẢ bí mật đã đăng ký (tầng VALUE) và bí mật chỉ khớp
       pattern (tầng PATTERN): cả hai phải mất trước khi vào ngữ cảnh model. */
    const { events, result } = await runLoop({
      streamFn: toolThenAnswer(),
      executeTool: async () => `TOKEN=${REGISTERED}\nGITHUB=${GHP}`,
    });

    const transcript = JSON.stringify(result.messages.filter((m) => m.role === 'toolResult'));
    expect(transcript).not.toContain(REGISTERED);
    expect(transcript).not.toContain(GHP);
    expect(transcript).toContain(REDACT_PLACEHOLDER);

    /* Event cũng là đường ra (persistence-subscriber ghi DB) nên phải sạch. */
    const endEvents = JSON.stringify(events.filter((e) => e.type === 'tool_execution_end'));
    expect(endEvents).not.toContain(REGISTERED);
    expect(endEvents).toContain(REDACT_PLACEHOLDER);
  });

  it('agent loop: afterToolCall (policy auto-pilot) vẫn thấy bản THÔ', async () => {
    getDefaultSecretRegistry().register(REGISTERED, 'test-secret');
    let seenByPolicy = '';
    const { result } = await runLoop({
      streamFn: toolThenAnswer(),
      executeTool: async () => `TOKEN=${REGISTERED}`,
      afterToolCall: async (ctx) => {
        seenByPolicy = JSON.stringify(ctx.result);
        return { terminate: true };
      },
    });
    /* Auto-pilot quyết định DỰA TRÊN nội dung thô; che ở đây sẽ làm policy
       (vd. chặn khi thấy ghi ra bí mật) mất dữ liệu để phán đoán. */
    expect(seenByPolicy).toContain(REGISTERED);
    expect(JSON.stringify(result.messages)).not.toContain(REGISTERED);
  });
});

describe('hợp nhất vào đường đi THẬT của kết quả tool — CLI harness', () => {
  const REGISTERED = 'vyen-cli-registered-token-0123456789ab';

  it('withSecretRedaction: bọc MỌI execute, tool không có execute giữ nguyên', async () => {
    getDefaultSecretRegistry().register(REGISTERED, 'test-secret');
    const tools = {
      read_file: { execute: async () => ({ ok: true, output: `OPENAI_API_KEY=${REGISTERED}` }) },
      security_audit: { execute: async () => `github: ${GHP}` },
      tools_list: { description: 'khai báo thuần, không có execute' },
    };

    const wrapped = withSecretRedaction(tools);
    expect(wrapped).toBe(tools); // mutate tại chỗ → kiểu của chỗ gọi không đổi

    const read = await tools.read_file.execute();
    expect(read.output).not.toContain(REGISTERED);
    expect(read.output).toContain(REDACT_PLACEHOLDER);

    expect(await tools.security_audit.execute()).toBe(`github: ${REDACT_PLACEHOLDER}`);
    expect(tools.tools_list).toEqual({ description: 'khai báo thuần, không có execute' });
  });

  it('CLI: key gõ bằng /key được đăng ký (setApiKey) nhưng vẫn dùng được cho model', () => {
    const agent = new AutonomousCliAgent({ workspaceRoot: process.cwd(), skipEnvLoad: true });
    const key = 'vyen-cli-0123456789abcdefghijklmnop';
    expect(getDefaultSecretRegistry().redact(key).text).toBe(key); // chưa đăng ký

    agent.setApiKey(key);

    expect(agent.getConfig().hasKey).toBe(true);
    expect(getDefaultSecretRegistry().redact(key).text).toBe(REDACT_PLACEHOLDER);
  });

  it('CLI simulated: output tool bị che TRƯỚC khi vào history (file session)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vyen-cli-redact-'));
    try {
      writeFileSync(path.join(dir, '.env.local'), `OPENAI_API_KEY=${REGISTERED}\n`);
      getDefaultSecretRegistry().register(REGISTERED, 'test-secret');
      const agent = new AutonomousCliAgent({
        workspaceRoot: dir,
        skipEnvLoad: true, // KHÔNG nạp .env.local thật của repo vào process.env
        mockMode: true, // chạy được không cần mạng/API key
        harness: new CliCodingHarness(dir),
      });

      const res = await agent.streamTurn('read .env.local', { onToken: () => {} });

      expect(res.text).not.toContain(REGISTERED);
      expect(res.text).toContain(REDACT_PLACEHOLDER);

      /* history bị saveSession() ghi xuống .vyen/sessions/<id>.json */
      const history = JSON.stringify(agent.getHistory());
      expect(history).not.toContain(REGISTERED);
      expect(history).toContain(REDACT_PLACEHOLDER);

      /* Chủ ý: che ở BIÊN GIỚI vào model, KHÔNG che ở nguồn — harness vẫn trả
         nội dung thật để lập trình viên đọc/grep ngay tại terminal. */
      expect(agent.getHarness().read('.env.local', 1, 5).output).toContain(REGISTERED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

