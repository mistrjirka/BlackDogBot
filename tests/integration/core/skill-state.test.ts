import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { SkillStateService } from "../../../src/services/skill-state.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import type { ISkillStateInfo } from "../../../src/shared/types/index.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

async function setupTempHomeAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-skillstate-test-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;
}

async function cleanupTempHomeAsync(): Promise<void> {
  process.env.HOME = originalHome;
  await fs.rm(tempDir, { recursive: true, force: true });
}

function resetSingletons(): void {
  (SkillStateService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
}

//#endregion Helpers

//#region Tests

describe("SkillStateService", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();
    resetSingletons();

    // Silence logger
    const logger: LoggerService = LoggerService.getInstance();
    vi.spyOn(logger, "debug").mockReturnValue(undefined);
    vi.spyOn(logger, "info").mockReturnValue(undefined);
    vi.spyOn(logger, "warn").mockReturnValue(undefined);
    vi.spyOn(logger, "error").mockReturnValue(undefined);
  });

  afterEach(async () => {
    resetSingletons();
    vi.restoreAllMocks();
    await cleanupTempHomeAsync();
  });

  it("should return default never-touched state when no state file exists", async () => {
    const service: SkillStateService = SkillStateService.getInstance();

    const state: ISkillStateInfo = await service.getStateAsync("nonexistent-skill");

    expect(state.state).toBe("never-touched");
    expect(state.lastError).toBeNull();
    expect(state.setupAt).toBeNull();
    expect(state.lastCheckedAt).toBeNull();
  });

  it("should save and retrieve state roundtrip", async () => {
    const service: SkillStateService = SkillStateService.getInstance();

    const stateToSave: ISkillStateInfo = {
      state: "setuped",
      lastError: null,
      setupAt: "2026-01-01T00:00:00.000Z",
      lastCheckedAt: "2026-01-01T00:00:00.000Z",
    };

    await service.saveStateAsync("my-skill", stateToSave);

    const retrieved: ISkillStateInfo = await service.getStateAsync("my-skill");

    expect(retrieved.state).toBe("setuped");
    expect(retrieved.setupAt).toBe("2026-01-01T00:00:00.000Z");
    expect(retrieved.lastError).toBeNull();
  });

  it("should markSetupComplete and persist the setuped state", async () => {
    const service: SkillStateService = SkillStateService.getInstance();

    await service.markSetupCompleteAsync("completed-skill");

    const state: ISkillStateInfo = await service.getStateAsync("completed-skill");

    expect(state.state).toBe("setuped");
    expect(state.lastError).toBeNull();
    expect(state.setupAt).toBeTruthy();
    expect(state.lastCheckedAt).toBeTruthy();
  });

  it("should markSetupError and persist the error state", async () => {
    const service: SkillStateService = SkillStateService.getInstance();

    await service.markSetupErrorAsync("broken-skill", "Something went wrong");

    const state: ISkillStateInfo = await service.getStateAsync("broken-skill");

    expect(state.state).toBe("error-during-setup");
    expect(state.lastError).toBe("Something went wrong");
    expect(state.setupAt).toBeNull();
    expect(state.lastCheckedAt).toBeTruthy();
  });

  it("should overwrite previous state when saving new state", async () => {
    const service: SkillStateService = SkillStateService.getInstance();

    await service.markSetupErrorAsync("flip-skill", "initial error");

    let state: ISkillStateInfo = await service.getStateAsync("flip-skill");

    expect(state.state).toBe("error-during-setup");

    await service.markSetupCompleteAsync("flip-skill");

    state = await service.getStateAsync("flip-skill");

    expect(state.state).toBe("setuped");
    expect(state.lastError).toBeNull();
  });
});

//#endregion Tests
