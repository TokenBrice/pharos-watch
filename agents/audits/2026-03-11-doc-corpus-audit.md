# Documentation Corpus Audit — 2026-03-11

Scope: `/docs/*` verified against the live repository state on March 11, 2026, plus cross-consistency checks against `README.md`.

Counting note: `Claims checked` below means discrete claim groups or contract clusters audited in this pass (routes, schedules, formulas, schema blocks, file-tree sections, or subsystem behaviors), not raw sentence count.

## 1. Per-Document Verification Report

| Document | Claims Checked | Verified | Issues Found | Issues Fixed | Status |
|----------|----------------|----------|--------------|--------------|--------|
| `api-reference.md` | 41 | 39 | 2 | 2 | Corrected |
| `architecture.md` | 18 | 16 | 2 | 2 | Corrected |
| `blacklist-tracker-timeline.md` | 7 | 7 | 0 | 0 | Verified |
| `blacklist-tracker.md` | 14 | 14 | 0 | 0 | Verified |
| `bluechip-ratings.md` | 7 | 7 | 0 | 0 | Verified |
| `cemetery-and-compare.md` | 8 | 6 | 2 | 2 | Corrected |
| `classification.md` | 8 | 7 | 1 | 1 | Corrected |
| `data-flow-map.md` | 9 | 9 | 0 | 0 | Verified |
| `data-pipeline.md` | 18 | 16 | 2 | 2 | Corrected |
| `depeg-detection.md` | 16 | 16 | 0 | 0 | Verified |
| `depeg-dews-timeline.md` | 10 | 10 | 0 | 0 | Verified |
| `dependency-map.md` | 10 | 10 | 0 | 0 | Verified |
| `deployment-process.md` | 8 | 8 | 0 | 0 | Verified |
| `design-language.md` | 12 | 12 | 0 | 0 | Verified |
| `design-tokens.md` | 12 | 12 | 0 | 0 | Verified |
| `dews.md` | 14 | 14 | 0 | 0 | Verified |
| `dex-liquidity.md` | 18 | 18 | 0 | 0 | Verified |
| `digest-pipeline.md` | 13 | 13 | 0 | 0 | Verified |
| `documentation-map-2026-03-05.tsv` | 7 | 6 | 1 | 1 | Corrected |
| `feedback-pipeline.md` | 10 | 9 | 1 | 1 | Corrected |
| `liquidity-score-timeline.md` | 9 | 9 | 0 | 0 | Verified |
| `methodology-page.md` | 8 | 8 | 0 | 0 | Verified |
| `mint-burn-flows-timeline.md` | 11 | 11 | 0 | 0 | Verified |
| `mint-burn-flows.md` | 20 | 20 | 0 | 0 | Verified |
| `report-cards-timeline.md` | 12 | 12 | 0 | 0 | Verified |
| `report-cards.md` | 19 | 17 | 2 | 2 | Corrected |
| `scripts.md` | 10 | 10 | 0 | 0 | Verified |
| `shadow-stablecoins.md` | 8 | 8 | 0 | 0 | Verified |
| `stability-index-timeline.md` | 9 | 9 | 0 | 0 | Verified |
| `stability-index.md` | 13 | 13 | 0 | 0 | Verified |
| `status-dashboard.md` | 16 | 16 | 0 | 0 | Verified |
| `supply-snapshot.md` | 12 | 10 | 2 | 2 | Corrected |
| `telegram-alerts.md` | 13 | 13 | 0 | 0 | Verified |
| `testing.md` | 15 | 15 | 0 | 0 | Verified |
| `worker-and-api-limits.md` | 12 | 11 | 1 | 1 | Corrected |
| `worker-infrastructure.md` | 22 | 21 | 1 | 1 | Corrected |
| `yield-intelligence.md` | 20 | 20 | 0 | 0 | Verified |

### Detailed Issues

## api-reference.md

