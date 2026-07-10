# PharosWatchBot and Telegram Alerts

> **Agent navigation** — ~75 KB; Grep the heading you need instead of reading wholesale: Overview · Mini App Launch Entrypoints · Files · Frontend Main Page · Public Pulse Privacy And Freshness · D1 Schema · Secrets and Bindings · Inline Keyboards (Callback Queries) · Webhook Command Flow · Dispatch Cron · Digest Appendices · Admin Visibility · Message Types · Digest vs Subscriber Alerts · Operational Notes · Runbooks.

## Overview

Pharos runs PharosWatchBot for opt-in stablecoin alerts and Telegram channel posts.

The subsystem has four moving parts:

- `POST /api/telegram-webhook` accepts Telegram commands, validates the shared secret from `X-Telegram-Bot-Api-Secret-Token`, and stores subscriber state in D1.
- `worker/src/cron/dispatch-telegram-alerts.ts` diffs the latest DEWS, active depeg, and safety-grade snapshots against cached prior snapshots, then fans out consolidated messages to matching subscribers.
- `worker/src/cron/daily-digest.ts` appends pending cemetery additions and newly tracked coins to the next Telegram digest post after a deploy.
- `worker/src/lib/telegram.ts`, `worker/src/lib/telegram-alerts.ts`, `worker/src/lib/telegram-presets.ts`, and `worker/src/lib/telegram-digest-appendices.ts` handle Bot API sends, alert import stability, preset resolution, message formatting, and digest appendices. `worker/src/lib/telegram-alerts.ts` remains the stable import barrel: ticker parsing lives in `telegram-alerts-parser.ts`, alert/message formatting lives in `telegram-alerts-formatting.ts`, Bot API sends and HTML escaping live in `telegram.ts`, and event diffing lives in the dispatch cron modules.

The delivery system is worker-owned. The frontend exposes a static `/pharoswatchbot/` landing page plus a lightweight public telemetry strip sourced from `/_site-data/telegram-pulse`, which proxies `GET /api/telegram-pulse` through the website-internal lane; it does not call any mutating bot APIs directly. Direct `https://api.pharos.watch/api/telegram-pulse` requests remain API-key protected like other non-exempt public reads. `/pharoswatchbot/` is the canonical public route, and the legacy `/telegram` and `/telegram/*` aliases redirect there.

The safety-alert path now has an additional hard dependency: `publish-report-card-cache` writes a generation-aware live safety source snapshot into `cache["alert:safety-source-cache"]`, and the 5-minute Telegram lane will suppress only safety-grade alerts when that source is missing, corrupt, stale, or from the wrong generation. Each live safety source row may also carry an `explain` payload with scoring-stage, dimension, and raw-input snapshots so safety alerts can say why a grade changed.

## Mini App Launch Entrypoints

PharosWatchBot exposes the Mini App control panel at `https://pharos.watch/pharoswatchbot/app/`. The first launch phase is private-chat scoped: bot commands and alert delivery continue to work in groups, but Web App launch buttons are attached only to private-chat replies because Telegram `InlineKeyboardButton.web_app` is private-chat-only and the MVP does not support group mutation. The private settings panel can toggle global alert families, choose the global depeg worsening step, and manage quiet hours through signed Mini App mutations.

Launch paths:

- Persistent bot menu button: the five-minute Telegram reconciliation lane sets the default menu button to `Manage Alerts` with a Web App URL of `/pharoswatchbot/app/`.
- Bot profile Main Mini App: configured through BotFather as `Launch app`; preview media and loading-screen customization are BotFather-owned and are not reconciled by Worker code.
- Private command replies: `/start`, `/help`, `/presets`, `/settings`, `/list`, `/status <ticker>`, selected explainers, `/set`, `/mute`, `/unmutehours`, `/timezone`, `/unsnooze`, and `/health` include Web App buttons in private chats. These buttons attach `startapp` context (`home`, `settings`, `watchlist`, `presets`, `quiet-hours`, `snooze`, `health`, `forget`, `coin_<stablecoinId>`, `why_<stablecoinId>`, or `coverage_<stablecoinId>`) so the Mini App opens on the matching panel. Private `quicksub:<stablecoinId>` confirmations also include a `coin_<stablecoinId>` tuning button. Group and supergroup replies keep the existing command and callback keyboards.
- Direct Mini App deep links: `https://t.me/PharosWatchBot?startapp=<payload>` may open the app with a start parameter; backend authorization for every Mini App read and mutation validates Telegram `initData`. Telegram reports private direct-link launches as `chat_type="sender"`, which the backend treats as the user's private alert settings context.

Group behavior is intentionally unchanged. Group setup, settings, and subscription mutations remain available only through addressed bot commands and existing callback flows, with the same fresh admin checks as before. The Mini App must not mutate group, supergroup, or channel rows until a fresh admin verification path and group-scoped launch ownership model exist.

BotFather-owned release checklist:

- Configure the bot profile Main Mini App as `Launch app` with URL `https://pharos.watch/pharoswatchbot/app/`.
- Enable the profile launch surface in BotFather separately from the reconciled persistent menu button.
- Upload current preview screenshots/video and confirm they match the private-chat control-panel flow.
- Configure the Mini App loading-screen icon and color in BotFather.
- Test direct links for `https://t.me/PharosWatchBot?startapp=settings`, `watchlist`, `coin_usdc-circle`, `why_usdc-circle`, and `coverage_usdc-circle` on Telegram mobile, desktop, and web.
- Verify the page loads inside Telegram with the Telegram bridge script, signed `initData`, and no frame denial headers.

## Files

