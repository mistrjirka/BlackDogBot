import { describe, it, expect } from "vitest";
import { isToolAllowed } from "../../src/helpers/tool-registry.js";

describe("MCP tool filtering", () => {
  describe("isToolAllowed for MCP tools", () => {
    it("should allow mcp.playwright.browser_click in full mode", () => {
      expect(isToolAllowed("mcp.playwright.browser_click", "full")).toBe(true);
    });

    it("should block mcp.playwright.browser_click in read_only mode", () => {
      expect(isToolAllowed("mcp.playwright.browser_click", "read_only")).toBe(false);
    });

    it("should allow mcp.github.list_issues in full mode", () => {
      expect(isToolAllowed("mcp.github.list_issues", "full")).toBe(true);
    });

    it("should block mcp.github.list_issues in read_only mode", () => {
      expect(isToolAllowed("mcp.github.list_issues", "read_only")).toBe(false);
    });

    it("should block mcp.anything in ignore mode", () => {
      expect(isToolAllowed("mcp.anything", "ignore")).toBe(false);
    });

    it("should block any mcp.* tool in read_only mode", () => {
      expect(isToolAllowed("mcp.some_server.some_tool", "read_only")).toBe(false);
      expect(isToolAllowed("mcp.custom.namespace", "read_only")).toBe(false);
    });

    it("should allow mcp.* tools in ignore mode (same as all tools)", () => {
      expect(isToolAllowed("mcp.server.tool", "ignore")).toBe(false);
    });
  });

  describe("isToolAllowed for existing core tools", () => {
    it("should allow run_cmd in full mode", () => {
      expect(isToolAllowed("run_cmd", "full")).toBe(true);
    });

    it("should block run_cmd in read_only mode (existing behavior)", () => {
      expect(isToolAllowed("run_cmd", "read_only")).toBe(false);
    });

    it("should allow write_file in full mode", () => {
      expect(isToolAllowed("write_file", "full")).toBe(true);
    });

    it("should block write_file in read_only mode (existing behavior)", () => {
      expect(isToolAllowed("write_file", "read_only")).toBe(false);
    });

    it("should allow send_message in full mode", () => {
      expect(isToolAllowed("send_message", "full")).toBe(true);
    });

    it("should allow send_message in read_only mode (safe tool)", () => {
      expect(isToolAllowed("send_message", "read_only")).toBe(true);
    });
  });

  describe("MCP tools take precedence over core tool behavior", () => {
    it("should block mcp.tool even if name matches core blocked tool pattern", () => {
      expect(isToolAllowed("mcp.run_cmd", "read_only")).toBe(false);
      expect(isToolAllowed("mcp.write_file", "read_only")).toBe(false);
    });
  });
});
