import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../../src/services/config.service.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { RateLimiterService } from "../../../src/services/rate-limiter.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { SkillStateService } from "../../../src/services/skill-state.service.js";
import { runSkillSetupAsync, type ISetupResult } from "../../../src/skills/setup-runner.js";
import type { ISkill, ISkillStateInfo } from "../../../src/shared/types/index.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (ConfigService as unknown as { _instance: null })._instance = null;
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
  (RateLimiterService as unknown as { _instance: null })._instance = null;
  (PromptService as unknown as { _instance: null })._instance = null;
  (SkillStateService as unknown as { _instance: null })._instance = null;
}

function createFakeSkill(overrides?: Partial<ISkill>): ISkill {
  return {
    name: "test-setup-skill",
    frontmatter: {
      name: "test-setup-skill",
      description: "A fake skill used for setup-runner e2e testing",
      homepage: null,
      userInvocable: true,
      disableModelInvocation: false,
      commandDispatch: null,
      commandTool: null,
      commandArgMode: null,
      metadata: {
        openclaw: null,
      },
    },
    instructions: "This skill requires no special setup. Just verify you can respond and call done.",
    directory: "/tmp/fake-skill",
    state: {
      state: "never-touched",
      lastError: null,
      setupAt: null,
      lastCheckedAt: null,
    },
    ...overrides,
  };
}

//#endregion Helpers

//#region Tests

describe("Setup Runner E2E", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-setup-runner-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    aiProviderService.initialize(configService.getConfig().ai);

    const promptService: PromptService = PromptService.getInstance();
    await promptService.initializeAsync();
  }, 120000);

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should successfully set up a skill with no requirements and persist setuped state", async () => {
    const skill: ISkill = createFakeSkill();

    const result: ISetupResult = await runSkillSetupAsync(skill);

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(typeof result.summary).toBe("string");

    // Verify state was persisted by SkillStateService
    const stateService: SkillStateService = SkillStateService.getInstance();
    const persistedState: ISkillStateInfo = await stateService.getStateAsync("test-setup-skill");

    expect(persistedState.state).toBe("setuped");
    expect(persistedState.lastError).toBeNull();
    expect(persistedState.setupAt).not.toBeNull();
  }, 120000);

  it("should set up a skill with openclaw requirements metadata and verify binary via run_cmd", async () => {
    const skill: ISkill = createFakeSkill({
      name: "metadata-skill",
      instructions: "Check whether the required binary 'node' is available using run_cmd. Then call done.",
      frontmatter: {
        name: "metadata-skill",
        description: "A skill with openclaw requirements metadata",
        homepage: null,
        userInvocable: true,
        disableModelInvocation: false,
        commandDispatch: null,
        commandTool: null,
        commandArgMode: null,
        metadata: {
          openclaw: {
            always: false,
            emoji: null,
            homepage: null,
            os: ["linux"],
            requires: {
              bins: ["node"],
              anyBins: [],
              env: [],
              config: [],
            },
            primaryEnv: null,
            skillKey: null,
            install: [],
          },
        },
      },
    });

    const result: ISetupResult = await runSkillSetupAsync(skill);

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();

    const stateService: SkillStateService = SkillStateService.getInstance();
    const persistedState: ISkillStateInfo = await stateService.getStateAsync("metadata-skill");
    expect(persistedState.state).toBe("setuped");
    expect(persistedState.setupAt).not.toBeNull();
  }, 120000);
});

//#endregion Tests
