# Mint/Burn Ingestion Runbook

Operational runbook for `sync-mint-burn` reliability controls, diagnostics, and recovery.

## Scope

- Cron job: `sync-mint-burn` (schedule: `3,23,43 * * * *`)
- Worker module: `worker/src/cron/sync-mint-burn.ts`
- Backfill endpoint: `POST /api/backfill-mint-burn`

## CCIP Bridge-Burn Coverage (Ethereum)

CCIP bridge-burn processing is enabled for Ethereum Burn/Mint pool tokens only:

- `usdc-circle` (`USDC`) — pool `0x03d19033ada17750d5bc2d8e325337d0748f9fef`
- `usdo-openeden` (`USDO`) — pool `0x500d4882938020e939a5666c1b4200873da7efd3`
- `usd1-world-liberty-financial` (`USD1`) — pool `0x36a72ed0096b414521c45e3ddc9ed657d1d9c141`
- `avusd-avant` (`avUSD`) — pool `0x81b72171642fab457aa815c0b8412a22b63a6af8`
- Baseline pre-existing config: `zchf-frankencoin` (`ZCHF`)

CCIP signal constants in use:

- Router: `0x80226fc0ee2b096224eeac085bb9a8cba1146f7d`
- Topic: `0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd` (`SendRequested`)
- Selector: `0x96f4e9f9` (`ccipSend`)

Excluded from bridge-burn processing:

- Any token not listed in Chainlink CCIP directory mainnet token pages.
- Any token listed as `Lock/Release` on Ethereum in `https://docs.chain.link/ccip/directory/mainnet`.

Only Ethereum `Burn/Mint` pool-type tokens are eligible for this classifier path.

## Runtime Controls

Environment variables:

- `MINT_BURN_DISABLED_IDS`
  - Comma-separated stablecoin IDs or config keys (`{chainId}-{contract}`) to disable.
- `MINT_BURN_DISABLED_SYMBOLS`
  - Comma-separated symbols to disable (`reUSD`, `USDS`, etc).
- `MINT_BURN_MAJOR_SYMBOLS`
  - Optional major-symbol override used by stale-ingestion alerts.
- `MINT_BURN_STALE_WARN_SEC`
  - Warn threshold in seconds (default `21600`, 6h).
- `MINT_BURN_STALE_CRIT_SEC`
  - Critical threshold in seconds (default `86400`, 24h).
- `MINT_BURN_ALERT_COOLDOWN_SEC`
  - Alert dedupe cooldown (default `3600`, 1h).

## Cron Metadata Fields

`cron_runs.metadata` for `sync-mint-burn` now includes:

- `rowsParsed`, `rowsInserted`, `rowsIgnored`, `rowsDropped`
- `configsDisabled`
- `sourceCoverage.contractsEnabled/contractsProcessed/contractsSkipped/contractsTotal`
- `configBreakdown[]` (`attempted`, `scanFrom`, `scanTo`, `failedEventDefs`, `advancedTo`, `advanceReason`, `coverageFrontier`, `missingTimestampCount`, insert stats, per-event coverage)
- `laggingConfigs[]` (largest `head-lastBlock` deltas)
- `coverageRatio`, `degradedSignal`, `degradedStreak`

Status can be `ok`, `degraded`, `error`, or `skipped_locked`.

## Health Checks

### Freshness and lag

```sql
SELECT
  datetime(MAX(timestamp), 'unixepoch') AS latest_event_utc,
  datetime(MAX((timestamp/3600)*3600), 'unixepoch') AS latest_hour_utc,
  (strftime('%s','now') - MAX(timestamp)) AS freshness_age_sec
FROM mint_burn_events;
```

### Coverage: sync state keys

```sql
SELECT COUNT(*) AS sync_state_rows FROM mint_burn_sync_state;
```

### Latest per major symbol

```sql
SELECT
  symbol,
  datetime(MAX(timestamp), 'unixepoch') AS latest_event_utc,
  (strftime('%s','now') - MAX(timestamp)) / 3600.0 AS age_hours
FROM mint_burn_events
WHERE symbol IN ('USDT','USDC','DAI','USDS','GHO','FRXUSD','BOLD','reUSD')
GROUP BY symbol
ORDER BY age_hours DESC;
```

### Recent cron run quality

```sql
SELECT
  datetime(started_at,'unixepoch') AS run_utc,
  status,
  item_count,
  json_extract(metadata, '$.coverageRatio') AS coverage_ratio,
  json_extract(metadata, '$.apiErrors') AS api_errors,
  json_extract(metadata, '$.configsDisabled') AS configs_disabled
FROM cron_runs
WHERE job='sync-mint-burn'
ORDER BY started_at DESC
LIMIT 20;
```

## Controlled Backfill Endpoint

Endpoint:

- `POST /api/backfill-mint-burn`
- Requires `X-Admin-Key`
- Supports `Idempotency-Key`

Request body:

```json
{
  "configKey": "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "fromBlock": 21900000,
  "toBlock": 22100000,
  "chunkSize": 50000,
  "maxChunks": 24
}
```

Response includes:

- `done` / `nextFromBlock`
- `rowsParsed`, `rowsInserted`, `rowsIgnored`, `rowsDropped`
- `chunksProcessed`
- `budgetUsed`

### Example call

```bash
curl -X POST "https://api.pharos.watch/api/backfill-mint-burn" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Idempotency-Key: mb-usdc-2026-03-04-1" \
  -d '{
    "configKey": "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "fromBlock": 21900000,
    "toBlock": 22100000,
    "chunkSize": 50000,
    "maxChunks": 24
  }'
```

## One-Time Recovery Sequence

Use this sequence after any change to sync-frontier or event-coverage advancement semantics.

1. Deploy the worker and verify `sync-mint-burn` is healthy for at least 6 consecutive runs.
2. Identify every config with `events.length > 1`.
   - Current mandatory recovery target: `ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7` (`USDT`)
3. Run `POST /api/backfill-mint-burn` from `startBlock` to head for each multi-event config until `done: true`.
4. After backfill completes, run `POST /api/reclassify-atomic-roundtrips` until `done: true`.
   - This is required because pre-existing rows skipped by `INSERT OR IGNORE` do not get `flow_type` updated during backfill inserts.
5. Re-run freshness and recent-run SQL checks.
6. Spot-check:
   - event totals for the repaired config
   - 24h / 7d / 30d net flow for the repaired config
   - recent hourly buckets around known treasury-event windows
7. Capture the executed chunk settings and completion timestamps in the incident or deploy log.

## Emergency Rollback

1. Disable extended or specific configs:
   - Set `MINT_BURN_DISABLED_SYMBOLS=reUSD` (or additional symbols).
2. Deploy updated worker config.
3. Confirm `status` returns to `ok` and `apiErrors` decreases.
4. If needed, roll back worker version and pause backfill operations.
