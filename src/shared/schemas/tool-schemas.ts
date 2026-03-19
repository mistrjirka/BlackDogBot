import { z } from "zod";
import { outputSchemaBlueprintSchema } from "./output-schema-blueprint.schema.js";

//#region Think Tool

export const thinkToolInputSchema = z.object({
  thought: z.string()
    .min(1)
    .describe("Your reasoning or analysis"),
});

export const thinkToolOutputSchema = z.object({
  acknowledged: z.boolean(),
});

//#endregion Think Tool

//#region Done Tool

export const doneToolInputSchema = z.object({
  summary: z.string()
    .min(1)
    .describe("Summary of what was accomplished"),
});

export const doneToolOutputSchema = z.object({
  finished: z.boolean(),
});

//#endregion Done Tool

//#region Run Command Tool

export const runCmdToolInputSchema = z.object({
  command: z.string()
    .min(1)
    .describe("Shell command to execute"),
  cwd: z.string()
    .default("~/.betterclaw")
    .describe("Working directory"),
  timeout: z.number()
    .int()
    .positive()
    .default(30000)
    .describe("Timeout in milliseconds"),
  mode: z.enum(["foreground", "background"])
    .default("foreground")
    .describe("'foreground' waits for output or stdin block; 'background' returns handleId immediately"),
  deterministicInputDetection: z.boolean()
    .default(true)
    .describe("When true, run_cmd uses strace to detect stdin waiting deterministically"),
});

export const runCmdToolOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().nullable(),
  status: z.enum(["completed", "awaiting_input", "running", "timed_out", "killed", "failed"])
    .describe("Current command status"),
  handleId: z.string()
    .nullable()
    .describe("Process handle for continuation/status queries (non-null when status=awaiting_input,running,failed-detector,background)"),
  timedOut: z.boolean()
    .default(false)
    .describe("True if the command was killed due to timeout"),
  durationMs: z.number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Duration in milliseconds (null if still running)"),
  signal: z.string()
    .nullable()
    .describe("Signal used to kill process, if any"),
  deterministic: z.boolean()
    .default(false)
    .describe("Whether stdin-wait detection was performed via syscall tracing"),
  error: z.string()
    .nullable()
    .describe("Error message if status=failed"),
});

export const runCmdInputToolInputSchema = z.object({
  handleId: z.string()
    .min(1)
    .describe("Process handle returned by a previous run_cmd call"),
  input: z.string()
    .describe("Text to send to the process's stdin (a trailing newline is appended automatically)"),
  closeStdin: z.boolean()
    .default(true)
    .describe("Whether to close stdin after sending input (triggers process to continue)"),
});

export const runCmdInputToolOutputSchema = z.object({
  success: z.boolean(),
  status: z.enum(["completed", "awaiting_input", "running", "timed_out", "killed", "failed"]),
  stdout: z.string().describe("Any new stdout since the handle was created or last input"),
  stderr: z.string().describe("Any new stderr since the handle was created or last input"),
  exitCode: z.number().nullable(),
  error: z.string().nullable(),
});

export const getCmdStatusToolInputSchema = z.object({
  handleId: z.string()
    .min(1)
    .describe("Process handle to query"),
});

