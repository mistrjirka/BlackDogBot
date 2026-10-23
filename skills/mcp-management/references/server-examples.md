# Example MCP servers (adapt, don't blindly install all)

Check whether the capability already exists before adding a server. These packages are from the official [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) project. The pinned 2.0.0 examples require Node.js 24+ (the currently inspected host has Node 26). Use `npm view <package> version engines` to verify versions when installing.

All examples below are **single-server entries** to merge under `mcpServers` in `~/.blackdogbot/mcp-servers.json`. They are not a complete configuration file. Preserve unrelated entries.

## Filesystem (limited to a dedicated workspace)

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem@2.0.0", "/home/jirka/.blackdogbot/workspace"],
  "allowedTools": [
    "read_text_file", "read_media_file", "read_multiple_files",
    "list_directory", "list_directory_with_sizes", "directory_tree",
    "search_files", "get_file_info", "list_allowed_directories"
  ]
}
```

Create the workspace directory before starting the server. The directory argument limits the filesystem server's accessible paths. The allowlist further exposes only its read tools; read-only **tool exposure alone is not a filesystem security sandbox**. Use a dedicated filesystem identity/container for stronger isolation. If the user specifically needs writing, add only the required tools such as `write_file` with an explicit directory boundary. Do not expose the entire home directory by default.

BlackDogBot already has general-purpose file tools, so this MCP server is often redundant.

## Local knowledge graph memory

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-memory@2.0.0"],
  "env": {
    "MEMORY_FILE_PATH": "/home/jirka/.blackdogbot/mcp-memory.jsonl"
  },
  "allowedTools": [
    "create_entities", "create_relations", "add_observations",
    "read_graph", "search_nodes", "open_nodes"
  ]
}
```

This MCP memory server stores data in a local JSONL file. Protect that file and its directory. Choose only the functions needed; avoid delete tools unless requested. Its storage is **separate** from BlackDogBot's own session, knowledge, and skill state. Do not duplicate memory systems if the existing bot features already meet the need.

## Remote HTTP MCP (provider-specific)

```json
{
  "url": "https://YOUR-PROVIDER.example/mcp",
  "transport": "http",
  "allowedTools": ["a_real_read_only_tool_name"]
}
```

This is **a template, not a working server URL**. Obtain the exact endpoint, authentication method, and verified tool names from the provider. SSE is only for servers that explicitly require `transport: "sse"`. Never guess OAuth credentials or paste bearer tokens into a chat or Git repository. Keep the MCP registry private (`0600`) if headers contain secrets. If the provider requires user consent or account access, explain the precise missing step.

## Discovery and verification

Use an MCP SDK client over the declared transport to call `listTools` and a harmless operation. A package being installed does not prove the tool is reachable. Check per-server `strictOutputSchema`, which defaults to true; if all otherwise-valid tools lack output schemas, disable strict filtering only for that server and keep `allowedTools` narrow.

For the full safe config edit/rollback process load [configuration.md](configuration.md). For browser automation load [playwright.md](playwright.md).
