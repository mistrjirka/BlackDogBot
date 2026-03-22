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