export const getCmdStatusToolOutputSchema = z.object({
  handleId: z.string(),
  status: z.enum(["completed", "awaiting_input", "running", "timed_out", "killed", "failed"]),
  exitCode: z.number().nullable(),
  pid: z.number().nullable(),
  startedAt: z.string().describe("ISO 8601 timestamp"),
  elapsedMs: z.number().int().nonnegative(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  timedOut: z.boolean(),
  signal: z.string().nullable(),
  error: z.string().nullable(),
});

export const getCmdOutputToolInputSchema = z.object({
  handleId: z.string()
    .min(1)
    .describe("Process handle to read output from"),
  channel: z.enum(["stdout", "stderr", "both"])
    .default("both")
    .describe("Which output channel to read"),
  maxBytes: z.number()
    .int()
    .positive()
    .default(65536)
    .describe("Maximum bytes to return"),
});

export const getCmdOutputToolOutputSchema = z.object({
  handleId: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  totalStdoutBytes: z.number().int().nonnegative(),
  totalStderrBytes: z.number().int().nonnegative(),
});

export const stopCmdToolInputSchema = z.object({
  handleId: z.string()
    .min(1)
    .describe("Process handle to stop"),
  signal: z.string()
    .default("SIGTERM")
    .describe("Signal to send (SIGTERM, SIGKILL, SIGINT)"),
});

export const stopCmdToolOutputSchema = z.object({
  success: z.boolean(),
  status: z.enum(["completed", "awaiting_input", "running", "timed_out", "killed", "failed"]),
  exitCode: z.number().nullable(),
  error: z.string().nullable(),
});

//#endregion Run Command Tool

//#region Send Message Tool

export const sendMessageToolInputSchema = z.object({
  message: z.string()
    .min(1)
    .describe("Message to send to the user"),
});

export const sendMessageToolOutputSchema = z.object({
  sent: z.boolean(),
  messageId: z.string()
    .nullable(),
});

//#endregion Send Message Tool

//#region Knowledge Tools

export const searchKnowledgeToolInputSchema = z.object({
  query: z.string()
    .min(1)
    .describe("Search query"),
  collection: z.string()
    .default("default")
    .describe("Collection to search"),
  limit: z.number()
    .int()
    .positive()
    .default(10)
    .describe("Max results"),
});

export const searchKnowledgeToolOutputSchema = z.object({
  results: z.object({
    id: z.string(),
    content: z.string(),
    score: z.number(),
    metadata: z.record(z.string(), z.unknown()),
  })
    .array(),
});

export const addKnowledgeToolInputSchema = z.object({
  knowledge: z.string()
    .min(1)
    .describe("Knowledge content to store"),
  collection: z.string()
    .default("default")
    .describe("Target collection"),
  metadata: z.record(z.string(), z.unknown())
    .default({})
    .describe("Additional metadata"),
});

export const addKnowledgeToolOutputSchema = z.object({
  id: z.string()
    .describe("ID of the stored document"),
  success: z.boolean(),
});

export const editKnowledgeToolInputSchema = z.object({
  id: z.string()
    .min(1)
    .describe("Document ID to edit"),
  collection: z.string()
    .default("default")
    .describe("Collection containing the document"),
  content: z.string()
    .min(1)
    .describe("Updated content"),
  metadata: z.record(z.string(), z.unknown())
    .optional()
    .describe("Updated metadata"),
});

export const editKnowledgeToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

//#endregion Knowledge Tools

//#region Skill Tools

export const callSkillToolInputSchema = z.object({
  skillName: z.string()
    .min(1)
    .describe("Name of the skill to call"),
  input: z.string()
    .default("")
    .describe("Input to pass to the skill"),
});

export const callSkillToolOutputSchema = z.object({
  success: z.boolean(),
  output: z.string(),
  error: z.string()
    .nullable(),
});

export const getSkillFileToolInputSchema = z.object({
  skillName: z.string()
    .min(1)
    .describe("Skill name"),
  filePath: z.string()
    .default("SKILL.md")
    .describe("Relative path within the skill directory"),
});

export const setupSkillToolInputSchema = z.object({
  skillName: z.string()
    .min(1)
    .describe("Name of the skill to set up"),
});

export const setupSkillToolOutputSchema = z.object({
  success: z.boolean(),
  state: z.string(),
  installed: z.array(z.string()),
  manualStepsRequired: z.array(z.string()),
  error: z.string()
    .nullable(),
});

export const getSkillFileToolOutputSchema = z.object({
  content: z.string(),
  exists: z.boolean(),
});

//#endregion Skill Tools

//#region Job Tools

export const addJobToolInputSchema = z.object({
  name: z.string()
    .min(1)
    .describe("Job name"),
  description: z.string()
    .default("")
    .describe("Job description"),
});

export const addJobToolOutputSchema = z.object({
  jobId: z.string(),
  status: z.string(),
});

export const editJobToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  name: z.string()
    .optional()
    .describe("Updated name"),
  description: z.string()
    .optional()
    .describe("Updated description"),
});

export const editJobToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const removeJobToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
});

export const removeJobToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const getJobsToolInputSchema = z.object({
  status: z.enum(["creating", "ready", "running", "completed", "failed"])
    .optional()
    .describe("Filter by status"),
});

