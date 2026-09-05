import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generatePlanMd,
  generateProgressMd,
  generateRequestMd,
  parsePlanMd,
  parseProgressMd,
  parseRequestMd,
  readTeamworkArtifacts,
  updateProgressState,
  updateProgressStatus,
  writeTeamworkArtifacts,
} from '../lib/teamwork/artifacts';
import {
  ProgressState,
  TeamworkPlan,
  TeamworkRequest,
} from '../lib/teamwork/types';

describe('Artifacts Engine — REQUEST.md', () => {
  const sampleRequest: TeamworkRequest = {
    title: 'Thêm tính năng Teamwork Engine Dual-Mode',
    originalGoal: 'Hiện thực hóa Runtime Teamwork Multi-Agent Engine 2-phase hỗ trợ Headless CLI và Electron.',
    repoContext: {
      latestCommit: 'abc1234 feat: baseline harness setup',
      gitStatus: 'clean (working tree clean)',
      workingDirectory: 'c:/Users/huumanh/Downloads/ai-chat-app',
    },
    constraints: {
      process: '2 Phase (Scope & Plan -> Execution & Critic)',
      concurrency: 'Tuần tự mặc định; tối đa 2 song song khi file hoàn toàn độc lập',
      fileOwnership: '1 worker / file tại 1 thời điểm',
      maxMilestones: 3,
      maxRetriesPerMilestone: 1,
      rateLimitPolicy: 'Gặp 429 dừng ngay, ghi PROGRESS.md, báo user',
    },
    acceptanceCriteria: [
      {
        description: 'Phase 1 tạo đầy đủ 3 tài liệu quản lý và dừng chờ xác nhận',
        verifyCommand: 'npx vitest run tests/teamwork-artifacts.test.ts',
        completed: false,
      },
      {
        description: 'Exclusive File Ownership chặn mọi xung đột ghi đồng thời',
        verifyCommand: 'npx vitest run tests/teamwork-file-lock.test.ts',
        completed: true,
      },
    ],
  };

  it('generates markdown strictly conforming to specification', () => {
    const md = generateRequestMd(sampleRequest);

    expect(md).toContain('# Request: Thêm tính năng Teamwork Engine Dual-Mode');
    expect(md).toContain('## Mục tiêu gốc');
    expect(md).toContain('Hiện thực hóa Runtime Teamwork Multi-Agent Engine 2-phase');
    expect(md).toContain('## Bối cảnh Repo');
    expect(md).toContain('- Commit gần nhất: abc1234 feat: baseline harness setup');
    expect(md).toContain('- Trạng thái git: clean (working tree clean)');
    expect(md).toContain('- Thư mục làm việc: c:/Users/huumanh/Downloads/ai-chat-app');
    expect(md).toContain('## Ràng buộc');
    expect(md).toContain('- Quy trình: 2 Phase');
    expect(md).toContain('- Concurrency: Tuần tự mặc định; tối đa 2 song song khi file hoàn toàn độc lập');
    expect(md).toContain('- Exclusive File Ownership: 1 worker / file tại 1 thời điểm');
    expect(md).toContain('- Giới hạn: Tối đa 3 milestones; retry tối đa 1 lần/milestone');
    expect(md).toContain('## Tiêu chí nghiệm thu (Acceptance Criteria)');
    expect(md).toContain('- [ ] Criterion 1: Phase 1 tạo đầy đủ 3 tài liệu quản lý và dừng chờ xác nhận (Lệnh kiểm chứng: `npx vitest run tests/teamwork-artifacts.test.ts`)');
    expect(md).toContain('- [x] Criterion 2: Exclusive File Ownership chặn mọi xung đột ghi đồng thời (Lệnh kiểm chứng: `npx vitest run tests/teamwork-file-lock.test.ts`)');
  });

  it('round-trips through generation and parsing without loss of key fields', () => {
    const md = generateRequestMd(sampleRequest);
    const parsed = parseRequestMd(md);

    expect(parsed.title).toBe(sampleRequest.title);
    expect(parsed.originalGoal).toContain('Hiện thực hóa Runtime Teamwork Multi-Agent Engine');
    expect(parsed.repoContext.latestCommit).toBe(sampleRequest.repoContext.latestCommit);
    expect(parsed.repoContext.gitStatus).toBe(sampleRequest.repoContext.gitStatus);
    expect(parsed.repoContext.workingDirectory).toBe(sampleRequest.repoContext.workingDirectory);
    expect(parsed.constraints.maxMilestones).toBe(3);
    expect(parsed.constraints.maxRetriesPerMilestone).toBe(1);

    expect(parsed.acceptanceCriteria.length).toBe(2);
    expect(parsed.acceptanceCriteria[0].completed).toBe(false);
    expect(parsed.acceptanceCriteria[0].verifyCommand).toBe('npx vitest run tests/teamwork-artifacts.test.ts');
    expect(parsed.acceptanceCriteria[1].completed).toBe(true);
    expect(parsed.acceptanceCriteria[1].verifyCommand).toBe('npx vitest run tests/teamwork-file-lock.test.ts');
  });
});

