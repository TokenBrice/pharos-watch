# Codebase Quality Audit — Executive Summary

**Date:** 2026-03-07
**Scope:** Full codebase audit targeting redundancy elimination, dead code removal, and maintainability improvements — zero feature changes.

## Impact

| Metric | Value |
|--------|-------|
| **Net LOC reduced** | **-239** (2,313 added / 2,552 deleted) |
| **Files touched** | 94 |
| **Files deleted** | 3 (`flow-gauge.tsx`, `chain-rpcs.ts`, `rate-limits.ts`) |
| **Files created** | 5 (shared primitives & helpers) |
| **Tests** | 130 files, 1,201 assertions — all passing |
| **Build** | Clean (`npm run build`, `worker tsc --noEmit`) |

## Phase Breakdown

### Phase 1: Dead Code & Safe Cleanup (-184 net LOC)
*4 parallel Codex agents, 11 files changed*

- **Deleted `flow-gauge.tsx`** — unused component
- **Removed 129 redundant `detailProvider: "defillama"` lines** from stablecoins.ts (the `coin()` helper already defaults to this)
- **Removed dead exports** from `chart-colors`, `flow-intensity`, `nav-config`, `use-api-query`, and 6 worker lib modules
- **Removed 42 dead type declarations** from `shared/types/index.ts`
- **Removed dead methodology version aliases** from 6 shared version files
- **De-exported internal-only types** across 10+ files (frontend + worker + shared)

### Phase 2: Worker Consolidation (-101 net LOC, +significant dedup)
*3 parallel Codex agents, 55 files changed*

- **Merged `chain-rpcs.ts` into `chain-registry.ts`** — eliminated overlapping chain ID mappings, deleted `chain-rpcs.ts`
- **Merged `rate-limits.ts` into `rate-limit.ts`** — consolidated two near-identically named files, deleted `rate-limits.ts`
- **Replaced inline rate limiter in `feedback.ts`** with shared `checkRateLimit`
- **Extracted `loadDexPriceMap` and `buildInsertDepegEventStmt`** into `depeg-helpers.ts` — eliminated duplication between `detect-depegs.ts` and `confirm-pending-depegs.ts`
- **Replaced reimplemented patterns** with existing helpers: `fetchWithRetry` in sync-blacklist, `getCache`/`setCache` in enrich-prices, `recordOutcomeSafe` in daily-digest and sync-usds-status, `shouldSkipFreshCache` in sync-bluechip
- **Extracted `crawlTokenPools` helper** — unified CoinGecko and GeckoTerminal crawler pipelines
- **Extracted `fetchSubgraphEntities` helper** — unified UniV3 and Aerodrome subgraph fetch loops
- **Extracted `fetchPriceMapByIds` helper** — unified 4 price enrichment passes

### Phase 3: Frontend Consolidation (-156 net LOC, +significant dedup)
*3 parallel Codex agents, 33 files changed*

- **Created `chart-primitives.tsx`** with `TimeXAxis`, `MonoYAxis`, `DateTooltip`, `TimeGrid` — replaced repeated Recharts boilerplate in 6 chart components
- **Extracted `CemeteryChartCard` wrapper** in cemetery-charts.tsx — eliminated 5 repeated card shells
- **Created `metric-stat-card.tsx`** — replaced repeated stat-card pattern in 5 dashboard stat components
- **Centralized KpiBar metric definitions** — single array mapped to both mobile and desktop views instead of parallel maintenance
- **Extracted `flow-signal-ui.ts`** — consolidated duplicated direction/pressure/narrative mappings from `flow-summary-card` and `flow-brrr-overview`
- **Replaced `PSI_BAND_COLORS`** with `PSI_HEX_COLORS` from shared — eliminated frontend/shared color duplication
- **Replaced local chain name map** with `CHAIN_META` from shared
- **Had `peg-stability.ts` call shared `peg-score` functions** instead of recomputing
- **Centralized time constants** (`DAY_MS`, `THIRTY_DAYS_SECONDS`, etc.) in `src/lib/constants.ts`
- **Derived threat-band ordering** from shared `classification.ts` instead of local definitions

## Process

- **Research phase:** 5 parallel Codex agents audited all codebase areas (~86K LOC) with `xhigh` reasoning
- **Implementation:** 10 Codex tickets across 3 sequential phases, each with 3-4 parallel agents
- **Validation:** Every worktree independently verified (build + tsc + full test suite) before merge
- **Conflict resolution:** 2 merge conflicts resolved manually (import path and chart primitive overlaps)
- **Bug caught:** Codex inlined `getMaxScanRange()` as 2000 instead of 50000 and `evmSafetyMarginBlocks()` as 5 instead of 75 — both caught by tests and fixed before merge

## Files Deleted

| File | Reason |
|------|--------|
| `src/components/flow-gauge.tsx` | Unused component (no imports) |
| `worker/src/lib/chain-rpcs.ts` | Merged into `chain-registry.ts` |
| `worker/src/lib/rate-limits.ts` | Merged into `rate-limit.ts` |

## New Shared Primitives

| File | Purpose |
|------|---------|
| `src/components/chart-primitives.tsx` | Reusable Recharts axis/tooltip/grid wrappers |
| `src/components/metric-stat-card.tsx` | Reusable stat card with colored left border |
| `src/lib/flow-signal-ui.ts` | Shared flow direction/pressure/narrative mappings |
| `worker/src/cron/dex-liquidity/crawl-helpers.ts` | Shared CG/GT pool crawler pipeline |
| `worker/src/cron/dex-liquidity/subgraph-helpers.ts` | Shared GraphQL subgraph fetch loop |
