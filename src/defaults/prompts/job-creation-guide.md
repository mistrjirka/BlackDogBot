# Guide: Creating Jobs and Nodes

When creating a job, follow this structured process:

<task>
## Guided workflow (recommended for new jobs)

1. **Plan the job graph** — use `think` to plan all nodes, their types,
   and how they connect before calling any tools.

2. **Start job creation** — call `start_job_creation` with the job name,
   description, and a description of what triggers the job. This creates
   the job and its Start node, sets the Start node as entrypoint, and
   activates job creation mode which unlocks typed node-creation tools.

3. **Set up database tables** — if the pipeline will persist data (via
   `litesql` nodes or agent DB tools), create the necessary tables
   **now**, before adding any pipeline nodes. Use `create_table`, etc.
   Having the table schema defined first ensures that downstream node
   schemas can be designed to match the table columns exactly.

4. **Add nodes** — for each node in the planned graph, call the appropriate
   `add_<type>_node` tool (e.g. `add_curl_fetcher_node`, `add_rss_fetcher_node`,
   `add_output_to_ai_node`). Always specify `parentNodeId` to auto-connect
   the node to its parent. The node's output schema should describe exactly
   what the node produces. For **agent** nodes: set `maxSteps` to at least
   **15**; if the agent has many tools (5+), use at least **50** — when in
   doubt, **50 is the safe default**.

  > **IMPORTANT: Agent nodes require an `outputSchema`.** Before calling
  > `add_agent_node`, you MUST first call `create_output_schema` to generate
  > a strict blueprint, then pass the returned `blueprint` object as the
  > `outputSchema` parameter. The runtime converts this blueprint to JSON
  > Schema internally. The `outputSchema` defines the shape of the agent's final
  > result. Calling `add_agent_node`
  > without `outputSchema` will fail.

5. **Add tests** — for each node **except `start` nodes** (which are passthroughs with no logic), add at least one test with `add_node_test` and run it with `run_node_test` to verify behavior.

6. **Finish** — call `finish_job_creation`. This validates the graph, checks
   all `{{nodeId.outputKey}}` template references, confirms all tests pass,
   marks the job as ready, and exits job creation mode.

## Manual / editing flow (for modifying existing jobs)

To edit an existing job, first call `start_job_creation` with the job's ID to
enter job creation mode, which unlocks the editing tools. Then use:
- `edit_node`, `remove_node`, `connect_nodes`, `disconnect_nodes`,
  `set_entrypoint`, `add_<type>_node`

When done, call `finish_job_creation` to validate and save.

Alternatively, for jobs not in creation mode:
- `edit_job` — update the job name or description
- `add_job` + `finish_job` — create a job via the legacy flow
</task>

<design_principles>
- The job graph is a **DAG (Directed Acyclic Graph)** of data transformation
  nodes. Data flows from the entrypoint through connected nodes, with each
  node's output feeding as input to the next node(s).

- **Deterministic nodes** (`curl_fetcher`, `crawl4ai`, `searxng`, `rss_fetcher`,
  `python_code`) perform fixed operations — fetching data, transforming data,
  running code. They do not reason or make decisions.

- **AI-powered nodes** (`output_to_ai`, `agent`) leverage an LLM to process
  data. Use these when the task requires reasoning, summarization, extraction
  of meaning, or flexible decision-making.

- **Prefer `output_to_ai` or `agent` over `python_code`** when the task is
  about understanding, filtering, or summarizing text data. Modern LLMs handle
  large context windows well — do not pre-filter or pre-process data with
  Python just to reduce the amount of text. Pass the full data to the AI node
  and let it reason about it directly.

- Use `python_code` only for truly **deterministic, mechanical** transformations
  that do not require reasoning — e.g., reformatting dates, computing averages,
  sorting arrays, encoding/decoding, or structured data transformations where
  the exact logic can be written as code.

