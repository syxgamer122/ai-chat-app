/**
 * Khóa cổng chặn 'deny' cho client tool (R2-1 + R2-2).
 *
 * Phần 1: ma trận isToolDenied (lib/tool-catalog.ts). Hàm thuần quyết định
 * tool có thuộc nhóm đang bị chặn không; tool lạ (mcp__*, tên chưa có trong
 * map) phải false vì không thuộc nhóm quyền nào.
 *
 * Phần 2: source-scan components/chat-interface.tsx theo precedent của
 * tests/staging-panel-keyboard.test.ts (repo chạy vitest environment 'node',
 * không có hạ tầng DOM). Funnel client tool PHẢI gọi isToolDenied trước khi
 * thực thi; ai bỏ cổng là test đỏ ngay.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALL_TOOL_CATEGORIES,
  isToolDenied,
  TOOL_CATEGORY_MAP,
} from '@/lib/tool-catalog';
import type { PermissionOverride, ToolPermissions } from '@/lib/store';

/** Quyền đồng loạt MỘT giá trị cho cả 8 nhóm (builder cho ma trận). */
function perms(value: PermissionOverride): ToolPermissions {
  const out = {} as ToolPermissions;
  for (const cat of ALL_TOOL_CATEGORIES) out[cat] = value;
  return out;
}

describe('isToolDenied - ma trận tool → nhóm → quyền deny', () => {
  it('shell_run/bg_run/bg_status/bg_stop theo nhóm shell: chặn shell là chặn cả lệnh nền', () => {
    // Đột biến bị chặn: bỏ bg_* khỏi TOOL_CATEGORY_MAP (bug cũ của taxonomy)
    // → 3 dòng bg_* trả false là đỏ.
    const p = { ...perms('default'), shell: 'deny' };
    expect(isToolDenied('shell_run', p)).toBe(true);
    expect(isToolDenied('bg_run', p)).toBe(true);
    expect(isToolDenied('bg_status', p)).toBe(true);
    expect(isToolDenied('bg_stop', p)).toBe(true);
  });

  it('lesson_save/memory_save theo nhóm memory (bài học không có nhóm riêng)', () => {
    // Đột biến bị chặn: gán nhầm lesson_save sang nhóm khác → dòng đầu đỏ.
    const p = { ...perms('default'), memory: 'deny' };
    expect(isToolDenied('lesson_save', p)).toBe(true);
    expect(isToolDenied('memory_save', p)).toBe(true);
  });

  it('delegate theo nhóm delegate: chặn nhóm này là chặn cả giao subagent', () => {
    expect(isToolDenied('delegate', { ...perms('default'), delegate: 'deny' })).toBe(true);
  });

  it('nhóm khác bị chặn thì tool ngoài nhóm đó vẫn chạy bình thường', () => {
    // Đột biến bị chặn: isToolDenied chỉ tra "có permissions nào là deny
    // không" (bỏ đối chiếu category) → 2 dòng dưới trả true là đỏ.
    const p = { ...perms('default'), shell: 'deny' };
    expect(isToolDenied('fs_read', p)).toBe(false);
    expect(isToolDenied('lesson_save', p)).toBe(false);
  });

  it('tool lạ (mcp__*, tên chưa có trong map, chuỗi rỗng) không bao giờ bị chặn', () => {
    // MCP tool không qua funnel client nên phải false kể cả khi mọi nhóm
    // đều deny - chặn nhầm là vỡ luồng MCP.
    const allDeny = perms('deny');
    expect(isToolDenied('mcp__search', allDeny)).toBe(false);
    expect(isToolDenied('mcp__filesystem__read_file', allDeny)).toBe(false);
    expect(isToolDenied('khong_co_tool_nay', allDeny)).toBe(false);
    expect(isToolDenied('', allDeny)).toBe(false);
  });

  it("chỉ 'deny' chặn; 'ask'/'auto'/'default' đều không chặn", () => {
    // Đột biến bị chặn: điều kiện lỏng thành !== 'auto' hoặc nhầm nhánh
    // 'ask' → một trong các dòng dưới đỏ.
    for (const value of ['ask', 'auto', 'default'] as const) {
      expect(isToolDenied('shell_run', perms(value)), `giá trị "${value}" không được chặn`).toBe(false);
    }
    expect(isToolDenied('shell_run', perms('deny'))).toBe(true);
  });

  it('mọi tên trong TOOL_CATEGORY_MAP đều tra được nhóm (không tool nào lọt lưới)', () => {
    // Đột biến bị chặn: đổi một tên trong map thành khóa lạ → tên cũ lọt
    // ra ngoài map, tra với allDeny trả false là đỏ.
    const allDeny = perms('deny');
    for (const name of Object.keys(TOOL_CATEGORY_MAP)) {
      expect(isToolDenied(name, allDeny), `"${name}" phải tra được nhóm của mình`).toBe(true);
    }
  });

  it('permissions thiếu khoá nhóm (object rỗng) không chặn tool đã biết', () => {
    // Đột biến bị chặn: đọc permissions[category] mà tra undefined !== 'deny'
    // bị sai kiểu (đổi thành === undefined thì test này đỏ).
    expect(isToolDenied('shell_run', {})).toBe(false);
  });
});

describe('chat-interface - cổng deny trong funnel client tool (source-scan)', () => {
  const code = fs.readFileSync(path.resolve(__dirname, '../components/chat-interface.tsx'), 'utf8');

  it('funnel gọi isToolDenied(toolCall.toolName, toolPermissions)', () => {
    // Đột biến bị chặn: bỏ cổng hoặc đổi tên biến → regex dưới không khớp.
    expect(code).toMatch(/isToolDenied\(\s*toolCall\.toolName,\s*toolPermissions\s*\)/);
  });

  it('cổng nằm TRƯỚC nhánh desktop-only và switch thực thi tool', () => {
    // Đột biến bị chặn: dời cổng xuống sau switch (tool đã chạy xong mới
    // chặn) → chỉ số cổng lớn hơn một trong hai chỉ số dưới là đỏ.
    const gate = code.indexOf('isToolDenied(toolCall.toolName');
    const desktopGate = code.indexOf('desktopOnly.has(toolCall.toolName)');
    const execSwitch = code.indexOf('switch (toolCall.toolName)');
    expect(gate, 'không tìm thấy cổng deny trong funnel').toBeGreaterThanOrEqual(0);
    expect(desktopGate, 'cổng phải đứng trước nhánh desktop-only').toBeGreaterThan(gate);
    expect(execSwitch, 'cổng phải đứng trước switch thực thi').toBeGreaterThan(gate);
  });

  it('lỗi trả về nêu tên nhóm hiển thị đọc từ TOOL_CATEGORY_LABELS', () => {
    // Đột biến bị chặn: thông báo lỗi chỉ ghi tên tool, không ghi tên nhóm
    // hiển thị → regex dưới không khớp.
    expect(code).toMatch(/TOOL_CATEGORY_LABELS\[category\]/);
  });
});
