# Telegram Alert Bot

## Overview

Pharos runs a Telegram bot for opt-in stablecoin alerts.

The subsystem has three moving parts:

- `POST /api/telegram-webhook` accepts Telegram commands, validates the shared secret in the query string, and stores subscriber state in D1.
- `worker/src/cron/dispatch-telegram-alerts.ts` diffs the latest DEWS, active depeg, and safety-grade snapshots against cached prior snapshots, then fans out consolidated messages to matching subscribers.
- `worker/src/lib/telegram.ts` and `worker/src/lib/telegram-alerts.ts` handle Bot API sends, ticker parsing, message formatting, and HTML escaping.

This is a worker-only feature. The frontend does not call it directly.

## Files

- `worker/src/api/telegram-webhook.ts`
- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/lib/telegram.ts`
- `worker/src/lib/telegram-alerts.ts`
- `worker/migrations/0054_telegram_subscribers.sql`
- `worker/migrations/0060_telegram_pending_alerts.sql`
- `scripts/register-telegram-webhook.sh`

## D1 Schema

`worker/migrations/0054_telegram_subscribers.sql` creates the subscriber/subscription/disambiguation tables, and `worker/migrations/0060_telegram_pending_alerts.sql` adds the overflow delivery queue:

| Table | Purpose | Key fields |
|-------|---------|------------|
| `telegram_subscribers` | Per-chat subscriber preferences | `chat_id`, `username`, `alert_dews`, `alert_depeg`, `alert_safety`, `created_at`, `last_active_at` |
| `telegram_subscriptions` | Per-chat stablecoin subscriptions | composite PK `chat_id, stablecoin_id` |
| `telegram_pending_disambiguation` | Short-lived state for ambiguous ticker replies | `chat_id`, `alert_types`, `resolved_ids`, `ambiguous_ticker`, `candidates`, `remaining_tickers`, `expires_at` |
| `telegram_pending_alerts` | Overflow delivery queue | `id`, `chat_id`, `message_html`, `disable_notification`, `created_at`, `attempts` |

The webhook also uses the generic `cache` table key `telegram:last-update-id` to deduplicate Telegram update re-delivery.

## Secrets and Bindings

| Binding | Required | Used by |
|---------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | Webhook replies, digest posting, subscriber alert fan-out |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Query-string secret validation for `POST /api/telegram-webhook` |
| `TELEGRAM_CHAT_ID` | No | Daily digest channel posting only |

Webhook registration is handled by `scripts/register-telegram-webhook.sh`, which calls Telegram `setWebhook` for:

`https://api.pharos.watch/api/telegram-webhook?secret=<TELEGRAM_WEBHOOK_SECRET>`

## Webhook Command Flow

`worker/src/api/telegram-webhook.ts` accepts only Telegram-origin webhook posts that include the configured `secret` query param. Invalid secrets, missing bot token, malformed JSON, and non-command messages all return `200 ok` without side effects so Telegram does not keep retrying.

### Supported Commands

| Command | Behavior |
|---------|----------|
| `/start` | Sends onboarding copy and example usage |
| `/help` | Sends command reference |
| `/list` | Returns enabled alert types plus subscribed coins for the chat |
| `/subscribe <types> <tickers>` | Enables one or more alert types and subscribes the chat to one or more coins |
| `/unsubscribe <tickers>` | Removes specific coin subscriptions |
| `/unsubscribe all` | Clears all subscriptions and disables all alert-type flags |

### Alert Types

- `dews`
- `depeg`
- `safety`

### Ticker Resolution

Ticker parsing lives in `worker/src/lib/telegram-alerts.ts` and is built from `TRACKED_STABLECOINS`.

- Resolution is symbol-first and case-insensitive.
- Unique matches subscribe immediately.
- Ambiguous symbols create a row in `telegram_pending_disambiguation`.
- Users reply with `1` or `1,2` style selections.
- Pending disambiguation rows expire after `5 minutes`.
- Unknown tickers return a contextual error, with a prefix-based suggestion when available.

### Update Deduplication

Telegram may redeliver the same `update_id`. The webhook stores the highest processed update in `cache("telegram:last-update-id")` and only processes strictly newer IDs.

## Dispatch Cron

`dispatchTelegramAlerts(db, botToken, signal?)` runs on a dedicated 5-minute cron slot
(`2,7,12,17,22,27,32,37,42,47,52,57 * * * *`), isolated from the quarter-hourly pipeline.

It no longer runs inside the quarter-hourly or daily slots. Safety-grade changes from the
daily `snapshot-safety-grade-history` job are detected within 5 minutes of the snapshot completing.

### Snapshot Inputs

Each dispatch run loads:

- Latest DEWS rows from `stress_signals`
- Active depegs from `depeg_events WHERE ended_at IS NULL`
- The latest `safety_grade_history` row for each stablecoin (not just the latest change day)
- Prior dispatch snapshots from cache keys:
  - `alert:dews-snapshot`
  - `alert:depeg-snapshot`
  - `alert:safety-snapshot`