describe('Artifacts Engine — PLAN.md', () => {
  const samplePlan: TeamworkPlan = {
    title: 'Kế hoạch Triển khai Teamwork Multi-Agent Engine',
    milestones: [
      {
        id: 'M1',
        title: 'Core Types, FileLockManager & Artifacts Engine',
        goal: 'Định nghĩa types, cơ chế khóa file và sinh đọc 3 file markdown',
        dependsOn: 'None',
        ownedFiles: [
          'lib/teamwork/types.ts',
          'lib/teamwork/file-lock.ts',
          'lib/teamwork/artifacts.ts',
        ],
        verifyCommand: 'npx vitest run tests/teamwork-file-lock.test.ts tests/teamwork-artifacts.test.ts',
        status: 'todo',
        retryCount: 0,
        workerBrief: 'Tạo các interface chuẩn, hiện thực FileLockManager với concurrencyCap=2 và các hàm artifacts.',
      },
      {
        id: 'M2',
        title: 'Headless Tool Runner & Safety Layers',
        goal: 'Đóng gói fs, shell, git không phụ thuộc React',
        dependsOn: 'M1',
        ownedFiles: ['lib/teamwork/tools.ts'],
        verifyCommand: 'npx vitest run tests/teamwork-tools.test.ts',
        status: 'todo',
        retryCount: 0,
        workerBrief: 'Tích hợp path-guard, staging, auto-pilot và edit-blocks cho môi trường headless.',
      },
    ],
  };

  it('generates plan markdown conforming to specification', () => {
    const md = generatePlanMd(samplePlan);

    expect(md).toContain('# Plan: Kế hoạch Triển khai Teamwork Multi-Agent Engine');
    expect(md).toContain('## Danh sách Milestones (Tối đa 3)');
    expect(md).toContain('### Milestone M1: Core Types, FileLockManager & Artifacts Engine');
    expect(md).toContain('- **Mục đích**: Định nghĩa types, cơ chế khóa file và sinh đọc 3 file markdown');
    expect(md).toContain('- **Phụ thuộc**: None');
    expect(md).toContain('- **File sở hữu độc quyền**:');
    expect(md).toContain('  - `lib/teamwork/types.ts`');
    expect(md).toContain('  - `lib/teamwork/file-lock.ts`');
    expect(md).toContain('  - `lib/teamwork/artifacts.ts`');
    expect(md).toContain('- **Lệnh verify bắt buộc**: `npx vitest run tests/teamwork-file-lock.test.ts tests/teamwork-artifacts.test.ts`');
    expect(md).toContain('- **Worker Brief** (≤15 dòng):');
    expect(md).toContain('  Tạo các interface chuẩn');
  });

  it('enforces maximum 3 milestones cap during generation', () => {
    const overPlan: TeamworkPlan = {
      title: 'Too many milestones',
      milestones: [
        { ...samplePlan.milestones[0], id: 'M1' },
        { ...samplePlan.milestones[1], id: 'M2' },
        { ...samplePlan.milestones[0], id: 'M3' },
        { ...samplePlan.milestones[1], id: 'M4' },
      ],
    };

    const md = generatePlanMd(overPlan);
    expect(md).toContain('### Milestone M1');
    expect(md).toContain('### Milestone M2');
    expect(md).toContain('### Milestone M3');
    expect(md).not.toContain('### Milestone M4');
  });

  it('round-trips through generation and parsing', () => {
    const md = generatePlanMd(samplePlan);
    const parsed = parsePlanMd(md);

    expect(parsed.title).toBe(samplePlan.title);
    expect(parsed.milestones.length).toBe(2);

    const m1 = parsed.milestones[0];
    expect(m1.id).toBe('M1');
    expect(m1.title).toBe(samplePlan.milestones[0].title);
    expect(m1.goal).toBe(samplePlan.milestones[0].goal);
    expect(m1.dependsOn).toBe('None');
    expect(m1.ownedFiles).toEqual([
      'lib/teamwork/types.ts',
      'lib/teamwork/file-lock.ts',
      'lib/teamwork/artifacts.ts',
    ]);
    expect(m1.verifyCommand).toBe(samplePlan.milestones[0].verifyCommand);
    expect(m1.workerBrief).toContain('Tạo các interface chuẩn');

    const m2 = parsed.milestones[1];
    expect(m2.id).toBe('M2');
    expect(m2.dependsOn).toBe('M1');
    expect(m2.ownedFiles).toEqual(['lib/teamwork/tools.ts']);
  });
});

