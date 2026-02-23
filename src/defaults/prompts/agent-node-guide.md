# Guide: Creating Agent Node System Prompts

When creating an agent node, structure the system prompt using XML tags
for maximum clarity and instruction adherence. GPT-5 and similar models
respond exceptionally well to XML-structured prompts.

## Core XML Tags

### <context_gathering>
Controls how the agent explores and gathers information before acting.

Example:
```xml
<context_gathering>
Goal: [What the agent needs to understand before acting]
Method: [How to search/explore — breadth-first, targeted, etc.]
Early stop criteria: [When the agent has enough context to proceed]
Depth: [How deep to trace dependencies]
</context_gathering>
```

### <persistence>
Controls agent autonomy and stop conditions.

Example:
```xml
<persistence>
- Keep going until the task is completely resolved before yielding.
- Only terminate when you are sure the problem is solved.
- Do not ask for confirmation — decide the most reasonable approach
  and proceed, documenting assumptions.
</persistence>
```

### <tool_preambles>
Controls how the agent communicates plans and progress.

Example:
```xml
<tool_preambles>
- Begin by rephrasing the goal clearly before calling any tools.
- Outline a structured plan detailing each logical step.
- Narrate each step succinctly as you execute.
- Finish by summarizing completed work.
</tool_preambles>
```

### <task>
The core task description with expected inputs, outputs, and success criteria.

### <constraints>
Boundaries, safety rules, and what the agent must NOT do.

### <output_format>
Expected output structure with JSON schema descriptions and examples.

## Best Practices

1. **Be precise and unambiguous** — contradictory instructions cause the
   model to waste reasoning tokens reconciling conflicts instead of working.

2. **Structured over verbose** — XML tags with clear content beat long
   unstructured paragraphs. The model parses structured prompts more reliably.

3. **Define stop conditions explicitly** — tell the agent exactly when the
   task is considered complete. Be specific: "stop after extracting all
   product prices" not "stop when done."

4. **Separate safe vs unsafe actions** — if the agent has run_cmd access,
   explicitly specify acceptable and forbidden commands.

5. **Use tool budgets** — for focused tasks, limit tool calls to prevent
   over-exploration:
   ```xml
   <context_gathering>
   Search depth: low
   Maximum tool calls: 3
   </context_gathering>
   ```

6. **Include examples** — for complex outputs, provide 1-2 concrete examples
   of expected behavior and format.

7. **Natural language within tags** — write as you would explain to a skilled
   colleague. Tags provide structure; content within is clear natural language.

8. **Match input/output schemas** — ensure the system prompt guides the agent
   to produce output that exactly matches the node's output JSON schema.

## maxSteps

`maxSteps` controls how many LLM→tool→LLM cycles the agent is allowed
before it is forcibly stopped. Always set it explicitly — do not rely on
the default.

| Situation | Recommended value |
|---|---|
| Simple, focused task (1-3 tools) | 15–20 |
| General-purpose agent with several tools | 50 |
| Agent with 5+ tools or complex multi-step work | 50+ |

**50 is the recommended safe default.** Setting it too low is a common
source of incomplete results — the agent simply stops mid-task. It is
almost always better to allow more steps than too few.

## Output Schema (required)

Every agent node **requires** an `outputSchema` — this defines the JSON format
of the `done()` tool that the agent calls to return its final result. The
workflow is:

1. Call `create_output_schema` with a description of what the agent should
   produce (e.g. "a list of filtered articles with title, link, and summary").
2. The tool returns `{ success: true, blueprint: { ... }, schema: { ... } }`.
3. Pass the `blueprint` object as `outputSchema` when calling `add_agent_node`
   (the runtime converts it to JSON Schema internally).

**Do NOT skip this step.** Calling `add_agent_node` without `outputSchema`
will fail validation and the node will not be created.

## Tool Selection

When creating an agent node, populate `selectedTools` with names from this
list. These are the **only** tools available inside agent nodes — they are
not the same as node types.

| Tool name | Description |
|---|---|
| `think` | Internal reasoning / scratchpad — always injected automatically |
| `run_cmd` | Run shell commands |
| `search_knowledge` | Search the knowledge base |
| `add_knowledge` | Add information to the knowledge base |
| `edit_knowledge` | Edit existing knowledge entries |
| `send_message` | Send a message to the execution user/chat when messaging context is available. In headless runs, it falls back to internal logging. |
| `read_file` | Read a file from the workspace |
| `write_file` | Write a file to the workspace |
| `append_file` | Append content to a file |
| `edit_file` | Edit a file in place |
| `write_to_database` | Insert a row into a database table. Requires databaseName, tableName, and data (key-value pairs matching column names). |
| `read_from_database` | Query rows from a database table with optional WHERE, ORDER BY, LIMIT, and column selection. |
| `list_databases` | List all available databases. |
| `list_tables` | List all tables in a specific database. |
| `get_table_schema` | Get the schema (columns, types) of a specific table. |
| `create_table` | Create a new table in a database with specified columns and types. |

**Notes:**
- `think` and `done` are always injected automatically — you do not need
  to include them in `selectedTools`, but listing `think` is harmless.
- `done` is the tool the agent calls when it has finished its task. It is
  always available.
- `send_message` requires execution messaging context (for example when the job
   is run from a chat). In headless runs (e.g., some scheduled/background
   executions), messages are logged instead of being delivered to a user chat.
- Choose only the tools the agent actually needs. Fewer tools = more
  focused behavior.
- **Do not confuse these with node types** (`curl_fetcher`, `crawl4ai`,
  `searxng`, etc.). Node types are separate nodes in the graph. The tools
  listed here are what an agent node can use *internally* during execution.

## Complete Example

```xml
<context_gathering>
Goal: Understand the current state of the target webpage.
Method: Use crawl4ai to fetch the page, then analyze structure.
Early stop criteria: Page content is loaded and key data identified.
</context_gathering>

<persistence>
- Complete full extraction before yielding results.
- If page structure is unexpected, adapt and try alternative selectors.
- Document any assumptions about the page structure.
</persistence>

<task>
Extract product pricing data from the given e-commerce URL.
Parse the HTML to find all product cards, extracting:
- Product name
- Current price
- Original price (if on sale)
- Availability status

Return data as a JSON array matching the output schema.
</task>

<constraints>
- Do not follow links to other pages.
- Do not interact with forms or login pages.
- Maximum 2 crawl4ai calls per execution.
- If the page requires authentication, report error without bypass.
</constraints>

<output_format>
JSON array of objects:
{
  "name": "Product Name",
  "currentPrice": 29.99,
  "originalPrice": 39.99,
  "onSale": true,
  "available": true
}
</output_format>
```
