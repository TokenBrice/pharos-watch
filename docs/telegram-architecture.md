# Telegram Architecture Seams

Status: frozen for internal reorganization until **2026-06-13** (see [Freeze period](#freeze-period)).

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

**Responsibility.** Receive `POST /api/telegram-webhook` requests. Validate the shared secret (with rotation overlap). Claim the `update_id` in `telegram_processed_updates` for idempotency. Route the parsed update to either Callback routing (callback_query), chat-migration handling (`migrate_to_chat_id` / `migrate_from_chat_id` service messages), or Command parsing → Action handlers (message). Hold the dedupe, pending-disambiguation gate, group-admin gate, and per-command cooldown. Always return `200 ok` on terminal handled outcomes, `503` only on in-flight duplicates.

**Owned files.**
- `worker/src/api/telegram-webhook.ts` (entrypoint and dispatcher loop)
- `worker/src/api/telegram-webhook-auth.ts` (secret validation, group-admin gating)
- `worker/src/api/telegram-webhook-shared.ts` (types/constants used by both Ingress and Action handlers — see note below)

**Allowed inbound dependencies.** `worker/src/index.ts` request router (this is an HTTP entrypoint).

**Allowed outbound dependencies.** Command parsing, Callback routing, Action handlers (via `COMMAND_HANDLERS`), State / persistence (for the processed-update claim, the pending-disambiguation read, the cooldown gate), Outbound transport (for reply helpers), Common.

**Must NOT.**
- Format alert messages — that is Action handlers / Common (`telegram-alerts.ts`).
- Read alert snapshots or build subscriber queries — that is Dispatch.
- Write subscription state directly — go through State / persistence helpers.
- Reorganize the `COMMAND_HANDLERS` table without adding/removing a command. The two switch statements were intentionally collapsed in P1-M1; do not re-expand.

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

**Responsibility.** Translate `callback_query` updates into action invocations. Validate the `action:arg` shape against an allowlist (`CALLBACK_ACTIONS`) before any D1 touch. Per-action: validate args, gate group admins for mutating actions, call the appropriate action helper or directly persist, then `answerCallbackQuery`. Bulk `setup:*` and `settings:*` namespaces have their own sub-dispatchers for compact validation tables.

**Owned files.**
- `worker/src/api/telegram-webhook-callbacks.ts`
- `worker/src/api/telegram-webhook-setup.ts` (setup wizard state machine — invoked by both Callback routing for `setup:*` taps and by Ingress for `awaiting-ticker` text input)
- `worker/src/api/telegram-webhook-settings.ts`, `telegram-webhook-settings-render.ts`, `telegram-webhook-settings-mutations.ts`, `telegram-webhook-settings-shared.ts` (settings inline keyboard sub-system)

**Allowed inbound dependencies.** Ingress only (`handleCallbackQuery` is called from `handleTelegramWebhook`).

**Allowed outbound dependencies.** Command parsing (`parsePendingDisambiguation` for bulk-confirm), Action handlers (re-runs `/why`, `/coverage` via the same helpers; falls through for quicksub via store helpers), State / persistence, Outbound transport, Common.

**Must NOT.**
- Bypass the `CALLBACK_ACTIONS` allowlist when adding a new callback prefix. Any new prefix is a seam-relevant change — add it to the allowlist *and* to the registered keyboard builders in one commit.
- Duplicate write logic that exists in `telegram-webhook-store.ts`. The current callbacks file has a few inline `INSERT … ON CONFLICT` writes (snooze, depegstep, safetydown) that pre-date the store helpers; these are grandfathered. New mutations go through `telegram-webhook-store.ts`.
- Take a hard dependency on a specific *Action handler* implementation — when a callback needs to re-run a command, prefer the same `build*Message` helper the command uses rather than calling `handle*` from `webhook-commands/`.

---

## 4. Action handlers

**Responsibility.** The business logic per command. Read whatever DB state the command needs, build the response message via Common formatters, persist any state changes through State / persistence, send via Outbound transport. One file per command keeps the surface small.

**Owned files.**
- `worker/src/api/webhook-commands/` (full directory)
  - `index.ts` — `COMMAND_HANDLERS` dispatch table
  - `context.ts` — `WebhookCommandContext` shape passed to every handler
  - `action-runner.ts` — shared `/subscribe`, `/unsubscribe`, `/set` coin-resolution + bulk-confirm flow (also used by Ingress's disambiguation reply path)
  - One file per command: `start.ts`, `help.ts`, `list.ts`, `status.ts`, `brief.ts`, `top.ts`, `why.ts`, `coverage.ts`, `health.ts`, `subscribe.ts`, `unsubscribe.ts`, `set.ts`, `settings.ts`, `mute.ts`, `timezone.ts`, `unmutehours.ts`, `unsnooze.ts`, `cancel.ts`, `presets.ts`, `single-target.ts` (shared helper for `/why` and `/coverage`)
- `worker/src/api/telegram-webhook-messages.ts` (message builders shared across handlers)
- `worker/src/api/telegram-webhook-insights.ts` (`/top`, `/why`, `/coverage` data-loading and rendering)
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

**Responsibility.** On the dedicated 5-minute cron slot, diff DEWS / depeg / safety / launch snapshots to detect events, load matching subscribers (direct + preset + global), filter for quiet hours, snooze, dews-min-band, safety-mode, depeg-step. Build per-chat consolidated messages and chunk them. Hand the chunk queue to Queue / rate-limit / retry plus Outbound transport. Persist alert-job manifests and per-target outcomes.

**Owned files.**
- `worker/src/cron/dispatch-telegram-alerts.ts` (entrypoint and orchestration)
- `worker/src/cron/dispatch-telegram-alerts-fanout.ts` (parallel loading of subscriber inputs)
- `worker/src/cron/dispatch-telegram-state.ts` (snapshot loading + assembly)
- `worker/src/cron/dispatch-telegram-routing.ts` (event routing → per-chat alert bundles, quiet-hours filter, chunk expansion)
- `worker/src/cron/dispatch-telegram-delivery.ts` (delivery orchestration: budget split, fresh send, retry/overflow enqueue, global backoff stamp)
- `worker/src/cron/telegram-alert-snapshots.ts`, `telegram-alert-changes.ts`, `telegram-alert-jobs.ts`, `telegram-alert-target-status.ts` (snapshot I/O, diff producers, durable job manifests, per-target audit)
- `worker/src/cron/telegram-quiet-hours.ts` (quiet-hours predicate; shared with Callback routing for the `tz:*` validation only)
- `worker/src/cron/telegram-degradation-watchdog.ts` (post-dispatch one-shot operator alerts on degraded delivery)
- `worker/src/cron/telegram-inactive-cleanup.ts`, `telegram-retention-cleanup.ts` (housekeeping crons on the same lane)
- `worker/src/api/admin-telegram-broadcast.ts`, `admin-telegram-resend.ts`, `admin-telegram-pending.ts`, `admin-telegram-chat.ts` (operator inputs that *write to the pending queue*; they are Dispatch-side because they share queue/TTL semantics, not Ingress)

**Allowed inbound dependencies.** Worker scheduled-event router, Worker admin route entrypoints. Not Ingress, not Callback routing.

**Allowed outbound dependencies.** Queue / rate-limit / retry, Outbound transport, State / persistence (read-heavy: subscribers, subscriptions, preset subscriptions, snoozes, snapshots), Common. Project shared lib for domain data is allowed.

**Must NOT.**
- Format command replies. Alert message formatting lives in `telegram-alerts.ts` (Common) and is shared between Dispatch and admin-broadcast; do not duplicate.
- Inline subscriber-query SQL into the entrypoint. Add new fan-out paths in `dispatch-telegram-alerts-fanout.ts` or one of the existing helper modules.
- Open new connections beyond Cloudflare's 6-per-trigger pool. Consume response bodies (`drainResponseBody`) before opening more fetches.

---

## 6. Queue / rate-limit / retry

**Responsibility.** Own the `telegram_pending_alerts` row lifecycle: claim, drain, retry-with-backoff, dead-letter, expire. Hold per-chat and global backoff (`not_before_at`, `telegram:global-send-backoff-until`). Enforce the 2-strike rule for blocked subscribers. Provide a dedupe key so duplicate chunks never queue.

**Owned files.**
- `worker/src/cron/telegram-pending-queue.ts` (single module — 1,277 lines but deliberately kept together because the lifecycle is one state machine)
- The pending-queue-related constants in `worker/src/lib/telegram-constants.ts` (`PENDING_TTL_SEC`, `PENDING_BACKOFF_SCHEDULE_SEC`, `PENDING_MAX_ATTEMPTS`, `SEND_BATCH_SIZE`, `TELEGRAM_PENDING_DRAIN_BUDGET`, `TELEGRAM_PENDING_PRIORITY`, `TELEGRAM_ALERT_TTL_SEC`, `TELEGRAM_DISPATCH_INTERVAL_SEC`, `BLOCK_STRIKE_WINDOW_SEC`, `PENDING_NEAR_TTL_WINDOW_SEC`)

**Allowed inbound dependencies.** Dispatch (the only legitimate enqueuer for alerts), Admin Telegram routes (`admin-telegram-broadcast.ts`, `admin-telegram-resend.ts`, `admin-telegram-pending.ts`), Callback routing only via `SNOOZE_REPLY_MARKUP` re-export (the `lib/telegram-alerts.ts` keyboard).

**Allowed outbound dependencies.** Outbound transport, State / persistence (cache helpers for global backoff), Common.

**Must NOT.**
- Be opened by Ingress directly. Ingress should never enqueue.
- Re-introduce schedule constants outside `telegram-constants.ts`.
- Mutate `telegram_subscribers` alert flags except via the 2-strike block-disable path. Subscription state is owned by State / persistence helpers.

---

## 7. State / persistence

**Responsibility.** Authoritative read/write helpers for Telegram D1 tables. Encodes the "upsert subscriber and subscriptions in one batch" pattern, the pending-disambiguation lifecycle (including the bulk-confirm payload and the setup-wizard state), the processed-update idempotency claim, the command-cooldown gate, group-to-supergroup chat-ID migration merges, and the chat-delivery diagnostics.

**Owned files.**
- `worker/src/api/telegram-webhook-store.ts` (the bulk of subscription/disambiguation writes and reads)
- `worker/src/lib/telegram-chat-member.ts` (cached chat-admin reads via Telegram API; the cache lives in D1)
- `worker/src/lib/telegram-usage-analytics.ts` (usage events, lifecycle snapshots, chat delivery diagnostics)
- `worker/src/lib/telegram-webhook-registration.ts` (writes the Bot API webhook/commands/profile/menu-button reconcile cadence to D1 cache)
- D1 schemas — owned by the migrations themselves (see [`telegram-alerts.md`](./telegram-alerts.md#d1-schema)):
  - `telegram_subscribers` — per-chat state and defaults
  - `telegram_subscriptions` — per-chat per-coin alert prefs
  - `telegram_preset_subscriptions` — persistent dynamic preset follows
  - `telegram_pending_disambiguation` — short-lived disambiguation, bulk-confirm, and setup-wizard state
  - `telegram_pending_alerts` — overflow + retry queue (owned by Queue, but the schema lives here)
  - `telegram_alert_jobs` / `telegram_alert_job_targets` — discovery + delivery audit (Dispatch)
  - `telegram_alert_dead_letters` — terminal failure audit (Queue)
  - `telegram_processed_updates` — webhook idempotency (Ingress)
  - `telegram_usage_daily` — privacy-preserving aggregates (Action handlers + Dispatch)
  - `telegram_watcher_lifecycle_daily` — daily lifecycle snapshots
  - `telegram_chat_delivery_diagnostics` — per-chat diagnostics (Outbound + Dispatch)
- KV: none currently. Cache keys live in D1 (`cache` table) — notably `alert:dews-snapshot`, `alert:dews-alertable-snapshot`, `alert:depeg-snapshot`, `alert:safety-snapshot`, `alert:launch-snapshot`, `alert:safety-source-cache`, `telegram:global-send-backoff-until`, `telegram:chat-admins:<chat_id>`, `telegram:group-welcome:<chat_id>`, `telegram:processed-updates:prune:last-run`, `telegram:commands-reconciled`, `telegram:profile-reconciled`, `telegram:menu-reconciled`, `telegram:preset-query-failure-count`, `telegram:degradation:*`.

**Allowed inbound dependencies.** Every other seam may read/write through these helpers.

**Allowed outbound dependencies.** Cache helpers (`worker/src/lib/db-cache.ts`), `worker/src/lib/db.ts`, Common.

**Must NOT.**
- Format messages or send to Telegram.
- Take direct dependencies on Action handlers or Dispatch — keep the helpers callable from both lanes.
- Add an ORM, schema-builder, or "repository" abstraction.

---

## 8. Outbound transport

**Responsibility.** The single place that hits `https://api.telegram.org/bot<token>/…`. Owns HTTP timeouts, the `link_preview_options` shape, the response-body drain (required under the Cloudflare 6-connection cap), Bot API error classification, and the auditing wrapper that updates per-chat reply diagnostics.

**Owned files.**
- `worker/src/lib/telegram.ts` (`sendToChat`, `sendBatch`, `postTelegramMessage`, `answerCallbackQuery`, `editMessage`, `escapeHtml`, link-preview helpers, send-error classification)
- `worker/src/api/telegram-webhook-replies.ts` (`sendAuditedTelegramReply` — chunks + diagnostics + replyMarkup)
- `worker/src/lib/telegram-log.ts` (structured Telegram event logger)

**Allowed inbound dependencies.** Action handlers, Callback routing, Ingress (for replies), Dispatch (alert sends), Queue (drains), admin routes, daily digest, registration reconciliation.

**Allowed outbound dependencies.** Native `fetch`, Common.

**Must NOT.**
- Know about subscribers, snapshots, or commands. Send what you are given.
- Inline HTML formatting beyond `escapeHtml`. Body composition lives in `telegram-alerts.ts` or per-handler builders.

---

## 9. Mini App surface

**Responsibility.** Serve the Telegram Mini App UI and its two signed `initData` API calls. Load private-user state, expose read-only group/stale-auth state, apply private-user mutations, and return the same state contract the frontend renders. Telegram direct-link launches can report the private user context as `chat_type="sender"`. This seam is intentionally narrow: it does not receive Telegram webhook updates and it does not call the Telegram Bot API.

**Owned files.**
- `src/app/pharoswatchbot/app/page.tsx`
- `src/app/pharoswatchbot/app/client.tsx`
- `src/app/pharoswatchbot/app/telegram-sdk.ts`
- `src/app/pharoswatchbot/app/types.ts`
- `worker/src/api/telegram-mini-app.ts`
- `worker/src/api/telegram-mini-app-state.ts`
- `worker/src/api/telegram-mini-app-mutations.ts`
- `worker/src/api/telegram-mini-app-schemas.ts`
- `worker/src/lib/telegram-mini-app-auth.ts`

**Allowed inbound dependencies.** The Next.js route `/pharoswatchbot/app/`, Worker route registry entries for `POST /api/telegram-mini-app/session` and `POST /api/telegram-mini-app/mutate`, and private-chat Web App buttons generated by Action handlers / Callback routing.

**Allowed outbound dependencies.** State / persistence helpers for subscription writes and cooldowns, `telegram-presets` for dynamic preset targets, `telegram-usage-analytics` for validated usage events, shared endpoint metadata, shared stablecoin metadata, and the Telegram WebApp browser bridge on the frontend.

**Must NOT.**
- Accept mutation auth older than the 5-minute mutation window.
- Mutate group/supergroup/channel chat rows until a fresh admin verification path and group-scoped launch ownership model exist.
- Write analytics or cooldown rows before signed `initData` validation succeeds.
- Duplicate per-coin or preset write SQL outside the existing State / persistence helpers.
- Use `Telegram.WebApp.sendData` without updating `allowed_updates` and treating incoming `web_app_data` as untrusted.

---

## Common modules

Files any seam may import:

- `worker/src/lib/telegram-constants.ts` — central magic numbers and tokens (`SNOOZE_SECONDS`, `DEPEG_STEP_VALUES`, `TOP_VIEW_NAMES`, `TELEGRAM_MESSAGE_CHUNK_LIMIT`, all queue tuning, disambiguation TTL).
- `worker/src/lib/telegram-alerts.ts` — alert formatting, ticker resolution, `splitMessage`, `SNOOZE_REPLY_MARKUP`. (Mixed concerns — flagged below.)
- `worker/src/lib/telegram-presets.ts` — preset definitions and resolution.
- `worker/src/lib/telegram-digest-appendices.ts` — channel digest appendices (cemetery, newly tracked).
- `worker/src/lib/telegram-log.ts` — structured logging.

---

## What changed in the recent refactors

Three commits decomposed Telegram code in 30 days. Knowing which seam each touched helps a future maintainer pick up where the structure is "current".

- **2026-04-17 — `feat(telegram): callback_query router + snooze buttons backend` (cb202d93b)** — created the **Callback routing** seam. Split `handleCallbackQuery` into its own file (`telegram-webhook-callbacks.ts`), added the `action:arg` parser, and added the first action (`snooze:1h|4h|24h`). Same-day follow-up `refactor(telegram): simplify pass after audit remediation` (6cd53dd0e) collapsed `upsertSubscriberRow + UPDATE` into one `INSERT ... ON CONFLICT` and parallelized `/status` D1 reads.

- **2026-05-11 — `P1-M1: decompose telegram-webhook.ts dispatch into per-command modules` (58695ef1e)** — created the **Action handlers** seam. Cut `telegram-webhook.ts` from ~1,034 lines to ~426, moved each `/command` into `worker/src/api/webhook-commands/<command>.ts`, replaced two parallel switch statements (the pending-active branch and the fresh-command branch) with one `COMMAND_HANDLERS` table plus explicit pending passthrough/clear sets. Extracted the shared subscribe/unsubscribe/set machinery into `webhook-commands/action-runner.ts`. Behavior and exports unchanged.

- **2026-05-14 — `refactor(telegram): extract callback and queue helpers` (d6f4fec8e)** — split **Dispatch / fan-out** further (`dispatch-telegram-alerts-fanout.ts`), restructured `telegram-webhook-callbacks.ts` for explicit per-action handlers, and grew `telegram-pending-queue.ts` to absorb claim-based draining. This commit is the most recent reorganization and the immediate motivation for this doc.

Several `harden` and `fix` commits between those reshaped behavior inside the seams (group-admin hard gate, per-coin snooze, dedupe-key stability, two-strike block rule, claim-based pending drain). Behavioral changes inside an existing seam are not seam changes — they should not move files.

---

## Freeze period

**Until 2026-06-13** (30 days from 2026-05-14), the Telegram code is **frozen for internal reorganization**.

Allowed during the freeze:
- Bug fixes that change behavior.
- New commands or callbacks (add a handler file in `webhook-commands/`, add to `CALLBACK_ACTIONS`, etc.).
- New tests, new docs.
- Adding fields to existing helpers or types.
- Behavioral hardening (rate limits, retry rules, threshold tuning, idempotency improvements) inside an existing seam.

Not allowed during the freeze, unless a real bug forces it and the fix narrative is in the commit message:
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
3. **A callback handler imports from 4+ seams** — `telegram-webhook-callbacks.ts` already sits at the edge (it imports Action handlers' builders, State helpers, Common, and re-runs setup state); if a new callback needs a 5th, the callback layer is doing too much.
4. **A new constant gets defined outside `telegram-constants.ts`** within the Telegram subsystem — the centralization (P1-M2) is decaying.
5. **The same SQL appears in two seams** — most likely State / persistence is missing a helper.
6. **Ingress grows past ~600 lines again** — the dispatcher loop is doing more than routing. Push behavior into Action handlers or State.

---

## Architectural tension flagged but not prescribed

- **`worker/src/lib/telegram-alerts.ts` is 760 lines and straddles Command parsing (ticker resolution, arg parsing) and alert message formatting (DEWS/depeg/safety/launch HTML, `splitMessage`, the `SNOOZE_REPLY_MARKUP` keyboard).** It is imported by every seam. A future split would have a clean parsing-only half (`resolveTicker`, `parseSubscribeArgs`, `parseDisambiguationReply`, `suggestClosestToken`) and an alert-formatting half (`formatConsolidatedMessage`, `buildAlertReplyMarkup`, `splitMessage`, depeg/dews/safety/launch builders). Not prescribed because the freeze blocks it; revisit after 2026-06-13.

- **Callback routing inlines a few mutating SQL writes (`snooze`, `coinsnooze`, `depegstep`, `safetydown`) that pre-date the store-helper convention.** They are functionally correct; they just bypass `telegram-webhook-store.ts`. Future rule: new mutating callbacks call store helpers, but do not retro-fit the existing ones during the freeze.

- **Setup wizard state lives in `telegram_pending_disambiguation` with `action_type = "setup-step"`.** Sharing the TTL and cleanup cron with disambiguation was deliberate, but Ingress now branches on `isSetupPending` before any other pending-state logic — that branch will keep growing if more wizards arrive. Watch for a third pending-action-type before deciding whether wizards need their own row type.

- **`admin-telegram-broadcast.ts` writes to `telegram_pending_alerts` directly with its own priority and TTL.** Filed under Dispatch in this doc, but it has Ingress-shaped concerns (it is an HTTP entrypoint). If a second admin write path appears, consider splitting "admin write surface" into its own seam.
