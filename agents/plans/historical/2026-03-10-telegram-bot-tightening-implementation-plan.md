# Telegram Bot Tightening Implementation Plan

**Date:** 2026-03-10  
**Scope:** Telegram webhook intake, subscriber model, alert dispatch cron, Telegram status visibility, Telegram landing page, and supporting worker/docs/tests  
**Based on:** End-to-end audit of `PharosWatchBot` and its upstream alert logic completed on 2026-03-10

---

## Objective

Tighten the current Telegram bot so it is:

1. **More reliable**: fresh alerts are either delivered, retried, or explicitly surfaced as failed.
2. **More precise**: users can control alert noise at the coin and severity level.
3. **Safer to use**: command flows are harder to misfire and easier to recover from.
4. **More truthful**: product copy and operator telemetry match actual runtime behavior.

This plan intentionally excludes:

- personalized watchlist recaps, `/brief`, `/watchlist`, or scheduled digest-like summaries
- new Telegram alert families from other existing pipelines

The priority is tightening the current bot before expanding the surface area.

---

## Executive Build Order

Recommended execution order:

1. **Delivery correctness and observability foundation**
2. **Subscription model upgrade and graduated alert policy**
3. **Webhook UX and command-safety tightening**
4. **Operator/status hardening and product-copy alignment**
5. **Migration, docs, and rollout cleanup**

This order is deliberate:

- Phase 1 fixes silent alert loss first.
- Phase 2 adds the biggest product-value improvement only after delivery semantics are trustworthy.
- Phase 3 makes the bot easier to operate without introducing ambiguity into the new preference model.
- Phase 4 ensures operators and users see the truth.
- Phase 5 closes the loop with docs, rollout guards, and cleanup.

---

## In Scope

- `worker/src/api/telegram-webhook.ts`
- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/lib/telegram.ts`
- `worker/src/lib/telegram-alerts.ts`
- `worker/src/api/status.ts`
- `src/components/status/telegram-bot-stats.tsx`
- `src/app/telegram/page.tsx`
- `worker/migrations/0054_telegram_subscribers.sql` follow-on migrations
- `worker/migrations/0060_telegram_pending_alerts.sql` follow-on migrations
- Telegram-related worker tests
- Telegram-related docs

Potentially in scope if needed for clean rollout:

- `shared/types/index.ts`
- `shared/lib/cron-jobs.ts`
- `docs/status-dashboard.md`
- `docs/worker-infrastructure.md`
- `docs/api-reference.md`

---

## Out of Scope

- adding new alert families such as blacklist, flows, yield, regime, or digest-derived alerts
- adding scheduled personalized summaries or digest-like watchlist reports
- redesigning the public `/telegram` page visually beyond copy/accuracy fixes
- changing cron-slot topology or introducing a new scheduler
- changing DEWS, depeg, or safety methodologies themselves
- introducing new external sources or vendors

---

## Non-Negotiables

- Do not silently drop fresh alerts.
- Do not overstate delivery success in status metadata.
- Prefer explicit delivery states over “best effort” semantics that hide failure.
- Preserve the current cold-start snapshot seeding behavior.
- Keep Telegram sends under Workers connection constraints.
- Any new subscription controls must remain backwards compatible for existing rows until migrations are complete.
- Any public claims about “real-time” or alert timing must match actual pipeline timing.
- Update docs when runtime behavior or user-visible command contracts change.

Docs that must be updated when implementation starts:

- `docs/telegram-alerts.md`
- `docs/worker-infrastructure.md`
- `docs/status-dashboard.md`
- `docs/api-reference.md` if any status/API contract changes
- `src/app/telegram/page.tsx` copy

---

## Verification Standard

Every completed workstream must finish with:

```bash
npm run build
npm run lint
npm test
cd worker && npx tsc --noEmit
```

Minimum targeted suites during development:

```bash
npm test -- \
  worker/src/api/__tests__/telegram-webhook.test.ts \
  worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts \
  worker/src/lib/__tests__/telegram-alerts.test.ts \
  worker/src/lib/__tests__/telegram.test.ts \
  worker/src/api/__tests__/status.test.ts
