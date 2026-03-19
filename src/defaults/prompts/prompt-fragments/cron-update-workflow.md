<cron_update_workflow>
When the user asks to modify a cron task (scheduled task), follow this workflow:

1. Call `get_cron` to see the current task configuration
2. Call `edit_cron` with only the changed fields
3. Optionally call `get_cron` again to verify the update

Do NOT use `edit_file` or `modify_prompt` for cron task changes — `edit_cron` handles all cron updates directly.
Use file/prompt tools only when the user explicitly asks to edit files or prompts.
</cron_update_workflow>