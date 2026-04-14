/**
 * Tool descriptions for the scheduled task (cron) agent.
 * Injected into the verifier prompt so the LLM knows what each tool does.
 */
export const CRON_TOOL_DESCRIPTIONS: Record<string, string> = {
  think:
    "Think through a problem step by step before acting. This is a meta reasoning tool that does not perform actions or call other tools. " +
    "Args: thought (string, required — your reasoning process). " +
    "No validation beyond required argument; no error conditions possible.",

  run_cmd:
    "Execute a shell command and return a structured result object. " +
    "Modes: foreground waits for terminal status (or awaiting_input); background returns immediately with status=running and handleId for follow-up tools. " +
    "Output fields include: status, stdout, stderr, exitCode, handleId, timedOut, durationMs, signal, deterministic, error. stdout/stderr are separate channels and both matter for diagnostics. " +
    "Status values: running (process active), awaiting_input (process waiting for stdin), completed (finished normally), timed_out (exceeded timeout), killed (received termination signal), failed (non-zero exit code). " +
    "handleId is present when status is running or awaiting_input; null when status is terminal (completed, timed_out, killed, failed). " +
    "Background mode lifecycle: returns handle immediately; use get_cmd_status/wait_for_cmd to monitor; process continues running until completion, timeout, or explicit stop via stop_cmd. " +
    "Args: command (string, required); cwd (string, default ~/.blackdogbot); timeout (ms, default 30000); mode (foreground|background, default foreground); deterministicInputDetection (boolean, default true).",

  run_cmd_input:
    "Send input to a running command waiting for stdin. " +
    "Args: handleId (string, required); input (string, required); closeStdin (boolean, default true).",

  get_cmd_status:
    "Get the current status of a command handle. " +
    "Status values: running (process active), awaiting_input (process waiting for stdin), completed (finished normally), timed_out (exceeded timeout), killed (received termination signal), failed (non-zero exit code). " +
    "handleId is present when status is running or awaiting_input; null when status is terminal (completed, timed_out, killed, failed). " +
    "Args: handleId (string, required).",

  get_cmd_output:
    "Get stdout/stderr output from a running command handle. " +
    "Args: handleId (string, required); channel (stdout|stderr|both, default both); maxBytes (number, default 65536).",

  wait_for_cmd:
    "Wait for a command handle to reach terminal status (or awaiting_input) and return status plus output. " +
    "Args: handleId (string, required); timeoutMs (number, default 120000); maxBytes (number, default 65536).",

  stop_cmd:
    "Stop a running command handle with a signal. " +
    "Args: handleId (string, required); signal (SIGTERM|SIGKILL|SIGINT, default SIGTERM).",

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
    "For scheduled tasks, two checks run before sending: " +
    "(1) Dispatch policy decides whether sending is appropriate: required deliverables (alerts, reports, summaries requested in task instructions) may send; operational chatter (progress/debug not requested for delivery) typically does not. " +
    "(2) Novelty comparison runs only after dispatch allows it; it compares the candidate message with previously sent messages from the same task using LLM judgment to decide if it is new enough. " +
    "If novelty check rejects the message, send_message returns sent=false with suppressedReason='novelty' and no Telegram message is sent. " +
    "Novelty scope is same-task stored message history (no fixed time window, limited by stored history). " +
    "To disable novelty suppression for periodic deliverables, set messageDedupEnabled=false on the task (not a tool parameter — this is a task-level setting). Dispatch policy still applies regardless. " +
    "Args: message (string, required).",

  get_previous_message:
    "Get previously sent messages ranked by similarity to your proposed message. " +
    "Returns the top 10 most similar past messages (with timestamps and similarity scores). " +
    "Search scope is vector-store history and has no fixed time window; it is limited by stored history and top-10 ranking. " +
    "Args: message (string, required — the message you plan to send).",

  read_file:
    "Read the contents of a file. Default location is the workspace (~/.blackdogbot/workspace/). " +
    "For workspace files, pass just the filename (e.g. 'notes.txt'); use a full absolute path only for files outside the workspace. " +
    "Args: filePath (string, default '').",

  read_image:
    "Read an image file and provide it to the model as media content (for vision-capable models). " +
    "Supports png/jpg/jpeg/gif/webp/bmp/svg up to 10MB. " +
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

  list_timed:
    "List all scheduled tasks managed by the scheduler. " +
    "Returns task summaries with: taskId (unique identifier), name, description, tools (array of tool name strings used by this task), schedule (cron expression or interval), enabled (boolean — true means task runs on its schedule, false means it is paused and will not run), lastRunAt (ISO timestamp or null), lastRunStatus (string: 'success', 'failure', or null for never-run), and messageDedupEnabled (boolean). " +
    "enabledOnly filter: when true, returns only tasks where enabled=true; when false, returns all tasks regardless of enabled state. " +
    "Args: enabledOnly (boolean, default false).",

  fetch_rss:
    "Fetch and parse an RSS/Atom feed. Use mode='unseen' to only get items not seen since the last fetch (state persisted per URL for 'unseen' mode tracking). " +
    "State is scoped to the URL and persists across runs; it is maintained in stable storage and survives process restarts. " +
    "Args: url (string, required); maxItems (number, default 20); mode ('latest' | 'unseen', default 'latest').",

  searxng:
    "Search the web using SearXNG. Returns search results formatted as markdown for easy reading. " +
    "Use short specific queries (typically 2-5 words); do not paste full headlines or source domain names. " +
    "Args: query (string, required); categories (string[], optional); maxResults (number, default 10); safesearch (0|1|2, optional); language (string, optional).",

  crawl4ai:
    "Fetch and parse a web page using Crawl4AI. Returns the page content in markdown format. " +
    "Args: url (string, required); selector (string, optional, CSS selector to extract specific content).",

  list_tables:
    "List all tables in the internal default database (read-only). " +
    "Returns: tables (string[]), and optional error when database is not initialized. " +
    "Args: none.",

  get_table_schema:
    "Get the schema (columns and types) of a specific table. " +
    "This is a read-only operation and does not modify data. " +
    "Args: tableName (string, required).",

  create_table:
    "Create a new table. This is a mutation operation that modifies database state. " +
    "If the table already exists, creation fails and returns an error (it does not replace the table). " +
    "Args: tableName (string, required); " +
    "columns (array of {name, type: TEXT|INTEGER|REAL|BLOB, primaryKey?, notNull?}, required).",

  drop_table:
    "Drop (permanently delete) a table and all of its rows. This is irreversible and cannot be undone. " +
    "Args: tableName (string, required).",

  read_from_database:
    "Read rows from a table with optional filtering, ordering, and column selection. " +
    "This is a read-only operation and does not modify data. " +
    "Args: tableName (string, required); " +
    "where (string, optional SQL WHERE predicates only; ORDER BY and LIMIT belong in orderBy/limit args, not in where); " +
    "orderBy (string, optional ORDER BY only); limit (number, optional, default 20 or BLACKDOGBOT_READ_DB_DEFAULT_LIMIT, max 50); offset (number, optional, default 0); columns (string[], optional). " +
    "Returns matchingTotal, returnedCount, remainingCount, nextOffset, and continuationHint for pagination.",

  "update_table_<tableName>":
    "Update rows in a specific table using the table-specific tool. " +
    "This is a naming pattern, not a literal tool name. Use actual tool names such as update_table_users or update_table_news_items. " +
    "This operation permanently modifies existing rows. " +
    "Args: set (object of column-value pairs, required); where (string, required).",

  delete_from_database:
    "Delete rows from a table. Requires a WHERE clause for safety. " +
    "This operation permanently deletes matching rows. " +
    "Args: tableName (string, required); where (string, required).",

  call_skill:
    "Invoke a named skill agent with the given input and return its output. " +
    "Args: skillName (string, required — must be a skill listed as available at runtime); input (string, default '').",

  get_skill_file:
    "Read a file from a skill's directory. " +
    "Args: skillName (string, required); filePath (string, default 'SKILL.md').",

  search_timed:
    "Search timed/scheduled tasks using fuzzy matching. Searches across task names, descriptions, instructions, task IDs, and tools. " +
    "Results are ranked by fuzzy match score (best matches first, based on weighted field matching). " +
    "Threshold: controls match strictness — lower values (closer to 0) require stricter matches; higher values (closer to 1) allow looser matches. Default 0.4 is a balanced setting. " +
    "limit: minimum 1, maximum 20. " +
    "Args: query (string, required — free-text search term to find matching tasks); enabledOnly (boolean, default false); limit (number, default 5, min 1, max 20); threshold (number, default 0.4, range 0.0 to 1.0).",
};