- `worker/src/api/telegram-webhook.ts`
- `worker/src/api/telegram-webhook-shared.ts`
- `worker/src/api/telegram-webhook-parsing.ts`
- `worker/src/api/telegram-webhook-messages.ts`
- `worker/src/api/telegram-webhook-store.ts`
- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/cron/daily-digest.ts`
- `worker/src/cron/sync-stablecoins/telegram-tracked-additions.ts`
- `worker/src/lib/telegram-webhook-registration.ts`
- `shared/lib/telegram-bot-registration.ts`
- `worker/src/lib/telegram.ts`
- `worker/src/lib/telegram-alerts.ts`
- `worker/src/lib/telegram-presets.ts`
- `worker/src/lib/telegram-digest-appendices.ts`
- `worker/src/lib/telegram-mini-app-auth.ts`
- `src/app/pharoswatchbot/page.tsx`
- `src/app/pharoswatchbot/app/page.tsx`
- `src/app/pharoswatchbot/app/client.tsx`
- `src/app/pharoswatchbot/app/telegram-sdk.ts`
- `src/app/pharoswatchbot/telegram-pulse-strip.tsx`
- `src/hooks/use-telegram-pulse.ts`
- `worker/src/api/telegram-pulse.ts`
- `worker/src/api/telegram-mini-app.ts`
- `worker/src/api/telegram-mini-app-state.ts`
- `worker/src/api/telegram-mini-app-mutations.ts`
- `shared/lib/telegram-mini-app-contract.ts`
- `shared/lib/telegram-mini-app-catalog.ts`
- `worker/src/lib/telegram-usage-analytics.ts`
- `worker/migrations/0000_baseline.sql`
- `worker/migrations/0123_telegram_usage_analytics.sql`
- `worker/migrations/MANIFEST.md`
- `npx tsx scripts/maintenance/register-telegram.ts --action webhook`
- `npx tsx scripts/maintenance/register-telegram.ts --action commands`

## Frontend Main Page

`src/app/pharoswatchbot/page.tsx` is the product-facing main page for PharosWatchBot and the wider Telegram feature set. It is promoted into the
primary navigation immediately after `/alt-pegs/`.

- Route: `/pharoswatchbot/`
- Legacy alias: `/telegram` redirects to `/pharoswatchbot/`, and `/telegram/*` redirects to the matching `/pharoswatchbot/*` path
- Covers the public `@pharoswatch` digest channel, the `@pharoswatchers` community channel, and the `@PharosWatchBot` subscription bot
- Reads `/_site-data/telegram-pulse` for snapshot-first watcher/subscription telemetry, including the hero pulse strip, the visible active-chat / load-test-evidence / alert-follows / top-follows summary, the Telegram chat lifecycle chart, and a "More information" disclosure for follow composition, daily lifecycle deltas, aggregate alert-type counts, and privacy-filtered quiet-hours/pending-delivery counts
- Does not call the webhook or any other mutating bot API; it links users to Telegram plus the on-site digest archive
- Presents the bot around low-noise growth paths: the recommended `/subscribe dews,depeg usd-top25` default, preset cohorts, group-addressed commands, reasoned safety-grade alerts, quiet hours, inline snooze, and the overflow delivery queue
- The recommended setup deep link preloads a Telegram confirmation for `dews,depeg usd-top25`; it does not silently subscribe the user before they confirm in Telegram.
- Renders a visible FAQ section with matching `FAQPage` JSON-LD, plus `HowTo` and `SoftwareApplication` JSON-LD for the bot setup flow

## Public Pulse Privacy And Freshness

The public pulse keeps the exact `activeWatchers` total visible by product decision, because it is the primary adoption signal on the public page. Low-cardinality supporting metrics are more sensitive while the bot is small: nonzero values below 5 are suppressed for daily new/churn/reactivation deltas, pending deliveries when available, quiet-hours chats, Mini App session/mutation totals, and lifecycle-history delta fields. Suppressed fields are listed in `privacy.suppressedFields`; consumers should omit those tiles instead of rendering zero. Mini App denied counters are an explicit exception: they are abuse/health counters, so they remain visible even below the threshold and are not listed in `privacy.suppressedFields`. Replay-class auth counters are reserved for future telemetry unless a producer is wired.

Pulse publication reuses heavy public sections on a 15-minute cadence, but only within the same UTC day. Mini App "today" counters reload after midnight UTC even when the previous heavy-section snapshot is still inside the reuse window.

`quality.status` is `partial` when a non-critical public telemetry loader failed. Public copy stays generic and never includes raw D1 or provider errors; Access-gated `/api/status` keeps field-level Telegram telemetry diagnostics for operators. Unavailable telemetry takes precedence over privacy suppression: if `pendingDeliveries` cannot be loaded, the response returns `pendingDeliveries: null` and lists `pendingDeliveries` in `quality.unavailableFields`, not in `privacy.suppressedFields`.

Freshness is split deliberately:

- `currentSnapshotAt` / `updatedAt` describe the current aggregate pulse, refreshed on the 5-minute Telegram pulse cadence.
- `lifecycleHistoryUpdatedAt` describes the latest daily lifecycle-history snapshot when any lifecycle snapshot exists, including bootstrap periods where `historySource="live-fallback"` is used because older active-chat cohort points are prefixed ahead of the fixed daily snapshots.
- `lifecycleHistoryEverySeconds=900` documents the lifecycle snapshot refresh cadence.
- Heavy public pulse sections (`topCoins`, lifecycle history, and Mini App daily usage counters) are reused for up to 15 minutes when the cached pulse is valid. The current aggregate counts still refresh on the 5-minute pulse cadence, and pending-delivery count can reuse the dispatch lane's pending-capacity snapshot.

The public chart labels snapshot-backed history as daily lifecycle snapshots. During bootstrap, it keeps the full lifecycle visible by prefixing fixed daily snapshots with live fallback points when active chats predate the first snapshot row. Those fallback prefix points are cumulative current active chats by subscriber-created date and should not be presented as stable churn-adjusted lifecycle history.

## D1 Schema

The Telegram subscriber, disambiguation, and delivery-queue tables are part of `worker/migrations/0000_baseline.sql`. Subsequent Telegram migrations add launch/snooze/preset/retry/audit/claim/retention/reserve fields and indexes. Migration `0172_worker_effect_fencing.sql` adds pending-delivery effect state and processed-update owner/generation/effect fencing; `0183_telegram_fresh_target_effect_fencing.sql` adds the rolling-compatible fresh alert-target lifecycle; `0185_telegram_source_event_resolution.sql` makes source detection and preset target resolution independently durable; `0187_telegram_pending_preference_revalidation.sql` adds monotonic chat-preference generations and pending-risk provenance; `0190_telegram_authoritative_target_plans.sql` makes subscriber capture, rendered plans, target chunks, delivery outcomes, bounded source expiry, and legacy overflow import row-authoritative; `0192_telegram_adoption_analytics.sql` adds aggregate-only adoption/retention reporting and two subscriber milestone timestamps used only for idempotency. [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md) is the complete lineage.

| Table | Purpose | Key fields |
|-------|---------|------------|
| `telegram_subscribers` | Per-chat state and defaults | `chat_id`, `username`, legacy default flags, `global_alert_dews`, `global_alert_depeg`, `global_alert_safety`, `global_alert_launch`, `global_alert_reserve`, `global_depeg_worsening_bps_step`, `quiet_hours_enabled`, `quiet_hours_start_utc`, `quiet_hours_end_utc`, `timezone`, `alert_snooze_until_ts`, `preference_generation`, `first_follow_at`, `first_setup_completed_at`, `consecutive_block_count`, `consecutive_block_first_at`, `created_at`, `last_active_at` |
| `telegram_subscriptions` | Per-chat per-coin alert preferences | composite PK `chat_id, stablecoin_id`, `alert_dews`, `alert_depeg`, `alert_safety`, `alert_launch`, `alert_reserve`, matching `alert_*_override` marker columns, `dews_min_band`, `safety_mode`, `depeg_worsening_bps_step`, `alert_snooze_until_ts` |
| `telegram_preset_subscriptions` | Persistent dynamic preset follows resolved at dispatch/list time | composite PK `chat_id, preset_id`, `alert_dews`, `alert_depeg`, `alert_safety`, `depeg_worsening_bps_step`, `created_at`, `updated_at` |
| `telegram_pending_disambiguation` | Short-lived state for ambiguous ticker replies | `chat_id`, `action_type`, `action_payload`, `resolved_ids`, `ambiguous_ticker`, `candidates`, `remaining_tickers`, `expires_at`, `initiator_user_id` |
| `telegram_pending_alerts` | Authoritative transport queue for planned risk chunks, retries, and admin work | `id`, `chat_id`, rendered payload, retry/dedupe/priority fields, processing claim, `delivery_state`, delivery owner/generation/timestamps, risk `source_event_id`, `alert_scope_json`, `preference_generation`, `markup_policy_json` |
| `telegram_alert_jobs` / `telegram_alert_job_targets` | Durable source-family manifests and exact target delivery truth | source/job identity, exclusive planned/accepted/enqueued/failed/cancelled/expired/execution-unknown counters; target source/plan ordinals, rendered payload, scope/preference/markup provenance, target expiry, pending identity, legacy effect fields, `final_delivery_state` and terminal detail |
| `telegram_alert_source_events` / `telegram_alert_source_resolution_pages` | Immutable detected event plus cursorable preset resolution and target-plan ownership | exact event/baseline payloads, source status, target-plan state/generation/owner/lease, detection-time subscriber horizon/high-water, capture/planning cursors and counts, terminal timestamps |
| `telegram_alert_source_resolution_memberships` / `telegram_alert_source_resolution_targets` | Normalized preset membership and follower-page lineage | `source_event_id`, `alert_type`, `preset_id`, `stablecoin_id`, `page_key`, `chat_id`; current preset intent and snooze state are revalidated before routing |
| `telegram_alert_planning_subscribers` | Frozen subscriber cohort and one durable planning decision per chat | source/generation/chat identity, captured preference generation/activity, initial eligibility, current planned generation, `target_planned`/ineligible/newly-eligible/missing/expired outcome |
| `telegram_alert_target_plan_pages` / `telegram_alert_target_plans` / `telegram_alert_target_plan_items` | Cursorable rendered manifest before transport handoff | immutable page bounds and expected/materialized counts; ordered versioned plan JSON plus digest/chunk counts; normalized source-item coverage |
| `telegram_alert_target_expiry_progress` | Bounded source-expiry reconciliation | processed and remaining subscriber/page/plan/target counts, running/complete state and timestamps |
| `telegram_legacy_overflow_state` | Singleton audit and cursor for the retired cache backlog importer | absent/importing/imported/corrupt/oversized/degraded state, blob digest/size/count, synthetic source id, cursor, imported targets, error/timestamps |
| `telegram_alert_job_target_items` | Queryable source-item coverage for each consolidated target chunk | composite `job_id, target_key, item_key`, `source_event_id`, `created_at` |
| `telegram_alert_dead_letters` | Expired, cancelled, or permanently failed pending-send audit trail | `pending_id`, `chat_id`, `source_type`, `alert_type`, `created_at`, `expired_at`, `attempts`, `last_error_class`, `reason`, `dedupe_key`, copied risk provenance fields |
| `telegram_processed_updates` / `telegram_webhook_operation_mutations` | Retry-safe webhook operation intent, atomic local-mutation proof, and outbound-effect claims | `update_id`, timestamps/type/chat/status, versioned `intent_kind`/`intent_payload`, `mutation_applied_at`, `effect_state`, `effect_kind`, `effect_ordinal`, effect timestamps, `claim_owner`, `claim_generation`, `error_class` |
| `telegram_usage_daily` | Privacy-preserving daily command/setup/action aggregates | `day`, `event_type`, `source_category`, `action_detail`, `outcome`, `latency_bucket`, `failure_class`, `count`, `first_seen_at`, `last_seen_at` |
| `telegram_adoption_daily` | Low-cardinality first-party funnel aggregates; never stores a chat/user ID | allowlisted campaign, placement, stage, feature, mutation-latency bucket, outcome, count and aggregate timestamps |
| `telegram_adoption_retention_daily` | Aggregate D7/D30 first-follow cohorts by surviving active-follow feature | cohort/measurement day, 7/30-day window, `any`/`direct`/`preset`/`global`, durable cohort/retained counts, quality |
| `telegram_adoption_ingress_quota` | Identifier-free global minute ceiling for the public CTA counter | minute bucket, admitted request count, update time; two-day operational retention |
| `telegram_watcher_lifecycle_daily` | Daily active-watcher snapshots for stable public pulse history | `day`, `snapshot_at`, `active_watchers`, `new_watchers`, `churned_watchers`, `reactivated_watchers`, `explicit_coin_follows`, `preset_implied_coin_follows`, `active_preset_followers`, alert-type opt-ins, quiet-hours and pending-delivery counts |
| `telegram_chat_delivery_diagnostics` | Per-chat delivery diagnostics used by `/health` | `chat_id`, `last_successful_delivery_at`, `last_successful_reply_at`, `last_delivery_attempt_at`, `recent_failure_class`, `updated_at` |

`worker/migrations/0117_telegram_global_alert_indexes.sql` adds partial indexes on each `telegram_subscribers.global_alert_*` flag (DEWS, depeg, safety, launch) plus `telegram_pending_alerts(chat_id)` so the dispatcher's global-subscriber fan-out queries and the pending drain JOIN avoid full scans. `worker/migrations/0157_telegram_global_alert_reserve_index.sql` adds the matching partial index for `global_alert_reserve`.

`/unsubscribe all` clears per-coin subscriptions, preset follows, and all-stablecoin alert flags, which stops alerts for that chat. It does not immediately erase the `telegram_subscribers` row, processed-update idempotency rows, delivery diagnostics, or historical aggregate counters needed for abuse prevention, retry safety, and operations.

`telegram_subscribers` rows are auto-pruned after 180 days of inactivity only when they have no meaningful alert state. The `telegram-inactive-cleanup` job runs on the daily 03:00 UTC lane behind a 7-day cache guard (`cache` key `cron:telegram-inactive-cleanup:last-run`) and removes an old subscriber when all global alert flags are off, no preset follows, pending alerts, or pending disambiguation remain, and every per-coin row is inert. A per-coin row is inert only when all alert flags and explicit-override markers are off and its snooze and tuning fields are empty; marker-backed explicit-off choices therefore continue to retain the profile. Live per-coin and preset follows are never expired for inactivity, and the job does not send a re-engagement warning to profiles that are ineligible for deletion. The scan uses `idx_telegram_subscribers_last_active_at` and each eligible chat is removed via a batched cascade DELETE; the job caps at 100 deletions per run so a large backlog cannot push the daily slot past its per-statement budget. The most recent run's `item_count` in the trailing 7-day window is surfaced as `TelegramBotStats.inactiveSubscribersCleanedThisWeek`.

Pending disambiguation rows expire with their command TTL. Pending alert rows leave the live queue when sent, expired, preference-cancelled, or permanently failed; dead-letter rows keep delivery-failure and cancellation audit context without being a live subscription. Expired pending-alert cleanup normally writes a dead-letter copy before deleting the live row; if that dead-letter write fails, the cleanup logs an error-level bypass event and still removes the expired live row so a persistent audit-table failure cannot grow the live delivery queue without bound. Users can also issue `/forget` for an immediate two-step deletion of their subscriber data plus chat-owned cache residue (command cooldown/flood rows, chat-member/admin diagnostics, group welcome markers, legacy re-engagement-warning markers, cached dispatch overflow plans, and nested burst-summary markers); `/unsubscribe all` plus inactivity pruning remains the lighter-touch alternative.

`telegram-retention-cleanup` deletes retained Telegram audit/analytics rows, including source-resolution and target-item lineage, in ordered capped batches instead of uncapped table DELETEs. Processed updates run in 1,000-row batches with a 2-second internal time budget and a 5,000-row ceiling; the other table/cache passes are capped at 10,000 rows per daily 03:00 UTC run. Alert source, resolution, target-item, job, and dead-letter audit rows use the same 90-day window. Usage, adoption, and adoption-retention aggregates use 400 days; CTA quota buckets use two days; the Mini App open-to-first-mutation cache uses 30 minutes and is deleted immediately by `/forget`. A bounded 5,001-row processed-update probe reports the remaining count exactly below that limit or as a lower bound at the limit. Remaining processed-update debt sets `runBudgetTruncated`, while per-table `cappedAtLimit` metadata distinguishes the row ceiling from time-budget exhaustion.

Telegram custom Worker logs are deliberately non-correlatable to a chat. `worker/src/lib/telegram-log.ts` uses a closed compile-time schema plus an independent runtime allowlist for operation/module labels, bounded counts, status codes, retry timing, and fixed error categories. It drops raw chat/user/update/callback/pending/source-event identifiers, message and callback content, URLs, tokens, secrets, `initData`, arbitrary error strings, arrays, and objects; allowed strings receive bounded secret/identifier scrubbing. Do not add unkeyed hashes or pseudonymous chat keys to restore general-log correlation. For one-chat incident response, use the Access-authenticated admin chat diagnostics and the D1 alert-target, pending, dead-letter, processed-update, and delivery-diagnostic rows. Expired-pending cleanup logs one aggregate summary rather than one record per target.

Cloudflare Workers Logs processes sampled custom records under the Cloudflare account permissions configured outside this repository. `worker/wrangler.toml` enables observability and invocation logs with `head_sampling_rate = 0.1`; the repository configures no separate Workers Logpush archive and no Telegram-specific/provider retention duration. Treat console logs as sampled, short-lived operational hints, not the durable incident ledger.

The webhook claims individual Telegram update IDs, completes parsing/authorization and records a bounded, versioned normalized operation intent before local mutation or Bot API effects. Replay-safe D1 mutations commit with a generation-fenced row in `telegram_webhook_operation_mutations`; losing the claim aborts the same D1 batch. The webhook crosses `effect_state = 'started'` only immediately before each irreversible Bot API call and records its effect kind/ordinal. Stale `unstarted` and `planned` claims are recoverable from the stored intent. Once an outbound effect starts, a missing terminal marker is execution-unknown and duplicates are acknowledged without replay. `/api/status.telegramBot.webhookEffectLifecycle` exposes planned/started/unknown counts and bounded ages; `webhookEffectUnknown` remains the combined ambiguous count.

When Telegram upgrades a group to a supergroup, the webhook handles `migrate_to_chat_id` and `migrate_from_chat_id` service messages before command parsing. The migration helper merges the old numeric chat ID into the new one across subscriber state, per-coin subscriptions, preset follows, pending selections, normalized source-resolution targets, pending/dead-letter delivery rows, alert job targets and their item lineage, delivery diagnostics, processed-update chat references, and known exact D1 cache keys such as `telegram:chat-admins:<chat_id>` and `telegram:group-welcome:<chat_id>`. The helper is idempotent because Telegram can deliver either service message first.

When `my_chat_member` reports that a group or supergroup removed the bot
(`left`/`kicked`), the webhook immediately runs the same subscriber-state
cascade as `/forget` for that chat and clears the group welcome/admin cache
keys. Processed-update idempotency rows and aggregate usage counters are
retained.

## Secrets and Bindings

| Binding | Required | Used by |
|---------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | Webhook replies, digest posting (including appended cemetery / tracking notices), subscriber alert fan-out |
| `TELEGRAM_BOT_TOKEN_PREVIOUS` | No | Optional bot-token rotation overlap for signed Mini App `initData`; sends and webhook registration use the current token |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Telegram webhook secret validation for `POST /api/telegram-webhook` via `X-Telegram-Bot-Api-Secret-Token` |
| `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` | No | Temporary overlap secret accepted by `POST /api/telegram-webhook` during secret rotation; registration still emits only `TELEGRAM_WEBHOOK_SECRET` |
| `TELEGRAM_CHAT_ID` | No | Daily digest channel posting, including appended cemetery and tracking notices |

Webhook registration is handled by `npx tsx scripts/maintenance/register-telegram.ts --action webhook`, which calls Telegram `setWebhook` with the webhook URL and the JSON `secret_token` field:

- URL: `https://api.pharos.watch/api/telegram-webhook`
- Secret token: `<TELEGRAM_WEBHOOK_SECRET>`

The dedicated five-minute Telegram worker lane now also reconciles the webhook registration in production on a cache-backed cadence. That means the live Worker periodically re-applies the configured webhook URL, secret token, and `allowed_updates = ["message", "callback_query", "my_chat_member"]` via Telegram `setWebhook`, which self-heals webhook-secret or update-filter drift without requiring a separate manual script run. `web_app_data` does not need a separate `allowed_updates` value for the current Mini App launch MVP because it is not using `Telegram.WebApp.sendData`; if that later changes, `web_app_data` arrives inside a `message` update and must be treated as untrusted input.

The same lane also reconciles bot commands, profile metadata, and the default chat menu button. Menu reconciliation reads `getChatMenuButton`, compares it with the expected `MenuButtonWebApp`, and calls `setChatMenuButton` only when the current menu button drifts. The expected menu payload is:

```json
{
  "menu_button": {
    "type": "web_app",
    "text": "Manage Alerts",
    "web_app": { "url": "https://pharos.watch/pharoswatchbot/app/" }
  }
}
```

### Webhook Secret Rotation

Operator steps for webhook-secret and bot-token rotations live in
[`docs/runbooks/telegram-secret-rotation.md`](./runbooks/telegram-secret-rotation.md).
Telegram secret rotation uses a short overlap window:

1. Set the new `TELEGRAM_WEBHOOK_SECRET`.
2. Move the prior value into `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`.
3. Run the reconciliation flow so Telegram starts sending only the new current secret.
4. Keep the previous secret configured for up to 24 hours as operator policy.
5. Remove `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` after the overlap window ends.

Receiver behavior accepts either current or previous secret whenever both are configured; the 24-hour overlap is enforced operationally by removing the previous secret, not by a timestamp check in the Worker. Registration and reconciliation always send only the current `TELEGRAM_WEBHOOK_SECRET`.

## Inline Keyboards (Callback Queries)

Every subscriber alert sent from the dispatcher carries an inline keyboard, and
alert keyboards are capped at two rows. Multi-coin first chunks use a compact
per-coin mute row before the snooze row: `Snooze <SYM> 4h` buttons
(`coinsnooze:<stablecoinId>:4h`) for the top one or two most-severe coins, so a
user can silence the noisiest coin without opening settings. Multi-coin overflow
chunks (`chunkIndex > 0`) carry only the chat-level snooze row
(`Snooze 1h | 4h | 24h`). Coins are ranked by `rankAlertCoins` (deduped by
`stablecoinId`, scored by the max of depeg deviation bps, DEWS band severity,
and safety downgrade magnitude); the displayed symbol is truncated if long while
the `callback_data` carries only the id. In groups the `coinsnooze` callback
stays admin-gated and yields the standard admin-denial toast for non-admins.
Single-coin first chunks use one contextual row (`Status`, `Depeg 250`, and
`Safety`) plus one compact action row (`Coin snooze 4h`, `Chat snooze 4h`, and,
in private chats only, `Open app`). Tapping a button yields a Telegram
`callback_query` update, routed to
`worker/src/api/telegram-webhook-callbacks.ts`.

The callback data format is `action:arg` (≤64 bytes, the Bot API limit).
Current actions:

- `snooze:1h | 4h | 24h`
- `coinsnooze:<stablecoinId>:1h | 4h | 24h` (per-coin snooze; sets `alert_snooze_until_ts` on the matching `telegram_subscriptions` row)
- `status:<stablecoinId>`
- `depegstep:<stablecoinId>:100|250|500`
- `safetydown:<stablecoinId>`
- `why:<stablecoinId>` (re-sends the `/why` explainer)
- `coverage:<stablecoinId>` (re-sends the `/coverage` card)
- `quicksub:<stablecoinId>` (enables DEWS + depeg for that one coin; private chats receive an audited confirmation with a Mini App tuning button; group chats require admin and keep the callback toast only)
- `manage:page:<N>` (paginates the `/list` `[ Manage ]` keyboard, edits the message in place)
- `unsub:<stablecoinId>` (removes one coin from the chat's subscriptions; group chats require admin, gated identically to `/unsubscribe`)
- `confirm:bulk` / `cancel:bulk` for bulk confirmation prompts
- `confirm:forget` / `cancel:forget` for the data-deletion confirmation flow
- `select:<N>` for setup/preset selection flows
- `help:commands` for command-help navigation
- `setup:*` for setup wizard steps
- `tz:<IANA zone>` for timezone quick picks
- `settings:home` / `settings:home:<page>` — re-render the chat-level settings view and page through per-coin settings buttons
- `settings:gt:<type>` where `type ∈ dews | depeg | safety | launch | reserve` — toggle global alert flag
- `settings:q:<1|0>` — enable (22-07 in the chat's configured timezone, UTC when unset) or disable quiet hours
- `settings:sc` — clear an active snooze
- `settings:o:<stablecoinId>` — open the per-coin settings view (no mutation)
- `settings:c:<stablecoinId>:<setting>:<value>` — apply a per-coin setting where `setting:value` uses short codes to stay within Telegram's 64-byte callback_data limit:
  - `db:A|W|D|0` — DEWS min band `ALERT`, `WARNING`, `DANGER`, or off
  - `sm:a|d|u|0` — Safety mode `all`, `downgrade-only`, `upgrade-only`, or off
  - `ds:100|250|500|0` — Depeg severity gate and worsening step in bps, or off (also clears `alert_depeg` for the coin)
  - `lc:1|0` — Launch on/off
  - `rs:1|0` — Reserve drift on/off

Settings callbacks edit the message in place via `editMessageText`. The chat-level settings keyboard includes paginated `settings:o:<stablecoinId>` buttons for explicitly subscribed coins, so users can open per-coin settings without typing `/settings <ticker>`. If the edit fails (e.g. the message is too old or content is unchanged) the handler falls back to a fresh `sendMessage` so the user still sees the new state.

Unknown action codes receive a visible callback toast but are not treated as
errors, so the bot stays forward-compatible with future keyboards.

Callbacks share the webhook ingress flood cap with commands before the callback
router touches action-specific D1 state. Read-heavy `status:`, `why:`, and
`coverage:` buttons also reuse the matching command cooldown bucket, so button
taps cannot bypass the `/status`, `/why`, or `/coverage` read limits.

Registration script `npx tsx scripts/maintenance/register-telegram.ts --action webhook` declares
`allowed_updates = ["message", "callback_query", "my_chat_member"]` so Telegram forwards only
update types the bot handles.

## Webhook Command Flow

`worker/src/api/telegram-webhook.ts` now acts as a thin ingress coordinator. Command parsing, message formatting, and D1 persistence live in the adjacent `telegram-webhook-*` helper modules so command behavior can be tested without editing the transport entrypoint.

The webhook validates the configured secret from `X-Telegram-Bot-Api-Secret-Token`. During rotation it accepts either `TELEGRAM_WEBHOOK_SECRET` or `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`. Invalid secrets, missing bot token, malformed JSON, and non-command messages all return `200 ok` without side effects so Telegram does not keep retrying.

In group and supergroup chats, commands must be addressed to the bot, for example `/subscribe@PharosWatchBot dews usd-top25`. Unaddressed slash commands and commands addressed to the public channel handle are ignored so Pharos does not intercept another bot's group command surface. Plain numeric replies for an active disambiguation prompt do not need a bot mention, but the reply must come from the same Telegram user who started the pending selection when `initiator_user_id` is available; unrelated group text from other users is ignored. Pending text replies are counted by the same ingress flood cap as commands and callbacks.

Channel-originated mutating commands and callbacks are rejected instead of applying subscription state, because channel admin ownership is not part of the shared-chat authorization model. When Telegram reports the bot was removed from a channel, the webhook still clears the chat-owned subscriber state and lifecycle caches.

While a pending selection is active, `/sample` remains available without
clearing the pending row. `/forget` clears the pending row for the initiating
user before showing its destructive-data confirmation prompt, so stale
disambiguation cannot mask account deletion.

### Group Admin Gating

`/subscribe`, `/unsubscribe`, `/set`, `/mute`, `/pause`, `/unmutehours`, `/unsnooze`, and `/import` are gated to group administrators so a single member cannot rewrite the chat's subscription or quiet-hours state. `/timezone <IANA-zone>` is also admin-gated when it mutates the chat's timezone; `/timezone` with no argument remains a read-only group status view and omits the common-zone keyboard. The gating mode is currently a code-level toggle in `worker/src/api/telegram-webhook.ts`, not a production env binding. The `tz:<zone>` callback handler enforces the same admin check before persisting. Setup wizard callbacks gate mutating steps in groups, but `setup:cancel` and `setup:branch:skip` remain non-mutating exits and rely on the wizard initiator check instead.

- **Hard gate (current default):** non-admin invocations receive a short command-specific refusal reply ("Only group admins can /subscribe. Ask @Alice or Bob.") and the command is short-circuited; the dispatch does not run. Admin display names come from `getChatAdministrators`, capped to three names plus an overflow phrase, and are already visible to every member through the Telegram group member list.
- **Soft (emergency rollback):** changing the code-level toggle to `"soft"` and redeploying warns the non-admin with the same copy but still runs the command. Kept as an operator escape hatch if the hard gate is ever too aggressive in production.

Mutating group authorization uses a fresh `getChatMember` check on every command or callback, so a demoted admin loses mutation access on the next webhook delivery and a newly promoted admin can act immediately. The five-minute `telegram:chat-member:<chat_id>:<user_id>` cache remains available for non-authorization diagnostics, and `telegram:chat-admins:<chat_id>` still caches the administrator list for denial copy. If Telegram's fresh member lookup fails, hard-gated mutations fail closed. Private chats remain open to every chat member.

The ingress flood cap is actor-aware in groups: each Telegram actor gets the
normal 20 actions / 60 seconds allowance inside the chat, with a higher
best-effort chat-wide ceiling as a secondary abuse guard. Private chats use the
chat ID alone. Cooldown rows are acquired before heavy command or Mini App work;
handler throws and transient Mini App 5xx-style failures release the cooldown
row best-effort, while validation and permission denials keep the cooldown.

Group welcome idempotency is stamped only when the audited welcome reply reports
success; the webhook does not perform a second diagnostics read to infer whether
the send succeeded.

### Setup Wizard

`/start` (with an empty payload or `?start=setup`) opens a two-branch inline-keyboard wizard handled in `worker/src/api/telegram-webhook-setup.ts`. The keyboard uses the `setup:*` callback namespace:

- `setup:branch:recommended` — confirms `dews,depeg` alerts for the `usd-top25` preset.
- `setup:branch:custom` — toggles alert types (`setup:type-toggle:<type>`), then `setup:next` to pick a target (`setup:target:<preset|all|type>`), then `setup:confirm`.
- `setup:branch:skip` — clears wizard state and returns a slim command-reference reply with a `/help` affordance for users who prefer typing commands.
- `setup:target:type` — opens a ticker prompt with an inline Cancel button; the next inbound message is resolved via `resolveTicker` and lands on the confirm step. Slash-prefixed single-token replies such as `/USDC` are treated as ticker input while `/cancel` and `/start` remain command escapes.
- `setup:cancel` — clears the wizard state for the user who started it.

Wizard state is persisted as a row in `telegram_pending_disambiguation` with `action_type = "setup-step"` and an `action_payload` JSON of `{ step, alertTypes, target }`. TTL is 5 min, shared with the disambiguation cleanup cron. When wizard state is active and a fresh slash command arrives outside the awaiting-ticker `/TICKER` case, the wizard row is cleared so the command runs unmodified.

### Supported Commands

| Command | Behavior |
|---------|----------|
| `/start` | Opens the two-branch setup wizard (Recommended / Custom / Type commands myself). Deep-link payload `?start=setup` also opens the wizard. Unknown payloads fall back to the long-form start message. |
| `/help` | Sends command reference; private replies include a Mini App settings button |
| `/presets` | Returns the preset watchlist catalog plus subscribe and unsubscribe examples; private replies include a Mini App presets button |
| `/sample` | Private-chat-only preview of a synthetic USDC DEWS alert so users can inspect the alert format before subscribing. It does not read live data or mutate subscription state. |
| `/list` | Returns enabled alert types plus subscribed coins for the chat. When the chat has at least one explicit coin subscription the reply carries a `[ Manage ]` inline button that opens a paginated keyboard (5 coins per page) where each row is a one-tap `[ ❌ <SYMBOL> ]` removal. The keyboard edits the same message in place via `editMessageText`. Group chats apply the same admin gate as `/unsubscribe`. |
| `/status <ticker>` | Returns a compact snapshot: current price freshness, supply, DEWS band, safety grade, active-depeg state, DEX liquidity, best yield context, and — for coins covered by the mint/burn tracker — a `Flow 24h: <signed compact USD>` line (24h net mint/burn flow with data age). The flow line reads the existing per-coin 24h flow cache (`perCoinFlowCacheKey(id, 24)`) and never recomputes; untracked coins omit it. No subscription required. The reply carries a `[ Why? ] [ Coverage ] [ Subscribe ]` inline keyboard so users can drill down or quick-subscribe (DEWS + depeg) without retyping a command. The `Subscribe` button is gated by the same group admin check as `/subscribe`. |
| `/brief` | Returns the latest compact market brief from the daily digest inputs and flags the reply when the latest digest is more than 48 hours old. `/market` is a deprecated compatibility alias and shares the same cooldown bucket. |
| `/top <view>` | Returns ranked current views for `depeg`, `dews`, `yield`, `liquidity`, `chains`, or `safety` |
| `/why <ticker>` | Explains the current Safety Score, weakest dimensions, and key risk notes for one coin. The reply keeps the same `[ Why? ] [ Coverage ] [ Subscribe ]` discovery keyboard as `/status`; private chats also include the Mini App button. |
| `/coverage <ticker>` | Shows which Pharos data surfaces currently cover one coin. The reply keeps the same `[ Why? ] [ Coverage ] [ Subscribe ]` discovery keyboard as `/status`; private chats also include the Mini App button. |
| `/health` | Shows self-diagnostics for the current chat: last successful alert delivery, last successful command reply, queued alert count, recent failure class, quiet-hours/snooze state, and alert readiness |
| `/subscribe <types> <targets>` | Enables one or more alert types and subscribes the chat to one or more explicit coins or preset watchlists |
| `/subscribe <targets> depeg-step <value>` | Enables depeg alerts for explicit coins or preset watchlists and stores a depeg severity gate plus worsening-step threshold (`100`, `250`, `500`, or `off`) |
| `/subscribe <types> all` | Enables one or more alert types across all tracked stablecoins (always gated; see below) |
| `/unsubscribe <targets>` | Removes the named direct coin preferences and/or preset follows independently; unfollowing a preset preserves direct preferences and overlapping presets |
| `/unsubscribe all` | Clears all per-coin subscriptions, disables every current alert flag including launch, and clears the global depeg worsening step (always gated; see below) |

Bulk `/subscribe` and `/unsubscribe` calls are gated behind an inline `[ Confirm ] [ Cancel ]` keyboard when the resolved coin set exceeds 10 coins or the literal `all` token is used. The deferred command is stored in `telegram_pending_disambiguation` with `action_type = 'confirm-bulk'` and inherits the standard 5-minute TTL. Tapping Confirm executes the original command; Cancel (or `/cancel`) clears the pending state without side effects. Confirmation is initiator-locked: only the user who started the bulk command may complete or cancel it.
| `/set <ticker> <setting> <value>` | Tunes per-coin settings such as DEWS floor, safety direction mode, launch on/off, reserve-drift on/off, or depeg severity and worsening step. Private success replies include a per-coin Mini App tuning button. |
| `/set all <setting> <value>` | Enables or disables global all-stablecoin alert types (`dews`, `depeg`, `safety`, `launch`, `reserve`) or sets the global depeg severity and worsening-step threshold. Private success replies include a Mini App watchlist button. |
| `/settings` | Opens an inline-keyboard view of chat-level settings: quiet hours toggle, snooze clear, and global alert toggles for DEWS / depeg / safety / launch / reserve. Each tap edits the message in place via `editMessageText` so the user sees a single self-updating panel. |
| `/settings <ticker>` | Opens a per-coin inline keyboard with DEWS min band (`ALERT/WARNING/DANGER/off`), safety mode (`all/downgrade-only/upgrade-only/off`), depeg severity and worsening step (`100/250/500/off`), launch on/off, and reserve-drift on/off rows. A `← Back to chat settings` button returns to the chat-level view. |
| `/mute <start>-<end>` | Enables quiet hours interpreted in the chat's `/timezone` (defaults to UTC; messages still deliver, notifications are silenced) |
| `/pause` | Pauses **all** alert delivery indefinitely by writing the far-future sentinel `alert_snooze_until_ts = 4102444800` (2100-01-01 UTC) through the existing chat-level snooze path, so the dispatcher's snooze filter skips the chat with no routing change. `/pause off` (or `/pause resume`) clears it; `/unsnooze` and the `/settings` Clear-snooze button also resume. `/pause <duration>` (`1h`, `4h`, `24h`) sets an ordinary timed snooze, not the sentinel. A paused chat renders distinctly as "Paused" (not a multi-thousand-day countdown) in `/list`, `/health`, and `/settings`, and the Home keyboard shows a single Resume button. Private replies include a Mini App snooze button. |
| `/timezone <IANA-zone>` | Sets the chat's IANA timezone for resolving quiet hours locally (e.g. `Europe/Paris`). Sending `/timezone` with no argument shows the current zone. Private no-argument replies also include common-zone buttons and a Mini App quiet-hours button; group no-argument replies are read-only and omit the keyboard. Unset chats use UTC, the historical behavior. |
| `/unsnooze` | Clears active alert snooze immediately; private replies include a Mini App snooze button |
| `/unmutehours` | Disables quiet hours |
| `/cancel` | Cancels a pending disambiguation flow |
| `/forget` | Two-step inline-confirmed deletion of the caller's subscriber data (per-coin and preset subscriptions, global toggles, quiet hours, snooze, delivery diagnostics, pending alerts, alert-job target rows, and dead-letter rows). Private chats only. Processed-update idempotency rows and aggregate alert-job manifests are retained until their normal prune because they contain no live subscription state. |
| `/export` | Emits one copy-paste-safe, self-contained `pw2` **watchlist token**. V2 preserves each direct/local coin row's five alert-family flags, explicit override markers, DEWS/safety/depeg tuning, and every followed preset's independent family/step policy. Its canonical payload carries a content-derived catalog version, gzip compression, collision-checked stable ID fingerprints, and a truncated SHA-256 corruption/tamper digest (integrity only, not authentication). Global-all settings, quiet hours, timezone, chat/per-coin snoozes, pending actions, and delivery history are intentionally excluded. Export fails closed rather than dropping unavailable rows or emitting a split token. Read-only; works in any chat. |
| `/import <token>` | Reads both token versions. Historical v1 tokens retain their original additive behavior: unavailable coins are reported/skipped and one uniform family set is enabled without removals or per-coin tuning. V2 validates every coin against the current subscribable registry and every preset against the catalog, then shows exact add/remove/change counts and every affected id. Long previews split deterministically, with the `[ Confirm ] [ Cancel ]` keyboard attached only to the final message. Confirmation replaces only portable direct/local and preset state in one generation-guarded D1 batch with the webhook operation marker. A stale preview is terminally consumed without changing preferences and asks the user to preview again. Retained coin rows keep their per-coin snooze; removed rows lose their snooze; chat-level snooze and all other excluded settings stay unchanged. The pending slot is initiator-locked, and group imports remain admin-gated. |

### /start Deep-Link Payloads

Telegram supports `https://t.me/PharosWatchBot?start=<payload>` deep links. The payload arrives as the `/start` argument string and is dispatched through `parseStartPayload` in `worker/src/api/telegram-webhook-parsing.ts`.

Supported payload schemes (lowercase, no spaces, max 64 characters, characters `[A-Za-z0-9_-]` only):

| Payload | Behavior |
|---------|----------|
| `sub_<types>_<targets>` (e.g. `sub_dews-depeg_usd-top25`) | Translates to `/subscribe <types> <targets>` and dispatches the existing subscribe path. Multiple alert types are joined by `-`. Only fires in private chats — group deep-links fall back to the standard onboarding reply with no mutation. |
| `status_<id>` | Runs the existing `/status` handler against the supplied Pharos coin id. Allowed in any chat. |
| `why_<id>` | Runs the existing `/why` handler. Allowed in any chat. |
| `coverage_<id>` | Runs the existing `/coverage` handler. Allowed in any chat. |
| `setup` | Opens the standard two-branch setup wizard. |
| `sample` | Alias entrypoint for `/sample`: in a private chat it runs the synthetic USDC DEWS preview (same message as `/sample`); in a group it falls back to the read-only start reply and does not run the preview. Surfaced by the Mini App Home "Send me a sample alert" deep link. |
| `app` / `home` | Sends a Mini App launch nudge. Private chats receive a Web App button for the home panel; groups receive a DM link because Telegram rejects `web_app` buttons outside private chats. |
| Unknown or malformed | Falls back to the standard `/start` reply; the user never sees an error. |

Telegram only delivers `?start=` deep links in private chats, but the dispatcher still defensively checks `chat.type === "private"` before running mutating `sub_*` payloads.

### Alert Types

- `dews`
- `depeg`
- `safety`
- `launch`
- `reserve` — opt-in per-coin reserve-drift alert (C123). Fires once when a live-reserve-tracked coin's live reserve mix newly diverges from its curated profile beyond the shared `delta > 15` threshold (`isReserveDriftThresholdExceeded`), reusing the four-hourly `checkCollateralDrift` set. Transition-gated (entering-drift only) and advisory; it does not feed the Safety Score or report card.

### Preset Watchlists

Preset watchlists are persistent dynamic sources independent of the direct per-coin preference model.

- Supported canonical aliases: `usd-top10`, `usd-top25`, `usd-top50`, `non-usd-top10`, `non-usd-top25`, `non-usd-top50`, `eur-top10`, `gold-top5`, `mcap-ge-1b`, `mcap-ge-100m`
- Top-N peg presets also accept dashed aliases, for example `usd-top-10`, `non-usd-top-25`, and `usd-top-50`; commands canonicalize them before subscription storage.
- Resolution happens for command/setup previews and at dispatch time inside `worker/src/lib/telegram-presets.ts`; dispatch-time resolution is authoritative
- The resolver uses the current strict `stablecoins` cache plus tracked stablecoin metadata to map each preset alias to concrete active coin IDs; `non-usd-top*` includes active tracked coins whose `flags.pegCurrency` is not `USD`
- `/subscribe ... <preset>` stores only a persistent row in `telegram_preset_subscriptions`; resolved members are preview data and are not copied into `telegram_subscriptions`
- `/unsubscribe <preset>` deletes only the named persistent preset row, preserving direct coin preferences and overlapping preset follows; removal does not require a successful dynamic-membership preview
- `/list` shows dynamic preset rows and direct/local coin rows as separate sources without expanding preset membership
- Mixed commands keep the sources separate: explicit ticker targets mutate direct rows while preset targets mutate preset rows in the same atomic intent
- Legacy rollout is conservative: every pre-existing `telegram_subscriptions` row is retained as direct/local intent because old preset-materialized rows cannot be distinguished reliably from user-created direct preferences. No backfill deletes or reclassifies a row.
- Preset DEWS follows use the default `ALERT` floor, and preset safety follows use the default all-changes mode, matching per-coin rows without custom tuning. Preset-level DEWS/safety tuning does not exist yet.
- `launch` does not accept presets; launch alerts support explicit ticker/coin-id targets and the special `all` target
- `reserve` does not accept presets either; reserve alerts support explicit ticker/coin-id targets and the special `all` target
- Preset resolution fails closed when the stablecoins cache is unavailable; the bot returns a temporary retry message instead of subscribing stale or incomplete cohorts

Additional alert controls:

- `dews_min_band`: optional per-coin floor (`ALERT` default, or `WARNING` / `DANGER`)
- `safety_mode`: `all`, `downgrade-only`, or `upgrade-only`
- `depeg_worsening_bps_step`: optional per-coin depeg severity gate and worsening follow-up step (`100`, `250`, `500`)
- `telegram_preset_subscriptions.depeg_worsening_bps_step`: optional dynamic preset depeg severity gate and worsening follow-up step (`100`, `250`, `500`)
- `global_depeg_worsening_bps_step`: optional all-stablecoin depeg severity gate and worsening follow-up step (`100`, `250`, `500`)
- `global_alert_*`: subscriber-level flags that subscribe the chat to every tracked stablecoin for that alert type, including `launch` and `reserve`
- quiet hours: subscriber-level hour window that forces `disable_notification = true`, interpreted in the subscriber's `timezone` column (unset = UTC)

`launch` alerts have no additional per-coin tuning beyond on/off subscription state, and can now be toggled through `/set <ticker> launch on|off` and `/set all launch on|off`.

`reserve` alerts likewise have no per-coin tuning beyond on/off subscription state, toggled through `/set <ticker> reserve on|off`, `/set all reserve on|off`, the per-coin settings keyboard (`rs` row), or the global Reserve toggle. Reserve drift only fires for coins with live-reserve tracking; coins that fall back to curated reserves are never alerted, and a coin dropped from the drift set by a failed live fetch produces no "drift cleared" message (entering-drift only, v1). Because the producer is the four-hourly reserve slot, a newly-opened drift can be delayed up to ~4h.

Quiet-hours windows must have different start and end hours. Use `/unmutehours`, alert toggles, or unsubscribes for all-day silence rather than encoding `0-0`.
If a configured timezone cannot be resolved by the Worker runtime ICU tables, quiet-hours evaluation falls back to UTC and emits a rate-limited structured Telegram warning keyed by the zone (`quietHoursTzFallback`).

Global and preset subscriptions are additive, but an enabled direct per-coin row takes precedence for that coin and alert type. That means a direct DEWS threshold, safety mode, or depeg worsening step overrides inherited fan-out for the same chat/coin pair. A marker-backed per-coin `off` suppresses matching preset/global fan-out for that family. The dispatcher requires both `alert_<type> = 0` and `alert_<type>_override = 1` before treating a per-coin row as an explicit opt-out; unmarked zeroes created by partial or legacy writes do not suppress global or preset fan-out. When multiple presets cover the same coin, their independent rows remain intact and the most inclusive positive depeg worsening step is selected deterministically unless a direct row owns the local tuning.

The effective precedence is **per-coin > preset > all-stablecoins**. `/list` surfaces this with one precedence note ("Precedence: per-coin > preset > all-stablecoins. A per-coin Muted overrides the rest.") and renders a per-coin row with marker-backed off flags as "Muted (overrides defaults)" rather than a bare "Muted", because that row actively suppresses the preset/global default for the coin (the per-coin `off` precedence above). Per-coin rows with at least one flag enabled are tagged "· per-coin" so the active override lane is legible. `/list` does not expand presets into their member coins; preset coverage is shown at the preset level only. This is a display change; which alerts fire is unchanged.

Global all-stablecoin safety follows are intentionally narrower than per-coin safety follows. The current product tier is:

- downgrade-only
- material-only when scores are present (`oldScore - newScore >= 3`)

This policy applies only to the global `safety all` tier. Explicit per-coin safety follows still honor the coin's configured `safety_mode`.

Global all-stablecoin depeg follows can also carry a severity threshold through `/set all depeg-step 100|250|500`. A configured value gates fresh depeg and resolution notifications below that peak deviation and also controls worsening follow-up milestones. The current model intentionally couples the severity floor and worsening cadence; they cannot be tuned independently. A value of `off` clears the threshold while leaving global depeg alerts enabled. Preset subscriptions can set the same per-coin threshold in one command, for example `/subscribe usd-top-50 depeg-step 250`.

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
- Expired rows are swept by the `telegram-disambiguation-cleanup` job on the 5-minute Telegram cron slot once `expires_at` is older than `2 * DISAMBIGUATION_TTL_SEC` (10 min minimum) so a slow user mid-selection is not raced. The expiry scan is indexed and capped at 5,000 deletions per run; overflow is left for later ticks and surfaced via `disambiguationCleanupHasMore`. The pass emits `disambiguationRowsCleaned` in its run metadata.
- Pending rows record the initiating Telegram user when Telegram provides `message.from.id`; in groups, only that user can complete or cancel the selection.
- Unknown tickers return a contextual error, with a prefix-based suggestion when available.
- Unknown preset aliases are reported through the same contextual error path, with `/presets` suggested as the discovery surface.
- `/cancel` clears a pending selection.
- `/help`, `/sample`, `/list`, `/presets`, `/status`, `/health`, and `/start` are not trapped behind pending disambiguation. `/forget` clears a pending selection only when it comes from the same initiating user, then runs its confirmation prompt. New mutating commands clear a pending selection only when they come from the same initiating user.

### Update Deduplication

Telegram may redeliver the same `update_id`. The webhook owner/generation-claims each update, persists its normalized intent as `planned`, and atomically proves local D1 mutation before any reply. Stale `unstarted` claims reparse the inbound update; stale `planned` claims resume the stored intent instead of rereading mutable/deleted pending state. Already processed duplicates return `200 ok`; fresh in-flight duplicates return `503 retry`. A retry that finds `started` or `execution_unknown` returns `200 ok` without rerunning the operation. This deliberate at-most-once boundary prevents duplicate Telegram effects after timeouts or post-send crashes. Operators reconcile `telegramBot.webhookEffectLifecycle` and the processed-update row before any manual repair.

Ordinary processed-update rows are retained for 7 days. `started` and `execution_unknown` evidence is retained for 90 days. The daily `telegram-retention-cleanup` job owns capped processed-update pruning alongside the other Telegram audit and analytics retention passes; webhook requests only claim and mark update rows for idempotency.

Command, callback, setup, and settings replies use the shared audited reply helper. Successful command replies update only `last_successful_reply_at`; alert delivery senders update `last_successful_delivery_at`. This keeps `/health` able to distinguish "commands work" from "alerts have not delivered recently." Reply failures record `reply_failure` usage events and update the recent failure class for the affected chat.

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
- The live safety source cache from `cache["alert:safety-source-cache"]`, including optional `explain` snapshots produced with the same report-card methodology constants as the public card
- Prior dispatch snapshots from cache keys:
  - `alert:dews-snapshot`
  - `alert:dews-alertable-snapshot`
  - `alert:depeg-snapshot`
  - `alert:safety-snapshot`
  - `alert:reserve-snapshot` — a versioned producer envelope (`generation`, `publishedAt`, `continuous`, `driftIds`) written by the four-hourly reserve slot (`hourly-live-reserves.ts` after `checkCollateralDrift`), read read-only by dispatch
  - `alert:reserve-dispatched-snapshot` — the dispatch-owned baseline of the drift id-set the dispatcher last acted on; written by `writeSnapshots` at the end of each run

When `alert:dews-alertable-snapshot` is absent (for example, immediately after deploy), the dispatcher rebuilds it from the raw DEWS snapshot so the rollout does not require a noisy cold start.

DEWS and depeg dispatch snapshots older than `24 hours` are treated as stale and are reseeded before any DEWS/depeg alerts are sent. Launch promotions use a separate best-effort `alert:launch-snapshot` read later in the run; a missing or malformed launch snapshot falls back to an empty prior set and does not trigger the stale-snapshot seed gate.

Reserve-drift transitions diff the producer's current drift set (`alert:reserve-snapshot`) against the dispatch baseline (`alert:reserve-dispatched-snapshot`). The producer (four-hourly reserve slot) is the only writer of the current set, so the dispatch trigger never opens reserve-adapter connections. Dispatch requires the expected source generation and a `publishedAt` age no greater than two producer intervals (8 hours). Missing, malformed, future-dated, stale, or wrong-generation envelopes suppress reserve transitions and preserve the prior baseline. The first fresh publish after a missing/legacy/wrong-generation/stale predecessor is marked `continuous: false`; dispatch reports the source as `recovering`, cold-seeds the current drift set, and sends no reserve transition. Only the next continuous fresh generation becomes alertable. A general DEWS/depeg seed run still preserves an existing reserve baseline, while a first healthy run with no baseline treats the current producer set as the baseline.

The live safety source cache is evaluated separately from those historical snapshots. It is hard-required for safety-grade fan-out and is considered stale after two `publish-report-card-cache` producer intervals. Legacy rows without `explain` remain valid; malformed or future-version `explain` payloads are dropped at parse time without dropping the row.

### First-Run / Stale-Snapshot Behavior

If the raw DEWS/depeg snapshots are missing, unparsable, or older than 24 hours, or if an existing `alert:dews-alertable-snapshot` is stale:

1. Current DEWS/depeg state is written back to the snapshot cache keys, along with the current launch snapshot for later best-effort launch promotion checks.
2. No subscriber messages are sent for that run.
3. The cron returns metadata with `snapshotSeeded: true`.

This prevents a cold start from blasting subscribers with every current condition as if it were a new event.

Safety-grade fan-out has its own source-cache freshness gate and seeds `alert:safety-snapshot` separately when the prior safety snapshot is absent, unparsable, or stale.

### Eventless Fast Path

When the dispatch snapshots are healthy, the live safety and reserve sources are valid, and no DEWS, depeg, safety, launch, or reserve changes are detected, the dispatcher takes an eventless fast path. The fast path refreshes the snapshot cache and returns complete cron metadata, but skips subscriber fan-out, alert-job manifests, per-chat backoff reads, and fresh delivery assembly.

The no-work branch is not used when snapshots need seeding, the safety source is missing/corrupt/stale/wrong-generation, any alert family has an actionable change, or due/expired pending rows need queue work. A non-alertable reserve source can still use this path because its baseline is explicitly preserved or cold-seeded; the returned metadata exposes `reserveAlertSourceState`, `reserveAlertSourceAgeSeconds`, `reserveAlertSourceGeneration`, and `reserveAlertsSuppressed`. Due pending rows still drain on an otherwise eventless run; expired pending rows still run the TTL cleanup. The latest pending-capacity and safety-source assessment from dispatch are passed to the degradation watchdog and pulse snapshot sidecar in the same five-minute lane so those sidecars do not repeat the same D1 reads.

### Failure Modes

If the `telegram_preset_subscriptions` query throws (transient D1 failure) or `resolveTelegramPresetTargets()` cannot read the stablecoins cache, preset-backed delivery is marked degraded rather than treated as an empty subscriber list. Direct and global subscribers continue when they can be resolved safely, snapshot writes still proceed for the current run, and structured metadata/logging records whether the failure was query or resolution related. A persistent `telegram:preset-query-failure-count` cache counter accumulates across consecutive failed preset-resolution runs and resets on the next successful run; the current value is exposed as `presetQueryFailures` in the Telegram bot status metrics.

### Alert Detection Rules

`worker/src/cron/dispatch-telegram-alerts.ts` detects:

- DEWS alert-band changes by comparing the current alertable band (`ALERT`/`WARNING`/`DANGER`) to the last alertable band snapshot, while still keeping the raw current-band snapshot for display context
- New active depeg events by comparing current active-depeg snapshot to the prior snapshot
- Depeg worsening milestones by comparing current active event severity to the prior snapshot
- Depeg resolutions by checking which prior active depegs disappeared and then loading the corresponding closed event rows; only rows with recovery close reasons (`recovered-primary`, `recovered-dex`, `recovered-native`) emit "Depeg Resolved"
- Safety-grade changes by comparing the previous `alert:safety-snapshot` against the live safety source cache written by `publish-report-card-cache`
- Safety-grade changes are emitted only when the live safety source cache is generation-valid; fallback-to-history no longer rewrites the alert snapshot as if it were a valid live source
- Launch promotions by comparing the current launch snapshot to `alert:launch-snapshot`
- Reserve-drift transitions by comparing the producer's current drift id-set (`alert:reserve-snapshot`) to the dispatch baseline (`alert:reserve-dispatched-snapshot`); only coins newly entering drift fire (entering-drift only)
- Methodology-version-only safety regrades are suppressed from user alerts

Safety-grade alerts attach a `Reason:` blockquote instead of the generic `Context:` blockquote used by DEWS/depeg alerts. The reason builder compares the previous and current optional `explain` snapshots and ranks scoring-stage movements before weighted dimension deltas: newly binding or tighter active-depeg caps, new no-liquidity penalties, new or tighter variant-parent caps, then the largest dimension movement matching the overall grade direction. When no valid `explain` data is available, the alert falls back to score or grade movement and appends the generic live context after `Now:`. Blacklist/freeze metadata remains display-only under the current methodology and is not used as a causal reason.

If the live safety source cache is missing, corrupt, stale, or from the wrong generation, DEWS/depeg/launch alerts can still continue, but safety alerts stay suppressed until a fresh publish lands and the Telegram lane reseeds its prior safety snapshot under that same generation.

If the reserve producer envelope is missing, corrupt, stale, future-dated, or from the wrong generation, the other alert families continue but reserve alerts stay suppressed. The `telegramSummary` object from `/api/health` and the latest dispatch cron metadata expose the reserve source state, age, generation, and suppression flag. Recovery intentionally requires two producer publications: the first cold-seeds as `recovering`, and the next continuous four-hourly publication restores `ok` without replaying transitions accumulated during the gap.

When the safety snapshot has to be reseeded (e.g. methodology-version flip changes the source generation), the dispatcher compares the current live source against the last seen `alert:safety-snapshot` purely to count the safety changes that would otherwise have been emitted and surfaces the total as `suppressedSafetyChangesAtSeed` in the cron metadata. The count is informational — no messages are sent — so operators can spot when a generation flip is masking real downgrades and inspect the safety-grade history directly.

If the cached safety snapshot is missing a coin, the dispatcher suppresses the alert unless that coin's latest grade-change row is newer than the cached snapshot timestamp. This avoids false `UNKNOWN → grade` alerts when repairing older partial snapshots or when a newly tracked coin gets its first seed row.

The separate `alert:dews-alertable-snapshot` cache key prevents duplicate same-band DEWS alerts when a coin silently dips to `WATCH` or `CALM` and then returns to the same alert band. Example: `ALERT → WATCH` produces no message and does not reset the alert dedupe baseline, so a later `WATCH → ALERT` does not resend the same `ALERT` notification.

The helper predicates `isDewsAlertable()` and `isDewsDeescalation()` live in `worker/src/lib/telegram-alerts.ts`.

### Burst Summary Mode (C128)

During sustained market-wide storms a global-follow chat can match a large number of coins in one run. `collapseBurstChats` (in `dispatch-telegram-routing.ts`) runs after routing but BEFORE the C102 format pass: when a chat matches at least `BURST_EVENT_THRESHOLD` distinct coins with **global** as the dominant match source (`globalCount > specificCount`), its consolidated alerts are replaced with a single burst-summary chunk (`Market-wide activity — N followed coins … Open your watchlist`, with a `t.me/PharosWatchBot?startapp=watchlist` deep link and the chat-level snooze row). Running before formatting means the collapse also bounds CPU, hence the C102 dependency. Chats where explicit per-coin subscriptions dominate are never summarized.

A per-chat marker is persisted as one JSON blob in `cache["telegram:burst-markers"]` (`chatId → { enteredAt, coinIds }`). While the marker is live the chat receives only coins not already summarized (delta-only); an empty delta suppresses the run entirely. The TTL (`BURST_MARKER_TTL_SEC`, default 1800s) is anchored to the first burst entry and not refreshed, so normal per-coin delivery resumes after it. Dispatch deletes the shared cache row when pruning leaves no live markers, and `/forget` removes the chat's nested marker entry. Quiet hours and snooze still apply (the summary defers/suppresses through the same path). `BURST_EVENT_THRESHOLD` ships effectively OFF (very high) and is lowered only after observing `burstCollapsedChats`/`burstDeltaSuppressed` in dispatch metadata.

### Subscriber Filtering

Subscribers are selected from two sources:

- `telegram_subscriptions`
- `telegram_subscribers`

Per-coin rows check the corresponding boolean on `telegram_subscriptions`:

- `alert_dews`
- `alert_depeg`
- `alert_safety`
- `alert_launch`
- `alert_reserve`

Global all-stablecoin follows use the matching `telegram_subscribers` flags:

- `global_alert_dews`
- `global_alert_depeg`
- `global_alert_safety`
- `global_alert_reserve`
- `global_alert_launch`

Filtering is subscription-aware:

- DEWS compares `newBand` against the coin's `dews_min_band`
- Per-coin safety changes respect the coin's `safety_mode`
- Global all-stablecoin safety follows accept downgrades only, with a materiality filter when scores are present (`oldScore - newScore >= 3`; scoreless downgrades still pass through)
- Fresh depeg and recovery-resolution notifications with a configured `depeg_worsening_bps_step` require the event's deviation to meet that bps threshold; coverage-lost, orphan, and superseded closures update the depeg snapshot but do not notify as recovered
- Depeg worsening follows the coin's `depeg_worsening_bps_step`
- Global depeg uses the subscriber's `global_depeg_worsening_bps_step` for both the initial severity gate and worsening follow-ups
- Quiet hours force `disable_notification = true`
- Chats with `alert_snooze_until_ts > now` are fully skipped for the run. The count of currently-snoozed chats (whether or not they would have received an alert this run) surfaces as `chatsWithActiveSnooze` in dispatch metadata.
- A durable **Paused** state (`/pause`) is the same snooze column set to the far-future sentinel `4102444800` (2100-01-01 UTC), so the dispatcher skips a paused chat with no routing change. The sentinel is recognized by `isPausedSentinel()` in `worker/src/lib/telegram-constants.ts` and rendered as "Paused" (rather than a multi-thousand-day countdown) in `/list`, `/health`, and `/settings`. Resuming clears the column to NULL via `/pause off`, `/unsnooze`, or the Clear-snooze button; no path treats NULL as still-paused.
- Per-coin snoozes live on `telegram_subscriptions.alert_snooze_until_ts` (added in `worker/migrations/0119_telegram_subscription_snooze.sql`). The dispatcher filters them out at the subscriber-row SELECT and also loads a `Map<stablecoinId, Set<chatId>>` of active per-coin snoozes so the global fan-out lane suppresses the same (chat, stablecoin) pair. Per-coin snooze and chat-level snooze stack — either active suppresses fan-out.

When the same chat has both a global alert type and a per-coin subscription for the same alert type, the per-coin row wins. This lets coin-specific thresholds or modes override the global default, and it lets `/set <ticker> <type> off` silence that coin even when the chat follows a preset or all-stablecoin alert family.

If a depeg closes with a recovery reason and reopens for the same coin between two dispatch snapshots, the alert is framed as the new detected event with the just-ended recovery duration. If the prior row closed for coverage-loss, orphan cleanup, or superseded direction, the new row is framed as a fresh detected event without a recovery-duration claim. The dispatcher suppresses the separate resolved line for that same coin in the same message so users do not receive contradictory "resolved" and "detected" sections at once.

### Message Formatting and Limits

- Messages are HTML-formatted via `formatConsolidatedMessage()`.
- Long messages are split with `splitMessage(html, 4000)`.
- `sendBatch()` posts in parallel batches of 4 (staying under Workers 6-connection limit).
- Hard cap: `3,600 Telegram message attempts per dispatch run`.
- `dispatch-telegram-alerts` has a 14-minute app-level hard timeout and 30-second lease heartbeats; pending-drain and fresh-send loops stop starting Telegram batches after a 4-minute soft deadline, releasing unattempted pending claims or queueing the untouched fresh tail so slow Bot API runs yield the next 5-minute trigger interval.
- Detection first inserts an immutable `telegram_alert_source_events` row. Dynamic preset followers are resolved in normalized cursor pages; completed pages are reused and only pending pages are queried on recovery.
- The first target-planning claim freezes `subscriber_horizon_at` at the source event's `detected_at` and records the greatest chat id created by that instant. Accounts created later cannot enter historical fan-out. Preference history is not reconstructed: when each frozen chat is captured, its current eligibility and preference generation are recorded atomically, then current intent is checked again immediately before target materialization. A capture-eligible chat that later unsubscribed is explicit, a capture-ineligible chat that became eligible is recorded as `eligible_after_event` and receives no historical alert, and unrelated preference churn may use the current generation.
- Each eligible chat is rendered into strict versioned plan JSON with a SHA-256 digest, bounded chunks, immutable page bounds, and normalized source-item rows. Page completion and the source cursor advance only after every plan and exact target chunk is durable. A crash resumes the incomplete page range without widening its subscriber cohort or changing prior ordinals.
- The coordinator advances at most 32 durable transitions per invocation. A normal bounded return generation-fences and releases its own planning claim so the next five-minute invocation can resume immediately; an exception or process loss retains the 120-second lease. The deterministic bound is 38 transitions/two invocations for 800 subscribers and 800 chunks, and 281 transitions/nine invocations (45 minutes) for the reviewed 5,000-subscriber, 7,483-chunk burst. Risk sources and pending rows use a two-hour TTL; the enforced load gate includes planning, outage-unavailable time, and post-recovery drain and requires at least 20 percent margin.
- Delivery opens only after capture and materialization are complete. Every planned chunk is then atomically inserted into `telegram_pending_alerts` and changed from target `planned` to `queued`; there is no direct risk-alert send or cache-authoritative overflow lane. New risk rows carry their immutable source event, exact coin/family group scope, current chat preference generation, and original markup/link-preview policy. Every split chunk in one message group carries the same conservative group scope, so one newly ineligible pair cancels every remaining chunk instead of delivering a partial stale group.
- Snapshot baselines remain unchanged until the manifest is ready, delivery is open, and no planned target remains. The fixed snapshot writes and `baseline_committed` transition share one D1 batch; `complete` is later bookkeeping. Expiry first fences the plan generation and reconciles at most 90 subscriber/page/plan/target rows per invocation, persisting remaining debt in `telegram_alert_target_expiry_progress`. Only a complete expiry pass advances the exact stored baseline.
- The retired `telegram:dispatch-overflow-plan` cache is inspected before every dispatch, including circuit-open runs. A valid blob imports in 90-plan pages through a reserved synthetic source namespace owned exclusively by the importer; corrupt, oversized, replaced, or partially imported blobs remain explicit in `telegram_legacy_overflow_state`. Imported chunks use the same pending queue and target truth. The cache is deleted only after exact plan/item/target reconciliation.
- Risk pending alerts for depeg, DEWS, safety, and reserve expire after `1 hour` (3600s); lower-priority launch/admin
  rows expire after 30 minutes. Stale alerts are dead-lettered before cleanup.

Delivery semantics are explicit:

- `sent`
- `blocked`
- `retryable_failure`
- `permanent_failure`

Fresh retryable failures are enqueued into `telegram_pending_alerts` instead of being dropped.
`403` responses from the pending-queue dispatcher follow a two-strike rule: the first 403 stamps `consecutive_block_first_at` on `telegram_subscribers` and increments `consecutive_block_count` but leaves alert flags untouched; a second 403 within 24 hours of the first strike disables the subscriber's global flags and all per-coin alert booleans. When the second strike disables a chat, any other live pending rows for that chat are dead-lettered with `blocked_disabled` and deleted so a known-blocked bot is not retried until the 1-hour TTL. Any successful send resets both counters. A first strike older than 24 hours is treated as fresh.

### Pending Delivery Queue

All new risk chunks enter `telegram_pending_alerts` as pre-split HTML only after their source manifest is complete. Each dispatch run drains a bounded queue page inside its send deadline; existing retry/admin rows and newly handed-off targets share the same claim and transport policy while each row remains inside its bounded TTL.

The pending drain is claim-based. It selects only `delivery_state = 'pending'` rows whose target dedupe key is not already terminal, claims them, and re-resolves each new-format risk row against current subscriber, direct, global, preset, explicit-local-off, chat-snooze, and coin-snooze state. Direct on wins; a marker-backed local off blocks preset/global inheritance; otherwise an active preset or global follow can keep the pair eligible. Any disabled group pair cancels the row without a Bot API attempt, while active snooze, malformed/partial provenance, or unavailable required preset membership defers conservatively. All-null provenance remains a rolling-compatible legacy row. Immediately before each Bot API wave, the `pending -> sending` update compare-and-swaps the current subscriber `preference_generation`, records a delivery owner, increments its generation, and sets a bounded effect-claim expiry. A concurrent mutation leaves the row pending for another full validation and opens no fetch.

Only confirmed HTTP retry responses (`429` or `5xx`) owner/generation-CAS the exact send back to `pending`. Timeout, network, or unknown attempted results become explicit `execution_unknown`; an expired `sending` owner is reconciled to the same state and is never reclaimed. Confirmed successes transition to `sent`. The pending terminal transition and its authoritative `telegram_alert_job_targets.final_delivery_state` projection use reciprocal guards in one D1 batch; a bounded repair pass projects any terminal pending row left by an interruption before cleanup. A failed sent-row delete therefore leaves authoritative terminal evidence that later drains cannot resend. `/api/status.telegramBot.pendingDeliveryBacklog.executionUnknown` exposes both explicit unknown rows and aged legacy `sending` rows for operator reconciliation. This at-most-once choice avoids repeating a potentially accepted external effect.

Dedupe re-enqueue updates only `pending` rows whose processing claim is absent, expired, or belongs to an expired pending lifecycle. It cannot rewrite payloads, clear owners, or reset timestamps on `sending`, `sent`, or `execution_unknown`, so a collision never turns external-effect ambiguity into replayable work.

Every alert-intent mutation advances `telegram_subscribers.preference_generation` in the same D1 batch or UPSERT as its direct, preset, global, snooze, unsubscribe, block-disable, or chat-migration write. Revalidation binds the current generation only into the send CAS; it never rewrites the persisted enqueue generation after deciding that a stale row is still eligible.

For row-authoritative risk alerts, `telegram_alert_job_targets` is materialized before transport and remains `planned` until its exact pending insert commits. The pending lifecycle then projects one final state (`accepted`, `failed`, `cancelled`, `expired`, or `execution_unknown`) back to the target with source and dedupe guards. Job counters are rebuilt exclusively from those mutually exclusive target buckets while preserving valid job metadata. The older fresh-effect columns remain rolling-compatible audit evidence, but new source-event delivery does not bypass the pending effect fence. Telegram has no general message idempotency key, so the policy is reconciliable at-most-once, not exactly-once delivery.

Depeg, DEWS, safety, reserve, and legacy risk pending alerts have a 2-hour TTL (`PENDING_TTL_SEC = 7200`). Launch alerts use 90 minutes, and admin
broadcast rows use a 45-minute TTL because they are lower-priority during contention.
The TTL — not a per-row attempts cap — bounds how long the queue keeps retrying.
Each drain re-selects unexpired rows whose `not_before_at` has elapsed; rows that age
past their TTL are copied into `telegram_alert_dead_letters` and then deleted in a
capped cleanup batch at the end of the run, leaving any overflow for later dispatch
runs. `execution_unknown` rows are excluded from ordinary TTL and blocked-chat cleanup. They remain queryable for 90 days, then are projected to target truth, copied to the dead-letter audit with `reason = 'execution_unknown_archived'`, and deleted only by an owner/generation/timestamp CAS. Operator resolution racing that archive wins and preserves the live row.
Admin broadcasts preflight `messageHtml` before target selection or enqueue. The accepted
Telegram HTML subset is `a[href]`, `b`/`strong`, `i`/`em`, `u`/`ins`, `s`/`strike`/`del`,
`code`, `pre`, `tg-spoiler`, and `blockquote` with optional `expandable`; only simple
HTML entities (`amp`, `lt`, `gt`, `quot`, `apos`, and numeric entities) are accepted.
Malformed tags, unsupported attributes, unsupported entities, or unbalanced tags return
`422` and write an admin-audit error without enqueueing rows.
Operator clears through `POST /api/telegram-pending` should be previewed with
`?dry_run=1` first. Dry-runs write only the matched count to admin audit; live clears
use the same audit path with `reason = 'manual_clear'` before deleting filtered live rows.

Within the TTL window, retryable sends are re-queued with an exponential backoff
(`60s → 120s → 240s → 480s → 600s`, capped at 600s) indexed by prior attempts. Telegram's
`Retry-After` header overrides the schedule when present. Fresh retryable sends that
collide with an existing pending row reuse that row's prior attempt count before
computing a new backoff, so re-enqueue cannot weaken an already-escalated retry delay.
A defensive
`PENDING_MAX_ATTEMPTS = 20` ceiling guards against a pathological row looping forever.

Dropped rows are classified in the dispatch metadata so operators can tell apart natural
expiry from real failures:

- `pendingDroppedTtlExpired` — row aged past `PENDING_TTL_SEC` and was cleaned up.
- `pendingDroppedPermanentFailure` — Telegram returned a non-retryable, non-blocked error
  (e.g. `400 bad_request`, `401 auth_error`).
- `pendingDroppedMaxAttemptsFallback` — defensive `PENDING_MAX_ATTEMPTS` ceiling was hit
  while the row was still retryable; expected to be 0 in normal operation.

Terminal pending drops are dead-lettered before deletion with `reason` values `ttl_expired`, `permanent_failure`, `max_attempts`, `blocked_disabled`, `preference_changed`, `manual_clear`, or `execution_unknown_archived`. Each audit row uses the deterministic pending-id/delivery-generation key. Conflict replay is accepted only when the stored reason, provenance, payload, and lifecycle snapshot match, so insert-success/delete-failure and repeated cleanup/manual clear cannot duplicate or silently replace audit evidence. Ordinary admin count/clear actions select only `pending` rows; `sending` and `execution_unknown` require explicit reconciliation. Preference cancellation projects `cancelled` target truth and retains bounded cancellation detail; it is not misclassified as TTL expiry. Expired pending-row cleanup logs an error-level bypass event and still removes expired live rows when dead-letter insertion fails, so an audit-table outage cannot let the claimable delivery queue grow without bound. Execution-unknown archival instead fails closed on dead-letter/projection failure.

Retry and deferral metadata lives on the pending rows:

- `not_before_at` defers retryable failures, rate-limited sends, active snoozes, generation races, malformed provenance, and temporarily unavailable required preset membership until the next eligible run. Quiet hours are re-evaluated at drain time and silence notifications without delaying delivery.
- `last_error_class` and `retry_after_sec` preserve the last retryable Telegram result for observability and backoff.
- `dedupe_key` and `chunk_index` prevent duplicate queued chunks for the same chat/message while still preserving split-message order.

The `dedupe_key` is hashed from the **pre-split canonical message body**, the chunk index, and the `TELEGRAM_SPLIT_VERSION` constant (`worker/src/lib/telegram-alerts.ts`). Hashing the canonical body — not the post-split chunk HTML — keeps the key stable when `splitMessage` is refactored, so in-flight pending rows survive unrelated code changes. Bump `TELEGRAM_SPLIT_VERSION` whenever the splitting algorithm changes in a way that should deterministically invalidate older queued chunks.

When Telegram migrates a group to a supergroup, `migrateTelegramChatId` rewrites the chat-id prefix embedded in pending `dedupe_key` values and alert-job `pending_dedupe_key` values after moving `chat_id`. Pending rows whose rewritten key collides with an already-present new-chat row are deleted so the queue keeps one deliverable copy.

Rate-limit isolation is per-chat unless the response is explicitly classified as bot-wide or the same send pass sees rate limits across several distinct chats.
A chat-scoped 429 stamps `not_before_at` on the affected chat's pending row and
short-circuits later same-chat rows/chunks in the current run; other chats continue to
drain and to receive fresh alerts against the per-run budget. Ambiguous 429 responses,
including long `Retry-After` values, stay chat-scoped unless Telegram's response body
identifies the limit as global/bot-wide or at least three distinct chats return 429s in
the current batch, which escalates the untouched tail to global backoff.
At the start of each fresh-send pass, the dispatcher loads `DISTINCT chat_id` for rows
whose `not_before_at` is still in the future and routes their fresh chunks back to the
queue (`freshDeferredPerChat` in the dispatch metadata). The queue stores Telegram's
`retry_after` value when available; otherwise it uses a 60-second retry floor. Explicit
global backoff leaves row-level `not_before_at` clear and stores
`telegram:global-send-backoff-until` instead.

This design keeps snapshots current while overflow and retryable failures are prioritized
inside bounded TTLs. Terminal failures and execution-unknown effects remain visible for
operator review; delivery is not guaranteed.

Before formatting subscriber alert HTML, the dispatcher builds a cheap newest-first fan-out plan with estimated chunk counts (`TELEGRAM_ALERTS_PER_MESSAGE_CHUNK_ESTIMATE = 16`). Only the prefix that fits the per-run send cap plus `TELEGRAM_FORMAT_BUDGET_ALLOWANCE = 64` is formatted on the fresh-send path. The overflow tail is formatted lazily only when it needs to be enqueued, so a market-wide burst cannot spend CPU formatting chats that could never be sent fresh in that invocation.

### Load Simulation and Query Plans

`npm run check:telegram-load` runs the Phase 5 synthetic load harness without touching production D1 or Telegram. It builds deterministic fixtures for 500, 1,000, 5,000, and 10,000 active watchers and covers:

- direct per-coin subscriptions
- global alert opt-ins
- dynamic preset followers
- group chats
- quiet-hours chats
- chat-level snoozes and per-coin snoozes
- blocked chats that still consume attempted sends until the two-strike policy disables them

The simulated scenarios are:

- single depeg
- market-wide depeg burst
- DEWS plus safety-grade burst
- admin broadcast to deliverable watchers
- Telegram 429 storm with a 15-minute backoff window

The script reports target chats, message chunks, pending enqueues, planning delay, outage-unavailable time, post-recovery drain, TTL margin, per-invocation CPU, and rough D1 read/write statement counts using the current sender budget: authoritative pending delivery at 1,800 attempts per run, 5-minute cron cadence, 14-minute dispatch hard timeout with a 4-minute send-loop soft deadline, Telegram's ordinary 30 msg/sec broadcast guidance, a conservative p95 send-latency/D1-write pacing model, a format/send CPU model capped against `worker/wrangler.toml` `cpu_ms`, a 2-hour risk TTL, and a 45-minute admin TTL. Planning duration is derived from the same shared capture, planning, handoff-page, and max-step policy as the Worker. Runtime limits and reviewed simulation-only calibration inputs live in `shared/lib/telegram-delivery-policy.ts`; Worker compatibility exports and the load harness consume that source. The harness replays the full ordered Worker migration stream into local SQLite and runs `EXPLAIN QUERY PLAN` checks for fan-out, pending drain, pulse/status aggregates, and the current active-watcher history fallback. Direct/global fan-out and pending drain are index-gated; preset and fallback aggregate scans are marked `REVIEW`.

The package-level `npm run check:telegram-load` command is blocking: it passes `--enforce-target-slo` and fails when the 5,000-watcher target misses the normal under-15-minute risk-alert SLO. For an advisory local report that only fails critical query-plan regressions, run `npx tsx scripts/ci/check-telegram-load.ts` directly without `--enforce-target-slo`.

The reviewed dependency groups in `scripts/lib/telegram-load-guard.mjs` drive local merge-gate selection and are parity-checked against the GitHub workflow path filter. They cover dispatch/pending work, durable job and target schemas, sender transport, preset resolution, formatter/chunker behavior, scheduled-lane ownership, admin broadcast, delivery policy, Worker CPU configuration, migrations, and the guard itself. Full deploy fallback includes the advisory report unconditionally; the scheduled Monday workflow keeps the blocking SLO check.

### Rollout and Rollback

Migration `0190` is additive and runs before the Worker version that uses it. Rollback does not remove its rows. Existing pending rows remain readable, and the one-time legacy cache importer preserves pre-migration overflow rather than silently treating it as empty. Operators should stop rollout when target planning is `degraded`, expiry debt remains nonzero, the legacy importer is corrupt/oversized/degraded, or exclusive job counters disagree with target-row inspection. Do not reset a source generation, delete a partial manifest, or make a synthetic legacy source eligible for normal planning as an ad hoc recovery.

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
- Snapshot advancement actions are stored with the exact digest edition and committed only when all persisted Telegram chunks are accepted. Retryable delivery reuses those chunks; ambiguous delivery stops for operator reconciliation without consuming the appendix notices.

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

`GET /api/admin-telegram-adoption-report` exposes the last seven complete UTC days of aggregate funnel data, a previous-seven-day comparison range, first-mutation latency buckets, and the latest D7/D30 feature-retention snapshots. Counts from one through four and rates derived from them are suppressed. CTA clicks are best-effort and are not joined to Telegram users, so click-to-start rates are directional and may exceed 100%; the response carries that warning and per-source quality/freshness metadata. See the [adoption report runbook](./runbooks/telegram-adoption-report.md).

The public Telegram pulse derives `miniAppOpenToFirstMutationP50Sec` from the same daily latency buckets, using the selected bucket midpoint as an approximate P50. It remains `null` and privacy-suppressed below five known-latency sessions; unknown/missing session correlations do not enter the median.

`GET /api/status` now exposes a `telegramBot` block for the Access-gated `/admin/` dashboard. It aggregates:

- total known chats in `telegram_subscribers`
- alert-enabled chats vs deliverable chats (explicit coin follows, preset follows, and global all-stablecoin follows all count)
- explicit `telegram_subscriptions` rows, preset-implied coin follows, active preset followers, and average explicit follows per subscribed chat
- pending disambiguation replies still within TTL
- per-alert-type enablement counts (`dews`, `depeg`, `safety`, `launch`, `reserve`, all five)
- top subscribed stablecoins by subscriber count, split between explicit and preset-implied follows when available

The status page also reads `crons["dispatch-telegram-alerts"].lastRun.metadata` to show the latest delivery run stats (`subscribersNotified`, `messagesSent`, `blockedUsersCleanedUp`, `eventsDetected`, `snapshotSeeded`, `cappedAtLimit`).

Additional Telegram bot status metrics now include:

- `pendingDeliveries`
- `oldestPendingDeliveryAgeSec`
- `pendingDeliveryBacklog` (`claimable`/`due`, `deferred`, `sending`, `executionUnknown`, `sentCleanup`, `expired`, and `nearTtl`). Recent `sending` work stays separate; `executionUnknown` contains explicit fresh-target unknown outcomes plus pending/fresh sends older than 15 minutes. Source-split counts, oldest unknown age, and bounded-sample saturation metadata are included for reconciliation.
- `retryErrorClassCounts`
- `customPreferenceChats`
- `quietHoursEnabledChats`
- `lifecycleSnapshot` (daily active watchers, new/churned/reactivated watchers, explicit vs preset-implied follows, active preset followers, alert-type opt-ins, quiet-hours chats, and pending deliveries)
- `quality` (`complete` or `partial`, with unavailable optional telemetry fields and raw error strings for operators)
- `presetQueryFailures` (consecutive aborted dispatch runs since the last clean preset-subscriber load; only set when > 0)
- dispatch breakdown fields such as `freshRetryQueued`, `freshPermanentFailures`, `pendingRetryQueued`, `pendingDeferred`, `pendingRateLimited`, `pendingRetryAfterSec`, `pendingDropped`, `pendingDroppedTtlExpired`, `pendingDroppedPermanentFailure`, and `pendingDroppedMaxAttemptsFallback`

### Alerting on degraded delivery

`worker/src/cron/telegram-degradation-watchdog.ts` runs on the 5-minute Telegram lane immediately after `dispatch-telegram-alerts`. It reuses the same-slot pending-capacity snapshot and safety-source assessment when dispatch produced them, falls back to live reads when they are unavailable, reads fresh dispatch metadata, and emits a one-shot alert via the existing `sendAlert(...)` webhook rail when any degraded-delivery condition holds; each condition emits a single "recovered" alert and clears its cache flag when it clears. Capacity reads return an explicit `available` or `unknown` result. An unknown D1 read degrades watchdog telemetry and preserves the existing onset/alert keys unchanged; it never fabricates an empty queue or emits a recovery:

- Pending delivery risk: active pending rows exceed 500, oldest pending age is at least 15 minutes, estimated drain time is at least 30 minutes, any row is inside the 15-minute near-TTL window, or execution-unknown work is at least 15 minutes old. Count/age/drain/execution-unknown breaches use the sustained window (`telegram:degradation:pending-since`); near-TTL alerts immediately.
- `alert:safety-source-cache` reports `state != "ok"` for more than two `publish-report-card-cache` intervals (cache key `telegram:degradation:safety-source-since`).
- The most recent `dispatch-telegram-alerts` cron run reported `eventsDetected > 0`, `freshCandidateChats > 0`, and `messagesSent == 0` for three consecutive distinct runs (cache key `telegram:degradation:zero-send-streak`). The cached JSON stores both the streak and the last evaluated `cron_runs.id`, so repeated watchdog evaluation of one row cannot advance the streak; legacy integer values remain readable during rollout.

`GET /api/health.telegramSummary` uses the same lifecycle vocabulary and returns `pendingDeliveries: null` with `pendingDeliveryLifecycleStatus: "unknown"` if the capacity query fails. `/api/status.telegramBot.pendingDeliveries` counts only active claimable plus deferred rows rather than expired or in-flight cleanup states.

The watchdog is wired through `runBestEffortScheduledJob` so its own failures never block the dispatch lane, and its metadata captures `triggered`, `recovered`, and `alertSent` flags per condition for admin inspection via `cron_runs`.

### Per-alert-type delivery breakdown

The dispatch metadata also exposes a `perAlertType` map covering each of the five
alert categories: `dews`, `depeg`, `safety`, `launch`, `reserve`. Each entry reports the
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
`depeg > dews > safety > launch > reserve`, since depeg is the most time-sensitive
event. Pending-queue replays are not attributed because the persisted row
stores only the rendered HTML.

### Circuit Breaker

The dispatcher is protected by `CIRCUIT_SOURCE.TELEGRAM_API`.

- Open circuits skip fan-out.
- Open circuits still run the pending-queue drain and expired-row cleanup so already-enqueued retries do not age out while fresh fan-out is gated.
- Successful snapshot seeding or alert delivery records a successful outcome.
- Failed sends record an unsuccessful outcome.

## Message Types

Formatting helpers in `worker/src/lib/telegram-alerts.ts` emit:

- DEWS band transitions with top two stress sub-signals
- Depeg-triggered messages with direction, bps deviation, and price
- Depeg-worsening messages with previous vs current deviation
- Depeg-resolved messages with duration, peak deviation, and recovery price
- Safety-grade changes with old/new grade and score when present
- One contextual line when cached report-card, liquidity, or supply data is available for the affected coin. For mint/burn-tracked coins the same line also carries a `Flow24h <signed compact USD>` segment sourced from the cached per-coin 24h flow (`perCoinFlowCacheKey(id, 24)`); dispatch reads only the tracked subset of alerting coins in one bounded `Promise.all` (no recompute) and omits the segment when that flow is stale or net-zero. Rendered as an expandable Telegram blockquote (`<blockquote expandable>…</blockquote>`) so it collapses by default on mobile; requires Telegram Bot API 7.0+ (Mar 2024) — older clients render it as a regular blockquote.

Alert context uses the published report-card snapshot cache. This keeps the five-minute dispatch lane from rebuilding the full report-card corpus just to attach a short annotation.

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

The reserve-drift family (C123) ships **glyph-less**: a `Reserve Drift` section with a bold-symbol line and no data-tied glyph. Per the rule above, adding a reserve glyph requires a separate review.

Subscriber alert messages end with a `View on Pharos` link. Telegram digest posts end with `Read on Pharos →`, even when cemetery or tracking appendices are present.

For single-coin alerts the first chunk is sent with `link_preview_options: { is_disabled: false, prefer_small_media: true, show_above_text: false }` so the "View on Pharos" link renders a compact preview card below the message body. Multi-coin alerts, overflow chunks, and pending-queue replays continue to use the batch-wide `disable_web_page_preview: true` default. Behavior requires Telegram Bot API 7.0+ (Mar 2024); older Bot API versions ignore the field and fall back to default link-preview rendering.

## Digest vs Subscriber Alerts

The same bot token can be used for both:

- Channel-style digest posting via `postDigestToTelegram(...)`
- Direct chat replies and subscriber alerts via `sendToChat(...)`

Digest posting uses `TELEGRAM_CHAT_ID`; subscriber alerts use the chat IDs stored in `telegram_subscribers`.

## Operational Notes

- The dedicated 5-minute Telegram trigger reconciles webhook registration, native slash-command suggestions, profile metadata, and the default Mini App menu button through `worker/src/lib/telegram-webhook-registration.ts`. After deploying a command-list change, the production bot menu users see when typing `/` should update on the next Telegram slot.
- The command reconciliation issues two scoped `setMyCommands` calls: the full list under `scope: { type: "all_private_chats" }` and a group-safe list under `scope: { type: "all_group_chats" }`. The group menu includes read-only commands and group-valid subscription/settings controls, but intentionally omits `/start` and `/forget` because setup deep links and destructive data deletion stay private-chat only. Both scopes share a single cache key (`telegram:commands-reconciled`); a fresh cache hit skips both round trips, and bumping `TELEGRAM_COMMANDS_CACHE_VERSION` forces every deployment to reconcile once.
- The same trigger reconciles the bot profile metadata (display name, short description, long description) under cache key `telegram:profile-reconciled` on the same 15-minute cadence. The configured strings are exported constants in `shared/lib/telegram-bot-registration.ts` so changes flow through code review and are reused by manual recovery tooling. Telegram returns a 400 "is not modified" response when the submitted value already matches the live one; the reconcile treats that as success and still refreshes the cache marker so the next 15 minutes are a true no-op. Current Bot API versions expose `setMyProfilePhoto`, but Pharos does not yet reconcile it; until that path is reviewed, set the avatar manually through @BotFather using `public/pharos-icon.png`.
- The cron connection-budget check includes the command/profile/menu/webhook reconciliation as a budget-only entry on the same chained five-minute Telegram group. It is not a separate status-tracked `cron_runs` job, but its serial Bot API calls are still visible to `npm run check:cron-connections`.
- `npx tsx scripts/maintenance/register-telegram.ts --action webhook`, `npx tsx scripts/maintenance/register-telegram.ts --action commands`, and `npx tsx scripts/maintenance/register-telegram.ts --action profile` remain manual recovery tools when an operator needs to force Bot API state outside the Worker reconciliation loop. Command, profile, and allowed-update payloads are shared with Worker reconciliation through `shared/lib/telegram-bot-registration.ts`.
- The webhook intentionally returns `200` on most malformed or unauthorized cases so Telegram does not keep retrying noisy payloads.
- The dedicated 5-minute Telegram trigger runs registration/menu reconciliation first, then subscriber alert fan-out through `dispatch-telegram-alerts`.
- The dispatcher consumes Bot API response bodies before returning, which matters under the Workers per-trigger connection cap.

## Runbooks

Operator-facing playbooks for Telegram incidents:

- [`runbooks/telegram-no-delivery.md`](./runbooks/telegram-no-delivery.md) — users report missing alerts; diagnostic checklist and remediation for snapshot, snooze, blocked-subscriber, and webhook-secret causes.
- [`runbooks/telegram-backlog-expiration.md`](./runbooks/telegram-backlog-expiration.md) — pending queue age approaches the 1-hour TTL; pause broadcasts, clear expired rows, and estimate drain time.
- [`runbooks/telegram-rate-limit-storm.md`](./runbooks/telegram-rate-limit-storm.md) — pending queue growing, 429 dominates retry classes; per-chat backoff vs. global throttling, manual pending-queue clearance.
- [`runbooks/telegram-webhook-retry-dedupe.md`](./runbooks/telegram-webhook-retry-dedupe.md) — webhook retries, processed-update dedupe, and skipped command recovery.
- [`runbooks/telegram-admin-broadcast-safety.md`](./runbooks/telegram-admin-broadcast-safety.md) — dry-run and backlog checks before sending an operator broadcast.
- [`runbooks/telegram-operator-queries.md`](./runbooks/telegram-operator-queries.md) — D1 snippets for delivery, webhook, dead-letter, and usage-funnel incidents.
- [`runbooks/d1-telemetry-kill-switch.md`](./runbooks/d1-telemetry-kill-switch.md) — disabling low-value telemetry writes when D1 pressure threatens product paths.
