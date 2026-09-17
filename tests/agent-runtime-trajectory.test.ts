import { describe, it, expect } from 'vitest';
import type { AgentRuntimeEvent } from '@/lib/agent-runtime/event-stream';
import {
  buildTrajectory,
  diffTrajectories,
  formatTrajectoryTranscript,
  parseTrajectory,
  redactSecrets,
  redactTrajectory,
  serializeTrajectory,
  TRAJECTORY_SCHEMA_VERSION,
  trajectoryStats,
} from '@/lib/agent-runtime/trajectory';

function ev(partial: Partial<AgentRuntimeEvent> & { id: number }): AgentRuntimeEvent {
  return Object.freeze({
    type: 'system_event',
    ts: 1_700_000_000_000 + partial.id * 1000,
    payload: '',
    source: 'system',
    contentHash: `h-${partial.id}`,
    ...partial,
  }) as AgentRuntimeEvent;
}

const SESSION: AgentRuntimeEvent[] = [
  ev({ id: 0, type: 'user_message', source: 'user', ts: 1_700_000_000_000, payload: 'sửa lỗi build' }),
  ev({ id: 1, type: 'agent_action', source: 'model', toolName: 'fs_read', payload: '{"path":"vite.config.ts"}' }),
  ev({ id: 2, type: 'agent_observation', source: 'tool', toolName: 'fs_read', payload: 'export default {}' }),
  ev({ id: 3, type: 'agent_action', source: 'model', toolName: 'shell', payload: '{"cmd":"npm run build"}' }),
  ev({ id: 4, type: 'agent_error', source: 'tool', toolName: 'shell', payload: 'FAIL build: TS2322' }),
  ev({ id: 5, type: 'assistant_message', source: 'model', payload: 'đã sửa xong' }),
];

