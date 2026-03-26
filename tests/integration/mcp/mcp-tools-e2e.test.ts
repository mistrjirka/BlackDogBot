import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { createTestEnvironment, resetSingletons, loadTestConfigAsync } from "../../utils/test-helpers.js";
import { McpRegistryService } from "../../../src/services/mcp-registry.service.js";
import { LangchainMcpService } from "../../../src/services/langchain-mcp.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { isToolAllowed } from "../../../src/helpers/tool-registry.js";
import type { IMcpServerConfig } from "../../../src/shared/types/mcp.types.js";

const env = createTestEnvironment("mcp-e2e");

describe("MCP Tools E2E", () => {
  beforeAll(async () => {
    await env.setupAsync({ logLevel: "error" });

    await loadTestConfigAsync(env.tempDir);

    const loggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("error", path.join(env.tempDir, "logs"));

    const configService = ConfigService.getInstance();
    await configService.initializeAsync();
  }, 60000);

  afterAll(async () => {
    const mcpService = LangchainMcpService.getInstance();
    await mcpService.closeAsync();
    resetSingletons();
    await env.teardownAsync();
  });

  describe("server lifecycle", () => {
    it("should connect to test MCP server and discover tools", async () => {
      const registry = McpRegistryService.getInstance();
      await registry.initializeAsync();

      const serverConfig: IMcpServerConfig = {
        command: "tsx",
        args: ["tests/mocks/mcp-test-server.ts"],
      };

      await registry.addServerAsync("test-server", serverConfig);

      const mcpService = LangchainMcpService.getInstance();
      await mcpService.refreshAsync();

      const tools = mcpService.getTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("mcp.test-server.echo");
      expect(toolNames).toContain("mcp.test-server.add");
      expect(toolNames).toContain("mcp.test-server.uppercase");
      expect(toolNames).toContain("mcp.test-server.get_timestamp");
    }, 30000);

    it("should report server results after refresh", async () => {
      const mcpService = LangchainMcpService.getInstance();
      const results = mcpService.getServerResults();

      const testResult = results.get("test-server");
      expect(testResult).toBeDefined();
      expect(testResult!.error).toBeNull();
      expect(testResult!.loadedToolNames.length).toBeGreaterThan(0);
    });

    it("should clean up connections on close", async () => {
      const mcpService = LangchainMcpService.getInstance();
      await mcpService.closeAsync();

      const tools = mcpService.getTools();
      expect(tools).toHaveLength(0);

      // Reconnect for other tests
      const mcpService2 = LangchainMcpService.getInstance();
      await mcpService2.refreshAsync();
    }, 30000);
  });

  describe("tool execution", () => {
    it("should execute echo tool and return input message", async () => {
      const mcpService = LangchainMcpService.getInstance();
      await mcpService.refreshAsync();

      const tools = mcpService.getTools();
      const echoTool = tools.find((t) => t.name === "mcp.test-server.echo");
      expect(echoTool).toBeDefined();

      const result = await echoTool!.invoke({ message: "Hello MCP!" });
      expect(result).toBeDefined();
      expect(result.structuredContent).toEqual({ text: "Hello MCP!" });
    }, 30000);

    it("should execute add tool and return sum", async () => {
      const mcpService = LangchainMcpService.getInstance();
      const tools = mcpService.getTools();
      const addTool = tools.find((t) => t.name === "mcp.test-server.add");
      expect(addTool).toBeDefined();

      const result = await addTool!.invoke({ a: 3, b: 5 });
      expect(result).toBeDefined();
      expect(result.structuredContent).toEqual({ result: 8 });
    });

    it("should execute uppercase tool and return uppercased text", async () => {
      const mcpService = LangchainMcpService.getInstance();
      const tools = mcpService.getTools();
      const uppercaseTool = tools.find((t) => t.name === "mcp.test-server.uppercase");
      expect(uppercaseTool).toBeDefined();

      const result = await uppercaseTool!.invoke({ text: "hello world" });
      expect(result).toBeDefined();
      expect(result.structuredContent).toEqual({ result: "HELLO WORLD" });
    });

    it("should execute get_timestamp tool and return ISO timestamp", async () => {
      const mcpService = LangchainMcpService.getInstance();
      const tools = mcpService.getTools();
      const timestampTool = tools.find((t) => t.name === "mcp.test-server.get_timestamp");
      expect(timestampTool).toBeDefined();

      const result = await timestampTool!.invoke({});
      expect(result).toBeDefined();
      const timestamp = result.structuredContent.timestamp;
      expect(typeof timestamp).toBe("string");
      // Verify it's a valid ISO timestamp
      expect(() => new Date(timestamp)).not.toThrow();
      expect(new Date(timestamp).toISOString()).toBe(timestamp);
    });
  });

  describe("permission filtering", () => {
    it("should block MCP tools in read_only permission", () => {
      expect(isToolAllowed("mcp.test-server.echo", "read_only")).toBe(false);
      expect(isToolAllowed("mcp.test-server.add", "read_only")).toBe(false);
      expect(isToolAllowed("mcp.test-server.uppercase", "read_only")).toBe(false);
    });

    it("should allow MCP tools in full permission", () => {
      expect(isToolAllowed("mcp.test-server.echo", "full")).toBe(true);
      expect(isToolAllowed("mcp.test-server.add", "full")).toBe(true);
      expect(isToolAllowed("mcp.test-server.uppercase", "full")).toBe(true);
    });
  });

  describe("strict output schema mode", () => {
    it("should skip tools without outputSchema in strict mode", async () => {
      // Close existing connections
      const mcpService = LangchainMcpService.getInstance();
      await mcpService.closeAsync();

      const registry = McpRegistryService.getInstance();
      await registry.removeServerAsync("test-server");

      // Add server with strictOutputSchema: true (default)
      await registry.addServerAsync("strict-server", {
        command: "tsx",
        args: ["tests/mocks/mcp-test-server.ts"],
      });

      await mcpService.refreshAsync();

      const results = mcpService.getServerResults();
      const strictResult = results.get("strict-server");
      expect(strictResult).toBeDefined();

      // no_schema_tool should be skipped with a warning
      const warnings = strictResult!.warnings;
      expect(warnings.some((w) => w.includes("no_schema_tool"))).toBe(true);

      // Echo, add, uppercase, get_timestamp should still be loaded
      const tools = mcpService.getTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("mcp.strict-server.echo");
      expect(toolNames).toContain("mcp.strict-server.add");
      expect(toolNames).toContain("mcp.strict-server.uppercase");
      expect(toolNames).toContain("mcp.strict-server.get_timestamp");

      // Cleanup
      await mcpService.closeAsync();
      await registry.removeServerAsync("strict-server");
    }, 30000);
  });
});