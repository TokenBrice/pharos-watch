# Telegram Bot Alert Subscriptions MVP Reference

**Date:** 2026-03-03  
**Status:** Proposed (implementation-ready)  
**Owner:** Engineering  
**Scope:** Backend Worker + D1 + Telegram integration only. No frontend UI changes required for MVP.

---

## 1. Objective

Deliver an interactive Telegram bot experience where users can:

1. Subscribe to DEWS alerts for all coins or selected stablecoins.
2. Subscribe to the daily digest in private chat.
3. Unsubscribe and inspect current preferences at any time.

Constraints:

1. Preserve existing channel broadcast behavior for digest and DEWS.
2. Keep alert generation non-fatal (storage and cron completion must not depend on Telegram availability).
3. Stay within existing Cloudflare Worker and Telegram API limits.

---

## 2. Non-Goals (MVP)

1. No web dashboard for Telegram preferences.
2. No OAuth/account linking between Pharos web users and Telegram users.
3. No multilingual bot responses.
4. No group/supergroup support (private chats only for MVP).
5. No paid tiering, no advanced quiet hours, no per-chain filters.

---

## 3. Current Baseline (Codebase State)

Telegram today is outbound-only:

1. `worker/src/lib/telegram.ts` posts messages using `sendMessage` to one `chat_id`.
2. `worker/src/cron/daily-digest.ts` posts digest to Telegram after storing to D1.
3. `worker/src/cron/compute-dews.ts` posts WARNING/DANGER band-entry alerts to Telegram.
4. `worker/src/index.ts` only allows `POST /api/feedback`; all other non-GET requests are rejected with 405.
5. No inbound Telegram webhook endpoint and no subscription tables exist.

This means the core message formatting and event detection logic already exist, but user-level preference and inbound command handling do not.

---

## 4. Functional Requirements

### 4.1 User-facing behavior

1. `/start` registers chat and displays quick actions.
2. `/help` shows command list.
3. `/subscriptions` shows active subscriptions.
4. `/subscribe <coin>` subscribes to DEWS for one coin.
5. `/unsubscribe <coin>` removes DEWS subscription for one coin.
6. `/subscribe_dews_all` subscribes to DEWS for all supported coins.
7. `/unsubscribe_dews_all` removes global DEWS subscription.
8. `/subscribe_digest` enables digest delivery.
9. `/unsubscribe_digest` disables digest delivery.

`<coin>` supports:

1. Stablecoin ID (preferred, exact).
2. Symbol (resolved if unique).
3. Name/symbol search fallback with disambiguation when multiple matches exist.

### 4.2 Alert behavior

1. DEWS: deliver when coin enters WARNING/DANGER upward (same trigger as channel).
2. Digest: deliver once per generated digest (same day/date key).
3. Deliveries are idempotent per `(alert_key, chat_id)` combination.
4. Blocked chats are auto-deactivated after Telegram `403` responses.

---

## 5. Architecture

## 5.1 High-level lanes

1. **Inbound lane (Webhook):** Telegram updates -> parse/auth -> mutate D1 subscriptions -> send immediate command response.
2. **Signal lane (Crons):** Existing digest/DEWS cron logic detects events and enqueues user deliveries.
3. **Delivery lane (Outbox dispatcher):** Separate cron drains outbox with retry/backoff and rate-limiting.

## 5.2 Why outbox for MVP

Direct per-user send in `compute-dews` and `daily-digest` risks cron timeout as subscriber count grows. Outbox decouples generation from delivery and keeps existing non-fatal design.

---

## 6. Data Model and Migrations

Current highest migration is `0034`. Add:

1. `0035_telegram_bot_core.sql`
2. `0036_telegram_outbox.sql`

## 6.1 Migration `0035_telegram_bot_core.sql`

