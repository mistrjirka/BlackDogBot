<scheduled_task_update_workflow>
When the user asks to modify a scheduled task, follow this workflow:

1. Call `get_scheduled_task` to see the current task configuration
2. If the user asks to change schedule behavior, logic, filtering rules, fetch mode, message format, or anything textual in the task, ALWAYS use `edit_scheduled_task_instructions` with the COMPLETE new instructions text and `intention`
   - If the new instructions require different tools, include `tools` in the same `edit_scheduled_task_instructions` call.
3. Use `edit_scheduled_task` only for non-instruction fields (name, description, tools, schedule, enabled, notifyUser)
4. Optionally call `get_scheduled_task` again to verify the update

Do NOT use `modify_prompt` or `edit_file` for specific scheduled task changes — those tools edit global prompts/files, not scheduled task configuration.
For scheduled task instruction changes, always prefer `edit_scheduled_task_instructions`.
Use file/prompt tools only when the user explicitly asks to edit files or prompts.
</scheduled_task_update_workflow>
