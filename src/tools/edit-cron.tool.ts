import { tool } from "ai";
import { z } from "zod";
import { editCronToolInputSchema, TOOL_PREREQUISITES } from "../shared/schemas/tool-schemas.js";
import { createToolWithPrerequisites, type ToolExecuteContext } from "../utils/tool-factory.js";
import { SchedulerService } from "../services/scheduler.service.js";
import { LoggerService } from "../services/logger.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { generateObjectWithRetryAsync } from "../utils/llm-retry.js";
import type { IScheduledTask } from "../shared/types/index.js";

//#region Interfaces

interface IEditCronResult {
  success: boolean;
  task?: IScheduledTask;
  error?: string;
}

//#endregion Interfaces

//#region Const

const TOOL_NAME: string = "edit-cron";
const TOOL_DESCRIPTION: string =
  "Modify an existing scheduled task (cron job). " +
  "You can patch any subset of fields. If instructions are changed, they will be re-verified by the LLM. " +
  "IMPORTANT: You MUST call 'get_cron' first to retrieve the current task configuration before using this tool.";

/**
 * Short descriptions for every tool the cron agent can be given.
 */
const CRON_TOOL_DESCRIPTIONS: Record<string, string> = {
  think:
    "Think through a problem step by step before acting. " +
    "Args: thought (string, required).",

  run_cmd:
    "Execute a shell command and return stdout, stderr, and exit code. " +
    "Args: command (string, required); cwd (string, default ~/.betterclaw); timeout (ms, default 30000).",

  search_knowledge:
    "Search the knowledge base for relevant information. Returns documents ranked by relevance. " +
    "Args: query (string, required); collection (string, default 'default'); limit (number, default 10).",

  add_knowledge:
    "Store new knowledge in the knowledge base (embedded and made searchable). " +
    "Args: knowledge (string, required); collection (string, default 'default'); metadata (object, optional).",

  edit_knowledge:
    "Edit an existing knowledge document by ID. Updates content and re-embeds it. " +
    "Args: id (string, required); content (string, required); collection (string, default 'default'); metadata (object, optional).",

  send_message:
    "Send a Telegram message directly to the user who owns this agent. " +
    "No chat ID, token, or destination config is needed — it always reaches the correct user automatically. " +
    "Args: message (string, required).",

  read_file:
    "Read the contents of a file. Default location is the workspace (~/.betterclaw/workspace/). " +
    "For workspace files, pass just the filename (e.g. 'notes.txt'); use a full absolute path only for files outside the workspace. " +
    "Args: filePath (string, default '').",

  write_file:
    "Write content to a file, completely replacing its contents. Must read the file first if it already exists. " +
    "Args: filePath (string, default ''); content (string, required).",

  append_file:
    "Append content to the end of a file; creates the file if it does not exist. Does not require reading first. " +
    "Args: filePath (string, default ''); content (string, required).",

  edit_file:
    "Find-and-replace text inside a file. Does not require reading first. " +
    "Args: filePath (string, default ''); oldString (string, required); newString (string, required); replaceAll (boolean, default false).",

  run_job:
    "Execute a preconfigured job by its ID with optional input data. The job must be in 'ready' status. " +
    "Args: jobId (string, required); input (object, default {}).",

  get_jobs:
    "List all jobs, optionally filtered by status (creating | ready | running | completed | failed). " +
    "Args: status (enum, optional).",

  list_crons:
    "List all scheduled cron tasks managed by the scheduler. " +
    "Args: enabledOnly (boolean, default false).",

  fetch_rss:
    "Fetch and parse an RSS/Atom feed. Use mode='unseen' to only get items not seen since the last fetch (state persisted per URL). " +
    "Args: url (string, required); maxItems (number, default 20); mode ('latest' | 'unseen', default 'latest').",

  searxng:
    "Search the web using SearXNG. Returns search results formatted as markdown for easy reading. " +
    "Args: query (string, required); categories (string[], optional); maxResults (number, default 10); safesearch (0|1|2, optional); language (string, optional).",

  crawl4ai:
    "Fetch and parse a web page using Crawl4AI. Returns the page content in markdown format. " +
    "Args: url (string, required); selector (string, optional, CSS selector to extract specific content).",

  list_databases:
    "List all available SQLite databases in ~/.betterclaw/databases/. " +
    "Args: none.",

  list_tables:
    "List all tables in a specific SQLite database. Use just the database name, not a file path. " +
    "Args: databaseName (string, required).",

  get_table_schema:
    "Get the schema (columns and types) of a specific table. Use just the database name, not a file path. " +
    "Args: databaseName (string, required); tableName (string, required).",

  create_database:
    "Create a new empty SQLite database (stored at ~/.betterclaw/databases/<name>.db). " +
    "Use just the name — never add .db extension (e.g. 'mydb' not 'mydb.db'). The tool manages the file path internally. " +
    "Args: databaseName (string, required).",

  create_table:
    "Create a new table in a database. Use just the database name, not a file path. " +
    "Args: databaseName (string, required); tableName (string, required); " +
    "columns (array of {name, type: TEXT|INTEGER|REAL|BLOB, primaryKey?, notNull?, defaultValue?}, required).",

  drop_table:
    "Drop (permanently delete) a table from a database. Use just the database name, not a file path. " +
    "Args: databaseName (string, required); tableName (string, required).",

  query_database:
    "Run queries or modify a SQLite database using an action-based interface. " +
    "IMPORTANT: The database must already exist. Never use sqlite3 via run_cmd — always use these database tools instead. " +
    "Use just the database name (e.g. 'mydb'), never a file path. " +
    "Actions: " +
    "  - list_databases: list all databases " +
    "  - list_tables: list tables in a database " +
    "  - query_table: SELECT rows (requires where, tableName, databaseName) " +
    "  - show_schema: get table schema " +
    "  - insert: INSERT a row (requires data: {col: value, ...}) " +
    "  - update: UPDATE rows (requires set: {col: value, ...}, where is REQUIRED for safety) " +
    "  - delete: DELETE rows (where is REQUIRED for safety) " +
    "Args: action (required); databaseName; tableName; where; limit; orderBy; columns; data; set.",

  call_skill:
    "Invoke a named skill agent with the given input and return its output. " +
    "Args: skillName (string, required — must be a skill listed as available at runtime); input (string, default '').",

  get_skill_file:
    "Read a file from a skill's directory. " +
    "Args: skillName (string, required); filePath (string, default 'SKILL.md').",
};

