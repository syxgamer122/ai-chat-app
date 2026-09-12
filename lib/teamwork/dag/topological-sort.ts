import {
  CycleDetectedError,
  DagEngineError,
  DagExecutionPlan,
  DagNode,
  MissingDependencyError,
} from './types';

/**
 * Traces a directed cycle path within unresolved nodes.
 * Returns an array representing the cycle loop, e.g. ['A', 'B', 'C', 'A'].
 */
export function traceCycle(
  unresolved: string[],
  reverseGraph: Map<string, Set<string>>
): string[] {
  const unresolvedSet = new Set(unresolved);
  const visited = new Set<string>();
  const path: string[] = [];
  const pathSet = new Set<string>();

  function dfs(curr: string): string[] | null {
    if (pathSet.has(curr)) {
      const cycleStart = path.indexOf(curr);
      return [...path.slice(cycleStart), curr];
    }
    if (visited.has(curr)) {
      return null;
    }

    visited.add(curr);
    path.push(curr);
    pathSet.add(curr);

    const children = reverseGraph.get(curr) || new Set<string>();
    for (const next of children) {
      if (unresolvedSet.has(next)) {
        const cycle = dfs(next);
        if (cycle) return cycle;
      }
    }

    path.pop();
    pathSet.delete(curr);
    return null;
  }

  for (const node of unresolved) {
    const cycle = dfs(node);
    if (cycle) return cycle;
  }

  return unresolved.length > 0 ? [unresolved[0], unresolved[0]] : [];
}

/**
 * Computes the execution plan for a set of DAG nodes using Kahn's algorithm.
 * Identifies topological order, parallel wave levels, initial ready nodes, and leaf nodes.
 * Throws CycleDetectedError if a circular dependency is detected.
 * Throws MissingDependencyError if a node references an unknown dependency.
 */
export function computeTopologicalPlan<TInput = unknown, TOutput = unknown>(
  nodes: DagNode<TInput, TOutput>[]
): DagExecutionPlan {
  const nodeMap = new Map<string, DagNode<TInput, TOutput>>();
  const inDegree = new Map<string, number>();
  const dependencyGraph = new Map<string, Set<string>>(); // Node -> parent IDs
  const reverseGraph = new Map<string, Set<string>>();    // Node -> child IDs

  // 1. Check for duplicate IDs and register nodes
  for (const node of nodes) {
    if (nodeMap.has(node.id)) {
      throw new DagEngineError(`Duplicate node ID found in DAG: "${node.id}".`);
    }
    nodeMap.set(node.id, node);
    dependencyGraph.set(node.id, new Set());
    reverseGraph.set(node.id, new Set());
  }

  // 2. Validate dependencies and build graphs
  for (const node of nodes) {
    const deps = node.dependsOn ?? [];
    for (const dep of deps) {
      if (!nodeMap.has(dep)) {
        throw new MissingDependencyError(node.id, dep);
      }
      dependencyGraph.get(node.id)!.add(dep);
      reverseGraph.get(dep)!.add(node.id);
    }
  }

  // 3. Compute initial in-degrees
  for (const [nodeId, parents] of dependencyGraph.entries()) {
    inDegree.set(nodeId, parents.size);
  }

  // 4. Find all nodes with in-degree = 0
  const initialReadyNodes: string[] = [];
  for (const [nodeId, deg] of inDegree.entries()) {
    if (deg === 0) {
      initialReadyNodes.push(nodeId);
    }
  }

  // 5. Kahn's algorithm level-by-level
  const sortedNodeIds: string[] = [];
  const levels: string[][] = [];
  let currentLevel = [...initialReadyNodes];

  while (currentLevel.length > 0) {
    levels.push([...currentLevel]);
    const nextLevel: string[] = [];

    for (const u of currentLevel) {
      sortedNodeIds.push(u);

      const children = reverseGraph.get(u) || new Set<string>();
      for (const v of children) {
        const nextDeg = inDegree.get(v)! - 1;
        inDegree.set(v, nextDeg);
        if (nextDeg === 0) {
          nextLevel.push(v);
        }
      }
    }

    currentLevel = nextLevel;
  }

  // 6. Cycle detection
  if (sortedNodeIds.length !== nodes.length) {
    const unresolved = nodes
      .map((n) => n.id)
      .filter((id) => inDegree.get(id)! > 0);

    const cyclePath = traceCycle(unresolved, reverseGraph);
    throw new CycleDetectedError(cyclePath);
  }

  // 7. Leaf nodes (nodes with out-degree = 0)
  const leafNodes = nodes
    .map((n) => n.id)
    .filter((id) => (reverseGraph.get(id)?.size ?? 0) === 0);

  return {
    sortedNodeIds,
    levels,
    initialReadyNodes,
    leafNodes,
    dependencyGraph,
    reverseGraph,
  };
}
