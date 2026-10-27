import type { ToolSet } from "ai";

/** Concise, reviewed top-level tool descriptions. Parameter schemas and execution
 * are left unchanged; use no runtime/task-dependent transformations here. */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  add_once: "Create a one-time reminder/task. Supply exact local date and time, self-contained instructions, permitted tools, and notification choice.",
  add_interval: "Create a recurring task. Supply interval, day-start offset, timezone, self-contained instructions, permitted tools, and notification choice.",
  edit_once: "Modify a one-time task's non-instruction fields. Call get_timed first. Use edit_instructions for its instructions.",
  edit_interval: "Modify a recurring task's non-instruction fields. Call get_timed first. Use edit_instructions for its instructions.",
  edit_instructions: "Update a scheduled task's instructions. First inspect it with get_timed; scheduled agents do not inherit chat history.",
  run_cmd: "Run shell commands in fresh shells; background mode returns handleId for input/status/output/stop. Shell cannot read blackboard variables. Pipeline exit status may mask failures: use set -o pipefail.",
  run_cmd_input: "Write input or a special controlKey to a background PTY handle. Provide exactly one; control keys add no newline. Terminal echo is not proof of consumption.",
  write_file: "Overwrite or create a UTF-8 file. Existing files must first be read with read_file. Relative paths resolve in ~/.blackdogbot/workspace/.",
  append_file: "Append text or create file without requiring prior read. Relative paths resolve in ~/.blackdogbot/workspace/.",
  edit_file: "Replace exact text in a file; replaces first match unless replaceAll=true. Relative paths resolve in ~/.blackdogbot/workspace/.",
  read_file: "Read a UTF-8 file. Relative paths resolve in ~/.blackdogbot/workspace/; absolute paths allowed.",
  get_cmd_status: "Return current status of background command by handleId.",
  get_cmd_output: "Read cumulative PTY output. Earlier output may repeat; stdout includes merged terminal streams.",
  wait_for_cmd: "Wait for completion or input on handleId; timeoutMs limits waiting only, not execution.",
  stop_cmd: "Stop a background process by handleId with SIGTERM/SIGINT/SIGKILL; cleanup and output may remain available.",
  run_timed: "Run a saved scheduled task immediately; optionally notify its user.",
  // Kept short; input schema carries exact configurable limits.
  run_code: "Analyze saved variables with synchronous JS; print() has one combined output budget (default 3000 chars), not a 1000-char per-print limit. Optional maxOutputChars requests up to 16000. Response output reports produced/shown/omitted counts; truncated prints are saved as fullOutputVariable (or outputPrefixVariable beyond 64000 chars). Follow nextWith via inspect_variable instead of rerunning. Print concise keyword matches; browser_read_text is plain text, not HTML. For /regex/g use matchAll to obtain capture groups. Return data to store a new variable. No network/shell.",
  send_file: "Send a file from the workspace or uploads directory, optionally with a caption.",
  "mcp.searxng.web_url_read": "Retrieve and extract text from a URL using SearXNG. For dynamic or blocked pages use the browser tools.",
  "mcp.searxng.searxng_web_search": "Search the web through SearXNG. Supply keywords and search filters; use returned URLs for follow-up reading.",
  "mcp.stealth.browser_read_html": "Read page content with mode=form/text/full. IMPORTANT: mode=text returns PLAIN PROSE WITHOUT HTML TAGS; mode=form retains a form-oriented reduced structure; mode=full returns reduced HTML markup for parsing tags or tables. Output is complete, NOT paginated: NO offset/start/limit arguments. Long results are saved to a blackboard variable: use inspect_variable or run_code to read further, NEVER repeat this tool to fetch a next chunk.",
  "mcp.stealth.browser_read_text": "Read VISIBLE TEXT ONLY (not HTML tags, divs, classes, or element structure). Search the saved text for relevant words using run_code. If actual markup is needed, use browser_read_html. For long results use the blackboard variable; calling again does not page through content.",
  "mcp.scrapling.browser_actions": "Interact with a persistent Scrapling browser session using browser actions.",
};

/** Stable at agent creation time; does not alter parameter contracts. */
export function conciseToolDescriptions(tools: ToolSet): ToolSet {
  const mapped: ToolSet = {};
  for (const [name, def] of Object.entries(tools)) {
    const cloned = { ...def } as typeof def;
    if (DESCRIPTIONS[name]) cloned.description = DESCRIPTIONS[name];
    mapped[name] = cloned;
  }
  return mapped;
}

/** Stable serialized order across MCP reconnects, independent of insertion order. */
export function canonicalToolCatalog(tools: ToolSet): ToolSet {
  const sorted: ToolSet = {};
  for (const [name, def] of Object.entries(tools).sort(([a], [b]) => a.localeCompare(b, "en"))) sorted[name] = def;
  return sorted;
}