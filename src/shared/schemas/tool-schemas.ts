import { z } from "zod";
import { skillStateInfoSchema } from "./skill.schemas.js";
import { MAX_DELEGATE_AGENT_OUTPUT_LENGTH } from "../constants.js";

//#region Variable reference schema (blackboard)

// Single source of truth lives in the variable store. Imported for the unions
// below and re-exported so the per-table write tools can build their
// variable-capable unions from tool-schemas.js (see Phase 1 — Blackboard Core).
import { variableRefSchema, VARIABLE_REF_DESCRIPTION } from "../../utils/variable-store.js";
export { variableRefSchema, VARIABLE_REF_DESCRIPTION };

/**
 * Variable-capable field: the RUNTIME schema is a `literal | variable-reference`
 * union (so the model's JSON schema describes the ref and validation accepts it),
 * while the STATIC input type is narrowed to the resolved `literal` type. The
 * `wrapToolSetWithVariables` wrapper unwraps refs before `execute`, so execute
 * genuinely receives the resolved literal — this decouples ai-sdk's strict
 * schema↔execute input check (Phase 1 — Blackboard Core). Per-branch descriptions
 * are preserved (literal branch + VARIABLE_REF_DESCRIPTION on the ref branch).
 */
function _variableCapable<LITERAL extends z.ZodType>(
  literal: LITERAL,
): z.ZodType<z.infer<LITERAL>, z.ZodTypeDef, z.infer<LITERAL>> {
  return z.union([
    literal,
    variableRefSchema.describe(VARIABLE_REF_DESCRIPTION),
  ]) as unknown as z.ZodType<z.infer<LITERAL>, z.ZodTypeDef, z.infer<LITERAL>>;
}

//#endregion Variable reference schema (blackboard)

//#region Think Tool

export const thinkToolInputSchema = z.object({
  thought: z.string()
    .min(1)
    .describe("Your reasoning or analysis"),
});

export const runCmdToolInputSchema = z.object({
  command: z.string()
    .min(1)
    .describe("Literal shell command to execute. Not a blackboard variable reference; run_cmd cannot access stored variables."),
  cwd: z.string()
    .default("~/.blackdogbot")
    .describe("Working directory"),
  timeout: z.number()
    .int()
    .nonnegative()
    .optional()
    .describe("Wall-clock execution limit in ms, including time between tool calls. Default: foreground 30000, background 600000. Use 0 for no deadline and stop_cmd to clean up interactive processes. Independent of wait_for_cmd.timeoutMs."),
  mode: z.enum(["foreground", "background"])
    .default("foreground")
    .describe("'foreground' waits for output or stdin block; 'background' returns handleId immediately"),
});

export const runCmdToolOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().nullable(),
  status: z.enum(["completed", "awaiting_input", "running", "timed_out", "killed", "failed"])
    .describe("Current command status"),
  handleId: z.string()
    .nullable()
    .describe("Process handle for continuation/status queries (non-null while running or awaiting input, and for background commands)"),
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
  error: z.string()
    .nullable()
    .describe("Error message if status=failed"),
});

export const runCmdInputToolInputSchema = z.object({
  handleId: z.string()
    .min(1)
    .describe("Process handle returned by a previous run_cmd call"),
  input: z.string().optional()
    .describe(String.raw`Text sent as a decoded JSON string, not a shell command. Use this OR controlKey. Ctrl+C is {"input":"\u0003","appendNewline":false}; {"input":"\\u0003"} instead sends printable backslash text.`),
  controlKey: z.enum(["CTRL_C", "CTRL_D", "CTRL_U", "TAB", "ENTER", "ESCAPE", "DELETE"]).optional()
    .describe("Preferred for special keys; use instead of input, no newline added. DELETE is not Ctrl+U."),
  appendNewline: z.boolean()
    .default(true)
    .describe("Append newline for normal answers; false for raw keys, e.g. Ctrl+C"),
  closeStdin: z.boolean()
    .default(false)
    .describe("Send the terminal EOF key (Ctrl+D) after writing; usually false"),
});

