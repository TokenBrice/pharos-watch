# Status Page Overhaul — Full Ops Dashboard

**Date**: 2026-02-28
**Status**: Approved

## Goal

Comprehensively update the `/status` page to monitor all ~28 API endpoints, expose circuit breaker states, provide admin action buttons, and auto-refresh every 60s.

## Current State

The status page has:
- Admin auth gate (sessionStorage)
- Overall status banner (healthy/degraded/stale)
- 10 cron job cards with history dots
- 5 data quality metric cards
- Cache freshness table

Missing: per-endpoint liveness, circuit breakers, admin action buttons, auto-refresh.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Data collection | Client-side probing | No worker changes, simple |
| Probe method | Full GET requests | Real latency/status, all cached anyway |
| Admin actions | Confirm dialog | Prevent accidental triggers |
| Auto-refresh | 60s interval | Good for incident monitoring |
| Layout | Single-page scroll | Keep it simple, no tabs |

## Page Layout (top to bottom)

1. **Header**: Title + countdown timer (`⟳ 45s`) + Refresh button + Sign out
2. **Status Banner**: Overall health (existing, unchanged)
3. **Endpoint Health**: Grid of all endpoints grouped by type (Public/Admin/Inline Admin), each showing status dot, latency, cache age
4. **Circuit Breakers**: Table from `/api/health` — name, state, trip count, last trip
5. **Admin Actions**: 8 action buttons with confirm dialogs and inline response display
6. **Cron Jobs**: Existing grid (unchanged)
7. **Data Quality**: Existing cards (unchanged)
8. **Cache Freshness**: Existing table (unchanged)

## Endpoint Health Probe

On load + every 60s, fire parallel `fetch()` to all endpoints:
- Public endpoints: plain GET
- Admin endpoints: GET with `X-Admin-Key` header
- POST-only (`/api/feedback`): skip probe, show cache status only
- 5s timeout per request via AbortController
- Display: status code, latency (ms), cache age ratio

Grouping:
- **Public** (18): stablecoins, stablecoin/:id, stablecoin-charts, peg-summary, health, blacklist, depeg-events, usds-status, bluechip-ratings, dex-liquidity, dex-liquidity-history, supply-history, daily-digest, digest-archive, digest-snapshot, stability-index, report-cards, status
- **Admin** (5): backfill-depegs, backfill-supply-history, backfill-cg-prices, audit-depeg-history, backfill-stability-index
- **Inline Admin** (3): trigger-digest, reset-blacklist-sync, debug-sync-state

## Circuit Breaker Panel

Source: `/api/health` response `circuits` field.
Display: table with name, state (closed/half-open/open), trip count, last trip time.
Colors: green=closed, amber=half-open, red=open.

## Admin Actions Panel

8 buttons, each with:
- Confirmation dialog before execution
- Loading spinner during execution
- Inline success/error response display
- For `debug-sync-state`: collapsible JSON viewer

| Button | Endpoint | Confirm Message |
|--------|----------|----------------|
| Trigger Digest | `/api/trigger-digest` | "Trigger daily digest? Bypasses 1h dedup window." |
| Reset Blacklist Sync | `/api/reset-blacklist-sync` | "Reset blacklist sync? Rolls back EVM 50k blocks, Tron 7 days." |
| Debug Sync State | `/api/debug-sync-state` | "Fetch sync state debug dump?" |
| Backfill Depegs | `/api/backfill-depegs` | "Run depeg backfill from CoinGecko?" |
| Backfill Supply | `/api/backfill-supply-history` | "Backfill supply history snapshots?" |
| Backfill CG Prices | `/api/backfill-cg-prices` | "Backfill CoinGecko prices?" |
| Backfill PSI | `/api/backfill-stability-index` | "Backfill stability index history?" |
| Audit Depegs | `/api/audit-depeg-history` | "Run depeg history audit?" |

## Auto-Refresh

- `refetchInterval: 60_000` on TanStack Query hooks (`useStatus`, `useHealth`)
- Client-side endpoint probes re-fire every 60s
- Countdown timer in header, resets on manual refresh
- Change `staleTime` from `Infinity` to `60_000` in `useStatus`

## Files Modified

| File | Change |
|------|--------|
| `src/app/status/client.tsx` | Add endpoint health grid, circuit breaker table, admin actions panel, auto-refresh countdown |
| `src/hooks/use-status.ts` | Change staleTime/refetchInterval to 60s |
| `src/lib/types.ts` | Add `HealthResponse`, `CircuitRecord`, `EndpointProbeResult` types |
| `worker/src/api/status.ts` | Fix stale CRON_INTERVALS, add missing jobs (stability-index, snapshot-psi) |

## New Files

| File | Purpose |
|------|---------|
| `src/hooks/use-health.ts` | TanStack Query hook for `/api/health` (public endpoint) |

## Worker Content Fixes (CRON_INTERVALS)

The `CRON_INTERVALS` map in `worker/src/api/status.ts` has drifted from actual cron schedules. These must be corrected:

| Job | Current value | Correct value | Reason |
|-----|--------------|---------------|--------|
| `sync-dex-liquidity` | 1200 (20min) | 1800 (30min) | Runs on `10,40 * * * *` = every 30min |
| `sync-usds-status` | 900 (15min) | 86400 (daily) | Moved to `0 8 * * *` daily trigger |
| `snapshot-supply` | 43200 (12h) | 86400 (daily) | Runs on `0 8 * * *` daily trigger |
| `stability-index` | **missing** | 900 (15min) | Runs on `*/15 * * * *`, piggybacked on sync-stablecoins |
| `snapshot-psi` | **missing** | 86400 (daily) | Runs on `0 8 * * *` daily trigger |

No new API endpoints needed — all data sources already exist.
