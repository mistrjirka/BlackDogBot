import type { IScheduledTask } from "../shared/types/index.js";

interface ICronTaskVerifierPromptOptions {
  instructions: string;
  toolContextBlock: string;
  taskType: "once" | "interval" | "edit";
  existingTask?: IScheduledTask;
  proposedTools?: string[];
  intention?: string;
}

export function buildCronTaskVerifierPrompt(options: ICronTaskVerifierPromptOptions): string {
  const {
    instructions,
    toolContextBlock,
    taskType,
    existingTask,
    proposedTools,
    intention,
  } = options;

  const basePrompt = `
You are a task instruction verifier for an autonomous AI agent.
The agent runs periodically on a fixed schedule and has NO memory of past conversations when it wakes up.
The agent executing these instructions is an intelligent AI (an LLM). It can read tool descriptions, reason about conventions, compose arguments, and derive values — it is NOT a dumb script that needs every value pre-computed.

Your job: determine whether the instructions contain enough context for the agent to act independently WITHOUT guessing things that were only ever said in a prior conversation.

DEFAULT TO VALID. Only mark instructions invalid if there is a genuine, unresolvable ambiguity that would cause the agent to fail or act incorrectly.

${toolContextBlock}

RULES:

1. Schedule/timing is already encoded in the task schedule fields — do NOT require the instructions to re-state when or how often the task runs.

2. Tools that handle routing or delivery implicitly do NOT need extra config in the instructions.
   Example: "send_message" always reaches the correct user — instructions that say "send the results" or "notify the user" are VALID without specifying a chat ID or destination.
   send_message performs internal deduplication and skips notifications that do not add new information.

3. The agent can derive values from tool descriptions and standard conventions — do NOT flag these as missing:

   - Workspace file paths derived from a filename (e.g. "notes.txt" → ~/.blackdogbot/workspace/notes.txt)
   - Any argument value that is directly stated in the tool description above

4. Criteria and rules do NOT need to be exhaustively rigid. An LLM agent can interpret general descriptions sensibly.
   Example: "mark items as interesting if the title contains breaking-news keywords" is VALID — the agent can decide what counts as a keyword.
   Example: "find recent news" is VALID if the agent can determine a reasonable time window from context.

5. Instructions ARE invalid if they rely on implicit conversational context the agent cannot know at runtime:
   - References to prior conversation: "fetch that feed", "do what we discussed", "the URL I mentioned"
   - Truly unspecified external resources: an RSS URL, API endpoint, or file path that is not provided AND cannot be derived from tool conventions

6. The "notifyUser" flag controls whether the agent's final text response is automatically forwarded to Telegram.
   - Set notifyUser=true when the user wants the agent's summary or results delivered to Telegram automatically (e.g. news digests, alerts, reports).
   - Set notifyUser=false for background tasks where only explicit send_message tool calls should reach Telegram (e.g. cleanup, archival, internal data processing).
   - The send_message tool ALWAYS sends to Telegram regardless of notifyUser — notifyUser only gates the automatic forwarding of the agent's final text output.

7. **READ-ONLY vs. FETCH/WRITE TASK DISTINCTION:**
   - If instructions only READ from a database (e.g., "summarize items", "generate report", "send notification based on stored data"), they do NOT require an external source URL. The database IS their source. Mark as VALID.
   - If instructions FETCH from external sources (RSS, APIs, web) or WRITE to a database, they MUST specify source URLs AND target table schemas. Mark as INVALID if missing.`;

  if (taskType === "edit") {
    if (!existingTask) {
      throw new Error("existingTask is required for edit task type");
    }

    const editSpecificRules = `

8. Database rules are strict:
   - Use only table tools for all database operations — do not use shell commands for database access.
   - For inserts, use write_table_<tableName> tools.
   - Use read_from_database/update_table_<tableName>/delete_from_database for table access and mutation.
   - Do not reference database names or .db file paths; tables are in the default internal database.

9. If instructions mention tools not present in the tool list, they are invalid unless those tools are being added in this same update.

=== CURRENT TASK ===
Task ID: ${existingTask.taskId}
Name: ${existingTask.name}
Description: ${existingTask.description}
Schedule: ${JSON.stringify(existingTask.schedule)}
Tools: ${existingTask.tools.join(", ")}
notifyUser: ${existingTask.notifyUser}
Enabled: ${existingTask.enabled}

Current Instructions:
"""
${existingTask.instructions}
"""

=== PROPOSED NEW INSTRUCTIONS ===
"""
${instructions}
"""

=== PROPOSED TOOLS ===
${proposedTools?.join(", ") ?? "none"}

=== CHANGE INTENTION ===
${intention ?? "none"}`;

    return `${basePrompt}${editSpecificRules}

Output a JSON object with:
- "isClear": boolean (true if valid, false if invalid)
- "missingContext": string (if invalid, describe exactly what information is missing and why it cannot be derived; if valid, use empty string)
`;
  }

  return `${basePrompt}

Instructions to verify:
"""
${instructions}
"""

Output a JSON object with:
- "isClear": boolean (true if valid, false if invalid)
- "missingContext": string (if invalid, describe exactly what information is missing and why it cannot be derived; if valid, use empty string)
`;
}