**Status:** 39 verified / 2 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Stablecoin IDs` | Inaccurate | Worker ID resolution accepts canonical IDs and legacy aliases | `resolveStablecoinId()` accepts canonical IDs only | `shared/lib/stablecoin-id-registry.ts:75` | Yes |
| 2 | `GET /api/health` field docs | Incomplete | Circuit list omits `coingecko-discovery` | `CIRCUIT_SOURCE` includes `CG_DISCOVERY: "coingecko-discovery"` | `worker/src/lib/constants.ts:122` | Yes |

### Changes Applied

- Reworded the stablecoin-ID section to document canonical-ID-only API behavior.
- Added `coingecko-discovery` to the documented `/api/health` circuit-key list.

## architecture.md

**Status:** 16 verified / 2 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `File Tree Guide` | Stale | `shared/index.ts` exists at the shared boundary root | `shared/` contains `types/` and `lib/`; there is no root `shared/index.ts` | `shared/` directory inventory | Yes |
| 2 | `File Tree Guide` | Inaccurate | `worker/migrations/` contains 63 files | Repository currently has 68 migration files | `worker/migrations/` directory inventory | Yes |

### Changes Applied

- Removed the nonexistent `shared/index.ts` entry from the curated tree.
- Updated the migration-count annotation from 63 to 68.

## cemetery-and-compare.md

**Status:** 6 verified / 2 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Selection and URL contract` | Inaccurate | Compare accepts legacy stablecoin IDs via `resolveStablecoinId(..., { allowLegacy: true })` | Compare parses canonical IDs or lowercase symbols only | `src/app/compare/client.tsx:61`, `src/app/compare/client.tsx:123` | Yes |
| 2 | `Data dependencies` / `Operational notes` | Incomplete | Compare depends on five API datasets | Compare also loads `/api/mint-burn-flows` via `useMintBurnFlows()` | `src/app/compare/client.tsx:12`, `src/app/compare/client.tsx:193` | Yes |

### Changes Applied

- Removed the stale legacy-ID claim from the URL contract.
- Added mint/burn flows to the documented compare-page data dependencies and updated the dependency count.

## classification.md

**Status:** 7 verified / 1 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Bluechip Grade` | Inaccurate | `BluechipGrade` lives in `types.ts` and is used by `GRADE_COLORS` in `classification.ts` | `BluechipGrade` lives in `shared/types/index.ts`; the verified frontend consumer here is `GRADE_ORDER` in `src/lib/bluechip.ts` | `shared/types/index.ts:518`, `src/lib/bluechip.ts:1` | Yes |

### Changes Applied

- Pointed the type reference at `shared/types/index.ts`.
- Removed the nonexistent `GRADE_COLORS` reference and kept the verified `GRADE_ORDER` consumer.

## data-pipeline.md

**Status:** 16 verified / 2 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Circuit Breakers` | Incomplete | Source list omits discovery-specific CoinGecko circuit | `CIRCUIT_SOURCE` includes `CG_DISCOVERY` | `worker/src/lib/constants.ts:122` | Yes |
| 2 | `Coverage Discovery -> Circuit Breaker` | Inaccurate | `CG_DISCOVERY` opens after 5 failures and probes after 24h | Shared breaker opens after 3 failures and probes after 30 minutes; discovery-scan uses that shared breaker directly | `worker/src/lib/circuit-breaker.ts:20`, `worker/src/cron/discovery-scan.ts:147` | Yes |

### Changes Applied

- Added `coingecko-discovery` to the tracked source list.
- Replaced the stale custom-threshold description with the actual shared breaker behavior.

## documentation-map-2026-03-05.tsv

**Status:** 6 verified / 1 incomplete

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Audit inventory row set | Incomplete | Latest listed audit artifact stops at the March 6 audit | New March 11 documentation-corpus audit exists under `agents/audits/` | `agents/audits/2026-03-11-doc-corpus-audit.md` | Yes |

### Changes Applied

- Added the new audit artifact to the TSV map and preserved the older March 6 audit as historical.

