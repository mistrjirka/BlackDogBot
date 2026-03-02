//#region Skill Types

export type SkillState = 
  | "never-touched"
  | "ready"
  | "needs-setup"
  | "setup-in-progress"
  | "missing-deps"
  | "setup-failed"
  | "os-unsupported";

export interface ISkillRequirements {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
}

export interface ISkillInstallStep {
  id: string;
  kind: "brew" | "node" | "go" | "uv" | "download" | "apt" | "pacman";
  formula: string | null;
  package: string | null;
  bins: string[];
  label: string | null;
  os: string[];
}

export interface ISkillMetadata {
  openclaw: {
    always: boolean;
    emoji: string | null;
    homepage: string | null;
    os: string[];
    requires: ISkillRequirements;
    primaryEnv: string | null;
    skillKey: string | null;
    install: ISkillInstallStep[];
  } | null;
}

export interface ISkillFrontmatter {
  name: string;
  description: string;
  homepage: string | null;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  commandDispatch: string | null;
  commandTool: string | null;
  commandArgMode: string | null;
  metadata: ISkillMetadata;
}

export interface ISkill {
  name: string;
  frontmatter: ISkillFrontmatter;
  instructions: string;
  directory: string;
  state: ISkillStateInfo;
}

export interface ISkillMissingDeps {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
}

export interface ISkillStateInfo {
  state: SkillState;
  lastError: string | null;
  setupAt: string | null;
  lastCheckedAt: string | null;
  missingDeps: ISkillMissingDeps | null;
  manualStepsRequired: string[];
  attemptedInstalls: string[];
}

//#endregion Skill Types
