import { describe, it, expect } from 'vitest';
import {
  evaluateToolcallRules,
  type ToolcallRule,
} from '@/lib/toolcall-rules';
import { shouldAutoApprove, type AutoApproveContext } from '@/lib/auto-pilot';

describe('User Toolcall Rules Protocol & Precedence', () => {
  const envProtectionRule: ToolcallRule = {
    id: 'rule-env-protect',
    when: {
      tool: 'fs_write',
      pathGlob: '*.env',
    },
    action: 'deny',
    message: 'Nghiêm cấm ghi đè trực tiếp các file cấu hình nhạy cảm .env',
    scope: 'workspace',
  };

  const gitPushRule: ToolcallRule = {
    id: 'rule-git-force',
    when: {
      tool: 'shell_run',
      argMatches: 'push\\s+--force',
    },
    action: 'deny',
    message: 'Chặn thao tác git push force để bảo vệ commit history',
    scope: 'workspace',
  };

  const allowReadmeRule: ToolcallRule = {
    id: 'rule-readme-allow',
    when: {
      tool: 'fs_write',
      pathGlob: '*README.md',
    },
    action: 'allow',
    message: 'Cho phép tự động ghi file tài liệu README',
    scope: 'workspace',
  };

  describe('Destructive Commands Absolute Block', () => {
    it('blocks rm -rf / regardless of user rules or allow actions', () => {
      const permissiveRule: ToolcallRule = {
        id: 'rule-allow-all',
        when: { tool: '*' },
        action: 'allow',
        message: 'Cho phép tất cả',
        scope: 'global',
      };

      const verdict = evaluateToolcallRules(
        'shell_run',
        { command: 'rm -rf /' },
        [permissiveRule],
      );

      expect(verdict.decision).toBe('deny');
      if (verdict.decision === 'deny') {
        expect(verdict.reason).toContain('Always-Block Safety Policy');
      }
    });

    it('blocks fork bombs unconditionally', () => {
      const verdict = evaluateToolcallRules(
        'shell_run',
        { command: ':(){ :|:& };:' },
        [],
      );
      expect(verdict.decision).toBe('deny');
    });
  });

  describe('User Toolcall Rules Evaluation', () => {
    it('denies access to protected .env file with exact verbatim rule message', () => {
      const verdict = evaluateToolcallRules(
        'fs_write',
        { path: '.env', content: 'SECRET=123' },
        [envProtectionRule],
      );

      expect(verdict.decision).toBe('deny');
      if (verdict.decision === 'deny') {
        expect(verdict.reason).toBe('Nghiêm cấm ghi đè trực tiếp các file cấu hình nhạy cảm .env');
        expect(verdict.ruleId).toBe('rule-env-protect');
      }
    });

    it('denies git push force via argument pattern matching', () => {
      const verdict = evaluateToolcallRules(
        'shell_run',
        { command: 'git push --force origin main' },
        [gitPushRule],
      );

      expect(verdict.decision).toBe('deny');
      if (verdict.decision === 'deny') {
        expect(verdict.reason).toBe('Chặn thao tác git push force để bảo vệ commit history');
      }
    });

    it('allows permitted pattern with exact rule message', () => {
      const verdict = evaluateToolcallRules(
        'fs_write',
        { path: 'README.md', content: '# Docs' },
        [allowReadmeRule],
      );

      expect(verdict.decision).toBe('allow');
      if (verdict.decision === 'allow') {
        expect(verdict.reason).toBe('Cho phép tự động ghi file tài liệu README');
      }
    });

    it('passes through to auto-pilot when no rules match', () => {
      const verdict = evaluateToolcallRules(
        'fs_read',
        { path: 'src/index.ts' },
        [envProtectionRule, gitPushRule],
      );

      expect(verdict.decision).toBe('pass_through');
    });
  });

  describe('Auto-pilot shouldAutoApprove Integration', () => {
    it('denies auto-approve when toolcall rule denies the tool', () => {
      const denyRule: ToolcallRule = {
        id: 'rule-deny-write',
        when: { tool: 'fs_write' },
        action: 'deny',
        message: 'Block all fs_write',
        scope: 'workspace',
      };

      const ctx: AutoApproveContext = {
        toolName: 'fs_write',
        args: { path: 'test.ts' },
        policy: 'never', // YOLO mode
        autoPilotEnabled: true,
        toolcallRules: [denyRule],
      };

      // In YOLO mode, normally fs_write is approved, but toolcall rule denies it!
      const approved = shouldAutoApprove(ctx);
      expect(approved).toBe(false);
    });

    it('allows auto-approve when toolcall rule allows even under smart policy for write tools', () => {
      const allowRule: ToolcallRule = {
        id: 'rule-allow-write',
        when: { tool: 'fs_write' },
        action: 'allow',
        message: 'Allow fs_write',
        scope: 'workspace',
      };

      const ctx: AutoApproveContext = {
        toolName: 'fs_write',
        args: { path: 'test.ts' },
        policy: 'smart', // In smart mode, write tools normally require approval!
        autoPilotEnabled: true,
        toolcallRules: [allowRule],
      };

      const approved = shouldAutoApprove(ctx);
      expect(approved).toBe(true);
    });

    it('does not deny when tool matches but pathGlob does not match in shouldAutoApprove', () => {
      const ctx: AutoApproveContext = {
        toolName: 'fs_write',
        args: { path: 'src/main.ts' },
        policy: 'never',
        autoPilotEnabled: true,
        toolcallRules: [envProtectionRule], // when: { tool: 'fs_write', pathGlob: '*.env' }
      };
      // In YOLO (never) mode, writing a non-.env file should be approved!
      expect(shouldAutoApprove(ctx)).toBe(true);
    });

    it('correctly matches rules by group', () => {
      const denyShellGroupRule: ToolcallRule = {
        id: 'rule-deny-shell',
        when: { group: 'shell' },
        action: 'deny',
        message: 'No shell tools allowed',
        scope: 'workspace',
      };

      const shellVerdict = evaluateToolcallRules(
        'shell_run',
        { command: 'ls' },
        [denyShellGroupRule],
      );
      expect(shellVerdict.decision).toBe('deny');

      const fsVerdict = evaluateToolcallRules(
        'fs_read',
        { path: 'src/main.ts' },
        [denyShellGroupRule],
      );
      expect(fsVerdict.decision).toBe('pass_through');
    });
  });
});
