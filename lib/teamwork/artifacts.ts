/**
 * Triad Document Generator & Parser for Teamwork Runtime Engine.
 * Conforms strictly to PROJECT.md và ORIGINAL_REQUEST.md.
 *
 * Manages:
 * 1. teamwork/REQUEST.md: Goal, repo context, constraints, and testable acceptance criteria.
 * 2. teamwork/PLAN.md: Milestone roadmap (max 3), exclusive file ownership, verify commands.
 * 3. teamwork/PROGRESS.md: Live status table, rate limit state, execution logs, and file stats.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AcceptanceCriterion,
  ExecutionLogEntry,
  FileChangeStat,
  Milestone,
  MilestoneStatus,
  ProgressMilestoneRow,
  ProgressState,
  ProgressUpdateOptions,
  RateLimitStatus,
  RepoContext,
  TeamworkArtifacts,
  TeamworkConstraints,
  TeamworkPlan,
  TeamworkRequest,
} from './types';

// ============================================================================
// 1. REQUEST.md: Generator & Parser
// ============================================================================

export function generateRequestMd(
  req: Partial<TeamworkRequest> & {
    title?: string;
    originalGoal?: string;
    repoContext?: Partial<RepoContext>;
    acceptanceCriteria?: AcceptanceCriterion[];
  }
): string {
  const lines: string[] = [];
  lines.push(`# Request: ${req.title || 'Untitled Request'}`);
  lines.push('');
  lines.push('## Mục tiêu gốc');
  lines.push(req.originalGoal || '');
  lines.push('');
  lines.push('## Bối cảnh Repo');
  lines.push(`- Commit gần nhất: ${req.repoContext?.latestCommit || 'None'}`);
  lines.push(`- Trạng thái git: ${req.repoContext?.gitStatus || 'clean'}`);
  lines.push(`- Thư mục làm việc: ${req.repoContext?.workingDirectory || '.'}`);
  lines.push('');
  lines.push('## Ràng buộc');
  lines.push(`- Quy trình: ${req.constraints?.process || '2 Phase (Scope & Plan -> Execution & Critic)'}`);
  lines.push(
    `- Concurrency: ${req.constraints?.concurrency || 'Tuần tự mặc định; tối đa 2 song song khi file hoàn toàn độc lập'}`
  );
  lines.push(`- Exclusive File Ownership: ${req.constraints?.fileOwnership || '1 worker / file tại 1 thời điểm'}`);
  const maxM = req.constraints?.maxMilestones ?? 3;
  const maxR = req.constraints?.maxRetriesPerMilestone ?? 1;
  lines.push(`- Giới hạn: Tối đa ${maxM} milestones; retry tối đa ${maxR} lần/milestone`);
  lines.push(`- Rate Limit: ${req.constraints?.rateLimitPolicy || 'Gặp 429 dừng ngay, ghi PROGRESS.md, báo user'}`);
  lines.push('');
  lines.push('## Tiêu chí nghiệm thu (Acceptance Criteria)');
  if (req.acceptanceCriteria && req.acceptanceCriteria.length > 0) {
    req.acceptanceCriteria.forEach((criterion, idx) => {
      const check = criterion.completed ? '[x]' : '[ ]';
      const cmdStr = criterion.verifyCommand ? ` (Lệnh kiểm chứng: \`${criterion.verifyCommand}\`)` : '';
      lines.push(`- ${check} Criterion ${idx + 1}: ${criterion.description}${cmdStr}`);
    });
  } else {
    lines.push('- [ ] Criterion 1: Tiêu chí kiểm chứng mặc định (Lệnh kiểm chứng: `npm test`)');
  }
  lines.push('');
  return lines.join('\n');
}

export function parseRequestMd(markdown: string): TeamworkRequest {
  const lines = markdown.split(/\r?\n/);
  let title = '';
  const repoContext: RepoContext = {
    latestCommit: '',
    gitStatus: '',
    workingDirectory: '',
  };
  const constraints: TeamworkConstraints = {
    process: '2 Phase (Scope & Plan -> Execution & Critic)',
    concurrency: 'Tuần tự mặc định; tối đa 2 song song khi file hoàn toàn độc lập',
    fileOwnership: '1 worker / file tại 1 thời điểm',
    maxMilestones: 3,
    maxRetriesPerMilestone: 1,
    rateLimitPolicy: 'Gặp 429 dừng ngay, ghi PROGRESS.md, báo user',
  };
  const acceptanceCriteria: AcceptanceCriterion[] = [];

  let currentSection = '';
  const goalLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const titleMatch = trimmed.match(/^#\s+Request:\s*(.*)$/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
      continue;
    }

    if (trimmed.startsWith('## ')) {
      currentSection = trimmed.slice(3).trim().toLowerCase();
      continue;
    }

    if (
      currentSection.includes('mục tiêu gốc') ||
      currentSection.includes('original goal') ||
      currentSection.includes('goal')
    ) {
      if (!trimmed.startsWith('#')) {
        goalLines.push(line);
      }
    } else if (currentSection.includes('bối cảnh') || currentSection.includes('context')) {
      if (trimmed.startsWith('- Commit gần nhất:')) {
        repoContext.latestCommit = trimmed.replace(/^- Commit gần nhất:\s*/, '').trim();
      } else if (trimmed.startsWith('- Trạng thái git:')) {
        repoContext.gitStatus = trimmed.replace(/^- Trạng thái git:\s*/, '').trim();
      } else if (trimmed.startsWith('- Thư mục làm việc:')) {
        repoContext.workingDirectory = trimmed.replace(/^- Thư mục làm việc:\s*/, '').trim();
      }
    } else if (currentSection.includes('ràng buộc') || currentSection.includes('constraints')) {
      if (trimmed.startsWith('- Quy trình:')) {
        constraints.process = trimmed.replace(/^- Quy trình:\s*/, '').trim();
      } else if (trimmed.startsWith('- Concurrency:')) {
        constraints.concurrency = trimmed.replace(/^- Concurrency:\s*/, '').trim();
      } else if (trimmed.startsWith('- Exclusive File Ownership:')) {
        constraints.fileOwnership = trimmed.replace(/^- Exclusive File Ownership:\s*/, '').trim();
      } else if (trimmed.startsWith('- Giới hạn:')) {
        const text = trimmed.replace(/^- Giới hạn:\s*/, '').trim();
        const mCount = text.match(/Tối đa\s+(\d+)\s+milestone/i);
        if (mCount) constraints.maxMilestones = parseInt(mCount[1], 10);
        const rCount = text.match(/retry\s+tối đa\s+(\d+)\s+lần/i);
        if (rCount) constraints.maxRetriesPerMilestone = parseInt(rCount[1], 10);
      } else if (trimmed.startsWith('- Rate Limit:')) {
        constraints.rateLimitPolicy = trimmed.replace(/^- Rate Limit:\s*/, '').trim();
      }
    } else if (
      currentSection.includes('tiêu chí nghiệm thu') ||
      currentSection.includes('acceptance criteria')
    ) {
      const critMatch = trimmed.match(
        /^-\s*\[([ xX])\]\s*(?:Criterion\s*\d+:\s*)?(.*?)(?:\s*\(Lệnh kiểm chứng:\s*`?([^`\)]+)`?\))?$/
      );
      if (critMatch) {
        const completed = critMatch[1].toLowerCase() === 'x';
        let desc = critMatch[2].trim();
        let cmd = critMatch[3] ? critMatch[3].trim() : '';
        if (!cmd) {
          const backtickMatch = desc.match(/`([^`]+)`/);
          if (backtickMatch) {
            cmd = backtickMatch[1];
          }
        }
        acceptanceCriteria.push({
          description: desc,
          verifyCommand: cmd,
          completed,
        });
      }
    }
  }

  return {
    title,
    originalGoal: goalLines.join('\n').trim(),
    repoContext,
    constraints,
    acceptanceCriteria,
    rawMarkdown: markdown,
  };
}