export const getJobsToolOutputSchema = z.object({
  jobs: z.object({
    jobId: z.string(),
    name: z.string(),
    description: z.string(),
    status: z.string(),
  })
    .array(),
});

export const runJobToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  input: z.record(z.string(), z.unknown())
    .default({})
    .describe("Input data for the entrypoint node"),
});

export const runJobToolOutputSchema = z.object({
  success: z.boolean(),
  output: z.unknown(),
  error: z.string()
    .nullable(),
  nodesExecuted: z.number(),
  failedNodeId: z.string()
    .nullable()
    .describe("ID of the node that failed, if any"),
  failedNodeName: z.string()
    .nullable()
    .describe("Name of the node that failed, if any"),
});

export const finishJobToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
});

export const finishJobToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  validationErrors: z.string()
    .array(),
});

//#endregion Job Tools

//#region Node Tools

export const editNodeToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  nodeId: z.string()
    .min(1),
  name: z.string()
    .optional(),
  description: z.string()
    .optional(),
  inputSchema: z.record(z.string(), z.unknown())
    .optional(),
  outputSchema: outputSchemaBlueprintSchema
    .optional(),
  config: z.record(z.string(), z.unknown())
    .optional(),
});

export const editNodeToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const removeNodeToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  nodeId: z.string()
    .min(1),
});

export const removeNodeToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const connectNodesToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  fromNodeId: z.string()
    .min(1)
    .describe("Source node ID"),
  toNodeId: z.string()
    .min(1)
    .describe("Target node ID"),
});

export const connectNodesToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  schemaCompatible: z.boolean()
    .describe("Whether the output/input schemas are compatible"),
});

export const setEntrypointToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  nodeId: z.string()
    .min(1),
});

export const setEntrypointToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const addNodeTestToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  nodeId: z.string()
    .min(1),
  name: z.string()
    .min(1)
    .describe("Test case name"),
  inputData: z.record(z.string(), z.unknown())
    .describe("Test input data"),
});

export const addNodeTestToolOutputSchema = z.object({
  testId: z.string(),
  success: z.boolean(),
});

export const runNodeTestToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  nodeId: z.string()
    .min(1),
});

export const runNodeTestToolOutputSchema = z.object({
  results: z.object({
    testId: z.string(),
    name: z.string(),
    passed: z.boolean(),
    error: z.string()
      .nullable(),
    validationErrors: z.string()
      .array(),
    executionTimeMs: z.number(),
  })
    .array(),
  allPassed: z.boolean(),
});

//#endregion Node Tools

//#region Graph Tools

export const getNodesToolInputSchema = z.object({
  jobId: z.string()
    .min(1)
    .describe("Job ID to list nodes for"),
});

export const getNodesToolOutputSchema = z.object({
  jobId: z.string(),
  jobName: z.string(),
  entrypointNodeId: z.string()
    .nullable(),
  nodeCount: z.number(),
  nodes: z.object({
    nodeId: z.string(),
    name: z.string(),
    type: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()),
    connections: z.string().array(),
    config: z.record(z.string(), z.unknown()),
    isEntrypoint: z.boolean(),
  }).array(),
  asciiGraph: z.string()
    .describe("ASCII art DAG visualization of the graph"),
});

export const renderGraphToolInputSchema = z.object({
  jobId: z.string()
    .min(1)
    .describe("Job ID whose graph to render and send as an image"),
});

export const renderGraphToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

//#endregion Graph Tools

//#region Cron Tools

/** Maps deprecated tool names to their replacement(s). */
export const CRON_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  query_database: ["read_from_database", "write_to_database", "update_database", "delete_from_database"],
};

export const CRON_VALID_TOOL_NAMES = [
  "think",
  "run_cmd",
  "search_knowledge",
  "add_knowledge",
  "edit_knowledge",
  "send_message",
  "get_previous_message",
  "read_file",
  "write_file",
  "append_file",
  "edit_file",
  "run_job",
  "get_jobs",
  "list_crons",
  "fetch_rss",
  "searxng",
  "crawl4ai",
  "list_databases",
  "list_tables",
  "get_table_schema",
  "create_database",
  "create_table",
  "drop_table",
  "read_from_database",
  "write_to_database",
  "update_database",
  "delete_from_database",
  "call_skill",
  "get_skill_file",
] as const;

