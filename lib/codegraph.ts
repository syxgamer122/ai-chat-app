/**
 * Codegraph & UML Architecture Analysis — Phân tích đồ thị phụ thuộc và phát hiện chu trình (Oh My Hermes P2 port).
 *
 * Tính năng chính:
 * 1. Trích xuất import/export edges giữa các file mã nguồn.
 * 2. Phát hiện chu trình phụ thuộc vòng (Dependency Cycles).
 * 3. Xếp hạng phát hiện (Findings Ranking): cycles, high fan-in, god modules.
 * 4. Xuất biểu đồ Mermaid TD trực quan.
 */

export interface CodeGraphNode {
  id: string; // file path
  name: string;
  imports: string[];
  importedBy: string[];
}

export interface CodeGraphFinding {
  type: 'cycle' | 'god_module' | 'high_fan_in';
  severity: 'high' | 'medium' | 'low';
  message: string;
  files: string[];
}

export interface CodeGraphResult {
  nodes: Record<string, CodeGraphNode>;
  cycles: string[][];
  findings: CodeGraphFinding[];
  mermaid: string;
}

const IMPORT_REGEX =
  /(?:import|from)\s+['"]([.@/][^'"]+)['"]|require\s*\(\s*['"]([.@/][^'"]+)['"]\s*\)|import\s*\(\s*['"]([.@/][^'"]+)['"]\s*\)/g;

/**
 * Phân giải chính xác đường dẫn import sang path file trong workspace.
 * Không dùng substring thô (tránh lỗi "./b" khớp nhầm "src/button.ts").
 */
function resolveImportTarget(
  fromPath: string,
  rawTarget: string,
  pathSet: Set<string>,
): string | undefined {
  let normalized = rawTarget.replace(/\\/g, '/');

  if (normalized.startsWith('@/')) {
    normalized = normalized.slice(2);
  } else if (normalized.startsWith('./') || normalized.startsWith('../')) {
    const fromDir = fromPath.split('/').slice(0, -1).join('/');
    const full = fromDir ? `${fromDir}/${normalized}` : normalized;
    const segments = full.split('/');
    const resolved: string[] = [];
    for (const seg of segments) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') {
        resolved.pop();
      } else {
        resolved.push(seg);
      }
    }
    normalized = resolved.join('/');
  }

  const candidates = [
    normalized,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}.js`,
    `${normalized}.jsx`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
    `src/${normalized}`,
    `src/${normalized}.ts`,
    `src/${normalized}.tsx`,
  ];

  for (const c of candidates) {
    if (pathSet.has(c)) {
      return c;
    }
  }

  // Khớp chính xác phần đuôi phân tách bằng dấu gạch chéo
  for (const p of pathSet) {
    for (const c of candidates) {
      if (p === c || p.endsWith(`/${c}`)) {
        return p;
      }
    }
  }

  return undefined;
}

/**
 * Phân tích danh sách file và xây dựng đồ thị phụ thuộc.
 */
export function buildCodeGraph(files: Array<{ path: string; content: string }>): CodeGraphResult {
  const nodes: Record<string, CodeGraphNode> = {};
  const pathSet = new Set(files.map((f) => f.path.replace(/\\/g, '/')));

  // 1. Khởi tạo nodes
  for (const f of files) {
    const normPath = f.path.replace(/\\/g, '/');
    const fileName = normPath.split('/').pop() ?? normPath;
    nodes[normPath] = {
      id: normPath,
      name: fileName,
      imports: [],
      importedBy: [],
    };
  }

  // 2. Trích xuất quan hệ import
  for (const f of files) {
    const normPath = f.path.replace(/\\/g, '/');
    const fromNode = nodes[normPath];
    let match: RegExpExecArray | null;
    const regex = new RegExp(IMPORT_REGEX);

    while ((match = regex.exec(f.content)) !== null) {
      const targetRaw = match[1] || match[2] || match[3];
      if (!targetRaw) continue;

      const resolvedTarget = resolveImportTarget(normPath, targetRaw, pathSet);

      if (resolvedTarget && resolvedTarget !== normPath) {
        if (!fromNode.imports.includes(resolvedTarget)) {
          fromNode.imports.push(resolvedTarget);
        }
        const targetNode = nodes[resolvedTarget];
        if (targetNode && !targetNode.importedBy.includes(normPath)) {
          targetNode.importedBy.push(normPath);
        }
      }
    }
  }

  // 3. Phát hiện chu trình phụ thuộc (Cycle Detection qua DFS)
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const currentPath: string[] = [];

  function dfs(nodeId: string) {
    visited.add(nodeId);
    recStack.add(nodeId);
    currentPath.push(nodeId);

    const node = nodes[nodeId];
    if (node) {
      for (const neighbor of node.imports) {
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (recStack.has(neighbor)) {
          // Tìm thấy chu trình
          const cycleStartIdx = currentPath.indexOf(neighbor);
          if (cycleStartIdx !== -1) {
            const cycle = currentPath.slice(cycleStartIdx);
            cycle.push(neighbor);
            cycles.push(cycle);
          }
        }
      }
    }

    currentPath.pop();
    recStack.delete(nodeId);
  }

  for (const id of Object.keys(nodes)) {
    if (!visited.has(id)) {
      dfs(id);
    }
  }

  // 4. Xếp hạng các phát hiện kiến trúc (Findings)
  const findings: CodeGraphFinding[] = [];

  // Cycles (nghiêm trọng nhất)
  for (const c of cycles) {
    findings.push({
      type: 'cycle',
      severity: 'high',
      message: `Phát hiện chu trình phụ thuộc vòng: ${c.map((p) => p.split('/').pop()).join(' ➜ ')}`,
      files: Array.from(new Set(c)),
    });
  }

  // God modules & High fan-in
  for (const node of Object.values(nodes)) {
    if (node.imports.length > 8) {
      findings.push({
        type: 'god_module',
        severity: 'medium',
        message: `Module "${node.name}" import quá nhiều module khác (${node.imports.length} imports) — có nguy cơ trở thành God Module.`,
        files: [node.id],
      });
    }

    if (node.importedBy.length > 10) {
      findings.push({
        type: 'high_fan_in',
        severity: 'low',
        message: `Module "${node.name}" có fan-in rất cao (${node.importedBy.length} dependents) — cần thận trọng khi refactor.`,
        files: [node.id],
      });
    }
  }

  // 5. Tạo Mermaid Diagram TD
  const mermaidLines: string[] = ['graph TD'];
  const sanitizedId = (id: string) => id.replace(/[^a-zA-Z0-9_]/g, '_');

  for (const node of Object.values(nodes)) {
    mermaidLines.push(`  ${sanitizedId(node.id)}["${node.name}"]`);
    for (const imp of node.imports) {
      mermaidLines.push(`  ${sanitizedId(node.id)} --> ${sanitizedId(imp)}`);
    }
  }

  return {
    nodes,
    cycles,
    findings,
    mermaid: mermaidLines.join('\n'),
  };
}

/**
 * Bí danh chuẩn hóa tool theo hợp đồng OMH P2
 */
export const codegraph_uml = buildCodeGraph;