- > **NEVER use `python_code` to interact with databases.**
  > Database persistence is handled exclusively by the `litesql` node and by
  > `agent` nodes with `write_table_<tableName>` / `read_from_database` tools.
  > Database reads are handled by the `litesql_reader` node or by `agent`
  > nodes with `read_from_database`.
  > Writing Python that opens a `sqlite3` connection, runs INSERT statements,
  > or manages `.db` files is **always wrong** — no exceptions. Use the
  > purpose-built `litesql` node and the `create_table` / `write_table_<tableName>` /
  > `read_from_database` tools instead.

- Every URL, query, and body field in fetcher nodes supports `{{key}}`
  template substitution, where `key` is replaced by the matching property
  from the node's input data.
</design_principles>

<graph_topology>
## How to structure the node graph

The job graph is a **data pipeline** — each node takes the output of the
previous node as input and passes its output to the next. Think of it as
an assembly line where data flows through stages.

### The pipeline pattern (default — use this most of the time)

The most common pattern is a **sequential chain**. When adding nodes,
set each node's `parentNodeId` to the **node you just created**, NOT
the Start node. Each node receives the output of the node before it.

**Example: "Fetch RSS news, filter with AI, store in database"**
```
start_job_creation           → startNodeId "s1"
add_rss_fetcher_node(parentNodeId = "s1")    → nodeId "n1"
add_output_to_ai_node(parentNodeId = "n1")   → nodeId "n2"
add_litesql_node(parentNodeId = "n2")        → nodeId "n3"
```
Result: `Start → RSS Fetcher → AI Filter → Database`

Data flows: Start outputs trigger input → RSS fetches feed items → AI
filters/summarizes the feed items → DB stores the AI's output.

**Example: "Search the web, crawl top results, summarize findings"**
```
start_job_creation           → startNodeId "s1"
add_searxng_node(parentNodeId = "s1")        → nodeId "n1"
add_crawl4ai_node(parentNodeId = "n1")       → nodeId "n2"
add_output_to_ai_node(parentNodeId = "n2")   → nodeId "n3"
```
Result: `Start → Search → Crawl Pages → Summarize`

**Example: "Monitor RSS feed, analyze each article with AI agent"**
```
start_job_creation           → startNodeId "s1"
add_rss_fetcher_node(parentNodeId = "s1")    → nodeId "n1"
add_agent_node(parentNodeId = "n1")          → nodeId "n2"
```
Result: `Start → RSS Fetcher → Agent`

### CRITICAL anti-pattern: star topology (DO NOT DO THIS)

**WRONG** — connecting all nodes to the Start node:
```
Start → RSS Fetcher
Start → AI Filter      ← BROKEN: AI receives Start's input, NOT the RSS data!
Start → Database        ← BROKEN: DB receives Start's input, NOT the AI output!
```
This breaks data flow entirely. The AI filter never sees the RSS data
because it receives the Start node's raw trigger input instead of the
RSS fetcher's output. Each node must chain to the node whose output it
needs, NOT back to Start.

### Fan-out pattern (parallel independent branches)

Connect multiple nodes to the **same parent** only when they perform
independent work on the same data:
```
Start → RSS Fetcher → AI Summarizer    (branch 1: summarize)
                    → LiteSQL           (branch 2: store raw feed)
```
Both the AI summarizer and the DB receive the RSS fetcher's output
independently. Use this when two downstream nodes need the same input
but do different things with it.

### Rule of thumb