export const addCronToolInputSchema = z.object({
  name: z.string()
    .min(1)
    .describe("Scheduled task name (required)"),
  description: z.string()
    .min(1)
    .trim()
    .describe("Task description (required, non-empty)"),
  instructions: z.string()
    .min(1)
    .trim()
    .describe("Detailed task instructions for the agent (required)"),
  tools: z.string()
    .min(1)
    .array()
    .min(1)
    .describe("Tool names available to the task agent (required, at least one)"),
  scheduleType: z.enum(["once", "interval", "cron"])
    .describe("Schedule type (required): once, interval, or cron"),
  scheduleRunAt: z.string()
    .optional()
    .describe("Required when scheduleType='once'. ISO 8601 datetime, e.g. '2025-06-01T10:00:00Z'"),
  scheduleIntervalMs: z.number()
    .optional()
    .describe("Required when scheduleType='interval'. Interval in milliseconds"),
  scheduleCron: z.string()
    .optional()
    .describe("Required when scheduleType='cron'. Cron expression, e.g. '0 */6 * * *'"),
  notifyUser: z.boolean()
    .describe("Whether to send a Telegram notification when this task completes (required)"),
}).superRefine((data, ctx) => {
  if (data.scheduleType === "once") {
    if (!data.scheduleRunAt || data.scheduleRunAt.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduleRunAt"],
        message: "scheduleRunAt is required when scheduleType is 'once'",
      });
    }
  }

  if (data.scheduleType === "interval") {
    if (data.scheduleIntervalMs === undefined || !Number.isFinite(data.scheduleIntervalMs) || data.scheduleIntervalMs <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduleIntervalMs"],
        message: "scheduleIntervalMs is required and must be > 0 when scheduleType is 'interval'",
      });
    }
  }

  if (data.scheduleType === "cron") {
    if (!data.scheduleCron || data.scheduleCron.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduleCron"],
        message: "scheduleCron is required when scheduleType is 'cron'",
      });
    }
  }
});

export const addCronToolOutputSchema = z.object({
  taskId: z.string(),
  success: z.boolean(),
  error: z.string()
    .optional(),
});

export const removeCronToolInputSchema = z.object({
  taskId: z.string()
    .min(1),
});

export const removeCronToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const getCronToolInputSchema = z.object({
  taskId: z.string()
    .min(1)
    .describe("ID of the cron task to retrieve"),
});

export const getCronToolOutputSchema = z.object({
  success: z.boolean(),
  task: z.any()
    .optional()
    .describe("Full scheduled task configuration"),
  error: z.string()
    .optional(),
});

export const editCronToolInputSchema = z.object({
  taskId: z.string()
    .min(1),
  name: z.string()
    .min(1)
    .optional()
    .describe("Updated task name"),
  description: z.string()
    .optional()
    .describe("Updated description"),
  instructions: z.string()
    .min(1)
    .optional()
    .describe("Updated instructions for the agent. If changed, the instructions will be re-verified."),
  instructionChangeWhat: z.string()
    .min(1)
    .optional()
    .describe("REQUIRED when instructions change. Describe what is being changed and how."),
  instructionChangeWhy: z.string()
    .min(1)
    .optional()
    .describe("REQUIRED when instructions change. Explain why this change is needed."),
  tools: z.string()
    .min(1)
    .array()
    .min(1)
    .optional()
    .describe("Updated list of available tool names"),
  scheduleType: z.enum(["once", "interval", "cron"])
    .optional()
    .describe("Optional schedule type hint. Schedule type is immutable and cannot be changed by edit_cron."),
  scheduleRunAt: z.string()
    .optional()
    .describe("ISO 8601 datetime for 'once' schedule"),
  scheduleIntervalMs: z.number()
    .optional()
    .describe("Interval in milliseconds for 'interval' schedule"),
  scheduleCron: z.string()
    .optional()
    .describe("Cron expression for 'cron' schedule"),
  notifyUser: z.boolean()
    .optional()
    .describe("Whether to send a Telegram notification"),
  enabled: z.boolean()
    .optional()
    .describe("Whether the task is enabled"),
});