```sql
-- Telegram chats known to the bot
CREATE TABLE IF NOT EXISTS telegram_chats (
  chat_id        TEXT PRIMARY KEY,          -- Telegram chat id as text (safe for large ints)
  chat_type      TEXT NOT NULL,             -- private | group | supergroup | channel
  username       TEXT,
  first_name     TEXT,
  last_name      TEXT,
  language_code  TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  blocked_at     INTEGER,
  last_seen_at   INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_chats_active
  ON telegram_chats(is_active, updated_at DESC);

-- User subscription preferences
CREATE TABLE IF NOT EXISTS telegram_subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         TEXT NOT NULL,
  alert_type      TEXT NOT NULL,            -- dews | digest
  stablecoin_id   TEXT NOT NULL DEFAULT '*',-- '*' for all coins or specific id
  threshold_score INTEGER NOT NULL DEFAULT 56, -- for dews: 56 (WARNING) or 76 (DANGER)
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(chat_id, alert_type, stablecoin_id, threshold_score)
);

CREATE INDEX IF NOT EXISTS idx_telegram_subscriptions_lookup
  ON telegram_subscriptions(alert_type, stablecoin_id, enabled, threshold_score);

CREATE INDEX IF NOT EXISTS idx_telegram_subscriptions_chat
  ON telegram_subscriptions(chat_id, enabled);

-- Webhook idempotency and audit trail
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id    INTEGER PRIMARY KEY,         -- Telegram update_id
  chat_id      TEXT,
  update_type  TEXT NOT NULL,               -- message | callback_query | other
  status       TEXT NOT NULL,               -- ok | ignored | error
  error        TEXT,
  received_at  INTEGER NOT NULL,
  handled_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_telegram_updates_received
  ON telegram_updates(received_at DESC);
```

## 6.2 Migration `0036_telegram_outbox.sql`

```sql
CREATE TABLE IF NOT EXISTS telegram_outbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key    TEXT NOT NULL UNIQUE,       -- alert-key + chat-id
  chat_id       TEXT NOT NULL,
  payload_json  TEXT NOT NULL,              -- {"text":"...", "parse_mode":"HTML"}
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | sent | dead
  attempts      INTEGER NOT NULL DEFAULT 0,
  available_at  INTEGER NOT NULL,
  sent_at       INTEGER,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_outbox_pending
  ON telegram_outbox(status, available_at, id);

CREATE INDEX IF NOT EXISTS idx_telegram_outbox_chat
  ON telegram_outbox(chat_id, status, created_at DESC);
```

## 6.3 Retention policy

Run pruning from dispatcher:

1. `telegram_updates`: keep 30 days.
2. `telegram_outbox` `sent`: keep 14 days.
3. `telegram_outbox` `dead`: keep 30 days.

---

## 7. Environment Variables

Existing:

1. `TELEGRAM_BOT_TOKEN`
2. `TELEGRAM_CHAT_ID` (legacy broadcast channel)

New:

1. `TELEGRAM_WEBHOOK_SECRET` (required for webhook header verification)

Optional:

1. `TELEGRAM_BOT_USERNAME` (for help text)
2. `TELEGRAM_BOT_ALLOWLIST` (comma-separated chat ids for canary rollout)
3. `TELEGRAM_BOT_DRY_RUN` (`"1"` to skip external send and log only)

---

## 8. Worker Surface and Routing

## 8.1 New endpoint

1. `POST /api/telegram/webhook`

Implementation note: this should be handled in `worker/src/index.ts` alongside `POST /api/feedback`, because current method guard rejects other POST requests before router dispatch.

### Auth contract

1. Require header `X-Telegram-Bot-Api-Secret-Token`.
2. Compare against `env.TELEGRAM_WEBHOOK_SECRET`.
3. On mismatch return 401 quickly.

### Response contract

Always return 200 for validly authenticated webhook payloads once processed/queued. Do not propagate Telegram send failures to webhook response.

---

## 9. New/Modified Files

## 9.1 New files

1. `worker/src/api/telegram-webhook.ts`
2. `worker/src/cron/dispatch-telegram-outbox.ts`
3. `worker/src/lib/telegram-bot.ts` (command parsing, subscription service, resolver)
4. `worker/src/lib/__tests__/telegram-webhook.test.ts`
5. `worker/src/lib/__tests__/telegram-subscriptions.test.ts`
6. `worker/src/cron/__tests__/dispatch-telegram-outbox.test.ts`
7. `worker/migrations/0035_telegram_bot_core.sql`
8. `worker/migrations/0036_telegram_outbox.sql`

