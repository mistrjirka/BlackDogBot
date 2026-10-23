# Safe MCP configuration and verification

BlackDogBot reads MCP registrations from `~/.blackdogbot/mcp-servers.json`. Local stdio entries have `command` and `args`; HTTP entries have `url` and optionally `transport: "http"`, `headers`, `env`, `strictOutputSchema`, and `allowedTools`. A newly installed server becomes available to the model when the **next agent turn** initializes its tools.

## Merge atomically, preserve other servers

Before touching a production config, inspect the server ID and proposed command or endpoint. Never overwrite an existing ID without intending to update it. Avoid editing JSON by string concatenation.

Use `run_cmd` to run a short Python program from the project directory, with `NEW_MCP_ID` and `NEW_MCP_CONFIG` supplied for the chosen server (do not print the values when they contain secrets):

```python
import json, os, pathlib, shutil, tempfile, re, time
p = pathlib.Path.home() / ".blackdogbot" / "mcp-servers.json"
server_id = os.environ["NEW_MCP_ID"]
server = json.loads(os.environ["NEW_MCP_CONFIG"])
assert re.fullmatch(r"[A-Za-z0-9_-]+", server_id)
document = json.loads(p.read_text()) if p.exists() else {"mcpServers": {}}
assert isinstance(document.get("mcpServers"), dict)
assert server_id not in document["mcpServers"], "Already installed: review before updating"
backup = p.with_name(p.name + f".backup-{time.time_ns()}")
if p.exists():
    shutil.copy2(p, backup)
document["mcpServers"][server_id] = server
fd, temp_path = tempfile.mkstemp(dir=p.parent, prefix=".mcp-edit-")
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(document, f, indent=2)
        f.write("\n")
    os.replace(temp_path, p)
except BaseException:
    if os.path.exists(temp_path):
        os.unlink(temp_path)
    raise
```

For repeated installations, **do not reuse an old backup**: name each backup with a unique timestamp. For a failed attempt, restore the backup atomically, then verify previously connected servers still work. Never delete other server entries.

If secrets are necessary, do not include them in Telegram text, shell history, tracked files, or stdout. Prefer protected environment files or server-native credential storage. The MCP JSON file itself must remain accessible only to the bot user (`chmod 600`). Editing a configured server's secrets without refreshing the process environment may require a separate safe reconnection or explicit user authentication.

## Test server functionality

- **Stdio:** verify the actual executable/version, launch the MCP process via `@modelcontextprotocol/sdk`'s `StdioClientTransport`, call `listTools`, and perform one harmless `callTool`. Terminate test processes on completion. Do not treat the server's stdout as ordinary terminal output: stdio stdout carries JSON-RPC.
- **Remote HTTP:** verify the endpoint and transport type (HTTP vs SSE); perform an MCP `initialize` and `listTools` using the matching SDK transport rather than guessing that GET / returns a webpage.
- **Tool exposure:** compare discovered server-side names with `allowedTools` and the effective `strictOutputSchema`. If all tools disappear under strict mode because `outputSchema` is absent, use a narrowly scoped exception and allowlist.
- **Reload:** BlackDogBot reloads the edited config before the **next new chat turn**. An already-running tool set is intentionally not mutated mid-generation. The agent can verify the new MCP server itself using the SDK via terminal now, then report that its namespaced tools will be ready on the next turn.
- **Inspect logs safely:** `journalctl --user -u blackdogbot.service --since '10 minutes ago' --no-pager`, filtering for server connection status; avoid printing authentication headers or whole configs.

Useful diagnostics: `npx --version`, `node --version`, package version, binary path, executable permissions, browser dependencies, listening interface, endpoint reachability, and any connection/discovery warnings.

## Uninstallation and rollback

Remove the single named registry entry using another safe JSON edit, preserving all others, or restore the most recent known-good backup. On next turn the MCP manager closes removed connections. Never delete a shared browser executable, package cache, or unrelated files just because a server was removed.

Stop after a few meaningfully different diagnostics. If credentials, package source, access approval, or root permissions are the blocker, state that specific blocker and avoid repeated blind retries.