export const getCmdStatusToolInputSchema = z.object({
  handleId: z.string()
    .min(1)
    .describe("Process handle to query"),
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

export const stopCmdToolInputSchema = z.object({
  handleId: z.string()
    .min(1)
    .describe("Process handle to stop"),
  signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT"])
    .default("SIGTERM")
    .describe("Signal to send (SIGTERM, SIGKILL, SIGINT)"),
});

export const sendMessageToolInputSchema = z.object({
  message: z.string()
    .min(1)
    .describe("Message to send to the user"),
});

export const sendFileToolInputSchema = z.object({
  filePath: z.string()
    .min(1)
    .describe(
      "Path to the file to send. Relative paths resolve against the workspace directory (~/.blackdogbot/workspace/). " +
      "Only files inside the workspace or uploads directory can be sent.",
    ),
  caption: z.string()
    .max(1024)
    .nullable()
    .optional()
    .describe("Optional caption to display with the file (max 1024 characters)"),
});

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

export const addKnowledgeToolInputSchema = z.object({
  knowledge: _variableCapable(z.string().min(1).describe("Knowledge content to store")),
  collection: z.string()
    .default("default")
    .describe("Target collection"),
  metadata: z.record(z.string(), z.unknown())
    .default({})
    .describe("Additional metadata"),
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

export const listSkillsToolInputSchema = z.object({}).strict();

export const skillSetupIssueSchema = skillStateInfoSchema.pick({
  state: true,
  missingDeps: true,
  lastError: true,
  manualStepsRequired: true,
  nextSetupAttemptAt: true,
}).extend({
  name: z.string(),
  description: z.string(),
}).strict();

export const listSkillsToolOutputSchema = z.object({
  skills: z.array(z.object({ name: z.string(), description: z.string() }).strict()),
  unavailableSkills: z.array(skillSetupIssueSchema),
}).strict();

export const loadSkillToolInputSchema = z.object({
  skillName: z.string().min(1).describe("Name of the skill to load"),
}).strict();

export const loadSkillToolOutputSchema = z.object({
  success: z.boolean(),
  skillName: z.string(),
  instructions: z.string(),
  error: z.string().nullable(),
}).strict();
export const delegateAgentToolInputSchema = z.object({
  task: z.string().min(1).max(100_000).describe("Bounded task for the delegated worker"),
}).strict();

export const delegateAgentToolOutputSchema = z.object({
  success: z.boolean(),
  output: z.string().max(MAX_DELEGATE_AGENT_OUTPUT_LENGTH),
  error: z.string().nullable(),
}).strict();

export const getSkillFileToolInputSchema = z.object({
  skillName: z.string()
    .min(1)
    .describe("Skill name"),
  filePath: z.string()
    .default("SKILL.md")
    .describe("Relative path within the skill directory"),
}).strict();

export const getSkillFileToolOutputSchema = z.object({
  content: z.string(),
  exists: z.boolean(),
}).strict();

//#endregion Skill Tools

//#region Cron Tools

/** Maps deprecated tool names to their replacement(s). */

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
  "inspect_variable",
  "read_image",
  "write_file",
  "append_file",
  "edit_file",
  "list_timed",
  "fetch_rss",
  "searxng", // Legacy task name; dynamically resolved to MCP, never the built-in client.
  // MCP names are checked against discovered tools by cron-tool-validation.
  // Avoid static lists that remain stale after swapping MCP servers.
  "search_timed",
  "list_tables",
  "get_table_schema",
  "create_table",
  "drop_table",
  "read_from_database",
  "delete_from_database",
  "load_skill",
  "list_skills",
  "get_skill_file",
  "delegate_agent",
] as const;

function _validateDate(params: { year: number; month: number; day: number }): boolean {
  const daysInMonth = new Date(params.year, params.month, 0).getDate();
  return params.day >= 1 && params.day <= daysInMonth;
}

const optionalDatetimeFields = {
  year: z.number()
    .int()
    .min(2024)
    .max(2100)
    .optional()
    .describe("Year (e.g., 2026)"),
  month: z.number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe("Month (1-12)"),
  day: z.number()
    .int()
    .min(1)
    .max(31)
    .optional()
    .describe("Day of month (1-31)"),
  hour: z.number()
    .int()
    .min(0)
    .max(23)
    .optional()
    .describe("Hour in 24-hour format (0-23)"),
  minute: z.number()
    .int()
    .min(0)
    .max(59)
    .optional()
    .describe("Minute (0-59)"),
};

const CURRENT_YEAR: number = new Date().getFullYear();

const requiredDatetimeFields = {
  year: z.number()
    .int()
    .min(CURRENT_YEAR)
    .max(2100)
    .describe("Year (current year or later, e.g., " + CURRENT_YEAR + ")"),
  month: z.number()
    .int()
    .min(1)
    .max(12)
    .describe("Month (1-12)"),
  day: z.number()
    .int()
    .min(1)
    .max(31)
    .describe("Day of month (1-31)"),
  hour: z.number()
    .int()
    .min(0)
    .max(23)
    .describe("Hour in 24-hour format (0-23)"),
  minute: z.number()
    .int()
    .min(0)
    .max(59)
    .describe("Minute (0-59)"),
};

export const addOnceToolInputSchema = z
  .object({
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
    ...requiredDatetimeFields,
    notifyUser: z.boolean()
      .describe("Whether to send a Telegram notification when this task completes (required)"),
    messageDedupEnabled: z.boolean()
      .default(true)
      .optional()
      .describe("Whether message deduplication is enabled for this task (default: true)"),
  })
  .refine(
    (data) => _validateDate({ year: data.year, month: data.month, day: data.day }),
    { message: "Invalid day for the given month" }
  );

export const addIntervalToolInputSchema = z.object({
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
  every: z.object({
    hours: z.number()
      .int()
      .min(0)
      .max(24),
    minutes: z.number()
      .int()
      .min(0)
      .max(59),
  }).describe("Interval in hours/minutes (both fields required; at least one non-zero)"),
  offsetFromDayStart: z.object({
    hours: z.number()
      .int()
      .min(0)
      .max(23),
    minutes: z.number()
      .int()
      .min(0)
      .max(59),
  })
    .describe("Offset from day start (midnight) in hours/minutes (both fields required)"),
  timezone: z.string()
    .min(1)
    .optional()
    .describe("IANA timezone for schedule anchoring (e.g., Europe/Prague)"),
  notifyUser: z.boolean()
    .describe("Whether to send a Telegram notification when this task completes (required)"),
  messageDedupEnabled: z.boolean()
    .default(true)
    .optional()
    .describe("Whether message deduplication is enabled for this task (default: true)"),
}).superRefine((data, ctx) => {
  if (data.every.hours === 24 && data.every.minutes !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["every", "minutes"],
      message: "every.minutes must be 0 when every.hours is 24",
    });
  }

  if (data.every.hours === 0 && data.every.minutes === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["every"],
      message: "every must be > 0 (set hours or minutes)",
    });
  }
});

