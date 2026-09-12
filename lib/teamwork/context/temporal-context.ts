/**
 * 3-Tier Progressive Milestone Context Manager.
 * Prevents LLM context saturation via tiered disclosure:
 * Tier 1 Index (~100 tokens), Tier 2 Decisions (~400 tokens), Tier 3 Diffs (~1500 tokens).
 */

import {
  ArchitecturalDecision,
  ContextQueryBudget,
  ContextRenderOptions,
  FileDiffItem,
  MilestoneContextSummary,
  MilestoneIndexItem,
} from './types';

export const DEFAULT_BUDGET: Required<ContextQueryBudget> = {
  tier1Tokens: 150,
  tier2Tokens: 500,
  tier3Tokens: 1800,
  maxTotalTokens: 2500,
};

export class TemporalContextManager {
  private readonly milestones = new Map<string, MilestoneIndexItem>();
  private readonly decisions: ArchitecturalDecision[] = [];
  private readonly diffs = new Map<string, FileDiffItem>();

  /**
   * Estimates token count using standard ~3.8 characters per token heuristic.
   */
  public static estimateTokens(text: string): number {
    if (!text || text.length === 0) return 0;
    return Math.max(1, Math.ceil(text.length / 3.8));
  }

  /**
   * Records or updates a milestone's index item.
   */
  public recordMilestone(milestone: MilestoneIndexItem): void {
    this.milestones.set(milestone.id, milestone);
  }

  /**
   * Records an architectural decision with rationale and constraints.
   */
  public recordDecision(decision: ArchitecturalDecision): void {
    const existingIndex = this.decisions.findIndex((d) => d.id === decision.id);
    if (existingIndex >= 0) {
      this.decisions[existingIndex] = decision;
    } else {
      this.decisions.push(decision);
    }
  }

  /**
   * Records a file diff for progressive Tier 3 querying.
   */
  public recordDiff(filePath: string, diff: string, milestoneId?: string): void {
    this.diffs.set(filePath, {
      filePath,
      diff,
      milestoneId,
      estimatedTokens: TemporalContextManager.estimateTokens(diff),
    });
  }

  /**
   * Returns all recorded milestones.
   */
  public getMilestones(): readonly MilestoneIndexItem[] {
    return Array.from(this.milestones.values());
  }

  /**
   * Returns all recorded architectural decisions.
   */
  public getDecisions(): readonly ArchitecturalDecision[] {
    return this.decisions;
  }

  /**
   * Returns all recorded diffs.
   */
  public getDiffs(): ReadonlyMap<string, FileDiffItem> {
    return this.diffs;
  }

  /**
   * Renders Tier 1 Index (~100 tokens).
   */
  public renderTier1(milestones: readonly MilestoneIndexItem[], tokenBudget: number = DEFAULT_BUDGET.tier1Tokens): string {
    if (milestones.length === 0) {
      return '### Milestone Index\n_No milestones recorded yet._';
    }

    const lines: string[] = ['### Milestone Index'];
    let currentChars = lines[0].length;
    const maxChars = tokenBudget * 3.8;

    for (const m of milestones) {
      const filesStr = m.filesTouched.length > 0 ? ` [files: ${m.filesTouched.join(', ')}]` : '';
      const verdictStr = m.criticVerdict ? ` | verdict: ${m.criticVerdict}` : '';
      const line = `- **${m.id}** [${m.status}]: ${m.title}${verdictStr}${filesStr}`;

      if (currentChars + line.length + 1 > maxChars && lines.length > 2) {
        lines.push(`- ... (${milestones.length - lines.length + 1} additional milestones summarized)`);
        break;
      }

      lines.push(line);
      currentChars += line.length + 1;
    }

    return lines.join('\n');
  }

  /**
   * Renders Tier 2 Architectural Decisions (~400 tokens).
   */
  public renderTier2(
    decisions: readonly ArchitecturalDecision[],
    targetMilestoneId?: string,
    tokenBudget: number = DEFAULT_BUDGET.tier2Tokens
  ): string {
    const relevant = targetMilestoneId
      ? decisions.filter((d) => d.milestoneId === targetMilestoneId)
      : decisions;

    if (relevant.length === 0) {
      return '### Key Decisions & Constraints\n_No technical decisions recorded._';
    }

    const lines: string[] = ['### Key Decisions & Constraints'];
    let currentChars = lines[0].length;
    const maxChars = tokenBudget * 3.8;

    for (const d of relevant) {
      const header = `- **[${d.milestoneId}] ${d.title}**: ${d.rationale}`;
      const constraints = d.constraints.length > 0 ? `  - *Constraints*: ${d.constraints.join('; ')}` : '';
      const alternatives =
        d.rejectedAlternatives && d.rejectedAlternatives.length > 0
          ? `  - *Rejected alternatives*: ${d.rejectedAlternatives.join('; ')}`
          : '';
      const interfaceChanges =
        d.interfaceChanges && d.interfaceChanges.length > 0
          ? `  - *Interface changes*: ${d.interfaceChanges.join('; ')}`
          : '';

      const blockParts = [header, constraints, alternatives, interfaceChanges].filter(Boolean);
      const block = blockParts.join('\n');

      if (currentChars + block.length + 1 > maxChars && lines.length > 1) {
        lines.push(`- ... (${relevant.length - lines.length + 1} older decisions omitted for budget)`);
        break;
      }

      lines.push(block);
      currentChars += block.length + 1;
    }

    return lines.join('\n');
  }

