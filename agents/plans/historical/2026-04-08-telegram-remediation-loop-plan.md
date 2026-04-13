# Telegram Bot Remediation Loop Plan

Date: 2026-04-08
Owner: Codex
Scope: Telegram webhook + dispatch lane + status/pulse metrics + `/telegram` landing page + docs

## Objective

Remediate the Telegram audit findings, then run a review/fix loop until the review phase returns fewer than one medium issue.

## Confirmed Issues To Fix

1. Fresh-alert rate-limit tail loss:
   `sendBatch()` stops after a `429`, but the untouched tail of `sendList` is not surfaced back to the caller for requeue.
2. Launch subscription visibility gap:
   `/list` and subscription summary reads omit `alert_launch`, so launch follows can appear muted.
3. Public/ops metric drift:
   Telegram pulse and bot stats ignore launch flags in key aggregates, and pulse/top-coin counts include muted rows.
4. Public surface drift:
   `/telegram` markets only three alert types and uses “real alert format” copy that no longer matches actual message structure or launch support.
5. Newly discovered launch-subscription target-resolution defect:
   ticker resolution indexes active coins only, so explicit pre-launch launch targets can fail to resolve.
6. Documentation drift:
   `docs/telegram-alerts.md` still says `/unsubscribe all` does not clear launch flags.

## Execution Plan

### Phase 1: Fix worker correctness

- Update Telegram target resolution so explicit pre-launch tracked coins can resolve cleanly for launch subscriptions.
- Fix `sendBatch()` or its caller so unattempted messages after a rate-limit stop are requeued deterministically.
- Update subscription read queries to select `alert_launch`.

### Phase 2: Fix observability and public metrics

- Update Telegram pulse metrics to count launch-enabled watchers and only count active subscription rows in public vanity metrics.
- Update Telegram bot status aggregates to include launch-enabled chats and prevent launch-only chats from being undercounted in “alert enabled” / “deliverable” rollups.
- If warranted, extend the status shape/UI to surface launch coverage explicitly.

### Phase 3: Fix public/docs communication

- Update `/telegram` copy, examples, and command framing so they reflect:
  - four alert types
  - launch support
  - actual message-shape expectations
  - presets vs explicit launch targets
- Update `docs/telegram-alerts.md` to match current `/unsubscribe all` behavior and any metric/command clarifications introduced by code changes.

### Phase 4: Verification expansion

- Add/expand tests for:
  - pre-launch target resolution for launch subscriptions
  - launch visibility in `/list` and summary reads
  - rate-limit tail requeue behavior
  - launch-aware pulse/stats aggregates
  - `/telegram` content only if there is an existing page test surface; otherwise rely on build + SEO gate

### Phase 5: Validation loop

1. Run targeted Telegram tests.
2. Run root typecheck, worker typecheck, lint, build, and SEO check.
3. Perform a fresh code review focused on correctness, trigger/send behavior, maintainability, and public-surface accuracy.
4. If review finds any medium-or-higher issue, return to implementation and repeat from the relevant phase.
5. Exit only when the review returns zero medium-or-higher issues.

## Review Gate Criteria

The loop only exits when all of the following are true:

- No medium-or-higher implementation defect remains in Telegram delivery semantics.
- No medium-or-higher issue remains in launch subscription correctness.
- No medium-or-higher drift remains between actual bot capability and `/telegram` / docs communication.
- Verification passes locally on the relevant surfaces.

## Expected Deliverables

- Worker code fixes
- Updated Telegram tests
- Updated `/telegram` landing page
- Updated `docs/telegram-alerts.md`
- Final review summary with residual risks, if any