describe('agent runtime trajectory — redaction', () => {
  it('che khoá API, Bearer, JWT, mật khẩu connection string và KEY=value', () => {
    const raw = [
      'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123',
      'curl -H "Authorization: Bearer abcdef1234567890XYZ" https://api',
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
      'postgres://admin:s3crer-password@db.internal:5432/app',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    ].join('\n');
    const r = redactSecrets(raw);
    expect(r.text).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz0123');
    expect(r.text).not.toContain('abcdef1234567890XYZ');
    expect(r.text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(r.text).not.toContain('s3crer-password');
    expect(r.text).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(r.text).toContain('postgres://admin:[REDACTED:db-password]@db.internal:5432/app');
    expect(r.redactions).toBeGreaterThanOrEqual(5);
    expect(r.byLabel['openai-key']).toBe(1);
    expect(r.byLabel['db-password']).toBe(1);
  });

  it('che private key block', () => {
    const raw = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const r = redactSecrets(raw);
    expect(r.text).toBe('[REDACTED:private-key]');
    expect(r.byLabel['private-key']).toBe(1);
  });

  it('idempotent — redact lần 2 không nhân đôi số đếm', () => {
    const once = redactSecrets('sk-proj-abcdefghijklmnopqrstuvwxyz0123').text;
    const twice = redactSecrets(once);
    expect(twice.text).toBe(once);
    expect(twice.redactions).toBe(0);
  });

  it('text không có bí mật → giữ nguyên', () => {
    const clean = 'npm run typecheck\nok, 0 lỗi';
    const r = redactSecrets(clean);
    expect(r.text).toBe(clean);
    expect(r.redactions).toBe(0);
  });

  it('redactTrajectory che payload mọi event và tính lại contentHash', () => {
    const traj = buildTrajectory(
      [ev({ id: 0, type: 'agent_observation', source: 'tool', toolName: 'shell', payload: 'key=sk-abcdefghijklmnopqrstuvwx' })],
      { conversationId: 'c1' },
      { redact: false },
    );
    const { trajectory, redactions } = redactTrajectory(traj);
    expect(redactions).toBe(1);
    expect(trajectory.events[0]?.payload).not.toContain('sk-abcdefghij');
    expect(trajectory.events[0]?.contentHash).not.toBe('h-0');
  });
});

describe('agent runtime trajectory — export/round-trip', () => {
  it('JSON round-trip giữ nguyên event', () => {
    const traj = buildTrajectory(SESSION, { conversationId: 'c1', model: 'gpt-5', appVersion: '0.1.0' });
    const parsed = parseTrajectory(serializeTrajectory(traj));
    expect(parsed.errors).toEqual([]);
    expect(parsed.trajectory?.schemaVersion).toBe(TRAJECTORY_SCHEMA_VERSION);
    expect(parsed.trajectory?.meta.model).toBe('gpt-5');
    expect(parsed.trajectory?.events.map((e) => e.type)).toEqual(SESSION.map((e) => e.type));
    expect(parsed.trajectory?.events[4]?.payload).toBe('FAIL build: TS2322');
  });

  it('JSONL round-trip: header dòng đầu + một event mỗi dòng', () => {
    const traj = buildTrajectory(SESSION, { conversationId: 'c1' });
    const text = serializeTrajectory(traj, { format: 'jsonl' });
    const lines = text.split('\n');
    expect(lines).toHaveLength(SESSION.length + 1);
    expect(JSON.parse(lines[0]!).meta.conversationId).toBe('c1');
    const parsed = parseTrajectory(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.trajectory?.events).toHaveLength(SESSION.length);
  });

  it('export redact mặc định, tắt được bằng redact: false', () => {
    const events = [ev({ id: 0, type: 'user_message', source: 'user', payload: 'key sk-abcdefghijklmnopqrstuvwx' })];
    expect(serializeTrajectory(buildTrajectory(events, { conversationId: 'c1' }))).not.toContain('sk-abcdefghij');
    expect(
      serializeTrajectory(buildTrajectory(events, { conversationId: 'c1' }, { redact: false }), { redact: false }),
    ).toContain('sk-abcdefghij');
  });

  it('lastN và dropSystemEvents thu hẹp file', () => {
    const events = [ev({ id: 0 }), ...SESSION];
    const traj = buildTrajectory(events, { conversationId: 'c1' }, { lastN: 3, dropSystemEvents: true });
    expect(traj.events).toHaveLength(3);
    expect(traj.events.some((e) => e.type === 'system_event')).toBe(false);
  });
});

describe('agent runtime trajectory — import khoan dung', () => {
  it('bỏ qua event sai type kèm warning, không ném lỗi', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      meta: { conversationId: 'c9' },
      events: [
        { type: 'user_message', ts: 1, payload: 'ok', source: 'user' },
        { type: 'khong_ton_tai', ts: 2, payload: 'x' },
        { type: 'assistant_message', ts: 3, payload: 'hi' },
      ],
    });
    const r = parseTrajectory(raw);
    expect(r.errors).toEqual([]);
    expect(r.trajectory?.events).toHaveLength(2);
    expect(r.warnings[0]).toContain('type không hợp lệ');
  });

  it('JSONL có dòng rác → cảnh báo và đọc tiếp', () => {
    const raw = [
      JSON.stringify({ schemaVersion: 1, meta: { conversationId: 'c2' } }),
      JSON.stringify({ type: 'user_message', ts: 1, payload: 'a', source: 'user' }),
      'đây không phải json',
      JSON.stringify({ type: 'assistant_message', ts: 2, payload: 'b', source: 'model' }),
    ].join('\n');
    const r = parseTrajectory(raw);
    expect(r.trajectory?.events).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes('không phải JSON'))).toBe(true);
  });

  it('nhận mảng event thuần và một event lẻ', () => {
    const arr = parseTrajectory(JSON.stringify([{ type: 'user_message', ts: 1, payload: 'x', source: 'user' }]));
    expect(arr.trajectory?.events).toHaveLength(1);
    expect(arr.trajectory?.meta.conversationId).toBe('imported');
    const one = parseTrajectory(JSON.stringify({ type: 'user_message', ts: 1, payload: 'x', source: 'user' }));
    expect(one.trajectory?.events).toHaveLength(1);
  });

  it('input rỗng / JSON không có events → lỗi rõ ràng', () => {
    expect(parseTrajectory('').errors).toEqual(['input rỗng']);
    expect(parseTrajectory('{"foo":1}').errors[0]).toContain('events');
    expect(parseTrajectory('   \n  ').trajectory).toBeNull();
  });

  it('schema mới hơn bản hiện tại → warning nhưng vẫn đọc', () => {
    const raw = JSON.stringify({ schemaVersion: 99, meta: { conversationId: 'x' }, events: [{ type: 'system_event', ts: 1, payload: '' }] });
    const r = parseTrajectory(raw);
    expect(r.trajectory?.events).toHaveLength(1);
    expect(r.warnings[0]).toContain('schema v99');
  });

  it('payload không phải string được chuẩn hoá thay vì làm hỏng file', () => {
    const r = parseTrajectory(JSON.stringify([{ type: 'agent_action', ts: 1, toolName: 'shell', payload: { cmd: 'ls' } }]));
    expect(r.trajectory?.events[0]?.payload).toBe('{"cmd":"ls"}');
    expect(r.trajectory?.events[0]?.toolName).toBe('shell');
  });
});

