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
