# Agent A H3: exception:Error Root-Cause Diagnosis

## Root Cause

**D1_ERROR: too many SQL variables at offset 245: SQLITE_ERROR**

All 7 `exception:Error` configs shared a single root cause: the `filterNewBlacklistRows` function in `worker/src/cron/blacklist/post-fetch.ts` used `EXISTING_BLACKLIST_ID_QUERY_CHUNK = 200`, generating `SELECT id FROM blacklist_events WHERE id IN (?,?,...,?)` queries with up to 200 bind parameters. Cloudflare D1 limits bind parameters to 100 per prepared statement.

## Why only these configs?

Configs that were well-synced (cursor near chain head) only fetch a handful of new events per cycle — well under 100. Configs scanning from their `startBlock` (USDG: 237 events, RLUSD: 179, USDO: 170, EURC Ethereum: 451, etc.) exceeded the 100-parameter limit on the first dedup chunk.

## Fix

Reduced `EXISTING_BLACKLIST_ID_QUERY_CHUNK` from 200 to 99 in commit `bccb12b0`.

## Outcome (post-fix)

After deployment, the next cron cycle (started_at: 1776322983) completed with **zero `apiErrorConfigs`** entries. Event counts for previously-stranded configs:

| Config | Events Ingested |
|--------|----------------|
| USDG (Ethereum) | 237 |
| RLUSD (Ethereum) | 179 |
| USDO (Ethereum) | 170 |
| EURC (Ethereum) | 451 |
| USDP (Ethereum) | 66 |

All sync cursors advanced to chain head.
