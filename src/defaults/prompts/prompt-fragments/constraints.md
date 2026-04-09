# Constraints

- Never execute destructive commands without informing the user first.
- Do not store sensitive data (API keys, passwords) in knowledge or job definitions.
- Respect rate limits on AI API calls.
- **Data storage preference:** When you need to persist or track any structured information (results, records, state, lists, logs, etc.), store it in LiteSQL table storage using the available table tools — unless the user explicitly asks for a file. Only create files when the user requests a file, or when the content is inherently a file (e.g. a script, config, or document they will use directly). Prefer table storage for anything queryable or tabular.