## 9.2 Modified files

1. `worker/src/index.ts`
2. `worker/src/cron/compute-dews.ts`
3. `worker/src/cron/daily-digest.ts`
4. `worker/src/lib/telegram.ts`
5. `worker/wrangler.toml`
6. `docs/digest-pipeline.md`
7. `docs/dews.md`
8. `docs/worker-infrastructure.md`
9. `docs/worker-and-api-limits.md` (usage profile update)

---

## 10. Telegram Webhook Handler Design

## 10.1 Accepted update types (MVP)

1. `message` with text command.
2. `callback_query` from inline keyboard buttons.

Ignored safely:

1. `edited_message`
2. `channel_post`
3. `my_chat_member`
4. any unsupported shape

## 10.2 Idempotency

1. Extract `update_id`.
2. `INSERT OR IGNORE` into `telegram_updates`.
3. If no row inserted (`changes=0`), return early (duplicate delivery).

## 10.3 Chat upsert

On every handled update:

1. Upsert `telegram_chats` metadata and `last_seen_at`.
2. If chat type is not `private`, send one-time response: "Private chat only for now."
3. Do not create subscriptions for non-private chats.

## 10.4 Command parsing

Parser rules:

1. Trim text.
2. Strip bot mention suffix for group-safe syntax (ex: `/start@pharos_bot`), even though groups are unsupported.
3. Split by whitespace into `command` and `args`.
4. Route to command handlers.

Supported commands and effects:

1. `/start` -> chat registration + starter message.
2. `/help` -> command help.
3. `/subscriptions` -> list all enabled prefs.
4. `/subscribe <coin>` -> add `dews` row for that coin (`threshold_score=56`).
5. `/unsubscribe <coin>` -> disable/remove matching `dews` row.
6. `/subscribe_dews_all` -> add `dews` row with `stablecoin_id='*'`.
7. `/unsubscribe_dews_all` -> disable/remove `dews` wildcard row.
8. `/subscribe_digest` -> add `digest` wildcard row.
9. `/unsubscribe_digest` -> disable/remove `digest` wildcard row.
10. `/dews_warning` -> set default DEWS threshold to 56 for wildcard and coin rows.
11. `/dews_danger` -> set default DEWS threshold to 76 for wildcard and coin rows.

---

## 11. Stablecoin Resolution

## 11.1 Source of truth

Use static metadata from:

1. `src/lib/stablecoins.ts` (`TRACKED_STABLECOINS`)
2. `src/lib/psi-eligible.ts` only for delivery-side compatibility

## 11.2 Resolver precedence

1. Exact ID match if input passes ID shape.
2. Exact symbol match (case-insensitive).
3. Exact name match (case-insensitive).
4. Prefix/contains fallback over symbol and name.

## 11.3 Ambiguity handling

Some symbols collide across tracked assets. If multiple matches:

1. Return disambiguation response listing up to 6 options.
2. Include both symbol, name, and id.
3. Provide inline keyboard buttons with callback payload `sub:<id>`.

Never auto-pick an ambiguous symbol.

---

## 12. Callback Query Design

## 12.1 Callback payload grammar

1. `sub:<stablecoin_id>`
2. `unsub:<stablecoin_id>`
3. `digest:on`
4. `digest:off`
5. `dews:all:on`
6. `dews:all:off`
7. `dews:threshold:56`
8. `dews:threshold:76`
9. `subs:refresh`

## 12.2 Handler behavior

1. Acknowledge callback via `answerCallbackQuery` immediately.
2. Execute mutation.
3. Edit message text or send a fresh confirmation message.

---

## 13. Alert Fanout Integration

## 13.1 DEWS cron integration (`worker/src/cron/compute-dews.ts`)

Current behavior:

1. Detect upward transitions into WARNING/DANGER.
2. Immediate post to one channel chat.

New behavior (in addition to legacy channel post):

