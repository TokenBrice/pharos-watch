# PharosWatchBot and Telegram Alerts

## Overview

Pharos runs PharosWatchBot for opt-in stablecoin alerts and Telegram channel posts.

The subsystem has four moving parts:

- `POST /api/telegram-webhook` accepts Telegram commands, validates the shared secret from `X-Telegram-Bot-Api-Secret-Token`, and stores subscriber state in D1.
- `worker/src/cron/dispatch-telegram-alerts.ts` diffs the latest DEWS, active depeg, and safety-grade snapshots against cached prior snapshots, then fans out consolidated messages to matching subscribers.
- `worker/src/cron/daily-digest.ts` appends pending cemetery additions and newly tracked coins to the next Telegram digest post after a deploy.
- `worker/src/lib/telegram.ts`, `worker/src/lib/telegram-alerts.ts`, `worker/src/lib/telegram-presets.ts`, and `worker/src/lib/telegram-digest-appendices.ts` handle Bot API sends, ticker parsing, preset resolution, message formatting, diffing, and HTML escaping.

The delivery system is worker-owned. The frontend exposes a static `/pharoswatchbot/` landing page plus a lightweight public telemetry strip sourced from `GET /api/telegram-pulse`; it does not call any mutating bot APIs directly. `/pharoswatchbot/` is the canonical public route, and the legacy `/telegram` and `/telegram/*` aliases redirect there.

The safety-alert path now has an additional hard dependency: `publish-report-card-cache` writes a generation-aware live safety source snapshot into `cache["alert:safety-source-cache"]`, and the 5-minute Telegram lane will suppress only safety-grade alerts when that source is missing, corrupt, stale, or from the wrong generation.

## Files