describe('agent runtime trajectory — thống kê', () => {
  it('đếm theo type, tool, lỗi, trùng lặp và thời lượng', () => {
    const s = trajectoryStats(SESSION);
    expect(s.total).toBe(6);
    expect(s.userTurns).toBe(1);
    expect(s.assistantTurns).toBe(1);
    expect(s.toolCalls).toBe(2);
    expect(s.toolErrors).toBe(1);
    expect(s.uniqueTools).toBe(2);
    expect(s.durationMs).toBe(5000);
    expect(s.duplicatePayloads).toBe(0);
    expect(s.avgPayloadChars).toBeGreaterThan(0);
  });

  it('payload lặp lại bị đếm là tín hiệu vòng lặp', () => {
    const repeated = [ev({ id: 0, type: 'agent_observation', toolName: 'shell', payload: 'same', contentHash: 'x', source: 'tool' }), ev({ id: 1, type: 'agent_observation', toolName: 'shell', payload: 'same', contentHash: 'x', source: 'tool' })];
    expect(trajectoryStats(repeated).duplicatePayloads).toBe(1);
  });

  it('stream rỗng không chia cho 0', () => {
    const s = trajectoryStats([]);
    expect(s.total).toBe(0);
    expect(s.avgPayloadChars).toBe(0);
    expect(s.durationMs).toBe(0);
  });
});

describe('agent runtime trajectory — transcript & diff', () => {
  it('transcript markdown có nhãn event và làm sạch ANSI', () => {
    const traj = buildTrajectory(
      [
        ev({ id: 0, type: 'user_message', source: 'user', payload: 'chạy test' }),
        ev({ id: 1, type: 'agent_observation', source: 'tool', toolName: 'shell', payload: '\u001B[31mFAIL\u001B[0m 1 test' }),
      ],
      { conversationId: 'c1', title: 'Bug build' },
      { redact: false },
    );
    const md = formatTrajectoryTranscript(traj);
    expect(md).toContain('# Trajectory: Bug build');
    expect(md).toContain('## #1 RESULT◄ `shell`');
    expect(md).toContain('FAIL 1 test');
    expect(md).not.toContain('\u001B');
  });

  it('diff: tool sequence giống nhau', () => {
    const a = buildTrajectory(SESSION, { conversationId: 'a' });
    const b = buildTrajectory(SESSION, { conversationId: 'b' });
    const d = diffTrajectories(a, b);
    expect(d.toolSequenceSame).toBe(true);
    expect(d.firstDivergenceIndex).toBe(-1);
    expect(d.summary).toContain('trùng tool sequence');
  });

  it('diff: phát hiện action lệch và tool chỉ có ở một bên', () => {
    const a = buildTrajectory(SESSION, { conversationId: 'a' });
    const b = buildTrajectory(
      [
        ev({ id: 0, type: 'user_message', source: 'user', payload: 'sửa lỗi build' }),
        ev({ id: 1, type: 'agent_action', source: 'model', toolName: 'grep', payload: '{"q":"TS2322"}' }),
      ],
      { conversationId: 'b' },
    );
    const d = diffTrajectories(a, b);
    expect(d.toolSequenceSame).toBe(false);
    expect(d.firstDivergenceIndex).toBe(0);
    expect(d.onlyInA).toContain('fs_read');
    expect(d.onlyInB).toContain('grep');
    expect(d.summary).toContain('Lệch từ action #0');
  });
});