1. Keep existing channel send path unchanged.
2. For each transition event:
   1. Build event key `dews:<stablecoin_id>:<computed_at>:<band>`.
   2. Query active DEWS subscriptions where:
      - `enabled = 1`
      - `alert_type = 'dews'`
      - `stablecoin_id IN ('*', <stablecoin_id>)`
      - `threshold_score <= event_score`
      - chat is active
   3. Insert one outbox row per recipient with unique `dedupe_key = <event_key>:<chat_id>`.
3. Return metadata additions:
   - `dewsEvents`
   - `telegramEnqueued`
   - `telegramChannelStatus`

## 13.2 Daily digest integration (`worker/src/cron/daily-digest.ts`)

Current behavior:

1. Store digest row.
2. Post to channel if creds exist.

New behavior:

1. Keep channel post unchanged for backward compatibility.
2. Enqueue digest for chat subscribers:
   1. Event key `digest:<yyyy-mm-dd>`.
   2. Select active subscriptions:
      - `alert_type = 'digest'`
      - `enabled = 1`
      - `stablecoin_id='*'`
   3. Insert outbox rows with dedupe key `digest:<date>:<chat_id>`.
3. Metadata additions:
   - `telegramDigestEnqueued`
   - `telegramChannelStatus` (existing)

---

## 14. Outbox Dispatcher Cron

## 14.1 Trigger

Use final available cron slot in `worker/wrangler.toml`:

1. `"* * * * *"` for dispatcher.

## 14.2 Dispatch algorithm

Per run:

1. Select pending rows:
   - `status='pending'`
   - `available_at <= now`
   - ordered by `id`
   - `LIMIT 150` (tunable)
2. For each row:
   1. Decode payload.
   2. Send Telegram `sendMessage`.
   3. On success:
      - mark row `sent`, set `sent_at`.
   4. On failure:
      - increment attempts.
      - classify and backoff.

### Failure classification

1. `403` (blocked/deactivated):
   - mark row `dead`
   - mark chat inactive (`is_active=0`, `blocked_at=now`)
   - optionally disable chat subscriptions.
2. `400` permanent format/chat error:
   - mark row `dead`.
3. `429`:
   - parse `retry_after`.
   - set `available_at = now + retry_after`.
4. `5xx` or network:
   - exponential retry backoff (`min(3600, 15 * 2^attempts)`).

## 14.3 Throughput and limits

At `LIMIT 150` and one run per minute:

1. steady throughput 150/min.
2. low risk vs Telegram API limits.
3. tunable without schema changes.

---

## 15. Telegram API Wrapper Changes

Keep `worker/src/lib/telegram.ts` as low-level transport and message formatting module.

Add exports:

1. `sendTelegramMessage(text, creds, chatIdOverride?)` or equivalent generic sender.
2. Typed Telegram API error parser:
   - status
   - description
   - retry_after (if present)

No formatting logic should be duplicated in webhook/cron code.

---

## 16. Security and Abuse Controls

## 16.1 Webhook origin trust

Primary control is secret header verification (`X-Telegram-Bot-Api-Secret-Token`).

## 16.2 Input safety

1. Cap command length.
2. Normalize whitespace.
3. Escape user-provided values in HTML responses.
4. Reject unsupported binary/non-text payload paths.

## 16.3 Anti-spam

Per-chat command rate limit in D1 (MVP simple):

1. max 20 webhook commands per 5 minutes per chat.
2. on breach, return success with "slow down" message.

## 16.4 Data minimization

Store only:

1. chat id
2. optional username/name fields from Telegram profile
3. subscription preferences
4. delivery/update audit metadata

No message history storage required.

---

## 17. Observability

## 17.1 Cron metadata

Add fields in dispatcher and producer crons:

1. `outboxPendingCount`
2. `outboxEnqueued`
3. `outboxSent`
4. `outboxRetried`
5. `outboxDead`
6. `webhookUpdatesHandled`
7. `webhookUpdatesErrored`

## 17.2 Alerting

Use existing `sendAlert` for:

1. webhook error bursts (example: >20 errors in 10 min).
2. outbox backlog age > 30 minutes.
3. dispatcher consecutive failures.

---

## 18. Test Plan

## 18.1 Unit tests