Ask yourself: "Does node B need the output of node A to do its work?"
If yes, then A must be B's parent (`parentNodeId = A's nodeId`).

Build the chain by always setting `parentNodeId` to the node whose
output the new node needs as input. In the vast majority of cases,
this means chaining each new node to the previously created node.
</graph_topology>

<storage_patterns>
## How to persist data — use litesql or agent DB tools, never Python

> **NEVER write Python code that opens a SQLite connection.**
> Any `python_code` node containing `import sqlite3`, `conn.execute(...)`, or
> similar is always wrong. Use the `litesql` node and the `create_table` /
> `write_table_<tableName>` / `read_from_database` tools.

### When to use litesql / litesql_reader vs agent with DB tools

| Situation | Use |
|---|---|
| Every input record should be inserted as-is, no logic needed | `litesql` node |
| Simple deterministic read (e.g. last N hours, all rows) | `litesql_reader` node |
| Need to read from the DB before deciding what to write | `agent` node with `read_from_database` + `write_table_<tableName>` |
| Need to update or delete existing rows conditionally | `agent` node with `update_table_<tableName>` / `delete_from_database` (+ explicit WHERE) |
| Need conditional writes (e.g. skip duplicates, filter by rule) | `agent` node with DB tools |
| Need to query data for summaries / reports | `agent` node with `read_from_database` |
| Simple end-of-pipeline persistence (insert and done) | `litesql` node |

**`litesql` is insert-only** — it takes every record the upstream node produces
and inserts it directly into the table. It has no query support and no
conditional logic. Use it only when the upstream node (e.g. `output_to_ai`)
has already done all filtering/transforming, and you just need to persist the result.

**`litesql_reader` is read-only** — it fetches rows from a table with optional
WHERE/ORDER BY/LIMIT and outputs them for downstream nodes. Use it when the
query is simple and deterministic (no AI reasoning needed to decide what to read).

**`agent` with DB tools** is for any situation where the node must reason about
the database — reading existing rows, checking before writing, building summaries,
or doing conditional inserts.

### Database tools: job creation vs pipeline nodes

During **job creation** (before `finish_job_creation`), the main agent can call
these tools directly to set up the schema:
- `create_table` — creates a table (also creates the database if needed)
- `get_table_schema` — inspects a table's columns

At **pipeline runtime**, `agent` nodes can use these tools via `selectedTools`:
- `write_table_<tableName>` — inserts rows using the table-specific validated tool
- `read_from_database` — queries rows
- `update_table_<tableName>` — updates existing rows (requires WHERE)
- `delete_from_database` — deletes rows (requires WHERE)
- `create_table` — creates a table if needed
- `get_table_schema` — introspection

### Step-by-step: adding a litesql node to a pipeline

**Before adding the node, set up the schema (tool calls, not pipeline nodes):**

1. **If the table doesn't exist, call `create_table`** — specify the table name
   and columns. Tables are created in the default internal database. Do this
   **before** calling `add_litesql_node`. Example columns:
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `title TEXT NOT NULL`
   - `link TEXT`
   - `summary TEXT`
   - `is_interesting INTEGER`
   - `stored_at TEXT`

**Then add the node:**

4. **Call `add_litesql_node`** with:
   - `databaseName`: `blackdog` (default internal database)
   - `tableName`: same table name

5. **Make the upstream node's output schema field names match the table column
   names exactly.** The `litesql` node inserts by using the input JSON's keys
   as column names — there is no separate query field or mapping config. If the
   upstream node outputs `{ "headline": "..." }` but the table has a `title`
   column, the insert will fail. Field names must match.

> **CRITICAL: When an agent node sits before a litesql node**, the agent's
> `outputSchema` must include **all** fields that the litesql table requires —
> including any pass-through fields from earlier nodes (e.g., `item_id`,
> `pubDate`, `title`, `link`). The agent completely replaces upstream data;
> fields not in the agent's output are lost. If the table needs fields from
> both the RSS fetcher and the agent's analysis, the agent must output both
> sets of fields. Alternatively, give the agent table-specific `write_table_<tableName>` tools in its
> `selectedTools` and let it handle storage itself (preferred for complex
> pipelines).
>
> If the agent handles DB writes directly via `write_table_<tableName>`, the
> downstream `litesql` node is typically unnecessary for that branch.
>
> Also ensure type alignment: if a table column is TEXT, the corresponding
> output schema field must be `string`, not `stringArray`. Arrays must be
> serialized to JSON strings before storage.

### Agent nodes that need database access

If an `agent` node must read from or write to a database (e.g. an agent that
checks existing records before deciding what to store), add these tools to its
`selectedTools`:
- `write_table_<tableName>` — inserts rows using the table-specific validated tool
- `read_from_database` — queries rows
- `update_table_<tableName>` / `delete_from_database` — optional for modifying existing rows (always with WHERE)
- `create_table` — creates a table if needed
- `get_table_schema` — introspection

The agent calls these tools itself at runtime; you do not need a `litesql` node
when the agent handles storage directly.

### Concrete example: "Fetch RSS, filter interesting items with agent, store to DB"

**Task:** every 6 AM / 8 PM fetch a feed, use an agent to decide which items
are interesting, store the interesting ones to SQLite.

**Step 1 — create the table first (tool call, not a pipeline node):**
```
create_table(
  table    = "interesting_items",
  columns  = [
    "id INTEGER PRIMARY KEY AUTOINCREMENT",
    "title TEXT NOT NULL",
    "link TEXT",
    "summary TEXT",
    "stored_at TEXT"
  ]
)
```
Note: `create_table` does not support `defaultValue`. Define only `name`,
`type`, `primaryKey`, and `notNull`. Auto-timestamp fields (`created_at`,
`updated_at`, `timestamp`, `created`, `updated`) are auto-filled by
`write_table_<tableName>` and are not required. Date-like fields may use
the literal `'now'` (converted to the current ISO timestamp).

**Step 2 — build the pipeline:**
```
start_job_creation                                          → startNodeId "s1"
add_rss_fetcher_node(parentNodeId = "s1", mode = "unseen") → nodeId "n1"
add_agent_node(                                             → nodeId "n2"
  parentNodeId  = "n1",
  selectedTools = ["write_table_interesting_items", "read_from_database",
                   "create_table", "get_table_schema"],
  systemPrompt  = "You receive RSS feed items. For each item, decide if it is
                   interesting. Store interesting items using write_table_interesting_items
                   (table=interesting_items). Include title,
                   link, summary, and stored_at (ISO timestamp)."
)
```

Or, if the filtering is stateless (no DB reads needed during filtering), use
`output_to_ai` to filter and `litesql` to store. In this case the `output_to_ai`
node's output schema **must use the same field names as the table columns**:

```
create_table("interesting_items", [...])                     ← tool call first
add_rss_fetcher_node(parentNodeId = "s1", mode = "unseen")  → nodeId "n1"
add_output_to_ai_node(                                       → nodeId "n2"
  parentNodeId  = "n1",
  outputSchema  = {
    type: "array",                  ← field names must match table columns!
    fields: [
      { name: "title", type: "string" },
      { name: "link", type: "string" },
      { name: "summary", type: "string" },
      { name: "stored_at", type: "string" }
    ]
  }
)
add_litesql_node(parentNodeId = "n2",                        → nodeId "n3"
  databaseName = "blackdog", tableName = "interesting_items")