export const editCronToolOutputSchema = getCronToolOutputSchema;

export const listCronsToolInputSchema = z.object({
  enabledOnly: z.boolean()
    .default(false)
    .describe("Only show enabled tasks"),
});

export const listCronsToolOutputSchema = z.object({
  tasks: z.object({
    taskId: z.string(),
    name: z.string(),
    description: z.string(),
    schedule: z.object({
      type: z.string(),
      expression: z.string()
        .optional(),
      intervalMs: z.number()
        .optional(),
      runAt: z.string()
        .optional(),
    }),
    enabled: z.boolean(),
    lastRunAt: z.string()
      .nullable(),
    lastRunStatus: z.string()
      .nullable(),
  })
    .array(),
});

export const setJobScheduleToolInputSchema = z.object({
  jobId: z.string()
    .min(1)
    .describe("ID of the job to schedule"),
  schedule: z.object({
    type: z.enum(["once", "interval", "cron"]),
    runAt: z.string()
      .optional(),
    intervalMs: z.number()
      .optional(),
    expression: z.string()
      .optional(),
  })
    .describe("Schedule configuration (same format as add_cron)"),
}).superRefine((data, ctx) => {
  if (data.schedule.type === "once") {
    if (!data.schedule.runAt || data.schedule.runAt.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedule", "runAt"],
        message: "schedule.runAt is required when schedule.type is 'once'",
      });
    }
  }

  if (data.schedule.type === "interval") {
    if (data.schedule.intervalMs === undefined || !Number.isFinite(data.schedule.intervalMs) || data.schedule.intervalMs <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedule", "intervalMs"],
        message: "schedule.intervalMs is required and must be > 0 when schedule.type is 'interval'",
      });
    }
  }

  if (data.schedule.type === "cron") {
    if (!data.schedule.expression || data.schedule.expression.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedule", "expression"],
        message: "schedule.expression is required when schedule.type is 'cron'",
      });
    }
  }
});

export const setJobScheduleToolOutputSchema = z.object({
  success: z.boolean(),
  scheduledTaskId: z.string()
    .describe("ID of the created/updated ScheduledTask"),
  message: z.string(),
});

export const removeJobScheduleToolInputSchema = z.object({
  jobId: z.string()
    .min(1)
    .describe("ID of the job whose schedule to remove"),
});

export const removeJobScheduleToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

//#endregion Cron Tools

//#region File Tools

export const readFileToolInputSchema = z.object({
  filePath: z.string()
    .default("")
    .describe("Path to the file. Use just a filename (e.g. 'notes.txt') for the default workspace directory. Only specify a full absolute path when you need to access files outside the workspace. For most tasks, do NOT specify a path — just use the filename."),
});

export const readFileToolOutputSchema = z.object({
  success: z.boolean(),
  content: z.string()
    .optional(),
  message: z.string(),
});

export const writeFileToolInputSchema = z.object({
  filePath: z.string()
    .default("")
    .describe("Path to the file. Use just a filename (e.g. 'notes.txt') for the default workspace directory. Only specify a full absolute path when you need to access files outside the workspace. For most tasks, do NOT specify a path — just use the filename."),
  content: z.string()
    .describe("Content to write to the file"),
});

export const writeFileToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const appendFileToolInputSchema = z.object({
  filePath: z.string()
    .default("")
    .describe("Path to the file. Use just a filename (e.g. 'notes.txt') for the default workspace directory. Only specify a full absolute path when you need to access files outside the workspace. For most tasks, do NOT specify a path — just use the filename."),
  content: z.string()
    .min(1)
    .describe("Content to append to the file"),
});

export const appendFileToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const editFileToolInputSchema = z.object({
  filePath: z.string()
    .min(1, "filePath is required and cannot be empty")
    .describe("Path to the file. Use just a filename (e.g. 'notes.txt') for the default workspace directory. Only specify a full absolute path when you need to access files outside the workspace. For most tasks, do NOT specify a path — just use the filename."),
  oldString: z.string()
    .min(1)
    .describe("The exact string to find in the file"),
  newString: z.string()
    .describe("The replacement string"),
  replaceAll: z.boolean()
    .default(false)
    .describe("Replace all occurrences (default: first occurrence only)"),
});

