import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { McpRegistryService } from "../../src/services/mcp-registry.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { resetSingletons } from "../utils/test-helpers.js";

let tempDir: string;
let originalHome: string;

describe("McpRegistryService", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-mcp-registry-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons([McpRegistryService, LoggerService]);

    const logger: LoggerService = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);
  });

  afterEach(async () => {
    resetSingletons([McpRegistryService, LoggerService]);
    vi.restoreAllMocks();

    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("addServerAsync", () => {
    it("should add a server and return it via getServer", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      const server = await registry.addServerAsync("playwright", {
        command: "npx",
        args: ["-y", "@playwright/mcp-server"],
      });

      expect(server.id).toBe("playwright");
      expect(server.transport).toBe("stdio");
      expect(server.enabled).toBe(true);
      expect(server.strictOutputSchema).toBe(true);
      expect(server.config.command).toBe("npx");
      expect(server.config.args).toEqual(["-y", "@playwright/mcp-server"]);

      const retrieved = registry.getServer("playwright");
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe("playwright");
      expect(retrieved?.transport).toBe("stdio");
      expect(retrieved?.enabled).toBe(true);
      expect(retrieved?.config.command).toBe("npx");
      expect(retrieved?.config.args).toEqual(["-y", "@playwright/mcp-server"]);
    });

    it("should add multiple servers and return all via getAllServers", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      await registry.addServerAsync("github", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
      });

      await registry.addServerAsync("filesystem", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      });

      const allServers = registry.getAllServers();
      expect(allServers).toHaveLength(2);
      expect(allServers.map((s) => s.id)).toContain("github");
      expect(allServers.map((s) => s.id)).toContain("filesystem");
    });

    it("should persist server to JSON file", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      await registry.addServerAsync("test-server", {
        command: "echo",
        args: ["hello"],
      });

      const filePath = path.join(tempDir, ".betterclaw", "mcp-servers.json");
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.mcpServers).toBeDefined();
      expect(parsed.mcpServers["test-server"]).toBeDefined();
      expect(parsed.mcpServers["test-server"].command).toBe("echo");
    });

    it("should throw validation error for config with neither command nor url", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      await expect(
        registry.addServerAsync("invalid-server", {})
      ).rejects.toThrow("Invalid MCP server config");
    });

    it("should add server with http transport when url is provided", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      const server = await registry.addServerAsync("http-server", {
        url: "https://mcp.example.com/sse",
        headers: { Authorization: "Bearer token" },
      });

      expect(server.transport).toBe("http");
      expect(server.config.url).toBe("https://mcp.example.com/sse");
      expect(server.config.headers?.Authorization).toBe("Bearer token");
    });
  });

  describe("removeServerAsync", () => {
    it("should remove a server and return true", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      await registry.addServerAsync("to-remove", { command: "echo" });
      expect(registry.hasServer("to-remove")).toBe(true);

      const removed = await registry.removeServerAsync("to-remove");
      expect(removed).toBe(true);
      expect(registry.hasServer("to-remove")).toBe(false);
    });

    it("should return false when removing non-existent server", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      const removed = await registry.removeServerAsync("non-existent");
      expect(removed).toBe(false);
    });

    it("should update persisted file after removal", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      await registry.addServerAsync("server1", { command: "echo" });
      await registry.addServerAsync("server2", { command: "echo" });
      await registry.removeServerAsync("server1");

      const filePath = path.join(tempDir, ".betterclaw", "mcp-servers.json");
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.mcpServers["server1"]).toBeUndefined();
      expect(parsed.mcpServers["server2"]).toBeDefined();
    });
  });

  describe("setEnabledAsync", () => {
    it("should toggle server enabled state to false", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      await registry.addServerAsync("toggle-test", { command: "echo" });
      expect(registry.getServer("toggle-test")?.enabled).toBe(true);

      const result = await registry.setEnabledAsync("toggle-test", false);
      expect(result).toBe(true);
      expect(registry.getServer("toggle-test")?.enabled).toBe(false);
    });

    it("should toggle server enabled state back to true", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      await registry.addServerAsync("toggle-test", { command: "echo" });
      await registry.setEnabledAsync("toggle-test", false);

      const result = await registry.setEnabledAsync("toggle-test", true);
      expect(result).toBe(true);
      expect(registry.getServer("toggle-test")?.enabled).toBe(true);
    });

    it("should return false when toggling non-existent server", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      const result = await registry.setEnabledAsync("non-existent", false);
      expect(result).toBe(false);
    });

    it("should persist enabled state to file", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      await registry.addServerAsync("persist-test", { command: "echo" });
      await registry.setEnabledAsync("persist-test", false);

      const retrieved = registry.getServer("persist-test");
      expect(retrieved?.enabled).toBe(false);
    });
  });

  describe("getServer and getAllServers", () => {
    it("should return undefined for non-existent server", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      const server = registry.getServer("does-not-exist");
      expect(server).toBeUndefined();
    });

    it("should return empty array when no servers configured", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      const servers = registry.getAllServers();
      expect(servers).toEqual([]);
    });
  });

  describe("hasServer", () => {
    it("should return true for existing server", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      await registry.addServerAsync("exists", { command: "echo" });
      expect(registry.hasServer("exists")).toBe(true);
    });

    it("should return false for non-existent server", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      expect(registry.hasServer("not-exists")).toBe(false);
    });
  });

  describe("initializeAsync", () => {
    it("should load servers from existing config file", async () => {
      const configDir = path.join(tempDir, ".betterclaw");
      await fs.mkdir(configDir, { recursive: true });

      const configContent = {
        mcpServers: {
          "preloaded-server": {
            command: "echo",
            args: ["preloaded"],
          },
        },
      };
      await fs.writeFile(
        path.join(configDir, "mcp-servers.json"),
        JSON.stringify(configContent)
      );

      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      const server = registry.getServer("preloaded-server");
      expect(server).toBeDefined();
      expect(server?.config.command).toBe("echo");
    });

    it("should create empty registry when config file does not exist", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      const servers = registry.getAllServers();
      expect(servers).toEqual([]);
    });

    it("should handle malformed JSON gracefully", async () => {
      const configDir = path.join(tempDir, ".betterclaw");
      await fs.mkdir(configDir, { recursive: true });

      await fs.writeFile(path.join(configDir, "mcp-servers.json"), "not valid json");

      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      const servers = registry.getAllServers();
      expect(servers).toEqual([]);
    });
  });

  describe("server ID validation", () => {
    it("should accept alphanumeric IDs", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      const server = await registry.addServerAsync("playwright123", { command: "echo" });
      expect(server.id).toBe("playwright123");
    });

    it("should accept IDs with dashes", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      const server = await registry.addServerAsync("my-server", { command: "echo" });
      expect(server.id).toBe("my-server");
    });

    it("should accept IDs with underscores", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      const server = await registry.addServerAsync("my_server", { command: "echo" });
      expect(server.id).toBe("my_server");
    });

    it("should reject IDs with dots", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      await expect(
        registry.addServerAsync("has.dots", { command: "echo" }),
      ).rejects.toThrow("Invalid server id");
    });

    it("should reject IDs with slashes", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      await expect(
        registry.addServerAsync("has/slash", { command: "echo" }),
      ).rejects.toThrow("Invalid server id");
    });

    it("should reject IDs with spaces", async () => {
      const registry: McpRegistryService = McpRegistryService.getInstance();
      await registry.initializeAsync();

      await expect(
        registry.addServerAsync("has space", { command: "echo" }),
      ).rejects.toThrow("Invalid server id");
    });
  });
});
