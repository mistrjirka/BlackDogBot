# BlackDogBot Commands Guide

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Initialize the bot for the chat. |
| `/help` | Show command help. |
| `/clear` | Clear conversation history for this chat. |
| `/cancel` | Stop the current generation and clear the active prompt. |
| `/reset [name\|all]` | Reset one prompt (or all prompts) to factory defaults. |
| `/update_prompts` | Refresh prompts from source defaults. |
| `/factory_reset` | Wipe local data and restore factory defaults. |
| `/notifications_enable` | Enable cron notifications for this chat. |
| `/notifications_disable` | Disable cron notifications for this chat. |
| `/status` | Show chat permission and notification status. |
| `/add_mcp_server` | Add an MCP server from JSON config. |
| `/list_mcp_servers` | List configured MCP servers. |
| `/remove_mcp_server <id>` | Remove an MCP server by id. |
| `/mcp_status` | Show MCP connection/tool status. |

## Discord Commands

- Slash command: `/cancel` (stops current generation).
- Most interaction is plain chat messages in allowed channels.

## Channel Permissions

Each channel has one permission level:

| Level | Description |
|-------|-------------|
| `ignore` | Bot does not respond. |
| `read_only` | Bot responds with safe tools only (no destructive actions). |
| `full` | Bot can use the full toolset. |

Default registration behavior:

- Telegram channels are auto-registered as `full`.
- Discord channels are auto-registered as `read_only`.