export const editFileToolOutputSchema = z.object({
  success: z.boolean(),
  replacements: z.number()
    .optional(),
  message: z.string(),
});

//#endregion File Tools

//#region Fetch RSS Tool

export const fetchRssToolInputSchema = z.object({
  url: z.string()
    .min(1)
    .describe("URL of the RSS or Atom feed to fetch"),
  maxItems: z.number()
    .int()
    .positive()
    .default(20)
    .describe("Maximum number of items to return"),
  mode: z.enum(["latest", "unseen"])
    .default("latest")
    .describe("'latest' returns the most recent items; 'unseen' returns only items not seen before (state persisted per URL)"),
});

export const fetchRssToolOutputSchema = z.object({
  title: z.string()
    .optional(),
  description: z.string()
    .optional(),
  link: z.string()
    .optional(),
  items: z.record(z.string(), z.unknown())
    .array(),
  totalItems: z.number(),
  feedUrl: z.string(),
  mode: z.string(),
  unseenCount: z.number()
    .optional(),
});

//#endregion Fetch RSS Tool

//#region Phase 2 Job Creation Tools

const _commonNodeCreationFields = {
  jobId: z.string()
    .min(1)
    .describe("Job ID to add the node to"),
  parentNodeId: z.string()
    .optional()
    .describe("If set, automatically connects parent node → this new node after creation"),
  name: z.string()
    .min(1)
    .describe("Node name"),
  description: z.string()
    .default("")
    .describe("Node description"),
  outputSchema: outputSchemaBlueprintSchema
    .describe(
      "Strict output blueprint. Use { type: 'object'|'array', fields: [{ name, type }] } where type is one of: string, number, boolean, stringArray, numberArray.",
    ),
};

export const startJobCreationToolInputSchema = z.object({
  name: z.string()
    .min(1)
    .describe("Job name"),
  description: z.string()
    .default("")
    .describe("Job description"),
  startNodeDescription: z.string()
    .default("")
    .describe("Description of what triggers or starts this job"),
});

export const startJobCreationToolOutputSchema = z.object({
  jobId: z.string(),
  startNodeId: z.string(),
  message: z.string(),
});

export const addCurlFetcherNodeToolInputSchema = z.object({
  ..._commonNodeCreationFields,
  url: z.string()
    .min(1)
    .describe("URL to fetch"),
  method: z.string()
    .default("GET")
    .describe("HTTP method"),
  headers: z.record(z.string(), z.string())
    .default({})
    .describe("HTTP headers"),
  body: z.string()
    .nullable()
    .default(null)
    .describe("Request body (null for GET)"),
});

export const addCurlFetcherNodeToolOutputSchema = z.object({
  nodeId: z.string(),
  success: z.boolean(),
  message: z.string(),
});

export const addRssFetcherNodeToolInputSchema = z.object({
  jobId: z.string()
    .min(1)
    .describe("Job ID to add the node to"),
  parentNodeId: z.string()
    .optional()
    .describe("If set, automatically connects parent node → this new node after creation"),
  name: z.string()
    .min(1)
    .describe("Node name"),
  description: z.string()
    .default("")
    .describe("Node description"),
  url: z.string()
    .min(1)
    .describe("RSS feed URL"),
  mode: z.enum(["latest", "unseen"])
    .default("latest")
    .describe("'latest' returns most recent items; 'unseen' returns only new items"),
  maxItems: z.number()
    .int()
    .positive()
    .default(20)
    .describe("Maximum number of feed items to return"),
});

export const addRssFetcherNodeToolOutputSchema = z.object({
  nodeId: z.string(),
  success: z.boolean(),
  message: z.string(),
});

export const addCrawl4aiNodeToolInputSchema = z.object({
  ..._commonNodeCreationFields,
  url: z.string()
    .min(1)
    .describe("URL to crawl"),
  extractionPrompt: z.string()
    .nullable()
    .default(null)
    .describe("Optional LLM extraction prompt for structured data"),
  selector: z.string()
    .nullable()
    .default(null)
    .describe("Optional CSS selector to restrict extraction"),
});