```

### WRONG pattern — never do this

```python
# WRONG: python_code node with sqlite3
add_python_code_node(parentNodeId = "n2",
  code = "import sqlite3; conn = sqlite3.connect('news.db'); ...")
```

Python nodes cannot reliably manage database files, handle concurrency, or
integrate with the rest of the system's database tooling.
</storage_patterns>

<node_types>

## curl_fetcher
Fetches a URL using HTTP and returns the response. Supports all HTTP methods,
custom headers, and request bodies. URL and body support `{{key}}` template
substitution from the node's input.

**Config (`ICurlFetcherConfig`):**
| Property | Type | Description |
|---|---|---|
| `url` | `string` | Target URL; supports `{{key}}` substitution |
| `method` | `string` | HTTP method (default: `GET`) |
| `headers` | `Record<string, string>` | Request headers |
| `body` | `string \| null` | Request body; supports `{{key}}` substitution |

**Output:**
```json
{
  "statusCode": 200,
  "headers": { "content-type": "application/json" },
  "body": { ... }
}
```
The `body` is parsed as JSON if possible, otherwise returned as a raw string.

---

## crawl4ai
Crawls a web page using the Crawl4AI service and returns markdown and HTML.
Optionally extracts structured data via an AI-powered extraction prompt.

**Config (`ICrawl4AiConfig`):**
| Property | Type | Description |
|---|---|---|
| `url` | `string` | URL to crawl; supports `{{key}}` substitution |
| `extractionPrompt` | `string \| null` | If set, the crawled markdown is passed through an LLM with this prompt to extract structured data |
| `selector` | `string \| null` | Optional CSS selector to narrow what content is crawled |

**Output:**
```json
{
  "url": "https://example.com",
  "success": true,
  "markdown": "# Page Title\n...",
  "html": "<html>...</html>",
  "extracted": { ... }
}
```
The `extracted` field is only present if `extractionPrompt` was set.

---

## searxng
Performs a web search using the SearXNG search engine and returns results.

**Config (`ISearxngConfig`):**
| Property | Type | Description |
|---|---|---|
| `query` | `string` | Search query; supports `{{key}}` substitution |
| `categories` | `string[]` | SearXNG categories (e.g., `["general", "news"]`); empty = no filter |
| `maxResults` | `number` | Maximum results to return (default: `10`) |

**Output:**
```json
{
  "query": "search terms",
  "results": [ ... ],
  "totalResults": 42
}
```

---

## rss_fetcher
Fetches and parses an RSS or Atom feed. Supports two modes: `latest` returns
the newest N items, and `unseen` tracks which items have been seen before
and only returns new ones (stateful across executions).

**Config (`IRssFetcherConfig`):**
| Property | Type | Description |
|---|---|---|
| `url` | `string` | RSS/Atom feed URL; supports `{{key}}` substitution |
| `maxItems` | `number` | Maximum items to return (default: `20`) |
| `mode` | `"latest" \| "unseen"` | `latest` = newest N items; `unseen` = only items not previously seen (persistent state) |

**Output:**
```json
{
  "title": "Feed Title",
  "description": "Feed description",
  "link": "https://example.com",
  "items": [ { "title": "...", "link": "...", "description": "...", ... } ],
  "totalItems": 50,
  "feedUrl": "https://example.com/feed.xml",
  "mode": "unseen",
  "unseenCount": 3
}
```
The `unseenCount` field is only present in `unseen` mode.

**When to use:** Monitoring RSS feeds for new content. Use `unseen` mode for
scheduled/periodic jobs that should only process new articles.

---

## python_code
Executes Python code. The node's input is available as the `input_data`
variable (a Python dict parsed from JSON). The script must print valid JSON
to stdout as its output.

**Config (`IPythonCodeConfig`):**
| Property | Type | Description |
|---|---|---|
| `code` | `string` | Python source code to execute |
| `pythonPath` | `string` | Path to Python binary (default: `python3`) |
| `timeout` | `number` | Execution timeout in milliseconds |

**Important:** The boilerplate `import sys, json, os, base64` and `input_data`
deserialization are automatically prepended — do not include them in your code.
Just use `input_data` directly and `print(json.dumps(result))` at the end.

**When to use:** Only for deterministic, mechanical data transformations that
do not require reasoning. Prefer `output_to_ai` or `agent` for anything that
involves understanding text content.

---

## output_to_ai
Sends the node's input data to an LLM with a prompt and returns structured
JSON. This is a **single-pass** AI call with no tools — the LLM receives the
prompt, the input data, and the expected output schema, and must return JSON
matching that schema.

**Config (`IOutputToAiConfig`):**
| Property | Type | Description |
|---|---|---|
| `prompt` | `string` | The instruction prompt. The input data and output schema are appended automatically. |
| `model` | `string \| null` | AI model identifier; `null` uses system default |

**When to use:** When you need an LLM to analyze, summarize, filter, classify,
or extract information from data — without needing tools. This is the simplest
and most efficient AI node. Modern LLMs handle large context well, so pass
all the data and let the model reason about it.

---

## agent
A full agentic LLM node with its own system prompt and access to a subset
of tools. The agent runs in a loop: it receives instructions, calls tools,
reasons, and eventually returns its final result as text.

**Config (`IAgentNodeConfig`):**
| Property | Type | Description |
|---|---|---|
| `systemPrompt` | `string` | The agent's system prompt / instructions |
| `selectedTools` | `string[]` | Names of tools to make available (see agent-node-guide for the full list). `think` is always injected automatically. |
| `model` | `string \| null` | AI model identifier; `null` uses system default |
| `reasoningEffort` | `"low" \| "medium" \| "high" \| null` | Reasoning effort level |
| `maxSteps` | `number` | Maximum agentic loop iterations (recommended: **50**) |

> **Note:** `think` is always injected automatically — do NOT include it in `selectedTools`.

**Output schema (required):** The `outputSchema` defines the JSON format of
the agent's final result — i.e., what the agent returns as its final result. For
typed node-creation tools, `outputSchema` must be a strict blueprint in this
shape: `{ type: "object"|"array", fields: [{ name, type }] }` where
`type` is one of `string | number | boolean | stringArray | numberArray`.
Use `create_output_schema` to generate this blueprint and pass `blueprint`
to `add_agent_node`.

**When to use:** When the task requires multi-step reasoning, tool use
(searching knowledge, running commands, reading/writing files), or complex
decision-making that cannot be done in a single LLM pass.

---

## litesql
An **insert-only output node** that inserts data into a SQLite database table.
The node receives JSON input from the previous node and inserts it as a row
(or rows) into the specified table. It performs **no queries, no conditional
logic, and no reads** — every record it receives is inserted directly. Use it
only when the upstream node has already done all filtering and transforming.
This is typically used at the **end of a pipeline** to persist data.

> **If you need to read from the database, check for duplicates, or apply
> conditional logic before writing — use an `agent` node with `selectedTools`
> including table-specific `write_table_<tableName>` tools and `read_from_database` instead.**

**Important:** Before using this node, you MUST:
1. If the table doesn't exist, use `create_table` to create it
2. Use `get_table_schema` to understand the table's column structure

**Config (`ILiteSqlConfig`):**
| Property | Type | Description |
|---|---|---|
| `databaseName` | `string` | Database name; use `blackdog` to target the default internal database. Supports `{{key}}` substitution |
| `tableName` | `string` | Target table name; supports `{{key}}` substitution |

**Input:** The node expects JSON matching the table's columns. For example,
if the table has columns `id`, `name`, `email`, the input should be:
```json
{ "id": 1, "name": "John", "email": "john@example.com" }
```

**Output:**
```json
{
  "insertedCount": 1,
  "lastRowId": 5
}
```

**Error handling:**
- If the database doesn't exist: Lists available databases
- If the table doesn't exist: Lists available tables in the database
- If schema doesn't match: Shows actual table columns and what was provided
- If primary key duplicate: Error with suggestion to fix

**When to use:** At the end of a pipeline to persist transformed data to table storage.

---

## litesql_reader
A **read-only data-source node** that fetches rows from a SQLite database table.
It queries the specified table with optional WHERE, ORDER BY, and LIMIT clauses
and outputs the result as `{ rows: [...], totalCount: number }`. Use it to feed
previously stored data back into a pipeline — for example, fetching records from
the last N hours for further processing.

> The output schema is **automatically derived** from the table's columns when
> you call `add_litesql_reader_node`. The tool response includes the
> `derivedOutputSchema` so you can see exactly what shape the output will have.

**Important:** Before using this node, the table MUST already exist. Use
`get_table_schema` to verify.

**Config (`ILiteSqlReaderConfig`):**
| Property | Type | Description |
|---|---|---|
| `databaseName` | `string` | Database name (use `blackdog` for compatibility with table tools) |
| `tableName` | `string` | Target table name |
| `where` | `string \| null` | SQL WHERE clause (without the keyword `WHERE`); supports `{{key}}` template substitution from input |
| `orderBy` | `string \| null` | SQL ORDER BY clause (without the keyword `ORDER BY`), e.g. `"created_at DESC"` |
| `limit` | `number \| null` | Maximum number of rows to return |

**Template substitution:** The `where` clause supports `{{key}}` placeholders
that are replaced at runtime with values from the node's input. For example,
`where: "created_at > datetime('now', '-{{hours}} hours')"` with input
`{ "hours": "24" }` becomes `WHERE created_at > datetime('now', '-24 hours')`.

**Input:** Any JSON object. Properties are used only for `{{key}}` template
substitution in the `where` clause. If the node has no upstream input or
no templates, the input is ignored.

**Output:**
```json
{
  "rows": [
    { "id": 1, "title": "...", "created_at": "2025-01-01" },
    { "id": 2, "title": "...", "created_at": "2025-01-02" }
  ],
  "totalCount": 2
}
```

**When to use:** At the start or middle of a pipeline when you need to read
previously stored data from a SQLite database for further processing,
filtering, or output. Prefer this over an `agent` node with
`read_from_database` when the query is simple and deterministic.

</node_types>

<schema_rules>
- Runtime node schemas are JSON Schema format.
- For typed node-creation tools, `outputSchema` input is a strict blueprint and is converted to JSON Schema internally.
- Connected nodes must have compatible schemas at their junction.
- Use descriptive property names and include descriptions.
- Keep schemas as simple as possible while capturing required structure.
</schema_rules>

<editing_after_creation>
Jobs and nodes are fully editable after creation. Do not recreate from
scratch if a small fix will do — use the appropriate edit tool instead.

To edit nodes, you must be in job creation mode (call `start_job_creation`
with the job's ID first). Available editing tools:
- `edit_node` — update a node's name, description, input schema, output
  schema, or config (code, URL, system prompt, maxSteps, etc.)
- `remove_node` — remove a node from the job
- `connect_nodes` — add a connection between two nodes
- `disconnect_nodes` — remove a connection between two nodes
- `set_entrypoint` — change which node starts execution
- `add_<type>_node` — add a new typed node to the job
- `finish_job_creation` — validate graph, run tests, mark job as ready,
  and exit job creation mode

Always-on (no job creation mode needed):
- `edit_job` — update the job name or description
- `finish_job` — mark a legacy job as ready

When to use edit tools:
- A node test fails → use `edit_node` to fix the config, code, or schema
- The output schema doesn't match downstream expectations → `edit_node`
- A new requirement means adding a step → `add_<type>_node` + `connect_nodes`
- Wrong connection → `disconnect_nodes` + `connect_nodes`
- Wrong entrypoint set → `set_entrypoint`
</editing_after_creation>

<job_scheduling>
## Scheduling jobs to run automatically

After creating a job, you can attach a schedule so it runs automatically:

1. **Set a schedule** — call `set_job_schedule` with the `jobId` and a `schedule`
   object. This creates a ScheduledTask that will run the job automatically.
   The schedule object format:
   - `{ type: "interval", every: { hours: 1, minutes: 0 }, offsetFromDayStart: { hours: 0, minutes: 0 }, timezone: "Europe/Prague" }` — every hour
   - `{ type: "once", runAt: "2026-03-01T00:00:00Z" }` — one-time
   - `{ type: "interval", every: { hours: 24, minutes: 0 }, offsetFromDayStart: { hours: 0, minutes: 0 }, timezone: "Europe/Prague" }` — daily (24-hour interval)

2. **Update a schedule** — call `set_job_schedule` again with a new schedule.
   The old ScheduledTask is automatically removed and replaced.

3. **Remove a schedule** — call `remove_job_schedule` with the `jobId` to
   stop automatic execution. The job can still be run manually with `run_job`.

**Example workflow:**
```
start_job_creation(name="Daily RSS Digest", ...)
add_rss_fetcher_node(...)
add_output_to_ai_node(...)
finish_job_creation(jobId)
set_job_schedule(jobId, { type: "interval", every: { hours: 24, minutes: 0 }, offsetFromDayStart: { hours: 0, minutes: 0 }, timezone: "Europe/Prague" })
```

**Note:** `set_job_schedule` is preferred for job scheduling because it
links the schedule to the job's start node, making it easy to update or
remove later. Use `add_interval` or `add_once` only for general-purpose
scheduled tasks that are not tied to a specific job.

**Important:** Each job can have only one schedule at a time. Calling
`set_job_schedule` replaces any existing schedule for that job. If the user
needs different schedules (e.g., every 30 minutes AND every 12 hours), create
SEPARATE jobs — one for each schedule.
</job_scheduling>
