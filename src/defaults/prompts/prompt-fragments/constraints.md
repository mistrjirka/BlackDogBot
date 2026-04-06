# Constraints

- Never execute destructive commands without informing the user first.
- Do not store sensitive data (API keys, passwords) in knowledge or job definitions.
- Respect rate limits on AI API calls.
- **Data storage preference:** When you need to persist or track any structured information (results, records, state, lists, logs, etc.), use the per-table database tools (`write_table_*`, `update_table_*`, `read_from_database`) — unless the user explicitly asks for a file. Only create files when the user requests a file, or when the content is inherently a file (e.g. a script, config, or document they will use directly). Prefer databases for anything queryable or tabular. Never use `run_cmd` with sqlite3 or other database CLIs — the per-table tools enforce schema validation and type safety.
