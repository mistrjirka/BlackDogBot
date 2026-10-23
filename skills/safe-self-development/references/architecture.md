# BlackDogBot architecture map

Read actual code at the current revision; these are navigation hints, not a guarantee of current interfaces.

| Capability | Code entry points | Where to test |
|---|---|---|
| Telegram messages, progress, photos, commands, outbox | `src/platforms/telegram/handler.ts`, `commands.ts`, `src/services/telegram-outbox.service.ts` | `tests/integration/core/telegram-handler.test.ts` |
| Main agent, tool execution, retries and compaction | `src/agent/main-agent.ts`, `base-agent.ts`, `retry-orchestrator.ts` | agent/retry tests in `tests/unit` and `tests/integration/core` |
| Model provider, reasoning parsing, vision and token accounting | `src/services/ai-provider/ai-provider-core.ts`, `src/utils/mcp-tool-image-bridge.ts`, `src/utils/request-token-counter.ts` | AI-provider/vision tests |
| MCP tools and registry | `src/services/mcp.service.ts`, `mcp-registry.service.ts`, `~/.blackdogbot/mcp-servers.json` | `tests/integration/mcp` |
| Skills | `src/services/skill-loader.service.ts`, `src/skills/parser.ts`, `skills/<name>/SKILL.md` | skill loader tests |
| PTY and shell tools | `src/services/command-process.service.ts`, `src/tools/run-cmd*.tool.ts` | PTY integration tests |
| Tool assembly, ACLs and messages | `src/agent/tool-assembly.ts`, `src/helpers/tool-registry.ts`, channel registry | tests for tool policies and channel permissions |
| Startup and user service | `src/index.ts`, `scripts/launch.sh`, `~/.config/systemd/user/blackdogbot.service` | service status and journal; not just compile |

Runtime state (config, sessions, DBs, skills, secrets) lives in `~/.blackdogbot`, outside the Git checkout and release snapshots. **Never overwrite it when updating source code.**

If extending an external API or tool service, implement/configure an MCP server under the `mcp-management` skill. If altering BlackDogBot's chat routing, Telegram formatting, tool-call semantics, permissions, compaction, or core behavior, edit the relevant source module with targeted tests.

Do not attach long, unrelated architecture instructions to every main-agent prompt; load this reference only when the user asks for development.
