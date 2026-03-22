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
