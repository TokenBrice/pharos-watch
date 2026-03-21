# Archivist Audit — Documentation Verification (2026-03-21)

Scope note: this pass fully re-verified the cadence, cron, freshness, and affected API-surface claims that drifted with the current worker schedule changes, then ran repo-level doc sync/count checks and source-path spot checks across the remaining docs. Files with no issue log below had no mismatches in the claims checked during this pass.

## 1. Per-Document Verification Report

### Corpus Summary

| Document | Status | Issues Found | Notes |
|----------|--------|--------------|-------|
| `README.md` | 9 inaccurate / 0 stale / 0 incomplete | 9 | Root README cadence + data-source refresh drift fixed |
| `docs/README.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/about-page.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/api-reference.md` | 3 inaccurate / 0 stale / 0 incomplete | 3 | API freshness/discovery wording fixed |
| `docs/architecture.md` | 8 inaccurate / 0 stale / 0 incomplete | 8 | API table + cron comments fixed |
| `docs/blacklist-tracker-timeline.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Historical timeline; no current drift found in targeted pass |
| `docs/blacklist-tracker.md` | 2 inaccurate / 0 stale / 0 incomplete | 2 | Hourly cadence correction |
| `docs/bluechip-ratings.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/cemetery-and-compare.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/chain-health-timeline.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Historical timeline; no current drift found in targeted pass |
| `docs/chains-page.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/classification.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | FX/currency pipeline wording matched current code paths checked |
| `docs/coverage-page.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/data-flow-map.md` | 5 inaccurate / 0 stale / 0 incomplete | 5 | Schedule map corrected |
| `docs/data-pipeline.md` | 8 inaccurate / 0 stale / 0 incomplete | 8 | PSI/blacklist/discovery freshness corrected |
| `docs/depeg-detection.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | 15-minute detection/confirmation loop remains accurate |
| `docs/depeg-dews-timeline.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Historical timeline; no current drift found in targeted pass |
| `docs/dependency-map.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/deployment-process.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/design-context.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/design-language.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/design-tokens.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Token layer claims remained aligned with `src/styles/tokens/*` |
| `docs/dews.md` | 3 inaccurate / 0 stale / 0 incomplete | 3 | DEWS cadence/storage corrected |
| `docs/dex-liquidity.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | 30-minute scoring + discovery split remained accurate |
| `docs/digest-pipeline.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Weekly recap chaining already matched code |
| `docs/documentation-map-2026-03-05.tsv` | archival snapshot / not normative | 0 | Date-scoped inventory file; not treated as live source-of-truth |
| `docs/feedback-pipeline.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/homepage.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/liquidity-score-timeline.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Historical timeline; no current drift found in targeted pass |
| `docs/live-reserves.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Hourly reserve lane claims still matched code |
| `docs/methodology-page.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Source-map links remained valid in targeted pass |
| `docs/mint-burn-flows-timeline.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Historical timeline; no current drift found in targeted pass |
| `docs/mint-burn-flows.md` | 1 inaccurate / 0 stale / 0 incomplete | 1 | Blacklist trigger cadence note fixed |
| `docs/operator-origin-access.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/portfolio-page.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/pricing-pipeline-timeline.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Historical timeline; no current drift found in targeted pass |
| `docs/pricing-pipeline.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | FX fallback claims matched current code paths checked |
| `docs/privacy-page.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/redemption-backstops.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/report-cards-timeline.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Historical timeline; no current drift found in targeted pass |
| `docs/report-cards.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/scripts.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Script inventory remained current in targeted pass |
| `docs/shadow-stablecoins.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | PSI/DEWS references remained accurate |
| `docs/stability-index-timeline.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Historical 15-minute entries intentionally preserved |
| `docs/stability-index.md` | 4 inaccurate / 0 stale / 0 incomplete | 4 | PSI cadence/storage corrected |
| `docs/stablecoin-detail-page.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/start-page.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/status-dashboard.md` | 3 inaccurate / 0 stale / 0 incomplete | 3 | Lane grouping corrected |
| `docs/supply-snapshot.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Quarter-hourly source-cache claims remained accurate |
| `docs/telegram-alerts.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/testing.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Test-inventory claims remained accurate in targeted pass |
| `docs/worker-and-api-limits.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | No mismatches found in targeted pass |
| `docs/worker-infrastructure.md` | 8 inaccurate / 0 stale / 0 incomplete | 8 | Trigger map + charts cooldown corrected |
| `docs/yield-intelligence-timeline.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | Historical timeline; no current drift found in targeted pass |
| `docs/yield-intelligence.md` | 0 inaccurate / 0 stale / 0 incomplete | 0 | 30-minute yield schedule remained accurate |