// ============================================================================
// 2. PLAN.md: Generator & Parser
// ============================================================================

export function generatePlanMd(
  plan: {
    title?: string;
    milestones?: Array<Partial<Milestone> & { id?: string; title?: string }>;
  }
): string {
  const lines: string[] = [];
  lines.push(`# Plan: ${plan.title || 'Untitled Plan'}`);
  lines.push('');
  lines.push('## Danh sách Milestones (Tối đa 3)');
  lines.push('');

  const milestones = (plan.milestones || []).slice(0, 3);
  milestones.forEach((m, idx) => {
    const id = m.id || `M${idx + 1}`;
    lines.push(`### Milestone ${id}: ${m.title || ''}`);
    lines.push(`- **Mục đích**: ${m.goal || ''}`);
    lines.push(`- **Phụ thuộc**: ${m.dependsOn || (idx === 0 ? 'None' : `M${idx}`)}`);
    lines.push('- **File sở hữu độc quyền**:');
    if (m.ownedFiles && m.ownedFiles.length > 0) {
      for (const f of m.ownedFiles) {
        lines.push(`  - \`${f}\``);
      }
    } else {
      lines.push('  - `(none)`');
    }
    lines.push(`- **Lệnh verify bắt buộc**: \`${m.verifyCommand || 'npm test'}\``);
    lines.push('- **Worker Brief** (≤15 dòng):');
    if (m.workerBrief) {
      const briefLines = m.workerBrief.trim().split(/\r?\n/).slice(0, 15);
      for (const bLine of briefLines) {
        lines.push(`  ${bLine}`);
      }
    } else {
      lines.push('  Triển khai các thay đổi theo đúng phạm vi file sở hữu và chạy lệnh verify.');
    }
    lines.push('');
  });

  return lines.join('\n');
}

