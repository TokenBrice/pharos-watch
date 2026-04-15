# Telegram Alert Bot

## Overview

Pharos runs a Telegram bot for opt-in stablecoin alerts and channel posts.

The subsystem has four moving parts:

- `POST /api/telegram-webhook` accepts Telegram commands, validates the shared secret from `X-Telegram-Bot-Api-Secret-Token`, and stores subscriber state in D1.
- `worker/src/cron/dispatch-telegram-alerts.ts` diffs the latest DEWS, active depeg, and safety-grade snapshots against cached prior snapshots, then fans out consolidated messages to matching subscribers.
- `worker/src/cron/daily-digest.ts` appends pending cemetery additions and newly tracked coins to the next Telegram digest post after a deploy.
- `worker/src/lib/telegram.ts`, `worker/src/lib/telegram-alerts.ts`, `worker/src/lib/telegram-presets.ts`, and `worker/src/lib/telegram-digest-appendices.ts` handle Bot API sends, ticker parsing, preset resolution, message formatting, diffing, and HTML escaping.

The delivery system is worker-owned. The frontend exposes a static `/telegram/` landing page plus a lightweight public telemetry strip sourced from `GET /api/telegram-pulse`; it does not call any mutating bot APIs directly.

## Files

- `worker/src/api/telegram-webhook.ts`
- `worker/src/api/telegram-webhook-shared.ts`
- `worker/src/api/telegram-webhook-parsing.ts`
- `worker/src/api/telegram-webhook-messages.ts`
- `worker/src/api/telegram-webhook-store.ts`
- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/cron/daily-digest.ts`
- `worker/src/lib/telegram.ts`
- `worker/src/lib/telegram-alerts.ts`
- `worker/src/lib/telegram-presets.ts`
- `worker/src/lib/telegram-digest-appendices.ts`
- `src/app/telegram/page.tsx`
- `src/app/telegram/telegram-pulse-strip.tsx`
- `src/hooks/use-telegram-pulse.ts`
- `worker/src/api/telegram-pulse.ts`
- `worker/migrations/0000_baseline.sql`
- `worker/migrations/MANIFEST.md`
- `scripts/register-telegram-webhook.sh`

## Frontend Landing Page

`src/app/telegram/page.tsx` is a static product-facing explainer for the Telegram feature set.

- Route: `/telegram/`
- Covers the public `@pharoswatch` digest channel, the `@pharoswatchers` community channel, and the `@PharosWatchBot` subscription bot
- Reads `GET /api/telegram-pulse` for the lightweight watcher/subscription pulse strip
- Does not call the webhook or any other mutating bot API; it links users to Telegram plus the on-site digest archive

## D1 Schema

The Telegram subscriber, disambiguation, and overflow-queue tables are part of `worker/migrations/0000_baseline.sql`. [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md) records the pre-squash lineage, including the historical migrations that introduced the subscriber, overflow-queue, and global-alert columns:

| Table | Purpose | Key fields |
|-------|---------|------------|
| `telegram_subscribers` | Per-chat state and defaults | `chat_id`, `username`, legacy default flags, `global_alert_dews`, `global_alert_depeg`, `global_alert_safety`, `global_alert_launch`, `quiet_hours_enabled`, `quiet_hours_start_utc`, `quiet_hours_end_utc`, `created_at`, `last_active_at` |
| `telegram_subscriptions` | Per-chat per-coin alert preferences | composite PK `chat_id, stablecoin_id`, `alert_dews`, `alert_depeg`, `alert_safety`, `alert_launch`, `dews_min_band`, `safety_mode`, `depeg_worsening_bps_step` |
| `telegram_pending_disambiguation` | Short-lived state for ambiguous ticker replies | `chat_id`, `action_type`, `action_payload`, `resolved_ids`, `ambiguous_ticker`, `candidates`, `remaining_tickers`, `expires_at` |
| `telegram_pending_alerts` | Overflow delivery queue | `id`, `chat_id`, `message_html`, `disable_notification`, `created_at`, `attempts` |

The webhook also uses the generic `cache` table key `telegram:last-update-id` to deduplicate Telegram update re-delivery.

## Secrets and Bindings

| Binding | Required | Used by |
|---------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | Webhook replies, digest posting (including appended cemetery / tracking notices), subscriber alert fan-out |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Telegram webhook secret validation for `POST /api/telegram-webhook` via `X-Telegram-Bot-Api-Secret-Token` |
| `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` | No | Temporary 24-hour overlap secret accepted by `POST /api/telegram-webhook` during secret rotation; registration still emits only `TELEGRAM_WEBHOOK_SECRET` |
| `TELEGRAM_CHAT_ID` | No | Daily digest channel posting, including appended cemetery and tracking notices |

Webhook registration is handled by `scripts/register-telegram-webhook.sh`, which calls Telegram `setWebhook` with the webhook URL and the JSON `secret_token` field:

- URL: `https://api.pharos.watch/api/telegram-webhook`
- Secret token: `<TELEGRAM_WEBHOOK_SECRET>`