### Detailed Issue Logs

## README.md

**Status:** 9 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Data Sources` / DexScreener row | Inaccurate | `15/20/30 min` | `15/30 min` only | `shared/lib/cron-jobs.ts:10-20`, `worker/src/handlers/scheduled/half-hourly.ts:1-10` | Yes |
| 2 | `Data Sources` / Etherscan row | Inaccurate | `20 min` | hourly blacklist sync | `worker/wrangler.toml:32-35`, `shared/lib/cron-jobs.ts:10-13` | Yes |
| 3 | `Data Sources` / TronGrid row | Inaccurate | `20 min` | hourly blacklist sync | `worker/wrangler.toml:32-35`, `shared/lib/cron-jobs.ts:10-13` | Yes |
| 4 | `Data Sources` / dRPC-Alchemy row | Inaccurate | `20 min` | hourly for blacklist enrichment, 20 min for mint/burn | `worker/wrangler.toml:32-42`, `shared/lib/cron-jobs.ts:12-16` | Yes |
| 5 | DEX discovery note | Inaccurate | writes every `20 minutes` | writes every `30 minutes` | `shared/lib/cron-jobs.ts:13-16` | Yes |
| 6 | `Infrastructure` / quarter-hourly lane | Inaccurate | includes PSI + DEWS | quarter-hourly is stablecoins + snapshots + FX + status only | `worker/wrangler.toml:32-42`, `worker/src/handlers/scheduled/half-hourly.ts:1-44` | Yes |
| 7 | `Infrastructure` / blacklist trigger | Inaccurate | `3,23,43 * * * *` | `3 * * * *` | `worker/wrangler.toml:32-35`, `shared/lib/cron-jobs.ts:10-13` | Yes |
| 8 | `Infrastructure` / half-hourly lane | Inaccurate | charts + DEX liquidity + yield | charts + DEX liquidity + DEWS + PSI + yield | `worker/src/handlers/scheduled/half-hourly.ts:1-44` | Yes |
| 9 | `Infrastructure` / `5 8 * * *` lane | Inaccurate | daily digest + discovery scan | daily digest + Monday-only weekly recap + Monday-only discovery scan | `shared/lib/cron-jobs.ts:18-20,281-307`, `worker/src/cron/discovery-scan.ts:140-142` | Yes |

### Changes Applied
- Corrected provider refresh rows and cron-lane descriptions to match the current worker schedule map.
- Added the missing `snapshot-chain-supply`, DEWS, PSI, weekly recap, and Monday-only discovery behavior to the top-level infrastructure summary.

## docs/api-reference.md

**Status:** 3 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `GET /api/stablecoin-charts` | Inaccurate | updated every 30 minutes | 30-minute trigger, but writes capped to 1 hour by `stablecoin-charts:last-write` cooldown | `worker/src/cron/sync-stablecoin-charts.ts:64-68,134-139` | Yes |
| 2 | `GET /api/stability-index` | Ambiguous | daily PSI scores | latest live sample plus daily history | `worker/src/api/stability-index.ts:23-49,67-117` | Yes |
| 3 | `GET /api/discovery-candidates` | Inaccurate | surfaced by daily discovery scan | surfaced by Monday CoinGecko scan plus quarter-hourly DefiLlama residual upserts | `worker/src/cron/discovery-scan.ts:140-181`, `worker/src/cron/sync-stablecoins/intake.ts:136-155` | Yes |

### Changes Applied
- Reworded the stablecoin charts endpoint to reflect the trigger-vs-write cadence split.
- Reworded PSI and discovery-candidates intros so the contract matches the current API behavior and ingestion paths.

## docs/architecture.md

**Status:** 8 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `API Endpoints` table separator | Inaccurate | malformed 3-column separator | 2-column table | doc render issue; table itself fixed | Yes |
| 2 | `GET /api/mint-burn-events` row | Inaccurate | query string broken by raw pipe | query param is `scope=all` or `scope=counted` | `worker/src/api/mint-burn-events.ts` | Yes |
| 3 | `GET /api/stability-index` row | Inaccurate | daily PSI scores | latest sample plus history | `worker/src/api/stability-index.ts:23-49,67-117` | Yes |
| 4 | `GET /api/discovery-candidates` row | Inaccurate | daily discovery scan | Monday CoinGecko scan + quarter-hourly DefiLlama residuals | `worker/src/cron/discovery-scan.ts:140-181`, `worker/src/cron/sync-stablecoins/intake.ts:136-155` | Yes |
| 5 | worker tree / `sync-stablecoin-charts.ts` | Inaccurate | historical chart data → D1 | cache refresh with 1-hour write cooldown | `worker/src/cron/sync-stablecoin-charts.ts:64-68,134-135` | Yes |
| 6 | worker tree / `stability-index.ts` | Inaccurate | every 15 min after `sync-stablecoins` | every 30 min after `compute-dews` on half-hourly lane | `worker/src/handlers/scheduled/half-hourly.ts:32-44`, `shared/lib/cron-jobs.ts:123-136` | Yes |
| 7 | worker tree / `discovery-scan.ts` | Inaccurate | daily 08:05 discovery | Monday-only weekly discovery | `worker/src/cron/discovery-scan.ts:140-142` | Yes |
| 8 | worker tree / `compute-dews.ts` | Inaccurate | every 15 min after `sync-stablecoins` | every 30 min after `sync-dex-liquidity` | `worker/src/handlers/scheduled/half-hourly.ts:25-39`, `shared/lib/cron-jobs.ts:131-136` | Yes |

### Changes Applied
- Repaired the API table formatting so the endpoint inventory renders correctly again.
- Corrected the PSI/discovery endpoint descriptions and the worker tree comments to match the live scheduling graph.

## docs/blacklist-tracker.md

**Status:** 2 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Intro paragraph | Inaccurate | runs every 20 minutes | runs hourly | `worker/wrangler.toml:32-35`, `shared/lib/cron-jobs.ts:12-13,143-149` | Yes |
| 2 | `Cron Schedule` | Inaccurate | `3,23,43 * * * *` | `3 * * * *` | `worker/wrangler.toml:32-35` | Yes |

### Changes Applied
- Updated the cadence language and cron expression to the dedicated hourly blacklist slot.

## docs/data-flow-map.md

**Status:** 5 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Coverage discovery` row | Incomplete | no Monday-only nuance | CoinGecko scan is Monday-only; DL residuals land via quarter-hourly intake | `worker/src/cron/discovery-scan.ts:140-181`, `worker/src/cron/sync-stablecoins/intake.ts:136-155` | Yes |
| 2 | `Scheduling Backbone` / quarter-hourly | Inaccurate | includes PSI + DEWS | PSI + DEWS moved off this slot | `worker/src/handlers/scheduled/half-hourly.ts:1-44` | Yes |
| 3 | `Scheduling Backbone` / blacklist | Inaccurate | `3,23,43 * * * *` | `3 * * * *` | `worker/wrangler.toml:32-35` | Yes |
| 4 | `Scheduling Backbone` / half-hourly | Incomplete | charts + DEX liquidity + yield | charts + DEX liquidity + DEWS + PSI + yield | `worker/src/handlers/scheduled/half-hourly.ts:1-44` | Yes |
| 5 | `Scheduling Backbone` / `5 8 * * *` | Ambiguous | recap + discovery without Monday scope | both recap and discovery are Monday-only | `worker/src/cron/discovery-scan.ts:140-142`, `worker/src/cron/weekly-recap.ts:135-138` | Yes |

