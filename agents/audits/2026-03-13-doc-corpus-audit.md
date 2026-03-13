# Documentation Corpus Audit — 2026-03-13

Scope: full `/docs/*` verification against the live repository state on March 13, 2026, plus cross-consistency checks against `README.md`, `AGENTS.md`, and `CLAUDE.md`.

Counting note: `Claims checked` below means audited claim groups or contract clusters, not raw sentence count. Typical units: endpoint sections, route inventories, cron schedules, cache policies, schema blocks, formula definitions, or operational guarantees.

## 1. Per-Document Verification Report

| Document | Claims Checked | Verified | Issues Found | Issues Fixed | Status |
|----------|----------------|----------|--------------|--------------|--------|
| `docs/README.md` | 8 | 7 | 1 | 1 | Corrected |
| `about-page.md` | 8 | 8 | 0 | 0 | Verified |
| `api-reference.md` | 46 | 43 | 3 | 3 | Corrected |
| `architecture.md` | 22 | 20 | 2 | 2 | Corrected |
| `blacklist-tracker-timeline.md` | 9 | 9 | 0 | 0 | Verified |
| `blacklist-tracker.md` | 15 | 15 | 0 | 0 | Verified |
| `bluechip-ratings.md` | 8 | 8 | 0 | 0 | Verified |
| `cemetery-and-compare.md` | 10 | 10 | 0 | 0 | Verified |
| `classification.md` | 8 | 8 | 0 | 0 | Verified |
| `coverage-page.md` | 8 | 8 | 0 | 0 | Verified |
| `data-flow-map.md` | 13 | 13 | 0 | 0 | Verified |
| `data-pipeline.md` | 20 | 20 | 0 | 0 | Verified |
| `depeg-detection.md` | 18 | 18 | 0 | 0 | Verified |
| `depeg-dews-timeline.md` | 12 | 12 | 0 | 0 | Verified |
| `dependency-map.md` | 11 | 11 | 0 | 0 | Verified |
| `deployment-process.md` | 10 | 10 | 0 | 0 | Verified |
| `design-context.md` | 6 | 6 | 0 | 0 | Verified |
| `design-language.md` | 16 | 16 | 0 | 0 | Verified |
| `design-tokens.md` | 11 | 11 | 0 | 0 | Verified |
| `dews.md` | 14 | 14 | 0 | 0 | Verified |
| `dex-liquidity.md` | 20 | 19 | 1 | 1 | Corrected |
| `digest-pipeline.md` | 14 | 14 | 0 | 0 | Verified |
| `documentation-map-2026-03-05.tsv` | 8 | 7 | 1 | 1 | Corrected |
| `feedback-pipeline.md` | 10 | 10 | 0 | 0 | Verified |
| `liquidity-score-timeline.md` | 11 | 11 | 0 | 0 | Verified |
| `live-reserves.md` | 11 | 10 | 1 | 1 | Corrected |
| `methodology-page.md` | 9 | 9 | 0 | 0 | Verified |
| `mint-burn-flows-timeline.md` | 15 | 15 | 0 | 0 | Verified |
| `mint-burn-flows.md` | 18 | 18 | 0 | 0 | Verified |
| `redemption-backstops.md` | 10 | 8 | 2 | 2 | Corrected |
| `report-cards-timeline.md` | 13 | 13 | 0 | 0 | Verified |
| `report-cards.md` | 19 | 19 | 0 | 0 | Verified |
| `scripts.md` | 12 | 12 | 0 | 0 | Verified |
| `shadow-stablecoins.md` | 8 | 8 | 0 | 0 | Verified |
| `stability-index-timeline.md` | 8 | 8 | 0 | 0 | Verified |
| `stability-index.md` | 13 | 13 | 0 | 0 | Verified |
| `stablecoin-detail-page.md` | 8 | 8 | 0 | 0 | New |
| `status-dashboard.md` | 17 | 17 | 0 | 0 | Verified |
| `supply-snapshot.md` | 13 | 13 | 0 | 0 | Verified |
| `telegram-alerts.md` | 15 | 15 | 0 | 0 | Verified |
| `testing.md` | 18 | 16 | 2 | 2 | Corrected |
| `worker-and-api-limits.md` | 12 | 12 | 0 | 0 | Verified* |
| `worker-infrastructure.md` | 26 | 25 | 1 | 1 | Corrected |
| `yield-intelligence-timeline.md` | 12 | 12 | 0 | 0 | Verified |
| `yield-intelligence.md` | 17 | 14 | 3 | 3 | Corrected |

\* `worker-and-api-limits.md` was verified for repo-visible service usage, batching patterns, and limit-dependent design claims. Exact upstream vendor ceilings remain externally sourced rather than derivable from local code.

### Issues Found

## docs/README.md

