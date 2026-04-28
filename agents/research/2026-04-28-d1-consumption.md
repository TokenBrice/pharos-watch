# D1 Consumption Investigation - 2026-04-28

## Scope

Assumption: "recent weeks" means the maximum currently available D1 analytics retention window, about 31 days. Cloudflare GraphQL rejected a 35-day request and the official D1 metrics docs state metrics are retained for the past 31 days.

Database:

- Name: `stablecoin-db`
- ID: `8f3f54ca-e035-4cdf-9ec5-a4fbbe48b27a`
- Region: `EEUR`
- Size: `1.91 GB`
- Tables: `66`
- Read replication: disabled

## Current 24h Snapshot

From `wrangler d1 info stablecoin-db` on 2026-04-28:

- Read queries: `97,276`
- Write queries: `150,967`
- Rows read: `810,071,703`
- Rows written: `396,794`

This is read-heavy by rows scanned, not by query count. Current average is roughly `8.3k` rows read per read query.

## Daily Rows Read Trend

Complete-day UTC totals from Cloudflare GraphQL:

| Window | Read queries | Rows read | Rows/read query | Write queries | Rows written |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-03-28..2026-04-03 | 3,899,491 | 14,285,733,344 | 3,663 | 3,463,663 | 7,909,394 |
| 2026-04-04..2026-04-10 | 994,045 | 19,467,055,201 | 19,584 | 2,054,617 | 5,415,227 |
| 2026-04-11..2026-04-17 | 1,122,922 | 12,103,862,652 | 10,779 | 2,025,012 | 6,631,663 |
| 2026-04-18..2026-04-24 | 974,481 | 8,727,050,688 | 8,956 | 1,446,978 | 3,797,300 |
| 2026-04-25..2026-04-27 | 343,311 | 2,895,462,648 | 8,434 | 530,435 | 1,375,079 |

Highest complete UTC days by rows read:

- 2026-04-07: `4.185B`
- 2026-03-28: `3.838B`
- 2026-04-10: `3.688B`
- 2026-04-08: `3.544B`
- 2026-04-09: `3.148B`

Interpretation: row reads peaked around 2026-04-07 to 2026-04-10, then stepped down. The latest complete days are around `0.85B` to `1.11B` rows/day, far below the early-April peak but still dominated by table/large-index scans.

## Hot Read Queries

Last 30 days, largest row-read fingerprints:

1. `SELECT symbol, MAX(timestamp) ... FROM mint_burn_events ... GROUP BY symbol`
   - `19.18B` rows read over 20,648 runs.
   - This does not appear in the 14-day or 24-hour top-read lists, so it is a historical driver that has already dropped out.

2. `SELECT stablecoin_id, MIN(snapshot_date) as first_seen FROM supply_history GROUP BY stablecoin_id`
   - `5.85B` rows read over 50,896 runs in 30d.
   - Still current: `184.4M` rows read in the last 24h.
   - Source: `worker/src/lib/db.ts`.

3. `mint_burn_hourly` aggregate net-flow queries for `/api/mint-burn-flows`
   - `5.23B` rows read over 39,969 runs in 30d.
   - Still current: `166.2M` rows read in the last 24h for the two-chain variant.
   - Source: `worker/src/api/mint-burn-flows.ts`.

4. `COUNT(*) FROM mint_burn_events ... stablecoin_id = ? AND chain_id IN (?) AND flow_type = 'standard' ...`
   - `3.09B` rows read over 5,409 runs in 30d.
   - Still current: `180.7M` rows read in the last 24h, only 162 runs but ~1.1M rows/run.
   - Source: `worker/src/api/mint-burn-flows.ts` / event pagination count surface.

5. Blacklist summary/ranked event scans and DEWS latest-signal scans
   - Individually smaller but persistent.
   - Examples include ranked `blacklist_events` latest-by-address, blacklist gap summaries, and latest `stress_signals` per coin.

## Current Relevant Table Cardinality

Remote count query on 2026-04-28:

- `mint_burn_events`: `1,272,451`
- `yield_history`: `232,061`
- `supply_history`: `140,155`
- `mint_burn_hourly`: `139,370`
- `stress_signals`: `56,130`
- `depeg_events`: `33,920`
- `blacklist_events`: `18,715`
- `cron_runs`: `9,224`

The biggest row-read pressure is not from returning large payloads; it is repeated scans/grouping across `mint_burn_events`, `mint_burn_hourly`, and `supply_history`.

## Notes

- Cloudflare D1 bills by rows read, rows written, and storage; read query count itself is not the billing metric.
- Wrangler/API reads performed during this investigation also count as usage.
- The 30-day top-query list includes historical fingerprints, so current mitigation should prioritize the 24h/14d hot lists over the full 30d list.

## Follow-up: Worker/Route Attribution

Cloudflare D1 analytics exposes database/query fingerprints, not a clean "rows read by Worker script" breakdown. In this repo there are only two runtime surfaces bound to `stablecoin-db`:

- `stablecoin-api` Worker (`worker/wrangler.toml`) for all API handlers and crons.
- Pages `/_site-data/*` Function, which has an optional `DB` binding for request attribution telemetry only.

The biggest consumers are therefore best identified by SQL fingerprint -> code path:

| 14d fingerprint / path | Rows read | Share of 14d rows | Inferred owner |
| --- | ---: | ---: | --- |
| `mint_burn_hourly` net-flow grouped by stablecoin/chain | 3.47B | 21.5% | `/api/mint-burn-flows` |
| `supply_history` first-seen grouped by stablecoin | 3.16B | 19.5% | `derivePegAnalyticsSnapshot()` used by `/api/peg-summary` and report-card publication |
| `mint_burn_events` counted total | 3.02B | 18.7% | `/api/mint-burn-events` pagination count |
| `mint_burn_hourly` first-hour grouped by stablecoin/chain | 1.21B | 7.5% | `/api/mint-burn-flows` |
| `mint_burn_events` atomic-roundtrip repair update | 0.95B | 5.9% | admin/backfill repair, not steady public traffic |
| `blacklist_events` gap summary | 0.52B | 3.2% | blacklist summary/status surfaces |
| `depeg_events` four-year event load | 0.51B | 3.2% | peg analytics and/or depeg events |
| `blacklist_events` latest-by-address ranked scan | 0.45B | 2.8% | `/api/blacklist-summary` |

Own request telemetry over the last 14 days:

- `public-api` external: `183,224` requests
- `site-api` site: `168,011` requests
- `public-api` site: `11,728` requests

Top request-count routes were `/api/peg-summary`, `/api/depeg-events`, `/api/stablecoin-summary/:id`, `/api/health`, `/api/blacklist`, and `/api/stablecoin/:id`, but request count is not a reliable proxy for rows read. `/api/mint-burn-flows` and `/api/mint-burn-events` are lower request-count but much higher row-scan per miss.

## Low/No-impact Reduction Candidates

1. **Cache the first-seen map used by peg analytics.**
   - Current impact: ~`3.16B` rows read / 14d, or ~`6.8B` projected monthly.
   - Reason: `SELECT stablecoin_id, MIN(snapshot_date) ... GROUP BY stablecoin_id` scans the full `supply_history` covering index every time peg analytics is built.
   - Low-impact fix: maintain a tiny cache row or derived table keyed by `stablecoin_id -> first_seen`, refreshed by the daily supply snapshot/backfill path.
   - Expected behavior impact: none; values change only when a new coin gets its first snapshot or history is backfilled.

2. **Stop doing live aggregate scans for `/api/mint-burn-flows`.**
   - Current impact: at least ~`4.9B` rows read / 14d across net-flow, first-hour, and daily-baseline queries, or ~`10B+` projected monthly.
   - Reason: the endpoint recomputes 7d/30d/90d aggregates and first-seen buckets from `mint_burn_hourly` on request.
   - Low/medium-impact fix: publish an aggregate flow snapshot from the mint/burn cron or cache the endpoint payload for a short TTL in D1/Cache API by canonical query params.
   - Expected behavior impact: bounded freshness delay matching existing cache profile; the endpoint already advertises a standard cache profile in the shared response helper.

3. **Add a partial/composite index for counted mint/burn events.**
   - Current impact: ~`3.02B` rows read / 14d, or ~`6.5B` projected monthly.
   - Current query plan uses `idx_mbe_flow_type_ts (flow_type=?)`, then scans a large standard-flow slice.
   - Low-impact migration candidate:
     `CREATE INDEX IF NOT EXISTS idx_mbe_counted_coin_chain_ts ON mint_burn_events(stablecoin_id, chain_id, timestamp DESC) WHERE flow_type = 'standard' AND (direction = 'mint' OR burn_type = 'effective_burn');`
   - Expected behavior impact: none; modest write/storage overhead on counted event inserts, likely strongly offset by lower reads.

4. **Treat one-off admin/backfill scans separately from steady-state public traffic.**
   - The `UPDATE mint_burn_events SET flow_type = 'atomic_roundtrip'...` fingerprint consumed ~`0.95B` rows in the last 14d but is repair/admin work, not site/API baseline. It should not drive product caching decisions, but future repair tools should batch with supporting indexes or offline windows.

5. **Do not prioritize Pages attribution telemetry for rows-read cost.**
   - It contributes mostly writes, not rows read. The expensive part is the upstream Worker handlers and cron/admin SQL, not the Pages `/_site-data/*` telemetry insert.

## Current Run-rate

For 2026-04-14 19:51 UTC through 2026-04-28 19:51 UTC:

- Rows read: `16,165,513,505`
- Read queries: `1,992,978`
- Rows/read query: `8,111`
- Projected 30-day rows read at this pace: `34,640,386,082`
- Projected overage above 25B included rows: `9,640,386,082`
- Projected D1 rows-read overage at `$0.001 / 1M`: about `$9.64`