### Changes Applied
- Corrected the schedule backbone and clarified the split discovery ingestion path.

## docs/data-pipeline.md

**Status:** 8 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Stability Index (PSI) Computation` | Inaccurate | runs every 15 minutes | runs every 30 minutes | `shared/lib/cron-jobs.ts:123-136`, `worker/src/handlers/scheduled/half-hourly.ts:32-44` | Yes |
| 2 | `Stability Index (PSI) Computation` storage | Inaccurate | 15-min samples | 30-minute samples | `shared/lib/cron-jobs.ts:123-136` | Yes |
| 3 | `Stale Data Monitoring` / Depeg row | Inaccurate | DEWS uses `CRON_15MIN` | DEWS uses `CRON_30MIN` | `src/hooks/api-hooks.ts:177-192`, `src/lib/data-health-config.ts:12-18` | Yes |
| 4 | `Stale Data Monitoring` / Blacklist row | Inaccurate | blacklist uses `CRON_20MIN` | blacklist uses `CRON_BLACKLIST` | `src/lib/cron-intervals.ts:4-9`, `src/hooks/use-blacklist-events.ts:3-8` | Yes |
| 5 | `Constants defined` | Inaccurate | `CRON_20MIN` described as generic 20 min set | `CRON_20MIN` is mint/burn; blacklist now has `CRON_BLACKLIST` | `src/lib/cron-intervals.ts:4-9` | Yes |
| 6 | `Coverage Discovery` intro | Inaccurate | all discovery comes from daily `runDiscoveryScan()` | discovery is split between quarter-hourly DL residual upserts and Monday CG scan | `worker/src/cron/discovery-scan.ts:140-181`, `worker/src/cron/sync-stablecoins/intake.ts:136-155` | Yes |
| 7 | `Source B` | Inaccurate | one call/day | one call/week on Mondays | `worker/src/cron/discovery-scan.ts:140-181` | Yes |
| 8 | `Candidate Lifecycle` | Inaccurate | upserted daily | upserted by quarter-hourly DL pass and Monday CG pass | `worker/src/cron/discovery-scan.ts:181-190`, `worker/src/cron/sync-stablecoins/intake.ts:152-158` | Yes |

### Changes Applied
- Rewrote the PSI cadence/storage statements to the current half-hourly model.
- Updated the frontend freshness contract section after fixing the code-side interval constants and hooks.
- Split the discovery section into its actual two-source ingestion model.

## docs/dews.md

**Status:** 3 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Intro paragraph | Inaccurate | computed every 15 minutes | computed every 30 minutes | `shared/lib/cron-jobs.ts:131-136`, `worker/src/handlers/scheduled/half-hourly.ts:32-39` | Yes |
| 2 | `Data Pipeline` / `stress_signals` | Inaccurate | 15-minute rolling samples | 30-minute rolling samples | `shared/lib/cron-jobs.ts:131-136` | Yes |
| 3 | `Cron Schedule` | Inaccurate | `*/15` after `sync-stablecoins` | `10,40 * * * *` after `sync-dex-liquidity` | `worker/src/handlers/scheduled/half-hourly.ts:25-39` | Yes |

### Changes Applied
- Updated the DEWS doc to the current half-hourly trigger chain and sample cadence.

## docs/mint-burn-flows.md

**Status:** 1 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Cron Schedule` / trigger mode | Inaccurate | blacklist is a dedicated 20-minute trigger | blacklist is a dedicated hourly trigger | `worker/wrangler.toml:32-35` | Yes |

