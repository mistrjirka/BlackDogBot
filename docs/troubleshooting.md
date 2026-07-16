# BlackDogBot Troubleshooting Guide

## Bot Not Responding

1. Verify platform token values in `~/.blackdogbot/config.yaml`.
2. Start or restart daemon: `pnpm start`.
3. Check logs: `tail -f ~/.blackdogbot/logs/blackdogbot.log`.

## Discord Message Handling Issues

Enable required privileged intents in Discord Developer Portal:

- Message Content Intent
- Server Members Intent (if your setup requires it)

## Embedding Download/Initialization Issues

First run may download embedding assets.

1. Verify internet connectivity.
2. Clear local Hugging Face cache if corrupted: `rm -rf ~/.cache/huggingface/`.
3. Restart the bot.

## Startup Fails With Exit Code 132

`132` usually means `SIGILL` (illegal instruction) from a native addon.

1. Rebuild required native modules:
   `pnpm rebuild better-sqlite3 sharp`
2. Verify runtime imports manually:
   `node -e "require('better-sqlite3'); require('sharp'); import('@huggingface/transformers').then(() => console.log('ok'))"`
3. Retry startup: `pnpm start`

If step 2 still exits with `132`, the machine CPU is not compatible with one of the prebuilt native binaries.

## Native Module ABI Mismatch

If startup reports that `better_sqlite3.node` was compiled against a different Node.js version, reinstall dependencies using the same Node.js runtime that starts the daemon:

```bash
pnpm install
node -e "require('better-sqlite3'); console.log('better-sqlite3 ok')"
```

The project uses `better-sqlite3@12.11.1`, which supports Node.js 26. Do not reuse a `node_modules` directory built under another Node.js major version.

## Optional Web Services Not Working

If web search/scrape tools fail:

1. Start optional services:
   `docker compose -f ~/.blackdogbot/docker-compose.yaml up -d`
2. Verify SearXNG: `curl "http://localhost:18731/search?q=test&format=json"`
3. Verify Crawl4AI: `curl "http://localhost:18732/health"`

## Cron Notifications Missing

1. Enable notifications for your chat/channel.
2. Confirm channel notification flag in `~/.blackdogbot/channels.yaml`.
3. Confirm task has `notifyUser: true`.
