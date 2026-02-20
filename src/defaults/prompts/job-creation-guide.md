# Guide: Creating Jobs and Nodes

When creating a job, follow this structured process:

<task>
1. **Plan the job graph** — think through what nodes are needed,
   their types, and how they connect. Use the think tool to plan
   the full graph before calling any creation tools.

2. **Create the job** — use add_job to create the job with a clear
   name and description. The job starts in "creating" status.

3. **Define nodes** — for each node in the graph:
   - Choose the appropriate node type (see `<node_types>` below).
   - Define the input JSON Schema (what data the node receives).
   - Define the output JSON Schema (what data the node produces).
   - Configure node-specific settings (code, URL, agent prompt, etc.).
   - For **agent** nodes: set `maxSteps` to at least **15**. If the agent
     has many tools (5+), set it to at least **50**. When in doubt, **50
     is a safe and recommended default** — it is better to allow more
     steps than to have the agent stop before completing its task.

4. **Connect nodes** — use connect_node_to_node to wire the graph.
   IMPORTANT: The output schema of node A must be compatible with
   the input schema of node B when connecting A -> B.

5. **Set entrypoint** — designate which node starts the execution.

6. **Add tests** — create at least one test per node with valid
   input data. Run node tests to verify behavior.

7. **Finish the job** — use finish_job to mark it as ready.
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

- Use `output_to_ai` for **single-pass LLM processing**: give it data and a
  prompt, get structured JSON back. No tools, no multi-step reasoning.

- Use `agent` for **multi-step, tool-using tasks**: when the node needs to
  search the knowledge base, run commands, read/write files, send messages,
  or make multiple decisions.

- The `manual` node is a pass-through — it does nothing to the data. Use it
  as an entrypoint to accept external input into the graph.

- Every URL, query, and body field in fetcher nodes supports `{{key}}`
  template substitution, where `key` is replaced by the matching property
  from the node's input data.
</design_principles>

<node_types>

## manual
A pure pass-through node. Returns its input unchanged. Use as the graph
entrypoint to accept external data that triggers the job.

**Config:** None (empty object `{}`).

**Output:** Identical to input.

---

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
reasons, and eventually calls the `done` tool with its final result.

**Config (`IAgentNodeConfig`):**
| Property | Type | Description |
|---|---|---|
| `systemPrompt` | `string` | The agent's system prompt / instructions |
| `selectedTools` | `string[]` | Names of tools to make available (see agent-node-guide for the full list). `think` and `done` are always injected automatically. |
| `model` | `string \| null` | AI model identifier; `null` uses system default |
| `reasoningEffort` | `"low" \| "medium" \| "high" \| null` | Reasoning effort level |
| `maxSteps` | `number` | Maximum agentic loop iterations (recommended: **50**) |

**When to use:** When the task requires multi-step reasoning, tool use
(searching knowledge, running commands, reading/writing files), or complex
decision-making that cannot be done in a single LLM pass.

</node_types>

<schema_rules>
- All schemas are JSON Schema format.
- Connected nodes must have compatible schemas at their junction.
- Use descriptive property names and include descriptions.
- Keep schemas as simple as possible while capturing required structure.
</schema_rules>

<editing_after_creation>
Jobs and nodes are fully editable after creation. Do not recreate from
scratch if a small fix will do — use the appropriate edit tool instead.

Available editing tools:
- `edit_job` — update the job name or description
- `edit_node` — update a node's name, description, input schema, output
  schema, or config (code, URL, system prompt, maxSteps, etc.)
- `add_node` — add a new node to an existing job
- `remove_node` — remove a node from the job
- `connect_nodes` — add a connection between two nodes
- `set_entrypoint` — change which node starts execution
- `finish_job` — mark job as ready (transitions status from "creating"
  to "ready"); call this once all nodes are defined and tested

When to use edit tools:
- A node test fails → use `edit_node` to fix the config, code, or schema
- The output schema doesn't match downstream expectations → `edit_node`
- A new requirement means adding a step → `add_node` + `connect_nodes`
- Wrong entrypoint set → `set_entrypoint`

Note: There is no `disconnect_nodes` tool. If a connection is wrong,
use `remove_node` on the problematic node and re-add it, or restructure
the graph by adding the corrected connection with `connect_nodes`.
</editing_after_creation>