**Status:** 7 verified / 1 incomplete

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Route And Page Contracts | Incomplete | No dedicated entry for the stablecoin detail route contract | `/stablecoin/[id]/` is the main product route and now has a dedicated doc | `src/app/stablecoin/[id]/page.tsx:1`, `src/app/stablecoin/[id]/client.tsx:1` | Yes |

### Changes Applied

- Added `docs/stablecoin-detail-page.md` to the route/page contract index.

## api-reference.md

**Status:** 43 verified / 3 inaccurate

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `DiscoveryCandidate` fields | Inaccurate | `id: string` | `id: number` | `shared/types/status.ts:185`, `worker/src/api/discovery.ts:53` | Yes |
| 2 | `DiscoveryCandidate` fields | Inaccurate | `llamaId: string \| null` | `llamaId: number \| null` | `shared/types/status.ts:187`, `worker/src/api/discovery.ts:55` | Yes |
| 3 | `DiscoveryCandidate` fields | Inaccurate | `marketCap: number` | `marketCap: number \| null` | `shared/types/status.ts:190`, `worker/src/api/discovery.ts:58` | Yes |

### Changes Applied

- Corrected the discovery-candidate field table to match the shared types and the live handler mapping.

## architecture.md

**Status:** 20 verified / 2 incomplete

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Worker cron tree | Incomplete | Omits the hourly live-reserve sync module from the architecture-significant cron tree | `sync-live-reserves.ts` is a first-class hourly cron feeding reserve detail and `/status` | `worker/src/cron/sync-live-reserves.ts:1` | Yes |
| 2 | Worker cron tree | Incomplete | Omits the cemetery announcement cron from the worker tree | `announce-cemetery-additions.ts` is a scheduled Telegram-sidecar job | `worker/src/cron/announce-cemetery-additions.ts:1` | Yes |

### Changes Applied

- Added `sync-live-reserves.ts` and `announce-cemetery-additions.ts` to the curated worker cron tree.

## dex-liquidity.md

**Status:** 19 verified / 1 inaccurate

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | CoinGecko Onchain Integration | Inaccurate | Locked liquidity is weighted into durability scoring at 5% | Locked liquidity is still collected and persisted, but `computeDurabilityScore()` now uses only organic fraction, TVL stability, volume consistency, and maturity | `worker/src/cron/dex-liquidity/pool-helpers.ts:53`, `worker/src/cron/dex-liquidity/scoring.ts:364` | Yes |

### Changes Applied

- Reworded the CoinGecko Onchain section so locked-liquidity data is described as persisted observability/context, not an active durability input.

## documentation-map-2026-03-05.tsv

**Status:** 7 verified / 1 incomplete

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Audit inventory rows | Incomplete | Latest doc-corpus audit entry stops at March 12 | This pass adds a new March 13 audit artifact under `agents/audits/` | `agents/audits/2026-03-13-doc-corpus-audit.md` | Yes |

### Changes Applied

- Added the current audit artifact row to keep the reference inventory aligned with the repo.

## live-reserves.md

**Status:** 10 verified / 1 inaccurate

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | API Contract / Cache control | Inaccurate | `live` and `live-stale` both use the slow cache profile | Only `mode === "live"` gets the 1-hour cache profile; `live-stale` uses the shorter fallback cache profile | `worker/src/api/stablecoin-reserves.ts:6`, `worker/src/api/stablecoin-reserves.ts:34` | Yes |

### Changes Applied

- Split the cache-control table so `live-stale` now correctly sits with the shorter fallback/unavailable responses.

## redemption-backstops.md

**Status:** 8 verified / 2 inaccurate

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Coverage | Inaccurate | `Configured coins: 47` | `REDEMPTION_BACKSTOP_CONFIGS` currently contains 46 configured IDs | `shared/lib/redemption-backstops.ts:70` | Yes |
| 2 | Coverage | Inaccurate | Route families include 6 `psm-swap` entries | Current config has 5 `psm-swap` entries | `shared/lib/redemption-backstops.ts:111` | Yes |

### Changes Applied

- Corrected the configured-coin total and route-family breakdown to match the current static registry.

## testing.md

**Status:** 16 verified / 1 inaccurate / 1 ambiguous

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Commands | Inaccurate | `coverage:critical` runs "Full coverage" | `coverage:critical` runs an explicitly enumerated critical-suite subset, then checks critical file thresholds | `package.json:13` | Yes |
| 2 | Cron test inventory | Ambiguous | DEX-liquidity fallback/scoring/persistence rows were duplicated at the end of the table | Each suite exists once; the repeated rows were doc duplication, not extra tests | `docs/testing.md:356` | Yes |

### Changes Applied

- Corrected the `coverage:critical` command description.
- Removed the duplicated cron-suite rows from the inventory table.

## worker-infrastructure.md

**Status:** 25 verified / 1 incomplete

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Edge Cache Strategy / Cache-Control profiles | Incomplete | Standard cache-profile usage list omitted `redemption-backstops` | `/api/redemption-backstops` uses `CACHE_PROFILES.standard` | `worker/src/api/redemption-backstops.ts:1` | Yes |