The dedicated five-minute Telegram worker lane now also reconciles the webhook registration in production on a cache-backed cadence. That means the live Worker periodically re-applies the configured webhook URL and secret token via Telegram `setWebhook`, which self-heals webhook-secret drift without requiring a separate manual script run.

### Webhook Secret Rotation

Telegram secret rotation uses a short overlap window:

1. Set the new `TELEGRAM_WEBHOOK_SECRET`.
2. Move the prior value into `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`.
3. Run the reconciliation flow so Telegram starts sending only the new current secret.
4. Keep the previous secret configured for up to 24 hours.
5. Remove `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` after the overlap window ends.

Receiver behavior accepts either current or previous secret during the overlap window. Registration and reconciliation always send only the current `TELEGRAM_WEBHOOK_SECRET`.

## Webhook Command Flow

`worker/src/api/telegram-webhook.ts` now acts as a thin ingress coordinator. Command parsing, message formatting, and D1 persistence live in the adjacent `telegram-webhook-*` helper modules so command behavior can be tested without editing the transport entrypoint.

The webhook validates the configured secret from `X-Telegram-Bot-Api-Secret-Token`. During rotation it accepts either `TELEGRAM_WEBHOOK_SECRET` or `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`. Invalid secrets, missing bot token, malformed JSON, and non-command messages all return `200 ok` without side effects so Telegram does not keep retrying.

### Supported Commands

| Command | Behavior |
|---------|----------|
| `/start` | Sends onboarding copy, example usage, and links to `@pharoswatch` and `@pharoswatchers` |
| `/help` | Sends command reference |
| `/presets` | Returns the preset watchlist catalog plus subscribe and unsubscribe examples |
| `/list` | Returns enabled alert types plus subscribed coins for the chat |
| `/subscribe <types> <targets>` | Enables one or more alert types and subscribes the chat to one or more explicit coins or preset watchlists |
| `/subscribe <types> all` | Enables one or more alert types across all tracked stablecoins |
| `/unsubscribe <targets>` | Removes explicit coin subscriptions and can also remove the coins covered by a preset watchlist |
| `/unsubscribe all` | Clears all per-coin subscriptions and disables every current alert flag, including launch |
| `/set <ticker> <setting> <value>` | Tunes per-coin settings such as DEWS floor, safety direction mode, or depeg worsening step |
| `/set all <setting> <value>` | Enables or disables global all-stablecoin alert types (`dews`, `depeg`, `safety`) |
| `/mute <start>-<end>` | Enables quiet hours in UTC (messages still deliver, notifications are silenced) |
| `/unmutehours` | Disables quiet hours |
| `/cancel` | Cancels a pending disambiguation flow |

### Alert Types

- `dews`
- `depeg`
- `safety`
- `launch`

### Preset Watchlists