//#endregion Const

//#region Tool

const executeEditCron = async (
  {
    taskId,
    ...patch
  }: {
    taskId: string;
    name?: string;
    description?: string;
    instructions?: string;
    tools?: string[];
    schedule?: { type: "once" | "interval" | "cron"; runAt?: string; intervalMs?: number; expression?: string };
    notifyUser?: boolean;
    enabled?: boolean;
  },
  _context: ToolExecuteContext,
): Promise<IEditCronResult> => {
  const logger: LoggerService = LoggerService.getInstance();
  const scheduler: SchedulerService = SchedulerService.getInstance();

  try {
    const existingTask = await scheduler.getTaskAsync(taskId);
    if (!existingTask) {
      return { success: false, error: `Cron task with ID '${taskId}' not found.` };
    }

    // 1. Verify instructions using LLM IF they are being changed
    if (patch.instructions !== undefined) {
      logger.debug(`[${TOOL_NAME}] Re-verifying cron instructions for task: ${taskId}`);

      const toolsToVerify = patch.tools ?? existingTask.tools;
      const toolContextLines: string[] = toolsToVerify.map((t) => {
        const desc: string = CRON_TOOL_DESCRIPTIONS[t] ?? "(no description available)";
        return `  - ${t}: ${desc}`;
      });
      const toolContextBlock: string =
        toolContextLines.length > 0
          ? `The agent will have access to the following tools:\n${toolContextLines.join("\n")}`
          : "The agent will have no tools available.";

      const verifierPrompt = `
You are a task instruction verifier for an autonomous AI agent.
The agent runs periodically on a fixed schedule and has NO memory of past conversations when it wakes up.
The agent executing these instructions is an intelligent AI (an LLM). It can read tool descriptions, reason about conventions, compose arguments, and derive values — it is NOT a dumb script that needs every value pre-computed.

Your job: determine whether the instructions contain enough context for the agent to act independently WITHOUT guessing things that were only ever said in a prior conversation.

DEFAULT TO VALID. Only mark instructions invalid if there is a genuine, unresolvable ambiguity that would cause the agent to fail or act incorrectly.

${toolContextBlock}

RULES:

1. Schedule/timing is already encoded in the cron expression — do NOT require the instructions to re-state when or how often the task runs.

2. Tools that handle routing or delivery implicitly do NOT need extra config in the instructions.
   Example: "send_message" always reaches the correct user — instructions that say "send the results" or "notify the user" are VALID without specifying a chat ID or destination.

3. The agent can derive values from tool descriptions and standard conventions — do NOT flag these as missing:
   - Database file paths derived from a database name (e.g. "rageintel_news" → ~/.betterclaw/databases/rageintel_news.db)
   - Workspace file paths derived from a filename (e.g. "notes.txt" → ~/.betterclaw/workspace/notes.txt)
   - Any argument value that is directly stated in the tool description above

4. Criteria and rules do NOT need to be exhaustively rigid. An LLM agent can interpret general descriptions sensibly.
   Example: "mark items as interesting if the title contains breaking-news keywords" is VALID — the agent can decide what counts as a keyword.
   Example: "find recent news" is VALID if the agent can determine a reasonable time window from context.

5. Instructions ARE invalid if they rely on implicit conversational context the agent cannot know at runtime:
   - References to prior conversation: "fetch that feed", "do what we discussed", "the URL I mentioned"
   - Truly unspecified external resources: an RSS URL, API endpoint, or file path that is not provided AND cannot be derived from tool conventions

6. The "notifyUser" flag controls whether the agent's final text response is automatically forwarded to Telegram.
   - Set notifyUser=true when the user wants the agent's summary or results delivered to Telegram automatically (e.g. news digests, alerts, reports notifyUser=false for).
   - Set background tasks where only explicit send_message tool calls should reach Telegram (e.g. cleanup, archival, internal data processing).
   - The send_message tool ALWAYS sends to Telegram regardless of notifyUser — notifyUser only gates the automatic forwarding of the agent's final text output.

Instructions to verify:
"""
${patch.instructions}
"""

Output a JSON object with:
- "isClear": boolean (true if valid, false if invalid)
- "missingContext": string (if invalid, describe exactly what information is missing and why it cannot be derived; if valid, use empty string)
`;

      const aiService = AiProviderService.getInstance();
      const model = aiService.getModel();

      const verificationResult = await generateObjectWithRetryAsync({
        model,
        schema: z.object({
          isClear: z.boolean(),
          missingContext: z.string(),
        }),
        prompt: verifierPrompt,
      });

      if (!verificationResult.object.isClear) {
        const errorMsg = `EDIT REJECTED. The updated instructions are ambiguous or missing context: ${verificationResult.object.missingContext}. Please provide complete, self-contained instructions.`;
        logger.warn(`[${TOOL_NAME}] Edit rejected: ${errorMsg}`);
        return { success: false, error: errorMsg };
      }
    }

    // 2. Update the task
    const updatedTask = await scheduler.updateTaskAsync(taskId, patch as any);

    return {
      success: true,
      task: updatedTask,
    };
  } catch (error: unknown) {
    const errorMessage: string = error instanceof Error ? error.message : String(error);
    logger.error(`[${TOOL_NAME}] Failed to edit cron task: ${errorMessage}`);

    return { success: false, error: errorMessage };
  }
};

export const editCronTool = tool({
  description: TOOL_DESCRIPTION,
  inputSchema: editCronToolInputSchema,
  execute: createToolWithPrerequisites(
    "edit_cron",
    TOOL_PREREQUISITES["edit_cron"] || [],
    executeEditCron,
  ) as any,
});

//#endregion Tool