export const editOnceToolInputSchema = z
  .object({
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
      .describe("Updated list of available tool names"),
    ...optionalDatetimeFields,
    notifyUser: z.boolean()
      .optional()
      .describe("Whether to send a Telegram notification"),
    enabled: z.boolean()
      .optional()
      .describe("Whether the task is enabled"),
    messageDedupEnabled: z.boolean()
      .optional()
      .describe("Whether message deduplication is enabled for this task"),
  })
  .refine(
    (data) => {
      const hasAnyDatetime = data.year !== undefined || data.month !== undefined || data.day !== undefined || data.hour !== undefined || data.minute !== undefined;
      if (!hasAnyDatetime) return true;
      const year = data.year ?? new Date().getFullYear();
      const month = data.month ?? 1;
      const day = data.day ?? 1;
      return _validateDate({ year, month, day });
    },
    { message: "Invalid day for the given month" }
  );

export const editIntervalToolInputSchema = z.object({
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
    .describe("Updated list of available tool names"),
  every: z.object({
    hours: z.number()
      .int()
      .min(0)
      .max(24),
    minutes: z.number()
      .int()
      .min(0)
      .max(59),
  })
    .optional()
    .describe("Updated interval in hours/minutes (both fields required when provided)"),
  offsetFromDayStart: z.object({
    hours: z.number()
      .int()
      .min(0)
      .max(23),
    minutes: z.number()
      .int()
      .min(0)
      .max(59),
  })
    .optional()
    .describe("Updated day-start offset in hours/minutes (both fields required when provided)"),
  timezone: z.string()
    .min(1)
    .optional()
    .describe("Updated IANA timezone for schedule anchoring"),
  notifyUser: z.boolean()
    .optional()
    .describe("Whether to send a Telegram notification"),
  enabled: z.boolean()
    .optional()
    .describe("Whether the task is enabled"),
  messageDedupEnabled: z.boolean()
    .optional()
    .describe("Whether message deduplication is enabled for this task"),
}).superRefine((data, ctx) => {
  if (data.every && data.every.hours === 24 && data.every.minutes !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["every", "minutes"],
      message: "every.minutes must be 0 when every.hours is 24",
    });
  }

  if (data.every && data.every.hours === 0 && data.every.minutes === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["every"],
      message: "every must be > 0 (set hours or minutes)",
    });
  }
});