Preset watchlists are a v1 convenience layer on top of the existing per-coin subscription model.

- Supported aliases: `usd-top10`, `usd-top25`, `usd-top50`, `eur-top10`, `gold-top5`, `mcap-ge-1b`, `mcap-ge-100m`
- Resolution happens at command time inside `worker/src/lib/telegram-presets.ts`
- The resolver uses the current strict `stablecoins` cache plus tracked stablecoin metadata to map each preset alias to concrete active coin IDs
- `/subscribe ... <preset>` expands the preset into normal `telegram_subscriptions` rows; v1 does not add a separate smart-subscription table
- `/unsubscribe <preset>` resolves the same alias and deletes those matching per-coin rows for the chat
- `/list` only shows the resulting coin rows; preset membership is not stored separately after expansion
- `launch` does not accept presets; launch alerts still require explicit ticker or coin-id targets
- Preset resolution fails closed when the stablecoins cache is unavailable; the bot returns a temporary retry message instead of subscribing stale or incomplete cohorts

Additional alert controls:

- `dews_min_band`: optional per-coin floor (`ALERT` default, or `WARNING` / `DANGER`)
- `safety_mode`: `all`, `downgrade-only`, or `upgrade-only`
- `depeg_worsening_bps_step`: optional per-coin worsening follow-up step (`100`, `250`, `500`)
- `global_alert_*`: subscriber-level flags that subscribe the chat to every tracked stablecoin for that alert type, including `launch`
- quiet hours: subscriber-level UTC hour window that forces `disable_notification = true`

`launch` alerts have no additional per-coin tuning beyond on/off subscription state.

Global subscriptions are additive, but explicit per-coin rows take precedence for that coin and alert type. That means a per-coin DEWS threshold or safety mode overrides the global default fan-out for the same chat/coin pair.

### Ticker Resolution

Ticker parsing lives in `worker/src/lib/telegram-alerts.ts` and is built from `TRACKED_STABLECOINS`.

- Resolution is symbol-first and case-insensitive.
- Preset aliases are matched before ticker resolution in the shared target parser.
- Unique matches subscribe immediately.
- Exact Pharos coin IDs resolve immediately and override symbol ambiguity.
- Both active and pre-launch tracked assets are eligible for explicit ticker or ID resolution; presets still expand active coins only.
- Ambiguous symbols create a row in `telegram_pending_disambiguation`.
- Users reply with `1` or `1,2` style selections.
- Pending disambiguation rows expire after `5 minutes`.
- Unknown tickers return a contextual error, with a prefix-based suggestion when available.
- Unknown preset aliases are reported through the same contextual error path, with `/presets` suggested as the discovery surface.
- `/cancel` clears a pending selection.
- `/help`, `/list`, and new mutating commands are not trapped behind pending disambiguation; only plain numeric replies are treated as selections.

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
  - `alert:dews-alertable-snapshot`
  - `alert:depeg-snapshot`
  - `alert:safety-snapshot`

When `alert:dews-alertable-snapshot` is absent (for example, immediately after deploy), the dispatcher rebuilds it from the raw DEWS snapshot so the rollout does not require a noisy cold start.

Snapshots older than `24 hours` are treated as stale and are reseeded before any alerts are sent.

### First-Run / Stale-Snapshot Behavior

If the raw DEWS/depeg/safety snapshots are missing, unparsable, or older than 24 hours, or if an existing `alert:dews-alertable-snapshot` is stale:

1. Current DEWS/depeg/safety state is written back to all four snapshot cache keys.
2. No subscriber messages are sent for that run.
3. The cron returns metadata with `snapshotSeeded: true`.

This prevents a cold start from blasting subscribers with every current condition as if it were a new event.

### Alert Detection Rules

`worker/src/cron/dispatch-telegram-alerts.ts` detects:

- DEWS alert-band changes by comparing the current alertable band (`ALERT`/`WARNING`/`DANGER`) to the last alertable band snapshot, while still keeping the raw current-band snapshot for display context
- New active depeg events by comparing current active-depeg snapshot to the prior snapshot
- Depeg worsening milestones by comparing current active event severity to the prior snapshot
- Depeg resolutions by checking which prior active depegs disappeared and then loading the corresponding closed event rows
- Safety-grade changes by comparing each coin's latest `safety_grade_history` row to the prior snapshot
- Methodology-version-only safety regrades are suppressed from user alerts

If the cached safety snapshot is missing a coin, the dispatcher suppresses the alert unless that coin's latest grade-change row is newer than the cached snapshot timestamp. This avoids false `UNKNOWN → grade` alerts when repairing older partial snapshots or when a newly tracked coin gets its first seed row.

The separate `alert:dews-alertable-snapshot` cache key prevents duplicate same-band DEWS alerts when a coin silently dips to `WATCH` or `CALM` and then returns to the same alert band. Example: `ALERT → WATCH` produces no message and does not reset the alert dedupe baseline, so a later `WATCH → ALERT` does not resend the same `ALERT` notification.

The helper predicates `isDewsAlertable()` and `isDewsDeescalation()` live in `worker/src/lib/telegram-alerts.ts`.

### Subscriber Filtering

Subscribers are selected from two sources:

- `telegram_subscriptions`
- `telegram_subscribers`

Per-coin rows check the corresponding boolean on `telegram_subscriptions`:

- `alert_dews`
- `alert_depeg`
- `alert_safety`
- `alert_launch`

Global all-stablecoin follows use the matching `telegram_subscribers` flags:

- `global_alert_dews`
- `global_alert_depeg`
- `global_alert_safety`
- `global_alert_launch`

Filtering is subscription-aware:

- DEWS compares `newBand` against the coin's `dews_min_band`
- Safety changes respect the coin's `safety_mode`
- Depeg worsening follows the coin's `depeg_worsening_bps_step`
- Quiet hours force `disable_notification = true`

When the same chat has both a global alert type and a per-coin subscription for the same alert type, the per-coin row wins. This lets coin-specific thresholds or modes override the global default.

### Message Formatting and Limits

- Messages are HTML-formatted via `formatConsolidatedMessage()`.
- Long messages are split with `splitMessage(html, 4000)`.
- `sendBatch()` posts in parallel batches of 5 (staying under Workers 6-connection limit).
- Hard cap: `200 Telegram message attempts per dispatch run`.
- Overflow subscribers are enqueued to `telegram_pending_alerts` and drained in subsequent runs.
- Pending alerts expire after `1 hour` (3600s) — stale alerts are cleaned up automatically.

Delivery semantics are explicit:

- `sent`
- `blocked`
- `retryable_failure`
- `permanent_failure`

Fresh retryable failures are enqueued into `telegram_pending_alerts` instead of being dropped.
`403` responses disable both the subscriber's global flags and all per-coin alert booleans to stop repeated failures.

### Pending Delivery Queue

When the chunked subscriber queue exceeds the per-run cap (200), overflow messages are written
to `telegram_pending_alerts` in D1 as pre-split HTML chunks. Each subsequent dispatch run
drains up to 25% of its budget from the pending queue before processing fresh events,
ensuring eventual delivery.

Pending alerts have a 1-hour TTL. Rows older than the TTL are deleted at the end of each
run. Retryable sends are queued while the stored `attempts` counter is below 5; rows that
fail again at `attempts >= 5` are dropped.

This design ensures snapshots always stay current (events are never "held back") while
guaranteeing delivery for large subscriber populations.

## Digest Appendices

`worker/src/lib/telegram-digest-appendices.ts` prepares deploy-diff sections for the Telegram daily digest before the channel post is sent.

### Snapshot Behavior

- Cache keys:
  - `telegram:cemetery-snapshot`
  - `telegram:cemetery-footer-index`
  - `telegram:tracked-stablecoins-snapshot`