export function parsePlanMd(markdown: string): TeamworkPlan {
  const lines = markdown.split(/\r?\n/);
  let title = '';
  const milestones: Milestone[] = [];

  let currentMilestone: Partial<Milestone> | null = null;
  let inOwnedFiles = false;
  let inWorkerBrief = false;
  const briefLines: string[] = [];

  const flushMilestone = () => {
    if (currentMilestone && (currentMilestone.id || currentMilestone.title)) {
      if (briefLines.length > 0) {
        currentMilestone.workerBrief = briefLines.join('\n').trim();
        briefLines.length = 0;
      }
      milestones.push({
        id: currentMilestone.id || `M${milestones.length + 1}`,
        title: currentMilestone.title || '',
        goal: currentMilestone.goal || '',
        dependsOn: currentMilestone.dependsOn || 'None',
        ownedFiles: currentMilestone.ownedFiles || [],
        verifyCommand: currentMilestone.verifyCommand || '',
        status: currentMilestone.status || 'todo',
        retryCount: currentMilestone.retryCount || 0,
        workerBrief: currentMilestone.workerBrief || '',
      });
      currentMilestone = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const titleMatch = trimmed.match(/^#\s+Plan:\s*(.*)$/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
      continue;
    }

    const mHeaderMatch = trimmed.match(/^###\s+Milestone\s*([A-Za-z0-9_-]+)?(?::\s*|\s*-\s*|\s+)(.*)$/i);
    if (mHeaderMatch) {
      flushMilestone();
      inOwnedFiles = false;
      inWorkerBrief = false;
      const rawId = mHeaderMatch[1] ? mHeaderMatch[1].trim() : `M${milestones.length + 1}`;
      const mId = rawId.toUpperCase().startsWith('M') ? rawId.toUpperCase() : `M${rawId}`;
      currentMilestone = {
        id: mId,
        title: mHeaderMatch[2] ? mHeaderMatch[2].trim() : '',
        ownedFiles: [],
        status: 'todo',
        retryCount: 0,
      };
      continue;
    }

    if (!currentMilestone) continue;

    if (trimmed.startsWith('- **Mục đích**:')) {
      inOwnedFiles = false;
      inWorkerBrief = false;
      currentMilestone.goal = trimmed.replace(/^-\s*\*\*Mục đích\*\*:\s*/, '').trim();
      continue;
    }

    if (trimmed.startsWith('- **Phụ thuộc**:')) {
      inOwnedFiles = false;
      inWorkerBrief = false;
      currentMilestone.dependsOn = trimmed.replace(/^-\s*\*\*Phụ thuộc\*\*:\s*/, '').trim();
      continue;
    }

    if (trimmed.startsWith('- **File sở hữu độc quyền**:')) {
      inOwnedFiles = true;
      inWorkerBrief = false;
      continue;
    }

    if (trimmed.startsWith('- **Lệnh verify bắt buộc**:')) {
      inOwnedFiles = false;
      inWorkerBrief = false;
      const rawCmd = trimmed.replace(/^-\s*\*\*Lệnh verify bắt buộc\*\*:\s*/, '').trim();
      currentMilestone.verifyCommand = rawCmd.replace(/^`|`$/g, '').trim();
      continue;
    }

    if (trimmed.match(/^-\s*\*\*Worker Brief\*\*/i)) {
      inOwnedFiles = false;
      inWorkerBrief = true;
      continue;
    }

    if (inOwnedFiles) {
      const fileMatch = trimmed.match(/^(?:-\s*)?`?([^`\r\n]+)`?$/);
      if (fileMatch && !trimmed.startsWith('- **')) {
        const val = fileMatch[1].trim();
        if (val && val !== '(none)') {
          currentMilestone.ownedFiles!.push(val);
        }
      } else if (trimmed.startsWith('- **')) {
        inOwnedFiles = false;
      }
    }

    if (inWorkerBrief) {
      if (trimmed.startsWith('- **') || trimmed.startsWith('###')) {
        inWorkerBrief = false;
        i--;
      } else {
        briefLines.push(line.replace(/^\s{2}/, ''));
      }
    }
  }

  flushMilestone();

  return {
    title,
    milestones,
    rawMarkdown: markdown,
  };
}

// ============================================================================
// 3. PROGRESS.md: Generator & Parser
// ============================================================================

export function generateProgressMd(state: ProgressState): string {
  const lines: string[] = [];
  lines.push(`# Progress: ${state.title || 'Untitled Goal'}`);
  lines.push('');
  lines.push('## Bảng trạng thái Milestone');
  lines.push('| Milestone | Worker | Trạng thái | File sở hữu | Critic Verdict | Lần thử | Ghi chú |');
  lines.push('|-----------|--------|------------|-------------|----------------|---------|---------|');

  for (const m of state.milestones || []) {
    const mLabel = m.title ? `${m.milestoneId}: ${m.title}` : m.milestoneId;
    const worker = m.worker || '-';
    const status = m.status || 'todo';
    const files = m.ownedFiles && m.ownedFiles.length > 0 ? m.ownedFiles.join(', ') : '-';
    const verdict = m.criticVerdict || '-';
    const attempts = m.attempts || '0/2';
    const notes = m.notes || '-';
    lines.push(`| ${mLabel} | ${worker} | ${status} | ${files} | ${verdict} | ${attempts} | ${notes} |`);
  }

  lines.push('');
  lines.push('## Trạng thái Rate Limit & Hệ thống');
  lines.push(`- Status: ${state.rateLimitStatus || 'HEALTHY'}`);
  lines.push(`- Lần cập nhật cuối: ${state.lastUpdated || new Date().toISOString()}`);
  lines.push(`- Ghi chú 429: ${state.rateLimitNote || 'None'}`);
  lines.push('');

  lines.push('## Nhật ký thực thi chi tiết');
  if (state.executionLogs && state.executionLogs.length > 0) {
    for (const log of state.executionLogs) {
      lines.push(`### [${log.timestamp}] ${log.milestoneId}: ${log.action}`);
      lines.push(`- Call: ${log.agent}`);
      lines.push(`- Details: ${log.details}`);
      lines.push('');
    }
  } else {
    lines.push('*Chưa có nhật ký thực thi.*');
    lines.push('');
  }

  lines.push('## Thống kê File thay đổi');
  if (state.fileStats && state.fileStats.length > 0) {
    for (const stat of state.fileStats) {
      lines.push(`- \`${stat.file}\`: +${stat.additions} / -${stat.deletions}`);
    }
  } else {
    lines.push('*Chưa có file thay đổi.*');
  }
  lines.push('');

  return lines.join('\n');
}

export function parseProgressMd(markdown: string): ProgressState {
  const lines = markdown.split(/\r?\n/);
  let title = '';
  const milestones: ProgressMilestoneRow[] = [];
  let rateLimitStatus: RateLimitStatus = 'HEALTHY';
  let lastUpdated = '';
  let rateLimitNote = 'None';
  const executionLogs: ExecutionLogEntry[] = [];
  const fileStats: FileChangeStat[] = [];

  let currentSection = '';
  let currentLog: Partial<ExecutionLogEntry> | null = null;

  const flushLog = () => {
    if (currentLog && currentLog.timestamp && currentLog.milestoneId) {
      executionLogs.push({
        timestamp: currentLog.timestamp,
        milestoneId: currentLog.milestoneId,
        agent: currentLog.agent || 'unknown',
        action: currentLog.action || '',
        details: currentLog.details || '',
      });
      currentLog = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const titleMatch = trimmed.match(/^#\s+Progress:\s*(.*)$/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
      continue;
    }

    if (trimmed.startsWith('## ')) {
      flushLog();
      currentSection = trimmed.slice(3).trim().toLowerCase();
      continue;
    }

    if (currentSection.includes('bảng trạng thái') || currentSection.includes('status board')) {
      if (trimmed.startsWith('|') && !trimmed.includes('---') && !trimmed.toLowerCase().includes('| milestone')) {
        const cells = trimmed
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim());
        if (cells.length >= 6) {
          const rawM = cells[0];
          let mId = rawM;
          let mTitle = '';
          if (rawM.includes(':')) {
            const parts = rawM.split(':');
            mId = parts[0].trim();
            mTitle = parts.slice(1).join(':').trim();
          }
          const worker = cells[1];
          const status = cells[2] as MilestoneStatus;
          const rawFiles = cells[3];
          const ownedFiles =
            rawFiles === '-' || !rawFiles
              ? []
              : rawFiles.split(',').map((f) => f.trim().replace(/^`|`$/g, ''));
          const criticVerdict = cells[4];
          const attempts = cells[5];
          const notes = cells[6] || '';

          milestones.push({
            milestoneId: mId,
            title: mTitle,
            worker,
            status,
            ownedFiles,
            criticVerdict,
            attempts,
            notes,
          });
        }
      }
    } else if (currentSection.includes('rate limit') || currentSection.includes('hệ thống')) {
      if (trimmed.startsWith('- Status:')) {
        const rawStatus = trimmed.replace(/^- Status:\s*/, '').trim();
        rateLimitStatus = rawStatus.includes('BLOCKED_429') ? 'BLOCKED_429' : 'HEALTHY';
      } else if (trimmed.startsWith('- Lần cập nhật cuối:')) {
        lastUpdated = trimmed.replace(/^- Lần cập nhật cuối:\s*/, '').trim();
      } else if (trimmed.startsWith('- Ghi chú 429:')) {
        rateLimitNote = trimmed.replace(/^- Ghi chú 429:\s*/, '').trim();
      }
    } else if (currentSection.includes('nhật ký') || currentSection.includes('execution log')) {
      const logHeader = trimmed.match(/^###\s+\[(.*?)\]\s+(?:Milestone\s*)?([^:]+):\s*(.*)$/);
      if (logHeader) {
        flushLog();
        currentLog = {
          timestamp: logHeader[1].trim(),
          milestoneId: logHeader[2].trim(),
          action: logHeader[3].trim(),
        };
        continue;
      }

      if (currentLog) {
        if (trimmed.startsWith('- Call:')) {
          currentLog.agent = trimmed.replace(/^- Call:\s*/, '').trim();
        } else if (trimmed.startsWith('- Details:')) {
          currentLog.details = trimmed.replace(/^- Details:\s*/, '').trim();
        } else if (trimmed.startsWith('- Findings:')) {
          currentLog.details = `Findings: ${trimmed.replace(/^- Findings:\s*/, '').trim()}`;
        } else if (trimmed.startsWith('- Modified:')) {
          currentLog.details = `Modified: ${trimmed.replace(/^- Modified:\s*/, '').trim()}`;
        } else if (trimmed.startsWith('- Verdict:')) {
          currentLog.details = (currentLog.details ? `${currentLog.details}; ` : '') + trimmed;
        } else if (trimmed.startsWith('- Re-run Test:')) {
          currentLog.details = (currentLog.details ? `${currentLog.details}; ` : '') + trimmed;
        }
      }
    } else if (currentSection.includes('thống kê file') || currentSection.includes('file change')) {
      const statMatch = trimmed.match(/^-\s*`?([^`:]+)`?:\s*\+(\d+)\s*\/\s*-(\d+)$/);
      if (statMatch) {
        fileStats.push({
          file: statMatch[1].trim(),
          additions: parseInt(statMatch[2], 10),
          deletions: parseInt(statMatch[3], 10),
        });
      }
    }
  }

  flushLog();

  return {
    title,
    milestones,
    rateLimitStatus,
    lastUpdated,
    rateLimitNote,
    executionLogs,
    fileStats,
    rawMarkdown: markdown,
  };
}

// ============================================================================
// 4. Progress Updater Functions
// ============================================================================

export function updateProgressState(
  state: ProgressState,
  update: ProgressUpdateOptions
): ProgressState {
  const updatedState: ProgressState = {
    ...state,
    milestones: [...state.milestones],
    executionLogs: [...state.executionLogs],
    fileStats: [...state.fileStats],
    lastUpdated: update.lastUpdated || new Date().toISOString(),
  };

  if (update.rateLimitStatus) {
    updatedState.rateLimitStatus = update.rateLimitStatus;
  }
  if (update.rateLimitNote !== undefined) {
    updatedState.rateLimitNote = update.rateLimitNote;
  }

  if (update.milestoneId) {
    const id = update.milestoneId.trim();
    const idx = updatedState.milestones.findIndex(
      (m) =>
        m.milestoneId.toLowerCase() === id.toLowerCase() ||
        m.milestoneId.toLowerCase().replace(/\s+/g, '') === id.toLowerCase().replace(/\s+/g, '') ||
        `m${m.milestoneId}`.toLowerCase() === id.toLowerCase() ||
        m.title.toLowerCase().includes(id.toLowerCase())
    );

    if (idx >= 0) {
      const existing = updatedState.milestones[idx];
      updatedState.milestones[idx] = {
        ...existing,
        status: update.status ?? existing.status,
        worker: update.worker ?? existing.worker,
        criticVerdict: update.criticVerdict ?? existing.criticVerdict,
        attempts: update.attempts ?? existing.attempts,
        notes: update.notes ?? existing.notes,
      };
    } else {
      updatedState.milestones.push({
        milestoneId: id,
        title: id,
        worker: update.worker ?? '-',
        status: update.status ?? 'todo',
        ownedFiles: [],
        criticVerdict: update.criticVerdict ?? '-',
        attempts: update.attempts ?? '0/2',
        notes: update.notes ?? '',
      });
    }
  }

  if (update.logEntry) {
    updatedState.executionLogs.push({
      timestamp: update.logEntry.timestamp || new Date().toISOString(),
      milestoneId: update.logEntry.milestoneId || update.milestoneId || 'General',
      agent: update.logEntry.agent,
      action: update.logEntry.action,
      details: update.logEntry.details,
    });
  }

  if (update.fileStats) {
    for (const newStat of update.fileStats) {
      const existingIdx = updatedState.fileStats.findIndex((s) => s.file === newStat.file);
      if (existingIdx >= 0) {
        updatedState.fileStats[existingIdx] = newStat;
      } else {
        updatedState.fileStats.push(newStat);
      }
    }
  }

  return updatedState;
}

export function updateProgressStatus(
  progressMdOrState: string | ProgressState,
  update: ProgressUpdateOptions
): string {
  const state =
    typeof progressMdOrState === 'string'
      ? parseProgressMd(progressMdOrState)
      : progressMdOrState;

  const updatedState = updateProgressState(state, update);
  return generateProgressMd(updatedState);
}

// ============================================================================
// 5. File System Persistence Helpers
// ============================================================================

export async function writeTeamworkArtifacts(
  workspaceRoot: string,
  artifacts: Partial<TeamworkArtifacts>
): Promise<void> {
  const teamworkDir = path.resolve(workspaceRoot, 'teamwork');
  await fs.mkdir(teamworkDir, { recursive: true });

  if (artifacts.requestMd !== undefined) {
    await fs.writeFile(path.join(teamworkDir, 'REQUEST.md'), artifacts.requestMd, 'utf-8');
  }
  if (artifacts.planMd !== undefined) {
    await fs.writeFile(path.join(teamworkDir, 'PLAN.md'), artifacts.planMd, 'utf-8');
  }
  if (artifacts.progressMd !== undefined) {
    await fs.writeFile(path.join(teamworkDir, 'PROGRESS.md'), artifacts.progressMd, 'utf-8');
  }
}

export async function readTeamworkArtifacts(
  workspaceRoot: string
): Promise<Partial<TeamworkArtifacts>> {
  const teamworkDir = path.resolve(workspaceRoot, 'teamwork');
  const result: Partial<TeamworkArtifacts> = {};

  try {
    result.requestMd = await fs.readFile(path.join(teamworkDir, 'REQUEST.md'), 'utf-8');
  } catch {
    // File not found or unreadable
  }
  try {
    result.planMd = await fs.readFile(path.join(teamworkDir, 'PLAN.md'), 'utf-8');
  } catch {
    // File not found or unreadable
  }
  try {
    result.progressMd = await fs.readFile(path.join(teamworkDir, 'PROGRESS.md'), 'utf-8');
  } catch {
    // File not found or unreadable
  }

  return result;
}
