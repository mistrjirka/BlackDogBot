import { describe, it, expect } from "vitest";

import { buildAsciiGraph } from "../../src/utils/ascii-graph.js";
import type { INode } from "../../src/shared/types/index.js";

//#region Helpers

function makeNode(overrides: Partial<INode> = {}): INode {
  return {
    nodeId: "default-id",
    jobId: "test-job",
    type: "start",
    name: "Default Node",
    description: "A default test node",
    inputSchema: {},
    outputSchema: {},
    connections: [],
    config: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

//#endregion Helpers

//#region Tests

describe("buildAsciiGraph", () => {
  //#region Empty / single node

  it("returns (no nodes) when the array is empty", () => {
    const result: string = buildAsciiGraph([], null);
    expect(result).toBe("(no nodes)");
  });

  it("renders a single node with no connections", () => {
    const node: INode = makeNode({ nodeId: "n1", name: "Solo", type: "start" });
    const result: string = buildAsciiGraph([node], "n1");

    expect(result).toContain("[ Solo ★ (start) ]");
    expect(result).toContain("Connections:");
    expect(result).toContain("(none)");
  });

  it("marks the entrypoint with ★", () => {
    const node: INode = makeNode({ nodeId: "ep", name: "Start", type: "start" });
    const result: string = buildAsciiGraph([node], "ep");

    expect(result).toContain("★");
  });

  it("does not mark ★ when entrypoint is null", () => {
    const node: INode = makeNode({ nodeId: "n1", name: "Node", type: "start" });
    const result: string = buildAsciiGraph([node], null);

    expect(result).not.toContain("★");
  });

  //#endregion Empty / single node

  //#region Linear chain

  it("renders a linear chain with arrows between each layer", () => {
    const a: INode = makeNode({ nodeId: "a", name: "A", connections: ["b"] });
    const b: INode = makeNode({ nodeId: "b", name: "B", connections: ["c"] });
    const c: INode = makeNode({ nodeId: "c", name: "C", connections: [] });

    const result: string = buildAsciiGraph([a, b, c], "a");
    const lines: string[] = result.split("\n");

    // All three node labels must appear
    expect(result).toContain("[ A ★ (start) ]");
    expect(result).toContain("[ B (start) ]");
    expect(result).toContain("[ C (start) ]");

    // A appears before B, B before C
    const idxA: number = lines.findIndex((l: string) => l.includes("[ A ★"));
    const idxB: number = lines.findIndex((l: string) => l.includes("[ B"));
    const idxC: number = lines.findIndex((l: string) => l.includes("[ C"));
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);

    // Arrows present between layers
    expect(result).toContain("|");
    expect(result).toContain("v");

    // Connection list
    expect(result).toContain("A ──> B");
    expect(result).toContain("B ──> C");
  });

  //#endregion Linear chain

  //#region Fan-out

  it("renders fan-out with a 'v' after the fan-out annotation", () => {
    const start: INode = makeNode({ nodeId: "s", name: "Start", type: "start", connections: ["b", "c"] });
    const b: INode = makeNode({ nodeId: "b", name: "Fetch RSS", type: "rss_fetcher" });
    const c: INode = makeNode({ nodeId: "c", name: "Fetch Web", type: "curl_fetcher" });

    const result: string = buildAsciiGraph([start, b, c], "s");
    const lines: string[] = result.split("\n");

    expect(result).toContain("+── fan-out ──>");

    // The line after the fan-out annotation must contain 'v'
    const fanOutLineIdx: number = lines.findIndex((l: string) => l.includes("+── fan-out ──>"));
    expect(fanOutLineIdx).toBeGreaterThanOrEqual(0);
    expect(lines[fanOutLineIdx + 1]).toContain("v");

    // Target names appear in the fan-out annotation
    expect(lines[fanOutLineIdx]).toContain("Fetch RSS");
    expect(lines[fanOutLineIdx]).toContain("Fetch Web");

    // Connections section
    expect(result).toContain("fan-out: 2 children");
  });

  //#endregion Fan-out

  //#region Fan-in

  it("renders fan-in with a 'v' after the fan-in annotation", () => {
    // Use null entrypoint so both source nodes are treated as layer-0 peers
    // (with an entrypoint set to one of them, the other would be classified as disconnected)
    const a: INode = makeNode({ nodeId: "a", name: "Fetch RSS", type: "rss_fetcher", connections: ["c"] });
    const b: INode = makeNode({ nodeId: "b", name: "Fetch Web", type: "curl_fetcher", connections: ["c"] });
    const c: INode = makeNode({ nodeId: "c", name: "Summarize", type: "output_to_ai" });

    const result: string = buildAsciiGraph([a, b, c], null);
    const lines: string[] = result.split("\n");

    expect(result).toContain("+── fan-in (from:");

    const fanInLineIdx: number = lines.findIndex((l: string) => l.includes("+── fan-in (from:"));
    expect(fanInLineIdx).toBeGreaterThanOrEqual(0);
    expect(lines[fanInLineIdx + 1]).toContain("v");

    expect(result).toContain("Summarize has 2 parents = fan-in");
  });

  //#endregion Fan-in

  //#region Diamond (fan-out + fan-in)

  it("renders a diamond graph correctly", () => {
    const start: INode = makeNode({ nodeId: "s", name: "Start", type: "start", connections: ["b", "c"] });
    const b: INode = makeNode({ nodeId: "b", name: "Branch A", type: "rss_fetcher", connections: ["end"] });
    const c: INode = makeNode({ nodeId: "c", name: "Branch B", type: "curl_fetcher", connections: ["end"] });
    const end: INode = makeNode({ nodeId: "end", name: "Merge", type: "output_to_ai" });

    const result: string = buildAsciiGraph([start, b, c, end], "s");

    // Fan-out and fan-in both present
    expect(result).toContain("+── fan-out ──>");
    expect(result).toContain("+── fan-in (from:");

    // 'v' present after fan-out
    const lines: string[] = result.split("\n");
    const fanOutIdx: number = lines.findIndex((l: string) => l.includes("+── fan-out ──>"));
    expect(lines[fanOutIdx + 1]).toContain("v");

    // End node appears at the bottom
    const idxStart: number = lines.findIndex((l: string) => l.includes("[ Start ★"));
    const idxMerge: number = lines.findIndex((l: string) => l.includes("[ Merge"));
    expect(idxStart).toBeLessThan(idxMerge);
  });

  //#endregion Diamond

  //#region Disconnected nodes

  it("shows disconnected nodes in a separate section — not mixed with layer 0", () => {
    const start: INode = makeNode({ nodeId: "s", name: "Start", type: "start", connections: ["b"] });
    const b: INode = makeNode({ nodeId: "b", name: "Connected", type: "python_code" });
    // Orphan: in-degree 0, no connections, not the entrypoint
    const orphan: INode = makeNode({ nodeId: "o", name: "Orphan", type: "python_code" });

    const result: string = buildAsciiGraph([start, b, orphan], "s");
    const lines: string[] = result.split("\n");

    // Orphan must NOT appear in layer 0 row (same line as Start)
    const layer0Line: string = lines.find((l: string) => l.includes("[ Start ★")) ?? "";
    expect(layer0Line).not.toContain("Orphan");

    // Orphan must appear in the disconnected section
    expect(result).toContain("[Disconnected nodes]");
    const disconnectedIdx: number = lines.findIndex((l: string) => l.includes("[Disconnected nodes]"));
    const orphanIdx: number = lines.findIndex((l: string) => l.includes("Orphan"));
    expect(disconnectedIdx).toBeGreaterThanOrEqual(0);
    expect(orphanIdx).toBeGreaterThan(disconnectedIdx);
  });

  it("does not show disconnected section when all nodes are reachable", () => {
    const a: INode = makeNode({ nodeId: "a", name: "A", connections: ["b"] });
    const b: INode = makeNode({ nodeId: "b", name: "B" });

    const result: string = buildAsciiGraph([a, b], "a");

    expect(result).not.toContain("[Disconnected nodes]");
  });

  it("does not show disconnected section when entrypoint is null", () => {
    // When no entrypoint, we cannot determine reachability — all nodes shown in normal layers
    const a: INode = makeNode({ nodeId: "a", name: "A" });
    const b: INode = makeNode({ nodeId: "b", name: "B" });

    const result: string = buildAsciiGraph([a, b], null);

    expect(result).not.toContain("[Disconnected nodes]");
  });

  it("shows multiple disconnected nodes in disconnected section", () => {
    const start: INode = makeNode({ nodeId: "s", name: "Start", type: "start" });
    const orphan1: INode = makeNode({ nodeId: "o1", name: "Ghost One", type: "python_code" });
    const orphan2: INode = makeNode({ nodeId: "o2", name: "Ghost Two", type: "python_code" });

    const result: string = buildAsciiGraph([start, orphan1, orphan2], "s");

    expect(result).toContain("[Disconnected nodes]");
    expect(result).toContain("Ghost One");
    expect(result).toContain("Ghost Two");

    // Neither ghost should be mixed with the start node
    const layer0Line: string = result.split("\n").find((l: string) => l.includes("[ Start ★")) ?? "";
    expect(layer0Line).not.toContain("Ghost");
  });

  //#endregion Disconnected nodes

  //#region Connections section

  it("shows (none) in connections when no edges exist", () => {
    const a: INode = makeNode({ nodeId: "a", name: "A" });
    const b: INode = makeNode({ nodeId: "b", name: "B" });

    const result: string = buildAsciiGraph([a, b], "a");

    expect(result).toContain("Connections:");
    expect(result).toContain("(none)");
  });

  it("notes fan-in parent count in the connections list", () => {
    const a: INode = makeNode({ nodeId: "a", name: "Alpha", connections: ["c"] });
    const b: INode = makeNode({ nodeId: "b", name: "Beta", connections: ["c"] });
    const c: INode = makeNode({ nodeId: "c", name: "Gamma" });

    const result: string = buildAsciiGraph([a, b, c], "a");

    expect(result).toContain("Gamma has 2 parents = fan-in");
  });

  //#endregion Connections section

  //#region Type label formatting

  it("replaces underscores with spaces in the type label", () => {
    const node: INode = makeNode({ nodeId: "n", name: "N", type: "rss_fetcher" });
    const result: string = buildAsciiGraph([node], "n");

    expect(result).toContain("(rss fetcher)");
    expect(result).not.toContain("rss_fetcher");
  });

  //#endregion Type label formatting
});

//#endregion Tests