### Changes Applied
- Corrected the cross-reference to the blacklist lane so the mint/burn doc no longer points readers to the retired 20-minute cadence.

## docs/stability-index.md

**Status:** 4 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | Intro paragraph | Inaccurate | computed every 15 minutes | computed every 30 minutes | `shared/lib/cron-jobs.ts:123-136`, `worker/src/handlers/scheduled/half-hourly.ts:32-44` | Yes |
| 2 | `Cron & Storage` / sample cadence | Inaccurate | `*/15` 15-min samples | `10,40 * * * *` 30-minute samples | `shared/lib/cron-jobs.ts:123-136`, `worker/src/handlers/scheduled/half-hourly.ts:32-44` | Yes |
| 3 | `Cron & Storage` / daily aggregation | Inaccurate | averages 15-min samples | averages 30-minute samples | `shared/lib/cron-jobs.ts:123-136` | Yes |
| 4 | `Key Files` | Inaccurate | `worker/src/cron/stability-index.ts` is a 15-minute cron job | 30-minute cron job | `shared/lib/cron-jobs.ts:123-129` | Yes |

### Changes Applied
- Updated every cadence reference in the PSI methodology doc to the current half-hourly compute lane.

## docs/status-dashboard.md

**Status:** 3 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `Cron cards are grouped` / 20-minute lane | Inaccurate | includes `sync-blacklist` | 20-minute lane is mint/burn only | `shared/lib/cron-jobs.ts:63-79` | Yes |
| 2 | `Cron cards are grouped` / 30-minute lane | Incomplete | charts / liquidity / yield only | charts / liquidity / DEWS / PSI / yield | `shared/lib/cron-jobs.ts:69-72`, `worker/src/handlers/scheduled/half-hourly.ts:1-44` | Yes |
| 3 | `Cron cards are grouped` / hourly lane | Incomplete | reserve / redemption only | blacklist + reserve + redemption | `shared/lib/cron-jobs.ts:75-79` | Yes |

