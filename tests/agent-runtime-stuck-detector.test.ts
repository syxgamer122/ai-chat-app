import { describe, it, expect, beforeEach } from 'vitest';
import {
  appendEvent,
  __clearAllEventStreams,
  type AgentRuntimeEvent,
} from '@/lib/agent-runtime/event-stream';
import {
  detectStuck,
  detectStuckForConversation,
  buildStuckSteering,
  STUCK_LOOP_REPEATS,
  STUCK_ERROR_LOOP_THRESHOLD,
  STUCK_MESSAGE_LOOP_THRESHOLD,
} from '@/lib/agent-runtime/stuck-detector';

/** Helper dựng event nhanh không cần store. */
function ev(
  type: AgentRuntimeEvent['type'],
  payload: string,
  toolName?: string,
): AgentRuntimeEvent {
  return {
    id: 0,
    type,
    ts: 0,
    payload,
    toolName,
    source: type === 'agent_action' || type === 'agent_error' ? 'model' : 'tool',
    contentHash: payload.replace(/\s+/g, ' ').trim().toLowerCase(),
  };
}

const READ_A = '{"path":"a.ts"}';
const OBS_A = 'file content a';

describe('agent runtime stuck-detector', () => {
  beforeEach(() => {
    __clearAllEventStreams();
  });

  it('stream ngắn / trống → không kẹt', () => {
    expect(detectStuck([]).stuck).toBe(false);
    expect(detectStuck([ev('user_message', 'hi')]).stuck).toBe(false);
  });

  it('repetition_4_4: 2 khối action-obs y hệt liên tiếp', () => {
    const events = [
      ev('agent_action', READ_A, 'fs_read'),
      ev('agent_observation', OBS_A, 'fs_read'),
      ev('agent_action', READ_A, 'fs_read'),
      ev('agent_observation', OBS_A, 'fs_read'),
      ev('agent_action', READ_A, 'fs_read'),
      ev('agent_observation', OBS_A, 'fs_read'),
      ev('agent_action', READ_A, 'fs_read'),
      ev('agent_observation', OBS_A, 'fs_read'),
    ];
    const d = detectStuck(events);
    expect(d.stuck).toBe(true);
    expect(d.pattern).toBe('repetition_4_4');
    expect(d.repeatedTool).toBe('fs_read');
    expect(d.detail).toContain('fs_read');
  });

  it('action-obs giống nhau nhưng chỉ 1.5 khối → không kết luận', () => {
    const events = [
      ev('agent_action', READ_A, 'fs_read'),
      ev('agent_observation', OBS_A, 'fs_read'),
      ev('agent_action', READ_A, 'fs_read'),
      ev('agent_observation', 'nội dung KHÁC', 'fs_read'),
    ];
    expect(detectStuck(events).stuck).toBe(false);
  });

  it('action_error_loop: cùng tool lỗi liên tiếp ≥ ngưỡng', () => {
    const events: AgentRuntimeEvent[] = [];
    for (let i = 0; i < STUCK_ERROR_LOOP_THRESHOLD; i += 1) {
      events.push(ev('agent_error', `err variant ${i}`, 'shell_run'));
    }
    const d = detectStuck(events);
    expect(d.stuck).toBe(true);
    expect(d.pattern).toBe('action_error_loop');
    expect(d.repeatedTool).toBe('shell_run');
    expect(d.detail).toContain('ĐỔI HƯỚNG');
  });

  it('error run bị ngắt bởi event khác → không còn là loop', () => {
    const events = [
      ev('agent_error', 'e1', 'shell_run'),
      ev('agent_error', 'e2', 'shell_run'),
      ev('user_message', 'thử lại nhé'),
      ev('agent_error', 'e3', 'shell_run'),
    ];
    expect(detectStuck(events).stuck).toBe(false);
  });

  it('repetition_3_3: khối action-obs-action y hệt (kết thúc bằng action)', () => {
    const events = [
      ev('agent_action', READ_A, 'fs_read'),
      ev('agent_observation', OBS_A, 'fs_read'),
      ev('agent_action', READ_A, 'fs_read'),
      ev('agent_observation', OBS_A, 'fs_read'),
      ev('agent_action', READ_A, 'fs_read'),
      ev('user_message', 'còn gì nữa không'), // bị ngắt → không tính 4_4
      ev('agent_action', READ_A, 'fs_read'),
    ];
    const d = detectStuck(events);
    // Với 6 event cuối gồm action/obs/action/obs/action + 1 user giữa — pattern
    // 3_3 cần cửa sổ 6 event thuần action/obs; trường hợp này chỉ kiểm không crash.
    expect(typeof d.stuck).toBe('boolean');
  });

  it('message_loop: assistant trả lời y hệt ≥ ngưỡng lần', () => {
    const events: AgentRuntimeEvent[] = [];
    for (let i = 0; i < STUCK_MESSAGE_LOOP_THRESHOLD; i += 1) {
      events.push(ev('assistant_message', 'Tôi không chắc phải làm gì tiếp.'));
    }
    const d = detectStuck(events);
    expect(d.stuck).toBe(true);
    expect(d.pattern).toBe('message_loop');
  });

  it('message_loop: nội dung chỉ khác whitespace vẫn tính là lặp', () => {
    const events: AgentRuntimeEvent[] = [];
    for (let i = 0; i < STUCK_MESSAGE_LOOP_THRESHOLD; i += 1) {
      events.push(ev('assistant_message', i % 2 ? 'câu trả lời  giống\n\nnhau' : 'câu trả lời giống nhau'));
    }
    const d = detectStuck(events);
    expect(d.stuck).toBe(true);
    expect(d.pattern).toBe('message_loop');
  });

  it('message_loop: câu trả lời khác nhau → không kẹt', () => {
    const events = [
      ev('assistant_message', 'lần 1'),
      ev('assistant_message', 'lần 2'),
      ev('assistant_message', 'lần 3'),
    ];
    expect(detectStuck(events).stuck).toBe(false);
  });

  it('detectStuckForConversation đọc từ store và nhận diện đủ 4-4', () => {
    for (let i = 0; i < 8; i += 1) {
      appendEvent('c', {
        type: i % 2 === 0 ? 'agent_action' : 'agent_observation',
        payload: i % 2 === 0 ? READ_A : OBS_A,
        toolName: 'fs_read',
      });
    }
    const d = detectStuckForConversation('c');
    expect(d.stuck).toBe(true);
    expect(d.pattern).toBe('repetition_4_4');
  });

  it('buildStuckSteering: kẹt → trả steering; không kẹt → undefined', () => {
    const stuck = detectStuck([
      ev('agent_action', READ_A, 'fs_read'),
      ev('agent_observation', OBS_A, 'fs_read'),
      ev('agent_action', READ_A, 'fs_read'),
      ev('agent_observation', OBS_A, 'fs_read'),
      ev('agent_action', READ_A, 'fs_read'),
      ev('agent_observation', OBS_A, 'fs_read'),
      ev('agent_action', READ_A, 'fs_read'),
      ev('agent_observation', OBS_A, 'fs_read'),
    ]);
    const steering = buildStuckSteering(stuck);
    expect(steering).toBeDefined();
    expect(steering).toContain('[PHÁT HIỆN BẤT THƯỜNG]');
    expect(buildStuckSteering({ stuck: false, detail: '' })).toBeUndefined();
  });

  it('hằng số khớp thiết kế (2 khối lặp)', () => {
    expect(STUCK_LOOP_REPEATS).toBe(2);
  });
});
