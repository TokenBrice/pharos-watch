# Telegram Alert Bot — Design Document

**Date:** 2026-03-08
**Status:** Approved
**Approach:** Integrated into existing Cloudflare Worker

## Overview

A Telegram bot that lets users subscribe to per-coin alerts for DEWS state changes, depeg events, and safety score changes. Users specify coins by ticker with disambiguation for duplicates. The bot reuses the existing `TELEGRAM_BOT_TOKEN` and runs entirely within the current Worker + D1 infrastructure.

**Live bot**: same bot identity that posts daily digests to the Pharos channel. Commands handled via Telegram webhook.

## Architecture Decision: Integrated vs Separate Service

**Chosen: Integrated into existing Worker.** Key reasons:

- Zero new infrastructure — same deploy, DB, secrets, monitoring
- Direct D1 access — alert dispatch reads DEWS/depeg/grade tables with no API round-trip or cache lag
- Atomic detection-to-notification — the cron that detects a depeg can immediately query subscribers and dispatch in the same invocation
- Telegram creds already wired through `RouteContext`

**Trade-offs accepted:**
- Fan-out ceiling of ~500 subscribers before wall-time becomes a concern (addressable later with Cloudflare Queues)
- Conversation state (disambiguation) requires D1 persistence since Workers are stateless
- Blast radius — bot bugs could theoretically affect API, mitigated by lightweight handler design

## 1. Command Interface

### Commands

| Command | Description |
|---|---|
| `/start` | Welcome message + usage instructions |
| `/subscribe <types> <tickers>` | Subscribe to alert types for specific coins |
| `/unsubscribe <tickers>` | Remove coins from subscriptions |
| `/unsubscribe all` | Remove all subscriptions |
| `/list` | Show current subscriptions |
| `/help` | Command reference |

### Alert type codes

| Code | Monitors | Source |
|---|---|---|
| `dews` | DEWS band changes (ALERT/WARNING/DANGER only) | `stress_signals` table |
| `depeg` | Depeg triggered or resolved | `depeg_events` table |
| `safety` | Safety grade changes | `safety_grade_history` table |

### Command parsing

Tokenize the argument string by whitespace. Match each token (case-insensitive) against the fixed set `{dews, depeg, safety}`. Matches are alert types; everything else is treated as a ticker. Parsing is order-independent — `/subscribe USDC dews BOLD depeg` is identical to `/subscribe dews depeg USDC BOLD`. No stablecoin in the tracked set has a ticker that collides with an alert type name.

### Example interaction

```
User:  /subscribe dews depeg USDC BOLD USDF
Bot:   "USDF" matches 2 coins:
       1. USDF — Astherus (usdf-astherus)
       2. USDf — Falcon USD (usdf-falcon)
       Reply with the number(s) you want (e.g. "1" or "1,2")

User:  1
Bot:   Subscribed to DEWS + Depeg alerts for:
       - USDC (usdc-circle)
       - BOLD (bold-liquity)
       - USDF (usdf-astherus)
```

### Subscription semantics

**Always additive.** `/subscribe` merges new alert types and coins into existing subscriptions — it never replaces.

- `/subscribe dews USDC` then `/subscribe depeg USDC BOLD` → USDC has dews + depeg, BOLD has depeg
- Re-subscribing to something already subscribed is a silent no-op (no "already subscribed" message)
- `/unsubscribe BOLD` removes the coin regardless of which alert types the user has
- `/unsubscribe all` removes all coins and resets all alert type flags to 0

### Ticker resolution (case-insensitive)

1. Exact match on `symbol` field — resolve immediately
2. Multiple matches — disambiguation prompt (pending state in D1, expires after 5 min)
3. Zero matches — "Not found. Did you mean X?" via prefix/Levenshtein suggestion

**Known duplicate tickers** (case-insensitive): GUSD (Gate/Gemini), USDA (Avalon/Anzens), USDM (Mega/Moneta), USDU (Unitas/USDU Finance), MSUSD (Metronome/Main Street), USDF/USDf (Astherus/Falcon), reUSD/REUSD (Re Protocol/Resupply).

