import { computeTopologicalPlan } from './topological-sort';
import {
  DagDefinition,
  DagEngineError,
  DagExecutionPlan,
  DagNode,
} from './types';

/**
 * DagGraph encapsulates a mutable Directed Acyclic Graph structure,
 * providing validation, topological execution planning, and dependency manipulation.
 */
export class DagGraph<TInput = unknown, TOutput = unknown> {
  private readonly nodes = new Map<string, DagNode<TInput, TOutput>>();

  constructor(nodes?: DagNode<TInput, TOutput>[]) {
    if (nodes) {
      for (const node of nodes) {
        this.addNode(node);
      }
    }
  }

  /**
   * Adds a node to the graph.
   */
  public addNode(node: DagNode<TInput, TOutput>): this {
    if (!node.id || typeof node.id !== 'string') {
      throw new DagEngineError('Node must have a valid string ID.');
    }
    if (this.nodes.has(node.id)) {
      throw new DagEngineError(`Node with ID "${node.id}" already exists in graph.`);
    }
    this.nodes.set(node.id, {
      ...node,
      dependsOn: [...(node.dependsOn ?? [])],
    });
    return this;
  }

  /**
   * Checks whether a node exists.
   */
  public hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  /**
   * Retrieves a node by ID.
   */
  public getNode(id: string): DagNode<TInput, TOutput> | undefined {
    return this.nodes.get(id);
  }

  /**
   * Removes a node and clears references to it from other nodes' dependsOn.
   */
  public removeNode(id: string): boolean {
    if (!this.nodes.has(id)) {
      return false;
    }
    this.nodes.delete(id);
    for (const node of this.nodes.values()) {
      node.dependsOn = node.dependsOn.filter((d) => d !== id);
    }
    return true;
  }

  /**
   * Returns an array of all nodes.
   */
  public getNodes(): DagNode<TInput, TOutput>[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Adds a directed dependency edge: `to` depends on `from`.
   */
  public addEdge(from: string, to: string): this {
    if (!this.nodes.has(from)) {
      throw new DagEngineError(`Cannot add edge: source node "${from}" does not exist.`);
    }
    const targetNode = this.nodes.get(to);
    if (!targetNode) {
      throw new DagEngineError(`Cannot add edge: target node "${to}" does not exist.`);
    }
    if (!targetNode.dependsOn.includes(from)) {
      targetNode.dependsOn.push(from);
    }
    return this;
  }

  /**
   * Removes a directed dependency edge.
   */
  public removeEdge(from: string, to: string): this {
    const targetNode = this.nodes.get(to);
    if (targetNode) {
      targetNode.dependsOn = targetNode.dependsOn.filter((d) => d !== from);
    }
    return this;
  }

  /**
   * Checks whether an edge exists from -> to (`to` depends on `from`).
   */
  public hasEdge(from: string, to: string): boolean {
    const target = this.nodes.get(to);
    return target ? target.dependsOn.includes(from) : false;
  }

  /**
   * Returns all direct parents (prerequisites) of a node.
   */
  public getParents(nodeId: string): string[] {
    const node = this.nodes.get(nodeId);
    return node ? [...node.dependsOn] : [];
  }

  /**
   * Returns all direct children (dependents) of a node.
   */
  public getChildren(nodeId: string): string[] {
    const children: string[] = [];
    for (const [id, node] of this.nodes.entries()) {
      if (node.dependsOn.includes(nodeId)) {
        children.push(id);
      }
    }
    return children;
  }

  /**
   * Validates graph topology (no cycles, valid dependencies).
   */
  public validate(): void {
    computeTopologicalPlan(this.getNodes());
  }

  /**
   * Computes Kahn's topological sort execution plan.
   */
  public plan(): DagExecutionPlan {
    return computeTopologicalPlan(this.getNodes());
  }

  /**
   * Deep clones the graph.
   */
  public clone(): DagGraph<TInput, TOutput> {
    const cloned = new DagGraph<TInput, TOutput>();
    for (const node of this.nodes.values()) {
      cloned.addNode({
        ...node,
        dependsOn: [...node.dependsOn],
        ownedFiles: node.ownedFiles ? [...node.ownedFiles] : undefined,
        metadata: node.metadata ? { ...node.metadata } : undefined,
      });
    }
    return cloned;
  }

  /**
   * Constructs a DagGraph from a DagDefinition.
   */
  public static fromDefinition<TInput = unknown, TOutput = unknown>(
    def: DagDefinition<TInput, TOutput>
  ): DagGraph<TInput, TOutput> {
    const graph = new DagGraph<TInput, TOutput>();
    for (const node of def.nodes) {
      graph.addNode(node);
    }
    return graph;
  }

  /**
   * Converts this graph into a DagDefinition.
   */
  public toDefinition(id: string, name: string): DagDefinition<TInput, TOutput> {
    return {
      id,
      name,
      nodes: this.getNodes(),
    };
  }
}
