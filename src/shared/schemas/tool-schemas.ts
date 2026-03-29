import { z } from "zod";

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

//#region Run Command Tool

export const runCmdToolInputSchema = z.object({
  command: z.string()
    .min(1)
    .describe("Shell command to execute"),
  cwd: z.string()
    .default("~/.blackdogbot")
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

export const waitForCmdToolInputSchema = z.object({
  handleId: z.string()
    .min(1)
    .describe("Process handle to wait for"),
  timeoutMs: z.number()
    .int()
    .positive()
    .default(120000)
    .describe("Maximum time to wait for command completion in milliseconds"),
  maxBytes: z.number()
    .int()
    .positive()
    .default(65536)
    .describe("Maximum bytes of stdout/stderr to return"),
});

export const waitForCmdToolOutputSchema = z.object({
  handleId: z.string(),
  completed: z.boolean()
    .describe("True when command reached a terminal state before timeoutMs"),
  status: z.enum(["completed", "awaiting_input", "running", "timed_out", "killed", "failed"]),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  timedOut: z.boolean()
    .describe("True if the command itself was killed due to its run_cmd timeout"),
  waitTimedOut: z.boolean()
    .describe("True if wait_for_cmd reached timeoutMs before command completion"),
  error: z.string().nullable(),
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

//#region Cron Tools

/** Maps deprecated tool names to their replacement(s). */
export const CRON_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  query_database: ["read_from_database", "update_database", "delete_from_database"],
};

export const CRON_VALID_TOOL_NAMES = [
  "think",
  "run_cmd",
  "run_cmd_input",
  "get_cmd_status",
  "get_cmd_output",
  "wait_for_cmd",
  "stop_cmd",
  "search_knowledge",
  "add_knowledge",
  "edit_knowledge",
  "send_message",
  "get_previous_message",
  "read_file",
  "read_image",
  "write_file",
  "append_file",
  "edit_file",
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
    .describe("Tool names available to the task agent (required, at least one). send_message performs internal deduplication against previous cron messages."),
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
  tools: z.string()
    .min(1)
    .array()
    .min(1)
    .optional()
    .describe("Updated list of available tool names. send_message performs internal deduplication against previous cron messages."),
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

export const editCronInstructionsToolInputSchema = z.object({
  taskId: z.string()
    .min(1)
    .describe("ID of the cron task to update"),
  instructions: z.string()
    .min(1)
    .describe("Complete NEW instructions text for the cron task (full replacement)."),
  intention: z.string()
    .min(1)
    .describe("Why this instruction update is needed. Metadata only; does not modify instructions by itself."),
  tools: z.string()
    .min(1)
    .array()
    .min(1)
    .optional()
    .describe("Optional replacement tool list to apply together with the instruction update."),
});

export const editCronInstructionsToolOutputSchema = getCronToolOutputSchema;

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
    tools: z.string()
      .array(),
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

export const readImageToolInputSchema = z.object({
  filePath: z.string()
    .default("")
    .describe("Path to an image file. Use just a filename for the default workspace directory. Use an absolute path only for files outside the workspace."),
});

export const readImageToolOutputSchema = z.object({
  success: z.boolean(),
  data: z.string()
    .optional()
    .describe("Base64 image data (without data URL prefix)"),
  mediaType: z.string()
    .optional()
    .describe("Detected media type, for example image/png"),
  bytes: z.number()
    .int()
    .nonnegative()
    .optional()
    .describe("Image file size in bytes"),
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

export const EDITABLE_PROMPT_NAMES: readonly string[] = [
  "main-agent",
  "cron-agent",
  "agent-node-guide",
  "tool-preambles",
  "context-gathering",
  "persistence",
  "skill-setup",
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




