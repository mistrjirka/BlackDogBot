import type { INode } from "../shared/types/index.js";

//#region Public functions

/**
 * Builds a text-based DAG visualization. Renders nodes in topological layers,
 * then appends a precise connection list that handles fan-out and fan-in clearly.
 *
 * Nodes that are not reachable from the entrypoint (or have no entrypoint) are
 * shown in a separate "[Disconnected nodes]" section at the bottom.
 *
 * Example output for a fan-out graph:
 *
 *   [Layer 0]  [ Start ★ (start) ]
 *                      |
 *              +--------+--------+
 *              v                 v
 *   [Layer 1]  [ Fetch RSS (rss fetcher) ]   [ Fetch Web (curl fetcher) ]
 *              |                 |
 *              +--------+--------+
 *                       v
 *   [Layer 2]  [ Summarize (output to ai) ]
 *
 *   Connections:
 *     Start ──> Fetch RSS
 *     Start ──> Fetch Web          (fan-out: 1 source, 2 children)
 *     Fetch RSS ──> Summarize
 *     Fetch Web ──> Summarize      (fan-in: 2 parents, 1 child)
 */
export function buildAsciiGraph(nodes: INode[], entrypointNodeId: string | null): string {
  if (nodes.length === 0) {
    return "(no nodes)";
  }

  const nodeMap: Map<string, INode> = new Map<string, INode>(
    nodes.map((n: INode) => [n.nodeId, n]),
  );

  // Build parent-count (in-degree) and children maps
  const inDegree: Map<string, number> = new Map<string, number>(
    nodes.map((n: INode) => [n.nodeId, 0]),
  );
  const children: Map<string, string[]> = new Map<string, string[]>(
    nodes.map((n: INode) => [n.nodeId, [...n.connections]]),
  );
  const parents: Map<string, string[]> = new Map<string, string[]>(
    nodes.map((n: INode) => [n.nodeId, []]),
  );

  for (const n of nodes) {
    for (const targetId of n.connections) {
      inDegree.set(targetId, (inDegree.get(targetId) ?? 0) + 1);
      parents.get(targetId)?.push(n.nodeId);
    }
  }

  // Assign topological layers via longest-path BFS (so fan-in nodes appear below all parents)
  const layer: Map<string, number> = new Map<string, number>();
  const remaining: Map<string, number> = new Map<string, number>(inDegree);
  const queue: string[] = [];

  for (const [nodeId, deg] of remaining) {
    if (deg === 0) {
      queue.push(nodeId);
      layer.set(nodeId, 0);
    }
  }

  let head: number = 0;

  while (head < queue.length) {
    const currentId: string = queue[head++];
    const currentLayer: number = layer.get(currentId) ?? 0;

    for (const targetId of (children.get(currentId) ?? [])) {
      const newLayer: number = currentLayer + 1;

      // Use longest path — place fan-in nodes as deep as their deepest parent
      if ((layer.get(targetId) ?? -1) < newLayer) {
        layer.set(targetId, newLayer);
      }

      const deg: number = (remaining.get(targetId) ?? 1) - 1;
      remaining.set(targetId, deg);

      if (deg === 0) {
        queue.push(targetId);
      }
    }
  }

  // Determine which nodes are reachable from the entrypoint via DFS
  const reachableFromEntrypoint: Set<string> = new Set<string>();

  if (entrypointNodeId !== null && nodeMap.has(entrypointNodeId)) {
    const dfsStack: string[] = [entrypointNodeId];

    while (dfsStack.length > 0) {
      const current: string = dfsStack.pop()!;

      if (reachableFromEntrypoint.has(current)) {
        continue;
      }

      reachableFromEntrypoint.add(current);

      for (const child of (children.get(current) ?? [])) {
        if (!reachableFromEntrypoint.has(child)) {
          dfsStack.push(child);
        }
      }
    }
  }

  // Nodes unreachable from the entrypoint go into disconnectedNodes.
  // Nodes with in-degree 0 that are NOT the entrypoint AND are not reachable
  // would be assigned layer 0 by the BFS above — so we must filter them out of
  // the regular layers and show them separately.
  const hasEntrypoint: boolean = entrypointNodeId !== null && nodeMap.has(entrypointNodeId);
  const disconnectedNodes: string[] = nodes
    .filter((n: INode) => {
      if (!hasEntrypoint) {
        return false; // no entrypoint — show all in regular layers
      }
      return !reachableFromEntrypoint.has(n.nodeId);
    })
    .map((n: INode) => n.nodeId);

  const disconnectedSet: Set<string> = new Set<string>(disconnectedNodes);

  // Group connected nodes by layer; also collect cycle nodes (never got a layer assigned)
  const maxLayer: number = layer.size > 0 ? Math.max(...Array.from(layer.values())) : 0;
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);

  for (const [nodeId, l] of layer) {
    if (!disconnectedSet.has(nodeId)) {
      layers[l].push(nodeId);
    }
  }

  // Cycle nodes (never assigned a layer at all) are also disconnected
  for (const n of nodes) {
    if (!layer.has(n.nodeId) && !disconnectedSet.has(n.nodeId)) {
      disconnectedNodes.push(n.nodeId);
      disconnectedSet.add(n.nodeId);
    }
  }

  // Helper: short label for a node
  const label = (nodeId: string): string => {
    const n: INode | undefined = nodeMap.get(nodeId);

    if (!n) {
      return `[${nodeId}]`;
    }

    const entryMarker: string = nodeId === entrypointNodeId ? " ★" : "";
    const typeLabel: string = n.type.replace(/_/g, " ");
    return `[ ${n.name}${entryMarker} (${typeLabel}) ]`;
  };

  const lines: string[] = [];

  for (let i: number = 0; i < layers.length; i++) {
    const layerNodes: string[] = layers[i];

    if (layerNodes.length === 0) {
      continue;
    }

    // Node boxes on this layer
    lines.push(layerNodes.map(label).join("   "));

    if (i >= layers.length - 1) {
      continue;
    }

    // Edges from this layer to the next
    // Count unique (src, dst) pairs crossing this layer boundary
    const nextLayerSet: Set<string> = new Set<string>(layers[i + 1]);
    const crossingEdges: Array<[string, string]> = [];

    for (const nodeId of layerNodes) {
      for (const targetId of (children.get(nodeId) ?? [])) {
        if (nextLayerSet.has(targetId)) {
          crossingEdges.push([nodeId, targetId]);
        }
      }
    }

    if (crossingEdges.length === 0) {
      continue;
    }

    // Determine unique source and destination nodes in this crossing
    const uniqueSources: Set<string> = new Set<string>(crossingEdges.map(([s]) => s));
    const uniqueDests: Set<string> = new Set<string>(crossingEdges.map(([, d]) => d));
    const isFanOut: boolean = uniqueSources.size === 1 && uniqueDests.size > 1;
    const isFanIn: boolean = uniqueSources.size > 1 && uniqueDests.size === 1;
    const isMixed: boolean = uniqueSources.size > 1 && uniqueDests.size > 1;

    if (isFanOut) {
      const targets: string[] = Array.from(uniqueDests).map(
        (id: string) => nodeMap.get(id)?.name ?? id,
      );
      lines.push(`         |`);
      lines.push(`         +── fan-out ──> ${targets.join(", ")}`);
      lines.push(`         v`);
    } else if (isFanIn) {
      const sources: string[] = Array.from(uniqueSources).map(
        (id: string) => nodeMap.get(id)?.name ?? id,
      );
      lines.push(`         +── fan-in (from: ${sources.join(", ")})`);
      lines.push(`         v`);
    } else if (isMixed) {
      lines.push(`         | (multiple connections — see Connections list below)`);
    } else {
      // Simple 1-to-1
      lines.push(`         |`);
      lines.push(`         v`);
    }
  }

  // Precise connection list — unambiguous regardless of rendering complexity
  lines.push("");
  lines.push("Connections:");

  let hasAnyConnections: boolean = false;

  for (const n of nodes) {
    if (n.connections.length === 0) {
      continue;
    }

    hasAnyConnections = true;

    const childNames: string = n.connections
      .map((targetId: string) => nodeMap.get(targetId)?.name ?? targetId)
      .join(", ");

    const fanNote: string = n.connections.length > 1 ? ` (fan-out: ${n.connections.length} children)` : "";
    const fanInNote: string = n.connections
      .map((targetId: string) => {
        const targetParentCount: number = (parents.get(targetId) ?? []).length;
        return targetParentCount > 1
          ? ` [${nodeMap.get(targetId)?.name ?? targetId} has ${targetParentCount} parents = fan-in]`
          : "";
      })
      .filter(Boolean)
      .join("");

    lines.push(`  ${n.name} ──> ${childNames}${fanNote}${fanInNote}`);
  }

  if (!hasAnyConnections) {
    lines.push("  (none)");
  }

  // Disconnected nodes section
  if (disconnectedNodes.length > 0) {
    lines.push("");
    lines.push("[Disconnected nodes]");

    for (const nodeId of disconnectedNodes) {
      lines.push(`  ${label(nodeId)}`);
    }
  }

  return lines.join("\n");
}

//#endregion Public functions
