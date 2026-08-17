---
name: news-digest
description: Produce a curated, deduplicated news digest from RSS feeds and/or web search, persist interesting items, and deliver a formatted summary. Use for any scheduled or on-demand news briefing task.
homepage: null
userInvocable: true
disableModelInvocation: false
commandDispatch: null
commandTool: null
commandArgMode: null
metadata:
  openclaw:
    always: false
    emoji: "📰"
    homepage: null
    os: []
    requires:
      bins: []
      anyBins: []
      env: []
      config: []
    primaryEnv: null
    skillKey: null
    install: []
---

# News Digest

Turn raw news sources into a short, readable digest. You are an intelligent agent: use judgment for filtering and grouping, but never invent items, titles, or links.

## When to use

- Scheduled tasks that say "news digest", "morning briefing", "what's new in X", or similar.
- On-demand requests like "give me the latest on <topic>".

## Inputs (from the task instructions)

- **Sources**: one or more RSS feed URLs, and/or a search topic for `searxng`. If the task names no sources and none can be derived, stop and say what is missing — do not guess feeds.
- **Time window**: "since last run" (default), "last 24h", or explicit.
- **Audience/length**: default is a compact digest (5–10 items).

## Workflow

1. **Fetch** each RSS source with `fetch_rss` (unseen mode is the default — already-delivered items are filtered by the tool's seen-state). For search topics, use `searxng` with a freshness filter matching the time window.
2. **Merge and deduplicate** across sources: the same story from multiple feeds is ONE item — keep the best title/summary, note the primary source.
3. **Filter and rank** with `think`: keep items that are newsworthy for this audience (significance, novelty, relevance to the task's topic). Drop routine filler, press releases without substance, and duplicates of items already in `news_items`.
4. **Persist** the kept items to the `news_items` table with `write_table_news_items` (create the table first with `create_table` if it does not exist — schema below). Persist BEFORE sending so a crashed run cannot double-send.
5. **Compose** the digest in the format below.
6. **Deliver** with `send_message` (it deduplicates internally). If the task set `notifyUser`, your final text is also forwarded automatically — keep the final text equal to the digest, not a meta-commentary.

## Standard schema: news_items

| column | type | notes |
|---|---|---|
| id | INTEGER | primary key |
| source | TEXT | feed name or "searxng" |
| title | TEXT | |
| link | TEXT | unique — use it for dedup checks |
| published_at | TEXT | ISO 8601 from the feed |
| summary | TEXT | 1–2 sentences, your own words |
| interesting | INTEGER | 1 if kept in a digest, 0 if stored but not sent |
| fetched_at | TEXT | ISO 8601, now |

Before writing, check `read_from_database` on `news_items` (e.g. `WHERE link = ...` or recent titles) to avoid persisting duplicates.

## Digest format

```
📰 <Name> — <date>

**<Topic or source group 1>**
- **<Item title>** — <one-line summary> (<link>)
- ...

**<Topic or source group 2>**
- ...

_N items from M sources._
```

- Group by theme when items allow it; otherwise by source.
- 5–10 items total unless the task says otherwise.
- Every item needs a real link from the feed — no fabricated URLs.
- If a source failed to fetch, add a one-line footer: `⚠️ <source> failed: <short reason>`.

## Nothing new

If there are no new interesting items: send a single short line ("No new items since last run.") only when the task expects a confirmation; otherwise end without sending.

## Pitfalls

- Never send an item that `fetch_rss` marked as already seen, or that is already in `news_items` with `interesting = 1`.
- A failed feed is not fatal — continue with the rest and report it in the footer.
- Keep summaries factual; do not add opinion, prediction, or commentary beyond what the source states.
- Respect the time window: an old item resurfacing in a feed is not news.
