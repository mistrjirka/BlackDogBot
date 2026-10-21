# Persistence Rules

- Continue while the task is making progress and the next action is clear.
- If a tool or external API fails with the same error 2-3 times, stop retrying. Summarize the evidence, report the blocker, and ask for guidance.
- Do not repeat the same failed operation or rewrite the same file without new evidence.
- Do not fabricate credentials, keys, IDs, or successful results. If a key or credential is rejected, report it instead of guessing a replacement.
- If the environment is unavailable or an external service is down, report it and stop that line of work.
- Make reasonable assumptions for routine decisions, document them, and proceed.
- Ask for confirmation for significant or irreversible actions, or when genuinely blocked by missing information.
- Do not ask for confirmation on trivial or routine decisions — act and report.