export const editInstructionsToolInputSchema = z.object({
  taskId: z.string()
    .min(1)
    .describe("ID of the scheduled task to update"),
  instructions: z.string()
    .min(1)
    .describe("Complete NEW instructions text for the scheduled task (full replacement)."),
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

export const removeTimedToolInputSchema = z.object({
  taskId: z.string()
    .min(1),
});

export const getCronToolInputSchema = z.object({
  taskId: z.string()
    .min(1)
    .describe("ID of the scheduled task to retrieve"),
});

export const listCronsToolInputSchema = z.object({
  enabledOnly: z.boolean()
    .default(false)
    .describe("Only show enabled tasks"),
});

export const readFileToolInputSchema = z.object({
  filePath: z.string()
    .default("")
    .describe("Path to the file. Use just a filename (e.g. 'notes.txt') for the default workspace directory. Only specify a full absolute path when you need to access files outside the workspace. For most tasks, do NOT specify a path — just use the filename."),
});

export const readImageToolInputSchema = z.object({
  filePath: z.string()
    .default("")
    .describe("Path to an image file. Use just a filename for the default workspace directory. Use an absolute path only for files outside the workspace."),
});

export const writeFileToolInputSchema = z.object({
  filePath: z.string()
    .default("")
    .describe("Path to the file. Use just a filename (e.g. 'notes.txt') for the default workspace directory. Only specify a full absolute path when you need to access files outside the workspace. For most tasks, do NOT specify a path — just use the filename."),
  content: _variableCapable(z.string().describe("Content to write to the file")),
});

export const appendFileToolInputSchema = z.object({
  filePath: z.string()
    .default("")
    .describe("Path to the file. Use just a filename (e.g. 'notes.txt') for the default workspace directory. Only specify a full absolute path when you need to access files outside the workspace. For most tasks, do NOT specify a path — just use the filename."),
  content: z.string()
    .min(1)
    .describe("Content to append to the file"),
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

export const fetchRssToolInputSchema = z.object({
  url: z.string()
    .url()
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

export const EDITABLE_PROMPT_NAMES: readonly string[] = [
  "main-agent",
  "cron-agent",
  "tool-preambles",
  "context-gathering",
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

export const listPromptsToolInputSchema = z.object({});

export const searchTimedToolInputSchema = z.object({
  query: z.string()
    .min(1)
    .trim()
    .describe("The search query"),
  enabledOnly: z.boolean()
    .default(false)
    .describe("Only search enabled tasks"),
  limit: z.number()
    .int()
    .positive()
    .min(1)
    .max(20)
    .default(5)
    .describe("Maximum number of results to return"),
  threshold: z.number()
    .min(0)
    .max(1)
    .default(0.4)
    .describe("Fuzzy match threshold (0-1, lower is stricter)"),
});

const TASK_ID_PLACEHOLDER = "TASK_ID_PLACEHOLDER";

/**
 * Registry of tool prerequisites.
 *
 * Format: { toolName: [ { tool: "prerequisiteTool", args: {...} }, ... ] }
 */
export const TOOL_PREREQUISITES: Record<string, { tool: string; args: Record<string, unknown> }[]> = {
  edit_once: [
    { tool: "get_timed", args: { taskId: TASK_ID_PLACEHOLDER } },
  ],
  edit_interval: [
    { tool: "get_timed", args: { taskId: TASK_ID_PLACEHOLDER } },
  ],
  edit_instructions: [
    { tool: "get_timed", args: { taskId: TASK_ID_PLACEHOLDER } },
  ],
  run_timed: [
    { tool: "get_timed", args: { taskId: TASK_ID_PLACEHOLDER } },
  ],
};
