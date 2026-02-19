import { describe, it, expect } from "vitest";

import { validateGraph, getExecutionOrder } from "../../src/jobs/graph.js";
import type { INode } from "../../src/shared/types/index.js";

//#region Helpers

function createNode(
  nodeId: string,
  connections: string[] = [],
  jobId: string = "test-job",
): INode {
  return {
    nodeId,
    jobId,
    type: "manual",
    name: `Node ${nodeId}`,
    description: `Test node ${nodeId}`,
    inputSchema: {},
    outputSchema: {},
    connections,
    config: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

//#endregion Helpers

//#region Tests

describe("graph", () => {
  describe("validateGraph", () => {
    it("should validate a simple linear graph", () => {
      const nodes: INode[] = [
        createNode("a", ["b"]),
        createNode("b", ["c"]),
        createNode("c"),
      ];

      const result = validateGraph(nodes, "a");

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.topologicalOrder).toEqual(["a", "b", "c"]);
    });

    it("should detect cycles", () => {
      const nodes: INode[] = [
        createNode("a", ["b"]),
        createNode("b", ["c"]),
        createNode("c", ["a"]),
      ];

      const result = validateGraph(nodes, "a");

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes("cycle"))).toBe(true);
      expect(result.topologicalOrder).toHaveLength(0);
    });

    it("should error when entrypoint is null", () => {
      const nodes: INode[] = [createNode("a")];

      const result = validateGraph(nodes, null);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("No entrypoint node set.");
    });

    it("should error when entrypoint node does not exist", () => {
      const nodes: INode[] = [createNode("a")];

      const result = validateGraph(nodes, "nonexistent");

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes("not found"))).toBe(true);
    });

    it("should detect connections to non-existent nodes", () => {
      const nodes: INode[] = [
        createNode("a", ["missing"]),
      ];

      const result = validateGraph(nodes, "a");

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes("non-existent"))).toBe(true);
    });

    it("should detect unreachable nodes", () => {
      const nodes: INode[] = [
        createNode("a", ["b"]),
        createNode("b"),
        createNode("c"), // not connected
      ];

      const result = validateGraph(nodes, "a");

      expect(result.valid).toBe(false);
      expect(result.errors.some((e: string) => e.includes("not reachable"))).toBe(true);
    });

    it("should handle a diamond graph", () => {
      const nodes: INode[] = [
        createNode("a", ["b", "c"]),
        createNode("b", ["d"]),
        createNode("c", ["d"]),
        createNode("d"),
      ];

      const result = validateGraph(nodes, "a");

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      // a must come first, d must come last
      expect(result.topologicalOrder[0]).toBe("a");
      expect(result.topologicalOrder[result.topologicalOrder.length - 1]).toBe("d");
    });

    it("should handle single-node graph", () => {
      const nodes: INode[] = [createNode("a")];

      const result = validateGraph(nodes, "a");

      expect(result.valid).toBe(true);
      expect(result.topologicalOrder).toEqual(["a"]);
    });
  });

  describe("getExecutionOrder", () => {
    it("should return topological order for valid graph", () => {
      const nodes: INode[] = [
        createNode("a", ["b"]),
        createNode("b", ["c"]),
        createNode("c"),
      ];

      const order: string[] = getExecutionOrder(nodes, "a");

      expect(order).toEqual(["a", "b", "c"]);
    });

    it("should throw on invalid graph", () => {
      const nodes: INode[] = [
        createNode("a", ["b"]),
        createNode("b", ["a"]),
      ];

      expect(() => getExecutionOrder(nodes, "a")).toThrow("Invalid graph");
    });
  });
});

//#endregion Tests
