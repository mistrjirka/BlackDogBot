---
name: coding-workflow
description: Use only when the user asks to write, edit, debug, test, review, or maintain source code. Optional coding workflow using existing terminal and file tools; not for general assistance.
userInvocable: true
disableModelInvocation: false
---

# Coding workflow

Ordinary coding is already possible with existing tools. Do not request extra Git, package-install, or test-runner tools unless the existing shell approach fails.

1. Inspect the project and repository before editing. Use run_cmd with an explicit cwd; Git, rg, language tooling, and tests run through the shell.
2. For edits use read_file, write_file, edit_file; absolute paths are needed outside the bot workspace. run_cmd can also run scripts to make changes. Inspect changes with git diff and git diff --check.
3. Run relevant tests after modifications. Report actual passes, failures, and anything untested.
4. For short terminal commands use run_cmd foreground. For interactive programs, REPLs, and long-lived servers use background, then the handleId with run_cmd_input, get_cmd_output, wait_for_cmd, and stop_cmd. Prefer the `controlKey` option for special keys, e.g. `{"handleId":"...","controlKey":"CTRL_C"}`; use `input` for text. Tool descriptions define exact key names and encoding. Never assume terminal echo means the target application processed a command. Handles survive between calls but not daemon restarts.
5. Prefer project-local dependency installs and Python virtual environments. Do not make global changes or push to remote repositories without user approval.
6. Respect existing code and repository state; avoid creating wrapper tools or unnecessary abstractions.

All commands run inside a PTY; program stdout and stderr are combined, and terminal applications may emit ANSI escape sequences. Files persist across commands, but each run_cmd call starts a new shell.

Use background mode for tests that need later input or stop calls. Set timeout=0 for these sessions, then stop_cmd during cleanup. Execution deadlines otherwise keep running while you think. wait_for_cmd.timeoutMs only limits polling. Verify child cleanup using recorded PIDs and process state, never grep counts. A diagnostic script must exit nonzero if any assertion fails and report PASS/FAIL/NOT TESTED totals.
