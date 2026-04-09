# AGENTS.md

## Quick Start

```bash
# Install deps
pnpm install

# Start daemon (use pnpm start, not node directly)
pnpm start

# Dev mode with auto-reload
pnpm dev
```

## Required Tools

- **Node.js 22+** (not 20)
- **pnpm** (not npm/yarn)

## Commands

| Command | Purpose |
|---------|---------|
| `pnpm test` | Unit + core integration tests |
| `pnpm test:unit` | Unit tests only (fast, no external deps) |
| `pnpm test:fast` | Unit + core (skips slow job tests) |
| `pnpm test:integration` | Full integration suite |
| `pnpm typecheck` | TypeScript check |
| `pnpm build` | Compile TypeScript |
| `pnpm vitest run <path>` | Run specific test file |

## Testing

- Tests use **Vitest** with `fileParallelism: false` to prevent OOM
- Embedding models load ~600MB; tests run sequentially
- Integration test timeout: **50 minutes** (see `vitest.integration.config.ts`)
- Never pipe test output through `head`/`tail` — failures print at end and get truncated

## Native Modules

If startup crashes with exit code 132 (`ELIFECYCLE`), rebuild native deps:
```bash
pnpm rebuild better-sqlite3 sharp onnxruntime-node
```

## Package Structure

- `src/` — Main bot (TypeScript, ESM)
- `brain-interface/` — Angular web UI (separate package, `ng serve`)

## Architecture

- **Platforms**: Telegram (grammy) + Discord (discord.js)
- **AI**: Vercel AI SDK with multiple providers (OpenAI, LM Studio, OpenRouter)
- **Skills**: Reusable `SKILL.md` files in `src/skills/`
- **Jobs**: DAG-based job graphs with cron scheduling
- **Knowledge**: Embeddings + LanceDB vector search

## Key Files

- `src/index.ts` — Entry point
- `src/services/` — Core services (config, AI, embeddings, skills)
- `src/tools/` — Tool definitions (file, search, code execution)
- `src/platforms/` — Telegram/Discord handlers

## See Also

- `docs/testing.md` — Detailed test guidance
- `docs/architecture.md` — Component overview
- `docs/configuration.md` — Config reference