Snapshots older than `24 hours` are treated as stale and are reseeded before any alerts are sent.

### First-Run / Stale-Snapshot Behavior

If any snapshot is missing, unparsable, or older than 24 hours:

1. Current DEWS/depeg/safety state is written back to the three snapshot cache keys.
2. No subscriber messages are sent for that run.
3. The cron returns metadata with `snapshotSeeded: true`.

This prevents a cold start from blasting subscribers with every current condition as if it were a new event.

### Alert Detection Rules

`worker/src/cron/dispatch-telegram-alerts.ts` detects:

- DEWS band escalations and de-escalations by comparing current band to prior band
- New active depeg events by comparing current active-depeg snapshot to the prior snapshot
- Depeg resolutions by checking which prior active depegs disappeared and then loading the corresponding closed event rows
- Safety-grade changes by comparing each coin's latest `safety_grade_history` row to the prior snapshot

If the cached safety snapshot is missing a coin, the dispatcher suppresses the alert unless that coin's latest grade-change row is newer than the cached snapshot timestamp. This avoids false `UNKNOWN → grade` alerts when repairing older partial snapshots or when a newly tracked coin gets its first seed row.

The helper predicates `isDewsAlertable()` and `isDewsDeescalation()` live in `worker/src/lib/telegram-alerts.ts`.

### Subscriber Filtering

Subscribers are selected by joining:

- `telegram_subscriptions`
- `telegram_subscribers`

Each alert type checks the corresponding boolean flag column:

- `alert_dews`
- `alert_depeg`
- `alert_safety`

### Message Formatting and Limits

- Messages are HTML-formatted via `formatConsolidatedMessage()`.
- Long messages are split with `splitMessage(html, 4000)`.
- `sendBatch()` posts in parallel batches of 5 (staying under Workers 6-connection limit).
- Hard cap: `200 subscriber deliveries per dispatch run`.
- Overflow subscribers are enqueued to `telegram_pending_alerts` and drained in subsequent runs.
- Pending alerts expire after `1 hour` (3600s) — stale alerts are cleaned up automatically.

When Telegram returns `403`, the send helper reports `{ blocked: true }` and the dispatcher
disables that user's alert flags to stop repeated failures.

### Pending Delivery Queue

When the subscriber queue exceeds the per-run cap (200), overflow messages are written
to `telegram_pending_alerts` in D1 as pre-split HTML chunks. Each subsequent dispatch run
drains up to 25% of its budget from the pending queue before processing fresh events,
ensuring eventual delivery.

Pending alerts have a 1-hour TTL. Rows older than the TTL are deleted at the end of each
run. Failed sends retry up to 2 times (3 attempts total) before being dropped.

This design ensures snapshots always stay current (events are never "held back") while
guaranteeing delivery for large subscriber populations.

## Admin Visibility

`GET /api/status` now exposes a `telegramBot` block for the private `/status` dashboard. It aggregates:

- total known chats in `telegram_subscribers`
- alert-enabled chats vs deliverable chats (enabled + at least one subscribed coin)
- total `telegram_subscriptions` rows and average follows per subscribed chat
- pending disambiguation replies still within TTL
- per-alert-type enablement counts (`dews`, `depeg`, `safety`, all three)
- top subscribed stablecoins by subscriber count

The status page also reads `crons["dispatch-telegram-alerts"].lastRun.metadata` to show the latest delivery run stats (`subscribersNotified`, `messagesSent`, `blockedUsersCleanedUp`, `eventsDetected`, `snapshotSeeded`, `cappedAtLimit`).

### Circuit Breaker

The dispatcher is protected by `CIRCUIT_SOURCE.TELEGRAM_API`.

- Open circuits skip fan-out.
- Successful snapshot seeding or alert delivery records a successful outcome.
- Failed sends record an unsuccessful outcome.

## Message Types

Formatting helpers in `worker/src/lib/telegram-alerts.ts` emit:

- DEWS band transitions with top two stress sub-signals
- Depeg-triggered messages with direction, bps deviation, and price
- Depeg-resolved messages with duration, peak deviation, and recovery price
- Safety-grade changes with old/new grade and score when present

Every consolidated message ends with a `View on Pharos` link.

## Digest vs Subscriber Alerts

The same bot token can be used for both:

- Channel-style digest posting via `postDigestToTelegram(...)`
- Direct chat replies and subscriber alerts via `sendToChat(...)`

Digest posting uses `TELEGRAM_CHAT_ID`; subscriber alerts use the chat IDs stored in `telegram_subscribers`.

## Operational Notes

- Run `scripts/register-telegram-webhook.sh` after rotating `TELEGRAM_BOT_TOKEN` or `TELEGRAM_WEBHOOK_SECRET`.
- The webhook intentionally returns `200` on most malformed or unauthorized cases so Telegram does not keep retrying noisy payloads.
- The dispatcher consumes Bot API response bodies before returning, which matters under the Workers per-trigger connection cap.