export const addCrawl4aiNodeToolOutputSchema = z.object({
  nodeId: z.string(),
  success: z.boolean(),
  message: z.string(),
});

export const addSearxngNodeToolInputSchema = z.object({
  ..._commonNodeCreationFields,
  query: z.string()
    .min(1)
    .describe("Search query (may contain {{nodeId.outputKey}} templates)"),
  categories: z.string()
    .array()
    .default([])
    .describe("SearXNG search categories (e.g. ['general', 'news'])"),
  maxResults: z.number()
    .int()
    .positive()
    .default(10)
    .describe("Maximum number of search results"),
});

export const addSearxngNodeToolOutputSchema = z.object({
  nodeId: z.string(),
  success: z.boolean(),
  message: z.string(),
});

export const addPythonCodeNodeToolInputSchema = z.object({
  ..._commonNodeCreationFields,
  code: z.string()
    .min(1)
    .describe("Python source code to execute"),
  pythonPath: z.string()
    .default("python3")
    .describe("Path to the Python interpreter"),
  timeout: z.number()
    .int()
    .positive()
    .default(30000)
    .describe("Execution timeout in milliseconds"),
});

export const addPythonCodeNodeToolOutputSchema = z.object({
  nodeId: z.string(),
  success: z.boolean(),
  message: z.string(),
});

export const addOutputToAiNodeToolInputSchema = z.object({
  ..._commonNodeCreationFields,
  prompt: z.string()
    .min(1)
    .describe("Prompt template sent to the AI model (may reference {{nodeId.outputKey}})"),
  model: z.string()
    .nullable()
    .default(null)
    .describe("Model override (null = use default model)"),
});

export const addOutputToAiNodeToolOutputSchema = z.object({
  nodeId: z.string(),
  success: z.boolean(),
  message: z.string(),
});

export const addAgentNodeToolInputSchema = z.object({
  ..._commonNodeCreationFields,
  systemPrompt: z.string()
    .min(1)
    .describe("System prompt for the agent"),
  selectedTools: z.string()
    .array()
    .describe("List of tool names available to the agent"),
  model: z.string()
    .nullable()
    .default(null)
    .describe("Model override (null = use default)"),
  reasoningEffort: z.enum(["low", "medium", "high"])
    .nullable()
    .default(null)
    .describe("Reasoning effort level (null = model default)"),
  maxSteps: z.number()
    .int()
    .positive()
    .default(50)
    .describe("Maximum agent steps"),
});

export const addAgentNodeToolOutputSchema = z.object({
  nodeId: z.string(),
  success: z.boolean(),
  message: z.string(),
});

export const addLitesqlNodeToolInputSchema = z.object({
  ..._commonNodeCreationFields,
  outputSchema: z.record(z.string(), z.unknown())
    .optional()
    .describe("JSON Schema describing what this node produces. Defaults to { insertedCount: number, lastRowId: number } if not provided."),
  databaseName: z.string()
    .min(1)
    .describe("LiteSQL database name"),
  tableName: z.string()
    .min(1)
    .describe("Table name to write to"),
  inputSchemaHint: z.record(z.string(), z.unknown())
    .nullable()
    .default(null)
    .describe(
      "JSON Schema for table input. REQUIRED if the table does not exist yet. " +
      "Get this from create_table output (inputSchema field) or get_table_schema.",
    ),
});

export const addLitesqlNodeToolOutputSchema = z.object({
  nodeId: z.string(),
  success: z.boolean(),
  message: z.string(),
});

export const addLitesqlReaderNodeToolInputSchema = z.object({
  ..._commonNodeCreationFields,
  outputSchema: z.record(z.string(), z.unknown())
    .optional()
    .describe("JSON Schema for output. Auto-derived from table columns if not provided."),
  databaseName: z.string()
    .min(1)
    .describe("LiteSQL database name"),
  tableName: z.string()
    .min(1)
    .describe("Table name to read from"),
  where: z.string()
    .nullable()
    .default(null)
    .describe("SQL WHERE clause (without the WHERE keyword); supports {{key}} template substitution from node input"),
  orderBy: z.string()
    .nullable()
    .default(null)
    .describe("SQL ORDER BY clause (without the ORDER BY keywords), e.g. 'created_at DESC'"),
  limit: z.number()
    .int()
    .positive()
    .nullable()
    .default(null)
    .describe("Maximum number of rows to return"),
});

