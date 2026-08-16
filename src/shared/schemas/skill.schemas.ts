import { z } from "zod";
import { ALLOWED_INSTALL_KINDS, MAX_AUTO_SETUP_ATTEMPTS, MAX_MANUAL_STEP_INSTRUCTION_LENGTH, MAX_SETUP_ERROR_LENGTH, MAX_SKILL_INSTALL_STEPS } from "../constants.js";

//#region Skill Schemas

export const skillStateSchema = z.enum([
  "never-touched",
  "ready",
  "needs-setup",
  "setup-in-progress",
  "missing-deps",
  "setup-failed",
  "os-unsupported",
]);

const boundedSkillRequirementArraySchema = z.string().max(100).array().max(64).default([]);
const skillOsSchema = z.string().max(32).array().max(8).default([]);
export const skillRequirementsSchema = z.object({
  bins: boundedSkillRequirementArraySchema,
  anyBins: boundedSkillRequirementArraySchema,
  env: boundedSkillRequirementArraySchema,
  config: boundedSkillRequirementArraySchema,
});

export const skillInstallStepSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(ALLOWED_INSTALL_KINDS),
  formula: z.string()
    .max(500)
    .nullable()
    .default(null),
  package: z.string()
    .max(500)
    .nullable()
    .default(null),
  bins: z.string()
    .max(100)
    .array()
    .max(32)
    .default([]),
  label: z.string()
    .max(500)
    .nullable()
    .default(null),
  os: skillOsSchema,
});

export const skillOpenClawMetadataSchema = z.object({
  always: z.boolean()
    .default(false),
  emoji: z.string()
    .nullable()
    .default(null),
  homepage: z.string()
    .nullable()
    .default(null),
  os: skillOsSchema,
  requires: skillRequirementsSchema
    .default({}),
  primaryEnv: z.string()
    .nullable()
    .default(null),
  skillKey: z.string()
    .nullable()
    .default(null),
  install: skillInstallStepSchema
    .array()
    .max(MAX_SKILL_INSTALL_STEPS)
    .default([]),
});

export const skillMetadataSchema = z.object({
  openclaw: skillOpenClawMetadataSchema
    .nullable()
    .default(null),
});

export const skillFrontmatterSchema = z.object({
  name: z.string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "Skill name must be lowercase alphanumeric with hyphens"),
  description: z.string()
    .min(1)
    .max(500),
  homepage: z.string()
    .nullable()
    .default(null),
  userInvocable: z.boolean()
    .default(true),
  disableModelInvocation: z.boolean()
    .default(false),
  commandDispatch: z.string()
    .nullable()
    .default(null),
  commandTool: z.string()
    .nullable()
    .default(null),
  commandArgMode: z.string()
    .nullable()
    .default(null),
  metadata: skillMetadataSchema
    .default({}),
});

export const skillStateInfoSchema = z.object({
  state: skillStateSchema
    .default("never-touched"),
  lastError: z.string()
    .max(MAX_SETUP_ERROR_LENGTH)
    .nullable()
    .default(null),
  setupAt: z.string()
    .nullable()
    .default(null),
  lastCheckedAt: z.string()
    .nullable()
    .default(null),
  missingDeps: skillRequirementsSchema.nullable().default(null),
  manualStepsRequired: z.string()
    .max(MAX_MANUAL_STEP_INSTRUCTION_LENGTH)
    .array()
    .max(32)
    .default([]),
  attemptedInstalls: z.string()
    .max(100)
    .array()
    .max(32)
    .default([]),
  setupFingerprint: z.string().max(128).nullable().default(null),
  setupAttempts: z.number().int().nonnegative().max(MAX_AUTO_SETUP_ATTEMPTS).default(0),
  nextSetupAttemptAt: z.string().datetime({ offset: true }).nullable().default(null),
});

//#endregion Skill Schemas
