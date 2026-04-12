<timed_update_workflow>
**Note:** Users may refer to these tasks as "cron", "timed", "scheduled", or "task" interchangeably. The system determines intent from context.

When the user asks to modify a timed/scheduled task, follow this workflow:

1. Call `get_timed` to see the current task configuration and determine the schedule type (once or interval).
2. If the user asks to change instructions, logic, filtering rules, fetch mode, message format, or anything textual in the task, ALWAYS use `edit_instructions` with the COMPLETE new instructions text and `intention`
   - If the new instructions require different tools, include `tools` in the same `edit_instructions` call.
3. Use `edit_once` for non-instruction changes to one-time tasks (name, description, tools, runAt, notifyUser, enabled, messageDedupEnabled).
   Use `edit_interval` for non-instruction changes to interval tasks (name, description, tools, every, offsetFromDayStart, timezone, notifyUser, enabled, messageDedupEnabled). When patching `every` or `offsetFromDayStart`, always provide both `hours` and `minutes`, including zero values (for example, use `{ hours: 2, minutes: 0 }`, not `{ hours: 2 }`).
4. If the user reports missing periodic notifications (for example "the cron didn't send the morning summary"), treat dedup suppression as a likely cause: inspect with `get_timed`, and consider setting `messageDedupEnabled` to `false` for periodic deliverables. Keep dedup enabled for event/incident alerts unless the user asks otherwise.
5. Optionally call `get_timed` again to verify the update.

**Why `edit_instructions` requires COMPLETE text:**
The `instructions` field is self-contained. Scheduled agents have no conversation memory and cannot access workspace files unless explicitly configured with a `read_file` step. Using file/prompt tools to "help" a task will fail — the task only sees what is in `instructions`. When in doubt, over-include: paste the CREATE TABLE schema, list exact column names, and specify complete URLs.

Use file/prompt tools only when the user explicitly asks to edit files or prompts.
</timed_update_workflow>