```

Recommended new suites to add as part of this plan:

- `worker/src/api/__tests__/telegram-webhook-preferences.test.ts`
- `worker/src/cron/__tests__/dispatch-telegram-alerts-delivery.test.ts`
- `worker/src/cron/__tests__/dispatch-telegram-alerts-thresholds.test.ts`
- `src/components/status/__tests__/telegram-bot-stats.test.tsx`

---

## Findings To Fix

| ID | Severity | Problem | Root cause |
|---|---|---|---|
| T1 | High | Fresh alert sends can fail and disappear permanently | fresh-send failures are swallowed and not retried/enqueued |
| T2 | High | Dispatch budget is enforced against subscribers, not actual message chunks | chunk expansion happens after budget slicing |
| T3 | High | Safety-grade alerts can misfire on methodology-version changes | dispatcher ignores `methodology_version` |
| T4 | Medium-high | Alert settings are too coarse for serious watchlists | flags exist only at chat level, not per coin/subscription |
| T5 | Medium-high | Users never hear about depegs worsening after trigger | dispatcher only emits entered/exited active-event transitions |
| T6 | Medium | Public/product copy overstates “real-time” behavior for safety alerts | safety changes are daily-snapshot driven |
| T7 | Medium | Disambiguation mode hijacks normal commands with no escape path | pending reply flow intercepts all text until expiry |
| T8 | Medium | Ambiguous unsubscribe removes all matching coins without confirmation | unsubscribe path does not reuse disambiguation workflow |
| T9 | Medium-low | Status metrics are optimistic or stale | metadata lacks failure breakdown and UI still references old cap text |
| T10 | Low-medium | Webhook secret handling is log-prone | secret is embedded in URL and echoed by helper script |

---

## Core Decisions

These are the proposed design decisions for implementation.

### 1. Delivery semantics become explicit

Fresh Telegram alert sends should resolve into one of four states:

- `sent`
- `blocked`
- `retryable_failure`
- `permanent_failure`

Fresh sends that do not succeed should no longer disappear. Retryable failures should enter the pending queue with an attempt counter and delivery metadata.

### 2. Budgeting moves to actual message chunks

The true unit of Telegram capacity is a `sendMessage` call, not a subscriber row. Caps, overflow handling, and status metrics should all be based on chunked messages.

### 3. Subscription preferences become per-subscription

The next model should support:

- chat-level defaults
- coin-level alert-type enablement
- optional severity thresholds by alert type

This should be stored on the subscription row, not inferred indirectly from chat-global booleans.

### 4. Alert escalation policy becomes configurable but minimal

Do not turn the bot into a complex rules engine. Add only the controls that materially reduce noise:

- DEWS minimum band threshold
- safety change direction policy
- depeg worsening milestone policy
- optional quiet hours at chat level

### 5. Methodology-driven changes must be visible as such

Safety alerts should suppress or explicitly label grade changes caused purely by methodology version changes. Methodology churn should not masquerade as market risk.

---

## Phase 1: Delivery Correctness and Observability Foundation

### Goal

Make fresh alert delivery trustworthy before changing user-facing feature depth.

### Deliverables

1. Fresh-send failure classification
2. Chunk-aware dispatch budgeting
3. Retry path for fresh-send failures
4. Accurate dispatch metadata for `/status`

### Implementation Tasks

#### 1.1 Stop swallowing fresh-send failures

Current problem:

- `sendBatch()` catches non-403 failures and reduces them to `{ ok: false, blocked: false }`
- the dispatcher neither retries nor enqueues those failures
- the run still records success

Implementation:

1. Extend `sendToChat()` and `sendBatch()` to return a richer result shape:
   - `ok`
   - `blocked`
   - `retryable`
   - `statusCode`
   - `errorClass`
2. Distinguish at minimum:
   - `403` blocked
   - `429` rate limit
   - `5xx` Telegram upstream failure
   - timeout/network failure
   - malformed/oversize payload failure
3. Preserve connection-body consumption behavior.
4. Update fresh-send handling so retryable failures are enqueued into `telegram_pending_alerts` instead of being dropped.
5. Add permanent-failure accounting when a message cannot reasonably succeed on retry.

Primary files:

- `worker/src/lib/telegram.ts`
- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/migrations/0060_telegram_pending_alerts.sql` follow-on migration if extra metadata columns are needed

Acceptance criteria:

- A fresh `500`, `429`, or timeout no longer causes silent alert loss.
- Dispatch metadata exposes fresh send failures separately from blocked users.
- Circuit-breaker success is not recorded for a run that lost all fresh sends.

