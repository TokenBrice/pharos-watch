# Cron Trigger Isolation — Design

**Date:** 2026-03-09
**Status:** Approved
**Scope:** Split consolidated cron triggers into dedicated per-job triggers + reliability improvements

## Problem

The worker currently packs 21 jobs into 5 cron triggers. Cloudflare Workers share a 6-connection outgoing fetch pool **per invocation**, meaning all `ctx.waitUntil()` jobs within a single cron trigger compete for 6 connections. The paid plan allows up to 250 cron triggers — we use 5.

The heaviest contention is on `3,23,43 * * * *` where sync-blacklist (Etherscan, multi-chain), sync-mint-burn (Alchemy, multi-contract), and sync-dex-discovery (CoinGecko/GeckoTerminal/DexScreener) all run in parallel sharing 6 connections. Each also shares one `cpu_ms` budget (currently 5,000ms = 5 seconds).

## Solution

Split the three fetch-heavy 20-minute jobs onto dedicated triggers (Phase 1) and extract sync-stablecoin-charts to a lower-cadence dedicated trigger (Phase 2). Bundle three reliability improvements.

## Trigger Layout

### Before (5 triggers)

| Expression | Jobs |
|-----------|------|
| `*/15 * * * *` | sync-stablecoins, snapshot-supply (retry), sync-stablecoin-charts, sync-fx-rates, stability-index, compute-dews, status-self-check, dispatch-telegram-alerts |
| `3,23,43 * * * *` | sync-blacklist, sync-mint-burn, sync-dex-discovery |
| `13,33,53 * * * *` | sync-mint-burn-extended |
| `10,40 * * * *` | sync-dex-liquidity, sync-yield-data |
| `0 8 * * *` | 8 daily jobs |

### After (8 triggers)

| Expression | Jobs | Change |
|-----------|------|--------|
| `*/15 * * * *` | sync-stablecoins, snapshot-supply (retry), sync-fx-rates, stability-index, compute-dews, status-self-check, dispatch-telegram-alerts | Charts removed |
| `3,23,43 * * * *` | sync-blacklist (solo) | Phase 1 |
| `4,24,44 * * * *` | sync-mint-burn (solo) | Phase 1 |
| `5,35 * * * *` | sync-stablecoin-charts (solo, 30-min) | Phase 2 |
| `6,26,46 * * * *` | sync-dex-discovery (solo) | Phase 1 |
| `13,33,53 * * * *` | sync-mint-burn-extended | Unchanged |
| `10,40 * * * *` | sync-dex-liquidity, sync-yield-data | Unchanged |
| `0 8 * * *` | 8 daily jobs | Unchanged |

## Reliability Additions

| Change | Before | After | Rationale |
|--------|--------|-------|-----------|
| `cpu_ms` | 5,000ms | 30,000ms | 5s shared across sequential jobs was tight; 30s per invocation gives headroom |
| Charts staleness threshold | 600s | 3,600s | Matches new 30-min cadence (~2x interval) |
| Charts `intervalSec` | 900 | 1,800 | Status page unhealthy detection must match actual cadence |
| Blacklist wall-clock timeout | 8 min | 12 min | Owns full invocation; reduces partial-completion on slow chains |
| Mint-burn wall-clock timeout | 8 min | 10 min | Isolated from blacklist/discovery |
| Mint-burn-extended timeout | 8 min | 10 min | Same rationale |
| Dex-discovery wall-clock timeout | 14 min | 16 min | Isolated; more room for rate-limit retries |

## Files Changed

### Worker (6 files)

| File | Changes |
|------|---------|
| `worker/wrangler.toml` | Add 3 cron expressions; raise `cpu_ms` to 30000 |
| `worker/src/lib/cron-schedule.ts` | Add 3 schedule constants; update job schedule mappings + charts intervalSec |
| `worker/src/handlers/scheduled.ts` | Split twentyMinuteOffset case; add 3 new cases; remove charts from quarter-hourly |
| `worker/src/lib/constants.ts` | Update charts freshness threshold 600 -> 3600 |
| `worker/src/lib/db.ts` | Update CRON_TIMEOUT_MS for 4 jobs |
| `worker/src/__tests__/index.scheduled.test.ts` | Update trigger tests; add 3 new test cases |

### Frontend (2 files)

| File | Changes |
|------|---------|
| `src/components/status/cron-config.ts` | Move charts to half-hourly group; update descriptions |
| `src/components/__tests__/cron-config.test.ts` | Update assertions |

### Documentation (1 file)

| File | Changes |
|------|---------|
| `docs/worker-infrastructure.md` | Rewrite trigger sections, update threshold/timeout tables |

## What Stays Unchanged

- Quarter-hourly dependency chain (sync-stablecoins -> capability gates -> downstream)
- Half-hourly slot (dex-liquidity -> yield-data chaining)
- Daily slot
- All cron job implementations (no job logic changes)
- Lease system, circuit breakers, alert system
