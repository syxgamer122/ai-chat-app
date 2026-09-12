/**
 * ASCII and Unicode flow sketch generator for DAG workflows, active nodes,
 * and pending human-in-the-loop approval gates.
 */

import type { FlowSketchNode, FlowSketchOptions } from './types';

export class FlowSketchGenerator {
  private static readonly UNICODE_STATUS_SYMBOLS: Record<string, string> = {
    completed: '✓',
    done: '✓',
    pass: '✓',
    running: '►',
    executing: '►',
    reviewing: '🔍',
    interrupted: '⧗',
    pending_approval: '⧗',
    gate: '⧗',
    ready: '○',
    pending: '○',
    todo: '○',
    failed: '✗',
    error: '✗',
    blocked: '⊘',
    skipped: '⊘',
  };

  private static readonly ASCII_STATUS_SYMBOLS: Record<string, string> = {
    completed: '[X]',
    done: '[X]',
    pass: '[X]',
    running: '[>]',
    executing: '[>]',
    reviewing: '[?]',
    interrupted: '[!]',
    pending_approval: '[!]',
    gate: '[!]',
    ready: '[ ]',
    pending: '[ ]',
    todo: '[ ]',
    failed: '[*]',
    error: '[*]',
    blocked: '[-]',
    skipped: '[-]',
  };

  /**
   * Renders a clean flow sketch from an array of DAG nodes or milestones.
   */
  public static renderFlowSketch(
    nodes: FlowSketchNode[],
    activeNodeId?: string,
    options?: FlowSketchOptions
  ): string {
    const isAscii = options?.format === 'ascii';
    const symbols = isAscii ? this.ASCII_STATUS_SYMBOLS : this.UNICODE_STATUS_SYMBOLS;
    const active = activeNodeId ?? options?.activeNodeId;
    // Ba cờ dưới đây trước đây được khai báo nhưng không hề được đọc.
    const showSymbols = options?.showStatusSymbols !== false;
    const highlightGates = options?.highlightGates !== false;
    const compact = options?.compact === true;

    if (!nodes || nodes.length === 0) {
      return isAscii ? '(empty workflow)' : '∅ (empty workflow)';
    }

    // Build levels/waves based on dependencies
    const levels = this.partitionIntoLevels(nodes);
    const nodeMap = new Map<string, FlowSketchNode>(nodes.map((n) => [n.id, n]));

    const lines: string[] = [];

    // Header diagram box
    if (!compact) {
      const title = isAscii ? '=== WORKFLOW EXECUTION GRAPH ===' : '╭─── WORKFLOW EXECUTION GRAPH ───╮';
      lines.push(title);
    }

    for (let l = 0; l < levels.length; l++) {
      const wave = levels[l];
      const waveItems = wave.map((id) => {
        const node = nodeMap.get(id);
        const st = (node?.status ?? 'pending').toLowerCase();
        const sym = symbols[st] ?? (isAscii ? '[ ]' : '○');
        const name = node?.name ? `${id} (${node.name})` : id;

        const isActive = active === id;
        const isInterrupted = st === 'interrupted' || st === 'pending_approval' || st === 'gate';

        let badge = '';
        if (isActive) {
          badge = isAscii ? ' <ACTIVE>' : ' ★ ACTIVE';
        } else if (isInterrupted && highlightGates) {
          badge = isAscii ? ' <! GATE PENDING>' : ' ⧗ GATE PENDING';
        }

        const prefix = showSymbols ? `${sym} ` : '';
        return isAscii ? `${prefix}${name}${badge}` : `[${prefix}${name}${badge}]`;
      });

      const layerPrefix = isAscii ? `Wave ${l + 1}: ` : `Stage ${l + 1}: `;
      lines.push(`${layerPrefix}${waveItems.join(isAscii ? '  ||  ' : '  ══  ')}`);

      if (!compact && l < levels.length - 1) {
        if (isAscii) {
          lines.push('         |');
          lines.push('         v');
        } else {
          lines.push('         │');
          lines.push('         ▼');
        }
      }
    }

    if (!compact) {
      const footer = isAscii ? '=================================' : '╰────────────────────────────────╯';
      lines.push(footer);
    }

    return lines.join('\n');
  }

  /**
   * Renders a linear or partitioned wave diagram from explicit level arrays.
   */
  public static renderLevelSketch(
    levels: string[][],
    statuses: Map<string, string>,
    options?: FlowSketchOptions
  ): string {
    const isAscii = options?.format === 'ascii';
    const symbols = isAscii ? this.ASCII_STATUS_SYMBOLS : this.UNICODE_STATUS_SYMBOLS;
    const active = options?.activeNodeId;
    // Hai cờ này trước đây bị bỏ qua ở nhánh renderLevelSketch.
    const showSymbols = options?.showStatusSymbols !== false;
    const compact = options?.compact === true;

    const lines: string[] = [];

    for (let l = 0; l < levels.length; l++) {
      const levelNodes = levels[l];
      const levelFormatted = levelNodes
        .map((id) => {
          const st = (statuses.get(id) ?? 'pending').toLowerCase();
          const sym = symbols[st] ?? (isAscii ? '[ ]' : '○');
          const isActive = id === active;
          const marker = isActive ? (isAscii ? '*' : '★') : '';
          return showSymbols ? `[${sym} ${id}${marker}]` : `[${id}${marker}]`;
        })
        .join(isAscii ? '  ||  ' : '  ══  ');

      lines.push(`Layer ${l + 1}:  ${levelFormatted}`);
      if (!compact && l < levels.length - 1) {
        lines.push(isAscii ? '            |' : '            │');
        lines.push(isAscii ? '            v' : '            ▼');
      }
    }

    return lines.join('\n');
  }

  /**
   * Partitions nodes into sequential dependency execution waves.
   */
  private static partitionIntoLevels(nodes: FlowSketchNode[]): string[][] {
    const inDegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    const nodeIds = new Set<string>(nodes.map((n) => n.id));

    for (const node of nodes) {
      inDegree.set(node.id, 0);
      outgoing.set(node.id, []);
    }

    for (const node of nodes) {
      const deps = (node.dependsOn ?? []).filter((d) => nodeIds.has(d));
      inDegree.set(node.id, deps.length);
      for (const dep of deps) {
        outgoing.get(dep)?.push(node.id);
      }
    }

    const levels: string[][] = [];
    const visited = new Set<string>();

    let currentWave: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) {
        currentWave.push(id);
        visited.add(id);
      }
    }

    if (currentWave.length === 0 && nodes.length > 0) {
      // Possible cycle or all interdependent, fallback to single level
      return [nodes.map((n) => n.id)];
    }

    while (currentWave.length > 0) {
      levels.push(currentWave);
      const nextWave: string[] = [];

      for (const u of currentWave) {
        for (const v of outgoing.get(u) || []) {
          const currentDeg = inDegree.get(v)! - 1;
          inDegree.set(v, currentDeg);
          if (currentDeg === 0 && !visited.has(v)) {
            nextWave.push(v);
            visited.add(v);
          }
        }
      }

      currentWave = nextWave;
    }

    // Add any remaining unvisited nodes as final layer
    const remaining = nodes.map((n) => n.id).filter((id) => !visited.has(id));
    if (remaining.length > 0) {
      levels.push(remaining);
    }

    return levels;
  }
}
