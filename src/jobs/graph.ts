import { INode } from "../shared/types/index.js";

//#region Interfaces

export interface IGraphValidationResult {
  valid: boolean;
  errors: string[];
  topologicalOrder: string[];
}

//#endregion Interfaces

//#region Public functions

export function validateGraph(nodes: INode[], entrypointNodeId: string | null): IGraphValidationResult {
  const errors: string[] = [];
  const nodeMap: Map<string, INode> = new Map<string, INode>();

  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  // Check entrypoint exists
  if (!entrypointNodeId) {
    errors.push("No entrypoint node set.");
  } else if (!nodeMap.has(entrypointNodeId)) {
    errors.push(`Entrypoint node "${entrypointNodeId}" not found.`);
  }

  // Validate all connections reference existing nodes
  for (const node of nodes) {
    for (const targetId of node.connections) {
      if (!nodeMap.has(targetId)) {
        errors.push(`Node "${node.nodeId}" connects to non-existent node "${targetId}".`);
      }
    }
  }

  // Topological sort + cycle detection (Kahn's algorithm)
  const inDegree: Map<string, number> = new Map<string, number>();
  const adjacency: Map<string, string[]> = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.nodeId, 0);
    adjacency.set(node.nodeId, [...node.connections]);
  }

  for (const node of nodes) {
    for (const targetId of node.connections) {
      if (inDegree.has(targetId)) {
        inDegree.set(targetId, (inDegree.get(targetId) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];

  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(nodeId);
    }
  }

  const topologicalOrder: string[] = [];

  while (queue.length > 0) {
    const current: string = queue.shift()!;
    topologicalOrder.push(current);

    const neighbors: string[] = adjacency.get(current) ?? [];

    for (const neighbor of neighbors) {
      const newDegree: number = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);

      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (topologicalOrder.length !== nodes.length) {
    errors.push("Graph contains a cycle. Nodes involved in cycles cannot be executed.");
  }

  // Check entrypoint reachability — all nodes should be reachable from entrypoint
  if (entrypointNodeId && nodeMap.has(entrypointNodeId) && errors.length === 0) {
    const reachable: Set<string> = new Set<string>();
    const stack: string[] = [entrypointNodeId];

    while (stack.length > 0) {
      const current: string = stack.pop()!;

      if (reachable.has(current)) {
        continue;
      }

      reachable.add(current);

      const neighbors: string[] = adjacency.get(current) ?? [];

      for (const neighbor of neighbors) {
        if (!reachable.has(neighbor)) {
          stack.push(neighbor);
        }
      }
    }

    for (const node of nodes) {
      if (!reachable.has(node.nodeId)) {
        errors.push(`Node "${node.nodeId}" (${node.name}) is not reachable from the entrypoint.`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    topologicalOrder: errors.length === 0 ? topologicalOrder : [],
  };
}

export function getExecutionOrder(nodes: INode[], entrypointNodeId: string): string[] {
  const result: IGraphValidationResult = validateGraph(nodes, entrypointNodeId);

  if (!result.valid) {
    throw new Error(`Invalid graph: ${result.errors.join(", ")}`);
  }

  return result.topologicalOrder;
}

//#endregion Public functions
