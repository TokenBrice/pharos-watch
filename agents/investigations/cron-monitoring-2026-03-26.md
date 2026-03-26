# Cron Monitoring Engagement - 2026-03-26

## Scope

Audit every scheduled cron lane, monitor remote runs, harden resilience where needed, and keep iterating until each job shows three consecutive flawless runs.

## Loop Tracker

| Job | Schedule | Audit complete | Monitored runs | Flawless streak | Notes |
| --- | --- | --- | --- | --- | --- |
| `sync-stablecoins` | `*/15 * * * *` | yes | 0 | 0 | Recent production history includes intermittent errors/degraded runs; audit done, monitoring pending |
| `sync-fx-rates` | `*/15 * * * *` | yes | 0 | 0 | Historical degraded runs seen in cron history; monitoring pending |
| `status-self-check` | `*/15 * * * *` | yes | 0 | 0 | Historical degraded runs look genuine endpoint slowness, not a code bug yet |
| `snapshot-supply` | `*/15 * * * *` | yes | 0 | 0 | Audit done via shared quarter-hourly lane |
| `snapshot-chain-supply` | `*/15 * * * *` | yes | 0 | 0 | Audit done via shared quarter-hourly lane |
| `sync-blacklist` | `3 * * * *` | yes | 0 | 0 | Potential resilience work identified around recoverable pending rows and D1 batch sizing |
| `sync-mint-burn` | `4,24,44 * * * *` | yes | 0 | 0 | No fresh code issue identified yet |
| `sync-dex-discovery` | `6,36 * * * *` | yes | 0 | 0 | No fresh code issue identified yet |
| `sync-stablecoin-charts` | `10,40 * * * *` | yes | 0 | 0 | Audited as part of half-hourly slot |
| `sync-dex-liquidity` | `10,40 * * * *` | yes | 0 | 0 | Hardening applied: optional direct API outages no longer degrade the whole run; PancakeSwap invalid-json diagnostics improved |
| `compute-dews` | `10,40 * * * *` | yes | 0 | 0 | Audited as part of half-hourly slot |
| `stability-index` | `10,40 * * * *` | yes | 0 | 0 | Audited as part of half-hourly slot |
| `sync-yield-data` | `10,40 * * * *` | yes | 0 | 0 | Hardening applied: deterministic on-chain rate fetch batch size reduced from 4 to 2 |
| `sync-live-reserves` | `11 * * * *` | yes | 0 | 0 | Potential resilience work identified around non-JSON upstream payload handling |
| `sync-mint-burn-extended` | `13,33,53 * * * *` | yes | 0 | 0 | Historical SQL issue appears already fixed |
| `dispatch-telegram-alerts` | `2,7,12,17,22,27,32,37,42,47,52,57 * * * *` | yes | 0 | 0 | No fresh code issue identified yet |
| `snapshot-safety-grade-history` | `0 8 * * *` | yes | 0 | 0 | Audited as part of daily 08:00 lane |
| `snapshot-supply` daily fallback | `0 8 * * *` | yes | 0 | 0 | Shares implementation with quarter-hourly write path |
| `snapshot-chain-supply` daily fallback | `0 8 * * *` | yes | 0 | 0 | Shares implementation with quarter-hourly write path |
| `snapshot-psi` | `0 8 * * *` | yes | 0 | 0 | Audited as part of daily 08:00 lane |
| `sync-usds-status` | `0 8 * * *` | yes | 0 | 0 | Audited as part of daily 08:00 lane |
| `fetch-tbill-rate` | `0 8 * * *` | yes | 0 | 0 | FRED fallback behavior looked intentional |
| `sync-bluechip` | `5 8 * * *` | yes | 0 | 0 | Hardening applied: JSON parse failures are slug-scoped; partial merges no longer poison the breaker |
| `daily-digest` | `5 8 * * *` | yes | 0 | 0 | Slot containment added so digest failure does not abort sibling jobs |
| `weekly-recap` | `5 8 * * *` | yes | 0 | 0 | Slot containment added so recap failure does not abort sibling jobs |
| `discovery-scan` | `5 8 * * *` | yes | 0 | 0 | Slot containment added so discovery failure does not abort sibling jobs |
| `yield-coverage-audit` | `0 6 1 * *` | yes | 0 | 0 | Audited; manual trigger pending because of monthly fence cadence |

## Code Changes Applied

1. `daily-0805` slot now isolates each child job so one thrown job does not abort the rest of the lane.
2. `sync-bluechip` now records malformed `200` responses as slug-scoped parse failures and treats degraded partial refreshes as breaker-neutral when at least one slug refreshed.
3. `sync-dex-liquidity` now keeps optional direct API outages in metadata instead of escalating the whole run to degraded unless coverage/value guards also worsen materially.
4. PancakeSwap subgraph fetches now emit explicit `invalid-json` diagnostics with body snippets.
5. `sync-yield-data` reduces deterministic on-chain rate fetch concurrency to avoid bursty RPC null failures.

## Validation Status

- Targeted tests covering the changed cron paths are passing.
- Full repo validation is in progress before remote monitoring loops begin.