#### 1.2 Enforce cap against chunked sends

Current problem:

- budget is applied to subscribers before chunk flattening
- a single subscriber with many chunks can exceed the intended cap

Implementation:

1. Pre-split messages before budgeting, as now, but compute the cap on actual chunk count.
2. Slice `sendList` by message-chunk budget, not `subscriberQueue` length.
3. Track overflow at the chunk level while keeping subscriber-level summary metrics.
4. Ensure `pendingBudget` and `freshBudget` both use chunk counts.
5. Update status wording and docs to refer to “message chunks” or “Telegram sends,” not “subscriber deliveries,” where appropriate.

Acceptance criteria:

- `MAX_MESSAGES_PER_RUN` becomes a hard upper bound on actual `sendMessage` attempts.
- Queue overflow counts match the number of deferred chunks.
- Status no longer presents a false notion of cap compliance.

#### 1.3 Make pending queue the universal retry path

Implementation:

1. Reuse `telegram_pending_alerts` for:
   - overflow
   - retryable fresh-send failures
2. Add optional metadata columns if needed:
   - `source_run_at`
   - `failure_reason`
   - `last_error_code`
3. Preserve TTL cleanup.
4. Track:
   - drained successfully
   - retried
   - expired
   - dropped after max attempts

Acceptance criteria:

- All retryable send failures flow through one queue.
- Queue diagnostics can distinguish “overflow backlog” from “delivery retries.”

#### 1.4 Correct success/failure recording and status payloads

Implementation:

1. Only record a successful Telegram API outcome when:
   - snapshot seeding succeeded, or
   - at least one send succeeded and no systemic failure threshold was crossed
2. Add structured dispatch metadata:
   - `freshAttempted`
   - `freshSent`
   - `freshRetryQueued`
   - `freshPermanentFailures`
   - `pendingAttempted`
   - `pendingSent`
   - `pendingRetryQueued`
   - `pendingDropped`
   - `blockedUsersCleanedUp`
3. Update `/status` parser/UI to render these values.
4. Fix the stale “hit 50-message cap” copy to match the actual cap.

Primary files:

- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/api/status.ts`
- `src/components/status/telegram-bot-stats.tsx`
- `docs/telegram-alerts.md`
- `docs/status-dashboard.md`

Acceptance criteria:

- `/status` can reveal whether a run mostly succeeded, mostly retried, or mostly failed.
- Status copy reflects the actual configured cap.

### Verification

- Add tests for retryable fresh failures being enqueued.
- Add tests for chunk-budget enforcement.
- Add tests for metadata on partially failed runs.

---

## Phase 2: Subscription Model Upgrade and Graduated Alert Policy

### Goal

Make the bot useful for professional watchlists without broadening feature families.

### Deliverables

1. Per-subscription alert preferences
2. Minimal graduated alert thresholds
3. Worsening-depeg alert support
4. Quiet-hours support

### Proposed Data Model

Keep `telegram_subscribers` for chat identity and global settings. Extend `telegram_subscriptions` with per-coin controls.

Recommended new columns:

```sql
ALTER TABLE telegram_subscriptions ADD COLUMN alert_dews INTEGER NOT NULL DEFAULT 1;
ALTER TABLE telegram_subscriptions ADD COLUMN alert_depeg INTEGER NOT NULL DEFAULT 1;
ALTER TABLE telegram_subscriptions ADD COLUMN alert_safety INTEGER NOT NULL DEFAULT 1;
ALTER TABLE telegram_subscriptions ADD COLUMN dews_min_band TEXT;
ALTER TABLE telegram_subscriptions ADD COLUMN safety_mode TEXT;
ALTER TABLE telegram_subscriptions ADD COLUMN depeg_worsening_bps_step INTEGER;