### Command validation and error responses

| Input | Response |
|---|---|
| `/subscribe dews` (no tickers) | "Specify at least one ticker. Example: /subscribe dews USDC BOLD" |
| `/subscribe USDC` (no alert types) | "Specify at least one alert type: dews, depeg, safety. Example: /subscribe dews USDC" |
| `/subscribe foo USDC` (invalid type) | "Unknown alert type: foo. Valid types: dews, depeg, safety" |
| `/unsubscribe USDC` (not subscribed) | Silent 200 (idempotent, no error) |
| `/list` (no subscriptions) | "No active subscriptions. Use /subscribe to get started." |
| Non-command text (no pending disambiguation) | Ignored (200 OK, no reply) |
| D1 failure during any command | Reply "Something went wrong, please try again." (best-effort; if send also fails, drop silently). Always return HTTP 200. |

### `/list` output format

```
Alert types: DEWS, Depeg
Coins (3):
- USDC (usdc-circle)
- BOLD (bold-liquity)
- USDF (usdf-astherus)
```

The canonical ID in parentheses eliminates ambiguity for duplicate-ticker coins and matches Pharos URL slugs. If alert types are active but no coins are subscribed (or vice versa), that section shows "None" — making the misconfiguration visible rather than silently broken.

## 2. Data Model

### New table: `telegram_subscribers`

One row per user, created on first `/subscribe`.

| Column | Type | Notes |
|---|---|---|
| `chat_id` | TEXT PK | String (Telegram IDs can exceed JS safe int) |
| `username` | TEXT | Nullable, for admin visibility |
| `alert_dews` | INTEGER | 1 = subscribed, 0 = not |
| `alert_depeg` | INTEGER | 1 = subscribed, 0 = not |
| `alert_safety` | INTEGER | 1 = subscribed, 0 = not |
| `created_at` | INTEGER | Unix seconds |
| `last_active_at` | INTEGER | Unix seconds, updated on any command |

### New table: `telegram_subscriptions`

One row per (user, coin) pair.

| Column | Type | Notes |
|---|---|---|
| `chat_id` | TEXT | FK to `telegram_subscribers` |
| `stablecoin_id` | TEXT | Canonical ID (e.g. `usdc-circle`) |
| PRIMARY KEY | | `(chat_id, stablecoin_id)` |

Index: `idx_tg_sub_coin` on `(stablecoin_id)` — for fan-out queries ("who watches this coin?").

### New table: `telegram_pending_disambiguation`

Ephemeral rows for mid-conversation state.

| Column | Type | Notes |
|---|---|---|
| `chat_id` | TEXT PK | One pending disambiguation per user |
| `alert_types` | TEXT | JSON array, e.g. `["dews","depeg"]` |
| `resolved_ids` | TEXT | JSON array of already-resolved coin IDs |
| `ambiguous_ticker` | TEXT | The ticker being disambiguated |
| `candidates` | TEXT | JSON array of `{id, name, symbol}` |
| `remaining_tickers` | TEXT | JSON array of tickers not yet processed |
| `expires_at` | INTEGER | Unix seconds (created_at + 300) |

### Alert state tracking

Stored in the existing `cache` table (JSON blobs):

| Cache key | Value |
|---|---|
| `alert:dews-snapshot` | `{stablecoin_id: band}` map from last alert run |
| `alert:depeg-snapshot` | `{stablecoin_id: {active: boolean, peakBps: number}}` map |
| `alert:safety-snapshot` | `{stablecoin_id: grade}` map |

**First-run seeding**: If no snapshot exists (or snapshot is older than 24h), seed with current state and skip dispatch. Alerts start firing from the next cycle. This prevents an alert storm on first deployment or after an outage.

### Upsert semantics

All subscriber mutations use D1-compatible SQLite operations, batched via `db.batch()` for atomicity:

- **`/subscribe`**: `INSERT INTO telegram_subscribers ... ON CONFLICT(chat_id) DO UPDATE SET alert_dews = MAX(alert_dews, ?), alert_depeg = MAX(alert_depeg, ?), alert_safety = MAX(alert_safety, ?), last_active_at = ?` — OR-merges flags so a previously-blocked user (all flags 0) can re-subscribe without errors. Subscriptions use `INSERT OR IGNORE INTO telegram_subscriptions`.
- **`/unsubscribe <tickers>`**: `DELETE FROM telegram_subscriptions WHERE chat_id = ? AND stablecoin_id IN (...)`.
- **`/unsubscribe all`**: Batched `DELETE FROM telegram_subscriptions WHERE chat_id = ?` + `UPDATE telegram_subscribers SET alert_dews = 0, alert_depeg = 0, alert_safety = 0 WHERE chat_id = ?`.
- **Blocked-user deactivation** (from dispatch): `UPDATE telegram_subscribers SET alert_dews = 0, alert_depeg = 0, alert_safety = 0 WHERE chat_id = ?`. Subscription rows are kept — the user can re-subscribe and their coin list is restored.

## 3. Webhook Endpoint

### Endpoint

```
POST /api/telegram-webhook?secret={TELEGRAM_WEBHOOK_SECRET}
```

