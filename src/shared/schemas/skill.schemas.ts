import { z } from "zod";

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

export const skillRequirementsSchema = z.object({
  bins: z.string()
    .array()
    .default([]),
  anyBins: z.string()
    .array()
    .default([]),
  env: z.string()
    .array()
    .default([]),
  config: z.string()
    .array()
    .default([]),
});

export const skillInstallStepSchema = z.object({
  id: z.string(),
  kind: z.enum(["brew", "node", "go", "uv", "download", "apt", "pacman"]),
  formula: z.string()
    .nullable()
    .default(null),
  package: z.string()
    .nullable()
    .default(null),
  bins: z.string()
    .array()
    .default([]),
  label: z.string()
    .nullable()
    .default(null),
  os: z.string()
    .array()
    .default([]),
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
  os: z.string()
    .array()
    .default([]),
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
    .min(1),
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
    .nullable()
    .default(null),
  setupAt: z.string()
    .nullable()
    .default(null),
  lastCheckedAt: z.string()
    .nullable()
    .default(null),
  missingDeps: z.object({
    bins: z.string().array().default([]),
    anyBins: z.string().array().default([]),
    env: z.string().array().default([]),
    config: z.string().array().default([]),
  }).nullable().default(null),
  manualStepsRequired: z.string()
    .array()
    .default([]),
  attemptedInstalls: z.string()
    .array()
    .default([]),
});

//#endregion Skill Schemas
