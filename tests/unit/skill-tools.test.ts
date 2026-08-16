import { describe, expect, it, vi } from "vitest";
import type { ISkill } from "../../src/shared/types/index.js";
import { loadSkillTool, type ILoadSkillResult } from "../../src/tools/load-skill.tool.js";
import { listSkillsTool, type IListSkillsResult } from "../../src/tools/list-skills.tool.js";
import { SkillLoaderService } from "../../src/services/skill-loader.service.js";

function isLoadSkillResult(value: ILoadSkillResult | AsyncIterable<ILoadSkillResult> | undefined): value is ILoadSkillResult {
  return typeof value === "object" && value !== null && "success" in value;
}

function isListSkillsResult(value: IListSkillsResult | AsyncIterable<IListSkillsResult> | undefined): value is IListSkillsResult {
  return typeof value === "object" && value !== null && "skills" in value;
}

function makeSkill(state: ISkill["state"]["state"], disabled: boolean): ISkill {
  return {
    name: "fixture",
    directory: "/tmp/fixture",
    skillFilePath: "/tmp/fixture/SKILL.md",
    stateScope: null,
    state: { state, lastError: null, setupAt: null, lastCheckedAt: null, missingDeps: null, manualStepsRequired: [], attemptedInstalls: [], setupFingerprint: null, setupAttempts: 0, nextSetupAttemptAt: null },
    frontmatter: {
      name: "fixture", description: "fixture", homepage: null, userInvocable: false,
      disableModelInvocation: disabled, commandDispatch: null, commandTool: null, commandArgMode: null,
      metadata: { openclaw: null },
    },
    autoSetupAllowed: true,
  };
}

describe("skill instruction tool", () => {
  it("returns instructions only for a ready model-visible skill", async () => {
    const loader = SkillLoaderService.getInstance();
    const skill: ISkill = makeSkill("ready", false);
    const loadInstructions = vi.spyOn(loader, "loadSkillInstructionsAsync").mockResolvedValue("fixture instructions");
    const executable = loadSkillTool;
    const result = await executable.execute?.({ skillName: skill.name }, { toolCallId: "test", messages: [] });
    expect(isLoadSkillResult(result)).toBe(true);
    if (isLoadSkillResult(result)) {
      expect(result.success).toBe(true);
      expect(result.instructions).toBe("fixture instructions");
    }
    loadInstructions.mockRestore();
  });

  it("rejects unknown, disabled, and unready skills", async () => {
    const loader = SkillLoaderService.getInstance();
    const refresh = vi.spyOn(loader, "refreshAsync").mockResolvedValue();
    const loadInstructions = vi.spyOn(loader, "loadSkillInstructionsAsync").mockResolvedValue(undefined);
    const getSkill = vi.spyOn(loader, "getSkill");
    const executable = loadSkillTool;
    const toolContext = { toolCallId: "test", messages: [] };

    getSkill.mockReturnValue(undefined);
    const unknownResult = await executable.execute?.({ skillName: "unknown" }, toolContext);
    expect(isLoadSkillResult(unknownResult) && unknownResult.error).toContain("unknown, disabled, or not ready");

    getSkill.mockReturnValue(makeSkill("ready", true));
    const disabledResult = await executable.execute?.({ skillName: "fixture" }, toolContext);
    expect(isLoadSkillResult(disabledResult) && disabledResult.error).toContain("disabled");

    getSkill.mockReturnValue(makeSkill("needs-setup", false));
    const unreadyResult = await executable.execute?.({ skillName: "fixture" }, toolContext);
    expect(isLoadSkillResult(unreadyResult) && unreadyResult.error).toContain("state=needs-setup");

    refresh.mockRestore();
    getSkill.mockRestore();
    loadInstructions.mockRestore();
  });

  it("reports persisted setup failure and retry timing", async () => {
    const loader = SkillLoaderService.getInstance();
    const skill: ISkill = makeSkill("setup-failed", false);
    skill.state.lastError = "installer failed";
    skill.state.nextSetupAttemptAt = "2026-01-01T00:01:00.000Z";
    const refresh = vi.spyOn(loader, "refreshAsync").mockResolvedValue();
    const getSkill = vi.spyOn(loader, "getSkill").mockReturnValue(skill);
    const loadInstructions = vi.spyOn(loader, "loadSkillInstructionsAsync").mockResolvedValue(undefined);

    const result = await loadSkillTool.execute?.({ skillName: skill.name }, { toolCallId: "test", messages: [] });

    expect(isLoadSkillResult(result) && !result.success).toBe(true);
    if (isLoadSkillResult(result)) {
      expect(result.error).toContain("state=setup-failed");
      expect(result.error).toContain("lastError=installer failed");
      expect(result.error).toContain("retryAt=2026-01-01T00:01:00.000Z");
    }
    refresh.mockRestore();
    getSkill.mockRestore();
    loadInstructions.mockRestore();
  });


  it("lists the current eligible skills after refreshing the catalog", async () => {
    const loader = SkillLoaderService.getInstance();
    const skill: ISkill = makeSkill("ready", false);
    const refresh = vi.spyOn(loader, "refreshAsync").mockResolvedValue();
    const getAvailableSkills = vi.spyOn(loader, "getAvailableSkills").mockReturnValue([skill]);
    const getAllSkills = vi.spyOn(loader, "getAllSkills").mockReturnValue([]);

    const result = await listSkillsTool.execute?.({}, { toolCallId: "test", messages: [] });

    expect(isListSkillsResult(result)).toBe(true);
    if (isListSkillsResult(result)) {
      expect(result.skills).toEqual([{ name: "fixture", description: "fixture" }]);
      expect(result.unavailableSkills).toEqual([]);
    }
    expect(refresh).toHaveBeenCalledOnce();
    expect(getAvailableSkills).toHaveBeenCalledOnce();
    expect(getAllSkills).toHaveBeenCalledOnce();
  });

  it("reports unavailable skills in the catalog", async () => {
    const loader = SkillLoaderService.getInstance();
    const blocked: ISkill = makeSkill("setup-failed", false);
    blocked.name = "blocked";
    blocked.frontmatter.description = "Blocked skill";
    blocked.state.lastError = "installer failed";
    blocked.state.nextSetupAttemptAt = "2026-01-01T00:01:00.000Z";
    const refresh = vi.spyOn(loader, "refreshAsync").mockResolvedValue();
    const getAvailableSkills = vi.spyOn(loader, "getAvailableSkills").mockReturnValue([]);
    const getAllSkills = vi.spyOn(loader, "getAllSkills").mockReturnValue([blocked]);

    const result = await listSkillsTool.execute?.({}, { toolCallId: "test", messages: [] });

    expect(isListSkillsResult(result)).toBe(true);
    if (isListSkillsResult(result)) {
      expect(result.unavailableSkills).toEqual([{
        name: "blocked",
        description: "Blocked skill",
        state: "setup-failed",
        missingDeps: null,
        lastError: "installer failed",
        nextSetupAttemptAt: "2026-01-01T00:01:00.000Z",
        manualStepsRequired: [],
      }]);
    }
    refresh.mockRestore();
    getAvailableSkills.mockRestore();
    getAllSkills.mockRestore();
  });
});