## feedback-pipeline.md

**Status:** 9 verified / 1 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Validation -> stablecoinId` | Inaccurate | Feedback canonicalizes legacy aliases through `resolveStablecoinId(..., { allowLegacy: true })` | The handler validates with `resolveStablecoinId()`; unknown or non-canonical IDs are stripped | `worker/src/api/feedback.ts:262`, `shared/lib/stablecoin-id-registry.ts:75` | Yes |

### Changes Applied

- Corrected the validation rule to match the current worker behavior.

## report-cards.md

**Status:** 17 verified / 2 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Portfolio Analyzer` | Inaccurate | Local-storage migration resolves legacy IDs through `resolveStablecoinId(..., { allowLegacy: true })` | Migration uses `REGISTRY_BY_ID` first and `REGISTRY_BY_LLAMA_ID` second in `migratePortfolioIds()` | `src/lib/portfolio-codec.ts:48` | Yes |
| 2 | `Interactive Stress Test` | Stale | Stress recomputation covers ~233 cards (155 tracked + 78 cemetery) | Current snapshot is built from 156 tracked coins plus 80 cemetery coins | `worker/src/lib/report-cards-snapshot.ts:108`, `worker/src/lib/report-cards-snapshot.ts:120` | Yes |

### Changes Applied

- Rewrote the local-storage migration note to match `portfolio-codec.ts`.
- Updated the stress-test snapshot-size note to the current tracked/cemetery counts.

## supply-snapshot.md

**Status:** 10 verified / 2 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Algorithm` step 4 | Stale | `PSI_ELIGIBLE_STABLECOINS` currently contains 157 entries (155 tracked + 2 shadow) | Current count is 158 (156 tracked + 2 shadow) | `worker/src/cron/snapshot-supply.ts:51` plus shared metadata counts | Yes |
| 2 | `GET /api/supply-history` params | Inaccurate | `stablecoin` resolves legacy aliases | History endpoints use canonical-ID validation via `resolveOrReject()` / `parseStablecoinHistoryQuery()` | `worker/src/lib/api-utils.ts:146`, `worker/src/lib/api-utils.ts:227` | Yes |

### Changes Applied

- Updated the PSI-eligible count to 158.
- Narrowed the `stablecoin` parameter contract to canonical Pharos IDs only.

## worker-and-api-limits.md

**Status:** 11 verified / 1 inaccurate

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `CoinGecko -> Crawl budget` | Stale | Onchain crawl budget protects `sync-dex-liquidity` runtime | CoinGecko onchain discovery runs inside the dedicated `sync-dex-discovery` cron budget | `worker/src/cron/dex-discovery/orchestrator.ts:118`, `worker/src/lib/rate-limit.ts:64` | Yes |

### Changes Applied

- Reworded the crawl-budget note so it matches the split discovery/scoring pipeline.

## worker-infrastructure.md

**Status:** 21 verified / 1 incomplete

### Issues Found

| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Circuit Breakers` | Incomplete | Circuit-source table omits discovery-specific CoinGecko breaker | `CIRCUIT_SOURCE` includes `CG_DISCOVERY`, and `discovery-scan` records outcomes against it | `worker/src/lib/constants.ts:122`, `worker/src/cron/discovery-scan.ts:147` | Yes |

### Changes Applied

- Added `CG_DISCOVERY` / `coingecko-discovery` to the worker-infrastructure circuit-breaker table.

### Verified With No Issues Found

No code/doc drift was found in this pass for:

- `blacklist-tracker-timeline.md`
- `blacklist-tracker.md`
- `bluechip-ratings.md`
- `data-flow-map.md`
- `depeg-detection.md`
- `depeg-dews-timeline.md`
- `dependency-map.md`
- `deployment-process.md`
- `design-language.md`
- `design-tokens.md`
- `dews.md`
- `dex-liquidity.md`
- `digest-pipeline.md`
- `liquidity-score-timeline.md`
- `methodology-page.md`
- `mint-burn-flows-timeline.md`
- `mint-burn-flows.md`
- `report-cards-timeline.md`
- `scripts.md`
- `shadow-stablecoins.md`
- `stability-index-timeline.md`
- `stability-index.md`
- `status-dashboard.md`
- `telegram-alerts.md`
- `testing.md`
- `yield-intelligence.md`

