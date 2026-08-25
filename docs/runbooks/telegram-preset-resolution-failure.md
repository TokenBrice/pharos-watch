# Runbook: Telegram Preset Resolution Failure

## Symptom

`presetQueryFailures` or `presetResolutionFailures` rises in dispatch metadata, or Telegram delivery stalls for a run because the alert source event never finishes preset resolution — direct, global, and preset targets all wait on the same source event.

Detection signals:

- `/api/status` -> `telegramBot.presetQueryFailures` shows a non-zero counter (only emitted when greater than zero).
- `crons["dispatch-telegram-alerts"].lastRun.metadata` contains `presetQueryFailures > 0` or `presetResolutionFailures > 0`. `presetFailure: true` only means source resolution was incomplete on that run — it is also set when preset resolution pages were merely deferred to the next tick (`last_error_class = 'preset_pages_pending'`), so confirm one of the counters before treating it as a failure.
- Wrangler tail logs `dynamic preset source page query failed` (`failureKind: 'query-failed'`) or `dynamic preset source page resolution failed` (`failureKind: 'resolution-failed'`) from `module: telegram-alert-source-events` when `telegram_preset_subscriptions` has rows but the preset query throws or the strict stablecoins cache is missing; a failing follower page logs `dynamic preset follower page query failed` from the same module.

Behavior: the alert source event stays incomplete and delivery stays closed for every target family — direct, global, and preset — rather than treating preset-backed recipients as an empty list. Snapshot baselines do not advance while source resolution is incomplete, and the run records `presetFailure` metadata. A later dispatch run resumes the same source event without replaying terminal targets, so no operator resend is needed unless the source event passes its TTL and is expired. See [`docs/telegram-alerts.md`](../telegram-alerts.md) section "Preset Watchlists" for the fail-closed contract.

## Quick Diagnostic Checklist

1. **D1 schema drift?** The live `telegram_preset_subscriptions` queries run in `resolveMemberships` and `resolveFollowerPage` (`worker/src/cron/telegram-alert-source-events.ts`), driven by `resolveTelegramAlertSourcePresetPages`; `resolveMemberships` calls `resolveTelegramPresetTargets` to map preset aliases to coins. Confirm the migration list (`worker/migrations/MANIFEST.md`) is in sync and the latest migration matches the deployed Worker.
2. **Stablecoins cache available?** The resolver reads the strict `stablecoins` cache plus `ACTIVE_STABLECOINS` (active coins only; every non-active lifecycle is excluded). A missing or malformed stablecoins cache makes resolution fail closed. Check the `sync-stablecoins` cron and the `stablecoins` cache row before looking at safety-alert source state.
3. **TRACKED_STABLECOINS drift?** If a deploy changed `shared/data/stablecoins/coins.generated.json` while the preset rows reference an alias that no longer maps to any active coin, the resolver may return zero targets. Verify each canonical preset alias (`usd-top10`, `usd-top25`, `usd-top50`, `non-usd-top10`, `non-usd-top25`, `non-usd-top50`, `eur-top10`, `gold-top5`, `mcap-ge-1b`, `mcap-ge-100m`) still produces a non-empty target set.
4. **Transient D1 failure?** `presetQueryFailures` increments when the `telegram_preset_subscriptions` SELECT throws. Check the `telegram-api` and D1 circuits via [`db-connectivity.md`](./db-connectivity.md).

## Operator Commands

Review the resolver and its inputs:

```bash
# Source-of-truth for resolver behavior
worker/src/lib/telegram-presets.ts
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

Rerun the preset resolver via the 5-minute Telegram cron lane after fixing the upstream cause: the next scheduled `dispatch-telegram-alerts` run will retry. There is no separate preset-only re-fire; once the cache is repopulated and the next dispatch tick fires, the persistent `telegram:preset-query-failure-count` counter resets and preset delivery resumes.

## Remediation

1. **Schema drift.** Apply the missing migration. Standard deploys apply D1 migrations before the new Worker is live, so a drift here indicates a partial rollback or a manually-applied environment.
2. **Stablecoins-cache miss.** Trigger or wait for the next `sync-stablecoins` run; the resolver will succeed on the next dispatch tick once the strict stablecoins cache is readable. Confirm via the stablecoins-cache fields in `/api/status`.
3. **TRACKED_STABLECOINS drift.** Re-verify the canonical alias map. If a preset alias no longer maps to any active coin, treat it as a bug in the deploy that removed the coin and either restore the coin to the tracked list or remove the alias from the preset catalog before redeploying.
4. **Transient D1.** No operator action; the counter resets on the next clean run. If the counter sticks above zero for three consecutive runs, escalate via [`db-connectivity.md`](./db-connectivity.md).

## Cross-References

- [`docs/telegram-alerts.md`](../telegram-alerts.md) section "Preset Watchlists" — fail-closed contract.
- [`docs/telegram-mini-app.md`](../telegram-mini-app.md) — preset payloads (`presets`) and Mini App preset operations.
- [`db-connectivity.md`](./db-connectivity.md) — D1 read failures.
- [`telegram-no-delivery.md`](./telegram-no-delivery.md) — broader dispatch diagnostics.
- [`telegram-operator-queries.md`](./telegram-operator-queries.md) — D1 queries for pending, jobs, and dead letters.
