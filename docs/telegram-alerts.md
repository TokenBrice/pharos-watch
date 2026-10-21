# PharosWatchBot and Telegram Alerts

> **Agent navigation** — Start with the [Telegram architecture seam map](./telegram-architecture.md). In this document: [commands](#commands) · [dispatch detection](#dispatch) · [dispatch routing and formatting](#dispatch-routing-and-formatting) · [delivery persistence](#delivery-persistence) · [digest appendices](#digest-appendices) · [admin visibility](#admin-visibility) · [message types](#message-types) · [operational notes](#operational-notes) · [runbooks](#runbooks). Grep `^##`, `SNAPSHOT_KEYS`, `preference_generation`, or `execution_unknown` to find contracts without loading the whole file. Client/auth/state live in the [Mini App contract](./telegram-mini-app.md#overview).

## Overview

Pharos runs PharosWatchBot for opt-in stablecoin alerts and Telegram channel posts.

The main ingress, dispatch, and digest entrypoints are:

- `POST /api/telegram-webhook` accepts Telegram commands, validates the shared secret from `X-Telegram-Bot-Api-Secret-Token`, and stores subscriber state in D1.
- `worker/src/cron/telegram/dispatch/dispatch-telegram-alerts.ts` diffs the latest DEWS, active depeg, safety-grade, and reserve snapshots against cached prior snapshots, and independently drains fresh immutable freeze Tape events through their dedicated cohort outbox before handing every rendered target to the shared pending transport. Freeze Tape rows with no possible active freeze audience still advance the freeze cursor but do not create durable source/target lineage, so large no-recipient blacklist batches cannot monopolize the five-minute dispatch slot.
- `worker/src/cron/daily-digest.ts` posts immutable digest editions; [digest Telegram delivery](./digest-pipeline.md#telegram) owns appendices/outbox behavior.
- [Architecture seams](./telegram-architecture.md#seam-overview) owns entrypoint/file responsibilities; this guide owns runtime behavior.

The sign-up funnel (landing click beacon, `/api/telegram-adoption`, campaign/placement stage counters and retention cohorts) is retired; its tables receive no writes and drop in the coordinated schema cleanup.

## Personalized Daily Recap

Personalized watchlist recaps are retired immediately, without a retirement-notice stage. The planner, command/callback handlers, Mini App controls and wire projections, rollout binding, queue branches, load scenarios, and digest CTA are removed. Legacy `/recap` commands use the ordinary unknown-command response; old recap buttons receive an unrecognized-action toast; signed `set-recap` requests fail schema validation before database access.

Risk alerts, private Mini App watchlists, timezone/quiet hours, snoozes, Tape, and public editorial daily/weekly digests are unchanged. The five-minute Telegram lane and shared transport/effect fences remain.

Before deployment, use the prior stop-capable Worker in `off` mode and prove zero planned/queued recap targets and zero pending/sending recap transports; [stop and drain](./runbooks/telegram-no-delivery.md#recap-retirement-stop-and-drain) owns the operator procedure. No production stop/drain evidence is implied by this code change.

Recap tables and append-only migration history remain for audit and privacy erasure. Existing sent/skipped target retention is 30 days; cancelled/expired/unknown/permanent-failure audit retains 90 days. Destructive schema/retention removal is separate, no sooner than 90 days after final recap evidence and after the compatible rollback floor closes. `/forget` continues to erase retained chat-owned recap data.

Public route/pulse/privacy are owned by [Mini App frontend](./telegram-mini-app.md#frontend-main-page). The site-proxy pulse is website-internal; direct public API reads still require an API key. [Snapshot inputs](#snapshot-inputs) owns safety source suppression; no Telegram live-score cache or full-publication fallback is allowed.

## Inline Keyboards (Callback Queries)

Subscriber alert keyboards have at most two rows. First chunks offer `[Mute {SYM} 24h] [Pause all 4h]` then `[Fewer like this] [Manage Alerts]`; overflow chunks offer only `Pause all 4h`. Mute targets the top-ranked coin (`rankAlertCoins` deduplicates by coin and ranks maximum depeg/DEWS/safety severity; displayed symbols may truncate but callback data uses canonical IDs). Manage Alerts opens the Mini App in private chats and the group settings keyboard in groups. "Fewer like this" (`fewer:<coinId>:<code>:<value>`, `callbacks/fewer.ts`) targets the family with the most events in the message and carries the per-coin value to write, one notch quieter than the tuning of the row that routed the alert (`nextFewerSettingValue`), so a repeated or retried tap sets the same value rather than stepping again. The written value is clamped to the coin's current effective setting: a stale tap never lowers a threshold the user has since raised and never re-enables a family or worsening alerts that are now off. Buttons sent before the value was carried resolve it at tap time from the strictest value currently routing that coin (direct row if it owns the family, otherwise every followed preset and the global follow). Steps: depeg step 100 → 250 → 500 → off, and with no step in effect straight to off so worsening alerts are never switched on; DEWS floor ALERT → WARNING → DANGER → off; safety/freeze/reserve off for that coin; the toast names the change and points to Manage Alerts to undo. Coin mute, Fewer and group settings remain admin-gated in groups. Old `status:`, `depegstep:` and `safetydown:` buttons in existing chats keep working but are no longer emitted.

Callback data is `action:arg`, at most 64 bytes. `CALLBACK_ACTIONS` in `worker/src/telegram/callbacks/_shared.ts` and its callback registry own prefix/argument syntax; keyboard builders and allowlist change together. Unknown actions receive a visible toast, not an error.

Command-driven buttons are stateless: no `telegram_pending_disambiguation` rows are read or written. `pick:st|un|su` carries a ticker and candidate index and is re-resolved on tap (`callbacks/pick.ts`). `bulk:sa|ua` (subscribe/unsubscribe all) carries a base-36 expiry, valid for 15 minutes, and `bulk:no` dismisses; `forget:yes:<expiry>` and `forget:no` do the same for `/forget` (`callbacks/confirm.ts`). `callbacks/legacy.ts` answers old `manage`, `unsub`, `tz`, `select`, `confirm` and `cancel` buttons with a short redirect, and old `why:`/`coverage:` buttons render the status card. Setup buttons are in [setup wizard](#setup-wizard).

Group settings edit the inline keyboard in place, with fresh-message fallback on refusal. Quick-subscribe enables DEWS+depeg, adding a Mini App tuning confirmation in private chats and an admin-gated toast in groups.

Ingress flood admission precedes action-specific D1 work; callbacks share the per-chat flood counter with commands. Registered update types derive from `shared/lib/telegram-bot-registration.ts`.

## Status Freshness

Bare `/status` is a chat card and `/status <ticker>` is a coin card; each value shows its own age and nothing carries a freshness verdict. Coin-card ages follow the `updated N ago` pattern, unavailable values say so, and model and generation identifiers are never shown.

Supply and DEX liquidity are labelled by age on the coin card (`Supply: <value> (updated N ago)`); `Supply: unavailable` appears when the stablecoins publication, the asset or its current peg buckets are unavailable. An explicit observed zero supply remains `$0`. The alert context still applies its own supply/DEX budgets.

Flow freshness is a distinct **context tolerance**, not a claim about `/api/mint-burn-flows` endpoint freshness. `shared/lib/api-freshness.ts` owns `TELEGRAM_FLOW_CONTEXT_MAX_AGE_SEC` (six hours), used by the `/status` loader and alert context. At exactly six hours flow remains eligible as context; beyond it alerts omit the optional flow segment. Endpoint freshness remains governed separately by `API_FRESHNESS_MAX_AGE_SEC`; PSI/DEWS incident canaries use the independent four-hour `CANARY_INCIDENT_MAX_AGE_SEC` policy. None of these context disclosures changes primary alert eligibility.

## Commands

The [command implementation appendix](#command-implementation-appendix) retains [setup wizard](#setup-wizard) state/attribution and [deep-link payloads](#start-deep-link-payloads); the shared manifest owns command syntax.

### Webhook Command Flow

`worker/src/telegram/webhook/telegram-webhook.ts` coordinates ingress; `worker/src/telegram/webhook/` owns parsing and ingress gates, `worker/src/telegram/commands/` owns command handlers, `worker/src/telegram/callbacks/` owns callback dispatch, and `worker/src/telegram/store/` owns D1 persistence.

The webhook validates `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET` or, during rotation, `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`. Invalid secrets and malformed JSON return `200 ok` without side effects. A missing bot token is acknowledged with a rate-limited configuration warning. If all D1-backed command flood checks are unavailable, ingress fails closed with the standard busy reply. Non-command text has no side effects.

Group/supergroup commands must address the bot, e.g. `/subscribe@PharosWatchBot dews usd-top25`; unaddressed commands and those addressed to the public channel handle are ignored.

Command tokens end at the first whitespace separator, including spaces, tabs and newlines. Arguments are trimmed without joining split command or bot-mention fragments; group bot-name matching remains exact.

Channel-originated mutations are rejected: channel admin ownership is outside shared-chat authorization. Bot removal still clears the channel's subscriber state and lifecycle caches.

`classifyTelegramCommand` in `telegram-webhook-ingress-policy.ts` is the shared command-policy authority for group authorization and local mutation. Retired commands are routed by `commands/legacy.ts` (see [supported commands](#supported-commands)).

### Group Admin Gating

Group admins alone may use `/subscribe`, `/unsubscribe`, `/pause` (and its `/unsnooze` alias) and the mutating buttons (`pick:su|un`, `bulk:sa|ua`, `setup:top25|undo`, settings toggles, snooze and per-coin buttons). Retired commands such as `/set`, `/mute` and `/timezone` only reply with a redirect, so they need no gate. `/forget` is private-only. The gate is a code toggle in `worker/src/telegram/webhook/telegram-webhook-ingress-policy.ts`, not an env binding.

- **Hard (default):** refuse non-admins with command-specific copy ("Only group admins can /subscribe. Ask @Alice or Bob.") without dispatch. `getChatAdministrators` supplies up to three already-public display names plus an overflow phrase.
- **Soft (emergency rollback):** set the code toggle to `"soft"` and redeploy; non-admins receive the same warning but the command runs.

Every mutating group command/callback freshly calls `getChatMember`, including `pick:` and `bulk:` taps; there is no initiator ownership, so any current admin may complete a prompt. Role changes apply on the next delivery. A lookup that fails (network, 429 or 5xx) is not treated as "not an admin": the action is refused with "Couldn't verify admin status. Please try again." A message an anonymous admin posts as the group itself (`sender_chat` is the group) counts as an admin action; a linked channel's `sender_chat` does not. The five-minute `telegram:chat-member:<chat_id>:<user_id>` cache is diagnostic only; `telegram:chat-admins:<chat_id>` caches denial-copy names. Private chats remain ungated.

The shared command classifier distinguishes group-admin gating from mutation planning: `/start` deep links retain handler authorization.

The ingress flood cap is one 20 actions / 60 seconds counter per chat, shared
by commands, callbacks and pending replies. Commands have no separate
cooldowns; the Mini App keeps its own cooldown rows.

Group welcome idempotency is stamped only when the audited welcome reply reports
success; the webhook does not perform a second diagnostics read to infer whether
the send succeeded.

### Supported Commands

`TELEGRAM_COMMAND_REFERENCE` in `shared/lib/telegram-bot-registration.ts` is the syntax, audience, example, alias, and help-text authority. `COMMAND_HANDLERS` in `worker/src/telegram/commands/index.ts` is the dispatch authority. Do not mirror their roster here. Product/side-effect contracts that are not just syntax:

- **Menus.** Private menu: `/start /status /list /subscribe /settings /pause /help`. Group menu: `/status /list /subscribe /settings /help`, addressed as `/cmd@PharosWatchBot`. `/unsubscribe` and `/forget` are typed only; `/sample` is reachable as the `?start=sample` alias.
- `/start` opens onboarding (see [setup wizard](#setup-wizard)); unknown or malformed payloads fall back safely. `/help` is short, with private and group variants.
- `/sample` is private-only and sends the public depeg sample from `shared/lib/telegram-alert-samples.ts` with the onboarding buttons: no live read or preference mutation.
- `/list` separates direct coins and presets and links to the Mini App for edits in private chats.
- Bare `/status` is a chat card: alerts on or paused, quiet hours, what the chat follows, open depegs among followed coins, and the last alert delivered with its real age. If any read fails, the depeg line is omitted rather than shown as "none". `/status <ticker>` is the coin card (`buildStatusMessage` in `webhook/telegram-webhook-messages.ts`): each value shows "updated N ago", unavailable values say so, and no model or generation ids appear. Yield APY, venue, PYS and source evidence come from one matching accepted `/api/yield-rankings` row; a missing row is unavailable, never replaced with raw `yield_data`.
- `/subscribe` and `/unsubscribe` apply unambiguous coins and presets immediately. Only the chat-wide `all` scope asks for confirmation (`bulk:sa|ua`, 15 minutes). `/subscribe <targets>` without alert types defaults to DEWS + depeg; bare `/subscribe` replies with the one-tap onboarding buttons. Ambiguous symbols show `pick:` buttons that are re-resolved on tap.
- `/settings`: private chats get a summary and a Manage Alerts button that opens the Mini App; groups keep the inline settings keyboard.
- `/pause` uses `alert_snooze_until_ts = 4102444800` for indefinite chat pause; timed durations use ordinary snooze. `/pause off` clears it. Displays say Paused, not a huge countdown. This is distinct from operator [delivery pauses](./runbooks/telegram-no-delivery.md#pause).
- `/forget` is two-step and private-only: remove subscriber/direct/preset settings, diagnostics, pending work, chat-owned planning/targets/item lineage, freeze/recap state, and dead letters. Processed-update idempotency and aggregate manifests retain normal audit policy; [schema/retention](./telegram-architecture.md#d1-schema) owns the cascade.
- **Aliases.** `/unsnooze` runs `/pause off`; `/health` and `/subscriptions` run `/list`; `/why` and `/coverage` run `/status`.
- **Retired commands.** `/set /mute /unmutehours /timezone /presets /top /brief /market /recap /cancel /export /import /add` answer with a one-line redirect, plus a Manage Alerts button in private chats (`commands/legacy.ts`).
- **Unknown commands.** `replyToUnknownCommand` suggests the nearest command by edit distance. If the token is a ticker (`/usdc`), it returns that coin's status card.
- Quiet hours silence notifications, not delivery, in the configured IANA timezone (unset UTC), and are edited in the Mini App.

### Alert Types

- `dews`
- `depeg`
- `safety`
- `launch` (retired) — no longer detected, sent, parsed by `/subscribe` (which replies with the retirement note), or toggled in the Mini App. `alert_launch*` columns keep their data until the coordinated table cleanup; `TELEGRAM_LIVE_ALERT_TYPES` excludes the family while `TELEGRAM_ALERT_TYPES` keeps it for column order and encoded callback masks. The one-time notice text is `TELEGRAM_LAUNCH_RETIREMENT_NOTICE_HTML` in `shared/lib/telegram-alert-families.ts`, sent once through `POST /api/admin-telegram-broadcast` with `scope: "retired-launch-opt-ins"` (chats with any global or per-coin launch opt-in) following [the broadcast safety runbook](runbooks/telegram-admin-broadcast-safety.md): dry run first, then a live call with the private canary.
- `reserve` — opt-in per-coin reserve-drift alert (C123). Fires once when a live-reserve-tracked coin's live reserve mix newly diverges from its curated profile beyond the shared `delta > 15` threshold (`isReserveDriftThresholdExceeded`), reusing the four-hourly `checkCollateralDrift` set. Transition-gated (entering-drift only) and advisory; it does not feed the Safety Score or report card.
- `freeze` — opt-in direct or all-stablecoin issuer freeze, unfreeze, and destroy events from the immutable Tape projection. This family has no preset inheritance or tunable threshold.

### Freeze Alert Source And Cadence

Only destroy events, and freeze/unfreeze events whose at-event amount is known and at least `TELEGRAM_ALERT_POLICY.freeze.realtimeMinAmountUsd` ($1M), are sent in real time (`isRealtimeFreezeAlert`). An unknown amount is never treated as large. **Freezes and unfreezes under $1M, or with an unknown amount, are currently not sent to anyone**: they advance the cursor without outbox rows and are only counted as `freezeSkippedBelowRealtimeThreshold` in the dispatch progress `countTotals`. They will be delivered once the hourly batch / daily roll-up lane ships; until then FreezeWatch on the site is the only place they appear. Freeze messages carry the same "Via" footer as other families (direct follow → your watchlist, otherwise all stablecoins).

Freeze alerts retain two immutable identities: the projected `tape_events.event_id` and its source `blacklist_events.id`. New Tape projections include the canonical stablecoin id from the verified blacklist contract configuration; historical symbol-only rows are accepted only when the symbol maps to one tracked coin. Malformed, unknown, or ambiguous rows fail closed: the cursor remains immediately below the first such row so a later registry update can make it deliverable. After three consecutive observations of the same poison row, Telegram emits a structured error and skips that row before continuing, preventing one bad projection from wedging the feed.

Cadences: blacklist 6h, Tape 30m, Telegram 5m. A successful `project-tape` run older than 60m pauses the cursor; a missing cursor seeds the newest freeze row without replay. `FREEZE_RECOVERY_WINDOW_SEC` admits source ages ≤24h (four scan slots); older Tape rows advance the cursor without alert/outbox creation, even historical backfills. Eligible events have immutable 2h expiry and a one-time, transactionally closed direct/global cohort; later subscribers cannot join. Normal controls apply: quiet hours, chat/coin snoozes, explicit local off, preference revalidation, pending dedupe, blocked-chat cleanup, and terminal target projection.

Freeze pending identity binds the immutable `freeze:<tape_events.event_id>` source, chat, split version, and chunk index rather than the rendered HTML. Two freezes with identical display text therefore retain independent pending rows and terminal outcomes. Both target ledgers remain planned until a pending row matches the exact source, rendered chunk, preference generation, scope, markup, notification policy, and expiry; an unrelated or mismatched row cannot prove a queued handoff and is not rewritten, even while still pending. Other alert families retain their intentional canonical-content dedupe.

The freeze outbox is intentionally separate from `telegram_alert_target_plans`, whose deployed CHECK constraint admits only the original five families. For events with at least one possible current freeze recipient, it creates canonical source/job/job-target/item lineage and hands every rendered chunk to `telegram_pending_alerts`; the freeze-specific tables preserve the independent Tape/blacklist provenance and resumable cohort without a destructive table rebuild. New no-audience events are cursor-advanced without durable rows because subscribers added after observation must not receive historical freeze alerts whose cohort was empty. Freeze jobs share the single counter authority: every queue write reuses the authoritative target-row reconciliation, so `planned_count` counts only targets still unresolved in the `planned` bucket (never a copy of `target_count`), the remaining counter columns follow the same bucket precedence as outcome reconciliation, and the job `status` is derived from those counters rather than from this run's queue count.

### Preset Watchlists

Preset watchlists are persistent dynamic sources, never copied into direct coin rows. Canonical aliases/filters live in `shared/lib/telegram-presets.ts`; `/presets` renders that source. Dashed top-N aliases canonicalize before storage. Resolution in `worker/src/telegram/common/presets.ts` uses the strict stablecoins cache plus tracked metadata; only active assets expand into presets, and non-USD means peg currency is not USD. Command/setup resolution is preview; dispatch-time resolution is authoritative. Missing cache fails closed with retry copy, never stale/incomplete subscription.

`/subscribe ... <preset>` writes only `telegram_preset_subscriptions`; `/unsubscribe <preset>` deletes only that follow and does not require successful membership preview. Mixed direct/preset mutations remain separate in one atomic intent. `/list` does not expand dynamic members. Existing rows of uncertain legacy provenance remain direct/local and are never deleted/reclassified by backfill. Presets support DEWS/depeg/safety only, with default DEWS ALERT floor and live safety downgrade-only (like global); no preset DEWS/safety tuning exists. Reserve/freeze require explicit coins or `all`.

Effective precedence is **per-coin > preset > all-stablecoins** per family. Direct enabled flags own local tuning. A local off suppresses inheritance only with both `alert_<family>=0` and `alert_<family>_override=1`; unmarked zeroes from partial/legacy/snooze-only rows inherit. Multiple presets retain independent rows and choose the most inclusive positive depeg step deterministically unless direct tuning wins. `/list` names individual marked-off families; only six marked-off families display “Muted (overrides defaults)”. Display labels never alter eligibility.

Settings loads all six override markers: unmarked zero/missing rows show inheritance, not Off, without resolving preset membership. Controls describe local overrides, not effective coverage; reserve/freeze inherit chat policy only.

Tuning semantics:

- DEWS per-coin floor defaults to ALERT, optionally WARNING/DANGER; safety direction is all/downgrade-only/upgrade-only.
- Depeg steps 100/250/500 bps couple initial severity floor, resolution peak gate and worsening cadence; they are not independent controls. Preset/global steps use the same model.
- Settings-style `depeg on` preserves a stored step; `depeg off` clears it; `depeg-step <bps>` enables depeg. The group settings keyboard (or Manage Alerts) turning depeg off disables it, while `/subscribe <targets> depeg-step off` still follows depeg without a step. OFF never displays a step suffix.
- Global safety is downgrade-only and, when scores exist, material-only (`oldScore-newScore >= 3`); scoreless downgrades still pass. Explicit coin safety retains its own mode.
- Live safety alerts follow `TELEGRAM_ALERT_POLICY.safety` (see [Alert Detection Rules](#alert-detection-rules)); a direct coin's safety mode can only narrow them further, because only severe downgrades are sent live.
- Reserve/freeze are on/off only. Reserve fires only for live-tracked comparable drift, entering-drift only; missing live fetches produce no “cleared” message. Four-hourly producer cadence can delay a new drift up to roughly four hours.
- Quiet hours force `disable_notification=true` using subscriber timezone (unset UTC). Start/end must differ; `0-0` is not all-day mute. Unknown runtime ICU zones fall back to UTC with a rate-limited `quietHoursTzFallback` warning. Chat and coin snoozes suppress delivery instead.

### Ticker Resolution

Ticker parsing lives in `worker/src/telegram/common/alerts-parser.ts`, built from `TRACKED_STABLECOINS`. Callers import parsing and formatting helpers directly from their owning modules.

- Resolution is symbol-first and case-insensitive.
- Preset aliases are matched before ticker resolution in the shared target parser.
- Unique matches apply immediately.
- Exact Pharos coin IDs resolve immediately and override symbol ambiguity.
- Both active and pre-launch tracked assets are eligible for explicit ticker or ID resolution; presets expand active coins only.
- Ambiguous symbols reply with `pick:` buttons (ticker plus candidate index). Nothing is stored; the ticker is re-resolved when a button is tapped.
- Unknown tickers return a contextual error, with a prefix-based suggestion when available. Unknown command tokens that are tickers (`/usdc`) open that coin's status card.

### Update Deduplication

Telegram may redeliver the same `update_id`. The webhook claims each id in `telegram_processed_updates`: a processed duplicate returns `200 ok` and is skipped, a fresh in-flight duplicate returns `503 retry`, and a thrown error releases the claim and returns non-2xx so Telegram's redelivery runs. A `processing` claim older than 60 seconds belongs to a crashed request and is reclaimed. Replies are not fenced: a crash between a reply and the processed marker can repeat that reply once on redelivery, which is accepted at the bot's traffic level. Mutations write explicit target values, so a redelivered update reapplies the same state. [Ingress incidents](./runbooks/telegram-webhook-retry-dedupe.md#current-dedupe-model) owns diagnosis.

Processed-update rows are retained for 7 days. The daily `telegram-retention-cleanup` job owns capped processed-update pruning alongside the other Telegram audit and analytics retention passes; webhook requests only claim and mark update rows.

Command, callback, setup, and settings replies use the shared audited reply helper. Successful command replies update only `last_successful_reply_at`; alert delivery senders update `last_successful_delivery_at`. This keeps `/health` able to distinguish "commands work" from "alerts have not delivered recently." Reply failures record `reply_failure` usage events and update the recent failure class for the affected chat.

## Dispatch

This section owns snapshot admission and event detection. [Dispatch Routing And Formatting](#dispatch-routing-and-formatting) owns recipient selection and message planning; [Delivery Persistence](#delivery-persistence) owns the durable transport lifecycle.

### Dispatch Cron

`dispatchTelegramAlerts(db, botToken, signal?)` runs on a dedicated 5-minute cron slot
(`2,7,12,17,22,27,32,37,42,47,52,57 * * * *`), isolated from the quarter-hourly pipeline.

It no longer runs inside the quarter-hourly or daily slots. Safety-grade changes are detected
within 5 minutes of `compute-safety-score-v9` accepting a canonical publication.
The five-minute lane is separate from quarter-hourly/daily work. [Operational notes](#operational-notes) owns serial ordering. DB-only sidecars do not require Telegram credentials.

### Snapshot Inputs

Each dispatch run loads:

- Latest published DEWS rows from the generation-aware current-row loader (`stress_signals_latest` or exact `stress_signal_publication_rows`, with `stress_signals` as the legacy fallback)
- Active depegs from `depeg_events WHERE ended_at IS NULL`
- The persisted thin V9 alert-source envelope and publication-health record, assessed by `loadActiveAlertSafetySourceAssessment` without reading `safety_grade_history` or decoding the full public publication
- Prior dispatch snapshots from cache keys:
  - `alert:dews-snapshot`
  - `alert:dews-alertable-snapshot`
  - `alert:dews-candidate-snapshot` — per-coin DEWS escalation persistence (distinct computations seen, the band it rose from) and calm-since clocks; a missing or corrupt value is an empty map
  - `alert:depeg-snapshot`
  - `alert:safety-snapshot`
  - `alert:reserve-snapshot` — four-hourly producer v2 envelope: source clock/continuity, drift IDs, per-asset `observedSince` epochs and explicit `unavailableIds`
  - `alert:reserve-dispatched-snapshot` / `alert:reserve-observed-snapshot` — dispatch-owned drift IDs and continuity epochs, committed together by `writeSnapshots`

When `alert:dews-alertable-snapshot` is absent (for example, immediately after deploy), the dispatcher rebuilds it from the raw DEWS snapshot so the rollout does not require a noisy cold start.

DEWS and depeg dispatch snapshots older than `24 hours` are treated as stale and are reseeded before any DEWS/depeg alerts are sent. The retired `alert:launch-snapshot` key is no longer read or written.

Reserve dispatch reads the four-hourly producer without reserve-adapter connections. Expected-generation envelopes are fresh through two producer intervals (8 hours); missing/corrupt/future/stale/wrong-generation sources suppress transitions and preserve baselines. Whole-producer recovery cold-seeds without alerts. Per-asset unavailable intervals reset only that member's observation epoch, so recovery is cold-seeded even when dispatch missed the gap; continuously observed peers remain alertable. The cohort excludes single-bucket/non-independent feeds and requires curated comparators plus admitted multi-slice live mixes. A complete observed no-drift set is a genuine empty result.

The live safety source is the persisted thin V9 alert envelope. Fan-out requires a current, identity-valid envelope matching publication health; held or stale data is unavailable. The prior snapshot persists full publication identity, but organic base-input and publication-generation advances remain comparable. Model, schema, methodology, policy, or evaluator-build changes force a baseline seed rather than grade-change fan-out.

Partial safety publications use internal attempt metadata to suppress quarantine/recovery transitions only for affected assets; unrelated organic grade alerts continue. Reason context uses projected V9 evidence/caps/pillars, never a Telegram-specific live-score cache.

### First-Run / Stale-Snapshot Behavior

If the raw DEWS/depeg snapshots are missing, unparsable, or older than 24 hours, or if an existing `alert:dews-alertable-snapshot` is stale:

1. Current DEWS/depeg state is written back to the snapshot cache keys.
2. No subscriber messages are sent for that run.
3. The cron returns metadata with `snapshotSeeded: true`.

A seed run keeps a fresh depeg baseline unchanged (only a missing or stale depeg snapshot is reseeded), so a depeg that opened during the seed run alerts on the next normal run. When the safety baseline itself does not need a reseed, a coin whose safety alert is due in a seed run keeps its previous row and pending clock, so the alert fires on the next normal run instead of being absorbed.

This prevents a cold start from blasting subscribers with every current condition as if it were a new event.

Safety-grade fan-out has its own source-cache freshness gate and seeds `alert:safety-snapshot` separately when the prior safety snapshot is absent, unparsable, stale, or bound to a different Safety Score methodology identity.

### Eventless Fast Path

When the dispatch snapshots are healthy, the live safety and reserve sources are valid, and no DEWS, depeg, safety, or reserve changes are detected, the dispatcher takes an eventless fast path. The fast path refreshes the snapshot cache and returns complete cron metadata, but skips subscriber fan-out, alert-job manifests, per-chat backoff reads, and fresh delivery assembly.

The no-work branch is not used when snapshots need seeding, the safety source is missing/corrupt/stale/wrong-generation, any alert family has an actionable change, or due/expired pending rows need queue work. A non-alertable reserve source can still use this path because its baseline is explicitly preserved or cold-seeded; the returned metadata exposes `reserveAlertSourceState`, `reserveAlertSourceAgeSeconds`, `reserveAlertSourceGeneration`, and `reserveAlertsSuppressed`. Due pending rows still drain on an otherwise eventless run; expired pending rows still run the TTL cleanup. The latest pending-capacity and safety-source assessment from dispatch are passed to the degradation watchdog and pulse snapshot sidecar in the same five-minute lane so those sidecars do not repeat the same D1 reads.

Eventless and circuit-open lifecycles also run bounded D1 maintenance before the due-transport gate ([Pending Delivery Queue](#pending-delivery-queue)), so orphaned `sending` rows recover without an unrelated alert; maintenance never counts as a send.

### Failure Modes

If the `telegram_preset_subscriptions` query throws (transient D1 failure) or `resolveTelegramPresetTargets()` cannot read the stablecoins cache, the source event remains incomplete and delivery stays closed rather than treating preset-backed recipients as an empty list. Direct, global, and preset targets materialize only after source resolution is complete, and snapshot baselines do not advance while any planned target remains unresolved. Structured metadata and logging record whether the failure was query- or resolution-related so a later run can resume the same source event without replaying terminal targets. A persistent `telegram:preset-query-failure-count` cache counter accumulates across consecutive failed preset-resolution runs and resets on the next successful run; the current value is exposed as `presetQueryFailures` in the Telegram bot status metrics.

### Alert Detection Rules

`TELEGRAM_ALERT_POLICY` in `shared/lib/telegram-delivery-policy.ts` is the single authority for every live-alert threshold, dwell, hysteresis and cooldown (R5). Moves that miss a gate are not sent live; each is counted under a named reason so the daily roll-up (built with the delivery rewrite) can consume them later. `worker/src/cron/telegram/dispatch/dispatch-telegram-alerts.ts` detects:

- **DEWS** (`planDewsAlerts`): escalations only. The observed band first gets exit hysteresis (`applyDewsExitHysteresis`): a coin leaves its previously observed band only when the score falls more than `exitHysteresisPoints` (5) below that band's lower bound, stepping down one band at a time; rises apply at once. An escalation must then appear in `escalationMinComputations` (2) distinct DEWS computations (`computed_at`; DEWS computes every 30 minutes, so about 30-60 minutes) before it is sent; while pending, the alertable baseline keeps the prior band and the message later states the band the coin rose from. De-escalations within the alertable range (`DANGER → WARNING`, `WARNING → ALERT`) are never sent live; a pending escalation that eases but stays above the last alerted band keeps counting rather than being absorbed. Direction is judged against the previously observed band, so a rise from `CALM`/`WATCH` into the alertable range is an escalation labelled from that band. Counters: `suppressedPendingDewsEscalations`, `suppressedDewsDeescalations`, `resetDewsBaselines` (log event `telegram_dews_changes_suppressed`). A seed run (missing or stale DEWS/depeg snapshots) adopts the current bands as already alerted and clears pending escalations, so conditions present at the seed never alert afterwards; on the first run after the candidate key is introduced the existing snapshots are used and any escalation starts its two-computation count. A run with no readable DEWS rows (stale or failed read) writes none of the three DEWS keys, and only an available read can trigger the DEWS stale-snapshot reseed, so a DEWS outage never blocks depeg alerts.
- New active depeg events by comparing persisted event IDs in the current and prior snapshots: a replacement ID triggers a new detected event even when the coin stays active, the peak falls or stays equal, or the direction reverses
- Depeg worsening milestones by comparing severity only within the same persisted event identity and direction
- Depeg resolutions by checking which prior active depegs disappeared and loading their exact persisted event IDs; only rows classified as recovered emit "Depeg Resolved" — an explicit recovery close reason (`recovered-primary`, `recovered-dex`, `recovered-native`), or a legacy row with no `close_reason` but a recorded `recovery_price`. Legacy snapshots without `eventId` retain stablecoin-only trigger/worsening diffing and the latest-closed-row resolution fallback until the next baseline write.
- **Safety** (`buildSafetyChanges`), comparing the current canonical V9 publication against `alert:safety-snapshot`, only when the live safety source cache is generation-valid. The persisted baseline row is the last *alerted* grade (`holdSuppressedSafetyBaselines`). Only a severe downgrade is sent live: at least `severeMinGradeNotches` (2) notches, or any drop landing at or below D. It must hold for `dwellSec` (6 h) against that baseline: the baseline row carries `pendingKind`/`pendingSinceSec`, the clock keeps running while the grade stays in the severe range (the message reports the latest grade) and resets when the grade returns or the move changes kind. A severe downgrade whose dwell ends within `downgradeCooldownSec` (24 h) of the coin's last live alert (`lastAlertedAtSec`) stays pending and is sent when the cooldown ends. A pipeline-gap, null-grade or operationally affected tick during a pending move keeps the last alerted row and both clocks. Minor downgrades keep the last alerted row, so small steps add up; upgrades are never sent live and become the new baseline once they hold for the dwell. Otherwise methodology-version-only regrades, pipeline gaps, null grades and operationally affected assets advance the baseline silently. A safety reseed keeps every coin's cooldown clock; when the old and new publication identities are comparable (continuity loss or source-generation change) it also keeps rows with a pending move so their dwell resumes, while an incomparable identity (model, methodology, policy or build change, such as a methodology release) takes current rows as the baseline silently (`reseedSafetyBaseline`). Counters: `suppressedPendingDwellSafetyChanges`, `suppressedMinorSafetyChanges`, `suppressedUpgradeSafetyChanges`, `suppressedCooldownSafetyChanges` (log event `telegram_safety_changes_suppressed`). Audience filtering then applies: global safety also needs `globalMinScoreDrop` (3 points) when scored; presets are downgrade-only; a direct coin's safety mode applies as stored.
- Reserve-drift transitions by comparing the producer's current drift id-set (`alert:reserve-snapshot`) to the dispatch baseline (`alert:reserve-dispatched-snapshot`); only coins newly entering drift fire (entering-drift only)
- **Freeze** real-time gate: see [Freeze Alert Source And Cadence](#freeze-alert-source-and-cadence).
- Launch promotions are no longer detected (family retired).

Safety-grade alerts carry a plain "Why:" line instead of the generic context facts used by DEWS/depeg alerts. The reason builder compares the previous and current optional `explain` snapshots and names a newly binding or changed cap first, unless the overall move is an upgrade: a cap never explains a rise. A variant-parent cap reads "Capped at the Safety Score of the coin it is built on." Otherwise it names the largest pillar movement matching the overall direction, in plain language with a pillar gloss (for example "Exit score rose from 35 to 48. Exit measures how easily holders can redeem or sell near $1."), then a new model reason, then the weakest pillar. A coin without `explain` data gets no reason line. Blacklist/freeze metadata remains display-only under the current methodology and is not used as a causal reason.

If the live safety source cache is missing, corrupt, stale, or from the wrong generation, DEWS/depeg alerts can still continue, but safety alerts stay suppressed until a fresh publish lands and the Telegram lane reseeds its prior safety snapshot under that same generation.

If the reserve producer envelope is missing, corrupt, stale, future-dated, or from the wrong generation, the other alert families continue but reserve alerts stay suppressed. The `telegramSummary` object from `/api/health` and the latest dispatch cron metadata expose the reserve source state, age, generation, and suppression flag. Recovery intentionally requires two producer publications: the first cold-seeds as `recovering`, and the next continuous four-hourly publication restores `ok` without replaying transitions accumulated during the gap.

When the safety snapshot has to be reseeded (e.g. methodology-version flip changes the source generation), the dispatcher compares the current live source against the last seen `alert:safety-snapshot` purely to count the safety changes that would otherwise have been emitted and surfaces the total as `suppressedSafetyChangesAtSeed` in the cron metadata. The count is informational — no messages are sent — so operators can spot when a generation flip is masking real downgrades and inspect the safety-grade history directly.

If the cached safety snapshot is missing a coin, the dispatcher suppresses its grade-change alert and seeds the current value; there is no grade-history timestamp exception. Pipeline gaps, null grades, and transitions involving operationally affected assets likewise establish recovery baselines rather than organic grade movements.

The separate `alert:dews-alertable-snapshot` cache key prevents duplicate same-band DEWS alerts when a coin silently dips to `WATCH` or `CALM` and then returns to the same alert band. Example: `ALERT → WATCH` produces no message and does not reset the alert dedupe baseline, so a later `WATCH → ALERT` does not resend the same `ALERT` notification. The baseline advances to every observed alertable band except while an escalation is pending, so an unsent `DANGER → WARNING` leaves `WARNING` as the baseline and a later confirmed `WARNING → DANGER` alerts again. Once a coin has stayed below ALERT for `baselineResetQuietSec` (24 h), its alertable baseline is cleared, so a later rise is reported from its real prior band and a return to its old band alerts again.

The helper predicates `isDewsAlertable()` and `isDewsDeescalation()` live in `worker/src/telegram/common/alerts-formatting.ts`.

## Dispatch Routing And Formatting

After [dispatch detection](#dispatch), subscription policy selects recipients and bounded message planning prepares the durable delivery manifest. Transport retries and terminal effects are owned by [Delivery Persistence](#delivery-persistence).

### Subscriber Filtering

Family persistence identifiers and SQL predicates derive from `TELEGRAM_ALERT_PERSISTENCE` in `shared/lib/telegram-alert-families.ts`: direct coin flags, independent preset rows, subscriber global flags, and explicit-off markers. Fan-out, pending preference revalidation and admin broadcast selection share that authority; broadcast active-follow checks reuse the canonical subscription/preset predicates without changing recipient scope. The fan-out family table owns only event-route semantics. [Preset watchlists](#preset-watchlists) owns precedence, marker-backed off and thresholds; do not duplicate its column roster here.

DEWS uses the coin's floor; local safety uses its direction mode, global safety uses the downgrade/material policy. Fresh depeg and recovery use configured deviation/peak gates and worsening uses the coupled step. Coverage-lost, orphan and superseded closures update snapshots without recovered notices.

Quiet hours silence notifications; chat snooze or the indefinite pause sentinel suppresses the whole chat. Dispatch metadata `chatsWithActiveSnooze` counts currently snoozed chats even if they had no event. Active coin snoozes suppress both direct and inherited coverage; either chat or coin snooze vetoes that pair.

If a recovered depeg closes and reopens between snapshots, replacement event ID is a new detected alert. Recovery interval uses exact prior `ended_at` to new `started_at` and is omitted for missing/inconsistent clocks or non-recovery closures. Suppress the simultaneous resolved line for that coin.

### Message Formatting and Limits

- `formatConsolidatedMessage()` emits HTML; `splitMessage(html, 4000)` keeps an ordered tag stack across section, line and hard boundaries. Each chunk closes/reopens the same nested tags and attributes within the limit; separators, entities and Unicode code points remain intact. Section/line cuts must leave non-whitespace rendered text; otherwise separators stay with neighboring text through the bounded hard cut. Whitespace-only messages and indivisible formatting/token envelopes that cannot fit throw rather than discard text. Split-policy versioning distinguishes new pending identities; already persisted chunks remain immutable and are never re-split or replayed by a policy bump.
- Distinct-chat waves use concurrency four; chunks for one chat stay serial. The shared ceiling is 3,600 attempts. The dispatch timeout is 4.5 minutes with 30-second heartbeats; send loops stop new batches after four minutes, leaving durable-finalization reserve. Lease TTL adds a one-minute crash fence; skipped-lock attempts cannot overwrite the owner's progress.
- Only deliverable events or incomplete source recovery create immutable sources. Preset capture persists 100-follower cursor pages with at most 32 attempts/20 seconds; failed attempts consume both bounds and retry only next invocation. Delivery stays closed until every family resolves.
- First planning claim freezes the cohort at source detection time and greatest eligible-created chat ID. Capture unions source-relevant direct/preset/global candidates, excluding global snooze; absent families skip loaders. Current eligibility/generation is recorded at capture and revalidated before materialization, not reconstructed as preference history. Reuse inputs only while all generations match. Later-created or capture-ineligible/newly-eligible chats cannot receive historical alerts; unrelated preference churn may use current generation.
- Render strict versioned plans with SHA-256 payload digest, bounded chunks, immutable page bounds and normalized items. New plans use split policy v4; persisted plans admit exactly v3 or v4, with one consistent version across every target key and exact key reconstruction under that stored version. Recovery and handoff preserve stored chunks, payload digests and keys without re-splitting or re-keying. Complete the page/cursor only after all plans/chunks are durable. Crash resumes that range without widening cohort or changing ordinals.
- Indexed reads bound source/generation/plan chunk reconciliation and `(chat_id,preset_id)` follower seeking; use chat-keyed subscriber merges and dedupe/chat indexes for backoff propagation. Apply the additive planning lookup indexes before Worker activation; rollback keeps them.
- Coordinator advances at most 32 durable transitions, releases its generation-fenced claim on bounded return and retains a 120-second lease after failure. The load model includes capture/planning/outage/drain with at least 20% modeled risk-TTL margin. This assumes pages fit inside 20 seconds: slow/failed D1 consumes the finite two-hour/24-start window and terminates through fenced expiry, never extended TTL or partial-cohort delivery.
- Delivery opens after complete capture/materialization. Bounded handoff validates every plan/target, set-based suppresses exact prior terminal effects, then atomically enqueues, propagates backoff and confirms queued state with one D1 batch plus page reconciliation. No per-target enqueue loop, direct risk send or cache-overflow authority exists. Exact same effect already sent/unknown on a prior source suppresses without replay and continues; live cross-source or hash-only collisions fail closed. Recovery of a source degraded by that exact terminal collision requires generation/owner fencing, delivery already open, and planned targets remaining.
- Risk rows carry immutable source, conservative coin/family group scope, enqueue preference generation and markup. One newly ineligible pair cancels remaining split chunks, never a partial stale group.
- Baselines stay unchanged until manifest ready/delivery open/no planned target. Snapshot writes and `baseline_committed` share one batch; complete is later bookkeeping. Expiry fences plan generation, reconciles at most 90 workflow/target rows per invocation and persists remaining debt; only complete expiry advances the stored baseline.
- Before formatting, newest-first page candidates use shared chunk estimates and a `max(1,captured chats*64)` budget. First candidate is admitted even above estimate; later overflow rejects the whole page before formatting/persistence. There is no independent burst-summary/fresh-send lane.

Transport outcomes distinguish sent, blocked, retryable and permanent failure. A first confirmed 403/chat-not-found stamps block time/count without disabling; a second within 24h disables follows and archives remaining live pending as `blocked_disabled`. Successful send resets strikes; an older first strike starts fresh. Auto-disable clears direct/preset/global intent, not just queue rows.

## Delivery Persistence

**Finalized planning decisions.** A page seals only after every retained captured member has a durable final outcome: `target_planned` owns exactly one consolidated plan and ineligible outcomes own none. Independently admitted payload digests, message identities, item identities and immutable target fields must reconcile before expected/materialized page totals are sealed together with the cursor under the live source owner/generation and unchanged-ledger guards. Counts come from admitted plans and their payload message counts, not actual target rows or the initial render's chunk forecast. A recovered suffix may unsubscribe, snooze or render fewer chunks without suppressing unaffected recipients.

Recovery of an old materializing or count-mismatch-degraded page is conservative: its original plan forecast can witness intact membership only when the entire retained window was initially eligible and every forecasted member is still accounted for. Other recovery windows without intact membership proof stay held as `target_page_membership_unproven`; missing plans/targets/items, invalid payloads and migrated identities also remain closed. Privacy erasure remains authoritative: recovery never restores deleted data, resets a generation or replays accepted/unknown effects.

Each atomic plan unit also requires its pending captured member and live subscriber at the observed preference generation; a stale render cannot recreate erased plan/target/item evidence. Ready and delivery-open gates recheck sealed page totals and retained target/item identities, so erasing evidence after a page seal cannot silently redefine the manifest as a smaller complete cohort. Missing capture-time eligibility (`snapshot_missing`) is unavailable evidence and holds completion rather than becoming an ordinary zero-target decision.

If preferences advance between rendering and that fenced unit, a missing plan is resumable only when the atomic outcome write was a no-op, the same intact captured member remains pending at a newer live generation, and no plan/target/item artifacts remain for that decision. The page stays materializing; the next bounded planning pass rereads eligibility/generation for that member without rewriting admitted peers. Missing or altered capture evidence, partial artifacts, and a missing plan whose outcome write succeeded still degrade the source rather than treating corruption as preference contention.

### Pending Delivery Queue

All new risk chunks enter `telegram_pending_alerts` as exact pre-split HTML only after complete source manifests. Existing retry/admin work and new targets share bounded claim/drain policy.

**Claim and effect fence.** Select only pending rows not already terminal by exact `source_event_id` plus pending dedupe identity; a recurring body hash is not terminal evidence. Claim CAS repeats selected state. New-format rows revalidate current direct/preset/global intent, explicit off, chat/coin snooze and required membership. Disabled pairs cancel without attempting; snooze, partial provenance and unavailable membership defer. All-null legacy provenance remains accepted except safety, which needs valid identity, but source-less rows never project onto authoritative alert targets. Immediately before each Bot API wave, the sending CAS repeats current-clock TTL, due time, live processing owner/lease and delivery/preference generations. Expiry is settled as expired rather than misclassified as preference churn; lease-expired untouched work is released without a send.

**Safety evidence.** Not-yet-started safety groups retain the full thin-source assessment: missing, unreadable, held or stale evidence defers with its machine-readable failure reason and retries within the original queue TTL. Recovery under a comparable identity can deliver the unchanged group once; it never renews expiry. Missing authored safety identity or a proven incompatible model/schema/methodology/policy/evaluator-build identity cancels rather than sends. Unavailability alone is not proof of incompatibility, and this policy never reopens terminal or already-started effects.

**At-most-once, not exactly-once.** Confirmed HTTP 429/5xx may return only that send generation to pending. A sending CAS whose response arrives after TTL or lease expiry may be released under its exact owner/generation only while the drain still knows no Bot API request started; that is unattempted admission work, not retrying an ambiguous effect. Timeout/network/unknown attempted results and crash-lost sending owners become immutable `execution_unknown`; confirmed success becomes sent. Terminal pending transition and authoritative target `final_delivery_state` use reciprocal source/dedupe guards in one batch. Failed cleanup leaves terminal truth that prevents resends. Dedupe re-enqueue may refresh only unclaimed/expired pending lifecycle rows, never sending/sent/unknown payloads, owners or timestamps.

**Maintenance before transport.** Ordered passes reconcile expired sending claims to unknown, project target finals, then reconcile terminal-target pending rows. Stale/terminal passes use `PENDING_DELETE_CHUNK_SIZE` in ID order; target-final stays bounded at 90 with source/owner/generation guards. Overflow waits for the next slot, including orphan/eventless/circuit-open queues. Fresh claims are untouched. Maintenance failure aborts transport; repair uses no message budget and cannot fabricate a send.

**Preferences.** Every intent mutation advances subscriber `preference_generation` atomically with direct/preset/global/snooze/unsubscribe/block-disable/chat-migration state. Revalidation binds current generation to send CAS, never rewrites original enqueue generation. Sending/sent/unknown remain monotonic evidence. Inactive cleanup shares its eligibility fence across child deletes so returning/newly subscribed chats survive; [schema/retention](./telegram-architecture.md#d1-schema) owns pruning.

**Target truth.** Target stays planned until exact pending insert commits, then projects one exclusive accepted/failed/cancelled/expired/unknown bucket. Job counters rebuild from those buckets while preserving metadata. Status and cancellation writers bind both source and pending dedupe identity. Only an exact sent target can reconcile pending work to sent; an expired target never creates acceptance. Historical prior-source targets cannot consume a new recurrence. Deliberate prior-live-pending collision/same-effect suppression remains a separate handoff policy. Legacy fresh-effect fields remain audit-compatible but never bypass the shared pending fence. Telegram offers no general message idempotency key; delivery is not guaranteed.

**TTL and audit.** `shared/lib/telegram-delivery-policy.ts` owns two-hour depeg/DEWS/safety/reserve/freeze/legacy risk TTL, 90-minute launch TTL and 45-minute admin TTL. Explicit expiry wins over legacy fallback at every wave, including split chunks; requests admitted before expiry retain real later acceptance. Cleanup repeats selected identity/provenance/expiry, owner/generation and observed lease, atomically projecting target outcomes and deleting only unchanged expired work. Copy failure logs `cleanup-expired-pending-dead-letter-bypass` and still removes only current expired work. Unknown is excluded from ordinary TTL/block cleanup and retains 90 days before guarded projection, deterministic `execution_unknown_archived` audit and fenced deletion. Unknown archive fails closed on audit/projection failure; no early-acknowledgement HTTP control exists.

`PendingDeadLetterReason` in `worker/src/cron/telegram/delivery/types.ts` owns reason vocabulary. Deterministic pending-ID/delivery-generation audit keys allow only matching reason/provenance/payload/lifecycle replay, never duplicate/replaced evidence. Preference cancellation is cancelled, not expired. Dispatch drop counters distinguish TTL, permanent rejection, and defensive max-attempt fallback. Historical `manual_clear` remains readable, but no operator clear/replay endpoint exists. [Incident remediation](./runbooks/telegram-no-delivery.md#remediation) forbids raw deletes or hand-enqueueing as substitutes.

**Admin broadcasts.** HTML preflight precedes target reads/enqueue: supported Telegram tags/entities only, balanced and with allowed attributes. Malformed/unsupported markup returns 422 and an audit error without rows. Live execution requires a known private canary, available admin permit and at least 15 minutes projected reserve inside its TTL. Every silent-canary chunk succeeds before fleet enqueue; no acknowledgement overrides reserve. [Broadcast safety](./runbooks/telegram-admin-broadcast-safety.md) owns the copy-paste operator procedure.

**Backoff/dedupe.** Retry uses exponential 60/120/240/480/600 seconds, capped at 600, with Telegram Retry-After overriding. Re-enqueue collisions retain the prior attempt count, not a fresh weaker delay. `not_before_at` also defers snoozes, generation races, malformed provenance and unavailable preset membership. Quiet hours are re-evaluated and silence, never defer. `last_error_class`/`retry_after_sec` preserve transport evidence.

`buildDedupeKey` in `worker/src/telegram/outbox/pending-queue.ts` binds chat, split version, chunk index and canonical pre-split body hash (chunk HTML for legacy). Freeze instead binds immutable source-event ID, preserving distinct identical-looking Tape events. Change split version with splitting algorithms. Group migration rewrites chat-prefix keys; collisions retain one deliverable new-chat copy.

**Rate limits.** Confirmed chat-scoped 429 atomically raises every live pending row's deadline and independent `telegram:chat-send-backoff:<chatId>` deadline with the attempted generation's fenced retry transition. Terminal/unknown rows remain untouched. Enqueue, authoritative handoff and retries inherit the deadline without changing TTL; bounded maintenance prunes expired chat keys by stored deadline. `/forget` erases the key and chat migration retains the maximum. Same-chat chunks stop while peers continue. Long Retry-After is not global; [rate-limit incidents](./runbooks/telegram-no-delivery.md#rate-limit-storm) owns durable 3-chat/60-second escalation. Missing retry_after uses 60 seconds. Global backoff raises `telegram:global-send-backoff-until` monotonically; row deadlines retain the same bound if its durable write fails.

The blocking [load simulation and query-plan checks](#load-simulation-and-query-plans) enforce the reviewed SLO, CPU, TTL-margin and read-cost budgets; the implementation appendix owns fixture, index and workflow-selection details.


### Rollout and Rollback

Stop rollout verification when planning is degraded, expiry debt remains, or exclusive job counters disagree with target rows. Do not reset source generations or delete partial manifests. Recover through a verified pre-change D1 Time Travel point and compatible Worker when forward recovery is unsafe; the migration manifest owns additive schema and squashed lineage.

## Digest Appendices

[Digest Telegram delivery](./digest-pipeline.md#telegram) owns appendix shape, cache keys, identity equivalence and edition-bound snapshot advancement; implementation is `worker/src/telegram/digest/digest-appendices.ts`. Queued notices survive retries and ambiguous delivery: only acceptance of every persisted chunk consumes them. This is channel edition state, not subscriber-event replay.

## Admin Visibility

[Status dashboard Telegram metrics](./status-dashboard.md#telegram-bot-metrics) owns the field inventory and delivery-SLI interpretation; `worker/src/lib/status/telegram-bot-stats.ts` owns the projection. Acceptance means Bot API acceptance, not recipient delivery/read. Ad hoc usage questions read `telegram_usage_daily` and the lifecycle tables directly; there is no funnel report.

Public pulse/client privacy and freshness are owned by [Mini App public pulse](./telegram-mini-app.md#public-pulse-privacy-and-freshness). Lifecycle deltas use atomic transition events, not net snapshot differences; unavailable telemetry is null with explicit quality, never zero.

### Alerting on degraded delivery

`worker/src/cron/telegram/maintenance/telegram-degradation-watchdog.ts` runs after `dispatch-telegram-alerts` on the five-minute lane. It reuses same-slot pending-capacity and safety-source evidence when available, otherwise reads live sources and fresh dispatch metadata. Unknown D1 evidence degrades telemetry and preserves onset keys, never fabricating an empty queue or recovery:

- Pending delivery risk: active pending rows exceed 500, oldest pending age is at least 15 minutes, estimated drain time is at least 30 minutes, any row is inside the 15-minute near-TTL window, or unexpired execution-unknown work is at least 15 minutes old. A first breach only records the episode onset; count/age/drain/execution-unknown breaches trigger once sustained for 20 minutes (`telegram:degradation:pending-since`), while a near-TTL breach triggers on a later evaluation without waiting out the sustained window.
- The canonical V9 safety assessment reports `state != "ok"` for at least two `compute-safety-score-v9` intervals (cache key `telegram:degradation:safety-source-since`). Held-publication outcomes add the bounded hold start, hold age, and up to five reason codes to the incident detail and cron metadata without changing the episode key or sustained threshold.
- The most recent `dispatch-telegram-alerts` cron run reported `eventsDetected > 0`, `messagesSent == 0`, and admitted recipient work for three consecutive distinct runs (cache key `telegram:degradation:zero-send-streak`). Non-freeze work uses row-backed `authoritativePlanning.plannedTargetCount` only when its non-null `sourceEventId` and `sourceEventFamilies` cover the events evaluated by that run; freeze observations use that run's durable `freezeTargetCount`. Missing counts or inapplicable source scope stay unknown and preserve the episode, never default to zero. The cached JSON stores both the streak and the last evaluated `cron_runs.id`, so repeated evaluation of one row cannot advance the streak; legacy integer episode values remain readable.

Dispatch evidence carries `zeroSend.availability` (`available` or `unknown`) and a machine-readable `zeroSend.reason`. A failed ledger read or missing/invalid required metadata degrades the watchdog with `dispatch-evidence-unavailable` when no higher-priority condition owns the top-level reason. It preserves the cached streak and last evaluated run identity without claiming recovery. A successful query with no completed row is `available` with `no-completed-run`; a valid duplicate row is `available` with `already-evaluated`. Neither advances the streak, and an already-triggered episode remains triggered in either case. Only a distinct admitted dispatch result that no longer meets the zero-send condition recovers the episode; its identity remains cached at streak zero so rereading that row cannot claim recovery again.

Every watchdog `safetySource` outcome carries `failureReason`, parsed-publication `ageSeconds`, source envelope `generation`, nullable `sourcePublicationGenerationId` and `acceptedPublicationGenerationId`, `freshnessMaxAgeSec` from `SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC`, and `assessedAtSec`. These diagnostics remain visible on newly tripped, sustained, pending-masked, and recovered runs. Age uses publication time, never cache-write time; preloaded assessments retain their original assessment clock and age. Successful sibling reads retain their provenance if the other read fails. `v9-publication-held`, `v9-snapshot-read-failed`, and `v9-snapshot-invalid` distinguish producer holds, D1 failure, and invalid JSON/schema/identity without changing the canonical source-state vocabulary, episode onset, thresholds, detail strings, or safety-alert suppression.

Compact health/cache identities and attempt readers live in `worker/src/lib/safety-score-v9/publication-health.ts` and `publication-attempts.ts`. Telegram imports these light modules, not the publication writer or report-card materializer; shared health reconciliation must not add a full-snapshot decode edge to the five-minute lane (ADR-24).

`GET /api/health.telegramSummary` uses the same lifecycle vocabulary and returns `pendingDeliveries: null` with `pendingDeliveryLifecycleStatus: "unknown"` if the capacity query fails. `/api/status.telegramBot.pendingDeliveries` counts only active claimable plus deferred rows rather than expired or in-flight cleanup states.

The watchdog is wired through `runBestEffortScheduledJobWithOutcome` so its own failures never block the dispatch lane, and its metadata captures `triggered` and `recovered` flags per condition for admin inspection via `cron_runs`.

Current dispatch results do not emit the retired `perAlertType`, `perAlertTypeTargets`, fresh-send outcome counters, or duplicate fresh-candidate projections. Comms uses `telegramBot.deliverySli.rollup.authoritativeTargetOutcomes` for bounded row-backed outcomes and keeps mixed-family target lineage distinct from single-family attribution; unavailable rollups stay unavailable. Historical metadata remains visible verbatim in cron detail, but its dominant-family/fresh-send counters are not current pending-drain measurements.

### Circuit Breaker

The dispatcher is protected by `CIRCUIT_SOURCE.TELEGRAM_API`.

- Open circuits skip fan-out.
- Open circuits still run pending maintenance/drain; durable transport permits can independently defer actual sends, so queued retries are not guaranteed to deliver while the circuit is open.
- Successful snapshot seeding or alert delivery records a successful outcome.
- Failed sends record an unsuccessful outcome.

## Message Types

Formatting helpers in `worker/src/telegram/common/alerts-formatting.ts` use one template for every family. The first line is the push preview: glyph, bold symbol, a direction verb and the key number (for example "▼ **USDC** lost its peg: $0.9880, 1.2% below $1.00", "🟠 **USDT** early-warning stress rose to WARNING (58/100, was ALERT)", "**USDR** Safety grade downgraded to D (was B)", "**USDC** issuer froze an address on Ethereum holding $1,000,000"). Facts with units follow, then an optional plain "Why:" line (safety reasons), then an italic provenance footer `Via {preset labels | your watchlist | all stablecoins} · {family}` built per message (the union of sources across its events, not per coin) from the routing source of each recipient (`AlertVia`, carried on the routed chat entry; freeze derives it from the direct/global opt-in). Up to two events stack the full template in severity order with recoveries, de-escalations and upgrades last; three or more render a count headline and compact lines grouped by family. Families with no live audience no longer render (launch is retired).

- One contextual line when cached report-card, liquidity, or supply data is available for the affected coin. For mint/burn-tracked coins the same line also carries a `Flow24h <signed compact USD>` segment sourced from the cached per-coin 24h flow (`perCoinFlowCacheKey(id, 24)`); dispatch reads only the tracked subset of alerting coins in one bounded `Promise.all` (no recompute) and omits the segment when that flow is stale or net-zero. Rendered as an expandable Telegram blockquote (`<blockquote expandable>…</blockquote>`) so it collapses by default on mobile; requires Telegram Bot API 7.0+ (Mar 2024) — older clients render it as a regular blockquote.
- Supply and DEX liquidity context carry their producer clocks through `worker/src/cron/telegram/sources/telegram-alert-context.ts` and are assessed with existing budgets only (`worker/src/telegram/common/context-freshness.ts`): supply uses the asset's `supplyObservedAt` bounded by the stablecoins publication time against the `/api/stablecoins` endpoint budget (`API_FRESHNESS_MAX_AGE_SEC.stablecoins`), and DEX liquidity uses the `dex_liquidity.updated_at` row clock against the DEWS DEX-liquidity budget (`DEWS_STALE_DEX_LIQUIDITY_SEC`). Boundaries are inclusive. Supply is read through `getCirculatingRawOrNull()`: missing, empty or invalid-only buckets are omitted, never rendered as `Supply $0`; an explicit observed zero renders `Supply $0`. Stale, unclocked or unavailable supply…

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

The reserve-drift family (C123) ships **glyph-less**: a `Reserve Drift` section with a bold-symbol line and no data-tied glyph. Per the rule above, adding a reserve glyph requires a separate review.

Subscriber alerts retain `View on Pharos`. Telegram digest posts end with `Read on Pharos →` after editorial body and appendices; no personalized-recap CTA is added. A current daily Safety Score map retains its dated summary above the edition kicker and separate durable-outbox photo before text chunks.

For single-coin alerts the first chunk uses `link_preview_options: { is_disabled: false, url: "https://pharos.watch/stablecoin/<id>", prefer_small_media: true, show_above_text: false }` for a compact preview below the body. New-format pending rows persist this markup policy and restore it when drained, including single-coin previews. Multi-coin and overflow chunks keep previews disabled; legacy rows without persisted markup use the default disabled-preview behavior.

## Digest vs Subscriber Alerts

The same bot token can be used for both:

- Channel-style digest posting through immutable editions and the durable digest outbox (`enqueueTelegramDigestEdition` / `deliverTelegramDigestEdition`)
- Direct chat replies and subscriber alerts via `sendToChat(...)`

The Daily Digest and weekly market recap remain public editorial editions on their existing schedules. Personalized subscriber recap retirement does not alter either editorial producer or replay-safe channel delivery.

Daily Digest and Weekly Recap outbox retry budgets are evaluated after a retryable transport response: 12 claimed retryable attempts may return to `pending`; the 13th retryable result, or one at least 24 hours after generation, becomes `failed_permanent` with an attempt- or age-budget error class. These are retry-return limits, not pre-send gates. Ambiguous attempted transports remain `execution_unknown` and are never made replayable by the budget.

Digest posting uses `TELEGRAM_CHAT_ID`; subscriber alerts use the chat IDs stored in `telegram_subscribers`. Operator-only alerts (currently the cron freshness watchdog and the digest-publication watchdog, both dispatched by `cron-sentinel` in `status` mode) use `TELEGRAM_OPERATOR_CHAT_ID` via `buildTelegramOperatorCreds()`; they are ops signal rather than audience content, so they must never be sent with the public channel credentials, and an unset operator chat suppresses the send instead of falling back.

## Operational Notes

- The dedicated 5-minute Telegram trigger checks webhook, commands, profile, and menu reconciliation serially on every tick through `worker/src/telegram/webhook/webhook-registration.ts`. Each unit may skip independently on its 15-minute fresh-cache/rate-limit marker. After deploying a command-list change, the production `/` menu should update on the next tick whose command unit is not skipped.
- Command reconciliation issues scoped `setMyCommands` calls for private and group chats, derived from `shared/lib/telegram-bot-registration.ts`. The group menu omits private setup `/start` and destructive `/forget`; `/recap` is absent from both. A matching `telegram:commands-reconciled` cache skips both round trips; manifest/cache-version changes force reconciliation.
- The same trigger reconciles the bot profile metadata (display name, short description, long description) under cache key `telegram:profile-reconciled` on the same 15-minute cadence. The configured strings are exported constants in `shared/lib/telegram-bot-registration.ts` so changes flow through code review and are reused by manual recovery tooling. The description's alert-family list derives from the canonical manifest in `shared/lib/telegram-alert-families.ts` (shared with the landing page, its metadata, and JSON-LD), and the profile copy is intentionally count-free so a growing tracked universe cannot stale it. Telegram returns a 400 "is not modified" response when the submitted value already matches the live one; the reconcile treats that as success and still refreshes the cache marker so the next 15 minutes are a true no-op. Current Bot API versions expose `setMyProfilePhoto`, but Pharos does not yet reconcile it; until that path is reviewed, set the avatar manually through @BotFather using `public/pharos-mark.png`. The brand mark was refreshed on 2026-07-31 and the former pharos-icon asset was removed — re-upload the avatar so the bot matches the current identity.
- The cron connection-budget check includes the four serial command/profile/menu/webhook reconciliation checks as one budget-only surface on the same chained five-minute Telegram group. It is not a separate status-tracked `cron_runs` job. `/api/status.budgetOnlySurfaces` records each unit as skipped, succeeded, or failed, including stable skip reasons; the serial Bot API call budget remains visible to `npm run check:cron-connections`.
- With a bot token configured, registration `durationMs` begins immediately before the four registration checks and excludes the preceding dispatch/recap/watchdog/cleanup/pulse chain. Without a token, the error duration retains the missing-token bookkeeping interval, before token-independent sidecars run.
- `npx tsx scripts/maintenance/register-telegram.ts --action webhook`, `npx tsx scripts/maintenance/register-telegram.ts --action commands`, and `npx tsx scripts/maintenance/register-telegram.ts --action profile` remain manual recovery tools when an operator needs to force Bot API state outside the Worker reconciliation loop. Command, profile, and allowed-update payloads are shared with Worker reconciliation through `shared/lib/telegram-bot-registration.ts`.
- The webhook intentionally returns `200` on most malformed or unauthorized cases so Telegram does not keep retrying noisy payloads.
- The five-minute Telegram trigger runs dispatch (with a token), watchdog, disambiguation cleanup and pulse before all four registration checks. Without a token, dispatch skips and registration records an error while independent sidecars continue.
- The dispatcher consumes Bot API response bodies before returning so transport cleanup and response-byte use remain bounded.

## Runbooks

Start read-only diagnosis at [Telegram Operator Queries](./runbooks/telegram-operator-queries.md#read-only-incident-entry); access does not grant mutation/replay authority. Choose [delivery/backlog/rate-limit/outage](./runbooks/telegram-no-delivery.md#quick-diagnostic-checklist), [ingress/retry/setup](./runbooks/telegram-webhook-retry-dedupe.md#quick-diagnostic-checklist), or [digest exact-effect recovery](./runbooks/telegram-digest-outbox.md). The generated [runbook index](./README.md#runbook-index) owns the complete roster, including auth, secrets, BotFather, presets and broadcast.

## Command Implementation Appendix

### Setup Wizard

Private `/start` (empty payload, `?start=setup`, or a landing token) is handled in `worker/src/telegram/webhook/telegram-webhook-setup.ts` and `callbacks/setup.ts`. Setup keeps no pending state.

- **New private user.** One card with three buttons: Follow the top 25 USD stablecoins (`setup:top25`, follows `usd-top25` for DEWS + depeg in one tap), Choose my own coins (opens the Mini App watchlist), and Show me a sample alert (`setup:sample`). After the first tap the card is replaced by a Done message, a sample alert preview, and Manage Alerts and Undo buttons. `setup:undo` unfollows `usd-top25`; Undo is offered only if that tap added it.
- **Returning user.** A "Welcome back" summary with Manage Alerts, Pause 24h and Help.
- **Groups.** Admins get a one-tap follow button; non-admins get a three-line note with a DM link.
- Old wizard buttons answer with a restart hint.

The first effective follow is owned by the shared Store enable mutation, not the setup reply: its idempotent `first_follow_at` milestone commits with the direct/preset/global transition. Bulk confirmation, quick-subscribe and settings use the same claim; previews, no-ops, replay and failed writes do not claim a new follow. No funnel aggregate is written.

**Attribution.** Setup-destination tokens persist into `bot_start`, `setup_complete` and `first_follow` campaign/placement dimensions. Generic `sub_*` links remain organic/unknown.

### /start Deep-Link Payloads

Telegram supports `https://t.me/PharosWatchBot?start=<payload>` deep links. The payload arrives as the `/start` argument string and is dispatched through `parseStartPayload` in `worker/src/telegram/webhook/telegram-webhook-parsing.ts`.

Supported payload schemes (lowercase, no spaces, max 64 characters, characters `[A-Za-z0-9_-]` only):

| Payload | Behavior |
|---------|----------|
| `sub_<types>_<targets>` (e.g. `sub_depeg_usdc-circle` or `sub_dews-depeg_usd-top25`) | Translates to `/subscribe <types> <targets>` and dispatches the existing subscribe path. Both non-empty segments are required; multiple alert types are joined by `-`, so `sub_usdc` is malformed and remains read-only. Valid private-chat subscription links are classified as mutating before dispatch so the effect fence records the subscription write and confirmation reply. Group deep-links fall back to the onboarding reply with no mutation. |
| `status_<id>` | Opens the status card for the supplied Pharos coin id. Allowed in any chat. |
| `why_<id>` | Opens the same status card. Allowed in any chat. |
| `coverage_<id>` | Opens the same status card. Allowed in any chat. |
| `setup` | Opens onboarding. |
| `pw1_landing_*` (tokens from `TELEGRAM_LANDING_LINK_CATALOG`) | Open the same onboarding card as `setup`, led by the one-tap "Follow the top 25 USD stablecoins" button; nothing is followed until that tap. No placement or attribution is recorded. A worker regression test sends every catalog token through the webhook. |
| `sample` | Alias entrypoint for `/sample`: private chats receive the synthetic USDC DEWS preview; other chat types receive the private-chat-only reply without running the preview. Surfaced by the Mini App Home "Send me a sample alert" deep link. |
| `app` / `home` | Sends a Mini App launch nudge. Private chats receive a Web App button for the home panel; groups receive a DM link because Telegram rejects `web_app` buttons outside private chats. |
| Unknown or malformed | Falls back to the standard `/start` reply; the user never sees an error. |

Telegram only delivers `?start=` deep links in private chats, but the dispatcher still defensively checks `chat.type === "private"` before running mutating `sub_*` payloads.

## Delivery Implementation Appendix

### Load Simulation and Query Plans

`npm run check:telegram-load` runs deterministic local migrated-SQLite simulation, never production D1/Telegram. Fixtures cover 500/1,000/5,000/10,000 watchers with direct/global/preset/group/quiet-hour/snooze/blocked populations. Scenarios include single depeg/freeze, market burst, DEWS/safety/reserve burst, admin send, recap and a 15-minute 429 outage.

Read target/chunk counts, queue enqueues, capture/planning delay, outage time, post-recovery drain, TTL margin, CPU and D1 costs together. Shared runtime and reviewed simulation-only inputs come from `shared/lib/telegram-delivery-policy.ts`, not hand-maintained fixture measurements here. Sender budgets/deadlines/TTL, Telegram pacing, p95/D1 cost and CPU ceiling bound the model; planning uses the Worker's capture/page/transition policy.

The production-calibrated scenario guards source-scoped candidates, invocation page reuse, handoff at most eight D1 round trips/page and projected wall time ≤three minutes. Full migration replay plus EXPLAIN checks protect direct/global/pending index paths; reviewed preset/status fallback scans remain explicit REVIEW entries, not silently approved full scans.
The pending-claim plan requires indexed pending-state selection and an exact source/dedupe target lookup through `idx_tajt_pending_source_outcome`. Its existing priority/due-time top-N sort remains bounded by the drain-attempt output limit; the source fence must not be removed to recover the former dedupe/status index plan.

`buildQueryPlanChecks()` enforces rows-read/duration budgets for pulse refresh, top-coins status and lifecycle-history fallback against migrated planning fixtures. These aggregates run on pulse cache miss / 15-minute heavy refresh, not each request; budget breaches require query/scale review.

`npm run check:telegram-load` is blocking (`--enforce-target-slo`): the policy's `sloEnforcedTarget` must meet the normal under-15-minute risk-alert SLO and spike bound. `requiredTarget` still bounds CPU, TTL margin and status-read budgets even when its SLO rows are advisory because planning cadence dominates. Inspect `shared/lib/telegram-delivery-policy.ts` for current tiers. For an advisory local report with critical query-plan failures, run `npx tsx scripts/ci/check-telegram-load.ts` without the enforcement flag.

The reviewed dependency groups in `scripts/lib/telegram-load-guard.mts` drive local merge-gate selection and are parity-checked against the GitHub workflow path filter. They cover dispatch/pending work, durable job and target schemas, sender transport, preset resolution, formatter/chunker behavior, scheduled-lane ownership, admin broadcast, delivery policy, Worker CPU configuration, migrations, and the guard itself. Full deploy fallback includes the advisory report unconditionally; the scheduled Monday workflow keeps the blocking SLO check.