- **Authentication**: Secret query parameter validated against `TELEGRAM_WEBHOOK_SECRET` env var. Standard Telegram-recommended approach (Telegram doesn't sign webhook payloads).
- **Cache**: `no-store` — every POST must reach the handler.
- **Rate limiting**: Exempt from the general 60 req/60 sec IP limiter (Telegram sends from a small set of IPs). The webhook secret serves as access control.
- **Response**: Always 200 OK (Telegram retries on non-2xx).

### Command dispatch flow

```
Webhook POST received
  -> Validate secret query param
  -> Parse Update JSON -> extract message.text, message.chat.id
  -> If no text or not a command -> ignore (200 OK)
  -> Check telegram_pending_disambiguation for this chat_id
     -> If exists and not expired -> treat message as disambiguation reply
     -> If exists and expired -> delete row, treat as fresh command
  -> Route command:
      /start      -> send welcome text
      /help       -> send command reference
      /list       -> query subscriptions, format response
      /subscribe  -> parse types + tickers, resolve, handle ambiguity
      /unsubscribe -> parse tickers, delete from subscriptions
      (other)     -> "Unknown command. Try /help"
  -> Return 200 OK
```

### Disambiguation flow

1. Resolve tickers left-to-right. First ambiguous ticker pauses processing.
2. Write `telegram_pending_disambiguation` row with: resolved IDs so far, ambiguous ticker + candidates, remaining tickers.
3. Send disambiguation message to user.
4. On next message: if pending row exists and not expired, treat as disambiguation reply (number selection).
5. Resolve, merge into resolved IDs, continue with remaining tickers (may hit another ambiguity).
6. Once all tickers resolved -> write subscriptions to D1, delete pending row, confirm.

### Webhook registration (one-time)

```bash
curl -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://api.pharos.watch/api/telegram-webhook?secret=${SECRET}"}'
```

Wrap in `scripts/register-telegram-webhook.sh` for convenience. Must wait until after deploy — the endpoint must exist or Telegram retries against a 404.

### BotFather command registration (one-time, pre-deploy OK)

Message `@BotFather`, send `/setcommands`, select the bot, then send:

```
start - Get started with Pharos alerts
subscribe - Subscribe to alerts for specific coins
unsubscribe - Remove coin subscriptions
list - Show your current subscriptions
help - Command reference
```

This registers the autocomplete menu in Telegram's UI. Can be done before code is deployed — the menu appears but commands won't function until the webhook is live.

## 4. Alert Dispatch

### Schedule

The `dispatch-telegram-alerts` cron job runs on two existing triggers:

| Trigger | Checks |
|---|---|
| `*/15 * * * *` | DEWS band changes + new/resolved depeg events |
| `0 8 * * *` | Safety grade changes (after `snapshot-safety-grade-history`) |

**Job sequencing**: `dispatch-telegram-alerts` must be positioned *last* in both cron slot handlers within `scheduled.ts`. On `*/15`, it runs after `compute-dews` and `sync-stablecoins` (which handles depeg detection). On `0 8`, it runs after `snapshot-safety-grade-history`. The existing handler runs jobs sequentially — order in the source code determines execution order. If placed before the data jobs, the dispatch diffs against stale snapshots and either misses events or fires false alerts.

### Detection logic

**DEWS**: Read latest `stress_signals` per coin. Compare `band` against `alert:dews-snapshot`. Notify only when the **new band is ALERT, WARNING, or DANGER** and the band changed. Transitions into CALM or WATCH are silent.

**Depeg**: Query `depeg_events WHERE ended_at IS NULL` for active depegs. Diff against `alert:depeg-snapshot`. New entries = "depeg triggered". Entries that disappeared = "depeg resolved".

**Safety**: Query today's `safety_grade_history` snapshot. Diff `grade` against `alert:safety-snapshot`. Any grade change = alert.

### Fan-out

1. For each changed coin, query subscribers:
   ```sql
   SELECT s.chat_id
   FROM telegram_subscriptions s
   JOIN telegram_subscribers u ON u.chat_id = s.chat_id
   WHERE s.stablecoin_id = ?
     AND u.alert_{type} = 1
   ```
2. **Consolidate per subscriber**: Group all events for the same `chat_id` into a single message. If a user follows USDC and BOLD and both have DEWS changes, they get one message with both, not two. If the consolidated message exceeds 4000 chars (Telegram hard limit is 4096; 96-char safety margin), split into multiple messages to the same `chat_id`, preserving the grouped-by-type structure. Each split message counts against the 50-message-per-run cap.
3. Sequential sends, one per subscriber per cycle. Respects Telegram's 1 msg/sec per chat rate limit.
4. **Blocked-user handling**: If a send returns HTTP 403 ("bot was blocked by user"), immediately mark the subscriber inactive (set all `alert_*` flags to 0). No need to wait for 3 retries — a 403 is definitive.
5. **Snapshot update**: Write new snapshot to cache only after all sends are accounted for (success or logged failure). Failed runs retry on the next cycle.

### Guardrails

- **Max 50 messages per cron run** — if more are needed (mass DEWS shift affecting many subscribers), send the first 50 (prioritized by `last_active_at` DESC — most engaged users first) and continue next cycle.
- **Circuit breaker** — reuse `CIRCUIT_SOURCE.TELEGRAM_API`. If Telegram is down, skip dispatch entirely and retry next cycle.
- **First-run seeding** — seed snapshot with current state, skip dispatch. Prevents flood of false alerts on deployment or after stale snapshot (>24h old).

### Message templates

All messages sent with `disable_web_page_preview: true` (suppress link preview clutter).

De-escalation alerts within the alertable range (DANGER -> WARNING, WARNING -> ALERT) sent with `disable_notification: true` — message appears in chat but doesn't buzz the phone. Escalations ring.

**DEWS band change:**
```html
<b>DEWS Alert</b>

<b>USDC</b> — CALM -> ALERT (score: 42)
Top signals: supply (45), pool (32)

<a href="https://pharos.watch/stablecoin/usdc-circle">View on Pharos</a>
```

**Depeg triggered:**
```html
<b>Depeg Detected</b>

<b>BOLD</b> — below peg
Deviation: 2.3% (230 bps)
Price: $0.977 (peg: $1.00)

<a href="https://pharos.watch/stablecoin/bold-liquity">View on Pharos</a>
```

**Depeg resolved:**
```html
<b>Depeg Resolved</b>

<b>BOLD</b>
Duration: 4h 30m
Peak deviation: 2.3%
Recovery price: $0.998

<a href="https://pharos.watch/stablecoin/bold-liquity">View on Pharos</a>
```

**Safety grade change:**
```html
<b>Safety Grade Change</b>

<b>FRAX</b> — B+ -> B-
Score: 75 -> 63

<a href="https://pharos.watch/stablecoin/frax-frax">View on Pharos</a>
```

**Consolidated message** (multiple events for one subscriber):
```html
<b>Pharos Alerts</b>

<b>DEWS</b>
- USDC — CALM -> ALERT (score: 42)
- BOLD — WATCH -> WARNING (score: 61)

<b>Depeg</b>
- FRAX — below peg, 1.5% deviation

<a href="https://pharos.watch">View on Pharos</a>
```

### Dispatch observability

The `dispatch-telegram-alerts` job logs metadata via `logCronRun` (recorded to `cron_runs`, visible in `/status` dashboard):

```json
{
  "eventsDetected": { "dews": 2, "depeg": 1, "safety": 0 },
  "subscribersNotified": 12,
  "messagesSent": 12,
  "blockedUsersCleanedUp": 1,
  "cappedAtLimit": false,
  "snapshotSeeded": false
}
```

- `eventsDetected` — number of state changes detected per alert type (before fan-out)
- `subscribersNotified` — unique users who received a message this run
- `messagesSent` — total messages sent (equals `subscribersNotified` due to consolidation)
- `blockedUsersCleanedUp` — users marked inactive due to 403 responses
- `cappedAtLimit` — true if the 50-message cap was hit (remaining deferred to next cycle)
- `snapshotSeeded` — true if this run was a first-run seed (no alerts dispatched)

## 5. Integration Points

### New environment variable

| Variable | Purpose | Setup |
|---|---|---|
| `TELEGRAM_WEBHOOK_SECRET` | Validates incoming webhook requests | `wrangler secret put TELEGRAM_WEBHOOK_SECRET` |

Existing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are reused. `TELEGRAM_CHAT_ID` remains for digest channel posting; alert dispatch uses per-subscriber `chat_id` from D1.

### New files

| File | Purpose |
|---|---|
| `worker/src/api/telegram-webhook.ts` | Webhook handler: command parsing, disambiguation, subscription CRUD |
| `worker/src/cron/dispatch-telegram-alerts.ts` | Alert detection, diffing, consolidated fan-out |
| `worker/src/lib/telegram-alerts.ts` | Message templates, subscriber queries, ticker resolution |
| `worker/migrations/NNNN_telegram_subscribers.sql` | D1 migration for 3 new tables |
| `scripts/register-telegram-webhook.sh` | One-time webhook registration convenience script |

### Modified files

| File | Change |
|---|---|
| `worker/src/lib/env.ts` | Add `TELEGRAM_WEBHOOK_SECRET` to `Env` |
| `worker/src/lib/telegram.ts` | Export `postTelegramMessage`, add `sendToChat(chatId, text, botToken, opts)` helper with `disable_web_page_preview` and `disable_notification` support |
| `worker/src/router.ts` | Register `/api/telegram-webhook` route |
| `worker/src/handlers/scheduled.ts` | Add `dispatch-telegram-alerts` to `*/15` and `0 8` cron slots |
| `worker/src/handlers/http.ts` | Skip rate limiter for webhook path |
| `shared/lib/api-endpoints.ts` | Register endpoint definition |

### Documentation updates

| Doc | Update |
|---|---|
| `docs/architecture.md` | Add webhook endpoint, new tables, new cron job |
| `docs/api-reference.md` | Document `/api/telegram-webhook` endpoint |
| `docs/worker-infrastructure.md` | Add cron job to dispatch list, document webhook secret |
| About page | Mention Telegram bot alerts as a feature |

## 6. Scalability Boundaries

| Constraint | Limit | Mitigation path (future) |
|---|---|---|
| Fan-out per cron run | ~50 messages (self-imposed), ~500 before wall-time risk | Cloudflare Queues for async fan-out |
| D1 storage | 3 small tables, negligible growth | Not a concern |
| Cron slots | No new slot used (piggybacks existing) | N/A |
| 6-connection limit | Alert sends are sequential (1 conn), but extend invocation time | Queues would decouple from cron |
| Telegram rate limit | 30 msgs/sec global, 1 msg/sec per chat | Already sequential; consolidation reduces volume |
