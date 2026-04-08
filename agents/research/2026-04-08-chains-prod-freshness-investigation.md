# Chains Prod Freshness Investigation

Date: 2026-04-08

## Question

Is the `/chains/` production warning banner accurate, and does it indicate an operational issue that needs immediate action?

## Live Production Evidence

Checked against the browser lane the site actually uses:

- `https://pharos.watch/_site-data/chains`
- `https://pharos.watch/_site-data/stablecoins`
- `https://pharos.watch/_site-data/public-status-history`

Observed at `2026-04-08 19:15:45 GMT+2`:

- `/chains` returned `200`
- `_meta.updatedAt = 1775667647` -> `2026-04-08 19:00:47 GMT+2`
- `_meta.ageSeconds = 898`
- `_meta.status = "degraded"`
- `Warning: 110 - "Response is degraded (898s old, max 600s)"`
- `_meta.dependencies.reportCards.status = "fresh"`

Observed at `2026-04-08 19:18:49 GMT+2`:

- public status history reported `currentStatus = "healthy"`
- `/chains` was still on the same `19:00:47 GMT+2` snapshot

Polling `/chains` through `19:18:20 GMT+2` continued to show the same snapshot with ages from `962s` to `1054s`.

Observed at `2026-04-08 19:19:48 GMT+2`:

- `/chains` advanced to `_meta.updatedAt = 1775668552` -> `2026-04-08 19:15:52 GMT+2`
- `_meta.ageSeconds = 236`
- `_meta.status = "fresh"`

## Local Code Path

Relevant files:

- `worker/src/api/chains.ts`
- `shared/lib/api-freshness.ts`
- `worker/wrangler.toml`
- `worker/src/handlers/scheduled/quarter-hourly.ts`
- `src/components/data-health-banner.tsx`
- `src/lib/data-health.ts`

Current behavior:

- `sync-stablecoins` runs on the quarter-hourly slot: `*/15 * * * *`
- `/api/chains` is computed from the stablecoins cache on read
- `/api/chains` hard-codes freshness `maxAge = 600s`
- `/api/stablecoins` uses freshness `maxAge = 900s`
- quarter-hourly slot alerting only escalates when the stablecoins cache exceeds `1800s` (`expected <20min`)

## Assessment

The banner is **accurate relative to current `/chains` rules**.

It is **not strong evidence of a production incident**.

Why:

- the chains route is warning on a `10 minute` age budget
- its upstream data source refreshes on a `15 minute` cadence
- public system status was still `healthy`
- the degraded state was caused by stablecoins snapshot age, not by stale report cards or a missing dependency

This means the page can warn during the normal end of each quarter-hour cycle, especially if the `sync-stablecoins` slot lands closer to `+16m` to `+19m` than `+15m`.

## Recommendation

No emergency operational action is needed from this evidence alone.

Recommended product/logic follow-up:

1. Align `/chains` freshness budget with the stablecoins source cadence, most likely `900s` minimum.
2. If the stricter `600s` budget is intentional, change the UX copy so it does not read like an incident during the expected pre-refresh window.
3. Only treat this as an ops issue when the stablecoins cache age moves materially beyond the slot budget, for example toward the existing `>20m` operator alert threshold or when public status also degrades.

## Bottom Line

The warning is real according to current code, but it currently behaves more like a noisy policy mismatch than a reliable production-failure signal.
