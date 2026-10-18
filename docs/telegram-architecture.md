# Telegram Architecture Seams

This document owns PharosWatchBot's seam boundaries, allowed dependencies, schema-purpose map, retention, and logging privacy. Behavioral authorities are [Telegram alerts](./telegram-alerts.md) (commands, dispatch, durable delivery), [Mini App](./telegram-mini-app.md) (launch, auth, client state), and [Worker bindings](./worker-infrastructure.md#env-interface) (generated inventory). Changes stay inside a named seam or revise its ownership contract here.

> **Agent navigation** — Architecture seams: [overview](#seam-overview) · [ingress](#1-ingress) · [command parsing](#2-command-parsing) · [callback routing](#3-callback-routing) · [action handlers](#4-action-handlers) · [dispatch/fan-out](#5-dispatch--fan-out) · [queue/retry](#6-queue--rate-limit--retry) · [state/persistence](#7-state--persistence) · [outbound transport](#8-outbound-transport) · [Mini App seam](#9-mini-app-surface) · [D1 schema](#d1-schema) · [secrets/bindings](#secrets-and-bindings). Bot behavior: [commands](./telegram-alerts.md#commands) · [dispatch](./telegram-alerts.md#dispatch) · [delivery persistence](./telegram-alerts.md#delivery-persistence). Client/auth/state: [Mini App overview](./telegram-mini-app.md#overview) · [client state](./telegram-mini-app.md#client-state-and-control-semantics) · [auth](./telegram-mini-app.md#auth-model) · [launch entrypoints](./telegram-mini-app.md#mini-app-launch-entrypoints) · [public pulse](./telegram-mini-app.md#public-pulse-privacy-and-freshness).
> Search hints: `effect_state|claim_generation` for replay safety; `preference_generation` for mutation/revalidation; `TELEGRAM_` for bindings.

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

**Responsibility.** Authenticate `POST /api/telegram-webhook`, claim each update by owner/generation, and route through flood, pending-flow, group-admin, and cooldown gates. [Update deduplication](./telegram-alerts.md#update-deduplication) owns normalized-intent recovery and effect fences; [ingress incidents](./runbooks/telegram-webhook-retry-dedupe.md) owns admission/retry diagnosis. Parsing/authorization precede replay-safe local mutation; only the irreversible Bot API boundary starts an external effect.

**Owned files.**
- `worker/src/api/telegram-webhook.ts` — HTTP entry/claim bootstrap.
- `worker/src/api/telegram-webhook-auth.ts` — secret/admin validation.
- `worker/src/api/telegram-webhook-update-normalization.ts` — pure update/chat/migration shapes; no D1 or Bot API.
- `worker/src/api/telegram-webhook-effect-fence.ts` — claim/normalized-intent effect boundary.
- `worker/src/api/telegram-webhook-update-dispatch.ts` — policy/pending-gated intent routing.
- `worker/src/api/telegram-webhook-ingress-policy.ts` — flood, cooldown, admin and channel gates.
- `worker/src/api/telegram-webhook-pending-gate.ts` — pending-flow decisions.
- `worker/src/api/telegram-webhook-group-welcome.ts` — group lifecycle/welcome.
- `worker/src/api/telegram-inline-queries.ts` — read-only inline cards.
- `worker/src/api/telegram-webhook-shared.ts` — cross-seam types/copy.

**Allowed inbound dependencies.** `worker/src/index.ts` request router (this is an HTTP entrypoint).

**Allowed outbound dependencies.** Command parsing, Callback routing, Action handlers (via `COMMAND_HANDLERS`), State / persistence (for the processed-update claim, the pending-disambiguation read, the cooldown gate), Outbound transport (for reply helpers), Common.

**Must NOT.**
- Format alert messages — that is Action handlers / Common (`worker/src/telegram/common/alerts-formatting.ts`).
- Read alert snapshots or build subscriber queries — that is Dispatch.
- Write subscription state directly — go through State / persistence helpers.
- Reorganize `COMMAND_HANDLERS` without adding/removing a command; do not re-expand it into parallel switches.

Group lifecycle and pending-flow policy remain explicit ingress sub-seams: `telegram-webhook-group-welcome.ts` owns bot-added/removed handling and atomic welcome claims; `telegram-webhook-pending-gate.ts` owns pass-through, clear-and-run, ownership refusal, and reply-and-stop decisions before `COMMAND_HANDLERS`.

`telegram-webhook-shared.ts` is the cross-seam contract for update/pending/bulk types and framed bot copy. Command rows and alert-family lists derive from shared manifests; widening a type is routine, restructuring this contract is a seam change.

---

## 2. Command parsing

**Responsibility.** Pure command/target/deep-link/pending-action parsing; no I/O.

**Owned files.**
- `worker/src/api/telegram-webhook-parsing.ts`
- `worker/src/telegram/common/alerts-parser.ts` — pure target/argument parsing.
- `worker/src/telegram/common/presets.ts` — pure alias parsing; its cache-reading target resolver is consumed by Action handlers/Dispatch.

**Allowed inbound dependencies.** Ingress, Callback routing, Action handlers, Dispatch (for `splitMessage` and formatting), Outbound transport (replies use `splitMessage`).

**Allowed outbound dependencies.** `@shared/lib/stablecoins`, `@shared/lib/classification`, Common (`telegram-constants`, `telegram.ts` for `escapeHtml`). No D1.

**Must NOT.**
- Make D1 calls.
- Make `fetch()` calls.
- Mutate global state.
- Inline preset coin lists — read from `telegram-presets` resolution at call time so the cache stays the source of truth.

---

## 3. Callback routing

**Responsibility.** Validate callback prefixes against `CALLBACK_ACTIONS` before handler D1 work, authorize mutating group actions, invoke shared builders/store helpers, and acknowledge the callback. Ingress owns flood/cooldown admission; `setup:*` and `settings:*` have bounded sub-dispatchers. [Commands](./telegram-alerts.md#commands) owns callback behavior.

**Owned files.**
- `worker/src/api/telegram-webhook-callbacks.ts`
- `worker/src/api/webhook-callbacks/` — registry and per-action implementation.
- `worker/src/api/telegram-webhook-setup.ts` — state machine shared with Ingress ticker input.
- `worker/src/api/telegram-webhook-settings.ts`, `telegram-webhook-settings-render.ts`, `telegram-webhook-settings-mutations.ts`, `telegram-webhook-settings-shared.ts` — settings subsystem.

**Allowed inbound dependencies.** Ingress only (`handleCallbackQuery` is called from `handleTelegramWebhook`).

**Allowed outbound dependencies.** Command parsing (`parsePendingDisambiguation` for bulk-confirm), Action handlers (re-runs `/why`, `/coverage` via the same helpers; falls through for quicksub via store helpers), State / persistence, Outbound transport, Common.

**Must NOT.**
- Bypass `CALLBACK_ACTIONS`; add every prefix and its keyboard builder together.
- Duplicate Store write logic; route new mutations through `telegram-webhook-store.ts`.
- Inline subscription upserts for settings; use `telegram-store/subscriptions.ts` builders to preserve `/set` parity.
- Depend on a concrete action handler; reuse its `build*Message` helper, not `handle*`.

---

## 4. Action handlers

**Responsibility.** Command-domain reads, Common response composition, Store mutations and audited transport; one handler per command.

**Owned files.**
- `worker/src/api/webhook-commands/` — `index.ts` dispatch, `context.ts` request shape, `action-runner.ts` shared resolution/confirmation, and per-command handlers.
- `worker/src/api/telegram-webhook-disambiguation-selection.ts` — pending-selection execution through the action runner.
- `worker/src/api/telegram-webhook-messages.ts`, `telegram-webhook-insights.ts`, `telegram-webhook-status.ts`, `telegram-webhook-resolution.ts` — shared builders and domain loaders/resolution.

**Allowed inbound dependencies.** Ingress (via `COMMAND_HANDLERS`), Callback routing (which re-invokes some handlers via their build-message helpers and may call `action-runner` for the disambiguation reply path).

**Allowed outbound dependencies.** Command parsing, State / persistence, Outbound transport (for replies via `sendAuditedTelegramReply`), Common. Project shared lib (`@shared/lib/*`) is allowed for read-only domain data — stablecoin metadata, classification, supply, peg rates, report cards, chain aggregation.

**Must NOT.**
- Talk to the Telegram HTTP API directly. Send through `replyToChat` / `replyToChatWithMarkup` from `WebhookCommandContext`, or call `sendAuditedTelegramReply` for delayed/audited paths.
- Read from `cron_runs`, alert snapshots, or anything in the Dispatch lane. Use the same primary sources of truth the website uses (caches, the canonical V9 publication, `stress_signals`, etc.).
- Introduce a per-handler "shared base class" or "command pipeline" abstraction. The dispatch table is the only shared shape; resist generalizing it.

---

## 5. Dispatch / fan-out

**Responsibility.** Detect immutable source events, capture source-scoped candidate cohorts, revalidate intent, persist bounded exact target plans/item lineage, and hand them to the queue. D1 owns generation, lease, cursor, page bounds, expiry debt, and final target truth; no baseline advances while a planned target remains. [Dispatch](./telegram-alerts.md#dispatch) owns admission/detection; [routing](./telegram-alerts.md#dispatch-routing-and-formatting) owns planning policy.

Structural boundaries:

- Capture/planning reuse one invocation-local input page only while captured preference generations match. Payload bounds apply before materialization; durable ordinals/digests make partial pages resumable without widening the cohort or reformatting stored targets. Handoff is separately cursor-bounded and set-based.
- The whole five-minute import graph uses `shared/lib/stablecoins/worker-runtime-registry.ts`, never the full stablecoin registry. Safety grade/score/publication identity comes only from the thin alert envelope via `loadActiveAlertSafetySourceAssessment`, never `loadActiveSafetyScoreSource`. `npm run check:runtime-reachability` protects this boundary; [ADR-24](./architecture.md#adr-24) owns the architectural decision.
- `five-minute-telegram.ts` owns serial orchestration and token-independent DB sidecars. [Operational notes](./telegram-alerts.md#operational-notes) owns ordering, token absence, registration outcomes, and recap deadline behavior.
- Reserve dispatch consumes the producer's versioned D1 envelope; it performs no reserve-adapter I/O. The producer owns admission/continuity; dispatch owns its observed/dispatched baselines.
- Freeze consumes immutable fresh Tape through its own cursor/cohort outbox, not the five-family target-plan constraint. It still creates canonical source/job/target/item lineage and uses the same pending queue.
- Personalized recap is a separate DB-only planner, not another risk-alert fan-out. It shares bounded Tape windows, resolves direct/preset/global intent without materialization, and persists exact targets. No AI/provider client, per-recipient Tape query, or planner Bot API send is permitted. Queue owns terminal projection.
- `admin-telegram-broadcast.ts` is the operator write surface, using Dispatch targeting and Queue lifecycle. [Broadcast safety](./runbooks/telegram-admin-broadcast-safety.md) owns canary/TTL authority; [operator queries](./runbooks/telegram-operator-queries.md) owns read-only incident access. There is no supported operator replay/clear/pause mutation.

**Owned files.**
- `worker/src/cron/telegram/dispatch/` — alerts entrypoint, authoritative planning/handoff orchestration, source and queue lifecycle, recipient pages/routing, predicates, state and result contract.
- `worker/src/cron/telegram/sources/` — event detection, changes, snapshots, context, safety reasons, immutable source events/memberships and item lineage.
- `worker/src/cron/telegram/target-plans/` — direct concrete modules for source state, cohort horizon, materialization, delivery handoff, read model and coordinator; `telegram-alert-target-plan-contract.ts` owns bounds and payload contracts.
- `worker/src/cron/telegram/delivery/` — pending queue lifecycle plus exclusive job-target delivery outcomes and target-status projections; see Queue below.
- `worker/src/cron/telegram/freeze/` — immutable freeze source/cohort outbox with its separate schema.
- `worker/src/cron/telegram/recap/` — deterministic DB-only recap planner; persistence and pure facts/rank/format stay in `worker/src/telegram/recap/recap-store.ts`, `recap-facts.ts`, `recap-ranking.ts`, `recap-formatting.ts`.
- `worker/src/cron/telegram/maintenance/` — degradation watchdog, inactive cleanup and retention cleanup; physical triggers stay owned by `shared/lib/cron-jobs.ts`.
- Each cron seam keeps its suites/support in a matching `__tests__/` directory. Consumers import concrete modules directly, with no compatibility barrels. Source/planning hands exact targets to Delivery; Freeze retains its separate immutable outbox and Recap its separate planner. Shared queue/store/transport policy stays in its existing library owner.
- `worker/src/cron/digest/telegram-transport.ts` — digest channel-edition publication, outside risk targeting.
- `worker/src/telegram/common/quiet-hours.ts` — shared quiet-hours predicate and callback timezone validation.
- `worker/src/handlers/scheduled/five-minute-telegram.ts` — serial orchestration with deferred imports of cron entrypoints.
- `worker/src/api/admin-telegram-broadcast.ts` — operator broadcast, not webhook Ingress.

**Allowed inbound dependencies.** Worker scheduled-event router, Worker admin route entrypoints. Not Ingress, not Callback routing.

**Allowed outbound dependencies.** Queue / rate-limit / retry, Outbound transport, State / persistence (read-heavy: subscribers, subscriptions, preset subscriptions, snoozes, snapshots), Common. Project shared lib for domain data is allowed.

**Must NOT.**
- Format command replies. Alert message formatting lives in `worker/src/telegram/common/alerts-formatting.ts` (Common) and is shared between Dispatch and admin-broadcast; do not duplicate.
- Inline subscriber-query SQL into the entrypoint. Add new fan-out paths in `dispatch-telegram-alerts-fanout.ts` or one of the existing helper modules.
- Duplicate admin-broadcast target selection SQL. Broadcast scopes call the Dispatch-owned `loadBroadcastTargetChatIds(db, scope)` helper so global/per-coin/preset watcher predicates evolve in one place.
- Import API action-handler modules for alert context. Dispatch-owned context and reason helpers live under `worker/src/cron/`.
- Exceed the repo's six-connection trigger budget. Consume or cancel response bodies (`cancelResponseBodyQuietly` for ignored bodies, bounded readers for consumed ones) before later fetch phases so cleanup and byte use stay bounded.

---

## 6. Queue / rate-limit / retry

**Responsibility.** Own queue enqueue/provenance, claims, current-preference revalidation, effect fence, retry/backoff, terminal projection, dead letters, expiry, and blocked-chat lifecycle. [Delivery persistence](./telegram-alerts.md#delivery-persistence) owns the behavioral contract. Only confirmed rejection may return the exact sending generation to pending; ambiguity never auto-replays. Confirmed migration archives the old effect before the shared chat-ID migration.

**Owned files.**
- `worker/src/cron/telegram/delivery/` (direct claim/drain, backoff, cleanup, dead-letter, preference revalidation, recap terminal projection, lifecycle, outcome and target-status modules; no barrel)
- `worker/src/telegram/outbox/pending-queue.ts` (enqueue, dedupe-key construction, priority and upsert SQL) and `worker/src/telegram/outbox/pending-capacity.ts` (capacity/watchdog read model)
- `shared/lib/telegram-delivery-policy.ts` owns runtime-neutral queue, batch, TTL, rate-limit, deadline, and load-model policy. `worker/src/telegram/common/constants.ts` re-exports the established Worker import surface.

**Allowed inbound dependencies.** Dispatch and the personalized recap planner (the only legitimate alert/recap enqueuers), Admin Telegram routes (`admin-telegram-broadcast.ts`), Callback routing only via the `SNOOZE_REPLY_MARKUP` keyboard in `worker/src/telegram/common/alerts-formatting.ts`.

**Allowed outbound dependencies.** Outbound transport, State / persistence (cache helpers for global backoff), Common.

**Must NOT.**
- Be opened by Ingress directly. Ingress should never enqueue.
- Re-introduce delivery-policy constants outside `shared/lib/telegram-delivery-policy.ts`.
- Mutate `telegram_subscribers` alert flags except via the 2-strike block-disable path. Subscription state is owned by State / persistence helpers.
- Reset or overwrite a `sending`, `sent`, or `execution_unknown` row through dedupe re-enqueue. Only unclaimed/expired `pending` rows may refresh in place.
- Delete `execution_unknown` through ordinary TTL or disabled-chat cleanup. It remains operator-visible, then moves to idempotent dead-letter audit after the separate 90-day ambiguity-retention window.

---

## 7. State / persistence

**Responsibility.** Own authoritative Telegram SQL builders and atomic mutation boundaries: subscriber/direct/preset state, pending command state, processed-update proof, cooldowns, chat migration, diagnostics, and recap preferences/targets.

Direct/local coin intent and persistent preset intent remain separate; neither setup, import, nor Mini App may flatten resolved presets into direct rows. Existing indistinguishable legacy rows remain conservatively direct/local. [Preset watchlists](./telegram-alerts.md#preset-watchlists) owns inheritance/override behavior; [Mini App portability](./telegram-mini-app.md#configuration-portability) owns signed preview/confirmation.

Unavailable pulse quality is `unknown`, never `complete`; do not write a lifecycle snapshot when pending-delivery evidence is unavailable.

**Owned files.**
- `worker/src/api/telegram-webhook-store.ts`, `worker/src/api/telegram-store/*` — stable import barrel and topic-specific SQL builders.
- `worker/src/telegram/webhook/chat-member.ts` — chat-admin read policy.
- `worker/src/telegram/store/usage-analytics.ts`, `worker/src/telegram/adoption/adoption-analytics.ts` — usage/lifecycle and identifier-free adoption.
- `worker/src/telegram/webhook/webhook-registration.ts` — registration cadence/cache state; HTTP through Outbound.
- D1 schemas: [purpose map](#d1-schema); migrations own columns/keys/indexes. No KV: snapshots, backoff, cooldown/flood, admin/welcome, registration and degradation markers use the D1 `cache` table. Exact chat-key cleanup is owned by `prepareDeleteTelegramChatCacheStatements` in `worker/src/telegram/store/subscriber-lifecycle.ts`, not a manually maintained key roster.

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
- `worker/src/telegram/delivery/telegram.ts` (`postTelegramBotApi`, `sendToChat`, `sendBatch`, `answerCallbackQuery`, `editMessage`, `escapeHtml`, link-preview helpers, send-error classification)
- `worker/src/api/telegram-webhook-replies.ts` (`sendAuditedTelegramReply` — chunks + diagnostics + replyMarkup)
- `worker/src/telegram/common/log.ts` (structured Telegram event logger)

**Allowed inbound dependencies.** Action handlers, Callback routing, Ingress (for replies), Dispatch (alert sends), Queue (drains), admin routes, daily digest, registration reconciliation, chat-admin membership probes.

**Allowed outbound dependencies.** Native `fetch`, Common.

**Must NOT.**
- Know about subscribers, snapshots, or commands. Send what you are given.
- Inline HTML formatting beyond `escapeHtml`. Body composition lives in `worker/src/telegram/common/alerts-formatting.ts` or per-handler builders.

---

## 9. Mini App surface

**Responsibility.** Serve static Mini App UI and signed session/mutation routes, using shared versioned contracts and State helpers. [Mini App](./telegram-mini-app.md) owns launch/auth/client-state behavior; this seam receives no webhook updates and calls no Bot API.

**Owned files.**
- `src/app/pharoswatchbot/app/page.tsx`
- `src/app/pharoswatchbot/app/client.tsx`
- `src/app/pharoswatchbot/app/components/*`
- `src/app/pharoswatchbot/app/constants.ts`
- `src/app/pharoswatchbot/app/error-messages.ts`
- `src/app/pharoswatchbot/app/format.ts`
- `src/app/pharoswatchbot/app/mini-app-api.ts`
- `src/app/pharoswatchbot/app/telegram-sdk.ts`
- `src/app/pharoswatchbot/app/telegram-theme.ts`
- `src/app/pharoswatchbot/app/types.ts`
- `src/app/pharoswatchbot/app/use-mini-app-view.ts`
- `src/app/pharoswatchbot/app/use-mini-app-mutations.ts`
- `src/app/pharoswatchbot/app/use-telegram-bridge.ts`
- `src/app/pharoswatchbot/app/use-telegram-main-button.ts`
- `worker/src/api/telegram-mini-app.ts`
- `worker/src/api/telegram-mini-app-state.ts`
- `worker/src/api/telegram-mini-app-mutations.ts`
- `worker/src/telegram/recap/recap-store.ts` (shared generation-fenced recap preference mutation)
- `worker/src/telegram/mini-app/mini-app-auth.ts`
- `shared/lib/telegram-mini-app-contract.ts`
- `shared/lib/telegram-mini-app-catalog.ts`
- `shared/lib/telegram-presets.ts`
- `shared/data/stablecoins/coins.telegram-mini-app.generated.json`
- `worker/src/api/telegram-mini-app-rate-limit.ts`
- `shared/lib/telegram-recap-policy.ts`
- `shared/lib/iana-local-time.ts`

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

- `worker/src/telegram/common/constants.ts` — shared delivery-state type and pending-only predicate; central tokens (snooze/step/view/chunk, ingress, queue, TTL).
- `worker/src/telegram/common/alerts-parser.ts` — ticker resolution, subscribe/set argument parsing, disambiguation parsing, and close-match suggestions.
- `worker/src/telegram/common/alerts-formatting.ts` — alert message formatting, `splitMessage`, and `SNOOZE_REPLY_MARKUP`.
- `worker/src/telegram/common/format-age.ts` — compact relative-age labels shared by command and status surfaces.
- `worker/src/telegram/common/coin-dedupe.ts` — shared stablecoin de-duplication helpers for alert and command coin lists.
- `worker/src/telegram/common/presets.ts` — preset definitions and resolution.
- `worker/src/telegram/digest/digest-appendices.ts` — channel digest appendices (cemetery, newly tracked).
- `worker/src/telegram/common/log.ts` — structured logging.
- `worker/src/telegram/outbox/pending-provenance.ts` — bounded target-group scope and markup-policy serialization/parsing shared by Dispatch and Queue.
- `shared/lib/telegram-alert-families.ts` — persistence manifest plus the trusted active-watcher/subscription/preset SQL fragments derived from it, shared by pulse, lifecycle analytics, and the offline load guard. All six direct families participate; presets remain DEWS/depeg/safety only.
- `worker/src/telegram/common/usd-profile.ts` — shared plain/signed compact-USD profiles. API formatters retain their null-producing input guards; alert context retains the visible `n/a` fallback.
- `shared/lib/telegram-bot-registration.ts` — runtime-neutral `TELEGRAM_COMMAND_REFERENCE`/registration manifest: syntax, audience, examples, help and deprecated aliases. `COMMAND_HANDLERS` remains the handler authority; metadata is not a pipeline.
- `shared/lib/telegram-recap-policy.ts` — runtime-neutral recap cadence, freshness, page, message, priority, TTL, and load bounds.
- `shared/lib/iana-local-time.ts` — validated IANA local-date/hour scheduling and deterministic DST handling shared by controls and planner.

---

## Structural change policy

Behavior changes stay inside current seams. Bug fixes, handlers, tests and fields inside an owner are routine. Cross-seam extraction/moves, new top-level directories, dispatch-registry restructuring or a new pipeline/framework require updating ownership and dependency direction in the same change.

`scripts/ci/check-architecture-boundaries.ts` enforces `telegram-public-surface` on production Worker sources outside the Telegram owners. Each resolved incoming edge must match an exact importer/entry-module pair; static imports, re-exports, literal dynamic imports and authored type-only dependencies are covered. The owners are the Telegram API/HTTP-handler implementations, `worker/src/cron/telegram/`, and the feature core in `worker/src/telegram/`. Imports between these owners are internal; passing through a permitted public entry does not prohibit its internal dependencies. Unrelated features do not gain a directory-wide or scheduled-handler exemption.

Telegram moves must rename the corresponding public-entry allowlist paths atomically with their callers, removing obsolete locations rather than adding compatibility re-exports. The checker recognizes the feature subtree, so a new deep destination import is not an escape hatch. `scripts/ci/check-worker-package.ts` separately rejects Heavy source-map reachability into Telegram's HTTP-bearing destinations (`webhook/`, including pulse, `mini-app/`, `adoption/`, and `admin/`); it does not ban generic delivery or outbox modules.

Re-evaluate a boundary when one fix repeatedly crosses seams, callbacks accumulate unrelated dependencies, Ingress becomes business logic, or SQL/policy is duplicated. Delivery policy stays in `shared/lib/telegram-delivery-policy.ts`; State owns shared SQL. These are design signals, not numerical acceptance gates.

---

## Architectural tension flagged but not prescribed

Revisit ownership, rather than adding another abstraction, if setup grows a third pending-action type or a second operator write surface appears. Setup deliberately shares disambiguation TTL/cleanup; broadcast deliberately shares Dispatch targeting despite its HTTP entrypoint. Existing callback mutations stay in Store/settings helpers, and Common alert callers import `worker/src/telegram/common/alerts-parser.ts` or `worker/src/telegram/common/alerts-formatting.ts` directly.

## D1 Schema

DDL authority is the active [Worker migration stream](../worker/migrations/MANIFEST.md), including `worker/migrations/0000_baseline.sql`. The manifest owns squashed lineage; do not treat historical individual migrations as executable files. This map names purposes, not column/constant copies:

| Table family | Purpose / seam |
| --- | --- |
| `telegram_subscribers`, `telegram_subscriptions`, `telegram_preset_subscriptions` | Chat defaults, independent direct/local preferences and dynamic preset follows — State |
| `telegram_pending_disambiguation` | TTL/initiator-owned selection, bulk confirmation and setup state — State / Ingress |
| `telegram_pending_alerts`, `telegram_alert_dead_letters` | Authoritative queued effects and terminal audit — Queue |
| `telegram_processed_updates`, `telegram_webhook_operation_mutations` | Owner/generation update intent, atomic mutation proof and effect fence — Ingress / State |
| `telegram_alert_source_events`, `telegram_alert_source_resolution_pages` | Immutable sources, resumable resolution and planning ownership — Dispatch |
| `telegram_alert_source_resolution_memberships`, `telegram_alert_source_resolution_targets` | Normalized preset membership/follower lineage — Dispatch |
| `telegram_alert_planning_subscribers` | Frozen candidate cohort and planning decisions — Dispatch |
| `telegram_alert_target_plan_pages`, `telegram_alert_target_plans`, `telegram_alert_target_plan_items`, `telegram_alert_target_expiry_progress` | Exact rendered manifest, bounds, item coverage and bounded expiry debt — Dispatch |
| `telegram_alert_jobs`, `telegram_alert_job_targets`, `telegram_alert_job_target_items` | Exclusive final delivery truth and source-item lineage — Dispatch / Queue |
| `telegram_freeze_alert_events`, `telegram_freeze_alert_targets` | Immutable Tape/blacklist identity and one-time freeze cohort — Dispatch |
| `telegram_recap_preferences`, `telegram_recap_targets` | Private local schedule, exact recap plan and consumed-window outcome — State / Dispatch / Queue |
| `telegram_usage_daily`, `telegram_adoption_daily`, `telegram_adoption_retention_daily` | Identifier-free usage/funnel and feature-retention aggregates — State |
| `telegram_adoption_ingress_quota`, `telegram_adoption_client_quota` | Global and dedicated-pepper HMAC-IP CTA ingress ceilings — State |
| `telegram_watcher_lifecycle_daily`, `telegram_watcher_lifecycle_events_daily` | Persisted lifecycle history and atomic transition counts — State |
| `telegram_chat_delivery_diagnostics` | Successful alert vs reply times and failure class — Outbound / State |
| `telegram_transport_circuit`, `telegram_transport_failure_observations`, `telegram_delivery_pauses` | Durable circuit, short-lived outage inference, generation-fenced pauses — Outbound |
| `telegram_digest_outbox` | Exact edition/photo/text transport — Digest |

Indexes are part of that migration authority. The [load harness](./telegram-alerts.md#load-simulation-and-query-plans) protects hot direct/global/candidate, pending, and status read plans instead of duplicating index DDL here.

`/unsubscribe all` clears per-coin subscriptions, preset follows, and all-stablecoin alert flags, which stops alerts for that chat. It does not immediately erase the `telegram_subscribers` row, processed-update idempotency rows, delivery diagnostics, or historical aggregate counters needed for abuse prevention, retry safety, and operations.

**Inactive subscribers.** `telegram-inactive-cleanup` uses the `daily0300Utc` lane behind the seven-day `cron:telegram-inactive-cleanup:last-run` guard. At 180 inactive days a profile is eligible only with every global flag off, no preset/pending/disambiguation state, no enabled recap, and only inert direct rows. Inert means all family flags **and override markers** off, no snooze and no tuning: explicit-off choices retain the profile. Live follows never expire for inactivity; no re-engagement warning is sent to ineligible profiles. Indexed scan caps at 100 atomic cascades/run; each child delete rechecks eligibility so returning/new intent survives. Latest seven-day item count supplies `inactiveSubscribersCleanedThisWeek`.

**User deletion and expiry.** Pending disambiguation uses command TTL. Sent/expired/cancelled/permanent queue rows leave live transport, with dead-letter evidence where applicable; expired-row diagnostic-copy failure logs a bypass and still deletes fenced live work. `/forget` immediately deletes subscriber-owned settings, diagnostics, pending/freeze/recap/planning/plan/target/item/dead-letter/transport-observation state plus exact/prefix cache residue from `prepareDeleteTelegramChatCacheStatements` (`worker/src/telegram/store/subscriber-lifecycle.ts`). `/unsubscribe all` stops follows without immediate erasure.

**Retention** (`telegram-retention-cleanup`):

| Evidence | Retention / dependency guard |
| --- | --- |
| Terminal candidate/plan-page/item/expiry workflow | 24h recovery grace |
| Settled targets, exact plans/jobs/resolution/source payloads | 14d; delete lineage first and source/plan only after no retained target depends on it |
| Legacy terminal targets without plan generation | 14d only with no pending/sending/claimed/unknown effect; source-less terminal jobs only after targets gone |
| Expired source-less discovered/queued jobs and unresolved sources with no dependent workflow/target/job | 30d |
| Unresolved/unknown effects, degraded job audit, dead letters, freeze audit | 90d; no supported operator replay |
| Usage/adoption/feature-retention aggregates | 400d |
| CTA quota buckets | 2d |
| Mini App first-mutation correlation | 30min; `/forget` immediately clears it |

Ordered SQL batches replace uncapped deletion: 10,000 rows/pass normally, up to 100,000/table/run for high-volume workflow/replay. Processed updates use 1,000-row batches, two-second internal budget, 5,000-row ceiling and a 5,001-row debt probe (exact below limit, lower bound at saturation). Debt/saturation sets `runBudgetTruncated` and per-table `cappedAtLimit`. High-growth passes report cutoffs/limit/deletes/oldest remaining and eligible clocks/duration/isolated errors; one family error degrades the cron while others continue. Dead-letter evidence survives the 14-day workflow window.

Telegram custom Worker logs are deliberately non-correlatable to a chat. `worker/src/telegram/common/log.ts` has a closed compile-time schema and independent runtime allowlist for operation/module labels, bounded counts, status codes, retry timing and fixed error categories. It drops raw chat/user/update/callback/pending/source-event IDs, content, URLs, tokens/secrets, `initData`, arbitrary error strings, arrays and objects; allowed strings are bounded and scrubbed. Never add unkeyed hashes or pseudonymous chat keys to restore correlation. Query restricted D1 rows through [operator queries](./runbooks/telegram-operator-queries.md) for exact evidence. Expiry cleanup logs an aggregate summary, not per-target records.

Cloudflare Workers Logs processes sampled custom records under the Cloudflare account permissions configured outside this repository. `worker/wrangler.toml` enables observability and invocation logs with `head_sampling_rate = 0.1`; the repository configures no separate Workers Logpush archive and no Telegram-specific/provider retention duration. Treat console logs as sampled, short-lived operational hints, not the durable incident ledger.

[Update deduplication](./telegram-alerts.md#update-deduplication) owns processed/planned/started/unknown behavior and retention. Local mutation proof and claim loss share one D1 transaction; the effect fence is crossed only at an irreversible Bot API call. Status lifecycle counts are diagnostics, not replay authority.

When Telegram upgrades a group to a supergroup, the webhook handles `migrate_to_chat_id` and `migrate_from_chat_id` service messages before command parsing. The migration helper merges the old numeric chat ID into the new one across subscriber state, per-coin subscriptions, preset follows, pending selections, normalized source-resolution targets, planning snapshots, rendered target plans, pending/dead-letter delivery rows, alert job targets and their item lineage, transport observations, delivery diagnostics, processed-update chat references, and known exact D1 cache keys such as `telegram:chat-admins:<chat_id>` and `telegram:group-welcome:<chat_id>`. Pre-handoff planned targets are cancelled before the chat ID moves so a plan rendered for the old destination cannot be replayed against the new chat. The helper is idempotent because Telegram can deliver either service message first.

When `my_chat_member` reports that a group or supergroup removed the bot
(`left`/`kicked`), the webhook immediately runs the same subscriber-state
cascade as `/forget` for that chat and clears the group welcome/admin cache
keys. Processed-update idempotency rows and aggregate usage counters are
retained.

## Secrets and Bindings

The complete binding contract is [Worker Env](./worker-infrastructure.md#env-interface) and its [generated binding inventory](./process/worker-infrastructure-appendix.md#binding-inventory). Do not mirror the inventory here. [Operational notes](./telegram-alerts.md#operational-notes) owns token absence, registration and audience/operator credential separation.

Webhook reconciliation uses the configured public webhook URL and **current** secret, with allowed updates derived from `shared/lib/telegram-bot-registration.ts`. The five-minute lane reconciles webhook, commands, profile and menu; cache/rate-limit skips and failures are distinct outcomes. Manual recovery uses `npx tsx scripts/maintenance/register-telegram.ts --action webhook` (or `commands` / `profile`).

The reconciled menu is `Manage Alerts`, a Web App link to `https://pharos.watch/pharoswatchbot/app/`. BotFather profile/preview/loading state is not reconciled; [launch surfaces](./telegram-mini-app.md#launch-surfaces) and the [BotFather runbook](./runbooks/telegram-mini-app-botfather.md) own it. `web_app_data` would arrive inside `message`; adopting `sendData` requires a trust-boundary review, never implicit authorization.

### Webhook Secret Rotation

[Secret rotation](./runbooks/telegram-secret-rotation.md) is the operational authority. The receiver accepts current or previous webhook secret while both are configured; the up-to-24-hour overlap is operator policy, not a timestamp gate. Registration sends only the current secret. Previous bot tokens validate signed Mini App sessions only, never outbound sends.
