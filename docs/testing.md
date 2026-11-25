# Testing BlackDogBot

Use Linux, Python 3.9 or newer, Node.js 22.13.0 or newer, and the exact pnpm
version in `package.json#packageManager`. Install dependencies with
`pnpm install --frozen-lockfile`.

## Required checks

```bash
pnpm typecheck
pnpm test:fast
pnpm test:python
pnpm build
```

The GitHub CI workflow runs these checks on Linux with Node 22, 24, and 26.
It also checks shell syntax. Dependencies are installed from the lockfile.
The workflow requires no bot credentials, model server, downloaded model weights,
Docker daemon, or running systemd user service.

| Command | Coverage |
| --- | --- |
| `pnpm test:unit` | Unit tests, migration transactions, backups, and lock recovery |
| `pnpm test:core` | Core service integration with temporary files and databases |
| `pnpm test:fast` | Unit and core tests, with live-model cases disabled |
| `pnpm test:migrations` | Schema migration, legacy imports, backups, and recovery |
| `pnpm test:python` | Installer, MCP registration, and release-supervisor tests |
| `pnpm test:integration` | Optional integration and model tests, including external services |

The standard Vitest configuration excludes `*e2e.test.ts`. It forces
`BLACKDOGBOT_TEST_LIVE_MODEL` and `BLACKDOGBOT_RUN_LIVE_PROMPT_AUDIT` off so an
inherited shell flag cannot turn an upgrade check into a live model call.

## Data isolation

Tests create temporary data and synthetic configuration. Both Vitest
configurations clear an inherited `BLACKDOGBOT_DATA_DIR` before loading test
files. Individual tests can then select their own temporary directory.

This also protects older tests that isolate their directories through their
existing home-directory fixtures. A regression test runs prompt and database
tests with a parent data-directory sentinel and checks that it remains unchanged.

Never read installed credentials in a fast test. Do not use production directories
as test fixtures. Release-supervisor tests mock service operations and
notifications. Their real migration subprocesses operate on synthetic temporary
data only.

## Knowledge and embedding tests

The fast knowledge suite uses fixed vectors with the real LanceDB store. It tests
record persistence, metadata, updates, deletion, collection filtering, vector
ordering, and reopening the database. It does not claim to measure a model's
understanding of text.

The original model checks remain available separately:

```bash
pnpm test:integration tests/integration/core/embedding-service.e2e.test.ts
pnpm test:integration tests/integration/core/knowledge.e2e.test.ts
```

Those tests can download model weights and take longer. Use
`BLACKDOGBOT_MODELS_DIR` to select an existing model cache when needed.
Do not put them in the installation or deployment gate.

To run an explicitly configured live agent test:

```bash
BLACKDOGBOT_TEST_LIVE_MODEL=1 BLACKDOGBOT_TEST_CONFIG=/absolute/path/to/test-config.yaml pnpm test:integration tests/integration/core/base-agent.test.ts
```

Treat that configuration as live. Its providers and tools can perform actual
requests. Model-quality tests must use real model responses. Fast tests may
replace provider boundaries when the behavior under test is storage or routing.

## Migration and backup tests

The migration suite uses synthetic fixtures with links to the historical schema
commits. It covers supported legacy formats, explicit imports, repeated apply,
schema 1 upgrades, interrupted writes, stale locks, corrupt backups, and
conflicting edits.

Backup tests include real SQLite files with committed data still in a WAL.
Verification opens disposable copies so validation cannot modify either the
source database or the saved backup bytes. Restore tests compare recovered
content and permissions in a new destination.

Python tests cover the complete release sequence with only the service boundary
mocked. They run the real TypeScript CLI to check snapshot creation and
verification, migration, failed-start rollback, and preservation of later edits.

## Inspecting failures

Keep the command's exit status and its complete output:

```bash
set -o pipefail
pnpm test:fast 2>&1 | tee /tmp/blackdogbot-tests.log
```

Read the final test summary and any failed assertions from that log. Do not let a
pipeline's last command turn a test failure into success.

Run one file during development:

```bash
pnpm exec vitest run tests/unit/migrations/data-migrations.test.ts
```

Use a focused test for the changed behavior, then run the required checks before
merging. Do not replace behavior tests with assertions that source code contains
a particular variable name or implementation pattern.


## Upgrade and release checks

The migration suites include native LanceDB copies, historical task fixtures,
configuration conflicts, source changes during copying, and interrupted recovery.
Startup tests execute the actual initialization boundary with mocks and verify
that pending releases cannot start skills, MCP, message polling, outbox delivery,
scheduled tasks, or Brain commands.

Python tests cover supervisor acceptance, service conversion, publication retries,
and bootstrap checkout of annotated tags and full commit IDs. Filesystem and Git
fixtures stay in temporary directories. They do not stop or start the host bot.

Backup-retention tests verify corruption preservation, current and unresolved
recovery references, deployment lock exclusion, and changes during retirement.
Release tests verify exact commit pins, checksums, interrupted draft uploads,
metadata drift, and tag changes during publication.

The release workflow resolves its source commit once. Every Node matrix job and
the publication job use that same SHA. A version tag must still identify that
commit before the release is made public.
