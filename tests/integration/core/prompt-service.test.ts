import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { PromptService } from "../../../src/services/prompt.service.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

async function setupTempHomeAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-test-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;
}

async function cleanupTempHomeAsync(): Promise<void> {
  process.env.HOME = originalHome;
  await fs.rm(tempDir, { recursive: true, force: true });
}

//#endregion Helpers

//#region Tests

describe("PromptService", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();

    // Reset the singleton so it re-reads from the new HOME
    (PromptService as unknown as { _instance: null })._instance = null;
  });

  afterEach(async () => {
    (PromptService as unknown as { _instance: null })._instance = null;
    await cleanupTempHomeAsync();
  });

  it("should initialize and copy default prompts", async () => {
    const service: PromptService = PromptService.getInstance();

    await service.initializeAsync();

    const prompts = await service.listPromptsAsync();

    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some((p) => p.name === "main-agent")).toBe(true);
  });

  it("should load a prompt by name", async () => {
    const service: PromptService = PromptService.getInstance();

    await service.initializeAsync();

    const content: string = await service.getPromptAsync("main-agent");

    expect(content).toBeTruthy();
    expect(content.length).toBeGreaterThan(0);
  });

  it("should write and read back a prompt", async () => {
    const service: PromptService = PromptService.getInstance();

    await service.initializeAsync();

    const testContent: string = "This is a test prompt.";

    await service.writePromptAsync("test-prompt", testContent);

    const read: string = await service.getPromptAsync("test-prompt");

    expect(read).toBe(testContent);
  });

  it("should reset a prompt to factory default", async () => {
    const service: PromptService = PromptService.getInstance();

    await service.initializeAsync();

    const original: string = await service.getPromptRawAsync("main-agent");

    await service.writePromptAsync("main-agent", "modified content");

    service.clearCache();

    const modified: string = await service.getPromptRawAsync("main-agent");

    expect(modified).toBe("modified content");

    await service.resetPromptAsync("main-agent");

    service.clearCache();

    const reset: string = await service.getPromptRawAsync("main-agent");

    expect(reset).toBe(original);
  });

  it("should reset all prompts to factory defaults", async () => {
    const service: PromptService = PromptService.getInstance();

    await service.initializeAsync();

    await service.writePromptAsync("main-agent", "changed");

    await service.resetAllPromptsAsync();

    service.clearCache();

    const prompts = await service.listPromptsAsync();
    const modified = prompts.filter((p) => p.isModified);

    expect(modified).toHaveLength(0);
  });

  it("should apply updated default prompts after resetAllPromptsAsync", async () => {
    const service: PromptService = PromptService.getInstance();

    await service.initializeAsync();

    const originalRaw: string = await service.getPromptRawAsync("cron-agent");

    await service.writePromptAsync("cron-agent", "temporary override content");
    const overridden: string = await service.getPromptAsync("cron-agent");
    expect(overridden).toContain("temporary override content");

    await service.resetAllPromptsAsync();

    const afterResetRaw: string = await service.getPromptRawAsync("cron-agent");
    const afterResetResolved: string = await service.getPromptAsync("cron-agent");

    expect(afterResetRaw).toBe(originalRaw);
    expect(afterResetResolved).not.toContain("temporary override content");
  });

  it("should recommend update when stored prompt fingerprint is stale", async () => {
    const service: PromptService = PromptService.getInstance();

    await service.initializeAsync();

    expect(await service.isPromptUpdateRecommendedAsync()).toBe(false);

    const promptSyncStatePath: string = path.join(
      tempDir,
      ".blackdogbot",
      "cache",
      "prompt-sync-state.json",
    );

    await fs.writeFile(
      promptSyncStatePath,
      JSON.stringify({
        lastAppliedDefaultsFingerprint: "stale-fingerprint",
        updatedAt: new Date(0).toISOString(),
      }, null, 2),
      "utf-8",
    );

    expect(await service.isPromptUpdateRecommendedAsync()).toBe(true);

    await service.resetAllPromptsAsync();

    expect(await service.isPromptUpdateRecommendedAsync()).toBe(false);
  });

  it("should not recommend update when prompt sync state file is invalid", async () => {
    const service: PromptService = PromptService.getInstance();

    await service.initializeAsync();

    const promptSyncStatePath: string = path.join(
      tempDir,
      ".blackdogbot",
      "cache",
      "prompt-sync-state.json",
    );

    await fs.writeFile(promptSyncStatePath, "{ invalid json", "utf-8");

    expect(await service.isPromptUpdateRecommendedAsync()).toBe(false);
  });

  it("should resolve include directives", async () => {
    const service: PromptService = PromptService.getInstance();

    await service.initializeAsync();

    // main-agent.md likely includes fragments — just verify it resolves without error
    const content: string = await service.getPromptAsync("main-agent");

    expect(content).toBeTruthy();
    // After resolving, there should be no unresolved include directives
    expect(content).not.toContain("{{include:");
  });

  it("should throw when loading non-existent prompt", async () => {
    const service: PromptService = PromptService.getInstance();

    await service.initializeAsync();

    await expect(service.getPromptAsync("nonexistent-prompt-xyz")).rejects.toThrow(
      "Prompt not found",
    );
  });
});

//#endregion Tests