export const finishJobCreationToolInputSchema = z.object({
  jobId: z.string()
    .min(1),
  skipAudit: z.boolean()
    .default(false)
    .describe("Skip the LLM-based graph audit. Use only for testing or when you're certain the graph is correct."),
});

export const finishJobCreationToolOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  validationErrors: z.string()
    .array(),
  suggestions: z.string()
    .array()
    .optional()
    .describe("Suggestions for improvement from the LLM audit"),
});

//#endregion Phase 2 Job Creation Tools

export const EDITABLE_PROMPT_NAMES: readonly string[] = [
  "main-agent",
  "cron-agent",
  "job-agent",
  "agent-node-guide",
  "job-creation-guide",
  "tool-preambles",
  "context-gathering",
  "persistence",
  "skill-setup",
  "graph-audit",
  "prompt-fragments/output-format",
  "prompt-fragments/xml-tag-guide",
  "prompt-fragments/safety-rules",
] as const;

export const modifyPromptToolInputSchema = z.object({
  promptName: z.string()
    .min(1)
    .describe("Prompt name without .md extension. Use list_prompts to see available names."),
  action: z.enum(["read", "write", "append"])
    .describe("Action to perform"),
  content: z.string()
    .optional()
    .describe("Content for write/append actions"),
});

export const modifyPromptToolOutputSchema = z.object({
  success: z.boolean(),
  content: z.string()
    .optional()
    .describe("File content (returned on read)"),
  message: z.string(),
});

export const listPromptsToolInputSchema = z.object({});

export const listPromptsToolOutputSchema = z.object({
  prompts: z.object({
    name: z.string(),
    path: z.string(),
    isModified: z.boolean(),
  })
    .array(),
});

//#endregion Prompt Tools

//#region Searxng Tool

export const searxngToolInputSchema = z.object({
  query: z.string()
    .min(1)
    .describe("The search query. Supports search syntax like 'site:github.com topic'"),
  categories: z.string()
    .array()
    .optional()
    .describe("Search categories to use (e.g., ['general', 'news', 'images']). Defaults to general."),
  maxResults: z.number()
    .int()
    .positive()
    .default(10)
    .describe("Maximum number of results to return"),
  safesearch: z.number()
    .int()
    .min(0)
    .max(2)
    .optional()
    .describe("Safe search level: 0 (off), 1 (moderate), 2 (strict). Default: 0"),
  language: z.string()
    .optional()
    .describe("Language code for results (e.g., 'en', 'all'). Default: 'all'"),
});

export const searxngToolOutputSchema = z.object({
  results: z.string(),
  error: z.string().optional(),
});

//#endregion Searxng Tool

//#region Crawl4ai Tool

export const crawl4aiToolInputSchema = z.object({
  url: z.string()
    .url()
    .describe("URL of the web page to crawl"),
  selector: z.string()
    .optional()
    .describe("Optional CSS selector to extract specific content"),
});

export const crawl4aiToolOutputSchema = z.object({
  content: z.string(),
  error: z.string().optional(),
});

//#endregion Crawl4ai Tool

// ============================================================================
// Tool Prerequisites Registry
// ============================================================================

const TASK_ID_PLACEHOLDER = "TASK_ID_PLACEHOLDER";

/**
 * Registry of tool prerequisites.
 *
 * Format: { toolName: [ { tool: "prerequisiteTool", args: {...} }, ... ] }
 *
 * Use TASK_ID_PLACEHOLDER in args to indicate the value should be taken from
 * the calling tool's input (e.g., { taskId: TASK_ID_PLACEHOLDER } means
 * use the same taskId that was passed to the calling tool).
 */
export const TOOL_PREREQUISITES: Record<string, { tool: string; args: Record<string, unknown> }[]> = {
  edit_cron: [
    { tool: "get_cron", args: { taskId: TASK_ID_PLACEHOLDER } },
  ],
};