ALTER TABLE telegram_subscribers ADD COLUMN quiet_hours_start_utc INTEGER;
ALTER TABLE telegram_subscribers ADD COLUMN quiet_hours_end_utc INTEGER;
ALTER TABLE telegram_subscribers ADD COLUMN quiet_hours_enabled INTEGER NOT NULL DEFAULT 0;
```

Recommended enum semantics:

- `dews_min_band`: `ALERT`, `WARNING`, `DANGER`, or null for default
- `safety_mode`:
  - `all`
  - `downgrade-only`
  - `upgrade-only`
- `depeg_worsening_bps_step`: null or positive step such as `100`, `250`, `500`

### Implementation Tasks

#### 2.1 Migrate from chat-global flags to subscription-aware filtering

Implementation:

1. Add new subscription-level columns.
2. Backfill them from current chat-level flags:
   - if a chat has `alert_dews = 1`, set all existing subscriptions `alert_dews = 1`, else `0`
   - same for depeg and safety
3. Keep the old chat-global flags temporarily for compatibility and status comparisons.
4. Update dispatcher subscriber loading queries to filter on subscription-level flags first.
5. Only remove or de-emphasize chat-global flags after the migration is stable.

Acceptance criteria:

- Existing subscribers retain behavior after migration.
- New subscriptions can differ by coin.

#### 2.2 Add graduated DEWS, safety, and depeg worsening policies

Implementation:

1. Replace fixed DEWS alertability checks with subscription-aware checks:
   - chat follows coin
   - `alert_dews = 1`
   - `newBand >= dews_min_band`
2. Replace binary safety filtering with `safety_mode`.
3. Extend depeg snapshots to carry last alerted worsening milestone.
4. Emit worsening alerts when an open event crosses additional thresholds, e.g.:
   - every `100`/`250`/`500` bps worsening step
   - only if the current user requested worsening alerts
5. Preserve silent delivery for de-escalations where appropriate.

Design note:

The worsening-depeg implementation likely needs either:

- per-chat state in a new table keyed by `(chat_id, stablecoin_id, depeg_event_id or stablecoin_id+direction)`, or
- event snapshot state extended with milestone markers sufficient for subscription-specific thresholds

Recommendation:

Use a dedicated per-chat alert-state table. That is cleaner than overloading the global snapshot cache with user-specific alert progress.

Suggested table:

```sql
CREATE TABLE telegram_alert_state (
  chat_id TEXT NOT NULL,
  stablecoin_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  state_key TEXT NOT NULL,
  state_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, stablecoin_id, alert_type, state_key)
);
```

`state_key` examples:

- `depeg:last-worsening-bps`
- `depeg:last-direction`

Acceptance criteria:

- Users can follow `USDT` for depeg only and `DAI` for safety only.
- Users can set stricter DEWS floors per coin.
- Open depegs can emit follow-up worsening alerts instead of only trigger/resolution.

#### 2.3 Add quiet hours

Implementation:

1. Store quiet-hours settings on `telegram_subscribers`.
2. During quiet hours:
   - either suppress only non-escalatory alerts, or
   - send with `disable_notification = true`

Recommendation:

- Phase 1 implementation should prefer `disable_notification = true` for in-window alerts
- do not delay critical alerts yet

This keeps logic simple and avoids backlog distortion.

Acceptance criteria:

- Quiet hours reduce notification noise without suppressing message delivery.

### Verification

- Add migration tests/backfill tests if migration harness supports them.
- Add dispatcher tests for per-subscription filtering and worsening thresholds.
- Add command tests covering creation and update of per-coin preferences.

---

## Phase 3: Webhook UX and Command-Safety Tightening

### Goal

Make the current bot command surface harder to misuse and easier to recover from.

### Deliverables

1. Disambiguation cancel/recovery flow
2. Symmetric unsubscribe disambiguation
3. Preference management commands
4. Better acknowledgement and validation copy

### Implementation Tasks

#### 3.1 Add `/cancel` and allow commands during pending disambiguation

Implementation:

1. Support `/cancel` to clear `telegram_pending_disambiguation`.
2. While pending disambiguation exists:
   - allow `/cancel`
   - allow `/help`
   - allow `/list`
   - allow a new `/subscribe ...` to replace the pending workflow cleanly
3. Only treat plain numeric replies as disambiguation responses.

Acceptance criteria:

- Users are not trapped in pending-selection mode for five minutes.
- A mistaken reply can be abandoned without waiting for expiry.

#### 3.2 Reuse disambiguation flow for `/unsubscribe`

Implementation:

1. Change ambiguous ticker handling in `/unsubscribe` to mirror `/subscribe`.
2. Track pending action type in `telegram_pending_disambiguation`, or create a separate generic “pending command resolution” structure.

Recommendation:

Extend `telegram_pending_disambiguation` with:

- `action_type` (`subscribe` or `unsubscribe`)

That is sufficient and keeps the model simple.

Acceptance criteria:

- Ambiguous unsubscribe does not delete all matching subscriptions automatically.

#### 3.3 Add commands for preference management

Because Phase 2 introduces per-subscription controls, the bot needs an ergonomic way to manage them.

Recommended commands:

- `/subscribe <types> <tickers>`  
  remains the fast path
- `/unsubscribe <tickers>`
- `/list`
- `/cancel`
- `/set <ticker> <setting> <value>`
- `/mute <start>-<end>` and `/unmutehours`

Examples:

```text
/set USDT dews WARNING
/set DAI safety downgrade-only
/set USDC depeg-step 250
/mute 22-07
```

Design constraint:

- keep the grammar narrow and deterministic
- avoid free-form natural-language parsing

Acceptance criteria:

- Users can modify per-coin settings without deleting/recreating subscriptions.
- Help text is short, deterministic, and consistent with actual behavior.

#### 3.4 Improve acknowledgement copy

Implementation:

1. After subscribe/unsubscribe/set actions, return:
   - what changed
   - current settings for the affected coins
2. `/list` should render:
   - followed coins
   - enabled alert types per coin
   - thresholds/modes when non-default
   - quiet-hours state

Acceptance criteria:

- Users can inspect their effective state from inside Telegram without ambiguity.

### Verification

- Extend webhook tests for `/cancel`, command passthrough during pending disambiguation, and ambiguous unsubscribe.
- Add tests for `/set` parsing and `/list` output.

---

## Phase 4: Operator Hardening and Public Accuracy

### Goal

Align runtime truth, status visibility, and public claims.

### Deliverables

1. Methodology-aware safety alert suppression or labeling
2. Better Telegram bot admin metrics
3. Accurate public timing/capability copy
4. Safer webhook registration process

### Implementation Tasks

#### 4.1 Make safety alerts methodology-aware

Implementation:

1. Extend the dispatch query/types to read `methodology_version` for latest safety rows.
2. Compare the latest row’s methodology version to the previous snapshot’s version.
3. Define policy:
   - if only methodology changed and grade changed at the same time, suppress user alerts by default
   - optionally record internally as `suppressed_methodology_change`
4. If you want user visibility later, surface this via operator status first, not user messaging.

Recommended snapshot change:

Store methodology version in the safety snapshot cache:

```json
{
  "usdc-circle": { "grade": "A", "score": 84, "methodologyVersion": "vX.Y" }
}
```

Acceptance criteria:

- A methodology rollout cannot generate false market-risk safety alerts.

#### 4.2 Expand Telegram bot stats

Implementation:

1. Expose additional aggregate metrics in `/api/status`:
   - chats with per-subscription preferences
   - quiet-hours enabled chats
   - fresh failures last run
   - retry backlog size
   - expired pending count last run
   - dropped-after-max-attempt count last run
2. Update the status card to show:
   - delivery quality
   - backlog pressure
   - whether recent runs were mostly sends or mostly retries

Acceptance criteria:

- Operators can tell the difference between product adoption and delivery health.

#### 4.3 Align public `/telegram` copy with actual timing

Implementation:

1. Clarify on [page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/telegram/page.tsx):
   - depeg and DEWS are near-real-time / cron-driven
   - safety alerts are daily after snapshot
2. Update example messages to match the real current formatting more closely.
3. Consider surfacing the current supported commands from a shared source or at least keep docs and page text in lockstep.

Acceptance criteria:

- The page no longer implies all alert families are equally real-time.

#### 4.4 Reduce secret exposure in webhook registration

Implementation:

1. Stop echoing the full webhook URL with secret in `scripts/register-telegram-webhook.sh`.
2. Print a redacted URL instead.
3. Optionally support a `WEBHOOK_BASE_URL` env override for non-prod registration.
4. Keep query-param secret validation if desired for now; the immediate issue is exposure hygiene, not auth redesign.

Acceptance criteria:

- Normal operator usage no longer prints the full secret-bearing webhook URL to stdout.

### Verification

- Add safety methodology-change tests.
- Add status endpoint tests for new fields.
- Manually verify redacted webhook registration output.

---

## Phase 5: Migration, Docs, and Rollout

### Goal

Ship the tightened bot without breaking existing subscribers.

### Rollout Strategy

#### 5.1 Ship in compatibility mode first

Order:

1. Add schema changes
2. Backfill subscription-level flags from existing chat-global flags
3. Update dispatcher to read subscription-level values with fallback compatibility
4. Add new commands/UI copy
5. Remove dependence on old chat-global flags only after observing stable behavior

#### 5.2 Add explicit admin validation steps

Recommended operator checklist after deploy:

1. Confirm webhook still replies to `/start`, `/help`, `/list`
2. Subscribe a test chat to one coin per alert type
3. Force a synthetic dispatch test in staging or seeded test fixtures
4. Confirm `/status` shows:
   - chunk-based counts
   - retry queue counts
   - no stale “50-message cap” text
5. Confirm quiet-hours and per-coin settings persist across updates

#### 5.3 Documentation updates

Must update:

- `docs/telegram-alerts.md`
  - schema
  - command list
  - alert filtering semantics
  - queue semantics
  - status metadata
- `docs/worker-infrastructure.md`
  - cron metadata and Telegram status fields
- `docs/status-dashboard.md`
  - Telegram panel semantics
- `docs/api-reference.md`
  - `/api/status` additions if response shape changes
- `src/app/telegram/page.tsx`
  - public accuracy and command examples

#### 5.4 Cleanup candidates after rollout stabilizes

Potential follow-up cleanup after one stable release:

- deprecate chat-global alert flags or keep only as defaults
- prune old status-parser compatibility branches
- simplify legacy safety-snapshot compatibility logic once methodology-version-aware snapshots are fully deployed

---

## Proposed Work Breakdown by PR

### PR 1: Delivery correctness

- rich Telegram send result model
- retryable fresh-send enqueue path
- chunk-based budget enforcement
- status metadata correction
- tests

### PR 2: Subscription model foundation

- migrations for per-subscription flags and quiet hours
- dispatcher query updates
- compatibility backfill
- tests

### PR 3: Graduated alert controls

- DEWS floor
- safety mode
- depeg worsening milestones
- `telegram_alert_state` support if needed
- tests

### PR 4: Command-surface tightening

- `/cancel`
- safe pending-command handling
- symmetric unsubscribe disambiguation
- `/set`, `/mute`, `/unmutehours`
- list/help output refresh
- tests

### PR 5: Truthfulness and rollout hardening

- methodology-aware safety suppression
- `/telegram` copy fixes
- status dashboard expansion
- webhook script redaction
- docs

This keeps risk concentrated and makes regressions easier to isolate.

---

## Open Questions To Resolve During Implementation

These do not block the plan, but they should be settled before Phase 2 lands:

1. Should quiet hours suppress only notification sounds or also defer low-priority messages?
   Recommendation: start with `disable_notification` only.

2. Should safety methodology-driven changes be fully suppressed or shown as a labeled low-priority note?
   Recommendation: suppress for user alerts, expose via status/admin only.

3. What should the default worsening step be for depeg alerts?
   Recommendation: null by default, opt-in at first; avoid surprise noise increases.

4. Should the old chat-global booleans remain as default templates for future `/subscribe` commands?
   Recommendation: yes, temporarily, until the new per-subscription UX has proven out.

5. Should `/list` remain plain text or move to a denser, more structured layout?
   Recommendation: keep plain text, but make settings explicit and deterministic.

---

## Recommended Acceptance Gate

Do not call the tightening effort complete until all of the following are true:

1. Fresh send failures are no longer silently dropped.
2. Dispatch cap is enforced against actual Telegram sends.
3. Status metadata accurately reflects failures, retries, and backlog.
4. Users can express different alert preferences per coin.
5. Ambiguous unsubscribe no longer removes all matches automatically.
6. Pending disambiguation no longer traps normal command usage.
7. Safety alerts are protected from methodology-only regrade noise.
8. Public `/telegram` copy accurately describes timing behavior.

---

## Summary

The fastest path to a materially better Telegram bot is:

1. fix silent delivery loss
2. make the cap and queue honest
3. introduce per-coin controls
4. add worsening-depeg and thresholded alerting
5. clean up the command surface and public truthfulness

That tightens the current bot into a credible professional tool without broadening the product into a larger Telegram platform.
