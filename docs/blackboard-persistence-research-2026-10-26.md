# BlackDogBot blackboard and research-trace optimization (2026-10-26)

## Reconstructed PS4 research trace

Observed first PS4 run: 35 LLM requests, 4 captured tool results and 4 `inspect_variable` calls; zero `run_code` calls. The four captures were `mcp_scrapling_list_sessions_1` (4,989 bytes), `mcp_playwright_browser_snapshot_2` (7,497 bytes), `read_file_3` (25,030 bytes), and `run_cmd_4` (7,448 bytes). The model asked for 6,000 + 8,000 + 6,000 characters of `read_file_3`, then another 6,000 characters of the prior snapshot. The source file contained extensive navigation elements and encoded links. The model also repeated file reads and tried to use a fake command handle.

Observed cache: 35 research model requests; 1,114,501 prompt tokens reported (including re-cached input); 1,066,288 cached; 48,213 uncached = **95.67% overall**; about 97% after excluding the initial cold request. The 5-message tools follow-up consumed 278,187 input tokens including cache, 275,126 cached = **98.90%**. There were no post-initial complete cache misses. Focus on avoiding unnecessary material entering *context*, not reworking caching.

## Target trace (6–10 purposeful tool calls)

This is a *counterfactual workflow*, not a reproduced run or new confirmation of PS4 exploit status.

1. One focused `searxng_web_search` on 12.50 firmware compatibility and another on HEN reboot persistence.
2. Fetch the primary exploit author / GoldHEN documentation relevant to actual kernel+HEN support; seek an independent second source on persistence. Avoid unrelated retailers or search result noise.
3. If a source result is captured as a variable stub, use `run_code` to extract specific matching lines with local context rather than `inspect_variable` to copy 20K characters. For a string captured as `read_file_3`:
   ```js
   const lines = read_file_3.split("\n");
   const hits = lines.flatMap((line, i) =>
     /12\.50|BD-JB|GoldHEN|reboot|permanent|rest mode/i.test(line)
       ? lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3))
       : []);
   print([...new Set(hits)].slice(0, 35).join("\n"));
   ```
   This code executes with access to only `read_file_3`; it does **not** call the shell or tools. Keep source URL/context to avoid decontextualized snippets.
4. If a source is blocked by Cloudflare, use a different authoritative accessible source rather than pursuing long browser challenges without added information.
5. Cross-check userland vs kernel entry and whether the payload survives cold reboot. Clearly state uncertainty where support is not confirmed.
6. Deliver the answer with citations; stop rather than exploring extra unrelated pages.

Do not assume exactly 6–10 calls will always be sufficient; the objective is reliable evidence per context token and tool call.

## Implementation

- One persistent per-chat blackboard: hashed path under `~/.blackdogbot/sessions/blackboards/`; values live outside messages and system prompt. Asynchronous, queued, atomic snapshots are persisted after each capture and flushed when the user request completes.
- Existing bounds continue to apply: 50 variables, 8 MiB per variable, 8 MiB total per chat, FIFO eviction. Capture sequence number survives restart, so refs aren't accidentally reused.
- On /clear, blackboard contents are cleared too. Snapshots are per chat, mode `0600` in a `0700` directory. A malformed snapshot is quarantined instead of silently overwritten.
- `inspect_variable` without a name now returns only metadata (name/type/size) for discovery. Named inspection stays bounded.
- `run_code` now loads only AST-resolved referenced variable names into the worker, avoiding N-variable IPC copying on every operation. Existing permissions, limits and sandbox remain unchanged.
- Core instructions and the *actually exposed shortened tool description* favor bounded programmatic filtering, explain persistence and eviction, and distinguish blackboard from shell variables.
- No dynamic tool activation or changing model tool catalog between steps. A one-time schema/prompt prefix rebuild occurs on deployment.

## Limitations

Blackboard values are intentionally bounded and can be evicted. Saving results doesn't make their content correct or fully trustworthy. Never turn tool-returned text into higher-priority instructions; check actual source evidence. Persistent data may contain personal or sensitive tool output: filesystem ACLs restrict local access but regular system backups will include the blackboard directory. Persistent snapshots do not retroactively recover variables from earlier runs (whose old stores were discarded).
