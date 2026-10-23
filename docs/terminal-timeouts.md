# Terminal and model response deadlines

Terminal commands and model responses use separate clocks.

| Operation | Default | Effect |
| --- | --- | --- |
| Foreground run_cmd | 30 seconds | Stops the command and its current children |
| Background run_cmd | 10 minutes | Stops the command and its current children |
| run_cmd with timeout=0 | No deadline | Keep the process until it exits or stop_cmd cleans it up |
| wait_for_cmd.timeoutMs | 2 minutes | Stops polling only. The command stays alive |
| Local model request | Configured requestTimeoutMs, normally 10 minutes | Cancels the HTTP request. One transport retry receives twice the deadline |

Execution deadlines continue while the model thinks between tool calls. For an
interactive session, input test, or stop test, start run_cmd with background mode
and timeout=0. Read its output, send input, then collect the result with
wait_for_cmd. Use stop_cmd in cleanup. Use a short explicit execution deadline
only when testing timeout behavior.

All commands use one PTY implementation. Files survive separate shell calls.
Running processes accept repeated input through their handle until they exit or
the bot restarts. A PTY combines command stdout and stderr into stdout.
run_cmd_input accepts either `input` for decoded text or `controlKey` for a
named key such as `CTRL_C`, `CTRL_D`, `CTRL_U`, `TAB`, or `ENTER`. Special keys
never append a newline; ordinary text does unless appendNewline=false. Printable
backslash escape notation is not itself a control byte. Terminal echo is not
proof that an application read input. Input to a stopped process fails explicitly.

stop_cmd snapshots the command's current descendants and their process start
times. It signals children and the PTY wrapper, then escalates to SIGKILL after
five seconds if needed. A recycled PID is never signalled. Terminal status is
published after cleanup and pipe drain. The stopped handle remains available
for final status/output. wait_for_cmd collects and removes a finished handle.
The cleanup targets current descendants. A daemon that detached and was
reparented before the snapshot is outside that tree.

The model transport uses its own Undici dispatcher. It disables the hidden
HTTP parser deadlines only for model traffic, leaving the configured
AbortSignal deadline in control. Non-streaming requests retain that deadline
through receipt of the full body. Logs report elapsed waiting time and nested
transport error codes. Elapsed waiting time is not proof of token generation.
No output-token limit is added.

Agent retries count consecutive failures. A completed model/tool step resets
the error budget. Existing in-flight history preserves completed tool results.
An exhausted transport timeout is not multiplied by another generic agent
retry loop. User cancellation does not trigger a retry.

## Regression checks

Run:

```sh
pnpm exec tsc --noEmit
pnpm exec vitest run tests/integration/core/run-cmd-pty.test.ts tests/unit/ai-provider-transport.test.ts tests/unit/utils/llm-fetch.test.ts tests/unit/retry-orchestrator.test.ts
pnpm test:fast
```

The PTY tests call the actual tools across separate invocations. They check
recorded parent/child PIDs and process state, not grep counts. A zombie is no
longer running. Tests clean up their processes even after a failed assertion.

The added cases reproduced orphan children for SIGTERM, SIGINT, and SIGKILL,
premature timeout results, and false success for input to a finished process
before the fixes. Ordinary Bash scripts are not a substitute for these tests.
Any diagnostic script must exit nonzero when assertions fail and report actual
pass, fail, and not-tested totals.

## Verified on 2026-10-23

- Latest full unit/core suite: 1,046 tests passed across 113 files.
- TypeScript type check and git diff --check passed.
- A real HTTP server withheld headers for 310 seconds. The scoped transport
  returned the correct response after 310,035 ms, beyond the old cutoff.
- The earlier terminal/transport revision was restarted successfully. The latest input/output safety changes require another service restart.
- No model output-token caps were added. No new agent-facing tools were added.
