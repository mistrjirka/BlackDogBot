//#region Skill Types

import type { z } from "zod";
import {
  skillFrontmatterSchema,
  skillInstallStepSchema,
  skillMetadataSchema,
  skillRequirementsSchema,
  skillStateInfoSchema,
  skillStateSchema,
} from "../schemas/skill.schemas.js";

export type SkillState = z.infer<typeof skillStateSchema>;
export type ISkillRequirements = z.infer<typeof skillRequirementsSchema>;
export type ISkillInstallStep = z.infer<typeof skillInstallStepSchema>;
export type ISkillMetadata = z.infer<typeof skillMetadataSchema>;
export type ISkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export interface ISkill {
  name: string;
  frontmatter: ISkillFrontmatter;
  directory: string;
  skillFilePath: string;
  stateScope: string | null;
  state: ISkillStateInfo;
  autoSetupAllowed: boolean;
}


/** Missing dependencies — same shape as requirements */
export type ISkillMissingDeps = ISkillRequirements;

export type ISkillStateInfo = z.infer<typeof skillStateInfoSchema>;

//#endregion Skill Types