## 2. Coverage Gap Analysis

### Undocumented Systems

| System/Feature | Complexity | Recommended Action |
|---------------|-----------|-------------------|
| None significant in `/docs` after this pass | — | No new product doc required; existing corpus already covers the major frontend, worker, scoring, pipeline, and operational subsystems |

### New Documents Created

- `agents/audits/2026-03-11-doc-corpus-audit.md` — full repo audit artifact for this verification pass, kept under `agents/audits/` per repo convention

## 3. Cross-Consistency Report

### Cross-Document Conflicts

| Doc A | Doc B | Conflict | Resolution |
|-------|-------|----------|------------|
| `docs/api-reference.md` | `docs/feedback-pipeline.md` / `docs/report-cards.md` / `docs/cemetery-and-compare.md` / `docs/supply-snapshot.md` | Several docs implied worker-side legacy-ID alias resolution | Standardized on canonical-ID-only worker behavior; route redirects remain a frontend/static concern |
| `docs/data-pipeline.md` | `docs/api-reference.md` / `docs/worker-infrastructure.md` | Circuit-breaker coverage lists disagreed and omitted `coingecko-discovery` in some places | Added `coingecko-discovery` everywhere the source inventory is documented |
| `README.md` | `docs/architecture.md` | Migration count diverged (`63` vs live repo) | Updated both to the current `68` migration-file count |
| `docs/data-pipeline.md` | shared circuit-breaker implementation | Discovery-scan breaker thresholds were documented as custom (`5` / `24h`) | Aligned doc with the actual shared breaker defaults (`3` / `30m`) |

### Terminology Standardization

- `Canonical ID only` now consistently describes worker/API stablecoin-ID handling.
- `coingecko-discovery` is now listed wherever the circuit-source inventory is documented.
- `156 tracked + 80 cemetery + 2 shadow` counts now match the current metadata sets used by the live code.
- `68 migrations` is now the consistent repo-wide migration count in the actively maintained docs.

## 4. Summary Dashboard

| Document | Claims Checked | Verified | Issues Found | Issues Fixed |
|----------|----------------|----------|--------------|--------------|
| `api-reference.md` | 41 | 39 | 2 | 2 |
| `architecture.md` | 18 | 16 | 2 | 2 |
| `cemetery-and-compare.md` | 8 | 6 | 2 | 2 |
| `classification.md` | 8 | 7 | 1 | 1 |
| `data-pipeline.md` | 18 | 16 | 2 | 2 |
| `documentation-map-2026-03-05.tsv` | 7 | 6 | 1 | 1 |
| `feedback-pipeline.md` | 10 | 9 | 1 | 1 |
| `report-cards.md` | 19 | 17 | 2 | 2 |
| `supply-snapshot.md` | 12 | 10 | 2 | 2 |
| `worker-and-api-limits.md` | 12 | 11 | 1 | 1 |
| `worker-infrastructure.md` | 22 | 21 | 1 | 1 |
| `TOTAL (/docs)` | 489 | 472 | 17 | 17 |

### Verification Notes

- Stablecoin-count checks were confirmed from the live metadata exports (`TRACKED_STABLECOINS.length = 156`, `SHADOW_STABLECOINS.length = 2`, `DEAD_STABLECOINS.length = 80`).
- Migration-count checks were confirmed from the live `worker/migrations/` directory (`68` files).
- Route/method/circuit checks were verified against `shared/lib/api-endpoints.ts`, `worker/src/router.ts`, `worker/src/lib/constants.ts`, and the relevant cron/api modules.
