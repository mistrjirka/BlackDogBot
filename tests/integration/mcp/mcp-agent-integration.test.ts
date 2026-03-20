import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { McpRegistryService } from "../../../src/services/mcp-registry.service.js";
import { McpService } from "../../../src/services/mcp.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";

let tempDir: string;
let originalHome: string;

describe("MCP Agent Integration", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-mcp-agent-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const logger: LoggerService = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);

    await logger.initializeAsync("error", path.join(tempDir, "logs"));

    const registry = McpRegistryService.getInstance();
    await registry.initializeAsync();

    await registry.addServerAsync("test", {
      command: "npx",
      args: ["tsx", "tests/mocks/mcp-test-server.ts"],
    });

    const mcpService = McpService.getInstance();
    await mcpService.refreshAsync();
  }, 30000);

  afterAll(async () => {
    try {
      await McpService.getInstance().closeAsync();
    } catch {
      // ignore
    }

    resetSingletons();
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("Tool Discovery", () => {
    it("should discover tools from mock MCP server", () => {
      const mcpService = McpService.getInstance();
      const tools = mcpService.getTools();
      const toolNames = Object.keys(tools);

      expect(toolNames).toContain("mcp.test.echo");
      expect(toolNames).toContain("mcp.test.echo_image");
    });

    it("should skip no_schema_tool due to strict mode", () => {
      const mcpService = McpService.getInstance();
      const tools = mcpService.getTools();
      const toolNames = Object.keys(tools);

      expect(toolNames).not.toContain("mcp.test.no_schema_tool");
    });

    it("should report warnings for skipped tools", () => {
      const mcpService = McpService.getInstance();
      const results = mcpService.getServerResults();
      const result = results.get("test");

      expect(result).toBeDefined();
      expect(result?.error).toBeNull();
      expect(result?.warnings).toContain(
        'Skipped tool "no_schema_tool" — missing outputSchema (strict mode)',
      );
    });

    it("should report loaded tool names", () => {
      const mcpService = McpService.getInstance();
      const results = mcpService.getServerResults();
      const result = results.get("test");

      expect(result?.loadedToolNames).toContain("mcp.test.echo");
      expect(result?.loadedToolNames).toContain("mcp.test.echo_image");
      expect(result?.loadedToolNames).toHaveLength(2);
    });
  });

  describe("Tool Execution", () => {
    it("should execute echo tool and return structured result", async () => {
      const mcpService = McpService.getInstance();
      const tools = mcpService.getTools();

      const echoTool = tools["mcp.test.echo"];
      expect(echoTool).toBeDefined();

      const executeFn = (echoTool as any).execute;
      const result = await executeFn({ message: "Hello MCP!" });

      expect(result).toHaveProperty("content");
      const content = (result as any).content;
      expect(content).toHaveLength(1);
      expect(content[0]).toEqual({ type: "text", text: "Hello MCP!" });
      expect(result).toHaveProperty("structuredContent");
      expect((result as any).structuredContent).toEqual({ text: "Hello MCP!" });
    });

    it("should execute echo_image tool and return image content", async () => {
      const mcpService = McpService.getInstance();
      const tools = mcpService.getTools();

      const imageTool = tools["mcp.test.echo_image"];
      expect(imageTool).toBeDefined();

      const executeFn = (imageTool as any).execute;
      const result = await executeFn({ message: "test" });

      const content = (result as any).content;
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: "text", text: "Image for: test" });
      expect(content[1].type).toBe("image");
      expect(content[1].mimeType).toBe("image/png");
      expect(content[1].data).toBeDefined();
      expect(typeof content[1].data).toBe("string");
    });

    it("should handle tool call errors gracefully", async () => {
      const mcpService = McpService.getInstance();
      const tools = mcpService.getTools();

      const echoTool = tools["mcp.test.echo"];
      const executeFn = (echoTool as any).execute;

      // Call with invalid input (missing required field)
      const result = await executeFn({});

      // MCP server should return the result even with empty message
      expect(result).toBeDefined();
      expect(result).toHaveProperty("content");
    });
  });

  describe("toModelOutput Conversion", () => {
    it("should convert MCP text content to model output", () => {
      const mcpService = McpService.getInstance();
      const tools = mcpService.getTools();

      const echoTool = tools["mcp.test.echo"];
      const toModelOutput = (echoTool as any).toModelOutput;
      expect(toModelOutput).toBeDefined();

      const mcpResult = {
        content: [{ type: "text", text: "hello" }],
        structuredContent: { text: "hello" },
      };
      const output = toModelOutput({ output: mcpResult });

      expect(output.type).toBe("content");
      const textParts = output.value.filter((p: any) => p.type === "text");
      expect(textParts).toHaveLength(2); // text content + structured output
      expect(textParts[0].text).toBe("hello");
      expect(textParts[1].text).toContain("Structured output");
    });

    it("should convert MCP image content to media type for model", () => {
      const mcpService = McpService.getInstance();
      const tools = mcpService.getTools();

      const imageTool = tools["mcp.test.echo_image"];
      const toModelOutput = (imageTool as any).toModelOutput;

      const mcpResult = {
        content: [
          { type: "text", text: "screenshot" },
          { type: "image", data: "base64data", mimeType: "image/png" },
        ],
        structuredContent: { hasImage: true },
      };
      const output = toModelOutput({ output: mcpResult });

      expect(output.type).toBe("content");
      const mediaParts = output.value.filter((p: any) => p.type === "media");
      expect(mediaParts).toHaveLength(1);
      expect(mediaParts[0].data).toBe("base64data");
      expect(mediaParts[0].mediaType).toBe("image/png");
    });

    it("should handle empty content gracefully", () => {
      const mcpService = McpService.getInstance();
      const tools = mcpService.getTools();

      const echoTool = tools["mcp.test.echo"];
      const toModelOutput = (echoTool as any).toModelOutput;

      const output = toModelOutput({ output: { content: [] } });

      expect(output.type).toBe("content");
      expect(output.value).toHaveLength(1);
      expect(output.value[0].text).toBe("No content returned.");
    });

    it("should handle non-object output gracefully", () => {
      const mcpService = McpService.getInstance();
      const tools = mcpService.getTools();

      const echoTool = tools["mcp.test.echo"];
      const toModelOutput = (echoTool as any).toModelOutput;

      const output = toModelOutput({ output: null });

      expect(output.type).toBe("content");
      expect(output.value).toHaveLength(1);
      expect(output.value[0].type).toBe("text");
    });
  });

  describe("Input Schema Conversion", () => {
    it("should create valid Zod schema from MCP tool inputSchema", () => {
      const mcpService = McpService.getInstance();
      const tools = mcpService.getTools();

      const echoTool = tools["mcp.test.echo"];
      const inputSchema = (echoTool as any).inputSchema;
      expect(inputSchema).toBeDefined();

      const parseResult = inputSchema.safeParse({ message: "test" });
      expect(parseResult.success).toBe(true);
    });

    it("should reject invalid input (missing required field)", () => {
      const mcpService = McpService.getInstance();
      const tools = mcpService.getTools();

      const echoTool = tools["mcp.test.echo"];
      const inputSchema = (echoTool as any).inputSchema;

      const invalidResult = inputSchema.safeParse({});
      expect(invalidResult.success).toBe(false);
    });
  });

  describe("Connection Lifecycle", () => {
    it("should reuse existing connections on refresh", async () => {
      const mcpService = McpService.getInstance();

      const toolsBefore = mcpService.getTools();
      expect(Object.keys(toolsBefore)).toHaveLength(2);

      // Second refresh should reuse existing connection
      await mcpService.refreshAsync();

      const toolsAfter = mcpService.getTools();
      expect(Object.keys(toolsAfter)).toHaveLength(2);
      expect(Object.keys(toolsAfter)).toEqual(Object.keys(toolsBefore));
    });

    it("should clear all state on closeAsync", async () => {
      // Use a separate registry/service pair for this test
      const registry = McpRegistryService.getInstance();
      await registry.addServerAsync("close-test", {
        command: "npx",
        args: ["tsx", "tests/mocks/mcp-test-server.ts"],
      });

      const mcpService = McpService.getInstance();
      await mcpService.refreshAsync();

      expect(Object.keys(mcpService.getTools())).toContain("mcp.close-test.echo");

      // Close just the close-test server by refreshing after removing it
      await registry.removeServerAsync("close-test");
      await mcpService.refreshAsync();

      // close-test tools should be gone
      const tools = mcpService.getTools();
      expect(Object.keys(tools)).not.toContain("mcp.close-test.echo");
    });

    it("should fully disconnect on closeAsync", async () => {
      // Create a fresh service context
      const mcpService = McpService.getInstance();
      const toolsBefore = mcpService.getTools();
      expect(Object.keys(toolsBefore).length).toBeGreaterThan(0);

      await mcpService.closeAsync();

      const toolsAfter = mcpService.getTools();
      expect(Object.keys(toolsAfter)).toHaveLength(0);
      expect(mcpService.getServerResults().size).toBe(0);
    });

    it("should allow reconnect after closeAsync", async () => {
      const mcpService = McpService.getInstance();
      const registry = McpRegistryService.getInstance();

      // Re-add the server (it was removed in the previous test's registry)
      // Re-add test server since it may have been removed
      if (!registry.hasServer("test")) {
        await registry.addServerAsync("test", {
          command: "npx",
          args: ["tsx", "tests/mocks/mcp-test-server.ts"],
        });
      }

      await mcpService.refreshAsync();

      const tools = mcpService.getTools();
      expect(Object.keys(tools)).toContain("mcp.test.echo");
    });

    it("should skip disabled servers during refresh", async () => {
      const registry = McpRegistryService.getInstance();
      await registry.addServerAsync("disabled-test", {
        command: "npx",
        args: ["tsx", "tests/mocks/mcp-test-server.ts"],
      });
      await registry.setEnabledAsync("disabled-test", false);

      const mcpService = McpService.getInstance();
      await mcpService.refreshAsync();

      const tools = mcpService.getTools();
      expect(Object.keys(tools)).not.toContain("mcp.disabled-test.echo");

      // Re-enable for cleanup
      await registry.removeServerAsync("disabled-test");
    });

    it("should handle server ID validation", async () => {
      const registry = McpRegistryService.getInstance();

      await expect(
        registry.addServerAsync("invalid.id", { command: "echo" }),
      ).rejects.toThrow("Invalid server id");
    });
  });
});
