# Telegram Architecture Seams

Status: post-freeze structural baseline; the internal-reorganization freeze ended on **2026-06-13** (see [Historical freeze period](#historical-freeze-period)).

This is the load-bearing structural doc for PharosWatchBot's worker-side code. It names each seam, declares ownership and allowed dependencies, and lists the symptoms that should trigger a re-evaluation. For *what the bot does* (commands, alert types, schema, runbooks) see [`telegram-alerts.md`](./telegram-alerts.md).

The Telegram subsystem has been decomposed three times in the last 30 days. Each pass moved code without naming the boundaries it was creating, so the next pass reopened the same questions. This doc fixes the boundaries; future changes either stay inside a seam or get an explicit revision of this doc.

---

## Seam overview

```
                 Telegram Bot API
                       │
   ┌───────────────────┴─────────────────┐
   │ inbound (webhook)     outbound (sends) │
   ▼                                       ▲
┌──────────┐                          ┌──────────────────┐
│ Ingress  │                          │ Outbound         │
│          │                          │ transport        │
└────┬─────┘                          └──────────────────┘
     │                                       ▲
     ├──► Command parsing ──┐                │
     ├──► Callback routing ─┤                │
     │                      ▼                │
     │                  Action handlers ─────┤
     │                      │                │
     │                      ▼                │
     │                  State / persistence  │ (Worker cron)
     │                      ▲                │   ▲
     │                      │                │   │
     │                      └────────────────┴───┴── Dispatch / fan-out
     │                                       │       │
     │                                       │       └── Queue / rate-limit / retry
     └── Common: telegram-shared, telegram-constants, telegram-log, telegram (HTTP), telegram-alerts (formatting)
```

Nine seams: **Ingress**, **Command parsing**, **Callback routing**, **Action handlers**, **Dispatch / fan-out**, **Queue / rate-limit / retry**, **State / persistence**, **Outbound transport**, and **Mini App surface**. Plus a small set of **Common** modules that any seam may import.

The audit asked for 6–7 seams. "Outbound transport" got its own seam because both Ingress (replies to commands) and Dispatch (alert fan-out) send through it; collapsing it into either side would force the other to reach across. **Command parsing** is kept distinct from **Action handlers** because the parser is reused by callbacks (disambiguation reply path) and `/start` deep-link payloads.

---

## 1. Ingress

**Responsibility.** Receive `POST /api/telegram-webhook` requests. Validate the shared secret (with rotation overlap). Owner/generation-claim the `update_id`, persist a versioned normalized operation intent, atomically prove replay-safe local mutation, and cross the effect fence only immediately before an irreversible Bot API call. Stale unstarted/planned claims are reclaimable; planned takeover resumes stored normalized parameters instead of mutable pending/setup rows. Once effect-start is durable, duplicates are acknowledged without replay and uncertain rows are exposed for operator reconciliation. Hold the dedupe, pending-disambiguation gate, ingress flood cap, group-admin gate, and per-command cooldown.

**Owned files.**
- `worker/src/api/telegram-webhook.ts` (entrypoint: secret validation, claim/fence bootstrap, and per-update-type routing)
- `worker/src/api/telegram-webhook-auth.ts` (secret validation, group-admin gating)
- `worker/src/api/telegram-webhook-update-normalization.ts` (pure update-shape helpers: update-type/chat-id resolution and group-to-supergroup migration extraction; no D1, no Bot API)
- `worker/src/api/telegram-webhook-effect-fence.ts` (the `update_id` claim bootstrap — duplicate/in-flight answering — plus the request-scoped operation-intent effect fence crossed before irreversible Bot API calls)
- `worker/src/api/telegram-webhook-update-dispatch.ts` (intent dispatch: routes claimed callback taps and message commands through the ingress policy gates and the pending gate into `COMMAND_HANDLERS` / the callback router)
- `worker/src/api/telegram-webhook-ingress-policy.ts` (ingress flood cap, per-command cooldown, group-admin gate, channel-mutation refusal predicates, and command-usage attribution)
- `worker/src/api/telegram-webhook-pending-gate.ts` (the pending-disambiguation / setup-step gate decisions run before dispatch: `handleSetupPendingBeforeDispatch`, `handlePendingActionBeforeDispatch`, and the disambiguation-reply helpers)
- `worker/src/api/telegram-webhook-group-welcome.ts` (the group lifecycle sub-seam: `handleMyChatMember` plus the bot-added/-removed transition checks, welcome message/markup builders, and the local `TelegramChatMemberUpdated` shape)
- `worker/src/api/telegram-webhook-shared.ts` (types/constants used by both Ingress and Action handlers — see note below)

**Allowed inbound dependencies.** `worker/src/index.ts` request router (this is an HTTP entrypoint).

**Allowed outbound dependencies.** Command parsing, Callback routing, Action handlers (via `COMMAND_HANDLERS`), State / persistence (for the processed-update claim, the pending-disambiguation read, the cooldown gate), Outbound transport (for reply helpers), Common.

**Must NOT.**
- Format alert messages — that is Action handlers / Common (`telegram-alerts.ts`).
- Read alert snapshots or build subscriber queries — that is Dispatch.
- Write subscription state directly — go through State / persistence helpers.
- Reorganize the `COMMAND_HANDLERS` table without adding/removing a command. The two switch statements were intentionally collapsed in P1-M1; do not re-expand.

Group lifecycle is part of this seam, isolated in
`telegram-webhook-group-welcome.ts` and invoked from the dispatcher loop: when a
group/supergroup `my_chat_member` transition says the bot was removed, Ingress
runs the subscriber-state cascade and clears exact group lifecycle cache keys.
When a bot-added transition sends the audited welcome reply successfully, Ingress
stamps the `telegram:group-welcome:<chat_id>` cache marker directly from that send
result.

The pending-flow gate is likewise isolated in
`telegram-webhook-pending-gate.ts`: the dispatcher loop loads the pending row,
applies the ingress flood cap, then delegates the setup-step / disambiguation
decision (pass-through, clear-and-run, ownership refusal, or reply-and-stop) to
that module before parsed commands reach `COMMAND_HANDLERS`.

> Note on `telegram-webhook-shared.ts`: it contains `TelegramWebhookUpdate`, `PendingAction`, `ConfirmBulkPayload`, etc. — types crossing the Ingress / Action-handler boundary. Treat it as a contract file; widening it is fine, restructuring it is a seam change.

---

## 2. Command parsing

**Responsibility.** Convert text strings into structured records: `/<command> <args>` into a `ParsedCommand`, `/subscribe` args into a typed `ParsedSubscribeArgs`, `/set` args into a typed `ParsedSetCommand`, `?start=…` deep-link payloads into command intents, and stored disambiguation rows back into typed `PendingAction`s. Pure functions; no D1, no fetches.

**Owned files.**
- `worker/src/api/telegram-webhook-parsing.ts`
- `worker/src/lib/telegram-alerts.ts` — parts: `parseSubscribeArgs`, `validateSubscribeArgs`, `resolveTicker`, `parseDisambiguationReply`, `suggestClosestToken`, the formatting helpers, and the `splitMessage` chunker. (This file straddles parsing and formatting; see "Architectural tension" below.)
- `worker/src/lib/telegram-presets.ts` — preset alias resolution (`resolveTelegramPresetAlias`) is part of parsing; `resolveTelegramPresetTargets` (which reads the cache) is consumed by Action handlers and Dispatch.

**Allowed inbound dependencies.** Ingress, Callback routing, Action handlers, Dispatch (for `splitMessage` and formatting), Outbound transport (replies use `splitMessage`).

**Allowed outbound dependencies.** `@shared/lib/stablecoins`, `@shared/lib/classification`, Common (`telegram-constants`, `telegram.ts` for `escapeHtml`). No D1.

**Must NOT.**
- Make D1 calls.
- Make `fetch()` calls.
- Mutate global state.
- Inline preset coin lists — read from `telegram-presets` resolution at call time so the cache stays the source of truth.

---

## 3. Callback routing

**Responsibility.** Translate `callback_query` updates into action invocations. Ingress applies the shared flood cap before this router runs and maps read-heavy `status:`, `why:`, and `coverage:` callbacks onto the matching command cooldown bucket. Validate the `action:arg` shape against an allowlist (`CALLBACK_ACTIONS`) before any handler D1 touch. Per-action: validate args, gate group admins for mutating actions, call the appropriate action helper or directly persist, then `answerCallbackQuery`. Bulk `setup:*` and `settings:*` namespaces have their own sub-dispatchers for compact validation tables; the setup dispatcher gates mutating steps in groups while leaving `setup:cancel` and `setup:branch:skip` to the initiator-ownership checks.

**Owned files.**
- `worker/src/api/telegram-webhook-callbacks.ts`
- `worker/src/api/webhook-callbacks/` (`index.ts` owns the handler registry; per-action files own action implementation)
- `worker/src/api/telegram-webhook-setup.ts` (setup wizard state machine — invoked by both Callback routing for `setup:*` taps and by Ingress for `awaiting-ticker` text input, including slash-prefixed `/TICKER` replies)
- `worker/src/api/telegram-webhook-settings.ts`, `telegram-webhook-settings-render.ts`, `telegram-webhook-settings-mutations.ts`, `telegram-webhook-settings-shared.ts` (settings inline keyboard sub-system, including paginated per-coin owner buttons on the chat-level settings home)

**Allowed inbound dependencies.** Ingress only (`handleCallbackQuery` is called from `handleTelegramWebhook`).

**Allowed outbound dependencies.** Command parsing (`parsePendingDisambiguation` for bulk-confirm), Action handlers (re-runs `/why`, `/coverage` via the same helpers; falls through for quicksub via store helpers), State / persistence, Outbound transport, Common.

**Must NOT.**
- Bypass the `CALLBACK_ACTIONS` allowlist when adding a new callback prefix. Any new prefix is a seam-relevant change — add it to the allowlist *and* to the registered keyboard builders in one commit.
- Duplicate write logic that exists in `telegram-webhook-store.ts`. The per-action files in `webhook-callbacks/` route their writes through helpers (`snooze.ts` via `setSubscriberSnooze`; `depegstep.ts` / `safetydown.ts` via `prepareCoinSettingStatements`); there are no inline `INSERT … ON CONFLICT` writes left in the callbacks layer. New mutations go through `telegram-webhook-store.ts`.
- Render inline `telegram_subscriptions` upserts for settings callbacks. Per-coin setting writes use the State-owned builders in `telegram-store/subscriptions.ts` so `/set` and `/settings` keep the same override semantics.
- Take a hard dependency on a specific *Action handler* implementation — when a callback needs to re-run a command, prefer the same `build*Message` helper the command uses rather than calling `handle*` from `webhook-commands/`.

---

## 4. Action handlers

**Responsibility.** The business logic per command. Read whatever DB state the command needs, build the response message via Common formatters, persist any state changes through State / persistence, send via Outbound transport. One file per command keeps the surface small.

**Owned files.**
- `worker/src/api/webhook-commands/` (full directory)
  - `index.ts` — `COMMAND_HANDLERS` dispatch table
  - `context.ts` — `WebhookCommandContext` shape passed to every handler
  - `action-runner.ts` — shared `/subscribe`, `/unsubscribe`, `/set` coin-resolution + bulk-confirm flow (also used by Ingress's disambiguation reply path)
- `worker/src/api/telegram-webhook-disambiguation-selection.ts` — executes pending disambiguation selections from callback replies through the shared action runner
  - One file per command: `start.ts`, `help.ts`, `list.ts`, `status.ts`, `brief.ts`, `top.ts`, `why.ts`, `coverage.ts`, `health.ts`, `subscribe.ts`, `unsubscribe.ts`, `set.ts`, `settings.ts`, `mute.ts`, `pause.ts`, `timezone.ts`, `unmutehours.ts`, `unsnooze.ts`, `cancel.ts`, `presets.ts`, `forget.ts`, `export.ts`, `import.ts`, `sample.ts`, `single-target.ts` (shared helper for `/why` and `/coverage`)
- `worker/src/api/telegram-webhook-messages.ts` (message builders shared across handlers)
- `worker/src/api/telegram-webhook-insights.ts` (`/top`, `/why`, `/coverage` data-loading and rendering; `/why` and `/coverage` attach the status discovery keyboard in every chat, with Mini App buttons only in private chats)
- `worker/src/api/telegram-webhook-status.ts` (the `/status` data loader)
- `worker/src/api/telegram-webhook-resolution.ts` (the coin-resolution flow used by `action-runner`)

**Allowed inbound dependencies.** Ingress (via `COMMAND_HANDLERS`), Callback routing (which re-invokes some handlers via their build-message helpers and may call `action-runner` for the disambiguation reply path).

**Allowed outbound dependencies.** Command parsing, State / persistence, Outbound transport (for replies via `sendAuditedTelegramReply`), Common. Project shared lib (`@shared/lib/*`) is allowed for read-only domain data — stablecoin metadata, classification, supply, peg rates, report cards, chain aggregation.

**Must NOT.**
- Talk to the Telegram HTTP API directly. Send through `replyToChat` / `replyToChatWithMarkup` from `WebhookCommandContext`, or call `sendAuditedTelegramReply` for delayed/audited paths.
- Read from `cron_runs`, alert snapshots, or anything in the Dispatch lane. Use the same primary sources of truth the website uses (caches, `report_card_cache`, `stress_signals`, etc.).
- Introduce a per-handler "shared base class" or "command pipeline" abstraction. The dispatch table is the only shared shape; resist generalizing it.

---

## 5. Dispatch / fan-out

**Responsibility.** On the dedicated 5-minute cron slot, diff DEWS / depeg / safety / launch / reserve-drift snapshots into an immutable source event. Resolve dynamic preset pages, freeze the subscriber cohort at the event's detection time, and record one planning outcome per captured chat. Revalidate current direct/preset/global intent and tuning page by page, render bounded versioned plans, and materialize every exact target chunk plus item lineage before transport opens. Atomically hand targets to the pending queue; only after no target remains `planned` may the stored source baseline advance. Target-plan ownership, generation, cursor, immutable page bounds, bounded expiry debt, and final delivery truth are D1-authoritative. Alert context reads the published report-card snapshot cache instead of rebuilding the report-card corpus inside the five-minute lane. When a depeg closes and a new active event for the same coin appears in the same window, dispatch emits only the new detected event and annotates it with the just-ended recovery duration instead of also sending a resolved line for that coin.

The post-dispatch capacity/watchdog read model is fail-closed for incident recovery. It reports an explicit available/unknown read state, keeps recent `sending` work separate, promotes sends older than 15 minutes into execution-unknown risk, and samples fresh uncertain effects to a bounded 5,001-row lower bound. Unknown reads preserve existing incident keys. Zero-send streak evaluation is keyed to the authoritative `cron_runs.id`, so rerunning the watchdog against the same dispatch record is idempotent.

The five-minute lane keeps its DB-only operational sidecars independent of Telegram credentials. With a bot token it runs dispatch, watchdog, expired-disambiguation cleanup, and pulse publication serially, then checks all four command/profile/menu/webhook registration units in serial order and drains the alert-broker outbox. Without a token it records dispatch as skipped and registration/transport as an operational error, but still runs the watchdog, cleanup, pulse, and alert-broker drain. Per-unit registration telemetry distinguishes `skipped`, `succeeded`, and `failed` instead of treating a fresh cache/rate-limit skip as a successful Bot API mutation.

Admin recovery paths preserve the same effect and queue boundaries. Chat diagnostics contract v2 redacts payloads and returns only bounded pending/dead-letter/target history, including after the subscriber row has been deleted while retained operational history remains. Resend is an exact authoritative target-plan replay: dry-run is the default, live requests require an idempotency key and operator reason, accepted/execution-unknown effects are refused, and the exact stored payload is enqueued as `admin_replay` rather than sent inline. Broadcasts require a successful private-chat canary and a hard 15-minute reserve inside the 45-minute admin TTL before fleet rows may enter the pending queue.

**Bounded page ordering.** Target planning scans the frozen subscriber ledger in chat-id order and renders only the current bounded page. The versioned plan contract limits payload bytes, items, and chunks before any D1 materialization batch is built. Immutable first/last chat bounds, plan ordinals, expected counts, and payload digests make a partial page resumable without reformatting an already durable target or widening the cohort. Transport handoff is independently bounded and cursorable through target ordinals; the pending drain's send deadline therefore cannot make subscriber discovery or formatting lossy.

**Burst-summary collapse (C128).** `collapseBurstChats` runs between routing and the plan/format phase, so it executes *before* `formatConsolidatedMessage` and therefore also bounds CPU (its C102 dependency). For a chat matching `BURST_EVENT_THRESHOLD`+ distinct coins with global the dominant source (`globalCount > specificCount`, tracked per-entry in `AlertsByChatEntry`), it replaces the chat's `ConsolidatedAlerts` with a single `burst` summary covering only delta coins versus a per-chat marker (`cache["telegram:burst-markers"]`), removing the chat entirely when the delta is empty. Markers prune on read at `BURST_MARKER_TTL_SEC` (anchored to first entry), the shared marker cache row is deleted when no live markers remain, and `/forget` removes the chat's nested marker entry. The threshold ships effectively off; `burstCollapsedChats`/`burstDeltaSuppressed` surface in dispatch metadata.

**Reserve-drift producer/consumer seam (C123).** The reserve-drift family is the one event source whose state is *not* computed inside the dispatch trigger. `checkCollateralDrift` does live reserve-adapter network I/O (`loadFreshIndependentLiveReserveMap`), so calling it from the 5-minute dispatch trigger would consume the per-trigger 6-connection pool. Instead the four-hourly reserve slot (`worker/src/handlers/scheduled/hourly-live-reserves.ts`) persists a versioned source envelope (`generation`, `publishedAt`, `continuous`, `driftIds`) to `alert:reserve-snapshot` after its own `checkCollateralDrift` call, and dispatch only *diffs* an alertable set against its own baseline `alert:reserve-dispatched-snapshot`. Dispatch never opens a reserve-adapter connection. Coins that fall back to curated reserves are omitted from the producer set so a transient live-fetch failure cannot read as a drift change; the family fires entering-drift only. `worker/src/lib/alert-reserve-source-cache.ts` derives the freshness ceiling from two `sync-live-reserves` intervals (8 hours), rejects missing/corrupt/future/wrong-generation state, and marks the first publish after a continuity gap as `recovering`. That recovery publish cold-seeds the dispatch baseline; only the next continuous expected-generation publish can create reserve transitions.

**Owned files.**
- `worker/src/cron/dispatch-telegram-alerts.ts` (entrypoint and orchestration: circuit gate, source load, path selection, and the preset-failure hook wiring)
- `worker/src/cron/dispatch-telegram-source-lifecycle.ts` (fanout-free baseline seed plus recovery of an oldest incomplete source event: baseline-committed-before-manifest backfill and bounded source expiry)
- `worker/src/cron/dispatch-telegram-queue-paths.ts` (fanout-free queue lifecycle paths: circuit-open drain, the eventless fast path, and the source-recovery queue sidecar)
- `worker/src/cron/dispatch-telegram-authoritative-path.ts`, `dispatch-telegram-authoritative-planning.ts` (source-resolution, page-scoped routing, manifest handoff, baseline gate)
- `worker/src/cron/dispatch-telegram-alerts-fanout.ts` (parallel loading of subscriber inputs)
- `worker/src/cron/dispatch-telegram-fanout-plan.ts` (fan-out plan orchestration: routes all five alert families into per-chat bundles, runs the burst collapse, and builds the overflow-aware plan/format split; owns `buildTelegramFanoutPlan`)
- `worker/src/cron/dispatch-telegram-events.ts` (DEWS/depeg/safety/launch/reserve-drift snapshot diffing into dispatch events; suppressed-safety-at-seed counting)
- `worker/src/cron/dispatch-telegram-predicates.ts` (alertability/safety predicates: DEWS/depeg-step thresholds, escalation, per-subscriber safety inclusion)
- `worker/src/cron/dispatch-telegram-result.ts` (dispatch result assembly: per-alert-type targets, the `DispatchResult` shape, and the shared pending/safety/reserve result-field mappers used by every dispatch path)
- `worker/src/cron/dispatch-telegram-subscribers.ts` (subscriber/preset/global row loading, per-coin snooze map, subscriber-map merge)
- `worker/src/cron/dispatch-telegram-state.ts` (snapshot loading + assembly, the shared dispatch-state handoff to the five-minute lane, and the preset-failure counter)
- `worker/src/cron/dispatch-telegram-routing.ts` (event routing → per-chat alert bundles, cheap chunk estimation, newest-first pre-format selection, quiet-hours filter, chunk expansion)
- `worker/src/cron/dispatch-telegram-delivery.ts` (delivery orchestration: budget split, fresh send, retry/overflow enqueue, global backoff stamp)
- `worker/src/cron/dispatch-telegram-overflow.ts` (strict rolling-compatible parser and chat-pruning helpers for the retired overflow cache)
- `worker/src/cron/telegram-legacy-overflow-import.ts` (strict, cursorable import of the retired overflow cache into synthetic source/target/pending lineage)
- `worker/src/cron/telegram-alert-target-plans.ts`, `telegram-alert-target-plans/*`, `telegram-alert-target-plan-contract.ts` (planning ownership, frozen subscriber ledger, rendered plans/items/pages, bounded expiry, delivery-open and pending handoff)
- `worker/src/cron/telegram-alert-job-target-outcomes.ts` (exclusive final-state projection and job counter reconciliation)
- `worker/src/cron/dispatch-telegram-terminal-targets.ts` (`pruneAlreadyTerminalSubscribers`: drops already-terminal dedupe-key targets before fresh send)
- `worker/src/cron/telegram-alert-snapshots.ts`, `telegram-alert-changes.ts`, `telegram-alert-context.ts`, `telegram-alert-safety-reasons.ts`, `telegram-alert-jobs.ts`, `telegram-alert-target-status.ts`, `telegram-alert-target-effects.ts` (snapshot I/O, diff producers, alert context/reason builders, durable job manifests, per-target audit and fresh-effect fencing)
- `worker/src/cron/telegram-quiet-hours.ts` (quiet-hours predicate; shared with Callback routing for the `tz:*` validation only)
- `worker/src/cron/telegram-degradation-watchdog.ts` (post-dispatch one-shot operator alerts on degraded delivery; same five-minute lane)
- `worker/src/handlers/scheduled/five-minute-telegram.ts` (token-aware five-minute orchestration: dispatch when configured, token-independent watchdog/cleanup/pulse, all four serial registration checks, then alert-broker drain)
- `worker/src/cron/telegram-inactive-cleanup.ts`, `telegram-retention-cleanup.ts` (daily 03:00 UTC housekeeping jobs)
- `worker/src/api/admin-telegram-broadcast.ts`, `admin-telegram-resend.ts`, `admin-telegram-pending.ts`, `admin-telegram-chat.ts` (operator broadcast/replay/queue inputs plus redacted retained-history diagnostics; mutations share Dispatch queue/TTL semantics, not Ingress)

**Allowed inbound dependencies.** Worker scheduled-event router, Worker admin route entrypoints. Not Ingress, not Callback routing.

**Allowed outbound dependencies.** Queue / rate-limit / retry, Outbound transport, State / persistence (read-heavy: subscribers, subscriptions, preset subscriptions, snoozes, snapshots), Common. Project shared lib for domain data is allowed.

**Must NOT.**
- Format command replies. Alert message formatting lives in `telegram-alerts.ts` (Common) and is shared between Dispatch and admin-broadcast; do not duplicate.
- Inline subscriber-query SQL into the entrypoint. Add new fan-out paths in `dispatch-telegram-alerts-fanout.ts` or one of the existing helper modules.
- Duplicate admin-broadcast target selection SQL. Broadcast scopes call the Dispatch-owned `loadBroadcastTargetChatIds(db, scope)` helper so global/per-coin/preset watcher predicates evolve in one place.
- Import API action-handler modules for alert context. Dispatch-owned context and reason helpers live under `worker/src/cron/`.
- Open new connections beyond Cloudflare's 6-per-trigger pool. Consume response bodies (`drainResponseBody`) before opening more fetches.

---

## 6. Queue / rate-limit / retry

**Responsibility.** Own the `telegram_pending_alerts` row lifecycle: enqueue bounded provenance, claim, revalidate current effective preference eligibility, effect-state transition, drain, retry-with-backoff, preference cancellation, dead-letter, expire. `pending -> sending` records an effect owner/generation immediately before the Bot API call. Confirmed HTTP retry responses alone return that exact generation to `pending`; timeout/network ambiguity, owner loss, and expired `sending` claims become `execution_unknown` and are never auto-replayed. Confirmed success becomes `sent`. A confirmed `chat_migrated` response is terminally archived without replay before the shared group-to-supergroup migration helper moves durable chat state to Telegram's replacement ID. Pending terminal transitions project the same final delivery state into the authoritative alert-job target before cleanup, and a bounded repair pass closes post-commit/pre-cleanup gaps. Terminal target state also excludes legacy sent rows from candidate selection. Hold per-chat/global backoff and the blocked-subscriber lifecycle.

**Owned files.**
- `worker/src/cron/telegram-pending/index.ts` (compatibility barrel for existing imports)
- `worker/src/cron/telegram-pending/*` (enqueue, claim/drain, backoff, capacity, cleanup, dead-letter, dedupe, lifecycle helpers)
- `shared/lib/telegram-delivery-policy.ts` owns runtime-neutral queue, batch, TTL, rate-limit, deadline, and load-model policy. `worker/src/lib/telegram-constants.ts` re-exports the established Worker import surface.

**Allowed inbound dependencies.** Dispatch (the only legitimate enqueuer for alerts), Admin Telegram routes (`admin-telegram-broadcast.ts`, `admin-telegram-resend.ts`, `admin-telegram-pending.ts`), Callback routing only via `SNOOZE_REPLY_MARKUP` re-export (the `lib/telegram-alerts.ts` keyboard).

**Allowed outbound dependencies.** Outbound transport, State / persistence (cache helpers for global backoff), Common.

**Must NOT.**
- Be opened by Ingress directly. Ingress should never enqueue.
- Re-introduce delivery-policy constants outside `shared/lib/telegram-delivery-policy.ts`.
- Mutate `telegram_subscribers` alert flags except via the 2-strike block-disable path. Subscription state is owned by State / persistence helpers.
- Reset or overwrite a `sending`, `sent`, or `execution_unknown` row through dedupe re-enqueue. Only unclaimed/expired `pending` rows may refresh in place.
- Delete `execution_unknown` through ordinary TTL or disabled-chat cleanup. It remains operator-visible, then moves to idempotent dead-letter audit after the separate 90-day ambiguity-retention window.

---

## 7. State / persistence

**Responsibility.** Authoritative read/write helpers for Telegram D1 tables. Encodes the "upsert subscriber and subscriptions in one batch" pattern, the pending-disambiguation lifecycle (including the bulk-confirm payload, the setup-wizard state, and expired-row cleanup), the processed-update idempotency claim, the command-cooldown gate and best-effort cooldown release for transient/throwing handlers, group-to-supergroup chat-ID migration merges, and the chat-delivery diagnostics.

Per-coin and preset facts are independent. `telegram_subscriptions` owns direct/local per-coin preferences; `telegram_preset_subscriptions` owns dynamic source membership and never materializes its resolved coins into the direct table. Store intent inputs name direct coin IDs separately from preset IDs so command, callback, setup, import, and Mini App callers cannot conflate the two sources. Following or unfollowing a preset changes only its preset row; current preset membership is resolved from the stablecoin cache at dispatch.

Watchlist-token v2 preserves that boundary instead of exporting a flattened effective watchlist. The token stores packed direct/local rows and preset policies separately. Import stages an exact, initiator-owned replacement preview in `telegram_pending_disambiguation`; new chats create the subscriber row before the pending row in the same batch. Confirmation leases `preference_generation`, upserts retained rows without touching their per-coin snooze, removes only previewed rows, cleans expired snooze-only rows, restores the next generation, clears the exact pending preview, and commits the existing webhook mutation marker atomically. Generation mismatch consumes the stale preview and marker but performs no portable-preference writes, making webhook retry report the same terminal outcome rather than replaying replacement work.

Direct subscribe-style follows bump alert flags with `MAX(...)` and mark the matching selected families as local preferences, while settings-style overrides replace exactly one setting and mark its matching `alert_*_override` column. Every enabled direct row is authoritative over preset tuning. Dispatch treats a per-coin row as an explicit off only when both the alert flag is `0` and the marker is `1`, so default zeroes from partial or legacy writes do not suppress preset/global fan-out. Settings-style depeg writes share one rule: `depeg on` preserves an existing worsening step, `depeg off` clears it, and `depeg-step <bps>` enables depeg while setting that step. `/subscribe ... depeg-step off` is still a direct follow with depeg enabled and no worsening-step threshold.

The provenance correction required no D1 migration because these two tables and keys already represented the target model. Existing `telegram_subscriptions` rows may have been created either directly or by the former preset-materialization behavior, so rollout classifies every existing row conservatively as direct/local intent and deletes none. Rolling back to an older Worker can resume materialization, but the corrected Worker remains compatible with those rows and will again retain them as direct intent.

**Owned files.**
- `worker/src/api/telegram-webhook-store.ts` (compatibility barrel re-exporting `telegram-store/*`) and `worker/src/api/telegram-store/*` (the topic-specific SQL builders: `subscribers`, `subscriptions`, `disambiguation`, `snooze`, `presets`, `forget`, `processed-updates`). The import contract — per-coin/preset write SQL belongs in `telegram-webhook-store` — still holds via the barrel.
- `worker/src/lib/telegram-chat-member.ts` (cached chat-admin read policy; Bot API HTTP goes through Outbound transport)
- `worker/src/lib/telegram-usage-analytics.ts` (usage events, lifecycle snapshots, chat delivery diagnostics)
- `worker/src/lib/telegram-adoption-analytics.ts` (aggregate funnel writes, one-time milestones, bounded D7/D30 catch-up, weekly report)
- `worker/src/lib/telegram-webhook-registration.ts` (Bot API webhook/commands/profile/menu-button reconcile cadence and D1 cache markers; Bot API HTTP goes through Outbound transport)
- D1 schemas — owned by the migrations themselves (see [`telegram-alerts.md`](./telegram-alerts.md#d1-schema)):
  - `telegram_subscribers` — per-chat state and defaults
  - `telegram_subscriptions` — per-chat direct/local per-coin alert preferences and explicit-off markers
  - `telegram_preset_subscriptions` — independent persistent dynamic preset follows
  - `telegram_pending_disambiguation` — short-lived disambiguation, bulk-confirm, and setup-wizard state
  - `telegram_pending_alerts` — overflow + retry queue (owned by Queue, but the schema lives here)
  - `telegram_alert_jobs` / `telegram_alert_job_targets` — discovery + delivery audit (Dispatch)
  - `telegram_alert_source_events` / `telegram_alert_source_resolution_pages` — immutable event and resumable preset-resolution state (Dispatch)
  - `telegram_alert_source_resolution_memberships` / `telegram_alert_source_resolution_targets` — normalized preset membership/follower page lineage, revalidated against current intent before routing (Dispatch)
  - `telegram_alert_planning_subscribers` — detection-time subscriber cohort and durable per-chat planning outcomes (Dispatch)
  - `telegram_alert_target_plan_pages` / `telegram_alert_target_plans` / `telegram_alert_target_plan_items` — rendered manifest, immutable page bounds, target counts, and source-item lineage (Dispatch)
  - `telegram_alert_target_expiry_progress` — bounded source-expiry reconciliation debt (Dispatch)
  - `telegram_legacy_overflow_state` — strict one-time cache-import state and audit (Dispatch)
  - `telegram_alert_job_target_items` — normalized source-item coverage for consolidated target chunks (Dispatch)
  - `telegram_alert_dead_letters` — terminal failure audit (Queue)
  - `telegram_processed_updates` — webhook idempotency (Ingress)
  - `telegram_usage_daily` — privacy-preserving aggregates (Action handlers + Dispatch)
  - `telegram_adoption_daily` / `telegram_adoption_retention_daily` — identifier-free funnel and retention aggregates
  - `telegram_adoption_ingress_quota` — identifier-free global CTA-ingress ceiling
  - `telegram_adoption_client_quota` — dedicated-pepper HMAC-IP CTA-ingress ceiling
  - `telegram_watcher_lifecycle_daily` — daily lifecycle snapshots
  - `telegram_chat_delivery_diagnostics` — per-chat diagnostics (Outbound + Dispatch)
- KV: none currently. Cache keys live in D1 (`cache` table) — notably `alert:dews-snapshot`, `alert:dews-alertable-snapshot`, `alert:depeg-snapshot`, `alert:safety-snapshot`, `alert:launch-snapshot`, `alert:reserve-snapshot` (producer-written versioned reserve source envelope), `alert:reserve-dispatched-snapshot` (dispatch baseline), `alert:safety-source-cache`, `telegram:global-send-backoff-until`, chat-scoped `telegram:command-cooldown:<chat_id>:*`, `telegram:command-flood:<chat_id>*`, `telegram:chat-member:<chat_id>:<user_id>`, `telegram:chat-admins:<chat_id>`, `telegram:group-welcome:<chat_id>`, the 30-minute consumed-on-first-mutation `telegram:adoption-mini-app-session:<chat_id>` key, legacy `telegram:re-engagement-warned:<chat_id>` markers awaiting retention cleanup, `telegram:commands-reconciled`, `telegram:profile-reconciled`, `telegram:menu-reconciled`, `telegram:preset-query-failure-count`, `telegram:degradation:*`.

**Allowed inbound dependencies.** Every other seam may read/write through these helpers.

**Allowed outbound dependencies.** Cache helpers (`worker/src/lib/db-cache.ts`), `worker/src/lib/db.ts`, Outbound transport for the narrow chat-member and registration Bot API calls, Common.

**Must NOT.**
- Format messages or send user-visible Telegram messages.
- Take direct dependencies on Action handlers or Dispatch — keep the helpers callable from both lanes.
- Add an ORM, schema-builder, or "repository" abstraction.

---

## 8. Outbound transport

**Responsibility.** The single place that hits `https://api.telegram.org/bot<token>/…`. Owns HTTP timeouts, the `link_preview_options` shape, the response-body drain (required under the Cloudflare 6-connection cap), Bot API error classification, and the auditing wrapper that updates per-chat reply diagnostics.

**Owned files.**
- `worker/src/lib/telegram.ts` (`postTelegramBotApi`, `sendToChat`, `sendBatch`, `postTelegramMessage`, `answerCallbackQuery`, `editMessage`, `escapeHtml`, link-preview helpers, send-error classification)
- `worker/src/api/telegram-webhook-replies.ts` (`sendAuditedTelegramReply` — chunks + diagnostics + replyMarkup)
- `worker/src/lib/telegram-log.ts` (structured Telegram event logger)

**Allowed inbound dependencies.** Action handlers, Callback routing, Ingress (for replies), Dispatch (alert sends), Queue (drains), admin routes, daily digest, registration reconciliation, chat-admin membership probes.

**Allowed outbound dependencies.** Native `fetch`, Common.

**Must NOT.**
- Know about subscribers, snapshots, or commands. Send what you are given.
- Inline HTML formatting beyond `escapeHtml`. Body composition lives in `telegram-alerts.ts` or per-handler builders.

---

## 9. Mini App surface

**Responsibility.** Serve the Telegram Mini App UI and its two signed `initData` API calls. Load private-user state, expose read-only group/stale-auth state, apply private-user mutations, and return a versioned mutable-state snapshot that the frontend hydrates with its bundled catalog. Telegram direct-link launches can report the private user context as `chat_type="sender"`. This seam is intentionally narrow: it does not receive Telegram webhook updates and it does not call the Telegram Bot API.

**Owned files.**
- `src/app/pharoswatchbot/app/page.tsx`
- `src/app/pharoswatchbot/app/client.tsx`
- `src/app/pharoswatchbot/app/components/*`
- `src/app/pharoswatchbot/app/constants.ts`
- `src/app/pharoswatchbot/app/error-messages.ts`
- `src/app/pharoswatchbot/app/format.ts`
- `src/app/pharoswatchbot/app/mini-app-api.ts`
- `src/app/pharoswatchbot/app/telegram-sdk.ts`
- `src/app/pharoswatchbot/app/types.ts`
- `src/app/pharoswatchbot/app/use-mini-app-mutations.ts`
- `src/app/pharoswatchbot/app/use-telegram-bridge.ts`
- `src/app/pharoswatchbot/app/use-telegram-main-button.ts`
- `worker/src/api/telegram-mini-app.ts`
- `worker/src/api/telegram-mini-app-state.ts`
- `worker/src/api/telegram-mini-app-mutations.ts`
- `worker/src/lib/telegram-mini-app-auth.ts`
- `shared/lib/telegram-mini-app-contract.ts`
- `shared/lib/telegram-mini-app-catalog.ts`
- `shared/lib/telegram-presets.ts`
- `shared/data/stablecoins/coins.telegram-mini-app.generated.json`

**Allowed inbound dependencies.** The Next.js route `/pharoswatchbot/app/`, Worker route registry entries for `POST /api/telegram-mini-app/session` and `POST /api/telegram-mini-app/mutate`, and private-chat Web App buttons generated by Action handlers / Callback routing.

**Allowed outbound dependencies.** State / persistence helpers for subscription writes and cooldowns, Worker preset resolution for dynamic targets, `telegram-usage-analytics` for validated usage events, the shared Mini App contract/catalog and preset definitions, shared endpoint metadata, shared stablecoin metadata, and the Telegram WebApp browser bridge on the frontend.

**Must NOT.**
- Accept mutation auth older than the 5-minute mutation window.
- Mutate group/supergroup/channel chat rows until a fresh admin verification path and group-scoped launch ownership model exist.
- Write analytics, aggregate counters, or cooldown rows before signed `initData` validation succeeds. Body-too-large, malformed JSON, and schema-denied Mini App requests must return without D1 writes because the endpoints are public API-key-exempt surfaces.
- Apply or replay a mutation when the advertised contract/catalog version does not match. Version mismatch must stay a pre-write `409`; the client may refresh its static bundle once but must require a new user action for the mutation.
- Duplicate per-coin or preset write SQL outside the existing State / persistence helpers.
- Use `Telegram.WebApp.sendData` without updating `allowed_updates` and treating incoming `web_app_data` as untrusted.

---

## Common modules

Files any seam may import:

- `worker/src/lib/telegram-constants.ts` — central magic numbers and tokens (`SNOOZE_SECONDS`, `DEPEG_STEP_VALUES`, `TOP_VIEW_NAMES`, `TELEGRAM_MESSAGE_CHUNK_LIMIT`, ingress flood limits, group welcome/admin cooldown TTLs, all queue tuning, disambiguation TTL).
- `worker/src/lib/telegram-alerts.ts` — compatibility barrel for alert parsing and formatting exports.
- `worker/src/lib/telegram-alerts-parser.ts` — ticker resolution, subscribe/set argument parsing, disambiguation parsing, and close-match suggestions.
- `worker/src/lib/telegram-alerts-formatting.ts` — alert message formatting, `splitMessage`, and `SNOOZE_REPLY_MARKUP`.
- `worker/src/lib/telegram-format-age.ts` — compact relative-age labels shared by command and status surfaces.
- `worker/src/lib/telegram-coin-dedupe.ts` — shared stablecoin de-duplication helpers for alert and command coin lists.
- `worker/src/lib/telegram-presets.ts` — preset definitions and resolution.
- `worker/src/lib/telegram-digest-appendices.ts` — channel digest appendices (cemetery, newly tracked).
- `worker/src/lib/telegram-log.ts` — structured logging.
- `worker/src/lib/telegram-pending-provenance.ts` — bounded target-group scope and markup-policy serialization/parsing shared by Dispatch and Queue.

---

## What changed in the recent refactors

Three commits decomposed Telegram code in 30 days. Knowing which seam each touched helps a future maintainer pick up where the structure is "current".

- **2026-04-17 — `feat(telegram): callback_query router + snooze buttons backend` (cb202d93b)** — created the **Callback routing** seam. Split `handleCallbackQuery` into its own file (`telegram-webhook-callbacks.ts`), added the `action:arg` parser, and added the first action (`snooze:1h|4h|24h`). Same-day follow-up `refactor(telegram): simplify pass after audit remediation` (6cd53dd0e) collapsed `upsertSubscriberRow + UPDATE` into one `INSERT ... ON CONFLICT` and parallelized `/status` D1 reads.

- **2026-05-11 — `P1-M1: decompose telegram-webhook.ts dispatch into per-command modules` (58695ef1e)** — created the **Action handlers** seam. Cut `telegram-webhook.ts` from ~1,221 to ~428 code lines (1,363 to 499 total), moved each `/command` into `worker/src/api/webhook-commands/<command>.ts`, replaced two parallel switch statements (the pending-active branch and the fresh-command branch) with one `COMMAND_HANDLERS` table plus explicit pending passthrough/clear sets. Extracted the shared subscribe/unsubscribe/set machinery into `webhook-commands/action-runner.ts`. Behavior and exports unchanged.

- **2026-05-14 — `refactor(telegram): extract callback and queue helpers` (d6f4fec8e)** — split **Dispatch / fan-out** further (`dispatch-telegram-alerts-fanout.ts`), restructured `telegram-webhook-callbacks.ts` for explicit per-action handlers, and grew `worker/src/cron/telegram-pending/index.ts` to absorb claim-based draining. This commit was the immediate motivation for this doc.

- **2026-05-14 — PharosWatchBot audit closeout** — the P0/P1/P2 remediation pass and implemented P3 closeout became the current frozen baseline: callback write paths were aligned with store/settings helpers, `loadPendingDisambiguation()` replaced duplicate SELECTs, `telegram-alerts.ts` became a parser/formatter compatibility barrel, registration/chat-member Bot API calls were centralized through outbound transport, `why_`/`coverage_` Mini App payloads gained in-app views, read-only command handler tests were added, and `telegram-pending/index.ts` became a compatibility barrel over `worker/src/cron/telegram-pending/*`.

Several `harden` and `fix` commits between those reshaped behavior inside the seams (group-admin hard gate, per-coin snooze, dedupe-key stability, two-strike block rule, claim-based pending drain). Behavioral changes inside an existing seam are not seam changes — they should not move files.

---

## Historical freeze period

The 30-day Telegram internal-reorganization freeze ran until **2026-06-13** (30 days from 2026-05-14). As of 2026-06-18, it is historical context, not an active blanket freeze.

The implemented PharosWatchBot audit closeout on 2026-05-14 remains the structural baseline. Do not use those already-landed refactors as precedent for casual file moves, helper extraction, or seam changes. Future structural Telegram changes should update this doc first, then move code in a separate, clearly motivated change.

Still acceptable without reopening the seam model:
- Bug fixes that change behavior.
- New commands or callbacks (add a handler file in `webhook-commands/`, add to `CALLBACK_ACTIONS`, etc.).
- New tests, new docs.
- Adding fields to existing helpers or types.
- Behavioral hardening (rate limits, retry rules, threshold tuning, idempotency improvements) inside an existing seam.

Treat these as doc-first structural changes, unless a real bug forces them and the fix narrative is in the commit message:
- "Extract helpers" / "split file" / "rename module" / "move type" refactors.
- New seams, new top-level Telegram directories, new layered abstractions.
- Reorganizing the `COMMAND_HANDLERS` table or the `CALLBACK_ACTIONS` allowlist for stylistic reasons.
- Generalizing per-command handlers behind a new "pipeline" or "framework".

If you think the current layout is wrong, do not refactor in place — propose the rename / split in a PR that updates this doc *first*, then move code in a second PR.

---

## Tell-tale signs the seams are wrong

If two or more of these happen, re-evaluate the seams (revise this doc, then refactor — not the other way around):

1. **Two consecutive "extract helper" commits to Telegram code in 7 days** — the seams aren't holding; whatever was extracted is still entangled.
2. **A bug fix touches more than 2 seams** — a single change rippling through Ingress + Action handlers + State means the boundary between them is wrong, not the code inside them.
3. **A callback handler imports from 4+ seams** — the callback layer already sits at the edge: the per-action files in `webhook-callbacks/` reach into Action handlers' builders, State helpers (via store/settings-mutations), Common, and the setup state machine; if a new callback needs a 5th, the callback layer is doing too much.
4. **A new constant gets defined outside `telegram-constants.ts`** within the Telegram subsystem — the centralization (P1-M2) is decaying.
5. **The same SQL appears in two seams** — most likely State / persistence is missing a helper.
6. **Ingress grows past ~600 lines again** — the dispatcher loop is doing more than routing. Push behavior into Action handlers or State.

---

## Architectural tension flagged but not prescribed

- **`worker/src/lib/telegram-alerts.ts` remains the stable import path for Common alert helpers, but implementation now lives in parser and formatter modules.** Keep the barrel so existing imports stay stable; do not create additional Common submodules without a doc-first seam update or a bug-driven reason.

- **Callback routing now routes mutating callback writes through `telegram-webhook-store.ts` or `telegram-webhook-settings-mutations.ts`.** New mutating callbacks should continue using those persistence helpers rather than adding inline SQL back into `telegram-webhook-callbacks.ts`.

- **Setup wizard state lives in `telegram_pending_disambiguation` with `action_type = "setup-step"`.** Sharing the TTL and cleanup cron with disambiguation was deliberate, but Ingress now branches on `isSetupPending` before any other pending-state logic — that branch will keep growing if more wizards arrive. Watch for a third pending-action-type before deciding whether wizards need their own row type.

- **`admin-telegram-broadcast.ts` writes to `telegram_pending_alerts` directly with its own priority and TTL.** Filed under Dispatch in this doc, but it has Ingress-shaped concerns (it is an HTTP entrypoint). Its watcher targeting is delegated to Dispatch and its message body is preflighted against the supported Telegram HTML subset before target selection. If a second admin write path appears, consider splitting "admin write surface" into its own seam.
