import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { McpRegistryService } from "../../../src/services/mcp-registry.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";

let tempDir: string;
let originalHome: string;

describe("McpRegistryService integration", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-mcp-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const logger: LoggerService = LoggerService.getInstance();
    silenceLogger(logger);
  });

  afterEach(async () => {
    resetSingletons();
    vi.restoreAllMocks();

    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reloads external edits while preserving the existing registry on malformed config", async () => {
    const registry = McpRegistryService.getInstance();
    await registry.initializeAsync();
    await registry.addServerAsync("existing", {
      command: "npx", args: ["-y", "@modelcontextprotocol/server-memory@2.0.0"],
    });
    const configPath = path.join(tempDir, ".blackdogbot", "mcp-servers.json");
    const original = await fs.readFile(configPath, "utf8");
    expect(await registry.reloadIfChangedAsync()).toBe(false);

    const modified = JSON.parse(original);
    modified.mcpServers.additional = { command: "npx", args: ["-y", "other"] };
    await fs.writeFile(configPath, JSON.stringify(modified));
    expect(await registry.reloadIfChangedAsync()).toBe(true);
    expect(registry.hasServer("additional")).toBe(true);
    expect(registry.hasServer("existing")).toBe(true);
    expect(await registry.reloadIfChangedAsync()).toBe(false);

    await fs.writeFile(configPath, "{not-json");
    expect(await registry.reloadIfChangedAsync()).toBe(false);
    expect(registry.hasServer("additional")).toBe(true);

    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { bad: { args: [] } } }));
    expect(await registry.reloadIfChangedAsync()).toBe(false);
    expect(registry.hasServer("existing")).toBe(true);

    await fs.writeFile(configPath, original);
    expect(await registry.reloadIfChangedAsync()).toBe(true);
    expect(registry.hasServer("additional")).toBe(false);
    expect(registry.hasServer("existing")).toBe(true);
  });

  it("keeps registry writes atomic/private and refuses to overwrite a broken file", async () => {
    const registry = McpRegistryService.getInstance();
    await registry.initializeAsync();
    await registry.addServerAsync("initial", { command: "npx", args: ["-y", "test"] });
    const configPath = path.join(tempDir, ".blackdogbot", "mcp-servers.json");
    const stat = await fs.stat(configPath);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
    await fs.writeFile(configPath, "{broken");
    await expect(registry.addServerAsync("other", { command: "npx" })).rejects.toThrow("Refusing to overwrite");
    expect(await fs.readFile(configPath, "utf8")).toBe("{broken");
  });

  it("should reload servers from file on initialize", async () => {
    const registry1: McpRegistryService = McpRegistryService.getInstance();
    await registry1.initializeAsync();

    await registry1.addServerAsync("persisted-server", {
      command: "npx",
      args: ["tsx", "test.ts"],
    });

    expect(registry1.hasServer("persisted-server")).toBe(true);

    resetSingletons();

    const registry2: McpRegistryService = McpRegistryService.getInstance();
    await registry2.initializeAsync();

    expect(registry2.hasServer("persisted-server")).toBe(true);
    const server = registry2.getServer("persisted-server");
    expect(server?.config.command).toBe("npx");
  });
});
