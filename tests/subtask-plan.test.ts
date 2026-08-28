import { describe, expect, it } from 'vitest';
import {
  emptyPlan,
  addSubtask,
  updateSubtaskStatus,
  planProgress,
  formatPlanSummary,
  parsePlan,
} from '@/lib/subtask-plan';

describe('subtask-plan', () => {
  it('emptyPlan tạo plan rỗng', () => {
    const p = emptyPlan('Test plan');
    expect(p.title).toBe('Test plan');
    expect(p.subtasks).toEqual([]);
  });

  it('addSubtask thêm subtask với ID tự động', () => {
    let p = emptyPlan('Build auth');
    p = addSubtask(p, 'Create login form', { files: ['src/login.tsx'] });
    p = addSubtask(p, 'Add validation');
    expect(p.subtasks).toHaveLength(2);
    expect(p.subtasks[0].id).toBe('st-1');
    expect(p.subtasks[1].id).toBe('st-2');
    expect(p.subtasks[0].files).toEqual(['src/login.tsx']);
    expect(p.subtasks[0].status).toBe('pending');
  });

  it('updateSubtaskStatus cập nhật đúng subtask', () => {
    let p = emptyPlan('Test');
    p = addSubtask(p, 'Task A');
    p = addSubtask(p, 'Task B');
    const updated = updateSubtaskStatus(p, 'st-1', 'done');
    expect(updated).not.toBeNull();
    expect(updated!.subtasks[0].status).toBe('done');
    expect(updated!.subtasks[1].status).toBe('pending');
  });

  it('updateSubtaskStatus trả null cho ID không tồn tại', () => {
    const p = emptyPlan('Test');
    expect(updateSubtaskStatus(p, 'nope', 'done')).toBeNull();
  });

  it('planProgress tính đúng thống kê', () => {
    let p = emptyPlan('Test');
    p = addSubtask(p, 'A');
    p = addSubtask(p, 'B');
    p = addSubtask(p, 'C');
    p = updateSubtaskStatus(p, 'st-1', 'done')!;
    p = updateSubtaskStatus(p, 'st-2', 'failed')!;
    const prog = planProgress(p);
    expect(prog.total).toBe(3);
    expect(prog.done).toBe(1);
    expect(prog.failed).toBe(1);
    expect(prog.pending).toBe(1);
    expect(prog.percentComplete).toBe(33);
  });

  it('formatPlanSummary hiển thị checkbox list', () => {
    let p = emptyPlan('Auth module');
    p = addSubtask(p, 'Login form');
    p = addSubtask(p, 'Validation');
    p = updateSubtaskStatus(p, 'st-1', 'done')!;
    const summary = formatPlanSummary(p);
    expect(summary).toContain('[PLAN] Auth module (1/2 xong, 50%)');
    expect(summary).toContain('● [st-1] Login form');
    expect(summary).toContain('○ [st-2] Validation');
  });

  it('parsePlan round-trip từ JSON', () => {
    let p = emptyPlan('Test');
    p = addSubtask(p, 'Task A', { description: 'desc', files: ['a.ts'] });
    p = updateSubtaskStatus(p, 'st-1', 'in_progress')!;
    const json = JSON.parse(JSON.stringify(p));
    const parsed = parsePlan(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe('Test');
    expect(parsed!.subtasks[0].status).toBe('in_progress');
    expect(parsed!.subtasks[0].files).toEqual(['a.ts']);
  });

  it('parsePlan trả null cho input rác', () => {
    expect(parsePlan(null)).toBeNull();
    expect(parsePlan({})).toBeNull();
    expect(parsePlan({ title: 42 })).toBeNull();
    expect(parsePlan({ title: 'ok', subtasks: 'bad' })).toBeNull();
  });
});
