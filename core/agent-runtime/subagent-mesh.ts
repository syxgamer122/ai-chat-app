/**
 * core/agent-runtime/subagent-mesh.ts
 *
 * Subagent Mesh Coordinator (Layer 4: Capability-Based Subagent Mesh).
 * Điều phối vòng đời khởi tạo, thực thi và cách ly tài nguyên của các Subagents.
 */

import {
  type AgentCapabilityScope,
  createCapabilityScope,
  validateSubagentPermission,
} from './capability-context';
import { VirtualStagingOverlayFS } from './virtual-staging-fs';

export interface SubagentSession {
  subagentId: string;
  parentChatId: string;
  role: string;
  scope: AgentCapabilityScope;
  overlayFs: VirtualStagingOverlayFS;
  invokedToolsCount: number;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'aborted';
  createdAt: number;
}

export class SubagentMeshCoordinator {
  private sessions = new Map<string, SubagentSession>();

  public spawnSubagent(opts: {
    subagentId: string;
    parentChatId: string;
    role: string;
    allowedTools?: string[];
    readPatterns?: string[];
    writePatterns?: string[];
    allowEgress?: boolean;
    maxToolCalls?: number;
  }): SubagentSession {
    const scope = createCapabilityScope({
      subagentId: opts.subagentId,
      parentChatId: opts.parentChatId,
      allowedTools: opts.allowedTools,
      readPatterns: opts.readPatterns,
      writePatterns: opts.writePatterns,
      allowEgress: opts.allowEgress,
      maxToolCalls: opts.maxToolCalls,
    });

    const session: SubagentSession = {
      subagentId: opts.subagentId,
      parentChatId: opts.parentChatId,
      role: opts.role,
      scope,
      overlayFs: new VirtualStagingOverlayFS(),
      invokedToolsCount: 0,
      status: 'idle',
      createdAt: Date.now(),
    };

    this.sessions.set(opts.subagentId, session);
    return session;
  }

  public getSession(subagentId: string): SubagentSession | undefined {
    return this.sessions.get(subagentId);
  }

  public async executeSubagentTool(
    subagentId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const session = this.sessions.get(subagentId);
    if (!session) {
      return { success: false, error: `[SubagentMesh] Không tìm thấy phiên subagent '${subagentId}'.` };
    }

    // 1. Kiểm tra giới hạn số lượt gọi công cụ
    if (session.invokedToolsCount >= session.scope.maxToolCalls) {
      return {
        success: false,
        error: `[CapBAC] Subagent '${subagentId}' đã vượt quá hạn ngạch gọi tool (${session.scope.maxToolCalls}).`,
      };
    }

    // 2. Thẩm định quyền hạn CapBAC
    const check = validateSubagentPermission(session.scope, toolName, args);
    if (!check.allowed) {
      return { success: false, error: check.reason };
    }

    session.invokedToolsCount++;

    // 3. Định tuyến thao tác ghi tệp vào Virtual Staging OverlayFS trong RAM
    if (['fs_write', 'fs_edit'].includes(toolName) && typeof args.path === 'string') {
      const content = String(args.content || '');
      await session.overlayFs.writeFile(args.path, content);
      return {
        success: true,
        result: {
          stagedInRam: true,
          path: args.path,
          bytes: content.length,
          note: 'Thay đổi đã được cô lập an toàn trong RAM Virtual Staging OverlayFS.',
        },
      };
    }

    return {
      success: true,
      result: { executed: true, tool: toolName },
    };
  }

  public terminateSubagent(subagentId: string): void {
    const session = this.sessions.get(subagentId);
    if (session) {
      session.status = 'aborted';
      session.overlayFs.clear();
      this.sessions.delete(subagentId);
    }
  }
}

export const subagentMeshCoordinator = new SubagentMeshCoordinator();