- `worker/src/api/telegram-webhook.ts`
- `worker/src/api/telegram-webhook-shared.ts`
- `worker/src/api/telegram-webhook-parsing.ts`
- `worker/src/api/telegram-webhook-messages.ts`
- `worker/src/api/telegram-webhook-store.ts`
- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/cron/daily-digest.ts`
- `worker/src/lib/telegram-webhook-registration.ts`
- `worker/src/lib/telegram.ts`
- `worker/src/lib/telegram-alerts.ts`
- `worker/src/lib/telegram-presets.ts`
- `worker/src/lib/telegram-digest-appendices.ts`
- `src/app/pharoswatchbot/page.tsx`
- `src/app/pharoswatchbot/telegram-pulse-strip.tsx`
- `src/hooks/use-telegram-pulse.ts`
- `worker/src/api/telegram-pulse.ts`
- `worker/migrations/0000_baseline.sql`
- `worker/migrations/MANIFEST.md`
- `scripts/register-telegram-webhook.sh`
- `scripts/register-telegram-commands.sh`

## Frontend Main Page

`src/app/pharoswatchbot/page.tsx` is the product-facing main page for PharosWatchBot and the wider Telegram feature set. It is promoted into the
primary navigation immediately after `/alt-pegs/`.

- Route: `/pharoswatchbot/`
- Legacy alias: `/telegram` redirects to `/pharoswatchbot/`, and `/telegram/*` redirects to the matching `/pharoswatchbot/*` path
- Covers the public `@pharoswatch` digest channel, the `@pharoswatchers` community channel, and the `@PharosWatchBot` subscription bot
- Reads `GET /api/telegram-pulse` for live watcher/subscription telemetry, including the hero pulse strip, adoption metrics board, aggregate alert-type/quiet-hours/pending-delivery counts, and an all-time cumulative active-watcher chart
- Does not call the webhook or any other mutating bot API; it links users to Telegram plus the on-site digest archive
- Presents the bot around low-noise growth paths: the recommended `/subscribe dews,depeg usd-top25` default, preset cohorts, group-addressed commands, quiet hours, inline snooze, and the overflow delivery queue
- Renders a visible FAQ section with matching `FAQPage` JSON-LD, plus `HowTo` and `SoftwareApplication` JSON-LD for the bot setup flow

## D1 Schema

The Telegram subscriber, disambiguation, and overflow-queue tables are part of `worker/migrations/0000_baseline.sql`. The baseline includes the core tables and legacy alert/global fields through `global_alert_safety`; launch-alert columns are added by `worker/migrations/0072_telegram_launch_alerts.sql`, `alert_snooze_until_ts` is added by `worker/migrations/0098_telegram_alert_snooze.sql`, pending-selection ownership is added by `worker/migrations/0107_telegram_pending_initiator.sql`, and persistent dynamic preset follows are added by `worker/migrations/0114_telegram_dynamic_presets.sql`. [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md) records the pre-squash lineage.

| Table | Purpose | Key fields |
|-------|---------|------------|
| `telegram_subscribers` | Per-chat state and defaults | `chat_id`, `username`, legacy default flags, `global_alert_dews`, `global_alert_depeg`, `global_alert_safety`, `global_alert_launch`, `global_depeg_worsening_bps_step`, `quiet_hours_enabled`, `quiet_hours_start_utc`, `quiet_hours_end_utc`, `alert_snooze_until_ts`, `created_at`, `last_active_at` |
| `telegram_subscriptions` | Per-chat per-coin alert preferences | composite PK `chat_id, stablecoin_id`, `alert_dews`, `alert_depeg`, `alert_safety`, `alert_launch`, `dews_min_band`, `safety_mode`, `depeg_worsening_bps_step` |
| `telegram_preset_subscriptions` | Persistent dynamic preset follows resolved at dispatch/list time | composite PK `chat_id, preset_id`, `alert_dews`, `alert_depeg`, `alert_safety`, `depeg_worsening_bps_step`, `created_at`, `updated_at` |
| `telegram_pending_disambiguation` | Short-lived state for ambiguous ticker replies | `chat_id`, `action_type`, `action_payload`, `resolved_ids`, `ambiguous_ticker`, `candidates`, `remaining_tickers`, `expires_at`, `initiator_user_id` |
| `telegram_pending_alerts` | Overflow and retry delivery queue | `id`, `chat_id`, `message_html`, `disable_notification`, `created_at`, `attempts`, `not_before_at`, `last_error_class`, `retry_after_sec`, `updated_at`, `dedupe_key`, `chunk_index` |

`worker/migrations/0117_telegram_global_alert_indexes.sql` adds partial indexes on each `telegram_subscribers.global_alert_*` flag (DEWS, depeg, safety, launch) plus `telegram_pending_alerts(chat_id)` so the dispatcher's global-subscriber fan-out queries and the pending drain JOIN avoid full scans.

The webhook also uses the generic `cache` table key `telegram:last-update-id` to deduplicate Telegram update re-delivery.

## Secrets and Bindings

| Binding | Required | Used by |
|---------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | Webhook replies, digest posting (including appended cemetery / tracking notices), subscriber alert fan-out |
| `TELEGRAM_BOT_TOKEN_PREVIOUS` | No | Optional rotation marker validated only for config consistency; sends and webhook registration use the current token |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Telegram webhook secret validation for `POST /api/telegram-webhook` via `X-Telegram-Bot-Api-Secret-Token` |
| `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` | No | Temporary overlap secret accepted by `POST /api/telegram-webhook` during secret rotation; registration still emits only `TELEGRAM_WEBHOOK_SECRET` |
| `TELEGRAM_CHAT_ID` | No | Daily digest channel posting, including appended cemetery and tracking notices |

Webhook registration is handled by `scripts/register-telegram-webhook.sh`, which calls Telegram `setWebhook` with the webhook URL and the JSON `secret_token` field:

- URL: `https://api.pharos.watch/api/telegram-webhook`
- Secret token: `<TELEGRAM_WEBHOOK_SECRET>`

The dedicated five-minute Telegram worker lane now also reconciles the webhook registration in production on a cache-backed cadence. That means the live Worker periodically re-applies the configured webhook URL, secret token, and `allowed_updates = ["message", "callback_query"]` via Telegram `setWebhook`, which self-heals webhook-secret or update-filter drift without requiring a separate manual script run.

### Webhook Secret Rotation

Telegram secret rotation uses a short overlap window:

1. Set the new `TELEGRAM_WEBHOOK_SECRET`.
2. Move the prior value into `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`.
3. Run the reconciliation flow so Telegram starts sending only the new current secret.
4. Keep the previous secret configured for up to 24 hours as operator policy.
5. Remove `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` after the overlap window ends.

Receiver behavior accepts either current or previous secret whenever both are configured; the 24-hour overlap is enforced operationally by removing the previous secret, not by a timestamp check in the Worker. Registration and reconciliation always send only the current `TELEGRAM_WEBHOOK_SECRET`.

## Inline Keyboards (Callback Queries)

Every subscriber alert sent from the dispatcher carries an inline keyboard.
Multi-coin or overflow chunks keep the snooze row (`Snooze 1h | 4h | 24h`).
Single-coin first chunks also include contextual actions (`Status`, `Depeg +250`,
and `Safety downgrades`) so a user can inspect or tighten routing without typing
the full command. Tapping a button yields a Telegram `callback_query` update,
routed to `worker/src/api/telegram-webhook-callbacks.ts`.

The callback data format is `action:arg` (≤64 bytes, the Bot API limit).
Current actions:

- `snooze:1h | 4h | 24h`
- `status:<stablecoinId>`
- `depegstep:<stablecoinId>:100|250|500`
- `safetydown:<stablecoinId>`

Unknown action codes receive a visible callback toast but are not treated as
errors, so the bot stays forward-compatible with future keyboards.

Registration script `scripts/register-telegram-webhook.sh` declares
`allowed_updates = ["message", "callback_query"]` so Telegram forwards only
update types the bot handles.

## Webhook Command Flow

`worker/src/api/telegram-webhook.ts` now acts as a thin ingress coordinator. Command parsing, message formatting, and D1 persistence live in the adjacent `telegram-webhook-*` helper modules so command behavior can be tested without editing the transport entrypoint.

The webhook validates the configured secret from `X-Telegram-Bot-Api-Secret-Token`. During rotation it accepts either `TELEGRAM_WEBHOOK_SECRET` or `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`. Invalid secrets, missing bot token, malformed JSON, and non-command messages all return `200 ok` without side effects so Telegram does not keep retrying.

In group and supergroup chats, commands must be addressed to the bot, for example `/subscribe@PharosWatchBot dews usd-top25`. Unaddressed slash commands and commands addressed to the public channel handle are ignored so Pharos does not intercept another bot's group command surface. Plain numeric replies for an active disambiguation prompt do not need a bot mention, but the reply must come from the same Telegram user who started the pending selection when `initiator_user_id` is available; unrelated group text from other users is ignored.

### Group Admin Gating

`/subscribe`, `/unsubscribe`, `/set`, `/mute`, `/unmutehours`, and `/unsnooze` are gated to group administrators so a single member cannot rewrite the chat's subscription or quiet-hours state. The gating mode lives behind the `TELEGRAM_GROUP_ADMIN_GATING` toggle in `worker/src/api/telegram-webhook.ts`.

- **Hard gate (current default):** non-admin invocations receive a refusal reply that names the current administrators ("Only group admins can change alert settings (/subscribe). Admins here: @Alice, Bob.") and the command is short-circuited; the dispatch does not run. Admin display names come from `getChatAdministrators`, which is already visible to every member through the Telegram group member list.
- **Soft (emergency rollback):** flipping the toggle to `"soft"` warns the non-admin with the same copy but still runs the command. Kept as an operator escape hatch if the hard gate is ever too aggressive in production.

Membership lookups go through `worker/src/lib/telegram-chat-member.ts`. `getCachedChatMember` and `getCachedChatAdministrators` cache results for 5 minutes in the `cache` D1 table under `telegram:chat-member:<chat_id>:<user_id>` and `telegram:chat-admins:<chat_id>` so a burst of group commands does not amplify the webhook-path Telegram API cost. Private chats and snooze callbacks remain open to every chat member.

### Setup Wizard

`/start` (with an empty payload or `?start=setup`) opens a two-branch inline-keyboard wizard handled in `worker/src/api/telegram-webhook-setup.ts`. The keyboard uses the `setup:*` callback namespace:

- `setup:branch:recommended` — confirms `dews,depeg` alerts for the `usd-top25` preset.
- `setup:branch:custom` — toggles alert types (`setup:type-toggle:<type>`), then `setup:next` to pick a target (`setup:target:<preset|all|type>`), then `setup:confirm`.
- `setup:branch:skip` — clears wizard state and returns the long-form `START_MESSAGE` for users who prefer typing commands.
- `setup:target:type` — opens a `force_reply` prompt so the user can type a ticker; the next inbound message is resolved via `resolveTicker` and lands on the confirm step.

Wizard state is persisted as a row in `telegram_pending_disambiguation` with `action_type = "setup-step"` and an `action_payload` JSON of `{ step, alertTypes, target }`. TTL is 5 min, shared with the disambiguation cleanup cron. When wizard state is active and a fresh slash command arrives, the wizard row is cleared so the command runs unmodified.

### Supported Commands

| Command | Behavior |
|---------|----------|
| `/start` | Opens the two-branch setup wizard (Recommended / Custom / Type commands myself). Deep-link payload `?start=setup` also opens the wizard. Unknown payloads fall back to the long-form start message. |
| `/help` | Sends command reference |
| `/presets` | Returns the preset watchlist catalog plus subscribe and unsubscribe examples |
| `/list` | Returns enabled alert types plus subscribed coins for the chat |
| `/status <ticker>` | Returns a compact snapshot: current price freshness, supply, DEWS band, safety grade, active-depeg state, DEX liquidity, and best yield context for the given coin. No subscription required. |
| `/brief` | Returns the latest compact market brief from the daily digest inputs. `/market` is a deprecated alias kept for one release cycle. |
| `/top <view>` | Returns ranked current views for `depeg`, `dews`, `yield`, `liquidity`, `chains`, or `safety` |
| `/why <ticker>` | Explains the current Safety Score, weakest dimensions, and key risk notes for one coin |
| `/coverage <ticker>` | Shows which Pharos data surfaces currently cover one coin |
| `/subscribe <types> <targets>` | Enables one or more alert types and subscribes the chat to one or more explicit coins or preset watchlists |
| `/subscribe <targets> depeg-step <value>` | Enables depeg alerts for explicit coins or preset watchlists and stores a worsening-step threshold (`100`, `250`, `500`, or `off`) |
| `/subscribe <types> all` | Enables one or more alert types across all tracked stablecoins (always gated; see below) |
| `/unsubscribe <targets>` | Removes explicit coin subscriptions and can also remove the coins covered by a preset watchlist |
| `/unsubscribe all` | Clears all per-coin subscriptions, disables every current alert flag including launch, and clears the global depeg worsening step (always gated; see below) |

Bulk `/subscribe` and `/unsubscribe` calls are gated behind an inline `[ Confirm ] [ Cancel ]` keyboard when the resolved coin set exceeds 10 coins or the literal `all` token is used. The deferred command is stored in `telegram_pending_disambiguation` with `action_type = 'confirm-bulk'` and inherits the standard 5-minute TTL. Tapping Confirm executes the original command; Cancel (or `/cancel`) clears the pending state without side effects. Confirmation is initiator-locked: only the user who started the bulk command may complete or cancel it.
| `/set <ticker> <setting> <value>` | Tunes per-coin settings such as DEWS floor, safety direction mode, launch on/off, or depeg worsening step |
| `/set all <setting> <value>` | Enables or disables global all-stablecoin alert types (`dews`, `depeg`, `safety`, `launch`) or sets the global depeg worsening step |
| `/mute <start>-<end>` | Enables quiet hours in UTC (messages still deliver, notifications are silenced) |
| `/unsnooze` | Clears active alert snooze immediately |
| `/unmutehours` | Disables quiet hours |
| `/cancel` | Cancels a pending disambiguation flow |

### /start Deep-Link Payloads

Telegram supports `https://t.me/PharosWatchBot?start=<payload>` deep links. The payload arrives as the `/start` argument string and is dispatched through `parseStartPayload` in `worker/src/api/telegram-webhook-parsing.ts`.

Supported payload schemes (lowercase, no spaces, max 64 characters, characters `[A-Za-z0-9_-]` only):

| Payload | Behavior |
|---------|----------|
| `sub_<types>_<targets>` (e.g. `sub_dews-depeg_usd-top25`) | Translates to `/subscribe <types> <targets>` and dispatches the existing subscribe path. Multiple alert types are joined by `-`. Only fires in private chats — group deep-links fall back to the standard onboarding reply with no mutation. |
| `status_<id>` | Runs the existing `/status` handler against the supplied Pharos coin id. Allowed in any chat. |
| `why_<id>` | Runs the existing `/why` handler. Allowed in any chat. |
| `coverage_<id>` | Runs the existing `/coverage` handler. Allowed in any chat. |
| `setup` | Falls through to the standard onboarding reply. The setup wizard work that consumes this payload arrives with P0-U2. |
| Unknown or malformed | Falls back to the standard `/start` reply; the user never sees an error. |

Telegram only delivers `?start=` deep links in private chats, but the dispatcher still defensively checks `chat.type === "private"` before running mutating `sub_*` payloads.

### Alert Types

- `dews`
- `depeg`
- `safety`
- `launch`

### Preset Watchlists

Preset watchlists are persistent dynamic follows on top of the existing per-coin subscription model.

- Supported canonical aliases: `usd-top10`, `usd-top25`, `usd-top50`, `eur-top10`, `gold-top5`, `mcap-ge-1b`, `mcap-ge-100m`
- Top-N peg presets also accept dashed aliases, for example `usd-top-10`, `usd-top-25`, and `usd-top-50`; commands canonicalize them before subscription storage.
- Resolution happens at command and dispatch/list time inside `worker/src/lib/telegram-presets.ts`
- The resolver uses the current strict `stablecoins` cache plus tracked stablecoin metadata to map each preset alias to concrete active coin IDs
- `/subscribe ... <preset>` stores a persistent row in `telegram_preset_subscriptions` and also updates the currently resolved coin rows for backwards-compatible list/explicit-row behavior
- `/unsubscribe <preset>` deletes the persistent preset row and removes the currently resolved coin rows for that chat
- `/list` shows both dynamic preset rows and explicit coin rows
- `launch` does not accept presets; launch alerts support explicit ticker/coin-id targets and the special `all` target
- Preset resolution fails closed when the stablecoins cache is unavailable; the bot returns a temporary retry message instead of subscribing stale or incomplete cohorts

Additional alert controls:

- `dews_min_band`: optional per-coin floor (`ALERT` default, or `WARNING` / `DANGER`)
- `safety_mode`: `all`, `downgrade-only`, or `upgrade-only`
- `depeg_worsening_bps_step`: optional per-coin worsening follow-up step (`100`, `250`, `500`)
- `telegram_preset_subscriptions.depeg_worsening_bps_step`: optional dynamic preset worsening follow-up step (`100`, `250`, `500`)
- `global_depeg_worsening_bps_step`: optional all-stablecoin depeg worsening follow-up step (`100`, `250`, `500`)
- `global_alert_*`: subscriber-level flags that subscribe the chat to every tracked stablecoin for that alert type, including `launch`
- quiet hours: subscriber-level UTC hour window that forces `disable_notification = true`

`launch` alerts have no additional per-coin tuning beyond on/off subscription state, and can now be toggled through `/set <ticker> launch on|off` and `/set all launch on|off`.

Global subscriptions are additive, but explicit per-coin rows take precedence for that coin and alert type. That means a per-coin DEWS threshold or safety mode overrides the global default fan-out for the same chat/coin pair.

Global all-stablecoin safety follows are intentionally narrower than per-coin safety follows. The current product tier is:

- downgrade-only
- material-only when scores are present (`oldScore - newScore >= 3`)

This policy applies only to the global `safety all` tier. Explicit per-coin safety follows still honor the coin's configured `safety_mode`.

Global all-stablecoin depeg follows can also carry a worsening-step threshold through `/set all depeg-step 100|250|500`. A value of `off` clears the threshold while leaving global depeg alerts enabled. Preset subscriptions can set the same per-coin threshold in one command, for example `/subscribe usd-top-50 depeg-step 250`.

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
- Expired rows are swept by the `telegram-disambiguation-cleanup` job on the 5-minute Telegram cron slot once `expires_at` is older than `2 * DISAMBIGUATION_TTL_SEC` (10 min minimum) so a slow user mid-selection is not raced. The pass emits `disambiguationRowsCleaned` in its run metadata.
- Pending rows record the initiating Telegram user when Telegram provides `message.from.id`; in groups, only that user can complete or cancel the selection.
- Unknown tickers return a contextual error, with a prefix-based suggestion when available.
- Unknown preset aliases are reported through the same contextual error path, with `/presets` suggested as the discovery surface.
- `/cancel` clears a pending selection.
- `/help`, `/list`, `/presets`, `/status`, and `/start` are not trapped behind pending disambiguation. New mutating commands clear a pending selection only when they come from the same initiating user.

### Update Deduplication

Telegram may redeliver the same `update_id`. The webhook stores the highest processed update in `cache("telegram:last-update-id")` and only processes strictly newer IDs.

## Dispatch Cron

`dispatchTelegramAlerts(db, botToken, signal?)` runs on a dedicated 5-minute cron slot
(`2,7,12,17,22,27,32,37,42,47,52,57 * * * *`), isolated from the quarter-hourly pipeline.

It no longer runs inside the quarter-hourly or daily slots. Safety-grade changes are detected
within 5 minutes of `publish-report-card-cache` refreshing the live safety source cache.

### Snapshot Inputs

Each dispatch run loads:

- Latest DEWS rows from `stress_signals`
- Active depegs from `depeg_events WHERE ended_at IS NULL`
- The latest `safety_grade_history` row for each stablecoin (not just the latest change day)
- The live safety source cache from `cache["alert:safety-source-cache"]`
- Prior dispatch snapshots from cache keys:
  - `alert:dews-snapshot`
  - `alert:dews-alertable-snapshot`
  - `alert:depeg-snapshot`
  - `alert:safety-snapshot`

When `alert:dews-alertable-snapshot` is absent (for example, immediately after deploy), the dispatcher rebuilds it from the raw DEWS snapshot so the rollout does not require a noisy cold start.

DEWS, depeg, and safety snapshots older than `24 hours` are treated as stale and are reseeded before any alerts are sent. Launch promotions use a separate best-effort `alert:launch-snapshot` read later in the run; a missing or malformed launch snapshot falls back to an empty prior set and does not trigger the stale-snapshot seed gate.

The live safety source cache is evaluated separately from those historical snapshots. It is hard-required for safety-grade fan-out and is considered stale after two `publish-report-card-cache` producer intervals.

### First-Run / Stale-Snapshot Behavior

If the raw DEWS/depeg/safety snapshots are missing, unparsable, or older than 24 hours, or if an existing `alert:dews-alertable-snapshot` is stale:

1. Current DEWS/depeg/safety state is written back to the snapshot cache keys, along with the current launch snapshot for later best-effort launch promotion checks.
2. No subscriber messages are sent for that run.
3. The cron returns metadata with `snapshotSeeded: true`.

This prevents a cold start from blasting subscribers with every current condition as if it were a new event.

### Failure Modes

If the `telegram_preset_subscriptions` query throws (transient D1 failure) or `resolveTelegramPresetTargets()` cannot read the stablecoins cache, the dispatch run **aborts** rather than producing a falsely-empty preset-subscriber list. The metadata flags the abort via `presetFailure: true`, increments `presetQueryFailures` or `presetResolutionFailures`, and no snapshots are written. A persistent `telegram:preset-query-failure-count` cache counter accumulates across consecutive failed runs and resets on the next successful run; the current value is exposed as `presetQueryFailures` in the Telegram bot status metrics.

### Alert Detection Rules

`worker/src/cron/dispatch-telegram-alerts.ts` detects:

- DEWS alert-band changes by comparing the current alertable band (`ALERT`/`WARNING`/`DANGER`) to the last alertable band snapshot, while still keeping the raw current-band snapshot for display context
- New active depeg events by comparing current active-depeg snapshot to the prior snapshot
- Depeg worsening milestones by comparing current active event severity to the prior snapshot
- Depeg resolutions by checking which prior active depegs disappeared and then loading the corresponding closed event rows
- Safety-grade changes by comparing the previous `alert:safety-snapshot` against the live safety source cache written by `publish-report-card-cache`
- Safety-grade changes are emitted only when the live safety source cache is generation-valid; fallback-to-history no longer rewrites the alert snapshot as if it were a valid live source
- Launch promotions by comparing the current launch snapshot to `alert:launch-snapshot`
- Methodology-version-only safety regrades are suppressed from user alerts

If the live safety source cache is missing, corrupt, stale, or from the wrong generation, DEWS/depeg/launch alerts can still continue, but safety alerts stay suppressed until a fresh publish lands and the Telegram lane reseeds its prior safety snapshot under that same generation.

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
- Per-coin safety changes respect the coin's `safety_mode`
- Global all-stablecoin safety follows accept downgrades only, with a materiality filter when scores are present (`oldScore - newScore >= 3`; scoreless downgrades still pass through)
- Depeg worsening follows the coin's `depeg_worsening_bps_step`
- Global depeg worsening follows the subscriber's `global_depeg_worsening_bps_step`
- Quiet hours force `disable_notification = true`
- Chats with `alert_snooze_until_ts > now` are fully skipped for the run. The count of currently-snoozed chats (whether or not they would have received an alert this run) surfaces as `chatsWithActiveSnooze` in dispatch metadata.

When the same chat has both a global alert type and a per-coin subscription for the same alert type, the per-coin row wins. This lets coin-specific thresholds or modes override the global default.

### Message Formatting and Limits

- Messages are HTML-formatted via `formatConsolidatedMessage()`.
- Long messages are split with `splitMessage(html, 4000)`.
- `sendBatch()` posts in parallel batches of 4 (staying under Workers 6-connection limit).
- Hard cap: `200 Telegram message attempts per dispatch run`.
- Overflow subscribers are enqueued to `telegram_pending_alerts` and drained in subsequent runs.
- Pending alerts expire after `1 hour` (3600s) — stale alerts are cleaned up automatically.

Delivery semantics are explicit:

- `sent`
- `blocked`
- `retryable_failure`
- `permanent_failure`

Fresh retryable failures are enqueued into `telegram_pending_alerts` instead of being dropped.
`403` responses from the pending-queue dispatcher follow a two-strike rule: the first 403 stamps `consecutive_block_first_at` on `telegram_subscribers` and increments `consecutive_block_count` but leaves alert flags untouched; a second 403 within 24 hours of the first strike disables the subscriber's global flags and all per-coin alert booleans. Any successful send resets both counters. A first strike older than 24 hours is treated as fresh.

### Pending Delivery Queue

When the chunked subscriber queue exceeds the per-run cap (200), overflow messages are written
to `telegram_pending_alerts` in D1 as pre-split HTML chunks. Each subsequent dispatch run
drains up to 25% of its budget from the pending queue before processing fresh events,
ensuring eventual delivery.

Pending alerts have a 1-hour TTL (`PENDING_TTL_SEC = 3600`). The TTL — not a per-row
attempts cap — bounds how long the queue keeps retrying. Each drain re-selects rows whose
`created_at` is within the TTL window and whose `not_before_at` has elapsed; rows that age
past the TTL are deleted at the end of the run.

Within the TTL window, retryable sends are re-queued with an exponential backoff
(`60s → 120s → 240s → 480s → 600s`, capped at 600s) indexed by prior attempts. Telegram's
`Retry-After` header overrides the schedule when present. A defensive
`PENDING_MAX_ATTEMPTS = 20` ceiling guards against a pathological row looping forever.

Dropped rows are classified in the dispatch metadata so operators can tell apart natural
expiry from real failures:

- `pendingDroppedTtlExpired` — row aged past `PENDING_TTL_SEC` and was cleaned up.
- `pendingDroppedPermanentFailure` — Telegram returned a non-retryable, non-blocked error
  (e.g. `400 bad_request`, `401 auth_error`).
- `pendingDroppedMaxAttemptsFallback` — defensive `PENDING_MAX_ATTEMPTS` ceiling was hit
  while the row was still retryable; expected to be 0 in normal operation.

Retry and deferral metadata lives on the pending rows:

- `not_before_at` defers retryable failures, rate-limited sends, and active snoozes until the next eligible run. Quiet hours are re-evaluated at drain time and silence notifications without delaying delivery.
- `last_error_class` and `retry_after_sec` preserve the last retryable Telegram result for observability and backoff.
- `dedupe_key` and `chunk_index` prevent duplicate queued chunks for the same chat/message while still preserving split-message order.

The `dedupe_key` is hashed from the **pre-split canonical message body**, the chunk index, and the `TELEGRAM_SPLIT_VERSION` constant (`worker/src/lib/telegram-alerts.ts`). Hashing the canonical body — not the post-split chunk HTML — keeps the key stable when `splitMessage` is refactored, so in-flight pending rows survive unrelated code changes. Bump `TELEGRAM_SPLIT_VERSION` whenever the splitting algorithm changes in a way that should deterministically invalidate older queued chunks.

Rate-limit isolation is per-chat. A 429 response stamps `not_before_at` on the affected
chat's pending row and defers only that chat in subsequent runs; other chats continue
to drain and to receive fresh alerts against the per-run budget. At the start of each
fresh-send pass, the dispatcher loads `DISTINCT chat_id` for rows whose `not_before_at`
is still in the future and routes their fresh chunks back to the queue
(`freshDeferredPerChat` in the dispatch metadata). The queue stores Telegram's
`retry_after` value when available; otherwise it uses a 60-second retry floor.

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

Stablecoin identity for cemetery diffs uses the stable dead-coin `id` from `shared/data/dead-stablecoins.json`. Legacy `llama:*` and `symbol|deathDate|name` snapshot entries are still treated as equivalent during migration, but new snapshots are rewritten to stable dead-coin IDs only. Tracked-coin diffs use the canonical Pharos stablecoin ID.

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

`GET /api/status` now exposes a `telegramBot` block for the Access-gated `/admin/` dashboard. It aggregates:

- total known chats in `telegram_subscribers`
- alert-enabled chats vs deliverable chats (per-coin follows and global all-stablecoin follows both count)
- total `telegram_subscriptions` rows and average follows per subscribed chat
- pending disambiguation replies still within TTL
- per-alert-type enablement counts (`dews`, `depeg`, `safety`, `launch`, all four)
- top subscribed stablecoins by subscriber count

The status page also reads `crons["dispatch-telegram-alerts"].lastRun.metadata` to show the latest delivery run stats (`subscribersNotified`, `messagesSent`, `blockedUsersCleanedUp`, `eventsDetected`, `snapshotSeeded`, `cappedAtLimit`).

Additional Telegram bot status metrics now include:

- `pendingDeliveries`
- `oldestPendingDeliveryAgeSec`
- `pendingDeliveryBacklog` (`due`, `deferred`, `expired`)
- `retryErrorClassCounts`
- `customPreferenceChats`
- `quietHoursEnabledChats`
- `presetQueryFailures` (consecutive aborted dispatch runs since the last clean preset-subscriber load; only set when > 0)
- dispatch breakdown fields such as `freshRetryQueued`, `freshPermanentFailures`, `pendingRetryQueued`, `pendingDeferred`, `pendingRateLimited`, `pendingRetryAfterSec`, `pendingDropped`, `pendingDroppedTtlExpired`, `pendingDroppedPermanentFailure`, and `pendingDroppedMaxAttemptsFallback`

### Alerting on degraded delivery

`worker/src/cron/telegram-degradation-watchdog.ts` runs on the 5-minute Telegram lane immediately after `dispatch-telegram-alerts`. It reads fresh dispatch metadata and emits a one-shot alert via the existing `sendAlert(...)` webhook rail when any of three conditions hold; each condition emits a single "recovered" alert and clears its cache flag when it clears:

- `telegram_pending_alerts` row count exceeds 500 sustained for more than 20 minutes (cache key `telegram:degradation:pending-since`).
- `alert:safety-source-cache` reports `state != "ok"` for more than two `publish-report-card-cache` intervals (cache key `telegram:degradation:safety-source-since`).
- The most recent `dispatch-telegram-alerts` cron run reported `eventsDetected > 0` but `messagesSent == 0` for three consecutive runs (cache key `telegram:degradation:zero-send-streak`).

The watchdog is wired through `runBestEffortScheduledJob` so its own failures never block the dispatch lane, and its metadata captures `triggered`, `recovered`, and `alertSent` flags per condition for admin inspection via `cron_runs`.

### Per-alert-type delivery breakdown

The dispatch metadata also exposes a `perAlertType` map covering each of the four
alert categories: `dews`, `depeg`, `safety`, `launch`. Each entry reports the
delivery outcome for that category in the latest run so operators can spot
"DEWS delivery fine but safety alerts stalled" at a glance:

- `sent` — chunks that delivered successfully on this run.
- `enqueued` — chunks deferred to the pending queue (rate-limit overflow,
  capacity overflow, or retryable failure).
- `failed` — permanent failures (non-retryable, non-blocked).
- `blocked` — chunks where the chat returned a "blocked" delivery class.
- `firstSendLatencyMs` — wall-clock latency from the start of the dispatch
  run to the first successful send of that category, or `null` if none sent.

A consolidated message can mix multiple alert categories for a single chat.
Attribution uses the chat's "dominant" alert type with priority order
`depeg > dews > safety > launch`, since depeg is the most time-sensitive
event. Pending-queue replays are not attributed because the persisted row
stores only the rendered HTML.

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
- One contextual line when cached report-card, liquidity, or supply data is available for the affected coin

Subscriber alert messages no longer carry a top-level `Pharos Alerts` header — the alert body starts directly with the first section. Each alert line is prefixed with a data-tied glyph so a subscriber can triage at a glance. These glyphs are a sanctioned exception to the repo's no-emoji rule because each one encodes a specific data dimension; **any future addition to the glyph set requires a separate review**.

| Glyph | Meaning | Applied to |
|-------|---------|------------|
| `▲` | Price above peg | Depeg-triggered and depeg-worsening lines with `direction = above` |
| `▼` | Price below peg | Depeg-triggered and depeg-worsening lines with `direction = below` |
| `🟢` | DEWS `CALM` | DEWS band transition lines |
| `🟡` | DEWS `WATCH` and `ALERT` | DEWS band transition lines |
| `🟠` | DEWS `WARNING` | DEWS band transition lines |
| `🔴` | DEWS `DANGER` | DEWS band transition lines |
| `✦` | Launch promotion | Newly tracked stablecoin lines |

Subscriber alert messages end with a `View on Pharos` link. Telegram digest posts end with `Read on Pharos →`, even when cemetery or tracking appendices are present.

## Digest vs Subscriber Alerts

The same bot token can be used for both:

- Channel-style digest posting via `postDigestToTelegram(...)`
- Direct chat replies and subscriber alerts via `sendToChat(...)`

Digest posting uses `TELEGRAM_CHAT_ID`; subscriber alerts use the chat IDs stored in `telegram_subscribers`.

## Operational Notes

- The dedicated 5-minute Telegram trigger reconciles both webhook registration and native slash-command suggestions through `worker/src/lib/telegram-webhook-registration.ts`. After deploying a command-list change, the production bot menu users see when typing `/` should update on the next Telegram slot.
- The command reconciliation issues two scoped `setMyCommands` calls: the full list under `scope: { type: "all_private_chats" }` and a slim list (`subscribe`, `unsubscribe`, `list`, `status`, `mute`, `help`) under `scope: { type: "all_group_chats" }`. Both scopes share a single cache key (`telegram:commands-reconciled`); a fresh cache hit skips both round trips, and bumping `TELEGRAM_COMMANDS_CACHE_VERSION` forces every deployment to reconcile once.
- The same trigger reconciles the bot profile metadata (display name, short description, long description) under cache key `telegram:profile-reconciled` on the same 15-minute cadence. The configured strings are exported constants in `worker/src/lib/telegram-webhook-registration.ts` so changes flow through code review. Telegram returns a 400 "is not modified" response when the submitted value already matches the live one; the reconcile treats that as success and still refreshes the cache marker so the next 15 minutes are a true no-op. Profile-photo updates are not exposed via the Bot API — set the avatar manually through @BotFather using `public/pharos-icon.png`.
- `scripts/register-telegram-webhook.sh`, `scripts/register-telegram-commands.sh`, and `scripts/register-telegram-profile.sh` remain manual recovery tools when an operator needs to force Bot API state outside the Worker reconciliation loop.
- The webhook intentionally returns `200` on most malformed or unauthorized cases so Telegram does not keep retrying noisy payloads.
- The dedicated 5-minute Telegram trigger runs registration reconciliation first, then subscriber alert fan-out through `dispatch-telegram-alerts`.
- The dispatcher consumes Bot API response bodies before returning, which matters under the Workers per-trigger connection cap.