describe('Artifacts Engine — PROGRESS.md & Status Updates', () => {
  const sampleProgress: ProgressState = {
    title: 'Triển khai Teamwork Multi-Agent Engine',
    milestones: [
      {
        milestoneId: 'M1',
        title: 'Types and Lock',
        worker: 'worker-1',
        status: 'done',
        ownedFiles: ['lib/types.ts', 'lib/file-lock.ts'],
        criticVerdict: 'PASS',
        attempts: '1/2',
        notes: 'All 15 tests passed',
      },
      {
        milestoneId: 'M2',
        title: 'Headless Tools',
        worker: 'worker-2',
        status: 'doing',
        ownedFiles: ['lib/tools.ts'],
        criticVerdict: 'pending',
        attempts: '1/2',
        notes: 'Running vitest',
      },
    ],
    rateLimitStatus: 'HEALTHY',
    lastUpdated: '2026-09-03T05:30:00.000Z',
    rateLimitNote: 'None',
    executionLogs: [
      {
        timestamp: '2026-09-03T05:25:00.000Z',
        milestoneId: 'M1',
        agent: 'teamwork-worker',
        action: 'Implemented file locks',
        details: 'Added concurrency cap and path normalizer',
      },
      {
        timestamp: '2026-09-03T05:28:00.000Z',
        milestoneId: 'M1',
        agent: 'teamwork-critic',
        action: 'Verified test run',
        details: 'PASS: 15 tests passed',
      },
    ],
    fileStats: [
      { file: 'lib/types.ts', additions: 120, deletions: 0 },
      { file: 'lib/file-lock.ts', additions: 180, deletions: 10 },
    ],
  };

  it('generates progress markdown conforming to specification', () => {
    const md = generateProgressMd(sampleProgress);

    expect(md).toContain('# Progress: Triển khai Teamwork Multi-Agent Engine');
    expect(md).toContain('## Bảng trạng thái Milestone');
    expect(md).toContain('| Milestone | Worker | Trạng thái | File sở hữu | Critic Verdict | Lần thử | Ghi chú |');
    expect(md).toContain('| M1: Types and Lock | worker-1 | done | lib/types.ts, lib/file-lock.ts | PASS | 1/2 | All 15 tests passed |');
    expect(md).toContain('| M2: Headless Tools | worker-2 | doing | lib/tools.ts | pending | 1/2 | Running vitest |');
    expect(md).toContain('## Trạng thái Rate Limit & Hệ thống');
    expect(md).toContain('- Status: HEALTHY');
    expect(md).toContain('- Ghi chú 429: None');
    expect(md).toContain('## Nhật ký thực thi chi tiết');
    expect(md).toContain('### [2026-09-03T05:25:00.000Z] M1: Implemented file locks');
    expect(md).toContain('- Call: teamwork-worker');
    expect(md).toContain('## Thống kê File thay đổi');
    expect(md).toContain('- `lib/types.ts`: +120 / -0');
    expect(md).toContain('- `lib/file-lock.ts`: +180 / -10');
  });

  it('round-trips through generation and parsing', () => {
    const md = generateProgressMd(sampleProgress);
    const parsed = parseProgressMd(md);

    expect(parsed.title).toBe(sampleProgress.title);
    expect(parsed.rateLimitStatus).toBe('HEALTHY');
    expect(parsed.rateLimitNote).toBe('None');
    expect(parsed.milestones.length).toBe(2);

    expect(parsed.milestones[0].milestoneId).toBe('M1');
    expect(parsed.milestones[0].status).toBe('done');
    expect(parsed.milestones[0].criticVerdict).toBe('PASS');
    expect(parsed.milestones[0].attempts).toBe('1/2');

    expect(parsed.milestones[1].milestoneId).toBe('M2');
    expect(parsed.milestones[1].status).toBe('doing');

    expect(parsed.executionLogs.length).toBe(2);
    expect(parsed.fileStats.length).toBe(2);
    expect(parsed.fileStats[0]).toEqual({ file: 'lib/types.ts', additions: 120, deletions: 0 });
  });

  it('updates milestone status in progress state and returns valid markdown', () => {
    const initialMd = generateProgressMd(sampleProgress);

    const updatedMd = updateProgressStatus(initialMd, {
      milestoneId: 'M2',
      status: 'done',
      criticVerdict: 'PASS',
      attempts: '1/2',
      notes: 'All tools tests passed (10/10)',
      logEntry: {
        milestoneId: 'M2',
        agent: 'teamwork-critic',
        action: 'Completed Verification',
        details: 'PASS: 10 tests passed',
      },
      fileStats: [{ file: 'lib/tools.ts', additions: 250, deletions: 5 }],
    });

    const parsed = parseProgressMd(updatedMd);
    const m2 = parsed.milestones.find((m) => m.milestoneId === 'M2');
    expect(m2).toBeDefined();
    expect(m2?.status).toBe('done');
    expect(m2?.criticVerdict).toBe('PASS');
    expect(m2?.notes).toContain('All tools tests passed');

    expect(parsed.executionLogs.some((l) => l.action === 'Completed Verification')).toBe(true);
    expect(parsed.fileStats.some((s) => s.file === 'lib/tools.ts')).toBe(true);
  });

  it('handles rate-limit (429) logging properly and pauses cleanly', () => {
    const initialMd = generateProgressMd(sampleProgress);

    const blockedMd = updateProgressStatus(initialMd, {
      milestoneId: 'M2',
      status: 'blocked',
      rateLimitStatus: 'BLOCKED_429',
      rateLimitNote: 'Bị ngắt do 429 Too Many Requests lúc 05:35 UTC. Chờ xác nhận của user.',
      logEntry: {
        milestoneId: 'M2',
        agent: 'orchestrator',
        action: 'Rate-Limit Intercept',
        details: 'HTTP 429 caught. Engine auto-paused safely to prevent spamming.',
      },
    });

    const parsed = parseProgressMd(blockedMd);
    expect(parsed.rateLimitStatus).toBe('BLOCKED_429');
    expect(parsed.rateLimitNote).toContain('Bị ngắt do 429');

    const m2 = parsed.milestones.find((m) => m.milestoneId === 'M2');
    expect(m2?.status).toBe('blocked');
    expect(parsed.executionLogs.some((l) => l.action === 'Rate-Limit Intercept')).toBe(true);
  });
});

describe('Artifacts Engine — File System Persistence', () => {
  it('writes and reads back all 3 artifacts from disk', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamwork-test-'));

    try {
      const requestMd = '# Request: Test Goal\n\n## Mục tiêu gốc\nTest goal description';
      const planMd = '# Plan: Test Plan\n\n## Danh sách Milestones (Tối đa 3)';
      const progressMd = '# Progress: Test Progress\n\n## Bảng trạng thái Milestone';

      await writeTeamworkArtifacts(tempDir, { requestMd, planMd, progressMd });

      const readBack = await readTeamworkArtifacts(tempDir);
      expect(readBack.requestMd).toBe(requestMd);
      expect(readBack.planMd).toBe(planMd);
      expect(readBack.progressMd).toBe(progressMd);

      // Verify files exist in teamwork/ subdirectory
      const statReq = await fs.stat(path.join(tempDir, 'teamwork', 'REQUEST.md'));
      expect(statReq.isFile()).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
