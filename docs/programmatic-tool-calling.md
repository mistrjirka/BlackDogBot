# Programmatic tool calling (blackboard)

BlackDogBot does **not** execute bot/MCP tools from model-generated JavaScript.
Tools return data, a per-run blackboard stores large results, and `run_code`
transforms that data without calling tools. This is intentionally different from
systems where the model writes a program that calls tools directly.

1. A large MCP search/page output (or ordinary tool output) appears as a small
   JSON stub with `variable`, `type`, `itemSchema`, `preview`, and size.
2. `run_code` receives the stored values as named JavaScript variables. Example:
   `return mcp_searxng_searxng_web_search_1.filter(x => x.title)`.
   Actual names must come from the stub. Some results contain only an array or
   a string rather than an object. `print(value)` inspects data without storing
   a return value. `return value` stores `code_<n>`.
3. Use `{"type":"variable","name":"code_2"}` in supported inputs:
   `write_table_<name>.data`, `write_file.content`, and
   `add_knowledge.knowledge`. `run_cmd` cannot access blackboard variables.

## Limits

- Values below 4,000 serialized characters remain inline; larger values become
  stubs. Text returned by MCP tools follows the same rule. Images remain
  multimodal and are not turned into blackboard variables.
- The store retains up to 50 values and up to 8 MiB total. A single value can
  be at most 8 MiB. Larger results produce a **bounded error** instead of
  injecting huge content into the conversation. Request a smaller or paginated
  result. Older variables may be evicted to stay within the budget.
- Each `run_code` call takes at most 4,000 source characters and 5 seconds.
  The worker has a 128 MiB V8 heap cap. JSON returns may be at most 1 MiB.
  Printed output is capped at 1,000 characters per call and 8,000 in total.
  Three consecutive failures stop further code attempts for that agent run.
- The store is **not persistent**. Names from previous agent runs cannot be
  resolved. A delegated worker gets its own independent store.
- `run_code` executes in a short-lived Node VM worker. It exposes no tools,
  shell, files or network interfaces to the code by design. Node VM is not a
  hardened security boundary. Node 26+ also enables filesystem, network and
  child-process restrictions for the worker. BlackDogBot remains a trusted-agent system.

The text-capture hook runs after MCP result conversion, preserving image parts
while removing repeated structured content when it duplicates JSON text.
