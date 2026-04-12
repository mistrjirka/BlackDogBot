/**
 * Tool descriptions for the scheduled task (cron) agent.
 * Injected into the verifier prompt so the LLM knows what each tool does.
 */
export const CRON_TOOL_DESCRIPTIONS: Record<string, string> = {
  think:
    "Think through a problem step by step before acting. " +
    "Args: thought (string, required).",

  run_cmd:
    "Execute a shell command and return stdout, stderr, and exit code. " +
    "Args: command (string, required); cwd (string, default ~/.blackdogbot); timeout (ms, default 30000).",

  run_cmd_input:
    "Send input to a running command waiting for stdin. " +
    "Args: handleId (string, required); input (string, required); closeStdin (boolean, default true).",

  get_cmd_status:
    "Get the current status of a running command handle. " +
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
    "The tool automatically checks previous cron messages and silently skips sending when the message does not add new information. " +
    "Args: message (string, required).",

  get_previous_message:
    "Get previously sent messages ranked by similarity to your proposed message. " +
    "Returns the top 10 most similar past messages (with timestamps and similarity scores). " +
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
    "Args: enabledOnly (boolean, default false).",

  fetch_rss:
    "Fetch and parse an RSS/Atom feed. Use mode='unseen' to only get items not seen since the last fetch (state persisted per URL). " +
    "Args: url (string, required); maxItems (number, default 20); mode ('latest' | 'unseen', default 'latest').",

  searxng:
    "Search the web using SearXNG. Returns search results formatted as markdown for easy reading. " +
    "Use short specific queries (typically 2-5 words); do not paste full headlines or source domain names. " +
    "Args: query (string, required); categories (string[], optional); maxResults (number, default 10); safesearch (0|1|2, optional); language (string, optional).",

  crawl4ai:
    "Fetch and parse a web page using Crawl4AI. Returns the page content in markdown format. " +
    "Args: url (string, required); selector (string, optional, CSS selector to extract specific content).",

  get_table_schema:
    "Get the schema (columns and types) of a specific table. " +
    "Args: tableName (string, required).",

  create_table:
    "Create a new table. " +
    "Args: tableName (string, required); " +
    "columns (array of {name, type: TEXT|INTEGER|REAL|BLOB, primaryKey?, notNull?}, required).",

  drop_table:
    "Drop (permanently delete) a table. " +
    "Args: tableName (string, required).",

  read_from_database:
    "Read rows from a table with optional filtering, ordering, and column selection. " +
    "Args: tableName (string, required); " +
    "where (string, optional SQL WHERE); orderBy (string, optional); limit (number, optional, default 100); columns (string[], optional).",

  "update_table_<tableName>":
    "Update rows in a specific table using the table-specific tool. " +
    "Args: set (object of column-value pairs, required); where (string, required).",

  delete_from_database:
    "Delete rows from a table. Requires a WHERE clause for safety. " +
    "Args: tableName (string, required); where (string, required).",

  call_skill:
    "Invoke a named skill agent with the given input and return its output. " +
    "Args: skillName (string, required — must be a skill listed as available at runtime); input (string, default '').",

  get_skill_file:
    "Read a file from a skill's directory. " +
    "Args: skillName (string, required); filePath (string, default 'SKILL.md').",
};