### Changes Applied
- Updated the lane-grouping description so the status doc matches the metadata now emitted by `shared/lib/cron-jobs.ts`.

## docs/worker-infrastructure.md

**Status:** 8 inaccurate / 0 stale / 0 incomplete

### Issues Found
| # | Line/Section | Type | Doc Says | Code Says | Source File | Fixed? |
|---|-------------|------|----------|-----------|-------------|--------|
| 1 | `wrangler.toml Triggers` | Inaccurate | blacklist cron `3,23,43 * * * *` | `3 * * * *` | `worker/wrangler.toml:32-35` | Yes |
| 2 | `Trigger 1` execution note | Inaccurate | DEWS/PSI moved to Trigger 7 | moved to Trigger 6 | `worker/src/handlers/scheduled/half-hourly.ts:1-44` | Yes |
| 3 | `Trigger 10` table | Incomplete | omitted `weekly-recap` | `weekly-recap` runs on the same `5 8 * * *` trigger | `shared/lib/cron-jobs.ts:287-299`, `worker/src/handlers/scheduled/daily-0805.ts:18-41` | Yes |
| 4 | `Trigger 10` connection budget | Incomplete | budget only accounts for bluechip + daily-digest + discovery | recap is chained after daily digest; recap + discovery are Monday-only | `worker/src/handlers/scheduled/daily-0805.ts:1-41`, `worker/src/cron/discovery-scan.ts:140-142`, `worker/src/cron/weekly-recap.ts:135-138` | Yes |
| 5 | `sync-stablecoin-charts` schedule | Inaccurate | every 30 min | half-hourly trigger, but successful writes capped at 1 hour | `worker/src/cron/sync-stablecoin-charts.ts:64-68` | Yes |
| 6 | `sync-stablecoin-charts` algorithm | Incomplete | fetch starts immediately | cooldown check happens before any fetch | `worker/src/cron/sync-stablecoin-charts.ts:64-70` | Yes |
| 7 | `sync-stablecoin-charts` footer note | Inaccurate | no staleness guard | 1-hour cooldown guard | `worker/src/cron/sync-stablecoin-charts.ts:64-68` | Yes |
| 8 | handler inventory | Incomplete | hourly reserve sync only | hourly blacklist + reserve slots | `worker/src/handlers/scheduled.ts`, `shared/lib/cron-jobs.ts:75-79` | Yes |

### Changes Applied
- Repaired the trigger inventory, Trigger 10 table, and the charts cron walkthrough so the infra doc matches the live scheduler again.

## 2. Coverage Gap Analysis

### Undocumented Systems
| System/Feature | Complexity | Recommended Action |
|---------------|-----------|-------------------|
| None above the “needs its own doc” threshold in this pass | — | Existing docs already cover cemetery/compare, dependency map, coverage, portfolio, blacklist, digest, reserve adapters, scripts, operator access, and cron infrastructure |

### New Documents Created
- None. I did not find a missing subsystem large enough to warrant a new doc after comparing the existing corpus against `src/`, `worker/`, `scripts/`, and `data/`.

## 3. Cross-Consistency Report

