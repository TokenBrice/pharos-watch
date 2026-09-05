# Telegram Architecture Seams

Status: current structural ownership baseline.

This is the load-bearing structural doc for PharosWatchBot's worker-side code. It names each seam, declares ownership and allowed dependencies, and lists the symptoms that should trigger a re-evaluation. It also owns ingress, bindings, and D1 schema. For bot commands, alert behavior, dispatch, delivery persistence, and runbooks, see [`telegram-alerts.md`](./telegram-alerts.md).

This document makes the subsystem boundaries explicit. Future changes either stay inside a named seam or revise the ownership and dependency rules here.

> **Agent navigation** — Architecture seams: [overview](#seam-overview) · [ingress](#1-ingress) · [command parsing](#2-command-parsing) · [callback routing](#3-callback-routing) · [action handlers](#4-action-handlers) · [dispatch/fan-out](#5-dispatch-fan-out) · [queue/retry](#6-queue-rate-limit-retry) · [state/persistence](#7-state-persistence) · [outbound transport](#8-outbound-transport) · [Mini App seam](#9-mini-app-surface) · [D1 schema](#d1-schema) · [secrets/bindings](#secrets-and-bindings). Bot behavior: [commands](./telegram-alerts.md#commands) · [dispatch](./telegram-alerts.md#dispatch) · [delivery persistence](./telegram-alerts.md#delivery-persistence). Client/auth/state: [Mini App overview](./telegram-mini-app.md#overview) · [client state](./telegram-mini-app.md#client-state-and-control-semantics) · [auth](./telegram-mini-app.md#auth-model) · [launch entrypoints](./telegram-mini-app.md#mini-app-launch-entrypoints) · [public pulse](./telegram-mini-app.md#public-pulse-privacy-and-freshness).

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

"Outbound transport" has its own seam because both Ingress (replies to commands) and Dispatch (alert fan-out) send through it; collapsing it into either side would force the other to reach across. **Command parsing** is kept distinct from **Action handlers** because the parser is reused by callbacks (disambiguation reply path) and `/start` deep-link payloads.

---

## 1. Ingress

**Responsibility.** Receive `POST /api/telegram-webhook` requests. Validate the shared secret (with rotation overlap). Owner/generation-claim the `update_id`, persist a versioned normalized operation intent, atomically prove replay-safe local mutation, and cross the effect fence only immediately before an irreversible Bot API call. Stale unstarted/planned claims are reclaimable; planned takeover resumes stored normalized parameters instead of mutable pending/setup rows. Once effect-start is durable, duplicates are acknowledged without replay and uncertain rows are exposed for operator reconciliation. Hold the dedupe, pending-disambiguation gate, ingress flood cap, group-admin gate, per-command cooldown, and bounded read-only inline-query routing.

**Owned files.**
- `worker/src/api/telegram-webhook.ts` (entrypoint: secret validation, claim/fence bootstrap, and per-update-type routing)
- `worker/src/api/telegram-webhook-auth.ts` (secret validation, group-admin gating)
- `worker/src/api/telegram-webhook-update-normalization.ts` (pure update-shape helpers: update-type/chat-id resolution and group-to-supergroup migration extraction; no D1, no Bot API)
- `worker/src/api/telegram-webhook-effect-fence.ts` (the `update_id` claim bootstrap — duplicate/in-flight answering — plus the request-scoped operation-intent effect fence crossed before irreversible Bot API calls)
- `worker/src/api/telegram-webhook-update-dispatch.ts` (intent dispatch: routes claimed callback taps and message commands through the ingress policy gates and the pending gate into `COMMAND_HANDLERS` / the callback router)
- `worker/src/api/telegram-webhook-ingress-policy.ts` (ingress flood cap, per-command cooldown, group-admin gate, channel-mutation refusal predicates, and command-usage attribution)
- `worker/src/api/telegram-webhook-pending-gate.ts` (the pending-disambiguation / setup-step gate decisions run before dispatch: `handleSetupPendingBeforeDispatch`, `handlePendingActionBeforeDispatch`, and the disambiguation-reply helpers)
- `worker/src/api/telegram-webhook-group-welcome.ts` (the group lifecycle sub-seam: `handleMyChatMember` plus the bot-added/-removed transition checks, welcome message/markup builders, and the local `TelegramChatMemberUpdated` shape)
- `worker/src/api/telegram-inline-queries.ts` (exact tracked ticker/id resolution, one cacheable `/status` article, and identifier-free aggregate inline telemetry)
- `worker/src/api/telegram-webhook-shared.ts` (types/constants used by both Ingress and Action handlers — see note below)

**Allowed inbound dependencies.** `worker/src/index.ts` request router (this is an HTTP entrypoint).

**Allowed outbound dependencies.** Command parsing, Callback routing, Action handlers (via `COMMAND_HANDLERS`), State / persistence (for the processed-update claim, the pending-disambiguation read, the cooldown gate), Outbound transport (for reply helpers), Common.

**Must NOT.**
- Format alert messages — that is Action handlers / Common (`telegram/alerts.ts`).
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
- `worker/src/lib/telegram/alerts.ts` — parts: `parseSubscribeArgs`, `validateSubscribeArgs`, `resolveTicker`, `parseDisambiguationReply`, `suggestClosestToken`, the formatting helpers, and the `splitMessage` chunker. (This file straddles parsing and formatting; see "Architectural tension" below.)
- `worker/src/lib/telegram/presets.ts` — preset alias resolution (`resolveTelegramPresetAlias`) is part of parsing; `resolveTelegramPresetTargets` (which reads the cache) is consumed by Action handlers and Dispatch.

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
  - One file per command: `start.ts`, `help.ts`, `list.ts`, `status.ts`, `brief.ts`, `top.ts`, `why.ts`, `coverage.ts`, `health.ts`, `subscribe.ts`, `unsubscribe.ts`, `set.ts`, `settings.ts`, `mute.ts`, `pause.ts`, `recap.ts`, `timezone.ts`, `unmutehours.ts`, `unsnooze.ts`, `cancel.ts`, `presets.ts`, `forget.ts`, `export.ts`, `import.ts`, `sample.ts`, `single-target.ts` (shared helper for `/why` and `/coverage`)
- `worker/src/api/telegram-webhook-disambiguation-selection.ts` — executes pending disambiguation selections from callback replies through the shared action runner
- `worker/src/api/telegram-webhook-messages.ts` (message builders shared across handlers)
- `worker/src/api/telegram-webhook-insights.ts` (`/top`, `/why`, `/coverage` data-loading and rendering; `/why` and `/coverage` attach the status discovery keyboard in every chat, with Mini App buttons only in private chats)
- `worker/src/api/telegram-webhook-status.ts` (the `/status` data loader)
- `worker/src/api/telegram-webhook-resolution.ts` (the coin-resolution flow used by `action-runner`)

**Allowed inbound dependencies.** Ingress (via `COMMAND_HANDLERS`), Callback routing (which re-invokes some handlers via their build-message helpers and may call `action-runner` for the disambiguation reply path).

**Allowed outbound dependencies.** Command parsing, State / persistence, Outbound transport (for replies via `sendAuditedTelegramReply`), Common. Project shared lib (`@shared/lib/*`) is allowed for read-only domain data — stablecoin metadata, classification, supply, peg rates, report cards, chain aggregation.

**Must NOT.**
- Talk to the Telegram HTTP API directly. Send through `replyToChat` / `replyToChatWithMarkup` from `WebhookCommandContext`, or call `sendAuditedTelegramReply` for delayed/audited paths.
- Read from `cron_runs`, alert snapshots, or anything in the Dispatch lane. Use the same primary sources of truth the website uses (caches, the canonical V9 publication, `stress_signals`, etc.).
- Introduce a per-handler "shared base class" or "command pipeline" abstraction. The dispatch table is the only shared shape; resist generalizing it.

---

## 5. Dispatch / fan-out

**Responsibility.** On the dedicated 5-minute cron slot, diff DEWS / depeg / safety / launch / reserve-drift snapshots into an immutable source event. Resolve dynamic preset pages, freeze a source-specific candidate cohort at the event's detection time, and record one planning outcome per captured chat. Candidate capture unions relevant direct subscriptions, resolved preset targets, and matching global-family flags rather than scanning every subscriber; alert families absent from the source skip their fan-out loaders. Revalidate current direct/preset/global intent and tuning page by page, render bounded versioned plans, and materialize every exact target chunk plus item lineage before transport opens. Atomically hand bounded target pages to the pending queue with set-based suppression/enqueue/state transitions; only after no target remains `planned` may the stored source baseline advance. Target-plan ownership, generation, cursor, immutable page bounds, bounded expiry debt, and final delivery truth are D1-authoritative. Alert context reads the published report-card snapshot cache instead of rebuilding the report-card corpus inside the five-minute lane. When a depeg closes and a new active event for the same coin appears in the same window, dispatch emits neither a resolved line nor a newly detected line for that coin: the snapshot diff is keyed by `stablecoin_id` alone, so the coin reads as continuously active across the window and only a later worsening-step crossing can alert.

The post-dispatch capacity/watchdog read model is fail-closed for incident recovery. It reports an explicit available/unknown read state, keeps recent `sending` work separate, promotes sends older than 15 minutes into execution-unknown risk, and samples fresh uncertain effects to a bounded 5,001-row lower bound. Unknown reads preserve existing incident keys. Zero-send streak evaluation is keyed to the authoritative `cron_runs.id`, so rerunning the watchdog against the same dispatch record is idempotent.

The five-minute lane keeps its DB-only operational sidecars independent of Telegram credentials. With a bot token it runs dispatch, the DB-only personalized recap planner, watchdog, expired-disambiguation cleanup, and pulse publication serially, then checks all four command/profile/menu/webhook registration units in serial order. A tokened recap defers when dispatch was locked, incomplete, or failed; otherwise its soft deadline is capped by the remaining five-minute slot after dispatch plus a 30-second reserve. Without a token it records dispatch as skipped and registration as an operational error, and records recap planning as skipped only in the token-requiring `canary`/`public` modes; `off`/`dark` still run the DB-only planner alongside the watchdog, cleanup, and pulse work. Per-unit registration telemetry distinguishes `skipped`, `succeeded`, and `failed` instead of treating a fresh cache/rate-limit skip as a successful Bot API mutation.

The whole five-minute lane (dispatch, recap, watchdog, cleanup, pulse, and the webhook/preset/parser helpers it shares with the API) reads stablecoin identity only from `shared/lib/stablecoins/worker-runtime-registry.ts` (`id`, `symbol`, `name`, `pegCurrency`, `status`), never from the full `shared/lib/stablecoins/registry.ts`. The full registry inlines the 15.8 MB `coins.generated.json` into the lane's dynamic-import graph; Cloudflare invocation analytics for 2026-08-26 to 2026-09-02 attributed every five-minute-lane abandonment to `exceededMemory` (no exceededCpu outcomes), concentrated on the `:27`/`:57` runs that carry safety fan-out after V9 publication, and each kill left the in-flight `sending` rows as never-retried, effect-unconfirmed `execution_unknown` (317 `pending_effect_owner_lost` rows since 2026-07-29). `npm run check:mint-burn-runtime-imports` bundles `five-minute-telegram.ts` and fails if the full registry re-enters. The registry removal alone did not stop the kills: `telegram-alert-context.ts` still decoded the full V9 publication for the alert `Context:` line, so the lane also reads safety grade, score, and publication identity only from the thin `alert-safety-v9-source` envelope (`loadActiveAlertSafetySourceAssessment`), never through `loadActiveSafetyScoreSource`. See ADR-24 in `architecture.md`.

Admin recovery paths preserve the same effect and queue boundaries. Broadcast is the only surviving one: it requires a successful private-chat canary and a hard 15-minute reserve inside the 45-minute admin TTL before fleet rows may enter the pending queue. The redacted chat-diagnostics view and the exact authoritative target-plan replay were retired with their routes on 2026-08-09; the pending, dead-letter, and target history they read is unchanged and is now inspected directly in D1 (see [`runbooks/telegram-operator-queries.md`](./runbooks/telegram-operator-queries.md)).

**Bounded page ordering.** Target planning scans the frozen candidate ledger in chat-id order and renders only the current bounded page. Capture and planning reuse one invocation-local fan-out page only when the captured preference generations still match current state; preference churn invalidates the page before routing. The versioned plan contract limits payload bytes, items, and chunks before any D1 materialization batch is built. Immutable first/last chat bounds, plan ordinals, expected counts, and payload digests make a partial page resumable without reformatting an already durable target or widening the cohort. Transport handoff is independently bounded and cursorable through target ordinals; a handoff page uses set-based D1 operations after strict payload validation, and the pending drain's send deadline therefore cannot make subscriber discovery or formatting lossy.

**Burst-summary collapse (C128).** `collapseBurstChats` runs between routing and the plan/format phase, so it executes *before* `formatConsolidatedMessage` and therefore also bounds CPU (its C102 dependency). For a chat matching `BURST_EVENT_THRESHOLD`+ distinct coins with global the dominant source (`globalCount > specificCount`, tracked per-entry in `AlertsByChatEntry`), it replaces the chat's `ConsolidatedAlerts` with a single `burst` summary covering only delta coins versus a per-chat marker (`cache["telegram:burst-markers"]`), removing the chat entirely when the delta is empty. Markers prune on read at `BURST_MARKER_TTL_SEC` (anchored to first entry), the shared marker cache row is deleted when no live markers remain, and `/forget` removes the chat's nested marker entry. The threshold ships effectively off; `burstCollapsedChats`/`burstDeltaSuppressed` surface in dispatch metadata.

**Reserve-drift producer/consumer seam (C123).** The reserve-drift family is the one event source whose state is *not* computed inside the dispatch trigger. `checkCollateralDrift` does live reserve-adapter network I/O (`loadFreshIndependentLiveReserveMap`), so calling it from the 5-minute dispatch trigger would consume the repo's six-request trigger budget. Instead the four-hourly reserve slot (`worker/src/handlers/scheduled/hourly-live-reserves.ts`) persists a versioned source envelope (`generation`, `publishedAt`, `continuous`, `driftIds`) to `alert:reserve-snapshot` after its own `checkCollateralDrift` call, and dispatch only *diffs* an alertable set against its own baseline `alert:reserve-dispatched-snapshot`. Dispatch never opens a reserve-adapter connection. Coins that fall back to curated reserves are omitted from the producer set so a transient live-fetch failure cannot read as a drift change; the family fires entering-drift only. `worker/src/lib/alert-reserve-source-cache.ts` derives the freshness ceiling from two `sync-live-reserves` intervals (8 hours), rejects missing/corrupt/future/wrong-generation state, and marks the first publish after a continuity gap as `recovering`. That recovery publish cold-seeds the dispatch baseline; only the next continuous expected-generation publish can create reserve transitions.

**Freeze-event producer/consumer seam.** Freeze is the sixth public family but does not enter the legacy five-family target-plan table. The dedicated outbox reads immutable `freeze.*` Tape rows only while `project-tape` is fresh, owns `cache["alert:freeze-tape-cursor"]`, and cold-seeds without history. Each event transactionally captures and closes one direct/global cohort in `telegram_freeze_alert_targets`, then creates the canonical generic source/job/job-target/item lineage and atomically hands chunks to `telegram_pending_alerts`. Resumes page only the frozen targets and retain the original two-hour expiry; the general snapshot baseline never reads or writes the freeze cursor.

**Personalized recap seam.** `telegram-recap-planner.ts` is a separate DB-only Dispatch module, not a sixth alert-family fan-out. Its rollout contract is runtime-neutral in `shared/lib/telegram-recap-rollout.ts`: unset/malformed config is `off`; `dark` computes aggregate D1-only projections without target/pending/schedule writes; `canary` uses exact CSV chat-ID membership for planning, delivery, and controls; `public` enables all eligible private chats. The off path atomically cancels only queued `personalized_recap` work. The planner claims due rows from `telegram_recap_preferences`, reads one capped `tape_events` window per page, resolves direct/preset/global scope, and in delivery modes writes one immutable `telegram_recap_targets` row plus one exact `telegram_pending_alerts` row for each material recipient. Its delivery/formatting bounds remain in `shared/lib/telegram-recap-policy.ts`; local-time and DST behavior is in `shared/lib/iana-local-time.ts`. It must not import digest AI/platform clients, open external provider connections, query Tape once per recipient, or materialize preset members into direct subscriptions. The queue owns the external send and terminal projection, so a recap target cannot bypass risk-priority ordering or preference-generation revalidation.

**Owned files.**
- `worker/src/cron/dispatch-telegram-alerts.ts` (entrypoint and orchestration: circuit gate, source load, path selection, and the preset-failure hook wiring)
- `worker/src/cron/dispatch-telegram-source-lifecycle.ts` (fanout-free baseline seed plus recovery of an oldest incomplete source event: baseline-committed-before-manifest backfill and bounded source expiry)
- `worker/src/cron/dispatch-telegram-queue-paths.ts` (fanout-free queue lifecycle paths: circuit-open drain, the eventless fast path, and the source-recovery queue sidecar)
- `worker/src/cron/dispatch-telegram-authoritative-path.ts`, `dispatch-telegram-authoritative-planning.ts` (source-resolution, page-scoped routing, manifest handoff, baseline gate)
- `worker/src/cron/dispatch-telegram-alerts-fanout.ts` (parallel loading of subscriber inputs)
- `worker/src/cron/dispatch-telegram-fanout-plan.ts` (fan-out plan orchestration: routes all five alert families into per-chat bundles, runs the burst collapse, and builds the overflow-aware plan/format split; owns `buildTelegramFanoutPlan`)
- `worker/src/cron/dispatch-telegram-events.ts` (DEWS/depeg/safety/launch/reserve-drift snapshot diffing into dispatch events; suppressed-safety-at-seed counting)
- `worker/src/cron/telegram-alert-freeze.ts`, `telegram-freeze-outbox.ts` (fresh immutable Tape loading, dedicated freeze cohort/outbox, and canonical pending lineage handoff)
- `worker/src/cron/telegram-recap-planner.ts` and `worker/src/lib/telegram/recap-store.ts` (private daily recap due-page planning and recap preference/target persistence; the store is shared with the Mini App seam)
- `worker/src/lib/telegram/recap-facts.ts`, `worker/src/lib/telegram/recap-ranking.ts`, `worker/src/lib/telegram/recap-formatting.ts` (allowlisted Tape parsing, deterministic collapse/rank, one-message HTML formatter)
- `worker/src/cron/dispatch-telegram-predicates.ts` (alertability/safety predicates: DEWS/depeg-step thresholds, escalation, per-subscriber safety inclusion)
- `worker/src/cron/dispatch-telegram-result.ts` (dispatch result assembly: per-alert-type targets, the `DispatchResult` shape, and the shared pending/safety/reserve result-field mappers used by every dispatch path)
- `worker/src/cron/dispatch-telegram-subscribers.ts` (subscriber/preset/global row loading, per-coin snooze map, subscriber-map merge)
- `worker/src/cron/dispatch-telegram-state.ts` (snapshot loading + assembly, the shared dispatch-state handoff to the five-minute lane, and the preset-failure counter)
- `worker/src/cron/dispatch-telegram-routing.ts` (event routing → per-chat alert bundles, cheap chunk estimation, newest-first pre-format selection, quiet-hours filter, chunk expansion)
- `worker/src/cron/dispatch-telegram-overflow.ts` (overflow-aware subscriber queue construction and the forget-path chat-pruning re-export for the retired overflow cache)
- `worker/src/cron/telegram-alert-target-plans.ts`, `telegram-alert-target-plans/*`, `telegram-alert-target-plan-contract.ts` (planning ownership, frozen subscriber ledger, rendered plans/items/pages, bounded expiry, delivery-open and pending handoff)
- `worker/src/cron/telegram-alert-job-target-outcomes.ts` (exclusive final-state projection and job counter reconciliation)
- `worker/src/cron/telegram-alert-snapshots.ts`, `telegram-alert-changes.ts`, `telegram-alert-context.ts`, `telegram-alert-safety-reasons.ts`, `telegram-alert-target-status.ts` (snapshot I/O, diff producers, alert context/reason builders, and per-target status helpers)
- `worker/src/cron/telegram-alert-source-events.ts`, `telegram-alert-event-lineage.ts`, `dispatch-telegram-pending-lifecycle.ts` (source-event and preset-subscriber page loading, per-item key listing and handled-item pruning, and the shared pending-queue lifecycle step invoked by the authoritative and queue paths)
- `worker/src/lib/telegram/quiet-hours.ts` (quiet-hours predicate; shared with Callback routing for the `tz:*` validation only)
- `worker/src/cron/telegram-degradation-watchdog.ts` (post-dispatch one-shot operator alerts on degraded delivery; same five-minute lane)
- `worker/src/handlers/scheduled/five-minute-telegram.ts` (token-aware five-minute orchestration: dispatch when configured, token-independent watchdog/cleanup/pulse, then all four serial registration checks)
- `worker/src/cron/telegram-inactive-cleanup.ts`, `telegram-retention-cleanup.ts` (daily 03:00 UTC housekeeping jobs)
- `worker/src/api/admin-telegram-broadcast.ts` (operator broadcast input; its mutations share Dispatch queue/TTL semantics, not Ingress). The sibling `admin-telegram-resend.ts`, `admin-telegram-pending.ts`, `admin-telegram-chat.ts`, and `admin-telegram-delivery-control.ts` routes were retired on 2026-08-09; the queue, per-chat, and pause state they exposed is still owned by the modules below and is now read or repaired directly in D1.

**Allowed inbound dependencies.** Worker scheduled-event router, Worker admin route entrypoints. Not Ingress, not Callback routing.

**Allowed outbound dependencies.** Queue / rate-limit / retry, Outbound transport, State / persistence (read-heavy: subscribers, subscriptions, preset subscriptions, snoozes, snapshots), Common. Project shared lib for domain data is allowed.

**Must NOT.**
- Format command replies. Alert message formatting lives in `telegram/alerts.ts` (Common) and is shared between Dispatch and admin-broadcast; do not duplicate.
- Inline subscriber-query SQL into the entrypoint. Add new fan-out paths in `dispatch-telegram-alerts-fanout.ts` or one of the existing helper modules.
- Duplicate admin-broadcast target selection SQL. Broadcast scopes call the Dispatch-owned `loadBroadcastTargetChatIds(db, scope)` helper so global/per-coin/preset watcher predicates evolve in one place.
- Import API action-handler modules for alert context. Dispatch-owned context and reason helpers live under `worker/src/cron/`.
- Exceed the repo's six-connection trigger budget. Consume response bodies (`drainResponseBody`) before later fetch phases so cleanup and byte use stay bounded.

---

## 6. Queue / rate-limit / retry

**Responsibility.** Own the `telegram_pending_alerts` row lifecycle: enqueue bounded provenance, claim, revalidate current effective preference eligibility, effect-state transition, drain, retry-with-backoff, preference cancellation, dead-letter, expire. `pending -> sending` records an effect owner/generation immediately before the Bot API call. Confirmed HTTP retry responses alone return that exact generation to `pending`; timeout/network ambiguity, owner loss, and expired `sending` claims become `execution_unknown` and are never auto-replayed. Confirmed success becomes `sent`. A confirmed `chat_migrated` response is terminally archived without replay before the shared group-to-supergroup migration helper moves durable chat state to Telegram's replacement ID. Pending terminal transitions project the same final delivery state into the authoritative alert-job target before cleanup, and a bounded repair pass closes post-commit/pre-cleanup gaps. Terminal target state also excludes legacy sent rows from candidate selection. Recap rows use `source_type = 'personalized_recap'`, priority `100`, six-hour TTL, exact stored Mini App markup, and a recap-specific generation/target revalidation branch; sent or `execution_unknown` outcomes project the consumed fact window to `telegram_recap_targets`, while expiry and permanent failure leave it unconsumed for the bounded next window. Hold per-chat/global backoff and the blocked-subscriber lifecycle.

**Owned files.**
- `worker/src/cron/telegram-pending/index.ts` (compatibility barrel for existing imports)
- `worker/src/cron/telegram-pending/*` (claim/drain, backoff, cleanup, dead-letter, preference revalidation, recap terminal projection, lifecycle helpers)
- `worker/src/lib/telegram/pending-queue.ts` (enqueue, dedupe-key construction, priority and upsert SQL, re-exported by `telegram-pending/upsert-sql.ts`) and `worker/src/lib/telegram/pending-capacity.ts` (capacity/watchdog read model)
- `shared/lib/telegram-delivery-policy.ts` owns runtime-neutral queue, batch, TTL, rate-limit, deadline, and load-model policy. `worker/src/lib/telegram/constants.ts` re-exports the established Worker import surface.

**Allowed inbound dependencies.** Dispatch and the personalized recap planner (the only legitimate alert/recap enqueuers), Admin Telegram routes (`admin-telegram-broadcast.ts`), Callback routing only via `SNOOZE_REPLY_MARKUP` re-export (the `lib/telegram/alerts.ts` keyboard).

**Allowed outbound dependencies.** Outbound transport, State / persistence (cache helpers for global backoff), Common.

**Must NOT.**
- Be opened by Ingress directly. Ingress should never enqueue.
- Re-introduce delivery-policy constants outside `shared/lib/telegram-delivery-policy.ts`.
- Mutate `telegram_subscribers` alert flags except via the 2-strike block-disable path. Subscription state is owned by State / persistence helpers.
- Reset or overwrite a `sending`, `sent`, or `execution_unknown` row through dedupe re-enqueue. Only unclaimed/expired `pending` rows may refresh in place.
- Delete `execution_unknown` through ordinary TTL or disabled-chat cleanup. It remains operator-visible, then moves to idempotent dead-letter audit after the separate 90-day ambiguity-retention window.

---

## 7. State / persistence

**Responsibility.** Authoritative read/write helpers for Telegram D1 tables. Encodes the "upsert subscriber and subscriptions in one batch" pattern, the pending-disambiguation lifecycle (including the bulk-confirm payload, the setup-wizard state, and expired-row cleanup), the processed-update idempotency claim, the command-cooldown gate and best-effort cooldown release for transient/throwing handlers, group-to-supergroup chat-ID migration merges, the chat-delivery diagnostics, and the recap preference/target lifecycle.

Per-coin and preset facts are independent. `telegram_subscriptions` owns direct/local per-coin preferences; `telegram_preset_subscriptions` owns dynamic source membership and never materializes its resolved coins into the direct table. Store intent inputs name direct coin IDs separately from preset IDs so command, callback, setup, import, and Mini App callers cannot conflate the two sources. Following or unfollowing a preset changes only its preset row; current preset membership is resolved from the stablecoin cache at dispatch.

Portable watchlist tokens preserve that boundary instead of exporting a flattened effective watchlist. Current `pw3` stores packed six-family direct/local rows and preset policies separately; `pw2` remains readable with freeze intent defaulted off. Webhook import stages an exact, initiator-owned replacement preview in `telegram_pending_disambiguation`; Mini App preview stays request-local. Both confirmation paths lease `preference_generation`, upsert retained rows without touching their per-coin snooze, remove only previewed rows, clean expired snooze-only rows, and restore the next generation atomically. A generation mismatch performs no portable-preference writes and requires a new preview.

Direct subscribe-style follows bump alert flags with `MAX(...)` and mark the matching selected families as local preferences, while settings-style overrides replace exactly one setting and mark its matching `alert_*_override` column. Every enabled direct row is authoritative over preset tuning. Dispatch treats a per-coin row as an explicit off only when both the alert flag is `0` and the marker is `1`, so default zeroes from partial or legacy writes do not suppress preset/global fan-out. Settings-style depeg writes share one rule: `depeg on` preserves an existing worsening step, `depeg off` clears it, and `depeg-step <bps>` enables depeg while setting that step. `/subscribe ... depeg-step off` is still a direct follow with depeg enabled and no worsening-step threshold.

The provenance correction required no D1 migration because these two tables and keys already represented the target model. Existing `telegram_subscriptions` rows may have been created either directly or by the former preset-materialization behavior, so rollout classifies every existing row conservatively as direct/local intent and deletes none. Rolling back to an older Worker can resume materialization, but the corrected Worker remains compatible with those rows and will again retain them as direct intent.

**Owned files.**
- `worker/src/api/telegram-webhook-store.ts` (compatibility barrel re-exporting `telegram-store/*`) and `worker/src/api/telegram-store/*` (the topic-specific SQL builders: `subscribers`, `subscriptions`, `chat-state`, `disambiguation`, `snooze`, `presets`, `forget`, `processed-updates`, `watchlist-import`). The import contract — per-coin/preset write SQL belongs in `telegram-webhook-store` — still holds via the barrel.
- `worker/src/lib/telegram/chat-member.ts` (cached chat-admin read policy; Bot API HTTP goes through Outbound transport)
- `worker/src/lib/telegram/usage-analytics.ts` (usage events, lifecycle snapshots, chat delivery diagnostics)
- `worker/src/lib/telegram/adoption-analytics.ts` (aggregate funnel writes, one-time milestones, bounded D7/D30 catch-up, weekly report)
- `worker/src/lib/telegram/webhook-registration.ts` (Bot API webhook/commands/profile/menu-button reconcile cadence and D1 cache markers; Bot API HTTP goes through Outbound transport)
- D1 schemas — owned by the migrations themselves (see [D1 Schema](#d1-schema)):
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
  - `telegram_legacy_overflow_state` — historical only; the retired one-time cache importer and its table were removed from production on 2026-08-10.
  - `telegram_alert_job_target_items` — normalized source-item coverage for consolidated target chunks (Dispatch)
  - `telegram_freeze_alert_events` / `telegram_freeze_alert_targets` — dedicated freeze source events and their frozen per-chat cohort (Dispatch)
  - `telegram_alert_dead_letters` — terminal failure audit (Queue)
  - `telegram_processed_updates` — webhook idempotency (Ingress)
  - `telegram_webhook_operation_mutations` — durable operation-intent markers for the webhook effect fence (Ingress)
  - `telegram_usage_daily` — privacy-preserving aggregates (Action handlers + Dispatch)
  - `telegram_adoption_daily` / `telegram_adoption_retention_daily` — identifier-free funnel and retention aggregates
  - `telegram_adoption_ingress_quota` — identifier-free global CTA-ingress ceiling
  - `telegram_adoption_client_quota` — dedicated-pepper HMAC-IP CTA-ingress ceiling
  - `telegram_watcher_lifecycle_daily` — daily lifecycle snapshots
  - `telegram_chat_delivery_diagnostics` — per-chat diagnostics (Outbound + Dispatch)
  - `telegram_transport_circuit` / `telegram_transport_failure_observations` / `telegram_delivery_pauses` — transport circuit state, failure observations, and operator delivery pauses (Outbound transport)
  - `telegram_digest_outbox` — digest send outbox (Digest transport)
  - `telegram_recap_preferences` — private recap opt-in, local hour, next due time, and consumed window (State / Dispatch)
  - `telegram_recap_targets` — one bounded recap plan/outcome per chat and local date (Dispatch / Queue)
- KV: none currently. Cache keys live in D1 (`cache` table) — notably `alert:dews-snapshot`, `alert:dews-alertable-snapshot`, `alert:depeg-snapshot`, `alert:safety-snapshot`, `alert:launch-snapshot`, `alert:reserve-snapshot` (producer-written versioned reserve source envelope), `alert:reserve-dispatched-snapshot` (dispatch baseline), `alert:freeze-tape-cursor` (owned only by the dedicated freeze outbox), canonical `report-cards:v9` and `report-cards:v9:publication-health`, `telegram:global-send-backoff-until`, chat-scoped `telegram:command-cooldown:<chat_id>:*`, `telegram:command-flood:<chat_id>*`, `telegram:chat-member:<chat_id>:<user_id>`, `telegram:chat-admins:<chat_id>`, `telegram:group-welcome:<chat_id>`, the 30-minute consumed-on-first-mutation `telegram:adoption-mini-app-session:<user_id>` key (written and consumed by validated initData user id; the `/forget` cascade clears it by chat id, which equals the user id in private chats), legacy `telegram:re-engagement-warned:<chat_id>` markers awaiting retention cleanup, `telegram:commands-reconciled`, `telegram:profile-reconciled`, `telegram:menu-reconciled`, `telegram:preset-query-failure-count`, `telegram:degradation:*`.

**Allowed inbound dependencies.** Every other seam may read/write through these helpers.

**Allowed outbound dependencies.** Cache helpers (`worker/src/lib/db-cache.ts`), `worker/src/lib/db.ts`, Outbound transport for the narrow chat-member and registration Bot API calls, Common.

**Must NOT.**
- Format messages or send user-visible Telegram messages.
- Take direct dependencies on Action handlers or Dispatch — keep the helpers callable from both lanes.
- Add an ORM, schema-builder, or "repository" abstraction.

---

## 8. Outbound transport

**Responsibility.** The single place that hits `https://api.telegram.org/bot<token>/…`. Owns HTTP timeouts, the `link_preview_options` shape, bounded response-body cleanup, Bot API error classification, and the auditing wrapper that updates per-chat reply diagnostics.

**Owned files.**
- `worker/src/lib/telegram.ts` (`postTelegramBotApi`, `sendToChat`, `sendBatch`, `answerCallbackQuery`, `editMessage`, `escapeHtml`, link-preview helpers, send-error classification)
- `worker/src/api/telegram-webhook-replies.ts` (`sendAuditedTelegramReply` — chunks + diagnostics + replyMarkup)
- `worker/src/lib/telegram/log.ts` (structured Telegram event logger)

**Allowed inbound dependencies.** Action handlers, Callback routing, Ingress (for replies), Dispatch (alert sends), Queue (drains), admin routes, daily digest, registration reconciliation, chat-admin membership probes.

**Allowed outbound dependencies.** Native `fetch`, Common.

**Must NOT.**
- Know about subscribers, snapshots, or commands. Send what you are given.
- Inline HTML formatting beyond `escapeHtml`. Body composition lives in `telegram/alerts.ts` or per-handler builders.

---

## 9. Mini App surface

**Responsibility.** Serve the Telegram Mini App UI and its two signed `initData` API calls. Load private-user state, expose read-only group/stale-auth state, apply private-user mutations including the Daily Recap toggle/hour, provide request-local portable-watchlist export/import and bounded bulk direct-row preview/confirm/undo, and return versioned responses that the frontend hydrates with its bundled catalog. Telegram direct-link launches can report the private user context as `chat_type="sender"`. This seam is intentionally narrow: it does not receive Telegram webhook updates and it does not call the Telegram Bot API.

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
- `worker/src/lib/telegram/recap-store.ts` (shared generation-fenced recap preference mutation)
- `worker/src/lib/telegram/mini-app-auth.ts`
- `shared/lib/telegram-mini-app-contract.ts`
- `shared/lib/telegram-mini-app-catalog.ts`
- `shared/lib/telegram-presets.ts`
- `shared/data/stablecoins/coins.telegram-mini-app.generated.json`

**Allowed inbound dependencies.** The Next.js route `/pharoswatchbot/app/`, Worker route registry entries for `POST /api/telegram-mini-app/session` and `POST /api/telegram-mini-app/mutate`, and private-chat Web App buttons generated by Action handlers / Callback routing.

**Allowed outbound dependencies.** State / persistence helpers for subscription writes and cooldowns, Worker preset resolution for dynamic targets, `telegram-usage-analytics` for validated usage events, the shared Mini App contract/catalog and preset definitions, shared endpoint metadata, shared stablecoin metadata, and the Telegram WebApp browser bridge on the frontend.

**Must NOT.**
- Accept mutation auth older than the 5-minute mutation window.
- Treat portable export or preview as a mutation: they use the 24-hour signed-read window and session throttle, while import confirmation remains a 5-minute mutation and must revalidate its exact preview.
- Flatten preset/global coverage into direct rows during bulk editing; bulk confirmation and undo may change only the bounded direct-row set and must fail stale on generation/fingerprint drift.
- Mutate group/supergroup/channel chat rows until a fresh admin verification path and group-scoped launch ownership model exist.
- Write analytics, aggregate counters, or cooldown rows before signed `initData` validation succeeds. Body-too-large, malformed JSON, and schema-denied Mini App requests must return without D1 writes because the endpoints are public API-key-exempt surfaces.
- Apply or replay a mutation when the advertised contract/catalog version does not match. Version mismatch must stay a pre-write `409`; the client may refresh its static bundle once but must require a new user action for the mutation.
- Duplicate per-coin or preset write SQL outside the existing State / persistence helpers.
- Treat `set-recap` as a generic alert toggle: enabling without an explicitly confirmed IANA timezone must return `recap-timezone-required`, and group/stale-auth writes remain denied.
- Use `Telegram.WebApp.sendData` without updating `allowed_updates` and treating incoming `web_app_data` as untrusted.

---

## Common modules

Files any seam may import:

- `worker/src/lib/telegram/constants.ts` — central magic numbers and tokens (`SNOOZE_SECONDS`, `DEPEG_STEP_VALUES`, `TOP_VIEW_NAMES`, `TELEGRAM_MESSAGE_CHUNK_LIMIT`, ingress flood limits, group welcome/admin cooldown TTLs, all queue tuning, disambiguation TTL).
- `worker/src/lib/telegram/alerts.ts` — compatibility barrel for alert parsing and formatting exports.
- `worker/src/lib/telegram/alerts-parser.ts` — ticker resolution, subscribe/set argument parsing, disambiguation parsing, and close-match suggestions.
- `worker/src/lib/telegram/alerts-formatting.ts` — alert message formatting, `splitMessage`, and `SNOOZE_REPLY_MARKUP`.
- `worker/src/lib/telegram/format-age.ts` — compact relative-age labels shared by command and status surfaces.
- `worker/src/lib/telegram/coin-dedupe.ts` — shared stablecoin de-duplication helpers for alert and command coin lists.
- `worker/src/lib/telegram/presets.ts` — preset definitions and resolution.
- `worker/src/lib/telegram/digest-appendices.ts` — channel digest appendices (cemetery, newly tracked).
- `worker/src/lib/telegram/log.ts` — structured logging.
- `worker/src/lib/telegram/pending-provenance.ts` — bounded target-group scope and markup-policy serialization/parsing shared by Dispatch and Queue.
- `shared/lib/telegram-recap-policy.ts` — runtime-neutral recap cadence, freshness, page, message, priority, TTL, and load bounds.
- `shared/lib/iana-local-time.ts` — validated IANA local-date/hour scheduling and deterministic DST handling shared by controls and planner.

---

## Structural change policy

The named seams are the current baseline. Behavioral work should stay inside them; structural changes should update this document before moving code.

Routine changes that do not reopen the seam model include bug fixes, new command or callback handlers, tests, fields on existing helpers/types, and hardening inside an existing owner.

Treat these as doc-first structural changes:

- extracting, splitting, renaming, or moving modules across seams
- adding top-level Telegram directories or layered abstractions
- reorganizing `COMMAND_HANDLERS` or `CALLBACK_ACTIONS` for style alone
- generalizing command handlers behind a new pipeline or framework

When the current layout is wrong, document the new ownership and dependency direction in the same change that moves the code.
1. **Two consecutive "extract helper" commits to Telegram code in 7 days** — the seams aren't holding; whatever was extracted is still entangled.
2. **A bug fix touches more than 2 seams** — a single change rippling through Ingress + Action handlers + State means the boundary between them is wrong, not the code inside them.
3. **A callback handler imports from 4+ seams** — the callback layer already sits at the edge: the per-action files in `webhook-callbacks/` reach into Action handlers' builders, State helpers (via store/settings-mutations), Common, and the setup state machine; if a new callback needs a 5th, the callback layer is doing too much.
4. **A new constant gets defined outside `telegram/constants.ts`** within the Telegram subsystem — the centralization (P1-M2) is decaying.
5. **The same SQL appears in two seams** — most likely State / persistence is missing a helper.
6. **Ingress grows past ~600 lines again** — the dispatcher loop is doing more than routing. Push behavior into Action handlers or State.

---

## Architectural tension flagged but not prescribed

- **`worker/src/lib/telegram/alerts.ts` remains the stable import path for Common alert helpers, but implementation now lives in parser and formatter modules.** Keep the barrel so existing imports stay stable; do not create additional Common submodules without a doc-first seam update or a bug-driven reason.

- **Callback routing now routes mutating callback writes through `telegram-webhook-store.ts` or `telegram-webhook-settings-mutations.ts`.** New mutating callbacks should continue using those persistence helpers rather than adding inline SQL back into `telegram-webhook-callbacks.ts`.

- **Setup wizard state lives in `telegram_pending_disambiguation` with `action_type = "setup-step"`.** Sharing the TTL and cleanup cron with disambiguation was deliberate, but Ingress now branches on `isSetupPending` before any other pending-state logic — that branch will keep growing if more wizards arrive. Watch for a third pending-action-type before deciding whether wizards need their own row type.

- **`admin-telegram-broadcast.ts` writes to `telegram_pending_alerts` directly with its own priority and TTL.** Filed under Dispatch in this doc, but it has Ingress-shaped concerns (it is an HTTP entrypoint). Its watcher targeting is delegated to Dispatch and its message body is preflighted against the supported Telegram HTML subset before target selection. If a second admin write path appears, consider splitting "admin write surface" into its own seam.

## D1 Schema

The Telegram subscriber, disambiguation, and delivery-queue tables are part of `worker/migrations/0000_baseline.sql`. Historical migrations `0172` through `0217`, now absorbed into that squashed baseline rather than replayed as active files, introduced launch/snooze/preset/retry/audit/claim/retention/reserve fields and indexes: `0172_worker_effect_fencing.sql` added pending-delivery effect state and processed-update owner/generation/effect fencing; `0183_telegram_fresh_target_effect_fencing.sql` added the rolling-compatible fresh alert-target lifecycle; `0185_telegram_source_event_resolution.sql` made source detection and preset target resolution independently durable; `0187_telegram_pending_preference_revalidation.sql` added monotonic chat-preference generations and pending-risk provenance; `0190_telegram_authoritative_target_plans.sql` made subscriber capture, rendered plans, target chunks, delivery outcomes, bounded source expiry, and legacy overflow import row-authoritative; `0192_telegram_adoption_analytics.sql` added aggregate-only adoption/retention reporting and two subscriber milestone timestamps used only for idempotency; `0197_telegram_freeze_alerts.sql` added opt-in freeze preferences and a dedicated immutable event/target outbox; `0198_telegram_personalized_recap.sql` added private-chat daily recap preferences and immutable per-local-date recap targets; `0216_telegram_authoritative_retention_indexes.sql` added terminal-source and target-item indexes for bounded lifecycle pruning; `0217_telegram_hot_family_subscription_indexes.sql` added partial direct-subscription indexes for DEWS, depeg, and safety candidate queries. [`worker/migrations/MANIFEST.md`](../worker/migrations/MANIFEST.md) is the complete lineage and identifies the active post-squash files.

| Table | Purpose | Key fields |
|-------|---------|------------|
| `telegram_subscribers` | Per-chat state and defaults | `chat_id`, `username`, legacy default flags, `global_alert_dews`, `global_alert_depeg`, `global_alert_safety`, `global_alert_launch`, `global_alert_reserve`, `global_alert_freeze`, `global_depeg_worsening_bps_step`, `quiet_hours_enabled`, `quiet_hours_start_utc`, `quiet_hours_end_utc`, `timezone`, `alert_snooze_until_ts`, `preference_generation`, `first_follow_at`, `first_setup_completed_at`, `consecutive_block_count`, `consecutive_block_first_at`, `created_at`, `last_active_at` |
| `telegram_subscriptions` | Per-chat per-coin alert preferences | composite PK `chat_id, stablecoin_id`, `alert_dews`, `alert_depeg`, `alert_safety`, `alert_launch`, `alert_reserve`, `alert_freeze`, matching `alert_*_override` marker columns, `dews_min_band`, `safety_mode`, `depeg_worsening_bps_step`, `alert_snooze_until_ts` |
| `telegram_preset_subscriptions` | Persistent dynamic preset follows resolved at dispatch/list time | composite PK `chat_id, preset_id`, `alert_dews`, `alert_depeg`, `alert_safety`, `depeg_worsening_bps_step`, `created_at`, `updated_at` |
| `telegram_pending_disambiguation` | Short-lived state for ambiguous ticker replies | `chat_id`, `action_type`, `action_payload`, `resolved_ids`, `ambiguous_ticker`, `candidates`, `remaining_tickers`, `expires_at`, `initiator_user_id` |
| `telegram_pending_alerts` | Authoritative transport queue for planned risk chunks, personalized recaps, retries, and admin work | `id`, `chat_id`, rendered payload, retry/dedupe/priority fields, processing claim, `delivery_state`, delivery owner/generation/timestamps, source `source_event_id`, `source_type`, `alert_scope_json`, `preference_generation`, `markup_policy_json`; recap rows use priority `100` and a six-hour TTL |
| `telegram_alert_jobs` / `telegram_alert_job_targets` | Durable source-family manifests and exact target delivery truth | source/job identity, exclusive planned/accepted/enqueued/failed/cancelled/expired/execution-unknown counters; target source/plan ordinals, rendered payload, scope/preference/markup provenance, target expiry, pending identity, legacy effect fields, `final_delivery_state` and terminal detail |
| `telegram_alert_source_events` / `telegram_alert_source_resolution_pages` | Immutable detected event plus cursorable preset resolution and target-plan ownership | exact event/baseline payloads, source status, target-plan state/generation/owner/lease, detection-time subscriber horizon/high-water, capture/planning cursors and counts, terminal timestamps |
| `telegram_freeze_alert_events` / `telegram_freeze_alert_targets` | Dedicated immutable freeze-event lineage and frozen opt-in recipient cohort | tape and blacklist source identities, captured payload/expiry/status, one-time cohort boundary, chat preference generation, pending dedupe identity, queued/terminal timestamps |
| `telegram_recap_preferences` | Private opt-in daily recap schedule | `chat_id`, private `chat_kind`, enabled/cadence, local delivery hour, next due time, consumed window, last local delivery date |
| `telegram_recap_targets` | One immutable personalized recap planning/delivery outcome per chat and local date | recap key, bounded window/high-water/fingerprint/hash, material/omitted counts, pending identity, queued/terminal status and reason |
| `telegram_alert_source_resolution_memberships` / `telegram_alert_source_resolution_targets` | Normalized preset membership and follower-page lineage | `source_event_id`, `alert_type`, `preset_id`, `stablecoin_id`, `page_key`, `chat_id`; current preset intent and snooze state are revalidated before routing |
| `telegram_alert_planning_subscribers` | Frozen subscriber cohort and one durable planning decision per chat | source/generation/chat identity, captured preference generation/activity, initial eligibility, current planned generation, `target_planned`/ineligible/newly-eligible/missing/expired outcome |
| `telegram_alert_target_plan_pages` / `telegram_alert_target_plans` / `telegram_alert_target_plan_items` | Cursorable rendered manifest before transport handoff | immutable page bounds and expected/materialized counts; ordered versioned plan JSON plus digest/chunk counts; normalized source-item coverage |
| `telegram_alert_target_expiry_progress` | Bounded source-expiry reconciliation | processed and remaining subscriber/page/plan/target counts, running/complete state and timestamps |
| `telegram_legacy_overflow_state` | Historical only: dropped from production on 2026-08-10 | Retired importer state only |
| `telegram_alert_job_target_items` | Queryable source-item coverage for each consolidated target chunk | composite `job_id, target_key, item_key`, `source_event_id`, `created_at` |
| `telegram_alert_dead_letters` | Expired, cancelled, or permanently failed pending-send audit trail | `pending_id`, `chat_id`, `source_type`, `alert_type`, `created_at`, `expired_at`, `attempts`, `last_error_class`, `reason`, `dedupe_key`, copied risk provenance fields |
| `telegram_processed_updates` / `telegram_webhook_operation_mutations` | Retry-safe webhook operation intent, atomic local-mutation proof, and outbound-effect claims | `update_id`, timestamps/type/chat/status, versioned `intent_kind`/`intent_payload`, `mutation_applied_at`, `effect_state`, `effect_kind`, `effect_ordinal`, effect timestamps, `claim_owner`, `claim_generation`, `error_class` |
| `telegram_usage_daily` | Privacy-preserving daily command/setup/action aggregates | `day`, `event_type`, `source_category`, `action_detail`, `outcome`, `latency_bucket`, `failure_class`, `count`, `first_seen_at`, `last_seen_at` |
| `telegram_adoption_daily` | Low-cardinality first-party funnel aggregates; never stores a chat/user ID | allowlisted campaign, placement, stage, feature, mutation-latency bucket, outcome, count and aggregate timestamps |
| `telegram_adoption_retention_daily` | Aggregate D7/D30 first-follow cohorts by surviving active-follow feature | cohort/measurement day, 7/30-day window, `any`/`direct`/`preset`/`global`, durable cohort/retained counts, quality |
| `telegram_adoption_ingress_quota` | Identifier-free global minute ceiling for the public CTA counter | minute bucket, admitted request count, update time; two-day operational retention |
| `telegram_adoption_client_quota` | Per-client minute ceiling for the public CTA counter | minute bucket, dedicated-pepper HMAC-IP key, admitted request count, update time; two-day operational retention |
| `telegram_watcher_lifecycle_daily` | Daily active-watcher snapshots for stable public pulse history | `day`, `snapshot_at`, `active_watchers`, `new_watchers`, `churned_watchers`, `reactivated_watchers`, `explicit_coin_follows`, `preset_implied_coin_follows`, `active_preset_followers`, alert-type opt-ins, quiet-hours and pending-delivery counts |
| `telegram_chat_delivery_diagnostics` | Per-chat delivery diagnostics used by `/health` | `chat_id`, `last_successful_delivery_at`, `last_successful_reply_at`, `last_delivery_attempt_at`, `recent_failure_class`, `updated_at` |

Pre-squash migration `0117_telegram_global_alert_indexes.sql`, now part of `worker/migrations/0000_baseline.sql`, adds partial indexes on each original `telegram_subscribers.global_alert_*` flag (DEWS, depeg, safety, launch) plus `telegram_pending_alerts(chat_id)` so the dispatcher's global-subscriber fan-out queries and the pending drain JOIN avoid full scans. The equally squashed `0157_telegram_global_alert_reserve_index.sql` adds the matching partial index for `global_alert_reserve`; migration `0197` adds the freeze index. Migration `0217` adds partial `(stablecoin_id, alert_snooze_until_ts, chat_id)` indexes for enabled DEWS, depeg, and safety direct subscriptions so the three hot-family loaders use a covering candidate/snooze path instead of scanning unrelated per-coin rows.

`/unsubscribe all` clears per-coin subscriptions, preset follows, and all-stablecoin alert flags, which stops alerts for that chat. It does not immediately erase the `telegram_subscribers` row, processed-update idempotency rows, delivery diagnostics, or historical aggregate counters needed for abuse prevention, retry safety, and operations.

`telegram_subscribers` rows are auto-pruned after 180 days of inactivity only when they have no meaningful alert state. The `telegram-inactive-cleanup` job runs on the daily 03:00 UTC lane behind a 7-day cache guard (`cache` key `cron:telegram-inactive-cleanup:last-run`) and removes an old subscriber when all global alert flags are off, no preset follows, pending alerts, or pending disambiguation remain, no enabled personalized recap preference exists, and every per-coin row is inert. A per-coin row is inert only when all alert flags and explicit-override markers are off and its snooze and tuning fields are empty; marker-backed explicit-off choices therefore continue to retain the profile. Live per-coin and preset follows are never expired for inactivity, and the job does not send a re-engagement warning to profiles that are ineligible for deletion. The scan uses `idx_telegram_subscribers_last_active_at` and each eligible chat is removed via a batched cascade DELETE; the job caps at 100 deletions per run so a large backlog cannot push the daily slot past its per-statement budget. The most recent run's `item_count` in the trailing 7-day window is surfaced as `TelegramBotStats.inactiveSubscribersCleanedThisWeek`.

Pending disambiguation rows expire with their command TTL. Pending alert rows leave the live queue when sent, expired, preference-cancelled, or permanently failed; dead-letter rows keep delivery-failure and cancellation audit context without being a live subscription. Expired pending-alert cleanup normally writes a dead-letter copy before deleting the live row; if that dead-letter write fails, the cleanup logs an error-level bypass event and still removes the expired live row so a persistent audit-table failure cannot grow the live delivery queue without bound. Users can also issue `/forget` for an immediate two-step deletion of their subscriber data plus chat-owned planning snapshots, rendered target plans, dedicated freeze targets, alert-job target rows and their chat-prefixed item lineage, dead-letter rows, transport-failure observations, and cache residue (command cooldown/flood rows, chat-member/admin diagnostics, group welcome markers, legacy re-engagement-warning markers, cached dispatch overflow plans, and nested burst-summary markers); `/unsubscribe all` plus inactivity pruning remains the lighter-touch alternative.

`telegram-retention-cleanup` deletes retained Telegram audit/analytics rows in ordered 10,000-row SQL batches instead of uncapped table DELETEs. Terminal authoritative workflow rows (`telegram_alert_planning_subscribers`, plan pages/items, and completed expiry progress) retain 24 hours of recovery grace. Settled job targets and their exact target plans, jobs, source-resolution rows, and terminal source payloads retain a 14-day exact-replay window; a plan or source is deleted only after no retained target depends on it. Pre-authoritative targets without a plan generation also age out after 14 days only when their target state is terminal and no pending, sending, claimed, or `execution_unknown` effect remains; target-item lineage is deleted first, source-less terminal jobs are removed only after their targets are gone, and degraded job audit remains on the 90-day policy. Expired source-less `discovered`/`queued` jobs and expired unresolved sources with no dependent workflow, target, or job rows retain 30 days before cleanup. Other unresolved or `execution_unknown` effects remain on the 90-day audit/reconciliation policy, as do dead letters and freeze audit rows. The high-volume workflow/replay passes may process up to 100,000 rows per table per daily 03:00 UTC run, while other table/cache passes remain capped at 10,000. Processed updates run in 1,000-row batches with a 2-second internal time budget and a 5,000-row ceiling. Usage, adoption, and adoption-retention aggregates use 400 days; CTA quota buckets use two days; the Mini App open-to-first-mutation cache uses 30 minutes and is deleted immediately by `/forget`. A bounded 5,001-row processed-update probe reports the remaining count exactly below that limit or as a lower bound at the limit. Remaining processed-update debt or a saturated high-volume delete pass sets `runBudgetTruncated`; per-table `cappedAtLimit` metadata identifies the affected pass. The high-growth family additionally reports its cutoffs, row limit, deleted counts, oldest remaining/eligible timestamps, duration, and isolated error; a family error degrades the cron while the other retention passes continue. Dead-letter audit remains available after day 14, but exact admin replay correctly returns incomplete once its target-plan bundle has aged out.

Telegram custom Worker logs are deliberately non-correlatable to a chat. `worker/src/lib/telegram/log.ts` uses a closed compile-time schema plus an independent runtime allowlist for operation/module labels, bounded counts, status codes, retry timing, and fixed error categories. It drops raw chat/user/update/callback/pending/source-event identifiers, message and callback content, URLs, tokens, secrets, `initData`, arbitrary error strings, arrays, and objects; allowed strings receive bounded secret/identifier scrubbing. Do not add unkeyed hashes or pseudonymous chat keys to restore general-log correlation. For one-chat incident response, use the Access-authenticated admin chat diagnostics and the D1 alert-target, pending, dead-letter, processed-update, and delivery-diagnostic rows. Expired-pending cleanup logs one aggregate summary rather than one record per target.

Cloudflare Workers Logs processes sampled custom records under the Cloudflare account permissions configured outside this repository. `worker/wrangler.toml` enables observability and invocation logs with `head_sampling_rate = 0.1`; the repository configures no separate Workers Logpush archive and no Telegram-specific/provider retention duration. Treat console logs as sampled, short-lived operational hints, not the durable incident ledger.

The webhook claims individual Telegram update IDs, completes parsing/authorization and records a bounded, versioned normalized operation intent before local mutation or Bot API effects. Replay-safe D1 mutations commit with a generation-fenced row in `telegram_webhook_operation_mutations`; losing the claim aborts the same D1 batch. The webhook crosses `effect_state = 'started'` only immediately before each irreversible Bot API call and records its effect kind/ordinal. Stale `unstarted` and `planned` claims are recoverable from the stored intent. Once an outbound effect starts, a missing terminal marker is execution-unknown and duplicates are acknowledged without replay. `/api/status.telegramBot.webhookEffectLifecycle` exposes planned/started/unknown counts and bounded ages; `webhookEffectUnknown` remains the combined ambiguous count.

When Telegram upgrades a group to a supergroup, the webhook handles `migrate_to_chat_id` and `migrate_from_chat_id` service messages before command parsing. The migration helper merges the old numeric chat ID into the new one across subscriber state, per-coin subscriptions, preset follows, pending selections, normalized source-resolution targets, planning snapshots, rendered target plans, pending/dead-letter delivery rows, alert job targets and their item lineage, transport observations, delivery diagnostics, processed-update chat references, and known exact D1 cache keys such as `telegram:chat-admins:<chat_id>` and `telegram:group-welcome:<chat_id>`. Pre-handoff planned targets are cancelled before the chat ID moves so a plan rendered for the old destination cannot be replayed against the new chat. The helper is idempotent because Telegram can deliver either service message first.

When `my_chat_member` reports that a group or supergroup removed the bot
(`left`/`kicked`), the webhook immediately runs the same subscriber-state
cascade as `/forget` for that chat and clears the group welcome/admin cache
keys. Processed-update idempotency rows and aggregate usage counters are
retained.

## Secrets and Bindings

| Binding | Required | Used by |
|---------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | No | Webhook replies, digest posting (including appended cemetery / tracking notices), subscriber alert fan-out; Telegram transport lanes are skipped or degraded when unset |
| `TELEGRAM_BOT_TOKEN_PREVIOUS` | No | Optional bot-token rotation overlap for signed Mini App `initData`; sends and webhook registration use the current token |
| `TELEGRAM_WEBHOOK_SECRET` | No | Webhook registration and validation for `POST /api/telegram-webhook` via `X-Telegram-Bot-Api-Secret-Token`; active only when Telegram credentials are configured |
| `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` | No | Temporary overlap secret accepted by `POST /api/telegram-webhook` during secret rotation; registration still emits only `TELEGRAM_WEBHOOK_SECRET` |
| `TELEGRAM_CHAT_ID` | No | Daily digest channel posting, including appended cemetery and tracking notices |
| `TELEGRAM_OPERATOR_CHAT_ID` | No | Private operator chat for the cron freshness-watchdog alert; the alert is suppressed when unset and never falls back to `TELEGRAM_CHAT_ID` |

Webhook registration is handled by `npx tsx scripts/maintenance/register-telegram.ts --action webhook`, which calls Telegram `setWebhook` with the webhook URL and the JSON `secret_token` field:

- URL: `https://api.pharos.watch/api/telegram-webhook`
- Secret token: `<TELEGRAM_WEBHOOK_SECRET>`

The dedicated five-minute Telegram worker lane now also reconciles the webhook registration in production on a cache-backed cadence. That means the live Worker periodically re-applies the configured webhook URL, secret token, and `allowed_updates = ["message", "callback_query", "my_chat_member", "inline_query", "chosen_inline_result"]` via Telegram `setWebhook`, which self-heals webhook-secret or update-filter drift without requiring a separate manual script run. `web_app_data` does not need a separate `allowed_updates` value for the current Mini App launch MVP because it is not using `Telegram.WebApp.sendData`; if that later changes, `web_app_data` arrives inside a `message` update and must be treated as untrusted input.

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
