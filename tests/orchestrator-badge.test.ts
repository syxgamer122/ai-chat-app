import { describe, expect, it } from 'vitest';
import { getOrchestratorAdoptedAnnotation } from '@/components/chat/orchestrator-badge';

describe('getOrchestratorAdoptedAnnotation — extract provenance từ annotations', () => {
  const payload = {
    goal: 'Tìm hiểu Next.js 16',
    runs: 5,
    ok: 4,
    failed: 1,
    model: 'gpt-5',
    adoptedAt: 1_756_000_000_000,
  };

  it('trả về payload cho annotation orchestratorAdopted đầu tiên', () => {
    expect(
      getOrchestratorAdoptedAnnotation([{ tool: { id: 't1' } }, { orchestratorAdopted: payload }]),
    ).toEqual(payload);
  });

  it('lấy annotation ĐẦU TIÊN nếu (lý thuyết) có nhiều', () => {
    expect(
      getOrchestratorAdoptedAnnotation([
        { orchestratorAdopted: payload },
        { orchestratorAdopted: { goal: 'thứ hai' } },
      ]),
    ).toEqual(payload);
  });

  it('payload rỗng vẫn được trả về (component tự normalize, không crash)', () => {
    expect(getOrchestratorAdoptedAnnotation([{ orchestratorAdopted: {} }])).toEqual({});
  });

  it('null khi không có / annotations rỗng / ann không phải object / field không phải object', () => {
    expect(getOrchestratorAdoptedAnnotation(undefined)).toBeNull();
    expect(getOrchestratorAdoptedAnnotation([])).toBeNull();
    expect(getOrchestratorAdoptedAnnotation([null, 'x', 42, { subagent: { phase: 'done' } }])).toBeNull();
    // orchestratorAdopted phải là object — giá trị nguyên thủy bị coi là thiếu.
    expect(getOrchestratorAdoptedAnnotation([{ orchestratorAdopted: null }])).toBeNull();
    expect(getOrchestratorAdoptedAnnotation([{ orchestratorAdopted: 'oops' }])).toBeNull();
  });
});
