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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-skillstate-test-"));
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
      setupFingerprint: null,
      setupAttempts: 0,
      nextSetupAttemptAt: null,
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

  it("sanitizes and bounds persisted setup errors", async () => {
    await skillState.markSkillSetupErrorAsync("noisy-skill", `line one\n${"x".repeat(2500)}`);

    const state = await skillState.getSkillStateAsync("noisy-skill");

    expect(state.lastError).toHaveLength(skillState.MAX_SETUP_ERROR_LENGTH);
    expect(state.lastError).not.toMatch(/\r?\n/);
  });

  it("counts setup starts and applies bounded retry metadata", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await skillState.markSkillSetupInProgressAsync("retry-skill", "fingerprint");
    let state = await skillState.getSkillStateAsync("retry-skill");
    expect(state.setupAttempts).toBe(1);
    expect(state.state).toBe("setup-in-progress");

    await skillState.markSkillSetupErrorAsync("retry-skill", "failed", "fingerprint");
    state = await skillState.getSkillStateAsync("retry-skill");
    expect(state.setupAttempts).toBe(1);
    expect(state.state).toBe("setup-failed");
    expect(state.nextSetupAttemptAt).toBe("2026-01-01T00:01:00.000Z");

    vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z"));
    await skillState.markSkillSetupInProgressAsync("retry-skill", "fingerprint");
    await skillState.markSkillSetupErrorAsync("retry-skill", "failed again", "fingerprint");
    state = await skillState.getSkillStateAsync("retry-skill");
    expect(state.setupAttempts).toBe(2);
    expect(state.nextSetupAttemptAt).toBe("2026-01-01T00:03:01.000Z");

    vi.setSystemTime(new Date("2026-01-01T00:03:02.000Z"));
    await skillState.markSkillSetupInProgressAsync("retry-skill", "fingerprint");
    await skillState.markSkillSetupErrorAsync("retry-skill", "failed at cap", "fingerprint");
    state = await skillState.getSkillStateAsync("retry-skill");
    expect(state.setupAttempts).toBe(skillState.MAX_AUTO_SETUP_ATTEMPTS);
    expect(state.nextSetupAttemptAt).toBeNull();
  });

  it("backs off manual setup after an automatic attempt", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await skillState.markSkillSetupInProgressAsync("manual-retry", "fingerprint");
    await skillState.markSkillNeedsSetupAsync(
      "manual-retry",
      { bins: ["ffmpeg"], anyBins: [], env: [], config: [] },
      ["Install ffmpeg manually"],
      "fingerprint",
    );

    const state = await skillState.getSkillStateAsync("manual-retry");
    expect(state.state).toBe("needs-setup");
    expect(state.setupAttempts).toBe(1);
    expect(state.nextSetupAttemptAt).toBe("2026-01-01T00:01:00.000Z");
  });

  it("preserves legacy state compatibility", async () => {
    const legacyState = {
      state: "setup-failed",
      lastError: "old failure",
      setupAt: null,
      lastCheckedAt: null,
      missingDeps: null,
      manualStepsRequired: [],
      attemptedInstalls: [],
    };
    const filePath = path.join(tempDir, ".blackdogbot", "skills", "legacy", "state.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(legacyState), "utf-8");
    const state = await skillState.getSkillStateAsync("legacy");
    expect(state.setupAttempts).toBe(0);
    expect(state.setupFingerprint).toBeNull();
  });

  it("falls back to defaults for oversized state files", async () => {
    const filePath = path.join(tempDir, ".blackdogbot", "skills", "oversized", "state.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ state: "ready", lastError: "x".repeat(1024 * 1024) }), "utf-8");

    const state = await skillState.getSkillStateAsync("oversized");

    expect(state.state).toBe("never-touched");
    expect(state.lastError).toBeNull();
  });

  it("does not follow symlinked state files", async () => {
    const stateDir = path.join(tempDir, ".blackdogbot", "skills", "symlinked");
    const targetPath = path.join(tempDir, "state-target.txt");
    const statePath = path.join(stateDir, "state.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(targetPath, "sentinel", "utf-8");
    await fs.symlink(targetPath, statePath);

    const state = await skillState.getSkillStateAsync("symlinked");

    expect(state.state).toBe("never-touched");
    await expect(skillState.saveSkillStateAsync("symlinked", state)).rejects.toThrow("not a regular file");
    await expect(fs.readFile(targetPath, "utf-8")).resolves.toBe("sentinel");
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
