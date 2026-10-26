# Tool catalog stabilization and compression

Date: 2026-10-26. Scope: BlackDogBot main chat agent.

## Measured impact

Token counts measured through the actual local Ornith llama.cpp /apply-template and /tokenize endpoints.

| Model-visible catalog | Tools | Schema tokens |
|---|---:|---:|
| Original recorded catalog | 71 | 15,927 |
| Optimized catalog (serialized reconstruction from new Zod schemas) | 66 | 12,495 |
| Difference | -5 | -3,432 (21.5%) |

The new catalog retains all capability *classes*. Unlike dynamically selecting tools, the full fixed set is advertised each turn. The reconstructed count excludes environment-dependent tool differences such as newly created per-table tools or absent MCP servers.

## Implementation

- Sort MCP-server connections, MCP tool names, per-table tool names and final catalog entries using a canonical, deterministic order. Avoid cache misses solely due to reconnect order.
- Replace verbose top-level descriptions using a curated, reviewed, statically defined map. All existing input-schema constraints remain unchanged for unmerged tools.
- Replace five **chat-only** PTY control tools with `process` and its `action` discriminator. The old PTY tools remain exported and still implement every action.
- Replace four **chat-only** scheduling creation/edit tools with `schedule_create` and `schedule_edit`, `kind=once|interval`. Legacy Zod validators and existing execution handlers still run, preserving scheduling behavior. `edit_instructions` remains separate.
- Add `apply_patch` for context-checked unified diffs. `git apply --check` is run before `git apply`, without shell execution. `edit_file` remains for simple replacement.
- Keep old cron agent tool definitions intact for backward compatibility with existing scheduled-task configurations.

The main agent prompt now documents the merged interfaces, blackboard references and terminal controls. Permission registry blocks merged process/scheduling/patch interfaces in read-only contexts.

## Live model study

`python3 scripts/benchmark-file-tools.py` performs six function-generation prompts against the local llama.cpp endpoint. Tool calls are **not executed**. On the October 26 local Ornith 9B run, six of six generated the expected arguments, with latencies 2.9–5.7 seconds each:
- exact-string replacement (`edit_file`), context-aware unified diff (`apply_patch`)
- legacy one-time and interval tasks
- merged one-time and interval tasks

This is not a general reliability claim. Larger, nontrivial changes and tricky schedule boundaries require more benchmarks.

## Caching and limitations

- Tool definitions are fixed for an agent run. Actual MCP availability and newly registered per-table write tools can still change the catalog across runs. Sorting removes ordering-only differences, not real availability changes.
- All five former PTY tools and four former scheduling tools remain usable in the cron/internal implementation, but are no longer directly advertised to the chat agent. Chat conversations from older releases may still contain references to those old tool names; historical messages are not rewritten.
- An already-running llama.cpp slot will have to build a new prefix after deployment; future prompts should reuse the new stable schema.
- A change in active model or configured MCP servers can still cause cache-prefix misses. This optimization deliberately avoids task-dependent activation.
