# Guide: Creating Jobs and Nodes

When creating a job, follow this structured process:

<task>
1. **Plan the job graph** — think through what nodes are needed,
   their types, and how they connect.

2. **Create the job** — use add_job to create the job with a clear
   name and description. The job starts in "creating" status.

3. **Define nodes** — for each node in the graph:
   - Choose the appropriate node type.
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

<node_types>
- **manual** — triggered by the AI, no automatic execution
- **curl_fetcher** — fetches a URL using curl, returns response body
- **crawl4ai** — crawls a web page with AI-powered content extraction
- **searxng** — performs a web search via SearXNG
- **python_code** — executes Python code written by you
- **output_to_ai** — returns data back to the calling AI
- **agent** — an agentic model with its own system prompt and tools
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
