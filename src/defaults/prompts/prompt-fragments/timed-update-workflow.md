<timed_update_workflow>
When the user asks to modify a timed/scheduled task, follow this workflow:

1. Call `get_timed` to see the current task configuration and determine the schedule type (once, interval, or cron).
2. If the user asks to change instructions, logic, filtering rules, fetch mode, message format, or anything textual in the task, ALWAYS use `edit_instructions` with the COMPLETE new instructions text and `intention`
   - If the new instructions require different tools, include `tools` in the same `edit_instructions` call.
3. Use `edit_once` for non-instruction changes to one-time tasks (name, description, tools, runAt, notifyUser, enabled).
   Use `edit_interval` for non-instruction changes to interval tasks (name, description, tools, intervalMs, notifyUser, enabled).
4. Optionally call `get_timed` again to verify the update.

Do NOT use `modify_prompt` or `edit_file` for specific task changes — those tools edit global prompts/files, not task configuration.
For task instruction changes, always prefer `edit_instructions`.
Use file/prompt tools only when the user explicitly asks to edit files or prompts.
</timed_update_workflow>