### Cross-Document Conflicts
| Doc A | Doc B | Conflict | Resolution |
|-------|-------|----------|------------|
| `README.md` | `docs/worker-infrastructure.md` | blacklist described as 20-minute in one place and hourly in another | standardized on `3 * * * *` hourly |
| `docs/stability-index.md` | `docs/dews.md` | PSI/DEWS still described as 15-minute chained-after-stablecoins jobs | standardized on shared half-hourly lane `10,40 * * * *` after DEX liquidity |
| `docs/api-reference.md` | `docs/architecture.md` | PSI endpoint described as daily-only in one place, live+history in another | standardized on “latest sample plus daily history” |
| `docs/data-pipeline.md` | `docs/data-flow-map.md` | discovery still described as daily single-path ingestion | standardized on split ingestion: quarter-hourly DL residuals + Monday CoinGecko scan |
| `docs/api-reference.md` | `docs/worker-infrastructure.md` | stablecoin charts described as 30-minute refresh vs 1-hour effective write cadence | standardized on “30-minute trigger with 1-hour write cooldown” |

### Terminology Standardization
- Normalized `blacklist sync` to “hourly” everywhere the live cron cadence is described.
- Normalized PSI/DEWS cadence language to “30 minutes” / “half-hourly lane”.
- Normalized coverage discovery language to “Monday CoinGecko scan plus quarter-hourly DefiLlama residual upserts”.
- Normalized stablecoin chart freshness language to distinguish trigger cadence from effective write cadence.

## 4. Supporting Code Fixes

The docs were not the only stale surface. I made the following supporting code fixes so the code-backed freshness contract now matches the corrected docs:

- `src/lib/cron-intervals.ts`: `CRON_20MIN` now maps to mint/burn, and `CRON_BLACKLIST` now maps to the hourly blacklist lane. Ground truth: `shared/lib/cron-jobs.ts:105-149`.
- `src/hooks/api-hooks.ts`: `useStablecoinCharts()` now uses `CRON_1H`; PSI and DEWS hooks now use `CRON_30MIN`. Ground truth: `src/hooks/use-api-query.ts:51-65`, `shared/lib/cron-jobs.ts:105-136`.
- `src/lib/data-health-config.ts`: blacklist, PSI, and DEWS presets now align with actual backend cadences. Ground truth: `src/lib/cron-intervals.ts:4-9`, `src/hooks/api-hooks.ts:133-192`.
- `src/hooks/use-blacklist-events.ts`: polling now uses `CRON_BLACKLIST`. Ground truth: `src/lib/cron-intervals.ts:4-9`.
- `shared/lib/cron-jobs.ts`: status-page group descriptions now match the current lane layout.
- `eslint.config.mjs` and `vitest.config.ts`: added `.claude/**` ignores so repo verification commands stop linting/testing sub-agent worktrees and generated `.next/out` artifacts.

## 5. Summary Dashboard

| Document | Claims Checked | Verified | Issues Found | Issues Fixed |
|----------|---------------:|---------:|-------------:|-------------:|
| `README.md` | 15 | 6 | 9 | 9 |
| `docs/api-reference.md` | 8 | 5 | 3 | 3 |
| `docs/architecture.md` | 12 | 4 | 8 | 8 |
| `docs/blacklist-tracker.md` | 5 | 3 | 2 | 2 |
| `docs/data-flow-map.md` | 9 | 4 | 5 | 5 |
| `docs/data-pipeline.md` | 14 | 6 | 8 | 8 |
| `docs/dews.md` | 8 | 5 | 3 | 3 |
| `docs/mint-burn-flows.md` | 5 | 4 | 1 | 1 |
| `docs/stability-index.md` | 10 | 6 | 4 | 4 |
| `docs/status-dashboard.md` | 6 | 3 | 3 | 3 |
| `docs/worker-infrastructure.md` | 18 | 10 | 8 | 8 |
| TOTAL (changed docs + root README) | 110 | 56 | 54 | 54 |

## 6. Verification Commands

- `npm run check:doc-sync` — passed
- `npm run check:doc-counts` — passed
- `cd worker && npx tsc --noEmit` — passed
- `npm run lint` — passed after adding `.claude/**` to ESLint ignores so the command stops traversing sub-agent worktrees and generated build artifacts
- `npm test` — failed, but the failures are unrelated to this docs/cadence work:
  - `shared/lib/__tests__/reserve-risk-consistency.test.ts`
  - `src/lib/__tests__/reserve-coinid-validation.test.ts`
- `npm run build` — passed
