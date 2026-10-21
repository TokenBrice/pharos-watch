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

Settings adapters validate transport codes and describe the result; State / persistence owns their subscription statement assembly. `/set` executes that shared plan, while callbacks and Mini App patches compose its statements into their existing atomic mutation boundary.

---

## 1. Ingress

**Responsibility.** Authenticate `POST /api/telegram-webhook` (constant-time secret compare, no D1, before any work), claim each `update_id`, and route commands through the flood and group-admin gates. Plain text is ignored: multi-step flows use stateless buttons, so ingress reads no chat text state. A processed duplicate is acked and skipped; a thrown error releases the claim and returns non-2xx so Telegram redelivers. Replies are unfenced, so a rare duplicate reply on redelivery is accepted. [Update deduplication](./telegram-alerts.md#update-deduplication) owns the behavior; [ingress incidents](./runbooks/telegram-webhook-retry-dedupe.md) owns admission/retry diagnosis.
`worker/src/telegram/webhook/` owns this seam; the [implementation appendix](#ingress-implementation-appendix) maps entrypoints, lifecycle handling and canonical read-only projections.

Registration requests messages, callback queries and bot-membership updates only. Unsupported types, including retired inline queries and chosen-inline feedback, return `200 ok` after authentication/parsing, before D1 claims or Bot API work. No answer, notice or usage event is emitted; `/status` remains available.


**Allowed inbound dependencies.** `worker/src/index.ts` request router (this is an HTTP entrypoint).

**Allowed outbound dependencies.** Command parsing, Callback routing, Action handlers (via `COMMAND_HANDLERS`), State / persistence (for the processed-update claim, the pending-disambiguation read, the flood counter), Outbound transport (for reply helpers), Common.

**Must NOT.**
- Format alert messages — that is Action handlers / Common (`worker/src/telegram/common/alerts-formatting.ts`).
- Read alert snapshots or build subscriber queries — that is Dispatch.
- Write subscription state directly — go through State / persistence helpers.
- Reorganize `COMMAND_HANDLERS` without adding/removing a command; do not re-expand it into parallel switches.


---

## 2. Command parsing

**Responsibility.** Pure command/target/deep-link parsing; no I/O.

**Owned files.**
- `worker/src/telegram/webhook/telegram-webhook-parsing.ts`
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

**Responsibility.** Validate callback prefixes against `CALLBACK_ACTIONS` before handler D1 work, authorize mutating group actions, invoke shared builders/store helpers, and acknowledge the callback. Ingress owns flood admission; `setup:*` and `settings:*` have bounded sub-dispatchers. [Commands](./telegram-alerts.md#commands) owns callback behavior.

**Owned files.**
- `handleCallbackQuery` in `worker/src/telegram/webhook/telegram-webhook-update-dispatch.ts` — router entry.
- `worker/src/telegram/callbacks/` — registry and per-action implementation.
- `worker/src/telegram/webhook/telegram-webhook-setup.ts` — state machine shared with Ingress ticker input.
- `worker/src/telegram/webhook/telegram-webhook-settings.ts`, `telegram-webhook-settings-render.ts`, `telegram-webhook-settings-mutations.ts`, `telegram-webhook-settings-shared.ts` — settings subsystem.

**Allowed inbound dependencies.** Ingress only (`handleCallbackQuery` is called from the update dispatcher).

**Allowed outbound dependencies.** Action handlers (re-runs `/why`, `/coverage` via the same helpers; falls through for quicksub via store helpers), State / persistence, Outbound transport, Common.

**Must NOT.**
- Bypass `CALLBACK_ACTIONS`; add every prefix and its keyboard builder together.
- Duplicate Store write logic; route new mutations through the topic modules in `worker/src/telegram/store/`.
- Inline subscription upserts for settings; use `worker/src/telegram/store/subscriptions.ts` builders to preserve `/set` parity.
- Depend on a concrete action handler; reuse its `build*Message` helper, not `handle*`.

---

## 4. Action handlers

**Responsibility.** Command-domain reads, Common response composition, Store mutations and audited transport; one handler per command.

**Owned files.**
- `worker/src/telegram/commands/` — `index.ts` dispatch, `context.ts` request shape, `action-runner.ts` shared resolution/confirmation, and per-command handlers.
- `worker/src/telegram/webhook/telegram-webhook-messages.ts`, `telegram-webhook-insights.ts`, `telegram-webhook-status.ts` — shared builders and domain loaders.

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
- `shared/types/status/telegram.ts` owns thin safety row, explanation and envelope schemas and inferred types. Persisted sources and dispatch baselines require explanations and publication identity; only the live source requires the V9 model. Admission strips unknown projection fields while retaining rating refinements, finite numbers and nullable/optional semantics. The publication writer projects already-decoded cards through `buildAlertSafetyV9SourceEnvelopeFromParts`; alert consumers assess only the persisted compact envelope plus publication health, not a decoded-response adapter.
- `five-minute-telegram.ts` owns serial orchestration and token-independent DB sidecars. [Operational notes](./telegram-alerts.md#operational-notes) owns ordering, token absence and registration outcomes.
- Reserve dispatch consumes the producer's versioned D1 envelope; it performs no reserve-adapter I/O. The producer owns admission/continuity; dispatch owns its observed/dispatched baselines.
- Freeze consumes fresh Tape through its own cursor/cohort outbox, not the five-family target-plan constraint. It still creates canonical source/job/target/item lineage and uses the same pending queue. Source suppression is revalidated for resumable candidates, queued-unsent admission and the final send CAS; cancellation records `freeze-claim-retracted`, while sent/uncertain effects remain untouched. [Tape source reconciliation](./tape-page.md#source-reconciliation) owns the hard-suppression policy.
- Freeze job counters are reconciled at handoff and by the daily TTL target sweep: once a freeze event's cohort is complete or expired and none of its targets is still planned/queued, the job is recomputed from its target rows (`sent`, or `degraded` when any target expired/failed). A sent-state checkpoint whose fenced batch commits with a short count (another owner took the row) logs a warning instead of aborting the drain run.
- `admin-telegram-broadcast.ts` is the operator write surface, using Dispatch targeting and Queue lifecycle. [Broadcast safety](./runbooks/telegram-admin-broadcast-safety.md) owns canary/TTL authority; [operator queries](./runbooks/telegram-operator-queries.md) owns read-only incident access. There is no supported operator replay/clear/pause mutation.

The [dispatch implementation appendix](#dispatch-implementation-appendix) maps concrete owners and their colocated suites; imports remain direct, never compatibility barrels.


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

**Responsibility.** Own queue enqueue/provenance, claims, current-preference revalidation, effect fence, retry/backoff, terminal projection, dead letters, expiry, and blocked-chat lifecycle. [Delivery persistence](./telegram-alerts.md#delivery-persistence) owns the behavioral contract. After a request starts, only confirmed rejection may return the exact sending generation to pending; ambiguity never auto-replays. A late pre-send CAS response may release its exact generation only with known-unattempted evidence. Confirmed migration archives the old effect before the shared chat-ID migration.

Queue terminal evidence is source-scoped: the exact source-event and pending-dedupe pair, never a recurring body hash, owns status, cancellation and final delivery. Source-less legacy rows do not mutate alert targets. Cleanup repeats the selected lifecycle tuple through audit, terminal projection and deletion; a refreshed row is a different lifecycle even when its id is reused. TTL is a current-clock send-admission cutoff, not permission to rewrite an already-attempted outcome. Chat-scoped Retry-After is indexed, set-based pending-row propagation under the confirmed attempt's owner/generation proof, not a global transport pause or a TTL extension.

The chat deadline is also stored independently in D1 `cache` under `telegram:chat-send-backoff:<chatId>`, monotonically checkpointed under the same sending proof. All pending enqueue paths and retry transitions inherit it even after the last carrier row disappears. Bounded pending maintenance removes only expired deadlines; chat erasure removes the exact key and migration takes the numeric maximum.

**Owned files.**
- `worker/src/cron/telegram/delivery/` (claim/drain, backoff, cleanup, dead-letter, preference revalidation, lifecycle, outcome and target-status modules; no barrel)
- `worker/src/telegram/outbox/pending-queue.ts` (enqueue, dedupe-key construction, priority and upsert SQL) and `worker/src/telegram/outbox/pending-capacity.ts` (capacity/watchdog read model)
- `shared/lib/telegram-delivery-policy.ts` owns runtime-neutral queue, batch, TTL, rate-limit, deadline, and load-model policy. `worker/src/telegram/common/constants.ts` re-exports the established Worker import surface.
- `shared/lib/telegram-alert-families.ts` owns family persistence identifiers used by dispatch, broadcast targeting and delivery revalidation. Local projections derive from `TELEGRAM_ALERT_PERSISTENCE`; the fan-out table retains event-route semantics only. Freeze outbox expiry uses `TELEGRAM_ALERT_TTL_SEC.freeze`, the same authority as queue admission.

**Allowed inbound dependencies.** Dispatch (risk-alert enqueue), Admin Telegram routes (`admin-telegram-broadcast.ts`), Callback routing only via the `SNOOZE_REPLY_MARKUP` keyboard in `worker/src/telegram/common/alerts-formatting.ts`.

**Allowed outbound dependencies.** Outbound transport, State / persistence (cache helpers for global backoff), Common.

**Must NOT.**
- Be opened by Ingress directly. Ingress should never enqueue.
- Re-introduce delivery-policy constants outside `shared/lib/telegram-delivery-policy.ts`.
- Mutate `telegram_subscribers` alert flags except via the 2-strike block-disable path. Subscription state is owned by State / persistence helpers.
- Reset or overwrite a `sending`, `sent`, or `execution_unknown` row through dedupe re-enqueue. Only unclaimed/expired `pending` rows may refresh in place.
- Delete `execution_unknown` through ordinary TTL or disabled-chat cleanup. It remains operator-visible, then moves to idempotent dead-letter audit after the separate 90-day ambiguity-retention window.

---

## 7. State / persistence

**Responsibility.** Own authoritative subscriber/direct/preset SQL, pending state, the processed-update claim, flood/cooldown counters, chat migration and diagnostics. Retired recap tables remain for retention/privacy erasure pending separate destructive cleanup.

Direct/local coin intent and persistent preset intent remain separate; neither setup nor Mini App bulk edits may flatten resolved presets into direct rows. Existing indistinguishable legacy rows remain conservatively direct/local. [Preset watchlists](./telegram-alerts.md#preset-watchlists) owns inheritance/override behavior. Watchlist token import/export is retired in the bot and the Mini App ([portability](./telegram-mini-app.md#configuration-portability)); its portable-import callback payload is retired too; malformed or retired confirmation payloads are rejected without mutation, while ordinary command bulk confirmations remain in Callback routing.

`shared/types/status/telegram.ts` owns tuning value tuples, schema primitives and derived types; `shared/lib/telegram-alert-families.ts` owns reversible settings callback codes. DEWS classification remains owned by `shared/lib/classification/risk.ts`. The Store's `prepareSettingToSubscriptions` assembles subscriber activity, preference generation, direct override and tuning writes without executing them, preserving composition with webhook operation proof. The first-follow milestone can be claimed once by an outer Mini App batch rather than by each nested setting.

Subscriber UPSERTs use common chat/username/activity inputs and one SQL builder. Global bumps and overrides are exclusive with a runtime conflict guard; overrides retain precedence over per-coin bumps. Single-column timezone/snooze inserts rely on D1 defaults for untouched columns. Undefined preserves a preference; null clears it. Username coalescing, quiet hours, generation increments and operation-proof rollback are unchanged.

Mini App bounded direct patches (bulk edit, single removal and their undo) run in one generation-fenced atomic batch: ensure the parent when requested, claim the generation lease, apply guarded preference and first-follow writes, restore explicit undo snoozes, restore the next generation, and prove the result from the lease claim. The batch retains D1 bind/statement bounds and overload retry.

Unavailable pulse quality is `unknown`, never `complete`; do not write a lifecycle snapshot when pending-delivery evidence is unavailable.

Lifecycle family opt-in totals and the all-types conjunction share manifest-derived direct/preset/global predicates, counting each chat once per family; presets contribute only their supported families. Delivery SLI attribution derives from persisted item-key patterns, not the target's routing type: depeg intentionally matches `depeg-%`, while the other families use colon prefixes. Multiple recognized families count as mixed; targets without a recognized family count as unknown.

Digest appendix preparation exposes immutable-edition `successActions`, not a separate commit callback. Only `worker/src/telegram/outbox/digest-outbox.ts` applies these post-delivery cache writes, atomically with the exact edition's fenced `sent` transition; preparation retains immediate writes solely for safe first-run/reseed baselines. The [digest outbox contract](./runbooks/telegram-digest-outbox.md#contract) owns finalization and replay safety.

Delivery diagnostics reconcile atomically across command replies and alert batches: each independent success clock retains its greatest observed timestamp (null until observed), and attempt/update clocks never decrease. Older attempts may contribute genuine historical successes but cannot change the latest attempt's failure class. At equal-second attempts, failures take precedence over successes; among failures the last persisted observation wins, matching within-batch coalescing. A strictly newer successful attempt clears the failure class. Diagnostics remain best-effort and never block replies or delivery.

`/forget` erases subscriber-owned rows and raw chat cache keys while retaining processed-update replay proof. Mini App abuse admission is independent, not subscriber-owned: only anonymous time-scoped HMAC keys, counters and the original admission clock survive, for at most the remainder of the anchored 30-second window. They never extend on forget/denial or identify a later window. Expired anonymous rows are inert and physically removed by the existing daily bounded cache prune; no raw chat-key retention or precise 30-second physical deletion is implied. [Mini App auth](./telegram-mini-app.md#auth-model) owns admission and identity details.

Chat migration derives insert/select columns and conflict assignments from one ordered local descriptor per merged table, including copy-only identities. Paired quiet-hour windows, null-safe minima, snooze normalization and generation increments retain explicit merge rules; repeated service events preserve complete destination rows. Child-table order, collision cleanup, private recap purge and processed-update evidence remain unchanged.

**Owned files.**
- `worker/src/telegram/store/*` — topic-specific SQL builders, imported directly (no barrel).
- Cached chat administrators in `worker/src/telegram/webhook/telegram-webhook-auth.ts` — denial-hint names only, never authorization.
- `worker/src/telegram/store/usage-analytics.ts` — identifier-free usage and lifecycle aggregates.
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
- `worker/src/telegram/delivery/telegram.ts` (`postTelegramBotApi`, `sendToChat`, `schedulePerChatBatches`, `answerCallbackQuery`, `editMessage`, `escapeHtml`, link-preview helpers, send-error classification)
- `worker/src/telegram/webhook/telegram-webhook-replies.ts` (`sendAuditedTelegramReply` — chunks + diagnostics + replyMarkup)
- `worker/src/telegram/common/log.ts` (structured Telegram event logger)

**Allowed inbound dependencies.** Action handlers, Callback routing, Ingress (for replies), Dispatch (alert sends), Queue (drains), admin routes, daily digest, registration reconciliation, chat-admin membership probes.

**Allowed outbound dependencies.** Native `fetch`, Common.

Distinct-chat scheduling stays in `schedulePerChatBatches`; the durable queue drain supplies the send callback and persisted markup/preview policy. Recovery resumes authoritative target manifests and normalized item lineage, rather than reconstructing a send-only batch or subtracting handled items from fresh fan-out.

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
- `worker/src/telegram/mini-app/telegram-mini-app.ts`
- `worker/src/telegram/mini-app/telegram-mini-app-state.ts`
- `worker/src/telegram/mini-app/telegram-mini-app-mutations.ts`
- `worker/src/telegram/mini-app/mini-app-auth.ts`
- `shared/lib/telegram-mini-app-contract.ts`
- `shared/lib/telegram-mini-app-catalog.ts`
- `shared/lib/telegram-presets.ts`
- `shared/data/stablecoins/coins.telegram-mini-app.generated.json`
- `worker/src/telegram/mini-app/telegram-mini-app-rate-limit.ts`

**Allowed inbound dependencies.** The Next.js route `/pharoswatchbot/app/`, Worker route registry entries for `POST /api/telegram-mini-app/session` and `POST /api/telegram-mini-app/mutate`, and private-chat Web App buttons generated by Action handlers / Callback routing.

**Allowed outbound dependencies.** State / persistence helpers for subscription writes and cooldowns, Worker preset resolution for dynamic targets, `telegram-usage-analytics` for validated usage events, the shared Mini App contract/catalog and preset definitions, shared endpoint metadata, shared stablecoin metadata, and the Telegram WebApp browser bridge on the frontend.

**Must NOT.**
- Accept mutation auth older than the 5-minute mutation window.
- Treat a bulk preview as a mutation: it uses the 24-hour signed-read window and session throttle, while bulk confirmation remains a 5-minute mutation and must revalidate its exact preview.
- Flatten preset/global coverage into direct rows during bulk editing; bulk confirmation and undo may change only the bounded direct-row set and must fail stale on generation/fingerprint drift.
- Mutate group/supergroup/channel chat rows until a fresh admin verification path and group-scoped launch ownership model exist.
- Write analytics, aggregate counters, or cooldown rows before signed `initData` validation succeeds. Body-too-large, malformed JSON, and schema-denied Mini App requests must return without D1 writes because the endpoints are public API-key-exempt surfaces.
- Apply or replay a mutation when the advertised contract/catalog version does not match. Version mismatch must stay a pre-write `409`; the client may refresh its static bundle once but must require a new user action for the mutation.
- Duplicate per-coin or preset write SQL outside the existing State / persistence helpers.
- Use `Telegram.WebApp.sendData` without updating `allowed_updates` and treating incoming `web_app_data` as untrusted.

---

## Common modules

Files any seam may import:

- `worker/src/telegram/common/constants.ts` — shared delivery-state type and pending-only predicate; central tokens (snooze/step/view/chunk, ingress, queue, TTL).
- `worker/src/telegram/common/alerts-parser.ts` — ticker resolution, subscribe/set argument parsing, disambiguation parsing, and close-match suggestions.
- `worker/src/telegram/common/alerts-formatting.ts` — alert message formatting, `splitMessage`, and `SNOOZE_REPLY_MARKUP`.
- `worker/src/telegram/common/mini-app-url.ts` — pure Mini App URL and `startapp` context builder shared by alert formatting and HTTP-facing controls; does not import HTTP-bearing Telegram modules.
- `worker/src/telegram/common/format-age.ts` — compact relative-age labels shared by command and status surfaces.
- `worker/src/telegram/common/coin-dedupe.ts` — shared stablecoin de-duplication helpers for alert and command coin lists.
- `worker/src/telegram/common/presets.ts` — preset definitions and resolution.
- `worker/src/telegram/digest/digest-appendices.ts` — channel digest appendices (cemetery, newly tracked).
- `worker/src/telegram/common/log.ts` — structured logging.
- `worker/src/telegram/outbox/pending-provenance.ts` — bounded target-group scope and markup-policy serialization/parsing shared by Dispatch and Queue.
- `shared/lib/telegram-alert-families.ts` — persistence manifest plus the trusted active-watcher/subscription/preset SQL fragments derived from it, shared by pulse, lifecycle analytics, and the offline load guard. All six direct families participate; presets remain DEWS/depeg/safety only.
- `worker/src/telegram/common/usd-profile.ts` — shared plain/signed compact-USD profiles. API formatters retain their null-producing input guards; alert context retains the visible `n/a` fallback.
- `shared/lib/telegram-bot-registration.ts` — runtime-neutral `TELEGRAM_COMMAND_REFERENCE`/registration manifest: syntax, audience, examples, help and deprecated aliases. `COMMAND_HANDLERS` remains the handler authority; metadata is not a pipeline.

---

## Structural change policy

Behavior changes stay inside current seams. Bug fixes, handlers, tests and fields inside an owner are routine. Cross-seam extraction/moves, new top-level directories, dispatch-registry restructuring or a new pipeline/framework require updating ownership and dependency direction in the same change.

`scripts/ci/check-architecture-boundaries.ts` enforces `telegram-public-surface` on production Worker sources outside the Telegram owners. Each resolved incoming edge must match an exact importer/entry-module pair; static imports, re-exports, literal dynamic imports and authored type-only dependencies are covered. The owners are the feature core in `worker/src/telegram/` and the scheduler implementation in `worker/src/cron/telegram/`; registered route and HTTP-handler adapters remain external consumers. Imports between the two owners are internal; passing through a permitted public entry does not prohibit its internal dependencies. Unrelated features do not gain a directory-wide or scheduled-handler exemption.

Telegram moves must rename the corresponding public-entry allowlist paths atomically with their callers, removing obsolete locations rather than adding compatibility re-exports. The checker recognizes the feature subtree, so a new deep destination import is not an escape hatch. `scripts/ci/check-worker-package.ts` separately rejects Heavy source-map reachability into Telegram's HTTP-bearing destinations (`webhook/`, including pulse, `commands/`, `callbacks/`, `mini-app/`, and `admin/`); it does not ban generic delivery or outbox modules.

Re-evaluate a boundary when one fix repeatedly crosses seams, callbacks accumulate unrelated dependencies, Ingress becomes business logic, or SQL/policy is duplicated. Delivery policy stays in `shared/lib/telegram-delivery-policy.ts`; State owns shared SQL. These are design signals, not numerical acceptance gates.

---

## Architectural tension flagged but not prescribed

Revisit ownership, rather than adding another abstraction, if setup grows a third pending-action type or a second operator write surface appears. Setup deliberately shares disambiguation TTL/cleanup; broadcast deliberately shares Dispatch targeting despite its HTTP entrypoint. Existing callback mutations stay in Store/settings helpers, and Common alert callers import `worker/src/telegram/common/alerts-parser.ts` or `worker/src/telegram/common/alerts-formatting.ts` directly.

## D1 Schema

DDL authority is the active [Worker migration stream](../worker/migrations/MANIFEST.md), including `worker/migrations/0000_baseline.sql`. The manifest owns squashed lineage; do not treat historical individual migrations as executable files. This map names purposes, not column/constant copies:

| Table family | Purpose / seam |
| --- | --- |
| `telegram_subscribers`, `telegram_subscriptions`, `telegram_preset_subscriptions` | Chat defaults, independent direct/local preferences and dynamic preset follows — State |
| `telegram_pending_disambiguation` | Retired text state: ingress no longer reads it and selection/confirmation/setup use stateless buttons. Only the expiry cleanup still touches it until the drop. |
| `telegram_pending_alerts`, `telegram_alert_dead_letters` | Authoritative queued effects and terminal audit — Queue |
| `telegram_processed_updates` | Update-id claim (`processing` → `processed`; released on error) — Ingress / State. Intent/effect columns are no longer written. |
| `telegram_webhook_operation_mutations` | Retired; no writer or reader. Dropped in a separate destructive rollout. |
| `telegram_alert_source_events`, `telegram_alert_source_resolution_pages` | Immutable sources, resumable resolution and planning ownership — Dispatch |
| `telegram_alert_source_resolution_memberships`, `telegram_alert_source_resolution_targets` | Normalized preset membership/follower lineage — Dispatch |
| `telegram_alert_planning_subscribers` | Frozen candidate cohort and planning decisions — Dispatch |
| `telegram_alert_target_plan_pages`, `telegram_alert_target_plans`, `telegram_alert_target_plan_items`, `telegram_alert_target_expiry_progress` | Exact rendered manifest, bounds, item coverage and bounded expiry debt — Dispatch |
| `telegram_alert_jobs`, `telegram_alert_job_targets`, `telegram_alert_job_target_items` | Exclusive final delivery truth and source-item lineage — Dispatch / Queue |
| `telegram_freeze_alert_events`, `telegram_freeze_alert_targets` | Immutable Tape/blacklist identity and one-time freeze cohort — Dispatch |
| `telegram_recap_preferences`, `telegram_recap_targets` | Retired personalized-recap audit only; expiry and `/forget` erasure remain, no planner or preference mutation |
| `telegram_usage_daily` | Identifier-free usage aggregates — State |
| `telegram_adoption_daily`, `telegram_adoption_retention_daily`, `telegram_adoption_ingress_quota`, `telegram_adoption_client_quota` | Retired sign-up funnel aggregates and HMAC-IP CTA quota buckets; no writers, retention-pruned until the coordinated drop |
| `telegram_watcher_lifecycle_daily`, `telegram_watcher_lifecycle_events_daily` | Persisted lifecycle history and atomic transition counts — State |
| `telegram_chat_delivery_diagnostics` | Successful alert vs reply times and failure class — Outbound / State |
| `telegram_transport_circuit`, `telegram_transport_failure_observations`, `telegram_delivery_pauses` | Durable circuit, short-lived outage inference, generation-fenced pauses — Outbound |
| `telegram_digest_outbox` | Exact edition/photo/text transport — Digest |

Indexes are part of that migration authority. The [load harness](./telegram-alerts.md#load-simulation-and-query-plans) protects hot direct/global/candidate, pending, and status read plans instead of duplicating index DDL here.

`/unsubscribe all` clears per-coin subscriptions, preset follows, and all-stablecoin alert flags, which stops alerts for that chat. It does not immediately erase the `telegram_subscribers` row, processed-update idempotency rows, delivery diagnostics, or historical aggregate counters needed for abuse prevention, retry safety, and operations.

**Inactive subscribers.** `telegram-inactive-cleanup` uses the `daily0300Utc` lane behind the seven-day `cron:telegram-inactive-cleanup:last-run` guard. At 180 inactive days a profile is eligible only with every global flag off, no preset/pending/disambiguation state, no enabled recap, and only inert direct rows. Inert means all family flags **and override markers** off, no snooze and no tuning: explicit-off choices retain the profile. Live follows never expire for inactivity; no re-engagement warning is sent to ineligible profiles. Indexed scan caps at 100 atomic cascades/run; each child delete rechecks eligibility so returning/new intent survives. Latest seven-day item count supplies `inactiveSubscribersCleanedThisWeek`.

**User deletion and expiry.** Pending disambiguation uses command TTL. Sent/expired/cancelled/permanent queue rows leave live transport, with dead-letter evidence where applicable; expired-row diagnostic-copy failure logs a bypass and still deletes fenced live work. `/forget` immediately deletes subscriber-owned settings, diagnostics, pending (including group prompts keyed by `initiator_user_id`)/freeze/recap/planning/plan/target/item/dead-letter/transport-observation state plus exact/prefix cache residue from `prepareDeleteTelegramChatCacheStatements` (`worker/src/telegram/store/subscriber-lifecycle.ts`). `/unsubscribe all` stops follows without immediate erasure.

**Retention** (`telegram-retention-cleanup`):

| Evidence | Retention / dependency guard |
| --- | --- |
| Terminal candidate/plan-page/item/expiry workflow | 24h recovery grace |
| Settled targets, exact plans/jobs/resolution/source payloads | 14d; delete lineage first and source/plan only after no retained target depends on it |
| Legacy terminal targets without plan generation | 14d only with no pending/sending/claimed/unknown effect; source-less terminal jobs only after targets gone |
| Expired source-less discovered/queued jobs and unresolved sources with no dependent workflow/target/job | 30d |
| Unresolved/unknown effects, degraded job audit, dead letters, freeze audit | 90d; no supported operator replay |
| Usage aggregates and residual retired funnel aggregates | 400d |
| Residual retired CTA quota buckets | 2d |
| Residual retired Mini App first-mutation correlation | 30min; `/forget` immediately clears it |

Ordered SQL batches replace uncapped deletion: 10,000 rows/pass normally, up to 100,000/table/run for high-volume workflow/replay. Processed updates use 1,000-row batches, two-second internal budget, 5,000-row ceiling and a 5,001-row debt probe (exact below limit, lower bound at saturation). Debt/saturation sets `runBudgetTruncated` and per-table `cappedAtLimit`. High-growth passes report cutoffs/limit/deletes/oldest remaining and eligible clocks/duration/isolated errors; one family error degrades the cron while others continue. Dead-letter evidence survives the 14-day workflow window.

Telegram custom Worker logs are deliberately non-correlatable to a chat. `worker/src/telegram/common/log.ts` has a closed compile-time schema and independent runtime allowlist for operation/module labels, bounded counts, status codes, retry timing and fixed error categories. It drops raw chat/user/update/callback/pending/source-event IDs, content, URLs, tokens/secrets, `initData`, arbitrary error strings, arrays and objects; allowed strings are bounded and scrubbed. Never add unkeyed hashes or pseudonymous chat keys to restore correlation. Query restricted D1 rows through [operator queries](./runbooks/telegram-operator-queries.md) for exact evidence. Expiry cleanup logs an aggregate summary, not per-target records.

Cloudflare Workers Logs processes sampled custom records under the Cloudflare account permissions configured outside this repository. `worker/wrangler.toml` enables observability and invocation logs with `head_sampling_rate = 0.1`; the repository configures no separate Workers Logpush archive and no Telegram-specific/provider retention duration. Treat console logs as sampled, short-lived operational hints, not the durable incident ledger.

[Update deduplication](./telegram-alerts.md#update-deduplication) owns the claim/processed/release behavior and retention. Legacy `planned`/`started`/`execution_unknown` rows are reclaimable after the 60-second stale window and pruned at seven days; status lifecycle counts over them are diagnostics only.

When Telegram upgrades a group to a supergroup, the webhook handles `migrate_to_chat_id` and `migrate_from_chat_id` service messages before command parsing. The migration helper merges the old numeric chat ID into the new one across subscriber state, per-coin subscriptions, preset follows, pending selections, normalized source-resolution targets, planning snapshots, rendered target plans, pending/dead-letter delivery rows, alert job targets and their item lineage, transport observations, delivery diagnostics, processed-update chat references, and known exact D1 cache keys such as `telegram:chat-admins:<chat_id>` and `telegram:group-welcome:<chat_id>`. Pre-handoff planned targets are cancelled before the chat ID moves so a plan rendered for the old destination cannot be replayed against the new chat. The helper is idempotent because Telegram can deliver either service message first. A transient D1 failure during migration returns non-2xx (claim released) so Telegram redelivers the service message; a deterministic failure is acked with `error_class = chat-migration` so it cannot hold back later updates.

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

## Ingress Implementation Appendix

**Owned files.**
- `worker/src/telegram/webhook/telegram-webhook.ts` — HTTP entry, update-id claim/release and update-shape normalization.
- `worker/src/telegram/webhook/telegram-webhook-auth.ts` — secret validation, tri-state group-admin lookup (`admin | not_admin | unknown`) and cached admin names.
- `worker/src/telegram/webhook/telegram-webhook-update-dispatch.ts` — gated message routing and the callback router.
- `worker/src/telegram/webhook/telegram-webhook-ingress-policy.ts` — command policy table, per-chat flood counter, admin and channel gates.
- `worker/src/telegram/webhook/telegram-webhook-group-welcome.ts` — group lifecycle/welcome.
- `worker/src/telegram/webhook/telegram-webhook-shared.ts` — cross-seam types/copy.
- `worker/src/telegram/store/processed-updates.ts` — processed-update claim, flood/cooldown counters, retention.

Group lifecycle remains an explicit ingress sub-seam: `telegram-webhook-group-welcome.ts` owns bot-added/removed handling and atomic welcome claims. `/start` payload kinds are classified by an exhaustive switch, so a new deep-link kind cannot silently fall into the read-only policy.

`telegram-webhook-shared.ts` is the cross-seam contract for update/pending/bulk types and framed bot copy. Command rows and alert-family lists derive from shared manifests; widening a type is routine, restructuring this contract is a seam change.

Read-only status loads the accepted yield-rankings response once and projects APY, venue, PYS and source provenance from the same canonical coin row. Status replies and coverage share that projection and its evidence formatter: stale/unknown observations retain their producer clock and reason, not the cache/publication clock. Missing rankings or a missing accepted row render unavailable; there is no raw-table fallback or independent score lookup.

## Dispatch Implementation Appendix

**Owned files.**
- `worker/src/cron/telegram/dispatch/` — alerts entrypoint, authoritative planning/handoff orchestration, source and queue lifecycle, recipient pages/routing, predicates, state and result contract.
- `worker/src/cron/telegram/sources/` — event detection, changes, snapshots, context, safety reasons, immutable source events/memberships and item lineage.
- `worker/src/cron/telegram/target-plans/` — direct concrete modules for source state, cohort horizon, materialization, delivery handoff, read model and coordinator; `telegram-alert-target-plan-contract.ts` owns bounds and payload contracts.
- `worker/src/cron/telegram/delivery/` — pending queue lifecycle plus exclusive job-target delivery outcomes and target-status projections; see Queue below.
- `worker/src/cron/telegram/freeze/` — immutable freeze source/cohort outbox with its separate schema.
- `worker/src/cron/telegram/maintenance/` — degradation watchdog, inactive cleanup and retention cleanup; physical triggers stay owned by `shared/lib/cron-jobs.ts`.
- Cron seams keep suites/support in matching `__tests__/` directories and direct imports. Source/planning hands exact targets to Delivery; Freeze retains its separate outbox. Shared queue/store/transport policy keeps its library owner.
- `worker/src/cron/digest/telegram-transport.ts` — digest channel-edition publication, outside risk targeting.
- `worker/src/telegram/common/quiet-hours.ts` — shared quiet-hours predicate and callback timezone validation.
- `worker/src/handlers/scheduled/five-minute-telegram.ts` — serial orchestration with deferred imports of cron entrypoints.
- `worker/src/telegram/admin/admin-telegram-broadcast.ts` — operator broadcast, not webhook Ingress.
