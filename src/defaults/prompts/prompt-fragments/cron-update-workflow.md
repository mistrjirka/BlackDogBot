<cron_update_workflow>
When the user asks to modify a cron task (scheduled task), follow this workflow:

1. Call `get_cron` to see the current task configuration
2. If the user asks to change cron behavior, logic, filtering rules, fetch mode, message format, or anything textual in the task, ALWAYS use `edit_cron_instructions` with the COMPLETE new instructions text and `intention`
3. Use `edit_cron` only for non-instruction fields (name, description, tools, schedule, enabled, notifyUser)
4. Optionally call `get_cron` again to verify the update

Do NOT use `modify_prompt` or `edit_file` for specific cron task changes — those tools edit global prompts/files, not cron task configuration.
For cron instruction changes, always prefer `edit_cron_instructions`.
Use file/prompt tools only when the user explicitly asks to edit files or prompts.
</cron_update_workflow>