  /**
   * Renders Tier 3 Targeted File Diffs (~1500 tokens).
   */
  public renderTier3(
    requestedFiles?: string[],
    tokenBudget: number = DEFAULT_BUDGET.tier3Tokens
  ): string {
    if (!requestedFiles || requestedFiles.length === 0) {
      return '';
    }

    const lines: string[] = ['### Selective File Diffs'];
    let currentChars = lines[0].length;
    const maxChars = tokenBudget * 3.8;

    for (const file of requestedFiles) {
      const item = this.diffs.get(file);
      if (!item || !item.diff) continue;

      const header = `#### Diff: ${file}\n\`\`\`diff`;
      const footer = '```';
      const availableCharsForContent = maxChars - (currentChars + header.length + footer.length + 4);

      if (availableCharsForContent <= 50) {
        lines.push(`\n_Diff for ${file} omitted due to token budget ceiling._`);
        break;
      }

      let diffContent = item.diff;
      if (diffContent.length > availableCharsForContent) {
        diffContent = diffContent.slice(0, availableCharsForContent) + '\n... [diff truncated to stay within budget]';
      }

      const diffBlock = `${header}\n${diffContent}\n${footer}`;
      lines.push(diffBlock);
      currentChars += diffBlock.length + 2;

      if (currentChars >= maxChars) {
        break;
      }
    }

    return lines.length > 1 ? lines.join('\n') : '';
  }

  /**
   * Progressively renders context according to requested tier and budget.
   */
  public renderContext(options?: ContextRenderOptions): MilestoneContextSummary {
    const tier = options?.tier ?? 3;
    const budget = {
      tier1Tokens: options?.budget?.tier1Tokens ?? DEFAULT_BUDGET.tier1Tokens,
      tier2Tokens: options?.budget?.tier2Tokens ?? DEFAULT_BUDGET.tier2Tokens,
      tier3Tokens: options?.budget?.tier3Tokens ?? DEFAULT_BUDGET.tier3Tokens,
      maxTotalTokens: options?.budget?.maxTotalTokens ?? DEFAULT_BUDGET.maxTotalTokens,
    };

    const milestones = this.getMilestones();
    const tier1Index = this.renderTier1(milestones, budget.tier1Tokens);

    let tier2Decisions = '';
    let tier3Diffs: string | undefined;

    if (tier >= 2) {
      tier2Decisions = this.renderTier2(
        this.decisions,
        options?.targetMilestoneId,
        budget.tier2Tokens
      );
    }

    if (tier >= 3 && options?.requestedFiles && options.requestedFiles.length > 0) {
      const diffStr = this.renderTier3(options.requestedFiles, budget.tier3Tokens);
      if (diffStr) {
        tier3Diffs = diffStr;
      }
    }

    const sections = [tier1Index, tier2Decisions, tier3Diffs].filter(Boolean);
    let renderedMarkdown = sections.join('\n\n');

    // Enforce the aggregate ceiling: shed the lowest-value tier(s) until the whole
    // render fits within maxTotalTokens. Previously this budget was computed but ignored,
    // so the rendered context could exceed the configured ceiling without bound.
    if (TemporalContextManager.estimateTokens(renderedMarkdown) > budget.maxTotalTokens) {
      if (tier3Diffs) {
        tier3Diffs = undefined;
      } else if (tier2Decisions) {
        tier2Decisions = '';
      }
      renderedMarkdown = [tier1Index, tier2Decisions, tier3Diffs].filter(Boolean).join('\n\n');
    }

    const totalEstimatedTokens = TemporalContextManager.estimateTokens(renderedMarkdown);

    return {
      tier1Index,
      tier2Decisions,
      tier3Diffs,
      renderedMarkdown,
      activeTier: tier,
      totalEstimatedTokens,
    };
  }

  /**
   * Resets all in-memory context data.
   */
  public clear(): void {
    this.milestones.clear();
    this.decisions.length = 0;
    this.diffs.clear();
  }
}
