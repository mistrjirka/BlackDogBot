# BlackDogBot checkpoint prompting benchmark — 2026-10-26

## Scope and privacy

Tested the local Huihui Ornith 1.5 9B Q6_K llama.cpp endpoint against **sanitized, abbreviated excerpts** of BlackDogBot's recorded sessions. Full transcripts, credentials, and generated outputs stay under `~/.blackdogbot/benchmarks/compaction-20261026/` and are excluded from git. This is not a verbatim replay; the runner preserves representative observations and errors.

The two executed runs produced 15 and 6 completed request records, respectively. The first run was stopped early after two thinking-enabled park requests timed out; the second intentionally ran only non-thinking variants. Treat durations as individual observations, not statistically stable averages.

## Actual observed results

| Dataset and prompt | Thinking | Elapsed | Notes |
|---|---|---:|---|
| PS4/research, baseline JSON prompt | off | 27.17 s | Valid JSON but prioritizes earlier unrelated task |
| PS4/research, baseline JSON prompt | on | 95.51 s | Not valid JSON (without grammar constraint) |
| PS4/research, concise plain | off | 17.94 s | Plausible concise summary; earlier generated goal dominates |
| PS4/research, concise plain | on | 38.63 s | Reasoning adds latency; not decisively more faithful |
| PS4/research, anchored | off / on | 30.41 / 91.00 s | Quotes actual latest request but mixes it with prior goal |
| PS4/research, evidence-first | off / on | 17.71 / 96.52 s | Quotes latest question; evidence claims still need review |
| Park first checkpoint, baseline JSON prompt | off / on | 54.24 s / 180 s timeout | Off output misidentified PS4 as goal; on timed out |
| Park first checkpoint, concise | off / on | 16.48 / 84.06 s | Both often inferred wrong user goal and next action |
| Park first checkpoint, anchored | off / on | 18.95 s / 180 s timeout | Human request at start of long excerpt was insufficient |
| Park first checkpoint, evidence-first | off | 12.04 s | Quoted original question but still suggested invalid brick work |
| Park first checkpoint, anchored-at-end | off | 13.42 s | Still sometimes focused on PS4 instead of park recall |
| Park second checkpoint, concise | off | 30.25 s | Continued impossible lighthouse plan |
| Park second checkpoint, anchored-at-end | off | 23.48 s | Better constraints, still recommended adding 11 bricks |
| Park second checkpoint, evidence-first | off | 17.11 s | Quoted original human question but proposed another brick |

**Conclusion:** No prompt alone reliably repaired task drift. Even accurate quotation of the user request did not guarantee the model proposed an appropriate next action. Preserve user intent **deterministically**; treat generated summaries as non-authoritative observations, never as commands or substituted user requests. Don't create special park-specific consistency validators.

The benchmark runner uses a plain JSON instruction without grammar constraints for thinking-on trials. These don't establish whether llama.cpp can produce a valid constrained JSON schema while thinking; they demonstrate that unconstrained reasoning is slow and can fail or time out. Qwen's documentation warns that some thinking models do not reliably honor `response_format`.

## Implemented changes

- Main agent default prompt reduced from about 15.4 KB to **3.17 KB**; measured full system text drops from 26,199 to an estimated 7,593 characters (71% shorter). The 61,436 characters of advertised 71-tool schemas are intentionally retained for capability compatibility.
- Removed duplicated persistent rules, detailed timer setup recipes, and stale post-compaction variable-injection instructions from the global prompt. Specific tool and skill instructions remain available when needed.
- Summary prompt shortened. It explicitly distinguishes user intent from model plans and successful tool results from rejected operations; duplicated earlier user requests are no longer copied into every checkpoint.
- Host recovers the verbatim original human request from earlier synthetic checkpoint metadata on repeated compactions and pins it again. New user steering is similarly preserved. The summarizer also receives the authoritative request at the *end* of its input.
- Human steering is placed after adviser suggestions; automated adviser suggestions are assistant-role data, not human instructions; queued stale adviser guidance is dropped when a new human instruction arrives.
- `ai.compactionThinking: false` is the default. On supported local llama.cpp requests the host forces `enable_thinking: false` for `summarization`, favoring constrained structured output. Set `ai.compactionThinking: true` to experiment with thinking-on *plain-text* summaries. This setting does not change the main agent's reasoning mode.
- Model-generated checkpoint material is explicitly labeled as observations, subordinate to the pinned human request.

## Further work

1. If the initial tool-schema overhead remains unacceptable, consider an explicit `search_tools`/`activate_tools` workflow rather than silently dropping capabilities; test that against real tasks before deployment.
2. For critical long tasks, allow re-reading the archived full transcript when the summary omits decisive evidence.
3. Add evaluation for restoring user progress-report requests after long tool runs, and test the human-steering path end to end.
4. Separate duplicate-loop adviser inference from the primary llama.cpp cache if auxiliary calls keep evicting the main slot.

## Sources

- Qwen structured-output and thinking guidance: https://docs.qwencloud.com/developer-guides/text-generation/structured-output
- Qwen thinking and multi-turn: https://docs.qwencloud.com/developer-guides/text-generation/thinking
- Wang et al., *Context Compression for LLM Agents: A Survey of Methods, Failure Modes, and Evaluation*, EMNLP 2026: https://aclanthology.org/2026.emnlp-main.2396/