1. command parser: command extraction, args, mention stripping.
2. stablecoin resolver: exact/ambiguous/not found.
3. subscription service: upsert, dedupe, wildcard logic.
4. webhook auth and idempotency behavior.
5. outbox retry classifier (`403`, `429`, `5xx`).

## 18.2 Integration tests (Worker-level)

1. webhook POST success path with mocked Telegram send.
2. duplicate `update_id` no-op path.
3. DEWS event enqueues only eligible subscribers.
4. digest event enqueues digest subscribers.
5. dispatcher marks sent/dead/retry correctly.

## 18.3 Regression tests

1. existing channel digest send still works.
2. existing DEWS channel alerts still fire only on upward threshold transitions.
3. cron lease behavior unchanged for current jobs.

## 18.4 Manual E2E checklist

1. `/start` in private chat receives welcome.
2. subscribe one coin and trigger synthetic DEWS transition -> receive alert.
3. subscribe digest and trigger admin digest -> receive digest.
4. block bot and verify chat marked inactive after failed send.

---

## 19. Implementation Sequence

## Phase 0: Schema and plumbing

1. Add migrations `0035`, `0036`.
2. Add D1 helpers for chat/subscription/outbox CRUD.
3. Add env var definitions in `worker/src/index.ts`.

## Phase 1: Webhook and command handling

1. Add `POST /api/telegram/webhook` handler in `index.ts`.
2. Implement webhook auth, idempotency, command routing.
3. Implement chat upsert and subscription mutations.
4. Add command response templates and callback support.

## Phase 2: Producer integration

1. Update `compute-dews` to enqueue user alerts.
2. Update `daily-digest` to enqueue user digests.
3. Keep legacy channel send path intact.

## Phase 3: Dispatcher

1. Add dispatcher cron job and outbox send loop.
2. Add retry/backoff and blocked-chat deactivation.
3. Add pruning routines.

## Phase 4: Docs and runbook

1. Update pipeline docs.
2. Add operational commands for webhook registration.
3. Add rollback and incident playbook notes.

---

## 20. Deployment and Rollout

## 20.1 Pre-deploy

1. Apply migrations locally and staging.
2. Add secrets:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET`
3. Register webhook:

```bash
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://api.pharos.watch/api/telegram/webhook" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d "drop_pending_updates=true"
```

## 20.2 Canary

1. Enable `TELEGRAM_BOT_ALLOWLIST` with internal chat ids only.
2. Validate end-to-end for 24 hours.
3. Remove allowlist restriction.

## 20.3 Post-deploy verification

1. Confirm webhook health via Telegram `getWebhookInfo`.
2. Confirm outbox sent/failed ratios are normal.
3. Confirm channel broadcasts unaffected.

---

## 21. Rollback Plan

If bot flow causes issues:

1. Disable webhook:

```bash
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook" \
  -d "drop_pending_updates=true"
```

2. Keep channel broadcasts active (no change to legacy paths).
3. Pause dispatcher by removing cron entry or feature-flagging.
4. Preserve subscription tables; no destructive rollback migration needed.

---

## 22. Acceptance Criteria

MVP is complete when all are true:

1. Users can self-serve subscriptions through Telegram commands only.
2. DEWS and digest events enqueue and deliver per user preferences.
3. Duplicate webhook updates and duplicate alert attempts do not create duplicate messages.
4. Blocked chats are auto-deactivated.
5. Existing channel broadcast behavior remains unchanged.
6. All new tests pass and no existing tests regress.

---

## 23. Open Decisions (Resolve Before Build)

1. Keep or drop support for symbol-based `/subscribe` input in MVP (ID-only avoids ambiguity).
2. Default DEWS threshold for `/subscribe` should be WARNING (56) or DANGER (76).
3. Whether to include wildcard DEWS subscription by default on `/start`.
4. Whether to enable group chats in phase 2 or keep private-only indefinitely.

---

## 24. Estimated Effort

Rough implementation estimate:

1. Schema + webhook + parser + subscriptions: 1.5 to 2 days
2. Producer enqueue integration: 0.5 to 1 day
3. Outbox dispatcher + retries + pruning: 1 day
4. Tests and docs: 1 to 1.5 days

Total: approximately 4 to 5.5 engineering days including validation and rollout.

