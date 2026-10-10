# Runbook: Telegram Preset Resolution Failure

## Symptom

`presetQueryFailures` or `presetResolutionFailures` rises in dispatch metadata, or Telegram delivery stalls for a run because the alert source event never finishes preset resolution — direct, global, and preset targets all wait on the same source event.

Detection signals:

- `/api/status` -> `telegramBot.presetQueryFailures` shows a non-zero counter (only emitted when greater than zero).
- `crons["dispatch-telegram-alerts"].lastRun.metadata` contains `presetQueryFailures > 0` or `presetResolutionFailures > 0`. `presetFailure: true` only means source resolution was incomplete on that run — it is also set when preset resolution pages were merely deferred to the next tick (`last_error_class = 'preset_pages_pending'`), so confirm one of the counters before treating it as a failure.
- Wrangler tail logs `dynamic preset source page query failed` (`failureKind: 'query-failed'`) or `dynamic preset source page resolution failed` (`failureKind: 'resolution-failed'`) from `module: telegram-alert-source-events` when `telegram_preset_subscriptions` has rows but the preset query throws or the strict stablecoins cache is missing; a failing follower page logs `dynamic preset follower page query failed` from the same module.

Behavior: the alert source event stays incomplete and new target planning stays closed for every target family — direct, global, and preset — rather than treating preset-backed recipients as an empty list. This source-wide hold is intentional; never bypass `allComplete`. Existing pending work may still drain and freeze uses an independent outbox. Snapshot baselines stay held until resolution completes or bounded source-expiry cleanup finishes; expiry advances the stored baseline without delivering the unresolved source. A later dispatch run resumes a still-live source without replaying terminal targets. After expiry, do not hand-enqueue or assume an operator resend exists. See [`docs/telegram-alerts.md`](../telegram-alerts.md) section "Preset Watchlists" for the fail-closed contract.

## Quick Diagnostic Checklist

1. **D1 schema drift?** The live `telegram_preset_subscriptions` queries run in `resolveMemberships` and `resolveFollowerPage` (`worker/src/cron/telegram-alert-source-memberships.ts`), driven by `resolveTelegramAlertSourcePresetPages`; `resolveMemberships` calls `resolveTelegramPresetTargets` to map preset aliases to coins. Confirm the migration list (`worker/migrations/MANIFEST.md`) is in sync and the latest migration matches the deployed Worker.
2. **Stablecoins cache available?** The resolver reads the strict `stablecoins` cache plus `ACTIVE_STABLECOINS` (active coins only; every non-active lifecycle is excluded). A missing or malformed stablecoins cache makes resolution fail closed. Check the `sync-stablecoins` cron and the `stablecoins` cache row before looking at safety-alert source state.
3. **Registry or supply drift?** Preset definitions and aliases are owned by `shared/lib/telegram-presets.ts`; target resolution uses the Worker runtime registry. Compare followed `preset_id` values with that catalog and inspect active lifecycle, peg, and observed supply inputs. An empty resolved preset is valid when no eligible assets meet its criteria; it is not a resolution failure.
4. **Transient D1 failure?** `presetQueryFailures` increments when the `telegram_preset_subscriptions` SELECT throws. Check the `telegram-api` and D1 circuits via [`db-connectivity.md`](./db-connectivity.md).

## Operator Commands

Review the resolver and its inputs:

```bash
# Source-of-truth for resolver behavior
worker/src/lib/telegram/presets.ts
# Specifically: resolveTelegramPresetTargets
```

Inspect preset rows currently followed by chats:

```sql
SELECT preset_id, COUNT(*) AS followers
FROM telegram_preset_subscriptions
GROUP BY preset_id
ORDER BY followers DESC;
```

Check the stablecoins cache and preset counters:

```bash
cd worker
npx wrangler tail stablecoin-api --format pretty
# Look for sync-stablecoins run completions and stablecoins cache writes.
curl -sS -H "CF-Access-Client-Id: $CF_ID" \
        -H "CF-Access-Client-Secret: $CF_SECRET" \
        https://ops-api.pharos.watch/api/status | jq '.dataQuality.stablecoinsCacheStatus, .dataQuality.stablecoinsCacheReason, .telegramBot.presetQueryFailures, .crons["dispatch-telegram-alerts"].lastRun.metadata.presetResolutionFailures'
```

After fixing the upstream cause, the next five-minute `dispatch-telegram-alerts` tick retries a live source. There is no preset-only re-fire. The persistent `telegram:preset-query-failure-count` resets on a run without query or resolution failures, even if pages remain deferred; confirm resolution completion and target-plan progress separately before claiming delivery resumed.

## Remediation

1. **Schema drift.** Apply the missing migration. Standard deploys apply D1 migrations before the new Worker is live, so a drift here indicates a partial rollback or a manually-applied environment.
2. **Stablecoins-cache miss.** Trigger or wait for the next `sync-stablecoins` run; the resolver will succeed on the next dispatch tick once the strict stablecoins cache is readable. Confirm via the stablecoins-cache fields in `/api/status`.
3. **Registry or supply drift.** Check followed IDs against `shared/lib/telegram-presets.ts` and verify the active lifecycle, peg, and observed supply inputs in `worker/src/lib/telegram/presets.ts`. Repair a confirmed registry/cache defect; do not restore a legitimately inactive asset or remove a preset merely because its current target set is empty.
4. **Transient D1.** No operator action; the counter resets on the next clean run. If the counter sticks above zero for three consecutive runs, escalate via [`db-connectivity.md`](./db-connectivity.md).

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section "Preset Watchlists" — fail-closed contract.
- [`docs/telegram-mini-app.md`](../telegram-mini-app.md) — preset payloads (`presets`) and Mini App preset operations.
- [`db-connectivity.md`](./db-connectivity.md) — D1 read failures.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) — broader dispatch diagnostics.
- [`telegram-operator-queries.md`](./telegram-operator-queries.md) — D1 queries for pending, jobs, and dead letters.