- `telegram:tracked-stablecoins-pending` records active tracked IDs discovered by `sync-stablecoins` when the new stablecoins payload contains IDs that were absent from the previous `stablecoins` cache.
- First run seeds the current cemetery and tracked identity sets only when there is no queued tracked-addition state to drain.
- Invalid snapshot payloads are reseeded; if queued tracked additions exist, those are still appended before the tracked snapshot is rewritten.
- Pending additions are appended to the next successful Telegram daily digest post.
- Snapshot advancement for pending additions is deferred until after Telegram accepts the digest post, so failed delivery does not lose pending notices.

Stablecoin identity for cemetery diffs uses `llamaId` when present; otherwise the fallback key is `symbol|deathDate|name`. Tracked-coin diffs use the canonical Pharos stablecoin ID.

### Appendix Shape

When the cemetery changed, the digest gains a `New Cemetery Entries` section with:

- symbol + name
- death month + cause
- italic epitaph when available
- optional peak market cap
- one rotating editorial footer line

When tracked coverage changed, the digest gains a `Tracking Changes` section split into:

- `Newly tracked stablecoins`
- `Newly tracked pre-launch stablecoins`

## Admin Visibility

`GET /api/status` now exposes a `telegramBot` block for the private `/status` dashboard. It aggregates:

- total known chats in `telegram_subscribers`
- alert-enabled chats vs deliverable chats (per-coin follows and global all-stablecoin follows both count)
- total `telegram_subscriptions` rows and average follows per subscribed chat
- pending disambiguation replies still within TTL
- per-alert-type enablement counts (`dews`, `depeg`, `safety`, `launch`, all four)
- top subscribed stablecoins by subscriber count

The status page also reads `crons["dispatch-telegram-alerts"].lastRun.metadata` to show the latest delivery run stats (`subscribersNotified`, `messagesSent`, `blockedUsersCleanedUp`, `eventsDetected`, `snapshotSeeded`, `cappedAtLimit`).

Additional Telegram bot status metrics now include:

- `pendingDeliveries`
- `customPreferenceChats`
- `quietHoursEnabledChats`
- dispatch breakdown fields such as `freshRetryQueued`, `freshPermanentFailures`, `pendingRetryQueued`, and `pendingDropped`

### Circuit Breaker

The dispatcher is protected by `CIRCUIT_SOURCE.TELEGRAM_API`.

- Open circuits skip fan-out.
- Successful snapshot seeding or alert delivery records a successful outcome.
- Failed sends record an unsuccessful outcome.

## Message Types

Formatting helpers in `worker/src/lib/telegram-alerts.ts` emit:

- DEWS band transitions with top two stress sub-signals
- Depeg-triggered messages with direction, bps deviation, and price
- Depeg-worsening messages with previous vs current deviation
- Depeg-resolved messages with duration, peak deviation, and recovery price
- Safety-grade changes with old/new grade and score when present

Subscriber alert messages end with a `View on Pharos` link. Telegram digest posts end with `Read on Pharos →`, even when cemetery or tracking appendices are present.

## Digest vs Subscriber Alerts

The same bot token can be used for both:

- Channel-style digest posting via `postDigestToTelegram(...)`
- Direct chat replies and subscriber alerts via `sendToChat(...)`

Digest posting uses `TELEGRAM_CHAT_ID`; subscriber alerts use the chat IDs stored in `telegram_subscribers`.

## Operational Notes

- Run `scripts/register-telegram-webhook.sh` after rotating `TELEGRAM_BOT_TOKEN` or `TELEGRAM_WEBHOOK_SECRET`.
- The webhook intentionally returns `200` on most malformed or unauthorized cases so Telegram does not keep retrying noisy payloads.
- The dedicated 5-minute Telegram trigger now handles subscriber fan-out only.
- The dispatcher consumes Bot API response bodies before returning, which matters under the Workers per-trigger connection cap.