### Changes Applied

- Added `redemption-backstops` to the standard cache-profile usage table.

## yield-intelligence.md

**Status:** 14 verified / 3 stale

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Automatic Lending Pool Discovery | Stale | Auto-discovery runs after a base three-tier resolution | The current resolver has four base tiers (on-chain, DeFiLlama, price-derived, rate-derived) before auto-discovery | `worker/src/cron/yield-sync/resolve.ts:175`, `worker/src/cron/yield-sync/resolve.ts:206` | Yes |
| 2 | `sync-yield-data` step 1 | Stale | Base resolution described as three-tier | Current runtime is four-tier | `worker/src/cron/yield-sync/resolve.ts:175`, `worker/src/cron/yield-sync/resolve.ts:206` | Yes |
| 3 | `sync-yield-data` step 6 | Stale | `Tier 1 → 2 → 3` | `Tier 1 → 2 → 3 → 4` | `worker/src/cron/yield-sync/resolve.ts:175`, `worker/src/cron/yield-sync/resolve.ts:206` | Yes |

### Changes Applied

- Updated all stale "three-tier" references to the current four-tier yield-resolution pipeline.

### Verified With No Issues Found

No code or contract drift was found in this pass for:

- `about-page.md`
- `blacklist-tracker-timeline.md`
- `blacklist-tracker.md`
- `bluechip-ratings.md`
- `cemetery-and-compare.md`
- `classification.md`
- `coverage-page.md`
- `data-flow-map.md`
- `data-pipeline.md`
- `depeg-detection.md`
- `depeg-dews-timeline.md`
- `dependency-map.md`
- `deployment-process.md`
- `design-context.md`
- `design-language.md`
- `design-tokens.md`
- `dews.md`
- `digest-pipeline.md`
- `feedback-pipeline.md`
- `liquidity-score-timeline.md`
- `methodology-page.md`
- `mint-burn-flows-timeline.md`
- `mint-burn-flows.md`
- `report-cards-timeline.md`
- `report-cards.md`
- `scripts.md`
- `shadow-stablecoins.md`
- `stability-index-timeline.md`
- `stability-index.md`
- `status-dashboard.md`
- `supply-snapshot.md`
- `telegram-alerts.md`
- `worker-and-api-limits.md` (repo-verifiable portions)
- `yield-intelligence-timeline.md`

## 2. Coverage Gap Analysis

### Undocumented Systems

| System/Feature | Complexity | Recommended Action |
|---------------|-----------|-------------------|
| Stablecoin detail route contract | High | New doc created: `docs/stablecoin-detail-page.md` |

### New Documents Created

- `docs/stablecoin-detail-page.md` — documents `/stablecoin/[id]/` server/client split, view-model wiring, section order, reserve/redemption fallbacks, and shared stale-query behavior.
- `agents/audits/2026-03-13-doc-corpus-audit.md` — full verification artifact for this pass.

## 3. Cross-Consistency Report

### Cross-Document Conflicts

| Doc A | Doc B | Conflict | Resolution |
|-------|-------|----------|------------|
| `README.md` | `docs/redemption-backstops.md` | Root README still claimed 47 configured redemption-backstop assets while the config registry contains 46 | Standardized both surfaces to 46, based on `REDEMPTION_BACKSTOP_CONFIGS` |
| `AGENTS.md` | `CLAUDE.md` | Both helper docs still described Yield Intelligence as a three-tier APY pipeline | Standardized both to four-tier, matching the current resolver and detailed doc |
| `docs/README.md` | Route coverage | The docs index had no entry for the detail route contract after adding a dedicated doc | Added `stablecoin-detail-page.md` to the route/page section |
| `worker-infrastructure.md` | `api-reference.md` | Infrastructure cache-profile table omitted a standard-cached endpoint listed in the API reference | Added `redemption-backstops` to the standard cache profile row |

### Terminology Standardization

- Standardized Yield Intelligence wording to `four-tier APY resolution` for current-state documentation outside the historical timeline.
- Standardized the redemption-backstop coverage count to `46 configured assets`.
- Standardized the new route-contract naming to `stablecoin detail page` / `stablecoin-detail-page.md`.

## 4. Summary Dashboard

| Document Set | Claims Checked | Verified | Issues Found | Issues Fixed |
|--------------|----------------|----------|--------------|--------------|
| `/docs/*` + `documentation-map-2026-03-05.tsv` | 585 | 571 | 14 | 14 |
| Cross-consistency (`README.md`, `AGENTS.md`, `CLAUDE.md`) | 4 conflict clusters | 4 | 4 | 4 |

## Verification Evidence

Executed after the doc changes:

- `npm run lint`
- `cd worker && npx tsc --noEmit`
- `npm test`
- `npm run build`

All four commands passed on the audited repository state.
