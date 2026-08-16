import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { SkillLoaderService } from "../../../src/services/skill-loader.service.js";
import { MAX_SKILLS_PER_ROOT } from "../../../src/shared/constants.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";
import * as skillState from "../../../src/helpers/skill-state.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import type { ISkill } from "../../../src/shared/types/index.js";


let tempDir: string;
let originalHome: string;
let originalCwd: string;

async function setupTempHomeAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-skillloader-test-"));
  originalHome = process.env.HOME ?? os.homedir();
  originalCwd = process.cwd();
  process.env.HOME = tempDir;
}

async function cleanupTempHomeAsync(): Promise<void> {
  process.chdir(originalCwd);
  process.env.HOME = originalHome;
  await fs.rm(tempDir, { recursive: true, force: true });
}


async function createSkillOnDiskAsync(dir: string, skillName: string, frontmatter: string, instructions: string): Promise<void> {
  const skillDir: string = path.join(dir, skillName);

  await fs.mkdir(skillDir, { recursive: true });

  const content: string = `---\n${frontmatter}\n---\n\n${instructions}`;

  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");
}


//#region Tests

describe("SkillLoaderService", () => {
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

  it("should load a skill from the default skills directory", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");

    await createSkillOnDiskAsync(skillsDir, "hello-skill", "name: hello-skill\ndescription: Hello world skill", "Say hello.");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    const skill: ISkill | undefined = service.getSkill("hello-skill");

    expect(skill).toBeDefined();
    expect(skill!.name).toBe("hello-skill");
    expect(skill!.frontmatter.description).toBe("Hello world skill");
    await expect(service.loadSkillInstructionsAsync(skill!.name)).resolves.toContain("Say hello.");
  });

  it("should load skills from additional directories", async () => {
    const additionalDir: string = path.join(tempDir, "extra-skills");

    await createSkillOnDiskAsync(additionalDir, "extra-skill", "name: extra-skill\ndescription: Extra", "Extra instructions.");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync([additionalDir]);

    const skill: ISkill | undefined = service.getSkill("extra-skill");

    expect(skill).toBeDefined();
    expect(skill!.name).toBe("extra-skill");
    expect(skill!.autoSetupAllowed).toBe(true);
  });

  it("trusts only managed and explicitly configured roots for auto-setup", async () => {
    const projectDir: string = await fs.mkdtemp(path.join(tempDir, "project-"));
    const projectAgentsDir: string = path.join(projectDir, ".agents", "skills");
    const userAgentsDir: string = path.join(tempDir, ".agents", "skills");
    const managedDir: string = path.join(tempDir, ".blackdogbot", "skills");
    const explicitDir: string = path.join(tempDir, "explicit-skills");
    await createSkillOnDiskAsync(projectAgentsDir, "project-skill", "name: project-skill\ndescription: Project", "Project");
    await createSkillOnDiskAsync(userAgentsDir, "user-skill", "name: user-skill\ndescription: User", "User");
    await createSkillOnDiskAsync(managedDir, "managed-skill", "name: managed-skill\ndescription: Managed", "Managed");
    await createSkillOnDiskAsync(explicitDir, "explicit-skill", "name: explicit-skill\ndescription: Explicit", "Explicit");
    process.chdir(projectDir);
    const service: SkillLoaderService = SkillLoaderService.getInstance();
    await service.loadAllSkillsAsync([explicitDir]);
    expect(service.getSkill("project-skill")?.autoSetupAllowed).toBe(false);
    expect(service.getSkill("user-skill")?.autoSetupAllowed).toBe(false);
    expect(service.getSkill("managed-skill")?.autoSetupAllowed).toBe(true);
    expect(service.getSkill("explicit-skill")?.autoSetupAllowed).toBe(true);
  });

  it("scopes external skill state away from managed skill state", async () => {
    const projectDir: string = await fs.mkdtemp(path.join(tempDir, "state-scope-project-"));
    const projectAgentsDir: string = path.join(projectDir, ".agents", "skills");
    const skillName = "collision-skill";

    await skillState.markSkillSetupCompleteAsync(skillName);
    await createSkillOnDiskAsync(
      projectAgentsDir,
      skillName,
      "name: collision-skill\ndescription: External\nmetadata:\n  openclaw:\n    requires:\n      bins:\n        - blackdogbot-state-scope-bin",
      "External instructions.",
    );
    process.chdir(projectDir);

    const service: SkillLoaderService = SkillLoaderService.getInstance();
    await service.loadAllSkillsAsync();
    const skill = service.getSkill(skillName);

    expect(skill?.state.state).toBe("missing-deps");
    expect(skill?.stateScope).toBe(path.resolve(projectAgentsDir));
  });

  it("rechecks ready skills when setup metadata changes", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");
    const skillName = "ready-metadata-skill";
    const createSkillWithRequirementAsync = async (binName: string): Promise<void> => {
      await createSkillOnDiskAsync(
        skillsDir,
        skillName,
        [
          `name: ${skillName}`,
          "description: Ready metadata",
          "metadata:",
          "  openclaw:",
          "    requires:",
          "      bins:",
          `        - ${binName}`,
          "    install:",
          "      - id: install-test",
          "        kind: node",
          "        package: test-package",
        ].join("\n"),
        "Ready instructions.",
      );
    };

    await createSkillWithRequirementAsync("node");
    const service: SkillLoaderService = SkillLoaderService.getInstance();
    await service.loadAllSkillsAsync();
    const skill = service.getSkill(skillName)!;
    const fingerprint = skillState.getSkillSetupFingerprint(skill);
    await skillState.markSkillSetupCompleteAsync(skillName, fingerprint, skill.stateScope);
    await service.refreshAsync();
    expect(service.getSkill(skillName)?.state.state).toBe("ready");

    await createSkillWithRequirementAsync("blackdogbot-ready-bin-changed");
    await service.refreshAsync();
    expect(service.getSkill(skillName)?.state.state).toBe("needs-setup");
    expect(service.getSkill(skillName)?.state.setupFingerprint).not.toBe(fingerprint);
  });

  it("revalidates ready state stored inside managed skill directories", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");
    const skillName = "forged-ready-skill";
    await createSkillOnDiskAsync(
      skillsDir,
      skillName,
      "name: forged-ready-skill\ndescription: Forged ready\nmetadata:\n  openclaw:\n    requires:\n      bins:\n        - blackdogbot-forged-ready-bin",
      "Forged instructions.",
    );

    const service: SkillLoaderService = SkillLoaderService.getInstance();
    await service.loadAllSkillsAsync();
    const skill = service.getSkill(skillName)!;
    const fingerprint = skillState.getSkillSetupFingerprint(skill);
    await skillState.markSkillSetupCompleteAsync(skillName, fingerprint, skill.stateScope);
    await service.refreshAsync();

    expect(service.getSkill(skillName)?.state.state).toBe("missing-deps");
  });

  it("applies bounded retry backoff and resets it when setup metadata changes", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");
    const skillName = "retry-skill";
    const missingBin = "blackdogbot-test-missing-bin";
    const createRetrySkillAsync = async (binName: string): Promise<void> => {
      await createSkillOnDiskAsync(
        skillsDir,
        skillName,
        [
          `name: ${skillName}`,
          "description: Retry skill",
          "metadata:",
          "  openclaw:",
          "    requires:",
          "      bins:",
          `        - ${binName}`,
          "    install:",
          "      - id: install-test",
          "        kind: node",
          "        package: test-package",
        ].join("\n"),
        "Retry instructions.",
      );
    };

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      await createRetrySkillAsync(missingBin);
      const service: SkillLoaderService = SkillLoaderService.getInstance();
      await service.loadAllSkillsAsync();

      const skill = service.getSkill(skillName);
      expect(skill?.state.state).toBe("needs-setup");
      const fingerprint = skillState.getSkillSetupFingerprint(skill!);

      await skillState.markSkillSetupInProgressAsync(skillName, fingerprint);
      await skillState.markSkillSetupErrorAsync(skillName, "install failed", fingerprint);
      await service.refreshAsync();
      expect(service.getSkill(skillName)?.state.state).toBe("setup-failed");
      expect(service.getSkill(skillName)?.state.setupAttempts).toBe(1);

      vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
      await service.refreshAsync();
      expect(service.getSkill(skillName)?.state.state).toBe("setup-failed");

      vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z"));
      await service.refreshAsync();
      expect(service.getSkill(skillName)?.state.state).toBe("needs-setup");
      expect(service.getSkill(skillName)?.state.setupAttempts).toBe(1);

      await skillState.markSkillSetupInProgressAsync(skillName, fingerprint);
      await skillState.markSkillSetupErrorAsync(skillName, "install failed again", fingerprint);
      vi.setSystemTime(new Date("2026-01-01T00:03:02.000Z"));
      await service.refreshAsync();
      await skillState.markSkillSetupInProgressAsync(skillName, fingerprint);
      await skillState.markSkillSetupErrorAsync(skillName, "install failed finally", fingerprint);
      vi.setSystemTime(new Date("2026-01-01T00:08:00.000Z"));
      await service.refreshAsync();
      expect(service.getSkill(skillName)?.state.state).toBe("setup-failed");
      expect(service.getSkill(skillName)?.state.setupAttempts).toBe(skillState.MAX_AUTO_SETUP_ATTEMPTS);

      await createRetrySkillAsync("blackdogbot-test-new-missing-bin");
      await service.refreshAsync();
      expect(service.getSkill(skillName)?.state.state).toBe("needs-setup");
      expect(service.getSkill(skillName)?.state.setupAttempts).toBe(0);
      expect(service.getSkill(skillName)?.state.setupFingerprint).not.toBe(fingerprint);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns an interrupted setup into one bounded retry", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");
    const skillName = "interrupted-skill";
    await createSkillOnDiskAsync(
      skillsDir,
      skillName,
      "name: interrupted-skill\ndescription: Interrupted\nmetadata:\n  openclaw:\n    requires:\n      bins:\n        - blackdogbot-interrupted-bin\n    install:\n      - id: install-test\n        kind: node\n        package: test-package",
      "Interrupted instructions.",
    );

    const service: SkillLoaderService = SkillLoaderService.getInstance();
    await service.loadAllSkillsAsync();
    const skill = service.getSkill(skillName);
    const fingerprint = skillState.getSkillSetupFingerprint(skill!);
    await skillState.markSkillSetupInProgressAsync(skillName, fingerprint);
    const inProgressState = await skillState.getSkillStateAsync(skillName, skill!.stateScope);
    await skillState.saveSkillStateAsync(
      skillName,
      { ...inProgressState, lastCheckedAt: new Date(0).toISOString() },
      skill!.stateScope,
    );
    await service.refreshAsync();

    expect(service.getSkill(skillName)?.state.state).toBe("needs-setup");
    expect(service.getSkill(skillName)?.state.setupAttempts).toBe(1);
    const persistedState = await skillState.getSkillStateAsync(skillName);
    expect(persistedState.state).toBe("setup-failed");
    await service.refreshAsync();
    expect(service.getSkill(skillName)?.state.state).toBe("needs-setup");
  });

  it("does not mark a live setup claim as interrupted during refresh", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");
    const skillName = "live-setup-skill";
    await createSkillOnDiskAsync(
      skillsDir,
      skillName,
      "name: live-setup-skill\ndescription: Live\nmetadata:\n  openclaw:\n    requires:\n      bins:\n        - blackdogbot-live-bin\n    install:\n      - id: install-test\n        kind: node\n        package: test-package",
      "Live instructions.",
    );

    const service: SkillLoaderService = SkillLoaderService.getInstance();
    await service.loadAllSkillsAsync();
    const skill = service.getSkill(skillName)!;
    const fingerprint = skillState.getSkillSetupFingerprint(skill);
    await skillState.markSkillSetupInProgressAsync(skillName, fingerprint, skill.stateScope);
    await service.refreshAsync();

    expect(service.getSkill(skillName)?.state.state).toBe("setup-in-progress");
  });

  it("keeps manual install steps out of automatic retry candidates", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");
    await createSkillOnDiskAsync(
      skillsDir,
      "manual-skill",
      "name: manual-skill\ndescription: Manual\nmetadata:\n  openclaw:\n    requires:\n      bins:\n        - blackdogbot-manual-bin\n    install:\n      - id: manual-install\n        kind: download\n        label: Install manually",
      "Manual instructions.",
    );

    const service: SkillLoaderService = SkillLoaderService.getInstance();
    await service.loadAllSkillsAsync();
    const skill = service.getSkill("manual-skill");

    expect(skill?.state.state).toBe("needs-setup");
    expect(skill?.state.manualStepsRequired.length).toBeGreaterThan(0);
    expect(skill?.state.setupAttempts).toBe(0);
  });

  it("uses the configured install whitelist when classifying manual steps", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");
    await createSkillOnDiskAsync(
      skillsDir,
      "restricted-install-skill",
      "name: restricted-install-skill\ndescription: Restricted\nmetadata:\n  openclaw:\n    requires:\n      bins:\n        - blackdogbot-restricted-bin\n    install:\n      - id: restricted-install\n        kind: node\n        package: test-package",
      "Restricted instructions.",
    );

    const service: SkillLoaderService = SkillLoaderService.getInstance();
    await service.loadAllSkillsAsync([], false, ["brew"]);

    expect(service.getSkill("restricted-install-skill")?.state.manualStepsRequired.length).toBeGreaterThan(0);
  });

  it("checks declared config requirements against the application config", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");
    await createSkillOnDiskAsync(
      skillsDir,
      "config-requirement-skill",
      "name: config-requirement-skill\ndescription: Config requirement\nmetadata:\n  openclaw:\n    requires:\n      config:\n        - ai.openrouter.apiKey",
      "Config instructions.",
    );

    const service: SkillLoaderService = SkillLoaderService.getInstance();
    await service.loadAllSkillsAsync([], false, ["node"], { ai: { openrouter: { apiKey: "" } } });

    expect(service.getSkill("config-requirement-skill")?.state.state).toBe("missing-deps");
    expect(service.getSkill("config-requirement-skill")?.state.missingDeps?.config).toEqual(["ai.openrouter.apiKey"]);
  });

  it("should prefer managed skills over .agents and configured extra roots", async () => {
    const projectDir: string = await fs.mkdtemp(path.join(tempDir, "project-"));
    const managedDir: string = path.join(tempDir, ".blackdogbot", "skills");
    const projectAgentsDir: string = path.join(projectDir, ".agents", "skills");
    const userAgentsDir: string = path.join(tempDir, ".agents", "skills");
    const extraDir: string = path.join(tempDir, "extra-skills");

    try {
      await createSkillOnDiskAsync(managedDir, "shared-skill", "name: shared-skill\ndescription: Managed", "Managed instructions.");
      await createSkillOnDiskAsync(projectAgentsDir, "project-skill", "name: project-skill\ndescription: Project", "Project instructions.");
      await createSkillOnDiskAsync(userAgentsDir, "user-skill", "name: user-skill\ndescription: User", "User instructions.");
      await createSkillOnDiskAsync(extraDir, "shared-skill", "name: shared-skill\ndescription: Extra", "Extra instructions.");
      await createSkillOnDiskAsync(projectAgentsDir, "agents-shared", "name: agents-shared\ndescription: Project shared", "Project shared instructions.");
      await createSkillOnDiskAsync(userAgentsDir, "agents-shared", "name: agents-shared\ndescription: User shared", "User shared instructions.");
      await createSkillOnDiskAsync(extraDir, "agents-shared", "name: agents-shared\ndescription: Extra shared", "Extra shared instructions.");

      process.chdir(projectDir);
      const service: SkillLoaderService = SkillLoaderService.getInstance();
      await service.loadAllSkillsAsync([extraDir]);

      expect(service.getSkill("shared-skill")?.frontmatter.description).toBe("Managed");
      expect(service.getSkill("project-skill")?.frontmatter.description).toBe("Project");
      expect(service.getSkill("user-skill")?.frontmatter.description).toBe("User");
      expect(service.getSkill("agents-shared")?.frontmatter.description).toBe("Project shared");
    } finally {
      process.chdir(originalCwd);
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it("should refresh added, edited, and deleted skills atomically", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");
    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();
    expect(service.getSkill("dynamic-skill")).toBeUndefined();

    await createSkillOnDiskAsync(skillsDir, "dynamic-skill", "name: dynamic-skill\ndescription: Initial", "Initial instructions.");
    await service.refreshAsync();
    await expect(service.loadSkillInstructionsAsync("dynamic-skill")).resolves.toContain("Initial instructions.");

    await fs.writeFile(
      path.join(skillsDir, "dynamic-skill", "SKILL.md"),
      "---\nname: dynamic-skill\ndescription: Edited\n---\n\nEdited instructions.",
      "utf-8",
    );
    await service.refreshAsync();
    expect(service.getSkill("dynamic-skill")?.frontmatter.description).toBe("Edited");
    await expect(service.loadSkillInstructionsAsync("dynamic-skill")).resolves.toContain("Edited instructions.");

    await fs.rm(path.join(skillsDir, "dynamic-skill"), { recursive: true, force: true });
    await service.refreshAsync();
    expect(service.getSkill("dynamic-skill")).toBeUndefined();
  });


  it("refreshes the catalog when a watched skill file changes", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");
    const skillFilePath: string = path.join(skillsDir, "watched-skill", "SKILL.md");
    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await createSkillOnDiskAsync(skillsDir, "watched-skill", "name: watched-skill\ndescription: Initial", "Initial instructions.");
    await service.loadAllSkillsAsync();
    await service.startWatching();

    try {
      await fs.writeFile(
        skillFilePath,
        "---\nname: watched-skill\ndescription: Watched\n---\n\nWatched instructions.",
        "utf-8",
      );
      await vi.waitFor(() => {
        expect(service.getSkill("watched-skill")?.frontmatter.description).toBe("Watched");
      }, { timeout: 2000, interval: 50 });
    } finally {
      service.stopWatching();
    }
  });

  it("should return all loaded skills via getAllSkills", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");

    await createSkillOnDiskAsync(skillsDir, "skill-a", "name: skill-a\ndescription: A", "A");
    await createSkillOnDiskAsync(skillsDir, "skill-b", "name: skill-b\ndescription: B", "B");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    const all: ISkill[] = service.getAllSkills();

    expect(all).toHaveLength(2);

    const names: string[] = all.map((s: ISkill) => s.name).sort();

    expect(names).toEqual(["skill-a", "skill-b"]);
  });

  it("should return only available skills (setuped + model invocation enabled)", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");

    await createSkillOnDiskAsync(skillsDir, "ready-skill", "name: ready-skill\ndescription: Ready\ndisableModelInvocation: false", "Ready.");
    await createSkillOnDiskAsync(skillsDir, "disabled-skill", "name: disabled-skill\ndescription: Disabled\ndisableModelInvocation: true", "Disabled.");

    await skillState.markSkillSetupCompleteAsync("ready-skill");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    const available: ISkill[] = service.getAvailableSkills();

    expect(available).toHaveLength(1);
    expect(available[0].name).toBe("ready-skill");
  });

  it("should handle missing skills directory gracefully", async () => {
    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await expect(service.loadAllSkillsAsync()).resolves.toBeUndefined();

    const all: ISkill[] = service.getAllSkills();

    expect(all).toHaveLength(0);
  });

  it("bounds the number of skill directories scanned per root", async () => {
    const cappedDir: string = path.join(tempDir, "capped-skills");
    for (let index = 0; index <= MAX_SKILLS_PER_ROOT; index += 1) {
      const skillName = `capped-skill-${String(index).padStart(3, "0")}`;
      await createSkillOnDiskAsync(cappedDir, skillName, `name: ${skillName}\ndescription: Capped`, "Capped.");
    }

    const service: SkillLoaderService = SkillLoaderService.getInstance();
    await service.loadAllSkillsAsync([cappedDir]);

    const loadedCappedSkills = service.getAllSkills().filter((skill) => skill.name.startsWith("capped-skill-"));
    expect(loadedCappedSkills.length).toBeLessThanOrEqual(MAX_SKILLS_PER_ROOT);
  });

  it("should skip directories without SKILL.md", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");

    await fs.mkdir(path.join(skillsDir, "no-skill-file"), { recursive: true });

    await createSkillOnDiskAsync(skillsDir, "valid-skill", "name: valid-skill\ndescription: Valid", "Valid.");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    const all: ISkill[] = service.getAllSkills();

    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("valid-skill");
  });

  it("rejects SKILL.md symlinks that escape the skill directory", async () => {
    if (process.platform === "win32") return;

    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");
    const outsideDir: string = path.join(tempDir, "outside");
    const outsideFile: string = path.join(outsideDir, "SKILL.md");
    const linkedFile: string = path.join(skillsDir, "linked-skill", "SKILL.md");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.mkdir(path.dirname(linkedFile), { recursive: true });
    await fs.writeFile(
      outsideFile,
      "---\nname: linked-skill\ndescription: Linked\n---\n\nOutside instructions.",
      "utf-8",
    );
    await fs.symlink(outsideFile, linkedFile);

    const service: SkillLoaderService = SkillLoaderService.getInstance();
    await service.loadAllSkillsAsync();

    expect(service.getSkill("linked-skill")).toBeUndefined();
  });

  it("should skip skills with invalid frontmatter and continue loading others", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");

    await createSkillOnDiskAsync(skillsDir, "bad-skill", "description: No name here", "Bad.");

    await createSkillOnDiskAsync(skillsDir, "good-skill", "name: good-skill\ndescription: Good", "Good.");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    const all: ISkill[] = service.getAllSkills();

    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("good-skill");
  });

  it("should skip regular files in skills directory (not directories)", async () => {
    const skillsDir: string = path.join(tempDir, ".blackdogbot", "skills");

    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, "not-a-dir.txt"), "hello", "utf-8");

    await createSkillOnDiskAsync(skillsDir, "real-skill", "name: real-skill\ndescription: Real", "Real.");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    const all: ISkill[] = service.getAllSkills();

    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("real-skill");
  });

  it("should return undefined for a non-existent skill via getSkill", async () => {
    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    expect(service.getSkill("does-not-exist")).toBeUndefined();
  });
});

//#endregion Tests
