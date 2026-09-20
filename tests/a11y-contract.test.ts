import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_TABS } from '@/components/settings-dialog';
import { Z_INDEX, Z_CLASS } from '@/lib/ui-z';

const ROOT = resolve(__dirname, '..');

function readComponent(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf-8');
}

describe('A11y Contract & Accessibility Compliance', () => {
  describe('Settings Dialog Tab & Panel ARIA linkage', () => {
    it('declares the 6 unified semantic tabs', () => {
      const tabIds = SETTINGS_TABS.map((t) => t.id);
      expect(tabIds).toEqual(['appearance', 'providers', 'safety', 'extensions', 'memory', 'data']);
    });

    it('ensures each role="tab" aria-controls points to a matching static tabpanel id', () => {
      const src = readComponent('components/settings-dialog.tsx');

      // Assert tab button markup uses static id pattern
      expect(src).toContain('id={`settings-tab-${t.id}`}');
      expect(src).toContain('aria-controls={`settings-panel-${t.id}`}');

      // Assert each tab has its own dedicated tabpanel element with matching id and aria-labelledby
      for (const t of SETTINGS_TABS) {
        expect(src).toContain(`id="settings-panel-${t.id}"`);
        expect(src).toContain(`aria-labelledby="settings-tab-${t.id}"`);
      }
    });
  });

  describe('Modal Dialogs & Focus Containment', () => {
    /*
     * z-index nay lấy từ thang tập trung `lib/ui-z.ts` chứ không viết cứng, nên
     * test kiểm tra việc DÙNG ĐÚNG LỚP thay vì khớp chuỗi `z-[NN]`.
     */
    const MODAL_FILES = [
      { path: 'components/diff-confirm.tsx', name: 'DiffConfirm', layer: 'approval' },
      { path: 'components/shell-confirm.tsx', name: 'ShellConfirm', layer: 'approval' },
      { path: 'components/staging-panel.tsx', name: 'StagingPanel', layer: 'approval' },
      { path: 'components/mcp/tool-approval-dialog.tsx', name: 'McpToolApprovalDialog', layer: 'approvalCritical' },
      { path: 'components/tools-panel.tsx', name: 'ToolsPanel', layer: 'navigation' },
      { path: 'components/recipes/recipes-panel.tsx', name: 'RecipesPanel', layer: 'navigation' },
    ];

    for (const modal of MODAL_FILES) {
      it(`${modal.name} conforms to dialog a11y and focus trap contract`, () => {
        const src = readComponent(modal.path);

        expect(src).toContain('role="dialog"');
        expect(src).toContain('aria-modal="true"');
        expect(src).toMatch(/aria-labelledby=|aria-label=/);
        expect(src).toContain('useFocusTrap');
        expect(src, `${modal.name} phải dùng Z_CLASS.${modal.layer}`).toContain(
          `Z_CLASS.${modal.layer}`,
        );
      });
    }

    it('ensures ToastHost dùng lớp toast (trên dropdown, dưới modal)', () => {
      const src = readComponent('components/toast.tsx');
      expect(src).toContain('Z_CLASS.toast');
    });

    it('SettingsDialog nằm TRÊN mọi modal — lớp system', () => {
      /*
       * Lỗi cũ: Settings ở `z-50`, thấp hơn cả modal phê duyệt (80) lẫn panel
       * điều hướng (90). Mở Cài đặt trong lúc có modal đang mở thì modal vẽ
       * ĐÈ lên Cài đặt.
       */
      const src = readComponent('components/settings-dialog.tsx');
      expect(src).toContain('Z_CLASS.system');
      expect(src).not.toContain('fixed inset-0 z-50');
    });

    it('menu ngữ cảnh sidebar KHÔNG được nổi trên modal', () => {
      const src = readComponent('components/sidebar.tsx');
      expect(src).not.toContain('z-[100]');
    });

    it('chat-interface dùng trọng tài phê duyệt chung, không phải hai hàng đợi song song', () => {
      /*
       * Lỗi cũ: diff và shell mỗi loại có hàng đợi riêng (`diffQueueRef` /
       * `shellQueueRef` + `diffOpenRef` / `shellOpenRef`). Khi agent gọi SONG
       * SONG một fs_edit và một shell_run trong cùng step, cả hai modal cùng
       * render ở z-[80] — chồng lên nhau và modal dưới không bấm được.
       *
       * Hành vi của trọng tài được kiểm chứng thật ở tests/approval-queue.test.ts.
       * Ở đây chỉ chốt rằng component DÙNG module chung thay vì tự viết lại.
       */
      const src = readComponent('components/chat-interface.tsx');

      expect(src, 'phải dùng ApprovalQueue dùng chung').toMatch(
        /import \{[^}]*ApprovalQueue[^}]*\} from '@\/lib\/approval-queue'/,
      );

      for (const stale of ['diffQueueRef', 'shellQueueRef', 'diffOpenRef', 'shellOpenRef']) {
        expect(src, `còn sót hàng đợi riêng "${stale}" — nguy cơ chồng modal`).not.toContain(stale);
      }

      /* API công khai không đổi: nơi gọi không phải sửa. */
      expect(src).toContain('showDiffModal');
      expect(src).toContain('showShellModal');
      expect(src).toContain('closeDiffModal');
      expect(src).toContain('closeShellModal');
    });
  });

  describe('Thang z-index tập trung (lib/ui-z.ts)', () => {
    it('bất biến approval < approvalCritical < navigation < system', () => {
      expect(Z_INDEX.approval).toBeLessThan(Z_INDEX.approvalCritical);
      expect(Z_INDEX.approvalCritical).toBeLessThan(Z_INDEX.navigation);
      expect(Z_INDEX.navigation).toBeLessThan(Z_INDEX.system);
      expect(Z_INDEX.dropdown).toBeLessThan(Z_INDEX.popover);
      expect(Z_INDEX.popover).toBeLessThan(Z_INDEX.toast);
      expect(Z_INDEX.toast).toBeLessThan(Z_INDEX.approval);
    });

    it('Z_CLASS khớp giá trị số', () => {
      expect(Z_CLASS.approval).toBe(`z-[${Z_INDEX.approval}]`);
      expect(Z_CLASS.navigation).toBe(`z-[${Z_INDEX.navigation}]`);
      expect(Z_CLASS.system).toBe(`z-[${Z_INDEX.system}]`);
      expect(Z_CLASS.toast).toBe(`z-[${Z_INDEX.toast}]`);
    });
  });

  describe('Keyboard navigation in menus', () => {
    it('TaskMenu implements APG arrow key navigation and Escape dismissal', () => {
      const src = readComponent('components/composer.tsx');
      expect(src).toContain('ArrowDown');
      expect(src).toContain('ArrowUp');
      expect(src).toContain('Escape');
      expect(src).toContain('Home');
      expect(src).toContain('End');
    });
  });
});
