import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import * as skillState from "../../../src/helpers/skill-state.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import type { ISkillStateInfo } from "../../../src/shared/types/index.js";


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



//#region Tests

describe("skill-state", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();
    resetSingletons();

    const logger: LoggerService = LoggerService.getInstance();
    silenceLogger(logger);
  });

  afterEach(async () => {
    resetSingletons();
    vi.restoreAllMocks();
    await cleanupTempHomeAsync();
  });

  it("should return default never-touched state when no state file exists", async () => {
    const state: ISkillStateInfo = await skillState.getSkillStateAsync("nonexistent-skill");

    expect(state.state).toBe("never-touched");
    expect(state.lastError).toBeNull();
    expect(state.setupAt).toBeNull();
    expect(state.lastCheckedAt).toBeNull();
  });

  it("should save and retrieve state roundtrip", async () => {
    const stateToSave: ISkillStateInfo = {
      state: "ready",
      lastError: null,
      setupAt: "2026-01-01T00:00:00.000Z",
      lastCheckedAt: "2026-01-01T00:00:00.000Z",
      missingDeps: null,
      manualStepsRequired: [],
      attemptedInstalls: [],
    };

    await skillState.saveSkillStateAsync("my-skill", stateToSave);

    const retrieved: ISkillStateInfo = await skillState.getSkillStateAsync("my-skill");

    expect(retrieved.state).toBe("ready");
    expect(retrieved.setupAt).toBe("2026-01-01T00:00:00.000Z");
    expect(retrieved.lastError).toBeNull();
  });

  it("should markSkillSetupCompleteAsync and persist the ready state", async () => {
    await skillState.markSkillSetupCompleteAsync("completed-skill");

    const state: ISkillStateInfo = await skillState.getSkillStateAsync("completed-skill");

    expect(state.state).toBe("ready");
    expect(state.lastError).toBeNull();
    expect(state.setupAt).toBeTruthy();
    expect(state.lastCheckedAt).toBeTruthy();
  });

  it("should markSkillSetupErrorAsync and persist the error state", async () => {
    await skillState.markSkillSetupErrorAsync("broken-skill", "Something went wrong");

    const state: ISkillStateInfo = await skillState.getSkillStateAsync("broken-skill");

    expect(state.state).toBe("setup-failed");
    expect(state.lastError).toBe("Something went wrong");
    expect(state.setupAt).toBeNull();
    expect(state.lastCheckedAt).toBeTruthy();
  });

  it("should overwrite previous state when saving new state", async () => {
    await skillState.markSkillSetupErrorAsync("flip-skill", "initial error");

    let state: ISkillStateInfo = await skillState.getSkillStateAsync("flip-skill");

    expect(state.state).toBe("setup-failed");

    await skillState.markSkillSetupCompleteAsync("flip-skill");

    state = await skillState.getSkillStateAsync("flip-skill");

    expect(state.state).toBe("ready");
    expect(state.lastError).toBeNull();
  });
});

//#endregion Tests
