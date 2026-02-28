# Telegram Channel — Design

**Date:** 2026-02-28
**Status:** Approved

## Overview

Add a public Telegram channel that receives the daily digest automatically after generation. This is the first delivery target beyond Twitter; a general-purpose Telegram module makes future post types (weekly Pharos changelog, etc.) trivially easy to add.

## Architecture

A generic `worker/src/lib/telegram.ts` utility module with a single `sendToTelegram(text, env)` function. The daily digest cron calls it after storing the digest — non-fatal, same pattern as the existing `worker/src/lib/twitter.ts`. Future crons import the same function.

No unified notification abstraction — just a reusable utility. YAGNI.

## Components

### `worker/src/lib/telegram.ts` (new, ~50 lines)

- `sendToTelegram(text: string, env: Env): Promise<void>`
- POSTs to `https://api.telegram.org/bot{token}/sendMessage`
- Graceful no-op if `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` not set (allows staging environments without credentials)
- HTML parse mode (simpler escaping than MarkdownV2)
- `disable_web_page_preview: false` — let Telegram preview the digest page link
- Non-fatal: logs a warning on failure, never throws

### `worker/src/cron/daily-digest.ts` (small addition)

After storing the digest, call `sendToTelegram()` with the following format:

```
<b>{title}</b>

{extended}

<a href="https://pharos.watch/digest/{date}">Read on Pharos →</a>
```

The `date` is derived from `generatedAt` (Unix seconds → `YYYY-MM-DD`).

### `worker/src/index.ts` (small addition)

The existing `/api/trigger-digest` admin endpoint already calls the Twitter post. Wire `sendToTelegram()` in the same place so force-triggered digests also post to Telegram.

### Worker `Env` interface (small addition)

Add two optional fields wherever `Env` is declared:

```ts
TELEGRAM_BOT_TOKEN?: string;
TELEGRAM_CHAT_ID?: string;
```

### New Worker secrets

Added via `wrangler secret put`:

- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_CHAT_ID` — channel username (e.g. `@pharos_watch`) or numeric ID

## Setup (manual, one-time)

1. Create a bot via @BotFather → receive `BOT_TOKEN`
2. Create the public channel, add the bot as admin with "Post Messages" permission
3. Get the channel's `CHAT_ID` (username or numeric)
4. `cd worker && npx wrangler secret put TELEGRAM_BOT_TOKEN`
5. `cd worker && npx wrangler secret put TELEGRAM_CHAT_ID`

## Error Handling

- Missing credentials → no-op (safe for local dev / staging)
- Telegram API error → `console.warn`, digest unaffected
- Network timeout → same as above

## Future Post Types

Any new cron (e.g. `weekly-changelog.ts`) imports `sendToTelegram` and formats its own message. No changes needed to the Telegram module itself.

## Files Changed

```
worker/src/lib/telegram.ts          ← new
worker/src/cron/daily-digest.ts     ← add sendToTelegram call
worker/src/index.ts                 ← add sendToTelegram call in trigger-digest handler
worker/src/types.ts (or Env type)   ← add TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
```
