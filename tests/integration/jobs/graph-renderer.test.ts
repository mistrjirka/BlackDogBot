import { describe, it, expect } from "vitest";

import { buildDotDiagram, renderGraphToImageAsync } from "../../../src/utils/graph-renderer.js";
import type { INode, NodeType } from "../../../src/shared/types/index.js";

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

describe("graph-renderer", () => {
  //#region buildDotDiagram

  describe("buildDotDiagram", () => {
    it("single start node, is entrypoint", () => {
      const node: INode = makeNode({ nodeId: "abc123", type: "start", name: "My Start Node" });
      const nodes: INode[] = [node];

      const result: string = buildDotDiagram(nodes, "abc123", "test-job");

      expect(result).toContain("digraph G {");
      expect(result).toContain("rankdir=TD");
      expect(result).toContain("n_abc123");
      expect(result).toContain("⬥");
      expect(result).toContain("start");
      expect(result).toContain('fillcolor="#e8eaf6"');
      expect(result).toContain('color="#3949ab"');
      expect(result).toContain('fontcolor="#1a237e"');
    });

    it("two connected nodes", () => {
      const nodeA: INode = makeNode({
        nodeId: "nodeA",
        type: "start",
        name: "Node A",
        connections: ["nodeB"],
      });
      const nodeB: INode = makeNode({
        nodeId: "nodeB",
        type: "python_code",
        name: "Node B",
        connections: [],
      });
      const nodes: INode[] = [nodeA, nodeB];

      const result: string = buildDotDiagram(nodes, "nodeA", "test-job");

      expect(result).toContain("n_nodeA");
      expect(result).toContain("n_nodeB");
      expect(result).toContain("n_nodeA -> n_nodeB;");
      expect(result).toContain('fillcolor="#e8eaf6"');
      expect(result).toContain('fillcolor="#fff3e0"');
    });

    it("node with special characters in name", () => {
      const node: INode = makeNode({
        nodeId: "special",
        name: 'My "Node" <test>',
      });
      const nodes: INode[] = [node];

      const result: string = buildDotDiagram(nodes, null, "test-job");

      expect(result).toContain('My \\"Node\\" <test>');
      expect(result).not.toContain('My "Node"');
    });

    it("no entrypoint", () => {
      const node: INode = makeNode({ nodeId: "solo" });
      const nodes: INode[] = [node];

      const result: string = buildDotDiagram(nodes, null, "test-job");

      expect(result).not.toContain("⬥");
    });

    it("unknown node type gets default style", () => {
      const node: INode = makeNode({
        nodeId: "unknown-type",
        type: "totally_unknown" as NodeType,
      });
      const nodes: INode[] = [node];

      const result: string = buildDotDiagram(nodes, null, "test-job");

      expect(result).toContain('fillcolor="#f5f5f5"');
      expect(result).toContain('color="#9e9e9e"');
      expect(result).toContain('fontcolor="#212121"');
    });
  });

  //#endregion buildDotDiagram

  //#region renderGraphToImageAsync

  describe("renderGraphToImageAsync", () => {
    it("renders a simple DOT diagram to a real PNG", async () => {
      const dotCode: string = [
        "digraph G {",
        "  rankdir=TD;",
        '  node [shape=box, style="filled,rounded", fontname="Arial"];',
        '  A [label="Hello", fillcolor="#e8f5e9", color="#43a047", fontcolor="#1b5e20"];',
        '  B [label="World", fillcolor="#fff3e0", color="#fb8c00", fontcolor="#e65100"];',
        "  A -> B;",
        "}",
      ].join("\n");

      const result: Buffer = await renderGraphToImageAsync(dotCode);

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      // PNG magic bytes: 0x89 0x50 0x4E 0x47
      expect(result[0]).toBe(0x89);
      expect(result[1]).toBe(0x50);
      expect(result[2]).toBe(0x4e);
      expect(result[3]).toBe(0x47);
    }, 30000);

    it("rejects on invalid DOT syntax", async () => {
      const invalidDot: string = "this is not valid DOT syntax {{{";

      await expect(renderGraphToImageAsync(invalidDot)).rejects.toThrow("Graph rendering failed");
    }, 30000);
  });

  //#endregion renderGraphToImageAsync
});

//#endregion Tests
