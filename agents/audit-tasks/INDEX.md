# Audit progress — INDEX

> **Generated** by `node agents/rebuild-audit-index.mjs`. Do not hand-edit — edit individual
> finding files; re-run to refresh. Protocol: `README.md`. Narrative report: `../CODEBASE-AUDIT-2026-06-15.md`.

**105/733 done (14%)**  `███░░░░░░░░░░░░░░░░░`

| Status | todo | in-progress | blocked | done | wontfix |
|---|---|---|---|---|---|
| Count | 605 | 4 | 0 | 105 | 19 |

### By pillar
| Pillar | Total | Done | In-progress | Blocked | Todo |
|---|---|---|---|---|---|
| redundancy | 266 | 46 | 2 | 0 | 208 |
| quality | 315 | 50 | 2 | 0 | 256 |
| sustainability | 152 | 9 | 0 | 0 | 141 |

## redundancy (266)

### High (1)

| | ID | E | Category | Title | Owner | Loc |
|---|---|---|---|---|---|---|
| ✅ | [R-001](redundancy/R-001.md) | M | naming | Two divergent functions named classifyLiquidityEvidence classify the same public field dif | codex | `worker/src/api/dex-liquidity-history.ts:15-51 + ` |

### Medium (82)

| | ID | E | Category | Title | Owner | Loc |
|---|---|---|---|---|---|---|
| ⬜ | [R-002](redundancy/R-002.md) | S | clone | REVIEWED_YIELD_EXPANSION_AT defined independently in two files with identical value |  | `shared/lib/redemption-backstop-configs/queue-red` |
| ✅ | [R-003](redundancy/R-003.md) | S | clone | formatRatio duplicated across two status files | codex | `worker/src/lib/status/evaluation-causes.ts:L17-L` |
| ✅ | [R-004](redundancy/R-004.md) | S | clone | parseSitemapLocs duplicated across check-seo-static.mjs and check-seo-live-smoke.mjs | codex | `scripts/ci/check-seo-static.mjs:L547-L558, scrip` |
| ⬜ | [R-005](redundancy/R-005.md) | S | clone | clearSetupState duplicates clearPendingDisambiguation from the store |  | `worker/src/api/telegram-webhook-setup.ts:L201-L2` |
| ⬜ | [R-006](redundancy/R-006.md) | S | clone | Duplicate subscriberHasGlobal function in mutations and render modules |  | `worker/src/api/telegram-webhook-settings-mutatio` |
| ⬜ | [R-007](redundancy/R-007.md) | S | clone | Identical ratioFromRaw / RATIO_SCALE duplicated in erc4626-single-asset and m0-wrapper-und |  | `worker/src/cron/reserve-adapters/erc4626-single-` |
| ⬜ | [R-008](redundancy/R-008.md) | S | clone | ERC4626 and ERC20 selector constants re-declared inside liquity-v2-branches instead of imp |  | `worker/src/cron/reserve-adapters/liquity-v2-bran` |
| ✅ | [R-009](redundancy/R-009.md) | S | dead-code | Inline import() type expressions in hero-card-sections.tsx for already-re-exported types | codex | `src/components/stablecoin-detail/hero-card-secti` |
| ✅ | [R-010](redundancy/R-010.md) | S | clone | DepegFeed load-more onClick duplicates the same setVisibleCount call | codex | `src/components/depeg-feed.tsx:L170-L177` |
| ✅ | [R-011](redundancy/R-011.md) | S | clone | Duplicated `isValidDateOnly` / `DATE_ONLY_RE` across two tooling modules | codex | `scripts/lib/hotspot-ratchet.mjs:L64-L70+L365-L37` |
| ✅ | [R-012](redundancy/R-012.md) | S | clone | stringValue() defined six times across scripts with identical body | codex | `scripts/maintenance/audit-dex-pricing-source-gap` |
| ⬜ | [R-013](redundancy/R-013.md) | S | clone | Three independent formatAge implementations across the telegram layer |  | `worker/src/api/telegram-webhook-insights.ts:L21-` |
| 🚫 | [R-014](redundancy/R-014.md) | S | dead-code | DEX_LIQUIDITY_TABLES Set is a dead allowlist — iteration array is always a strict subset |  | `worker/src/cron/dex-liquidity/persistence.ts:L54` |
| ⬜ | [R-015](redundancy/R-015.md) | S | clone | Two functionally identical price-observation merge functions coexist |  | `worker/src/cron/dex-liquidity/subgraph-helpers.t` |
| ⬜ | [R-016](redundancy/R-016.md) | S | clone | buildPoolIdentity called twice on the same DexScreener pair per iteration |  | `worker/src/cron/dex-liquidity/fetch-fallbacks.ts` |
| ⬜ | [R-017](redundancy/R-017.md) | S | clone | Identical BAND_RANK literal duplicated from shared THREAT_BAND_ORDER |  | `worker/src/cron/daily-digest/editorial-candidate` |
| ⬜ | [R-018](redundancy/R-018.md) | S | dead-code | Local throwIfAborted in sync-redemption-backstops.ts duplicates lib/abort export |  | `worker/src/cron/sync-redemption-backstops.ts:L32` |
| ⬜ | [R-019](redundancy/R-019.md) | S | wrapper | safety-score-data.ts is a single-consumer indirection with no reuse value |  | `shared/lib/methodology-versions/safety-score-dat` |
| ⬜ | [R-020](redundancy/R-020.md) | S | dead-code | Dead `markdown` and `markdownParagraphs` fields computed and stored but never read |  | `src/app/methodology/sections/methodology-content` |
| ⬜ | [R-021](redundancy/R-021.md) | S | clone | Hardcoded BOT_USERNAME in CoinInsightPanel duplicates PHAROSWATCHBOT_BOT_URL constant |  | `src/app/pharoswatchbot/app/components/CoinInsigh` |
| ⬜ | [R-022](redundancy/R-022.md) | S | clone | Duplicate readableComponentKey function with divergent implementations |  | `src/app/screener/picker/result-pane.tsx:534-546 ` |
| ⬜ | [R-023](redundancy/R-023.md) | S | clone | ChartMargin interface defined twice in the same chart-primitives directory |  | `src/components/chart-primitives/axes.tsx:L25-L31` |
| ⬜ | [R-024](redundancy/R-024.md) | S | clone | countConsecutiveStatus and getLastSuccessfulRun duplicated between cron-card and cron-lane |  | `src/components/status/cron-card.tsx:L39-L55, src` |
| ✅ | [R-025](redundancy/R-025.md) | S | dead-code | PharosLogoWithText exported but never imported | codex | `src/components/pharos-logo.tsx:L41-L59` |
| ⬜ | [R-026](redundancy/R-026.md) | S | clone | Data-source label map duplicated across two modules |  | `src/components/yield-detail-section-model.ts:L17` |
| ✅ | [R-027](redundancy/R-027.md) | S | clone | Exact clone of canListen/allocatePort/resolveStaticExportPort across two scripts | codex | `scripts/maintenance/lighthouse-static-export.mjs` |
| ✅ | [R-028](redundancy/R-028.md) | S | clone | stringValue / numberValue re-defined locally in 6+ maintenance scripts despite shared expo | codex | `scripts/maintenance/audit-dia-provider-poc.ts:L1` |
| ⬜ | [R-029](redundancy/R-029.md) | M | clone | Structural clone: api-query-registry.ts and api-query-runtime-registry.ts |  | `src/lib/api-query-registry.ts:L1-L361, src/lib/a` |
| ⬜ | [R-030](redundancy/R-030.md) | S | clone | Double console.log for directApiSkippedUntracked behind identical guard |  | `worker/src/cron/dex-liquidity/orchestrator-phase` |
| ⬜ | [R-031](redundancy/R-031.md) | S | dead-code | _symbolToIds parameter is dead in both subgraph source-family fetchers |  | `worker/src/cron/dex-liquidity/subgraph-source-fa` |
| ⬜ | [R-032](redundancy/R-032.md) | S | clone | Local re-derivation of ConfiguredCoin / LiveReserveConfig duplicates shared types |  | `worker/src/cron/sync-live-reserves-core.ts:25-27` |
| ⬜ | [R-033](redundancy/R-033.md) | S | clone | normalizeAddress function independently implemented in four separate adapters |  | `worker/src/cron/reserve-adapters/crvusd.ts:L158-` |
| ⬜ | [R-034](redundancy/R-034.md) | S | config | CMC_CATEGORY_LIMIT constant is not used in URL construction — hardcoded literal duplicated |  | `worker/src/cron/sync-stablecoins/enrich-prices-c` |
| ⬜ | [R-035](redundancy/R-035.md) | S | clone | Three identical 4-member alert-type unions defined independently |  | `worker/src/cron/dispatch-telegram-alerts-fanout.` |
| ⬜ | [R-036](redundancy/R-036.md) | S | clone | mapWithConcurrency implemented three times with divergent semantics |  | `worker/src/lib/concurrency.ts:22-58, worker/src/` |
| ⬜ | [R-037](redundancy/R-037.md) | S | clone | editMessage and editMessageText are near-identical clones |  | `worker/src/lib/telegram.ts:L464-L490, L501-L526` |
| ⬜ | [R-038](redundancy/R-038.md) | S | clone | safeJsonParse and safeJsonParseWithContext are byte-for-byte identical except for a defaul |  | `worker/src/lib/api-cache-read.ts:L41-L63` |
| ⬜ | [R-039](redundancy/R-039.md) | M | clone | Near-full structural clone between homepage-bootstrap.ts and homepage-bootstrap-runtime.ts |  | `src/lib/homepage-bootstrap.ts:1-179 + src/lib/ho` |
| 🚫 | [R-040](redundancy/R-040.md) | S | dead-code | 36 individual changelog-entry functions exported but never imported outside their module |  | `src/app/methodology/scoring-changelog/content-v7` |
| ⬜ | [R-041](redundancy/R-041.md) | M | clone | Desktop/mobile diagram JSX duplicated verbatim in four methodology section files |  | `src/app/methodology/sections/core/safety-scores-` |
| ⬜ | [R-042](redundancy/R-042.md) | S | dead-code | FiatWorldAtlas accepts two props it never reads |  | `src/app/alt-pegs/fiat-world-atlas/world-atlas.ts` |
| ⬜ | [R-043](redundancy/R-043.md) | S | clone | Duplicate `Map` construction over `searchableCoins` in WatchlistPanel |  | `src/app/pharoswatchbot/app/components/WatchlistP` |
| ⬜ | [R-044](redundancy/R-044.md) | S | clone | Duplicate CoinCrossTrackerHatnote render when stablecoin filter is active |  | `src/app/freezewatch/client.tsx:L91-L134` |
| ⬜ | [R-045](redundancy/R-045.md) | S | dead-code | Inline hydration helpers in screener-table duplicate the existing useHydrated hook |  | `src/components/screener/screener-table.tsx:L113-` |
| ⬜ | [R-046](redundancy/R-046.md) | S | clone | Duplicate CoinLockup component — reviewer module vs shared row-card |  | `src/components/depeg-resolver-reviewer-module.ts` |
| ⬜ | [R-047](redundancy/R-047.md) | S | clone | Duplicated resolveApiBase() and fetchHeaders() in two sibling scripts |  | `scripts/maintenance/generate-homepage-bootstrap.` |
| ⬜ | [R-048](redundancy/R-048.md) | S | clone | normalizeStablecoinRows has near-identical field-building blocks for two payload shapes |  | `scripts/maintenance/audit-dex-pricing-source-gap` |
| ✅ | [R-049](redundancy/R-049.md) | S | dead-code | Duplicate path string literals in validation.ts shadow canonical API_PATHS entries | codex | `shared/lib/api-endpoints/validation.ts:L16-17` |
| ⬜ | [R-050](redundancy/R-050.md) | S | dead-code | Two ExclusionReason enum values are never emitted by the exclusion engine |  | `shared/lib/selector/types.ts:L349,L352; shared/l` |
| ⬜ | [R-051](redundancy/R-051.md) | S | clone | Duplicate buildReportCardMap implementations |  | `src/lib/stablecoin-lookups.ts:L14-L19, src/hooks` |
| ⬜ | [R-052](redundancy/R-052.md) | S | clone | Parallel CSV download implementations: csv-export.ts vs exports/csv.ts |  | `src/lib/csv-export.ts:1-20 + src/lib/exports/csv` |
| ⬜ | [R-053](redundancy/R-053.md) | S | clone | Duplicate normalizeApiMeta / normalizeDependencyMeta between api.ts and homepage-bootstrap |  | `src/lib/api.ts:140-179, src/lib/homepage-bootstr` |
| ⬜ | [R-054](redundancy/R-054.md) | S | clone | Duplicate finiteNumber helper across three files |  | `src/lib/yield-source-explorer-model.ts:114-116, ` |
| ⬜ | [R-055](redundancy/R-055.md) | S | clone | Duplicate stability-index light query hook |  | `src/hooks/use-stability-index-light.ts:L1-L8 + s` |
| ⬜ | [R-056](redundancy/R-056.md) | S | clone | Stablecoin price-cache loaded twice per dex-liquidity cron run |  | `worker/src/cron/dex-liquidity/orchestrator-phase` |
| ⬜ | [R-057](redundancy/R-057.md) | S | wrapper | fetch-primary.ts re-exports fetchUniV3Data and fetchAerodromeData as pure pass-through wra |  | `worker/src/cron/dex-liquidity/fetch-primary.ts:L` |
| ⬜ | [R-058](redundancy/R-058.md) | S | clone | Source-failure message strings duplicated between data-quality.ts and evaluation-causes.ts |  | `worker/src/lib/status/data-quality.ts:L20-L39, w` |
| ⬜ | [R-059](redundancy/R-059.md) | S | clone | Archetype dispatch logic cloned between index.tsx renderArchetype and wrapper-diagram.tsx  |  | `src/components/stablecoin-detail/mechanism-diagr` |
| ⬜ | [R-060](redundancy/R-060.md) | S | dead-code | CronCard is dead production code — only test-file imports keep it alive |  | `src/components/status/cron-card.tsx:L1-L225` |
| ⬜ | [R-061](redundancy/R-061.md) | S | clone | Local depegColorClass duplicates the shared deviationColorClass from severity-colors |  | `src/components/market-highlights.tsx:L141-L147` |
| ⬜ | [R-062](redundancy/R-062.md) | S | clone | Daily-digest 'non-weekly' SQL filter duplicated instead of importing shared constant |  | `worker/src/api/daily-digest.ts:7 (clone of worke` |
| ⬜ | [R-063](redundancy/R-063.md) | S | dead-code | setCache for kinesis totals is a dead write — no consumer reads it |  | `worker/src/cron/sync-kinesis-supply.ts:123-132` |
| ⬜ | [R-064](redundancy/R-064.md) | S | clone | Local pegTypeFromCurrency in stablecoin-charts-reconciliation duplicates shared normalizeP |  | `worker/src/lib/stablecoin-charts-reconciliation.` |
| ✅ | [R-065](redundancy/R-065.md) | S | clone | Three independent directory-walk implementations when source-files.mjs already exists | codex | `scripts/lib/hotspot-ratchet.mjs:L80-L105, script` |
| ⬜ | [R-066](redundancy/R-066.md) | M | clone | CSV escapeCsvField re-implemented in generate-public-datasets.ts despite a canonical versi |  | `scripts/maintenance/generate-public-datasets.ts:` |
| ⬜ | [R-067](redundancy/R-067.md) | S | clone | DdrrV2CoverageRowSchema re-declares terminal-evidence fields already present in DdrrV2Base |  | `shared/types/depeg-resolver-review.ts:L193-L209,` |
| ⬜ | [R-068](redundancy/R-068.md) | S | clone | D1_WRITE_FINALIZE_TIMEOUT_MS constant in core.ts duplicates the budget-config default |  | `worker/src/cron/sync-live-reserves-core.ts:46` |
| ⬜ | [R-069](redundancy/R-069.md) | S | wrapper | chainlink-nav.ts is a zero-logic pass-through wrapper over chainlink-nav-core.ts |  | `worker/src/cron/reserve-adapters/chainlink-nav.t` |
| ⬜ | [R-070](redundancy/R-070.md) | S | dead-code | Orphaned _backfillYieldHistory function + its fetch machinery is dead code |  | `worker/src/cron/yield-history-backfill.ts:7-9,60` |
| ⬜ | [R-072](redundancy/R-072.md) | M | clone | stringValue/numberValue/isRecord type-guards re-declared in 7+ scripts files despite @shar |  | `shared/lib/type-guards.ts:5-21 (canonical isReco` |
| ⬜ | [R-073](redundancy/R-073.md) | S | clone | Desktop/mobile layout of LiquidityTechnicalDetails duplicates the component list render |  | `src/app/methodology/sections/core/liquidity-tech` |
| ⬜ | [R-074](redundancy/R-074.md) | S | clone | LazyCard in safety-scores/client.tsx duplicates the existing LazySection component |  | `src/app/safety-scores/client.tsx:L38-L57, src/co` |
| ⬜ | [R-079](redundancy/R-079.md) | S | type-safety | Shadow NativePegQuote type collides with the canonical one |  | `worker/src/cron/pending-depeg-confirmation.ts:45` |
| ⬜ | [R-080](redundancy/R-080.md) | M | clone | Source-key prefix routing duplicated across three modules with no shared parser |  | `worker/src/cron/yield-sync/source-risk.ts:36-71,` |
| ⬜ | [R-081](redundancy/R-081.md) | M | clone | median() reimplemented 6+ times across shared, worker, and src instead of using shared/lib |  | `shared/lib/stats.ts:18-24 (canonical, filters no` |
| ⬜ | [R-082](redundancy/R-082.md) | M | clone | Two independent timing-safe comparison implementations coexist in the same worker |  | `worker/src/lib/auth.ts:L183-L195, worker/src/lib` |
| ⬜ | [R-083](redundancy/R-083.md) | M | wrapper | Test-only legacy api-key handler wrappers shipped in production source |  | `worker/src/api/api-keys.ts:23-25,47-54,71-78,102` |
| ⬜ | [R-084](redundancy/R-084.md) | M | clone | Compact-USD abbreviation (T/B/M/K with $) implemented in 4 places across worker, src, and  |  | `shared/lib/format.ts:7-38 (abbreviateNumber/form` |
| ⬜ | [R-085](redundancy/R-085.md) | M | clone | Number-coercion helpers (toFiniteNumber/parseFiniteNumber/coerceFiniteNumber/parsePositive |  | `worker/src/lib/number-utils.ts:1-13 (canonical t` |
| ⬜ | [R-086](redundancy/R-086.md) | S | dead-code | buildComparableSets output (comparableSets) is fully computed but only consumed by its own |  | `src/lib/yield-view-model.ts:894-922, 1221, 194` |
| ⬜ | [R-088](redundancy/R-088.md) | S | clone | Cron health-priority logic duplicated and divergent between getCronSeverity and getRowTone |  | `src/app/admin/cron-severity.ts:7-12; src/app/adm` |
| ⬜ | [R-089](redundancy/R-089.md) | M | clone | erc4626-nav, preview-redeem, and idle-cdo-tranche providers are near-identical PriceSource |  | `worker/src/lib/authoritative-price-sources/erc46` |

### Low (183)

| | ID | E | Category | Title | Owner | Loc |
|---|---|---|---|---|---|---|
| ⬜ | [R-071](redundancy/R-071.md) | M | clone | ISO date formatter (epoch->YYYY-MM-DD) re-implemented inline ~30x in worker despite export |  | `shared/lib/format.ts:158-160 (canonical formatIs` |
| 🔄 | [R-075](redundancy/R-075.md) | S | clone | parseDigestParagraph duplicates bold-header stripping already done in consumers of lib/dig | codex | `src/components/daily-digest.tsx:L67-L72` |
| ⬜ | [R-076](redundancy/R-076.md) | S | clone | StablecoinChartResponseSchema and UsdsStatusResponseSchema are domain-mislocated in digest |  | `shared/types/digest.ts:L393-L427` |
| ⬜ | [R-077](redundancy/R-077.md) | S | clone | formatNetFlowUsd in mint-burn-card duplicates shared compact-USD formatting with a minor p |  | `src/components/home-alt-mini-cards/mint-burn-car` |
| ⬜ | [R-078](redundancy/R-078.md) | S | wrapper | useCoverageMatrixQueryResource is a trivial useMemo wrapper used only once |  | `src/hooks/use-coverage-matrix-model.ts:L28-L40` |
| ⬜ | [R-087](redundancy/R-087.md) | M | clone | Two independent fetch-with-retry+backoff+sleep stacks (worker vs scripts) plus inline abor |  | `worker/src/lib/fetch-retry.ts:28-89 + worker/src` |
| ✅ | [R-090](redundancy/R-090.md) | S | clone | Split import of `@shared/lib/format` in chains/client.tsx | codex | `src/app/chains/client.tsx:L19, L23` |
| ✅ | [R-091](redundancy/R-091.md) | S | dead-code | Redundant `shouldShowTickerLabel` alias in coin-emblem.tsx | codex | `src/app/alt-pegs/fiat-world-atlas/coin-emblem.ts` |
| ✅ | [R-092](redundancy/R-092.md) | S | clone | Split import statements from `@/hooks/api-hooks` in depeg/client.tsx | codex | `src/app/depeg/client.tsx:L8-L9` |
| ✅ | [R-093](redundancy/R-093.md) | S | dead-code | getErrorMessage in raw-snapshot.ts is a one-line pass-through wrapper with no value | codex | `worker/src/lib/status/raw-snapshot.ts:L48-L50` |
| ⬜ | [R-094](redundancy/R-094.md) | S | dead-code | buildComplianceViewModel calls isGeniusRegimeEffective twice per invocation |  | `src/app/compliance/model.ts:L268-L278` |
| ✅ | [R-095](redundancy/R-095.md) | S | dead-code | collectCronConsoleUsage is an exported alias with zero importers | codex | `scripts/ci/check-cron-console-usage.mjs:L153` |
| ✅ | [R-096](redundancy/R-096.md) | S | wrapper | One-line ChartTooltip wrapper adds no value inside cemetery-charts.tsx | codex | `src/components/cemetery-charts.tsx:L33-L39` |
| ⬜ | [R-097](redundancy/R-097.md) | S | dead-code | documentedBoundSupplyFull called only to discard its capacityModel in 10 stablecoin-redeem |  | `shared/lib/redemption-backstop-configs/stablecoi` |
| ⬜ | [R-098](redundancy/R-098.md) | S | dead-code | Hardcoded ownership-conflict string at telegram-webhook.ts:557 bypasses the shared PENDING |  | `worker/src/api/telegram-webhook.ts:L557` |
| ⬜ | [R-099](redundancy/R-099.md) | S | clone | countWords and countTitleWords are identical functions |  | `worker/src/cron/daily-digest/response.ts:L248-L2` |
| ⬜ | [R-100](redundancy/R-100.md) | S | wrapper | Local throwIfAborted closure in sync-mint-burn.ts duplicates lib/abort utility |  | `worker/src/cron/sync-mint-burn.ts:79-85` |
| ⬜ | [R-101](redundancy/R-101.md) | S | dead-code | SupplyGapReconciliationResult has two identical fields: reconciledCount and totalReconcile |  | `worker/src/cron/sync-stablecoins/supply-gap-reco` |
| ✅ | [R-102](redundancy/R-102.md) | S | wrapper | Private getErrorMessage is a one-line alias for the already-imported toErrorMessage | codex | `worker/src/lib/status-reliability-shared.ts:L147` |
| ✅ | [R-103](redundancy/R-103.md) | S | dead-code | Dead 'file-section' branch in check-selector-banned-phrases.mjs | codex | `scripts/ci/check-selector-banned-phrases.mjs:L94` |
| ✅ | [R-104](redundancy/R-104.md) | S | dead-code | check-cron-connection-budget.ts: missingBudgetJobs.length in the `failed` initializer is a | codex | `scripts/ci/check-cron-connection-budget.ts:L89-L` |
| ✅ | [R-105](redundancy/R-105.md) | S | wrapper | clampPercent is a zero-value thin wrapper over shared clampScore | codex | `src/components/depeg-control-board.tsx:L57-L59` |
| ⬜ | [R-106](redundancy/R-106.md) | S | clone | Identical resolveStaticCostScore duplicated across two audit scripts |  | `scripts/maintenance/audit-redemption-registry-pa` |
| ✅ | [R-107](redundancy/R-107.md) | S | dead-code | DAY_MS re-declared as a module-scoped constant in tape-digest.ts instead of importing from | codex | `src/lib/tape-digest.ts:8` |
| ⬜ | [R-108](redundancy/R-108.md) | S | dead-code | 'deleted' counter in SyncCurrentBalanceCacheResult is declared but never incremented |  | `worker/src/cron/blacklist/current-balance-cache.` |
| ⬜ | [R-109](redundancy/R-109.md) | S | clone | AlertMarker type and readMarker() duplicated across two watchdog files |  | `worker/src/cron/cron-staleness-watchdog.ts:112-1` |
| ⬜ | [R-110](redundancy/R-110.md) | S | clone | pegTypeKey and getChainLabels exactly duplicated in zephyr-zsd.ts |  | `worker/src/cron/sync-stablecoins/zephyr-zsd.ts:4` |
| ✅ | [R-111](redundancy/R-111.md) | S | dead-code | dispatchIntervalSec hardcoded in emptyPendingCapacity instead of referencing the constant | codex | `worker/src/cron/dispatch-telegram-result.ts:L65` |
| ⬜ | [R-112](redundancy/R-112.md) | S | clone | telegram-digest-appendices.ts rebuilds TRACKED_META_BY_ID instead of importing it |  | `worker/src/lib/telegram-digest-appendices.ts:L36` |
| ⬜ | [R-113](redundancy/R-113.md) | S | dead-code | symbolToIds parameter accepted but immediately voided in convertToGtNewPools |  | `worker/src/lib/dex-api-pool-shaping.ts:L282, L28` |
| ⬜ | [R-114](redundancy/R-114.md) | S | clone | parseCsvSymbols in mint-burn-health-config duplicates parseCsvEnv in env.ts |  | `worker/src/lib/mint-burn-health-config.ts:L40-L4` |
| ✅ | [R-115](redundancy/R-115.md) | S | dead-code | inferTag and TAG_RULES are permanently dead code | codex | `src/components/changelog-entry-card.tsx:L7-17, L` |
| ⬜ | [R-116](redundancy/R-116.md) | S | dead-code | Dead `screenerFilterChips` key in buildResultSummaryCoordinationProps spread |  | `src/app/screener/picker/handoff.ts:L136` |
| ⬜ | [R-117](redundancy/R-117.md) | S | clone | gradeRank() duplicated with divergent NR semantics across two files |  | `src/components/stablecoin-detail/safety-score-hi` |
| ⬜ | [R-118](redundancy/R-118.md) | S | clone | scheduleIdle() is a near-clone in two component files |  | `src/components/home-alt-hero-chart-gate.tsx:29-4` |
| ⬜ | [R-119](redundancy/R-119.md) | S | dead-code | getDepegRowPegSeries is a no-op stub wrapping a fixed placeholder array |  | `src/components/depeg-tracker-table.tsx:L68-L74` |
| ✅ | [R-120](redundancy/R-120.md) | S | clone | isReadableStablecoinStatus duplicates isReadableStablecoinMeta | codex | `shared/lib/stablecoins/schema.ts:L126-L128` |
| ⬜ | [R-121](redundancy/R-121.md) | S | clone | Same calendar dates aliased under 3-4 different constant names across files |  | `shared/lib/redemption-backstop-configs/review-da` |
| ⬜ | [R-122](redundancy/R-122.md) | S | clone | Duplicate depeg-step type-guard: isDepegStep vs isDepegStepValue |  | `worker/src/api/telegram-webhook-settings-shared.` |
| ⬜ | [R-123](redundancy/R-123.md) | S | clone | SyncBlacklistApiErrorConfig type is private in sync-support.ts but re-declared inline in s |  | `worker/src/cron/blacklist/sync-support.ts:L29-L3` |
| ⬜ | [R-124](redundancy/R-124.md) | S | clone | CrawlStats zero-initialization object literal copy-pasted three times |  | `worker/src/cron/dex-liquidity/fetch-crawlers.ts:` |
| ⬜ | [R-125](redundancy/R-125.md) | S | clone | Two private getMetaString helpers with identical signatures |  | `worker/src/cron/daily-digest/response.ts:L264-L2` |
| ⬜ | [R-126](redundancy/R-126.md) | S | dead-code | toAttemptMessage is a single-line pass-through wrapper with no added value |  | `worker/src/cron/sync-live-reserves-shared.ts:189` |
| ✅ | [R-127](redundancy/R-127.md) | S | dead-code | Dead re-export of isMissingTableError in source-state/fallback.ts | codex | `worker/src/cron/dews/source-state/fallback.ts:14` |
| ⬜ | [R-128](redundancy/R-128.md) | S | clone | sumPegBucketValues duplicates shared sumPegBuckets |  | `worker/src/cron/sync-stablecoins/phase-helpers.t` |
| ⬜ | [R-129](redundancy/R-129.md) | S | clone | toPositiveFiniteNumber defined three times with diverging return types |  | `worker/src/cron/sync-stablecoins/supplemental-as` |
| 🚫 | [R-130](redundancy/R-130.md) | S | dead-code | loadDexLiquidityMap is an exported thin wrapper with zero callers |  | `worker/src/lib/dex-liquidity.ts:L58-L63` |
| ⬜ | [R-131](redundancy/R-131.md) | S | clone | URL double-parse in live-reserves-store-row-decoding sourceUrls normalization |  | `worker/src/lib/live-reserves-store-row-decoding.` |
| ⬜ | [R-132](redundancy/R-132.md) | S | clone | Duplicate 'YYYY-MM-DD' → epoch-seconds parsers in cemetery.ts and lifecycle.ts |  | `worker/src/lib/tape-projectors/cemetery.ts:L20-L` |
| ⬜ | [R-133](redundancy/R-133.md) | S | clone | Duplicate loadObservedIds SELECT pattern across cemetery.ts and lifecycle.ts |  | `worker/src/lib/tape-projectors/cemetery.ts:L32-L` |
| ⬜ | [R-134](redundancy/R-134.md) | S | dead-code | mint-burn-spike and blacklist-surge annotation kinds are declared but never reachable on c |  | `shared/types/chart-annotation.ts:L12-19, src/hoo` |
| ✅ | [R-135](redundancy/R-135.md) | S | dead-code | Redundant local variable assignments for stablecoin counts in AboutPage | codex | `src/app/about/page.tsx:L231-L243` |
| ⬜ | [R-136](redundancy/R-136.md) | S | dead-code | `entries` field on `MethodologyChangelogRouteDefinition` is exposed but never consumed ext |  | `src/app/methodology/changelog-route-factory.tsx:` |
| ⬜ | [R-137](redundancy/R-137.md) | S | dead-code | feedPages and datasetPages are permanently empty arrays in sitemap.ts |  | `src/app/sitemap.ts:462-484` |
| ✅ | [R-138](redundancy/R-138.md) | S | wrapper | fieldClassName() is a zero-argument function returning a constant string | codex | `src/components/status/api-keys-panel-parts.tsx:L` |
| ⬜ | [R-139](redundancy/R-139.md) | S | clone | intensity is clamped twice in the FlowMachine pipeline |  | `src/components/flow-machine-scene.tsx:49-53, src` |
| ✅ | [R-140](redundancy/R-140.md) | S | dead-code | Redundant alias `handleFocusSearch` that is the same function as `openGlobalCommandPalette | codex | `src/components/providers.tsx:L66, L129, L140` |
| ⬜ | [R-141](redundancy/R-141.md) | S | clone | `sleep` defined independently in sync-from-api.ts and smoke-runtime.mjs |  | `scripts/lib/sync-from-api.ts:L64, scripts/lib/sm` |
| ✅ | [R-142](redundancy/R-142.md) | S | wrapper | deriveVariantAwareDependencies is a zero-logic pass-through wrapper | codex | `shared/lib/stablecoins/variants.ts:L13-L17` |
| ⬜ | [R-143](redundancy/R-143.md) | S | clone | stablecoinRouteSearchText called twice per coin in buildL2BeatBridgeRouteReviewAudit |  | `shared/lib/chains/l2beat-audit.ts:L551, L589` |
| ✅ | [R-144](redundancy/R-144.md) | S | clone | escapeSqlString defined independently in two maintenance scripts instead of using the shar | codex | `worker/scripts/repair-non-usd-fiat-depeg-history` |
| ⬜ | [R-145](redundancy/R-145.md) | S | clone | InlineKeyboardButton interface duplicated in setup and messages modules |  | `worker/src/api/telegram-webhook-setup.ts:L77-L82` |
| ✅ | [R-146](redundancy/R-146.md) | S | dead-code | requireGroupAdminForCallback carries a _db parameter that is never used | codex | `worker/src/api/telegram-webhook-auth.ts:L80-L93` |
| ⬜ | [R-147](redundancy/R-147.md) | S | clone | DRPC_NETWORK map duplicated in balance-providers.ts and chainlink-feeds.ts |  | `worker/src/cron/blacklist/balance-providers.ts:L` |
| ⬜ | [R-148](redundancy/R-148.md) | S | wrapper | loadLastRunSec / recordLastRunSec re-implement the shared cache abstraction |  | `worker/src/cron/telegram-inactive-cleanup.ts:L51` |
| ✅ | [R-149](redundancy/R-149.md) | S | clone | cex-tickers.ts duplicates parsePositiveNumber from number-utils.ts | codex | `worker/src/lib/cex-tickers.ts:L65-L68` |
| ⬜ | [R-150](redundancy/R-150.md) | S | wrapper | Four single-line wrapper functions add no value over direct shouldSkipFreshMatchingCache c |  | `worker/src/lib/telegram-webhook-registration.ts:` |
| ⬜ | [R-151](redundancy/R-151.md) | S | dead-code | Dead else-if branch in buildCacheStatuses statusFloor finalization |  | `worker/src/lib/api-freshness.ts:L414-L422` |
| ⬜ | [R-152](redundancy/R-152.md) | S | clone | bigIntToDecimal is a one-line wrapper over decimalNumberFromBigInt |  | `worker/src/lib/bigint.ts:L26-L28` |
| ✅ | [R-153](redundancy/R-153.md) | S | dead-code | Unused `field` parameter in loadOptionalTelegramTelemetry | codex | `worker/src/lib/status/telegram-bot-stats.ts:L307` |
| ⬜ | [R-154](redundancy/R-154.md) | S | wrapper | loadMintBurnPriceContext is a trivial single-id wrapper that adds no value |  | `worker/src/lib/mint-burn-pipeline/context.ts:L74` |
| ⬜ | [R-155](redundancy/R-155.md) | S | dead-code | scopeNodeIds Set in computeVisibleGraph is redundant with the nodeIds loop |  | `src/components/contagion-graph-graph.ts:58-95` |
| ⬜ | [R-156](redundancy/R-156.md) | S | clone | Three private formatDeviation functions with near-identical logic |  | `src/app/depeg/[event]/page.tsx:78-85 + src/app/d` |
| ⬜ | [R-157](redundancy/R-157.md) | S | dead-code | capitalize() in selector-mobile-form duplicates selectorProfileLabel from shared |  | `src/components/selector/selector-mobile-form.tsx` |
| ✅ | [R-158](redundancy/R-158.md) | S | dead-code | selectConfirmedEvents is a transparent pass-through exported for testing but adding no log | codex | `scripts/maintenance/sync-depeg-events.ts:L83-L85` |
| ⬜ | [R-159](redundancy/R-159.md) | S | dead-code | getCoinsByLifecycleStatus accepts a 'dead' status that is unreachable and always returns [ |  | `shared/lib/stablecoins/by-mechanism.ts:L74-L91` |
| ⬜ | [R-160](redundancy/R-160.md) | S | clone | rowsById map constructed independently in lower-ranked and output-helpers for the same uni |  | `shared/lib/selector/lower-ranked.ts:L109-L110; s` |
| ✅ | [R-161](redundancy/R-161.md) | S | dead-code | getStabilityIndexNavSignal always returns null | codex | `src/lib/sidebar-signals.ts:L55-L57` |
| ⬜ | [R-162](redundancy/R-162.md) | S | clone | MONTH_INDEX and MONTH_LABEL arrays duplicated between attestation-pdf-index and usdh-nativ |  | `worker/src/cron/reserve-adapters/attestation-pdf` |
| ⬜ | [R-163](redundancy/R-163.md) | S | dead-code | Report-card cache envelope path (generation-mismatch / invalid-envelope) is unreachable at |  | `worker/src/lib/report-card-cache.ts:L102-L130, L` |
| 🔄 | [R-164](redundancy/R-164.md) | S | wrapper | toRedemptionBackstopVersionLabel re-export aliases a base utility only for one methodology | codex | `shared/lib/methodology-versions/redemption-backs` |
| ⬜ | [R-165](redundancy/R-165.md) | M | clone | Desktop/mobile diagram JSX trees duplicated verbatim in two methodology sections |  | `src/app/methodology/sections/core-sections-prici` |
| ⬜ | [R-166](redundancy/R-166.md) | S | wrapper | createAboutEditorialSection is a single-consumer factory wrapper |  | `src/app/about/editorial-helpers.tsx:L9-L31, src/` |
| ⬜ | [R-167](redundancy/R-167.md) | S | clone | Venue resolution logic duplicated across `venueFromInput` and `compareVenueParam` |  | `src/app/screener/picker/handoff.ts:L77-L111` |
| ✅ | [R-168](redundancy/R-168.md) | S | dead-code | DEFAULT_BASE_URL module-level constant in check-seo-live-smoke.mjs is a dead fallback | codex | `scripts/ci/check-seo-live-smoke.mjs:L5, L15, L42` |
| ⬜ | [R-169](redundancy/R-169.md) | S | dead-code | Local formatPercent duplicates shared/lib/format.formatPercentFromRatio |  | `src/components/depeg-resolver-reviewer-module.ts` |
| ⬜ | [R-170](redundancy/R-170.md) | S | wrapper | flow-machine-scene-shredder.tsx performs a one-shot matchMedia read inside useState initia |  | `src/components/flow-machine-scene-shredder.tsx:L` |
| ⬜ | [R-171](redundancy/R-171.md) | S | clone | FeedbackModal dynamic import duplicated across FeedbackButton and MobileUtilityDock |  | `src/components/feedback-button.tsx:L7-L10, src/c` |
| ✅ | [R-172](redundancy/R-172.md) | S | wrapper | `PAGES_UI_PREFIXES` in deploy-impact.mjs is a hard-coded clone of `DEPLOY_IMPACT_REGISTRY. | codex | `scripts/lib/deploy-impact.mjs:L22-L28` |
| ✅ | [R-173](redundancy/R-173.md) | S | wrapper | getResolvedDynamicEndpointDescriptor performs a redundant third descriptor lookup for admi | codex | `shared/lib/api-endpoints/validation.ts:L181-193` |
| 🚫 | [R-174](redundancy/R-174.md) | S | dead-code | variant-display.badgeClass is never read and is byte-identical to chipClass |  | `shared/lib/variant-display.ts:8-34` |
| ⬜ | [R-175](redundancy/R-175.md) | S | clone | Parallel CSV download implementation in csv-export.ts and exports/csv.ts |  | `src/lib/csv-export.ts:1-20, src/lib/exports/csv.` |
| ✅ | [R-176](redundancy/R-176.md) | S | dead-code | Duplicate metadata key skipped/skippedReason in preflight-skip log row | codex | `worker/src/handlers/scheduled/preflight-skip.ts:` |
| ✅ | [R-177](redundancy/R-177.md) | S | dead-code | Dead members in ApiKeyRequestRateLimitScope union | codex | `worker/src/api/api-key-requests/rate-limit.ts:14` |
| ⬜ | [R-178](redundancy/R-178.md) | S | clone | Preset label lookup duplicated between setup wizard and action-runner |  | `worker/src/api/telegram-webhook-setup.ts:L93-L98` |
| ⬜ | [R-179](redundancy/R-179.md) | S | wrapper | token-batch-runner.ts is a 3-line file exporting a single interface used nowhere directly |  | `worker/src/cron/dex-liquidity/token-batch-runner` |
| ⬜ | [R-180](redundancy/R-180.md) | S | clone | normalizeStringArray duplicated between response.ts and digest-intelligence.ts |  | `worker/src/cron/daily-digest/response.ts:L128-L1` |
| ✅ | [R-181](redundancy/R-181.md) | S | wrapper | pricing-source-policy.ts is a pure re-export shim with no added value | codex | `worker/src/lib/pricing-source-policy.ts:L1-L11` |
| ⬜ | [R-182](redundancy/R-182.md) | S | clone | Generic object/number/string/boolean accessor helpers cloned across three locations |  | `worker/src/lib/status/yield-health.ts:L99-L121, ` |
| ⬜ | [R-183](redundancy/R-183.md) | S | wrapper | getTelegramBotStats re-exported through derived-data.ts adding an unnecessary barrel hop |  | `worker/src/lib/status/derived-data.ts:L14, worke` |
| ⬜ | [R-184](redundancy/R-184.md) | S | clone | Identical inline type declarations in depeg-event-related-data.json.d.ts and depeg-event-s |  | `src/generated/depeg-event-related-data.json.d.ts` |
| ⬜ | [R-185](redundancy/R-185.md) | S | clone | Local CAUSE_OF_DEATH_LABELS in event-card.tsx duplicates shared CAUSE_META |  | `src/components/tape/event-card.tsx:L345-L354` |
| ⬜ | [R-186](redundancy/R-186.md) | S | clone | renderDelta and renderMetric are near-identical local render helpers in telegram-bot-stats |  | `src/components/status/telegram-bot-stats.tsx:L24` |
| ⬜ | [R-187](redundancy/R-187.md) | S | dead-code | getBackingLabelShort contains unreachable legacy-alias branches |  | `shared/lib/classification/domain.ts:L63-L71` |
| ⬜ | [R-188](redundancy/R-188.md) | S | wrapper | expandIds and defineBatch are two utilities for the same semantic operation with different |  | `shared/lib/redemption-backstop-configs/shared.ts` |
| ✅ | [R-189](redundancy/R-189.md) | S | dead-code | z.lazy forward reference in YieldHistoryPointSchema is unnecessary — YieldSourceRiskSchema | codex | `shared/types/yield.ts:L117` |
| ⬜ | [R-190](redundancy/R-190.md) | S | wrapper | No-op identity wrapper functions pollingDescriptor and staticDescriptor |  | `src/lib/api-query-registry.ts:L126-L132, src/lib` |
| ⬜ | [R-191](redundancy/R-191.md) | S | clone | Both coverage/mint-authority.ts and mint-authority-display.ts define nearly identical per- |  | `src/lib/coverage/mint-authority.ts:61-93 + src/l` |
| ⬜ | [R-192](redundancy/R-192.md) | S | dead-code | Watchlist legacy dual-write keeps stale storage keys alive indefinitely |  | `src/hooks/use-watchlist.ts:L73-L81` |
| ⬜ | [R-193](redundancy/R-193.md) | S | clone | postTelegramMessage duplicates sendToChat's fetch logic without reusing it |  | `worker/src/lib/telegram.ts:L56-L75` |
| ⬜ | [R-194](redundancy/R-194.md) | S | clone | offchain-issuer/shared.ts and stablecoin-redeem/shared.ts both re-export identical constan |  | `shared/lib/redemption-backstop-configs/offchain-` |
| ⬜ | [R-195](redundancy/R-195.md) | S | clone | BCB regulatory annotation label and timestamp duplicated verbatim across two BRL stablecoi |  | `shared/data/annotations/curated-annotations.ts:L` |
| ⬜ | [R-196](redundancy/R-196.md) | S | wrapper | ExplainerPageShell is a pure pass-through that adds no logic |  | `src/app/learn/mechanisms/explainer-page-shell.ts` |
| ⬜ | [R-197](redundancy/R-197.md) | S | clone | Duplicate `overallScore`/`safetyScore` both set to the same value in selector-data-adapter |  | `src/app/screener/picker/selector-data-adapter.ts` |
| ⬜ | [R-198](redundancy/R-198.md) | S | dead-code | homepage-skeletons.tsx is a one-line file with a single external consumer |  | `src/components/homepage-skeletons.tsx:L1-L5` |
| ⬜ | [R-199](redundancy/R-199.md) | S | wrapper | depeg-resolver-row-card.tsx is a thin glue file that only re-exports DepegResolverRowCard |  | `src/components/depeg-resolver-row-card.tsx:1-47` |
| ⬜ | [R-200](redundancy/R-200.md) | S | clone | Two independent YYYY-MM month-name formatters in the same feature area |  | `src/components/cemetery-tombstones.tsx:L204-L215` |
| ⬜ | [R-201](redundancy/R-201.md) | S | clone | FlowChart computes the data range twice — once from raw hourly buckets, once from shaped c |  | `src/components/flow-chart.tsx:L133-L140, L175-L1` |
| ⬜ | [R-202](redundancy/R-202.md) | S | clone | String-join dependency trick duplicated across two scroll-spy components |  | `src/components/api-reference-layout.tsx:L20-L36 ` |
| ⬜ | [R-203](redundancy/R-203.md) | S | clone | IterationOne is a private named sub-component of FlowBrrrOverview that adds an indirection |  | `src/components/flow-brrr-overview.tsx:L112-L298` |
| ✅ | [R-204](redundancy/R-204.md) | S | dead-code | Thin free-function wrappers `d1Query`, `d1QueryParsed`, `d1ExecFile` are unused outside te | codex | `scripts/lib/remote-d1.ts:L91-L101` |
| ⬜ | [R-205](redundancy/R-205.md) | S | dead-code | refresh-reserve-html-fixtures.ts fetches the same URL four times for four Circle fixture f |  | `scripts/maintenance/refresh-reserve-html-fixture` |
| ✅ | [R-206](redundancy/R-206.md) | S | dead-code | generate-cemetery-dataset.ts and generate-postman-collection.ts run side effects at module | codex | `scripts/maintenance/generate-cemetery-dataset.ts` |
| ⬜ | [R-207](redundancy/R-207.md) | S | dead-code | incident-groups computes reopenWithin24h (and REOPEN_FLAG_GAP_SEC) but nothing ever reads  |  | `shared/lib/depeg-resolver/incident-groups.ts:22,` |
| ⬜ | [R-208](redundancy/R-208.md) | S | wrapper | computeChainEnvironmentScore is a thin single-line wrapper that is only used in tests |  | `shared/lib/chains/health.ts:L145-147` |
| ⬜ | [R-209](redundancy/R-209.md) | S | clone | commodity-median reimplements the existing medianOf helper inline |  | `shared/lib/commodity-median.ts:74-82` |
| ⬜ | [R-210](redundancy/R-210.md) | S | dead-code | SELECTOR_YIELD_PEG_CURRENCIES and isSelectorYieldPegCurrency are identical to ELIGIBLE set |  | `shared/lib/selector/types.ts:L32-L53` |
| ⬜ | [R-211](redundancy/R-211.md) | S | wrapper | api-key-format.ts is a three-line file that wraps a one-line Date call |  | `src/lib/api-key-format.ts:1-3` |
| ⬜ | [R-212](redundancy/R-212.md) | S | clone | Divergent deterministic hash algorithms for layout jitter (contagion vs. DEWS radar) |  | `src/lib/contagion-layout.ts:129-135, src/lib/dew` |
| ⬜ | [R-213](redundancy/R-213.md) | S | dead-code | viewRank / rankWithinSet / comparableSetLabel are computed per row but never read in produ |  | `src/lib/yield-view-model.ts:148-150, 750-760` |
| ⬜ | [R-214](redundancy/R-214.md) | S | clone | Duplicated BACKFILL_MIN_CONFIRM_POINTS constant across extraction and replay modules |  | `worker/src/api/backfill-depegs-extraction.ts:14 ` |
| ⬜ | [R-215](redundancy/R-215.md) | S | clone | safeJsonParse re-implemented three times in this slice |  | `worker/src/api/admin-action-log.ts:19-25, worker` |
| ⬜ | [R-216](redundancy/R-216.md) | S | wrapper | worker/src/handlers/http.ts is a pass-through wrapper with no value |  | `worker/src/handlers/http.ts:L1-L10` |
| ⬜ | [R-217](redundancy/R-217.md) | S | clone | FNV-1a stableHash implemented twice in worker with minor divergence |  | `worker/src/cron/sync-redemption-backstops.ts:L54` |
| ⬜ | [R-218](redundancy/R-218.md) | S | wrapper | adaptOpenEdenUsdo is a single-line pass-through that adds no value |  | `worker/src/cron/reserve-adapters/openeden.ts:L16` |
| 🚫 | [R-219](redundancy/R-219.md) | S | clone | mapWithConcurrency is a generic utility defined locally in gho.ts with no reuse |  | `worker/src/cron/reserve-adapters/gho.ts:L177-L19` |
| ⬜ | [R-220](redundancy/R-220.md) | S | clone | hasMultipleStablecoinIds re-iterates all alert lists that getSingleAlertStablecoinId alrea |  | `worker/src/lib/telegram-alerts-formatting.ts:235` |
| ⬜ | [R-221](redundancy/R-221.md) | S | dead-code | feeBps config field on ProtocolParConfig is plumbed everywhere but never set; multiplier m |  | `worker/src/lib/authoritative-price-sources/proto` |
| ⬜ | [R-222](redundancy/R-222.md) | S | clone | safeJsonParse / safeParse re-implemented 5+ times in worker outside the canonical api-cach |  | `worker/src/lib/api-cache-read.ts:41-60 (canonica` |
| ⬜ | [R-223](redundancy/R-223.md) | S | clone | mapWithConcurrency reimplemented 3x in worker with weaker error handling than the canonica |  | `worker/src/lib/concurrency.ts:22-58 (canonical, ` |
| ⬜ | [R-224](redundancy/R-224.md) | S | clone | Array chunk() duplicated within worker (collections.ts vs address-price-providers/shared.t |  | `worker/src/lib/collections.ts:3-17 (chunkArray, ` |
| ⬜ | [R-225](redundancy/R-225.md) | S | clone | EVM normalizeAddress (lowercase + 0x40-hex validate) duplicated byte-for-byte across worke |  | `worker/src/cron/reserve-adapters/reserve-protoco` |
| ⬜ | [R-226](redundancy/R-226.md) | S | dead-code | SAFETY_SCORE_METHODOLOGY_CHANGELOG_NAV_VERSIONS is a one-off export not available to any o |  | `shared/lib/methodology-versions/safety-score.ts:` |
| ⬜ | [R-227](redundancy/R-227.md) | S | clone | buildLiquidityStats and buildLiquidityRows both iterate all 406 ACTIVE_STABLECOINS indepen |  | `src/app/liquidity/model.ts:L37-L130` |
| ⬜ | [R-228](redundancy/R-228.md) | S | clone | GOVERNANCE_COLORS and BACKING_COLORS are derived projections with no call-site advantage o |  | `shared/lib/classification/badges.ts:L54-L61` |
| ⬜ | [R-229](redundancy/R-229.md) | S | clone | mean/median reimplemented locally despite shared/lib/stats.ts exporting identical helpers |  | `shared/lib/depeg-resolver-review/summary.ts:33-4` |
| ⬜ | [R-230](redundancy/R-230.md) | S | clone | Duplicated 14-line admin JOIN SELECT in two functions |  | `worker/src/api/api-key-requests/admin.ts:31-46 (` |
| ⬜ | [R-231](redundancy/R-231.md) | S | dead-code | safeParse helper in snapshot-public-dataset.ts is a private re-implementation |  | `worker/src/cron/snapshot-public-dataset.ts:99-10` |
| ⬜ | [R-232](redundancy/R-232.md) | S | dead-code | rotateArray in mint-burn/run-state.ts is redundant with rotateFromCursor.items |  | `worker/src/cron/mint-burn/run-state.ts:L27-31 + ` |
| ⬜ | [R-233](redundancy/R-233.md) | S | clone | 13-field all-null benchmark registry literal repeated three times |  | `worker/src/cron/yield-sync/sources-riskfree.ts:7` |
| ⬜ | [R-234](redundancy/R-234.md) | S | clone | Repeated new Date(ymd + 'T00:00:00') pattern appears in three separate functions in the sa |  | `src/components/changelog-entry-card.tsx:L25, L60` |
| ⬜ | [R-235](redundancy/R-235.md) | S | wrapper | safety-score-data.ts split adds an extra indirection layer not present in any other method |  | `shared/lib/methodology-versions/safety-score-dat` |
| ⬜ | [R-236](redundancy/R-236.md) | S | dead-code | LATE_MONTHLY const dead export missed by guard |  | `shared/lib/live-reserve-adapters-schemas.ts L688` |
| ⬜ | [R-237](redundancy/R-237.md) | S | clone | riskBudgetTargetFilters is an exact clone of presetFilters, and its comment contradicts it |  | `src/lib/yield-view-model.ts:1123-1125, 1161-1165` |
| ⬜ | [R-238](redundancy/R-238.md) | S | wrapper | raceWithAbortSignal re-implements a pattern already covered by AbortSignal.any + raceWithT |  | `worker/src/cron/sync-live-reserves.ts:68-94` |
| ⬜ | [R-239](redundancy/R-239.md) | S | dead-code | adaptAccountableTypeBreakdown is a thin adapter-internal wrapper only consumed by tests |  | `worker/src/cron/reserve-adapters/accountable.ts:` |
| ⬜ | [R-240](redundancy/R-240.md) | M | clone | Error-to-message extraction implemented ~6 ways plus 61 inline copies in scripts |  | `worker/src/lib/error-utils.ts:1-3 (toErrorMessag` |
| ⬜ | [R-241](redundancy/R-241.md) | S | clone | formatAddress vs shortenAddress: two address-truncation helpers with different slice width |  | `shared/lib/format.ts:130-133 (formatAddress, 6/-` |
| ⬜ | [R-242](redundancy/R-242.md) | S | clone | VirtualTableFrame duplicates the aria-label / caption-detection logic already in TableFram |  | `src/components/table/virtual-table-frame.tsx:L70` |
| ⬜ | [R-243](redundancy/R-243.md) | S | dead-code | summary.thresholdPct fallback to STATUS_COINGECKO_PRICE_DIFF_THRESHOLD_PCT is unreachable |  | `src/components/status/coingecko-price-diff.tsx:L` |
| ⬜ | [R-244](redundancy/R-244.md) | S | clone | readAdminStringParam duplicates readBodyOrQueryStringParam with one minor behavioral diffe |  | `worker/src/lib/admin-job.ts:54-63, worker/src/li` |
| ⬜ | [R-245](redundancy/R-245.md) | M | clone | filterCollidingInflections duplicates the logic of buildVisiblePsiChartEvents |  | `src/components/cemetery-charts.tsx:L373-L399 + s` |
| 🚫 | [R-246](redundancy/R-246.md) | S | wrapper | buildCommandPaletteActionDefinitions is called both directly and indirectly within buildCo |  | `src/components/command-palette-model.ts:L391-L45` |
| ⬜ | [R-247](redundancy/R-247.md) | S | wrapper | cli.mjs is a thin relay that duplicates smoke-runtime.mjs exports without consolidating ca |  | `scripts/lib/cli.mjs:L1-L27` |
| ⬜ | [R-248](redundancy/R-248.md) | S | clone | median clone stats vs peg-utils |  | `shared/lib/stats.ts L18-L24 and shared/lib/peg-u` |
| ⬜ | [R-249](redundancy/R-249.md) | S | wrapper | DDRR_HORIZON_SECONDS is an exported re-alias of HORIZON_SECONDS with a single same-file co |  | `shared/lib/depeg-resolver-review/review.ts:23-25` |
| ⬜ | [R-250](redundancy/R-250.md) | S | config | ADDRESS_OVERRIDES in phase-helpers partially duplicates registry contract data |  | `worker/src/cron/sync-stablecoins/phase-helpers.t` |
| ⬜ | [R-251](redundancy/R-251.md) | M | clone | withOpsHtmlCsp / addCspHeaders duplicate the HTML-CSP rewrite logic across two handlers |  | `functions/lib/ops-asset-host-gate.ts:17-40 vs fu` |
| 🚫 | [R-252](redundancy/R-252.md) | S | dead-code | freezewatch/view-model.ts exposes pageSize as a constant alias that adds no value |  | `src/app/freezewatch/view-model.ts:L126` |
| ⬜ | [R-253](redundancy/R-253.md) | S | clone | commonSourceConfig spread duplicated across two createRequestSourceRecorder call sites in  |  | `worker/src/handlers/http/request-dispatch.ts:L50` |
| ⬜ | [R-254](redundancy/R-254.md) | S | clone | Version-stamp spread duplicated across seal/meta/store builders |  | `worker/src/cron/depeg-resolver/public-projection` |
| ⬜ | [R-255](redundancy/R-255.md) | S | clone | RPC-URL ordering helpers duplicated three times with subtly different ordering |  | `worker/src/cron/yield-coverage-audit-quarantine.` |
| ⬜ | [R-256](redundancy/R-256.md) | S | wrapper | rankings.ts parseWarningSignals is a pure re-export adding only an indirection |  | `worker/src/cron/yield-sync/rankings.ts:9-10` |
| ⬜ | [R-257](redundancy/R-257.md) | M | clone | buildYieldHistoryEvaluationInputs duplicates its cooperative variant's per-row classificat |  | `worker/src/cron/yield-sync/coordinator-history.t` |
| ⬜ | [R-258](redundancy/R-258.md) | S | clone | CASE_STUDY_ORDER is a redundant derived array alongside CASE_STUDIES (an object) and CASE_ |  | `src/app/learn/case-studies/content/index.ts:L58-` |
| 🚫 | [R-259](redundancy/R-259.md) | S | dead-code | feed/digest.xml/route.ts is a thin one-liner re-export that adds no value |  | `src/app/feed/digest.xml/route.ts:L1-L5` |
| ⬜ | [R-260](redundancy/R-260.md) | S | clone | reviewDepegResolverAssessments largely duplicates reviewDdrrV2Rows' assessment path |  | `shared/lib/depeg-resolver-review/index.ts:17-47 ` |
| ⬜ | [R-261](redundancy/R-261.md) | S | dead-code | Per-provider attemptedTargets/matchedTargets are computed in every provider but never cons |  | `worker/src/lib/address-price-providers/types.ts:` |
| 🚫 | [R-262](redundancy/R-262.md) | S | wrapper | Structural-clone OpsHostGateShell invocations across admin and admin-api clients |  | `src/app/admin/client.tsx:6-37; src/app/admin-api` |
| 🚫 | [R-263](redundancy/R-263.md) | S | dead-code | buildEmptyDdrrSummary is a single-use re-export wrapper |  | `worker/src/cron/compute-depeg-resolver-review.ts` |
| ⬜ | [R-264](redundancy/R-264.md) | S | wrapper | computeApyFromPrice is a zero-value pass-through alias of computeApyFromRate |  | `worker/src/cron/yield-helpers.ts:88-97` |
| ⬜ | [R-265](redundancy/R-265.md) | S | dead-code | Birdeye Solana filter is redundant with the chain guard already applied at target-build ti |  | `worker/src/lib/address-price-providers/birdeye.t` |
| ⬜ | [R-266](redundancy/R-266.md) | M | clone | formatApiKeyRequestRelativeTime reimplements relative-time formatting that shared/lib/rela |  | `src/lib/api-key-request-admin-view-model.ts:66-8` |

## quality (315)

### High (6)

| | ID | E | Category | Title | Owner | Loc |
|---|---|---|---|---|---|---|
| ✅ | [Q-001](quality/Q-001.md) | M | complexity | Sequential per-market RPC loops in crvusd make N round-trips per LLAMMA market with no par | codex | `worker/src/cron/reserve-adapters/crvusd.ts:L314-` |
| ✅ | [Q-002](quality/Q-002.md) | M | complexity | dispatchTelegramAlerts is a 590-line monolith with three distinct control paths | codex | `worker/src/cron/dispatch-telegram-alerts.ts:L167` |
| ✅ | [Q-003](quality/Q-003.md) | S | dead-code | Slipstream pools hardcode volume24hUsd=0, triggering silent large-pool filter exclusion | codex | `worker/src/cron/dex-liquidity/fetch-slipstream.t` |
| ✅ | [Q-004](quality/Q-004.md) | S | type-safety | usdgo-osl rate-derived config uses benchmarkCurrency instead of benchmarkOverrideKey, spli | codex | `worker/src/cron/yield-config-rate-sources.ts:221` |
| ✅ | [Q-078](quality/Q-078.md) | S | type-safety | reserve-protocol-dtf compares fetchOnchainUint256 bigint result to 0n to detect non-SOUND  | codex | `worker/src/cron/reserve-adapters/reserve-protoco` |
| ✅ | [Q-082](quality/Q-082.md) | S | security | LIKE wildcard injection in tape-event full-text search (q parameter) | codex | `worker/src/lib/tape-event-store.ts:142-145, work` |

### Medium (110)

| | ID | E | Category | Title | Owner | Loc |
|---|---|---|---|---|---|---|
| ✅ | [Q-007](quality/Q-007.md) | S | security | gitSubcommandTokens bypass: multiple -C flags or git global options defeat agent hook guar | codex | `scripts/ci/pharos-change-contract.mjs:L669-L681` |
| ✅ | [Q-010](quality/Q-010.md) | M | dead-code | WeakMap override-reason metadata is inaccessible on the merged top-level registry | codex | `shared/lib/redemption-backstop-configs/factory.t` |
| ✅ | [Q-011](quality/Q-011.md) | S | error-handling | sky-makercore.ts silently discards ALL errors from the LitePSM on-chain read | codex | `worker/src/cron/reserve-adapters/sky-makercore.t` |
| ✅ | [Q-012](quality/Q-012.md) | S | error-handling | Bare catch in loadPriceValidationReferences silently swallows DB errors and masks degradat | codex | `worker/src/lib/price-validation.ts:L191-L197` |
| ⬜ | [Q-013](quality/Q-013.md) | S | complexity | resupply-pairs serialises all pair I/O in a sequential loop, multiplying latency with pair |  | `worker/src/cron/reserve-adapters/resupply-pairs.` |
| ✅ | [Q-014](quality/Q-014.md) | S | error-handling | Silent `catch {}` swallows selector engine errors in use-selector.ts | codex | `src/app/screener/picker/use-selector.ts:L163-L16` |
| ⬜ | [Q-015](quality/Q-015.md) | M | error-handling | ChartBrush declares role='slider' but implements no keyboard interaction — ARIA contract v |  | `src/components/chart-primitives/sync.tsx:L110-L2` |
| ⬜ | [Q-016](quality/Q-016.md) | M | security | window.confirm and window.prompt used for destructive admin mutation confirmations |  | `src/components/status/api-key-requests-panel.tsx` |
| ⬜ | [Q-019](quality/Q-019.md) | S | clone | Peg-floor thresholds duplicated verbatim in answers-to-screener instead of calling exclusi |  | `shared/lib/selector/answers-to-screener.ts:L84-L` |
| ⬜ | [Q-022](quality/Q-022.md) | S | error-handling | Silent broad catch on stress_signals_latest hides D1 transient errors from observability |  | `worker/src/cron/dews/source-state/hydration.ts:L` |
| ✅ | [Q-023](quality/Q-023.md) | S | testing | depeg-incident-utils.ts has no tests despite being the sole parser for pending-depeg UI da | codex | `src/lib/depeg-incident-utils.ts:L57-L80` |
| ✅ | [Q-024](quality/Q-024.md) | S | type-safety | buildResultSummaryCoordinationProps erases all prop types via Record<string, unknown> | codex | `src/app/screener/picker/handoff.ts:L128` |
| ✅ | [Q-026](quality/Q-026.md) | S | error-handling | project-tape.ts silently returns ok status when tape projectors throw | codex | `worker/src/cron/project-tape.ts:106-125` |
| ⬜ | [Q-028](quality/Q-028.md) | S | type-safety | Mini-app error retry passes potentially-null initData directly to loadSession |  | `src/app/pharoswatchbot/app/client.tsx:L344` |
| ⬜ | [Q-031](quality/Q-031.md) | M | type-safety | DigestSnapshotInputDataSchema casts z.object({}).passthrough() to DigestInputData — snapsh |  | `shared/types/digest.ts:L428-L432` |
| ⬜ | [Q-036](quality/Q-036.md) | M | error-handling | fetchCurrentBalanceForAddress (current-balance-cache) never uses drpcApiKey despite it bei |  | `worker/src/cron/blacklist/current-balance-cache.` |
| 🔄 | [Q-039](quality/Q-039.md) | S | error-handling | admin-action-audit.ts truncates serialized JSON at a byte boundary, producing invalid JSON | codex | `worker/src/lib/admin-action-audit.ts:L22-L23` |
| ✅ | [Q-040](quality/Q-040.md) | S | error-handling | mapWithConcurrency early-abort skips when task rejects with a falsy value | codex | `worker/src/lib/concurrency.ts:37-43` |
| ⬜ | [Q-041](quality/Q-041.md) | M | clone | Alert-safety explain snapshot re-derives stage scores from rounded baseScore, diverging fr |  | `worker/src/lib/alert-safety-source-cache.ts:L470` |
| ⬜ | [Q-043](quality/Q-043.md) | S | testing | safety-score-golden test is outside the critical test suite; methodology regressions caugh |  | `worker/src/lib/__tests__/safety-score-golden.tes` |
| ⬜ | [Q-044](quality/Q-044.md) | M | naming | governance kind overloaded as catch-all for semantically distinct exploit events |  | `shared/data/annotations/curated-annotations.ts:L` |
| ⬜ | [Q-045](quality/Q-045.md) | M | dead-code | ESLint /api/ path enforcement rule does not catch TemplateLiteral constructions — multiple |  | `eslint.config.mjs:147-155` |
| ⬜ | [Q-047](quality/Q-047.md) | M | type-safety | Unvalidated `as SelectorOutput` cast on snapshot network response |  | `src/app/screener/picker/use-selector.ts:L54` |
| ⬜ | [Q-051](quality/Q-051.md) | S | error-handling | aria-selected misused as keyboard-focus indicator in CoinSelector listbox |  | `src/components/coin-selector.tsx:L205-L207` |
| ⬜ | [Q-056](quality/Q-056.md) | S | type-safety | Non-null assertion on TELEGRAM_BOT_TOKEN inside closure built before the guard |  | `worker/src/handlers/scheduled/five-minute-telegr` |
| ⬜ | [Q-057](quality/Q-057.md) | S | error-handling | unsubscribeAll does not reset alert_snooze_until_ts, leaving chat silenced after unsubscri |  | `worker/src/api/telegram-store/forget.ts:L9-L31` |
| ⬜ | [Q-058](quality/Q-058.md) | S | error-handling | inferErrorClass misclassifies errors whose message contains the substring 'http' |  | `worker/src/cron/blacklist/amount-recovery.ts:L87` |
| ⬜ | [Q-059](quality/Q-059.md) | S | error-handling | recordDirectApiOutcome records the circuit outcome twice on telemetry read failure |  | `worker/src/cron/dex-liquidity/orchestrator-phase` |
| ⬜ | [Q-061](quality/Q-061.md) | S | error-handling | Single try/catch across all three CEX venue fetches silently skips venues after the first  |  | `worker/src/lib/cex-orderbooks.ts:L218-L228` |
| ⬜ | [Q-062](quality/Q-062.md) | M | testing | api-pagination cursor-helper internals have no unit tests; multi-column disjunction untest |  | `worker/src/lib/api-pagination.ts:L1-L320 (49.6% ` |
| ⬜ | [Q-063](quality/Q-063.md) | M | testing | reserve-presentation.ts (265 lines) has no tests; incorrect notice tone for stale/failed r |  | `src/components/stablecoin-detail/reserve-present` |
| ⬜ | [Q-064](quality/Q-064.md) | S | type-safety | MethodologySectionShell silently drops the version badge when only one of two coupled opti |  | `src/app/methodology/methodology-shared.tsx:60,63` |
| ⬜ | [Q-065](quality/Q-065.md) | S | error-handling | ContentTable column/row mismatch validation is dev-only, silent in production builds |  | `src/components/table/content-table.tsx:L150-L153` |
| ⬜ | [Q-066](quality/Q-066.md) | S | error-handling | role="alert" inside aria-live="polite" container creates conflicting live-region semantics |  | `src/components/toast-container.tsx:L39, L69-L70` |
| ⬜ | [Q-067](quality/Q-067.md) | S | type-safety | BADGE_PILL_BASE string concatenated with Tailwind class strings bypasses purge safety |  | `src/components/key-info-card.tsx:L43, L253, L273` |
| ⬜ | [Q-068](quality/Q-068.md) | S | type-safety | SVG clipPath IDs in yield-scatter-plot are not globally unique when multiple chart instanc |  | `src/components/yield-scatter-plot.tsx:L139-L171` |
| 🚫 | [Q-071](quality/Q-071.md) | M | error-handling | build-og-learn-images.mjs generates SVGs but never converts them to PNGs — the check:og-le |  | `scripts/maintenance/build-og-learn-images.mjs:L1` |
| ⬜ | [Q-072](quality/Q-072.md) | M | clone | Hardcoded 4% APY benchmark in yield-source diverges from per-coin benchmarkRate used by th |  | `shared/lib/selector/yield-source.ts:L75; shared/` |
| ⬜ | [Q-073](quality/Q-073.md) | S | complexity | coverage-matrix-model.ts: three separate O(n log n) sorts over featureSummaries to extract |  | `src/lib/coverage-matrix-model.ts:185-202` |
| ⬜ | [Q-074](quality/Q-074.md) | S | error-handling | backfillTronFromLedger returns {updated: 0} mid-loop when budget is reached, discarding al |  | `worker/src/cron/blacklist/amount-recovery.ts:L71` |
| ⬜ | [Q-075](quality/Q-075.md) | S | type-safety | Unsafe Number(bigint) fallback for token balances loses precision on large reserves |  | `worker/src/cron/dex-liquidity/fetch-fluid.ts:L13` |
| ⬜ | [Q-076](quality/Q-076.md) | M | complexity | supply7dOutcome evaluates wrong coin when symbol ranking changes day-over-day |  | `worker/src/cron/daily-digest/digest-next-trigger` |
| ⬜ | [Q-079](quality/Q-079.md) | M | type-safety | isFallbackCronResult discriminates on 'metadata' in result — fragile structural guard |  | `worker/src/cron/sync-stablecoins/fallback.ts:22-` |
| ⬜ | [Q-080](quality/Q-080.md) | S | type-safety | Eventless fast-path result built via Object.assign with an unsafe cast |  | `worker/src/cron/dispatch-telegram-alerts.ts:L374` |
| ⬜ | [Q-081](quality/Q-081.md) | S | type-safety | Four independent nowSec timestamps computed within a single fan-out Promise.all |  | `worker/src/cron/dispatch-telegram-subscribers.ts` |
| ⬜ | [Q-083](quality/Q-083.md) | M | testing | depeg-resolver resolution.ts — K2/R1/R2 kill and anchor factor codes never directly assert |  | `shared/lib/depeg-resolver/resolution.ts:L67-L130` |
| ⬜ | [Q-086](quality/Q-086.md) | M | type-safety | Redemption backstop toEntry throws on schema parse failure, causing full snapshot load to  |  | `worker/src/lib/redemption-backstops-store.ts:L27` |
| ⬜ | [Q-088](quality/Q-088.md) | S | error-handling | `CaseStudyChart` passes an empty array to `PegDeviationChart` during loading, rendering an |  | `src/app/learn/case-studies/case-study-chart.tsx:` |
| ⬜ | [Q-090](quality/Q-090.md) | S | error-handling | Response bodies not consumed on early-exit paths in checkSitemapUrls (check-seo-live-smoke |  | `scripts/ci/check-seo-live-smoke.mjs:L125-L148` |
| ⬜ | [Q-093](quality/Q-093.md) | S | error-handling | yield-history-chart-model onSourceChange is a noop when externalSourceKey is set, silently |  | `src/components/yield-history-chart-model.ts:L373` |
| ✅ | [Q-094](quality/Q-094.md) | S | error-handling | yield-venue-risk-calibration.ts reads .env.local by splitting on '=' which breaks values c | codex | `scripts/maintenance/yield-venue-risk-calibration` |
| ⬜ | [Q-095](quality/Q-095.md) | S | error-handling | filterAgainstExisting in build-annotation-candidates uses fragile substring matching that  |  | `scripts/maintenance/build-annotation-candidates.` |
| ⬜ | [Q-096](quality/Q-096.md) | S | type-safety | isActiveStablecoinMeta silently treats undefined status as active |  | `shared/lib/stablecoins/status.ts:L3-L5` |
| ⬜ | [Q-097](quality/Q-097.md) | M | complexity | runSimulation O(n²) post-simulation collision pass runs synchronously on the main thread w |  | `src/lib/contagion-layout.ts:493-543` |
| ⬜ | [Q-098](quality/Q-098.md) | S | error-handling | backfill-cg-prices has no per-coin error isolation; one bad response aborts the whole batc |  | `worker/src/api/backfill-cg-prices.ts:53-176` |
| ⬜ | [Q-100](quality/Q-100.md) | M | complexity | Mutable closure variable nextReplyMarkup in makeActionRunner creates ordering-sensitive im |  | `worker/src/api/webhook-commands/action-runner.ts` |
| ⬜ | [Q-102](quality/Q-102.md) | M | error-handling | Telegram double-send risk when cache write fails after successful delivery |  | `worker/src/cron/daily-digest.ts:L284-L301` |
| ⬜ | [Q-103](quality/Q-103.md) | M | error-handling | resolveRunStatus maps all-circuit-breaker-skipped runs to 'error', masking healthy circuit |  | `worker/src/cron/sync-live-reserves-finalize.ts:1` |
| ⬜ | [Q-104](quality/Q-104.md) | M | complexity | Serial per-observation D1 reads in loadAlertMarkers and loadDetailWriteFailures |  | `worker/src/cron/cron-staleness-watchdog.ts:198-2` |
| ⬜ | [Q-105](quality/Q-105.md) | S | type-safety | cap-vault silently prices all unknown assets at $1.00 regardless of underlying token |  | `worker/src/cron/reserve-adapters/cap-vault.ts:L8` |
| ⬜ | [Q-108](quality/Q-108.md) | S | clone | 'legacy-best' source-key magic string duplicated ~10x while a named constant exists |  | `worker/src/cron/yield-sync/evaluation.ts:311,515` |
| ⬜ | [Q-110](quality/Q-110.md) | S | type-safety | buildChainRpcs uses non-null assertion on Tron public RPC in the no-Alchemy branch |  | `worker/src/lib/chain-registry.ts:L114` |
| ⬜ | [Q-111](quality/Q-111.md) | S | error-handling | getMintBurnReconciliation parallel DB queries are unguarded — any query failure bubbles as |  | `worker/src/lib/status/derived-data.ts:L208-L229` |
| ⬜ | [Q-112](quality/Q-112.md) | M | complexity | DEWS projector scans and classifies all band-change samples for both variants independentl |  | `worker/src/lib/tape-projectors/dews.ts:L198-L240` |
| ⬜ | [Q-113](quality/Q-113.md) | M | complexity | FlowsClient unconditionally issues three concurrent API calls, one always redundant |  | `src/app/flows/client.tsx:L56-L78` |
| ⬜ | [Q-119](quality/Q-119.md) | S | type-safety | Module-scoped mutable singleton searchTimer leaks across client navigations |  | `src/lib/analytics.ts:L58-L66` |
| ⬜ | [Q-121](quality/Q-121.md) | M | type-safety | SETUP_PENDING_ACTION_TYPE excluded from PendingActionType union, breaking exhaustive dispa |  | `worker/src/api/telegram-webhook-shared.ts:L143 +` |
| ⬜ | [Q-125](quality/Q-125.md) | M | type-safety | isAbortResult type guard uses structural exclusions that are brittle under future type ext |  | `worker/src/cron/sync-stablecoins/post-enrichment` |
| ⬜ | [Q-126](quality/Q-126.md) | M | error-handling | linkSealedNearbyIncidentTail performs 4+ non-atomic sequential D1 writes with no compensat |  | `worker/src/lib/depeg-resolver-incident-store.ts:` |
| ⬜ | [Q-127](quality/Q-127.md) | M | error-handling | safeErrorMessage is nearly unused — raw toErrorMessage leaks into logs throughout the work |  | `worker/src/lib/safe-error-message.ts:L1-L30` |
| ⬜ | [Q-128](quality/Q-128.md) | M | type-safety | computePriceSignal returns available:true with value 100 when price is null — breaks evide |  | `worker/src/lib/dews/signal-families.ts:L226-L228` |
| ⬜ | [Q-131](quality/Q-131.md) | S | error-handling | apiFetchWithMeta silently retries schema validation on the unstripped JSON body |  | `src/lib/api.ts:334-341` |
| ⬜ | [Q-133](quality/Q-133.md) | M | testing | Production routes the *Trusted backfill/remediate handlers; the auth-wrapped public varian |  | `worker/src/api/backfill-cg-prices.ts:196-211, wo` |
| ⬜ | [Q-135](quality/Q-135.md) | M | error-handling | Broad silent catch in telegram-usage-analytics swallows all errors from non-telemetry path |  | `worker/src/lib/telegram-usage-analytics.ts:L264-` |
| ⬜ | [Q-136](quality/Q-136.md) | M | error-handling | healNullPrices silently skips historical events (>48h old) with no alerting or escalation  |  | `worker/src/lib/mint-burn-pipeline/price-heal.ts:` |
| ⬜ | [Q-137](quality/Q-137.md) | S | error-handling | yield/client.tsx shows a SectionErrorBoundary-wrapped QueryErrorNotice at L183 for the no- |  | `src/app/yield/client.tsx:L171-L207` |
| ⬜ | [Q-139](quality/Q-139.md) | L | type-safety | DdrCompatRow compat shim: 12+ unsafe `row as DdrCompatRow` casts instead of a proper union |  | `src/components/depeg-resolver-row-card-model.ts:` |
| ⬜ | [Q-140](quality/Q-140.md) | S | error-handling | resolveOutlook uses a narrow, divergent terminal-status definition vs the canonical helper |  | `shared/lib/depeg-resolver/resolution.ts:168-204 ` |
| ⬜ | [Q-142](quality/Q-142.md) | M | type-safety | stablecoin-detail-mint-authority-client.ts: multiple unsafe casts of string values to narr |  | `src/lib/stablecoin-detail-mint-authority-client.` |
| 🚫 | [Q-143](quality/Q-143.md) | S | naming | use-stress-test-model.ts lacks "use client" but exports React-hook-adjacent code with modu |  | `src/hooks/use-stress-test-model.ts:L1, L35-L39` |
| ⬜ | [Q-144](quality/Q-144.md) | M | error-handling | Admin reject mutation is non-atomic: key can be deactivated while request stays pending/is |  | `worker/src/api/api-key-requests/admin-handlers.t` |
| ⬜ | [Q-145](quality/Q-145.md) | S | error-handling | SSE data: line concatenation omits the newline separator required by the spec |  | `worker/src/cron/digest/anthropic-stream.ts:L111-` |
| ⬜ | [Q-146](quality/Q-146.md) | M | testing | Identity disambiguation resolver (a financial-signal correctness path) has no unit tests |  | `worker/src/cron/yield-sync/identity.ts:81-148` |
| ⬜ | [Q-147](quality/Q-147.md) | S | complexity | derivePoolVolume24hUsd averages USD estimates instead of summing, producing incorrect mult |  | `worker/src/lib/dex-api-token-pricing.ts:L99-L144` |
| ⬜ | [Q-148](quality/Q-148.md) | S | clone | Local median() diverges from canonical stats.median for even-length inputs, biasing aggreg |  | `worker/src/lib/address-price-providers/shared.ts` |
| ⬜ | [Q-149](quality/Q-149.md) | S | error-handling | isMissingColumnError schema shim is still live in depeg.ts after methodology_version migra |  | `worker/src/lib/tape-projectors/depeg.ts:L75-L85,` |
| ⬜ | [Q-150](quality/Q-150.md) | M | testing | Deterministic on-chain health/cooldown state machine is untested |  | `worker/src/cron/yield-sync/state-loading.ts:181-` |
| ⬜ | [Q-152](quality/Q-152.md) | S | complexity | remediate-blacklist-amount-gaps parses limit/maxAttempts twice with inconsistent validatio |  | `worker/src/api/remediate-blacklist-amount-gaps.t` |
| ⬜ | [Q-153](quality/Q-153.md) | M | error-handling | checkCachedPublicApiReadFastRateLimit always uses isolate-local limiter even when circuit  |  | `worker/src/handlers/http/gates.ts:L295-L300` |
| ⬜ | [Q-154](quality/Q-154.md) | L | complexity | evaluateYieldSourceGroup is a ~320-line monolith mixing stats, safety, risk, scoring, and  |  | `worker/src/cron/yield-sync/evaluation.ts:217-541` |
| 🚫 | [Q-155](quality/Q-155.md) | M | testing | Securitize Seize event (BUIDL on 6 chains) has no test coverage; amountDataIndex:0 is unve |  | `worker/src/lib/blacklist-contracts.ts:L517-L534,` |
| ⬜ | [Q-156](quality/Q-156.md) | M | complexity | StatusDashboard is a god-orchestrator doing unmemoized cron sorting in the render body |  | `src/app/admin/status-dashboard.tsx:24-180` |
| ⬜ | [Q-157](quality/Q-157.md) | M | complexity | buildStablecoinDetailHeroViewModel is a ~205-line monolith assembling 8 unrelated sub-stru |  | `src/lib/stablecoin-detail-view-model.ts:546-751` |
| ⬜ | [Q-158](quality/Q-158.md) | M | complexity | buildBlacklistSummaryPayload is a ~250-line god function with triple-branched currentBalan |  | `worker/src/api/blacklist-summary.ts:473-727` |
| ⬜ | [Q-159](quality/Q-159.md) | L | complexity | audit-depeg-history is a ~1145-line god module mixing parsing, 3 repair engines, CG I/O, a |  | `worker/src/api/audit-depeg-history.ts:1-1145` |
| ⬜ | [Q-160](quality/Q-160.md) | S | error-handling | Bare catch in tape-evidence loader masks all D1 read failures |  | `worker/src/cron/compute-depeg-resolver-review.ts` |
| ⬜ | [Q-161](quality/Q-161.md) | M | complexity | appendPoolFamilyYieldSources is a 165-line god-function blending three discovery strategie |  | `worker/src/cron/yield-sync/resolve-helpers.ts:35` |
| ⬜ | [Q-162](quality/Q-162.md) | L | complexity | runYieldCoverageAudit is a ~190-line orchestration monolith mixing IO, derivation, and two |  | `worker/src/cron/yield-coverage-audit.ts:809-1001` |
| ⬜ | [Q-163](quality/Q-163.md) | S | testing | Branchy pure-logic units have no direct unit tests |  | `src/app/admin/cron-severity.ts:7-12; src/app/adm` |
| ⬜ | [Q-164](quality/Q-164.md) | M | type-safety | Mint-authority view model reads an untyped UnknownRecord candidate via stringValue/numberV |  | `src/lib/stablecoin-detail-mint-authority-view-mo` |
| ⬜ | [Q-165](quality/Q-165.md) | M | type-safety | selectDigestIntelligence trusts unvalidated runtime shapes with bare casts after only Arra |  | `worker/src/api/digest-intelligence-summary.ts:26` |
| ⬜ | [Q-166](quality/Q-166.md) | S | naming | getContractConfig silently hardcodes USDC as the redeem quote token, an undocumented denom |  | `worker/src/lib/authoritative-price-sources/helpe` |
| ⬜ | [Q-167](quality/Q-167.md) | M | security | Site-data Pages cache key ignores Vary/CORS dimensions, allowing cross-origin ACAO bleed |  | `functions/_site-data/[[path]].ts:57-59,159-166,1` |
| ⬜ | [Q-168](quality/Q-168.md) | M | complexity | summarizeDdrrMetrics is a 140-line monolith deriving ~50 interdependent counts/ratios in o |  | `shared/lib/depeg-resolver-review/summary.ts:109-` |
| ⬜ | [Q-169](quality/Q-169.md) | M | error-handling | materializeTerminalEvidenceForEvent silently nulls valid terminal evidence |  | `worker/src/cron/compute-depeg-resolver-review.ts` |
| ⬜ | [Q-170](quality/Q-170.md) | M | complexity | DecisionContext god-object plus monolithic deriveDecisionContext |  | `worker/src/cron/depeg-detection/decision-engine.` |
| ⬜ | [Q-171](quality/Q-171.md) | M | type-safety | Optional-protocol JSON responses cast directly to typed shapes with no shape validation |  | `worker/src/cron/yield-sync/sources-optional-prot` |
| ⬜ | [Q-172](quality/Q-172.md) | M | complexity | buildYieldSyncMetadata takes a ~55-field flat parameter object (long-param-list / primitiv |  | `worker/src/cron/yield-sync/coordinator-metadata.` |
| ⬜ | [Q-173](quality/Q-173.md) | M | error-handling | audit CG fetch swallows individual-event errors as 'error' verdicts, so a global CG outage |  | `worker/src/api/audit-depeg-history.ts:1029-1125` |
| ⬜ | [Q-174](quality/Q-174.md) | M | complexity | computeStressedGrades drops cycle members |  | `shared/lib/report-card-overall.ts L133-L154` |

### Low (199)

| | ID | E | Category | Title | Owner | Loc |
|---|---|---|---|---|---|---|
| ✅ | [Q-005](quality/Q-005.md) | S | complexity | buildCompositionLayout contains unreachable guard conditions | codex | `src/app/chains/[chain]/view-model.ts:17-29` |
| ✅ | [Q-006](quality/Q-006.md) | S | dead-code | Dead null-coalescence in yield-source risk scoring (sourceRiskInverted always returns numb | codex | `shared/lib/selector/yield-source.ts:L70-L71` |
| ✅ | [Q-008](quality/Q-008.md) | S | type-safety | aria-label and aria-labelledby both set on the same Link in selector-shortlist-card — ARIA | codex | `src/components/selector/selector-shortlist-card.` |
| ✅ | [Q-009](quality/Q-009.md) | S | complexity | serve-static-export.mjs introduces a redundant alias that adds a full module-level promise | codex | `scripts/maintenance/serve-static-export.mjs:L119` |
| ✅ | [Q-017](quality/Q-017.md) | S | error-handling | exploit-notice-banner URL parser drops all but the first URL and silently discards text be | codex | `src/components/exploit-notice-banner.tsx:L11-L35` |
| ✅ | [Q-018](quality/Q-018.md) | S | error-handling | fetch-logos.ts defers Node.js built-in imports (fs, path, url) to inside an async function | codex | `scripts/maintenance/fetch-logos.ts:90-96` |
| ✅ | [Q-020](quality/Q-020.md) | S | complexity | runFourHourlyReserveSyncSlot shadows outer `summary` variable inside a try block | codex | `worker/src/handlers/scheduled/hourly-live-reserv` |
| ✅ | [Q-021](quality/Q-021.md) | S | naming | persistLiveReserveCursorState misleadingly names a cleanup-only deletion function | codex | `worker/src/cron/sync-live-reserves-run-state.ts:` |
| ✅ | [Q-025](quality/Q-025.md) | S | type-safety | isSupplyBackfillAction hardcodes the path string instead of using the shared key | codex | `src/components/status/admin-action-button.tsx:L3` |
| ⬜ | [Q-027](quality/Q-027.md) | S | testing | homepage-bootstrap-runtime.ts has zero test coverage for its custom ApiMeta parsing logic |  | `src/lib/homepage-bootstrap-runtime.ts:51-93` |
| ⬜ | [Q-029](quality/Q-029.md) | M | complexity | IIFE inside JSX render obscures dominance-breakdown logic in chains/client.tsx |  | `src/app/chains/client.tsx:L292-L385` |
| ⬜ | [Q-030](quality/Q-030.md) | S | type-safety | psiBand is cast to ConditionBand without membership guard in digest-archive-client |  | `src/components/digest-archive-client.tsx:296, 31` |
| ✅ | [Q-032](quality/Q-032.md) | S | error-handling | chart-export.ts silently swallows errors; caller has no way to surface failure to the user | codex | `src/lib/chart-export.ts:15-17` |
| ⬜ | [Q-033](quality/Q-033.md) | S | type-safety | normalizeDependencyMeta in homepage-bootstrap-runtime.ts uses as never cast to work around |  | `src/lib/homepage-bootstrap-runtime.ts:51-75` |
| ✅ | [Q-034](quality/Q-034.md) | S | type-safety | useHomeAltFilters passes the clear-sentinel "all" through setParams, causing a no-op URL w | codex | `src/hooks/use-home-alt-filters.ts:L36-L38` |
| ⬜ | [Q-035](quality/Q-035.md) | S | complexity | setup.ts callback issues a raw D1 query for telegram_pending_disambiguation instead of usi |  | `worker/src/api/webhook-callbacks/setup.ts:L51-L6` |
| ⬜ | [Q-037](quality/Q-037.md) | S | error-handling | Wrong bootstrap-source key passed to resolveBootstrapAllowed for yield-rankings loader |  | `worker/src/cron/dews/source-state/hydration.ts:L` |
| ⬜ | [Q-038](quality/Q-038.md) | S | error-handling | loadDewsRows always issues two DB queries; legacy table queried even when latest is comple |  | `worker/src/cron/dispatch-telegram-state.ts:L70-L` |
| ⬜ | [Q-042](quality/Q-042.md) | S | dead-code | DewsInsufficientEvidenceReason variant 'total_weight_below_minimum' is declared but never  |  | `worker/src/lib/dews/types.ts:L107-L111, worker/s` |
| ⬜ | [Q-046](quality/Q-046.md) | S | error-handling | External links rendered via ReactMarkdown in the docs page lack rel="noopener noreferrer" |  | `src/app/docs/[slug]/page.tsx:L82-L97` |
| ⬜ | [Q-048](quality/Q-048.md) | S | complexity | Module-scope `readFileSync` at import time in depeg page-data.ts |  | `src/app/depeg/[event]/page-data.ts:L20-L25` |
| ⬜ | [Q-049](quality/Q-049.md) | M | complexity | getActionGroup groups admin actions by path string matching — fragile coupling to URL stru |  | `src/components/status/admin-actions-panel.tsx:L1` |
| ⬜ | [Q-050](quality/Q-050.md) | S | complexity | useDesktopViewport in desktop-sidebar.tsx uses a state+effect pattern that can produce an  |  | `src/components/desktop-sidebar.tsx:10-22` |
| ⬜ | [Q-052](quality/Q-052.md) | S | error-handling | pageUrl captured outside useCallback causes stale-closure risk and misleading deps |  | `src/components/feedback-modal.tsx:L78-L120` |
| ✅ | [Q-053](quality/Q-053.md) | S | error-handling | parsePositiveInteger accepts 0, causing silent wrong behavior for --top and --min-impressi | codex | `scripts/maintenance/analyze-gsc-performance.mjs:` |
| 🔄 | [Q-054](quality/Q-054.md) | S | dead-code | V3997_PROFILE and V4_PROFILE in score-diff script are structurally identical objects — dif | codex | `scripts/maintenance/audit-redemption-v4-score-di` |
| ⬜ | [Q-055](quality/Q-055.md) | S | complexity | getCoinsByLifecycleStatus rebuilds a full Map on every call; called in a hot build-time lo |  | `shared/lib/stablecoins/by-mechanism.ts:L74-L91` |
| ⬜ | [Q-060](quality/Q-060.md) | S | complexity | price-consensus medianPrice uses floor-index, systematically biasing high for even-sized c |  | `worker/src/lib/price-consensus.ts:L248-L251` |
| ⬜ | [Q-069](quality/Q-069.md) | M | complexity | `validateRedemptionBackstopRegistry` is a 1117-line god function with nested function decl |  | `scripts/lib/redemption-backstop-validation.ts:L1` |
| ⬜ | [Q-070](quality/Q-070.md) | S | error-handling | audit-seo-render-budget.mjs silently swallows all per-response accounting errors in the Pl |  | `scripts/maintenance/audit-seo-render-budget.mjs:` |
| ✅ | [Q-077](quality/Q-077.md) | S | naming | validationFailures in mint-burn metadata aliases apiErrors, producing a misleading cron_ru | codex | `worker/src/cron/mint-burn/run-completion.ts:L154` |
| ⬜ | [Q-084](quality/Q-084.md) | M | complexity | DailyDigest contains an IIFE returning JSX, splitting layout into two unrelated branches i |  | `src/components/daily-digest.tsx:L249-L333` |
| ⬜ | [Q-085](quality/Q-085.md) | M | complexity | readRedemptionBackstopLiveMetadata is a 220-line monolithic function with 30+ intermediate |  | `worker/src/lib/redemption-backstop-live-metadata` |
| ⬜ | [Q-087](quality/Q-087.md) | M | type-safety | Hundreds of entries have reconstructed: false with commits: [] — semantically contradictor |  | `shared/data/methodology-changelogs/depeg-dews/v6` |
| ⬜ | [Q-089](quality/Q-089.md) | S | complexity | CompareClient has a 60-second nowSeconds polling interval that is only used for flow-data  |  | `src/app/compare/client.tsx:121-198, L237-239` |
| ⬜ | [Q-091](quality/Q-091.md) | M | long param lists | HeroSectionBaseProps spreads 26 individual props through two large section components |  | `src/components/stablecoin-detail/hero-card-secti` |
| ⬜ | [Q-092](quality/Q-092.md) | M | complexity | depeg-control-board.tsx is a 583-line god module mixing view-model, primitives, and page l |  | `src/components/depeg-control-board.tsx:L1-L583` |
| ⬜ | [Q-099](quality/Q-099.md) | S | error-handling | skipped_running fence status is logged but silently ignored without return |  | `worker/src/handlers/scheduled.ts:L88-L94` |
| ⬜ | [Q-101](quality/Q-101.md) | S | complexity | T1_MAX_POOLS = 0 makes tier assignment semantically opaque |  | `worker/src/cron/dex-discovery/types.ts:L73 + wor` |
| ⬜ | [Q-106](quality/Q-106.md) | M | complexity | syncStablecoins entry-point has 9 positional parameters — ordering errors are undetectable |  | `worker/src/cron/sync-stablecoins.ts:L22-L32` |
| ⬜ | [Q-107](quality/Q-107.md) | M | error-handling | Preset failure count incremented on any partial failure but only reset on full success |  | `worker/src/cron/dispatch-telegram-alerts.ts:L469` |
| ⬜ | [Q-109](quality/Q-109.md) | M | complexity | buildPrimarySourceCandidates is a 300-line monolith with eight distinct responsibilities |  | `worker/src/lib/primary-price-collector.ts:L240-L` |
| ✅ | [Q-114](quality/Q-114.md) | S | complexity | UptimeBar.buildDaySegments is O(days × transitions) — inner loop does not advance a cursor | codex | `src/components/status/uptime-bar.tsx:L33-L80` |
| ⬜ | [Q-115](quality/Q-115.md) | S | type-safety | Treemap content prop supplied with zero-value placeholder props — type unsafety via dummy  |  | `src/components/reserve-treemap.tsx:L205` |
| ⬜ | [Q-116](quality/Q-116.md) | M | complexity | ContagionGraph re-runs useContagionGraphModel twice for the same dataset when fullscreen o |  | `src/components/contagion-graph.tsx:L20-L68` |
| ⬜ | [Q-117](quality/Q-117.md) | L | complexity | analyze-gsc-coverage.mjs is a 954-line monolith with a bespoke CSV parser, ZIP reader, and |  | `scripts/maintenance/analyze-gsc-coverage.mjs:1-9` |
| ⬜ | [Q-118](quality/Q-118.md) | M | type-safety | RawDimensionInputs / ReportCard / ReportCardsResponse declare interfaces that extend z.inf |  | `shared/types/report-cards.ts:L133-L148, L245-L25` |
| ⬜ | [Q-120](quality/Q-120.md) | S | complexity | command-palette-verbs.ts: parsePaletteInput has no return type annotation and returns unde |  | `src/lib/command-palette-verbs.ts:289-357` |
| ⬜ | [Q-122](quality/Q-122.md) | S | complexity | stagedPoolConfidence boundary: DB query window and confidence zero-out disagree by one sec |  | `worker/src/cron/dex-discovery/types.ts:L57-L61 +` |
| ⬜ | [Q-123](quality/Q-123.md) | S | type-safety | degradedSources written to two different fields of DigestInputData with no reconciliation |  | `worker/src/cron/daily-digest/input.ts:L231, L254` |
| ⬜ | [Q-124](quality/Q-124.md) | S | complexity | usdgo-transparency.ts uses an opaque sort-by-distance heuristic to reverse-engineer the fo |  | `worker/src/cron/reserve-adapters/usdgo-transpare` |
| ⬜ | [Q-129](quality/Q-129.md) | S | type-safety | GeniusComplianceRow.reserveDisclosurePresent conflates three distinct fields into one bool |  | `src/app/compliance/model.ts:L197-L199` |
| ⬜ | [Q-130](quality/Q-130.md) | M | complexity | command-palette-model.ts is a 727-line monolith mixing type definitions, static data, scor |  | `src/components/command-palette-model.ts:L1-L727` |
| ⬜ | [Q-132](quality/Q-132.md) | S | complexity | useAutoLoadInfinitePages resets retryCountRef via a separate effect rather than in the mai |  | `src/hooks/use-auto-load-infinite-pages.ts:L32-L3` |
| ⬜ | [Q-134](quality/Q-134.md) | S | security | SQL interpolation of user-controlled script arguments in rebuild-blacklist script |  | `worker/scripts/rebuild-blacklist-current-balance` |
| ⬜ | [Q-138](quality/Q-138.md) | M | complexity | KpiBar component accumulates 27 hook calls and ~250 lines of pre-render data wrangling |  | `src/components/kpi-bar.tsx:40-370` |
| ⬜ | [Q-141](quality/Q-141.md) | S | complexity | compare-pages.ts: build-time throw on module evaluation can produce opaque build errors |  | `src/lib/compare-pages.ts:L142, L50-L74` |
| ⬜ | [Q-151](quality/Q-151.md) | M | error-handling | SVG sanitizer does not strip `href` / `xlink:href` attributes enabling CSS-based data exfi |  | `src/app/alt-pegs/fiat-world-atlas/world-map.tsx:` |
| ⬜ | [Q-175](quality/Q-175.md) | S | naming | Typo in function name: precisStaleness instead of preciseStaleness |  | `src/components/selector/selector-shortlist-card.` |
| ✅ | [Q-176](quality/Q-176.md) | S | dead-code | Deprecated SVG xlinkHref attribute left alongside the modern href equivalent | codex | `src/components/yield-scatter-plot.tsx:L165` |
| ⬜ | [Q-177](quality/Q-177.md) | S | type-safety | supply-ratio capacityModel missing confidence field in usn-noon.ts and yusd-aegis.ts |  | `shared/lib/redemption-backstop-configs/stablecoi` |
| ✅ | [Q-178](quality/Q-178.md) | S | complexity | yield-venue-risk-calibration.ts: main() body is not indented inside the function braces | codex | `scripts/maintenance/yield-venue-risk-calibration` |
| ✅ | [Q-179](quality/Q-179.md) | S | complexity | `docs/api-reference.md` is read twice in the same `runDocSyncChecks` call | codex | `scripts/lib/doc-sync/checks.ts:L329-L415` |
| ⬜ | [Q-180](quality/Q-180.md) | S | security | Hardcoded personal email address in a user-visible error message |  | `src/lib/api-key-self-serve.ts:88` |
| ⬜ | [Q-181](quality/Q-181.md) | S | dead-code | psiPresent metadata field is always true in snapshot-public-dataset.ts |  | `worker/src/cron/snapshot-public-dataset.ts:454` |
| ✅ | [Q-182](quality/Q-182.md) | S | docs | check-phishing-signatures.mjs: spec comment diverges from implementation; 'yellow' severit | codex | `scripts/ci/check-phishing-signatures.mjs:L7-L11,` |
| ✅ | [Q-183](quality/Q-183.md) | S | complexity | injectCashtags rebuilds a large RegExp from all tracked stablecoin symbols on every call | codex | `worker/src/lib/twitter.ts:L61-L66` |
| 🚫 | [Q-184](quality/Q-184.md) | S | naming | pricing-pipeline/v1.ts uses 4-space indentation; all other changelog data files use 2-spac |  | `shared/data/methodology-changelogs/pricing-pipel` |
| ✅ | [Q-185](quality/Q-185.md) | S | naming | window.setTimeout used instead of global setTimeout in client component | codex | `src/app/learn/case-studies/case-study-share.tsx:` |
| ✅ | [Q-186](quality/Q-186.md) | S | naming | check-node-modules-fresh.mjs uses console.warn for all output including success, making CI | codex | `scripts/ci/check-node-modules-fresh.mjs:L25-L58` |
| ⬜ | [Q-187](quality/Q-187.md) | L | type-safety | StatusResponseSchema and StatusHistoryResponseSchema use passthrough().transform(v => v as |  | `shared/types/status.ts:L1046, L1056` |
| ⬜ | [Q-188](quality/Q-188.md) | S | error-handling | snapshot-safety-grade-history uses manual signal?.aborted throws instead of throwIfAborted |  | `worker/src/cron/snapshot-safety-grade-history.ts` |
| ⬜ | [Q-189](quality/Q-189.md) | S | naming | cronLeaseQueryFailed silently excluded from CronHealthSnapshot despite influencing orphan  |  | `worker/src/lib/status/cron-health.ts:L8-L23 (int` |
| ✅ | [Q-190](quality/Q-190.md) | S | dead-code | Unused parameter _visibleCount in getHomepageDiscoveryCycleLength | codex | `src/lib/homepage-discovery.ts:L135-L141` |
| ⬜ | [Q-191](quality/Q-191.md) | S | naming | stats.totalCommits name misrepresents its meaning |  | `src/data/changelogs/types.ts:L27, src/components` |
| ✅ | [Q-192](quality/Q-192.md) | S | error-handling | parse-version-upload.mjs: no error handling around per-line JSON.parse of wrangler JSONL o | codex | `.github/scripts/parse-version-upload.mjs:L11` |
| ✅ | [Q-193](quality/Q-193.md) | S | type-safety | generate-reserve-coverage-audit.ts uses `file://${process.argv[1]}` template string for ma | codex | `scripts/maintenance/generate-reserve-coverage-au` |
| ⬜ | [Q-194](quality/Q-194.md) | S | error-handling | removePresetSubscriptions calls statements[0].run() instead of db.batch(), silently droppi |  | `worker/src/api/telegram-store/presets.ts:L93-L10` |
| ⬜ | [Q-195](quality/Q-195.md) | S | naming | Hardcoded 55-minute OXR rate-limit window lacks named constant |  | `worker/src/cron/sync-fx-rates-helpers.ts:738` |
| ⬜ | [Q-196](quality/Q-196.md) | S | type-safety | dateRange.from/to are untyped strings; sort correctness relies on undocumented format assu |  | `src/data/changelogs/types.ts:L16, src/data/chang` |
| ⬜ | [Q-197](quality/Q-197.md) | S | naming | `takeaways[4]` in `usr-resolv-2026.ts` is a multi-sentence prose paragraph, violating the  |  | `src/app/learn/case-studies/content/usr-resolv-20` |
| ✅ | [Q-198](quality/Q-198.md) | S | complexity | check-cron-connection-budget.ts: printReport couples to global CRON_CONNECTION_BUDGET, byp | codex | `scripts/ci/check-cron-connection-budget.ts:L183-` |
| ⬜ | [Q-199](quality/Q-199.md) | S | error-handling | SectionBanner swallows clipboard write rejection silently |  | `src/components/stablecoin-detail/section-banner.` |
| ✅ | [Q-200](quality/Q-200.md) | S | naming | Malformed aria-label on the peak supply-move link | codex | `src/components/home-alt-mini-cards/supply-moves-` |
| ⬜ | [Q-201](quality/Q-201.md) | S | complexity | HomeAltHeroChart calls makeScales redundantly — once per area path and once per top-line p |  | `src/components/home-alt-hero-chart.tsx:L119-L173` |
| ✅ | [Q-202](quality/Q-202.md) | S | error-handling | ExploitNoticeBanner uses list index as React key for critical security notices | codex | `src/components/exploit-notice-banner.tsx:L49` |
| ⬜ | [Q-203](quality/Q-203.md) | S | error-handling | formatSchemaIssues truncates Zod errors to 8 issues, potentially hiding validation failure |  | `shared/lib/stablecoins/schema.ts:L398-L406` |
| ⬜ | [Q-204](quality/Q-204.md) | S | error-handling | sourceRiskInverted silent-null contract breaks the special-case detection in scoreRow |  | `shared/lib/selector/normalization.ts:L63, shared` |
| ⬜ | [Q-205](quality/Q-205.md) | S | type-safety | ApiKeySelfServeCadence is a plain TypeScript union type with no Zod schema — unlike every  |  | `shared/types/api-key-requests.ts:L15-L20` |
| ⬜ | [Q-206](quality/Q-206.md) | M | error-handling | use-status-history builds /api/status-history URL inline, bypassing the shared API_PATHS h |  | `src/hooks/use-status-history.ts:L18-L25` |
| ⬜ | [Q-207](quality/Q-207.md) | S | clone | TOTAL_VALUE_SELECTOR (0xd4c3eea0) defined independently in two adapter files |  | `worker/src/cron/reserve-adapters/blast-usdb-yiel` |
| ✅ | [Q-208](quality/Q-208.md) | S | naming | M0 adapter metadata comment `cashUnits: 'milli-usd-to-micro-usd'` is factually wrong | codex | `worker/src/cron/reserve-adapters/m0.ts:L63, L171` |
| ⬜ | [Q-209](quality/Q-209.md) | S | error-handling | sync-bluechip setTimeout delay does not respect AbortSignal |  | `worker/src/cron/sync-bluechip.ts:L127` |
| ⬜ | [Q-210](quality/Q-210.md) | S | type-safety | isUsableGeckoId filters via substring 'wrong' — undocumented sentinel, possible false posi |  | `worker/src/cron/sync-stablecoins/enrich-prices-p` |
| ⬜ | [Q-211](quality/Q-211.md) | S | docs | Generic homepage or section-landing hrefs used for high-severity annotations, violating cu |  | `shared/data/annotations/curated-annotations.ts:L` |
| ⬜ | [Q-212](quality/Q-212.md) | S | type-safety | Hardcoded magic index accesses into PRINCIPLES_AXIOMS array in AboutPage |  | `src/app/about/page.tsx:L244-L250` |
| ⬜ | [Q-213](quality/Q-213.md) | S | naming | inspection-board.tsx uses a data-driven colored left-stripe in violation of the repo's fla |  | `src/app/safety-scores/inspection-board.tsx:93` |
| ⬜ | [Q-214](quality/Q-214.md) | S | naming | Function named `tradingShareStaleExceeded` while the check is named `tradingStaleExceeded` |  | `src/app/screener/picker/client.tsx:L167, L430` |
| ⬜ | [Q-215](quality/Q-215.md) | S | error-handling | check-depeg-operational-integrity.mjs: FAIL/ok output goes to stdout, not stderr |  | `scripts/ci/check-depeg-operational-integrity.mjs` |
| ⬜ | [Q-216](quality/Q-216.md) | S | naming | ShareBar's topMargin boolean prop is an inverted-concern design smell |  | `src/components/status/request-source-attribution` |
| ⬜ | [Q-217](quality/Q-217.md) | S | error-handling | depeg-provenance-badges.tsx builds className strings with manual template-literal + .trim( |  | `src/components/depeg-provenance-badges.tsx:71, 8` |
| ⬜ | [Q-218](quality/Q-218.md) | S | complexity | Universal safetyGrade === 'F' check in applyUniversalExclusions is made unreachable by pri |  | `shared/lib/selector/exclusions.ts:L162-L163, L18` |
| ⬜ | [Q-219](quality/Q-219.md) | S | error-handling | Nested deadline-exit in fetchDsFallbackPools emits an event without recording circuit outc |  | `worker/src/cron/dex-liquidity/fetch-fallbacks.ts` |
| ⬜ | [Q-220](quality/Q-220.md) | S | complexity | recordDeferredTail mutates the caller's breakerKeys Set as an undocumented side-effect |  | `worker/src/cron/sync-live-reserves-run-state.ts:` |
| ⬜ | [Q-221](quality/Q-221.md) | S | naming | OXR_LEGACY_LAST_FETCH_KEY is a write-only migration fossil with no expiry path |  | `worker/src/cron/sync-fx-rates-helpers.ts:25, 729` |
| ⬜ | [Q-222](quality/Q-222.md) | S | complexity | accountable adapter applies renameMap twice to the same bucket name |  | `worker/src/cron/reserve-adapters/accountable.ts:` |
| ⬜ | [Q-223](quality/Q-223.md) | S | dead-code | D1Result stub in stability-index.ts is unreachable but occupies 10 LOC |  | `worker/src/cron/stability-index.ts:55-67` |
| ⬜ | [Q-224](quality/Q-224.md) | S | docs | MNEE event signatures omit 'indexed' qualifiers, creating misleading human-readable docume |  | `worker/src/lib/blacklist-contracts.ts:L409-L427` |
| ⬜ | [Q-225](quality/Q-225.md) | S | error-handling | logIndex NaN not guarded in parse.ts — produces corrupted event ID and silent DB collision |  | `worker/src/lib/mint-burn-pipeline/parse.ts:L62-L` |
| ⬜ | [Q-226](quality/Q-226.md) | S | complexity | result-pane.tsx buildClosestSurvivorsFromOutput uses an unsafe cast to access an optional  |  | `src/app/screener/picker/result-pane.tsx:500-511` |
| ✅ | [Q-227](quality/Q-227.md) | S | error-handling | build-og-case-studies.mjs silently drops case-study cards when regex-based field extractio | codex | `scripts/maintenance/build-og-case-studies.mjs:68` |
| ⬜ | [Q-228](quality/Q-228.md) | S | error-handling | useCompareShareActions silently swallows all canvas/render errors in handleTwitterShare |  | `src/hooks/use-compare-share-actions.ts:L123-L150` |
| ⬜ | [Q-229](quality/Q-229.md) | S | docs | fieldNotes word-count constraint is JSDoc-only and unverifiable at authoring time |  | `src/data/changelogs/types.ts:L21-26` |
| ⬜ | [Q-230](quality/Q-230.md) | S | complexity | pickRelatedStudies performs two O(n) linear scans per call inside an O(n) loop |  | `src/app/learn/case-studies/case-study-body.tsx:L` |
| ✅ | [Q-231](quality/Q-231.md) | S | error-handling | RefreshCountdown timer only counts up but never drives an actual refresh — stale seconds s | codex | `src/components/status/refresh-countdown.tsx:L1-L` |
| ⬜ | [Q-232](quality/Q-232.md) | M | naming | Hardcoded AI model name in DigestNameplate creates a brittle sustainability dependency |  | `src/components/digest-nameplate.tsx:L39` |
| ⬜ | [Q-233](quality/Q-233.md) | S | type-safety | ApiKeySelfServeIssueResponse hardcodes rateLimitPerMinute: 30 as a literal type — unnecess |  | `shared/types/api-key-requests.ts:L51` |
| ⬜ | [Q-234](quality/Q-234.md) | S | type-safety | backfill-mint-burn block-range bounds validation is dead for any supplied param |  | `worker/src/api/backfill-mint-burn.ts:112-131,189` |
| ⬜ | [Q-235](quality/Q-235.md) | S | error-handling | runEventReconciliation uses a hard-coded fallback public Ethereum RPC that bypasses inject |  | `worker/scripts/reconcile-blacklist-events-from-k` |
| ⬜ | [Q-236](quality/Q-236.md) | M | security | isGroupAdminActor makes an uncached Telegram API call per command invocation in the hot pa |  | `worker/src/api/telegram-webhook-auth.ts:L43-L52 ` |
| ⬜ | [Q-237](quality/Q-237.md) | M | scalability | discovery-scan.ts upserts each candidate with individual sequential D1 calls |  | `worker/src/cron/discovery-scan.ts:L62-L127` |
| ⬜ | [Q-238](quality/Q-238.md) | S | naming | freezeActive always equals freezeCapabilityPresent — misleading field semantics |  | `worker/src/cron/sync-usds-status.ts:118-119 + sh` |
| ⬜ | [Q-239](quality/Q-239.md) | S | security | dexscreener.ts spoofs a Chrome browser User-Agent and browser headers |  | `worker/src/lib/dexscreener.ts:L14-L22` |
| ⬜ | [Q-240](quality/Q-240.md) | S | type-safety | GraphQL query in D1 analytics fetch uses the wrong CF variable type annotation |  | `worker/src/lib/status/d1-usage.ts:L206` |
| ⬜ | [Q-241](quality/Q-241.md) | S | testing | dews source-state fallback.ts at 66.7% coverage with no direct tests for resolveBootstrapA |  | `worker/src/cron/dews/source-state/fallback.ts:L3` |
| ✅ | [Q-242](quality/Q-242.md) | S | type-safety | SummaryItem.href accepts any string with no path/URL contract | codex | `src/data/changelogs/types.ts:L11` |
| ⬜ | [Q-243](quality/Q-243.md) | S | type-safety | SectionKicker requires className even when no extra styling is needed |  | `src/app/learn/_shared/section-primitives.tsx:16` |
| ⬜ | [Q-244](quality/Q-244.md) | S | complexity | CurrencyFlag inlines all flag SVGs at module level rather than deferring unused paths |  | `src/app/yield/currency-flag.tsx:L30-L136` |
| ⬜ | [Q-245](quality/Q-245.md) | S | error-handling | forgetMe dispatches through optimistic mutate instead of imperative performMutation |  | `src/app/pharoswatchbot/app/use-mini-app-mutation` |
| ⬜ | [Q-246](quality/Q-246.md) | S | complexity | ScoreBreakdown badge logic in selector-shortlist-card produces misleading label combinatio |  | `src/components/selector/selector-shortlist-card.` |
| ⬜ | [Q-247](quality/Q-247.md) | S | type-safety | hasTableCaptionChild falls back to function.name which is minified in production builds |  | `src/components/table/table-label.ts:L40` |
| ⬜ | [Q-248](quality/Q-248.md) | S | naming | downstreamByTarget is named opposite to its semantics in computeRippleState |  | `src/components/contagion-graph-graph.ts:117-165` |
| ⬜ | [Q-249](quality/Q-249.md) | S | error-handling | GoogleAnalytics bootstrap effect leaks a no-op cleanup when the idle-callback path runs |  | `src/components/google-analytics.tsx:L36-L68` |
| ⬜ | [Q-250](quality/Q-250.md) | M | type-safety | classifyFailure relies on free-text error message substring matching, silently falls back  |  | `worker/src/cron/sync-live-reserves-shared.ts:159` |
| ⬜ | [Q-251](quality/Q-251.md) | M | complexity | drainPendingQueue uses 14 parallel mutable accumulators in a single function body |  | `worker/src/cron/telegram-pending/drain.ts:L309-L` |
| ⬜ | [Q-252](quality/Q-252.md) | S | type-safety | fetchHistoricalSecondaryFxDay casts API response without validation, silently accepts malf |  | `worker/src/lib/backfill-fx.ts:L159` |
| ⬜ | [Q-253](quality/Q-253.md) | S | type-safety | DdrDiagnosticAssessmentSnapshot uses unknown[] for rows, silently dropping non-conforming  |  | `worker/src/lib/depeg-resolver-assessment-store.t` |
| ⬜ | [Q-254](quality/Q-254.md) | S | testing | yield-source-risk-registry.ts has no shared/lib test; computed derived fields tested only  |  | `shared/lib/yield-source-risk-registry.ts:L1-L108` |
| ✅ | [Q-255](quality/Q-255.md) | S | complexity | Array index used as React `key` in `CaseStudyTimeline` and `explainer-shell.tsx` | codex | `src/app/learn/case-studies/case-study-timeline.t` |
| ⬜ | [Q-256](quality/Q-256.md) | S | complexity | Inline `table` key uses `row.join('\|')` which is O(n×m) string allocation per render |  | `src/app/about/api/page.tsx:L193` |
| ⬜ | [Q-257](quality/Q-257.md) | S | complexity | `pct` recomputed in `CompositionSection` when `chainShare` already holds it |  | `src/app/chains/[chain]/composition-section.tsx:L` |
| 🚫 | [Q-258](quality/Q-258.md) | S | error-handling | handleRefresh in status/client.tsx is not memoized and its async refetches are not void-ca |  | `src/app/status/client.tsx:L48-L51` |
| ⬜ | [Q-259](quality/Q-259.md) | S | type-safety | SourceInfo status type not narrowed before being passed to SourceChip |  | `src/components/stablecoin-detail/price-transpare` |
| ⬜ | [Q-260](quality/Q-260.md) | S | error-handling | symbolToId heuristic in recent-freezes-card is prefix-sensitive and could mismatch if regi |  | `src/components/home-alt-mini-cards/recent-freeze` |
| ⬜ | [Q-261](quality/Q-261.md) | S | complexity | FlowSummaryCard has complex multi-fallback data resolution logic that is hard to trace |  | `src/components/flow-summary-card.tsx:L126-L148` |
| ⬜ | [Q-262](quality/Q-262.md) | M | complexity | formatChartNumber introduces a module-level Intl cache duplicating the pattern scattered a |  | `src/components/yield-history-chart-model.ts:L231` |
| ⬜ | [Q-263](quality/Q-263.md) | S | error-handling | Feedback modal honeypot input has readOnly + value='' but still reads via body JSON |  | `src/components/feedback-modal.tsx:L251-L259, L97` |
| ⬜ | [Q-264](quality/Q-264.md) | S | error-handling | freeze-stablecoin.ts fetches the entire /api/stablecoins payload to find one coin |  | `scripts/maintenance/freeze-stablecoin.ts:L78-L86` |
| ⬜ | [Q-265](quality/Q-265.md) | S | error-handling | Dependency-risk ceiling detail can mislabel a mechanism-bound ceiling as 'wrapper' |  | `shared/lib/report-card-dependency.ts:109-147` |
| ⬜ | [Q-266](quality/Q-266.md) | S | naming | getDewsFreshness: computedAt=0 (Unix epoch) silently treated as missing data |  | `src/lib/dews-signal-utils.ts:L84-L85` |
| ⬜ | [Q-267](quality/Q-267.md) | S | complexity | CohortBucket.size duplicates scoresDescending.length and is maintained in parallel |  | `src/lib/yield-view-model.ts:785-815, 825-837` |
| ⬜ | [Q-268](quality/Q-268.md) | S | type-safety | handleApiKeyAuditLog declares request optional but dereferences it unconditionally |  | `worker/src/api/api-key-audit-log.ts:30-42` |
| ⬜ | [Q-269](quality/Q-269.md) | S | testing | bounded-queue.ts has no test for worker exception propagation leaving sparse results array |  | `worker/src/cron/shared/bounded-queue.ts:L37-64 +` |
| ⬜ | [Q-270](quality/Q-270.md) | S | error-handling | parseTimestampLikeToUnixSeconds silently rejects any DD/MM/YY date where both day and mont |  | `worker/src/cron/reserve-adapters/freshness.ts:L9` |
| ⬜ | [Q-271](quality/Q-271.md) | M | error-handling | circuit-breaker sendAlert fire-and-forget may drop alerts before isolate teardown |  | `worker/src/lib/circuit-breaker.ts:L108-L113, L13` |
| ⬜ | [Q-272](quality/Q-272.md) | M | complexity | computeReserveCompositionOverview uses 43 local variables and mixes cursor-parsing with ag |  | `worker/src/lib/live-reserves-store-overview.ts:L` |
| ⬜ | [Q-273](quality/Q-273.md) | S | complexity | computeStructuredYieldSignal accumulates score by additive checks with no cap check until  |  | `worker/src/lib/dews/signal-families.ts:L420-L468` |
| ⬜ | [Q-274](quality/Q-274.md) | S | testing | report-card-policy.ts inference defaults are tested only transitively through resilience/g |  | `shared/lib/report-card-policy.ts:L170-L176 + sha` |
| ⬜ | [Q-275](quality/Q-275.md) | S | security | CF Access JWT verifier trusts attacker-controlled header.alg instead of pinning the JWK al |  | `shared/lib/cloudflare-access-jwt.ts:184,200-222 ` |
| ⬜ | [Q-276](quality/Q-276.md) | S | error-handling | Index used as React key in three static content lists |  | `src/app/learn/_shared/section-primitives.tsx:49,` |
| 🚫 | [Q-277](quality/Q-277.md) | S | type-safety | session-storage.ts casts unknown sessionStorage value with as Partial<> instead of runtime |  | `src/app/screener/picker/session-storage.ts:L24-L` |
| ⬜ | [Q-278](quality/Q-278.md) | S | naming | usdd-data-platform names the timestamp variable statisticTimeMs but passes it to parseTime |  | `worker/src/cron/reserve-adapters/usdd-data-platf` |
| ⬜ | [Q-279](quality/Q-279.md) | S | error-handling | sealPublicOutcome has a TOCTOU window: load-then-insert is not atomic, causing a misleadin |  | `worker/src/lib/depeg-resolver-publication-store.` |
| ⬜ | [Q-280](quality/Q-280.md) | S | complexity | topologicalOrder has no cycle detection; a dependency cycle silently produces a wrong orde |  | `worker/src/lib/report-cards-snapshot-card.ts:L47` |
| ⬜ | [Q-281](quality/Q-281.md) | S | error-handling | methodology-change kind applied to non-methodology product pivots, diluting the Pharos met |  | `shared/data/annotations/curated-annotations.ts:L` |
| ✅ | [Q-282](quality/Q-282.md) | S | dead-code | Dead null-coalescing guards on a non-optional number field (worstCacheRatio) | codex | `src/app/admin/sections/reliability-section.tsx:7` |
| ⬜ | [Q-283](quality/Q-283.md) | S | complexity | YieldIntelligenceMethodologySection is a 302-line single-component file with a long prose  |  | `src/app/methodology/sections/monitoring/yield-in` |
| ⬜ | [Q-284](quality/Q-284.md) | M | type-safety | stripCommentsAndStrings in check-feature-flag-inlining.mjs does not handle template-litera |  | `scripts/ci/check-feature-flag-inlining.mjs:L52-L` |
| ⬜ | [Q-285](quality/Q-285.md) | S | error-handling | coin-notice.tsx uses array index as React list key for potentially stable, ordered notices |  | `src/components/coin-notice.tsx:L59` |
| ⬜ | [Q-286](quality/Q-286.md) | S | complexity | ChartSkeleton exposes two partially-overlapping prop sets (`variant`/`height` vs `type`/`c |  | `src/components/chart-skeleton.tsx:L6-L147` |
| ⬜ | [Q-287](quality/Q-287.md) | S | complexity | DepegFeed seenIds Set grows without bound across the component lifetime |  | `src/components/depeg-feed.tsx:L44, L85-L94` |
| ⬜ | [Q-288](quality/Q-288.md) | M | complexity | usePortfolio reads window.location.search directly in getInitialPortfolioState, bypassing  |  | `src/hooks/use-portfolio.ts:L78-L99` |
| ⬜ | [Q-289](quality/Q-289.md) | S | error-handling | cancelResponseBodyQuietly called after res.json() already consumed body — misleading dead  |  | `worker/src/cron/sync-stablecoins/enrich-prices-d` |
| ⬜ | [Q-290](quality/Q-290.md) | S | type-safety | rowToDepegEvent silently ignores unknown direction/source values after warning |  | `worker/src/lib/depeg-helpers.ts:356-401` |
| ⬜ | [Q-291](quality/Q-291.md) | S | naming | formatRouteAvailabilityReviewedAt is exported but semantically identical to inline formatU |  | `worker/src/lib/redemption-backstop-availability.` |
| ⬜ | [Q-292](quality/Q-292.md) | S | naming | Two METHODOLOGY_SECTIONS nav IDs omit the '-methodology' suffix used by all other entries |  | `src/app/methodology/methodology-shared.tsx:17,21` |
| ⬜ | [Q-293](quality/Q-293.md) | S | complexity | FundingKpiRow builds branching label objects inline, adding cognitive load |  | `src/components/funding/funding-page-sections.tsx` |
| ⬜ | [Q-294](quality/Q-294.md) | S | error-handling | downloadCsvWithPreamble: object URL not revoked on click failure and a.click() return valu |  | `src/lib/exports/csv.ts:L38-L52` |
| ⬜ | [Q-295](quality/Q-295.md) | S | naming | Risk-score threshold 50 is a magic number duplicated between summary aggregation and its o |  | `src/lib/api-key-request-admin-view-model.ts:178,` |
| ⬜ | [Q-296](quality/Q-296.md) | S | naming | INLINE_EXTERNAL_LINK_CLASS in about/page.tsx is local and inconsistent with pharos-prose-l |  | `src/app/about/page.tsx:L39-L41` |
| ⬜ | [Q-297](quality/Q-297.md) | S | complexity | buildVisiblePsiChartEvents uses a Partial record for label-position deduplication, silentl |  | `src/lib/psi-history-events.ts:167-183` |
| ⬜ | [Q-298](quality/Q-298.md) | S | error-handling | admin-telegram-resend records httpStatus 200 and returns HTTP 200 even when Telegram deliv |  | `worker/src/api/admin-telegram-resend.ts:274-307` |
| ⬜ | [Q-299](quality/Q-299.md) | M | testing | Public decision-ledger reason-code derivation is untested despite being a wire-format cont |  | `worker/src/cron/yield-sync/decision-public.ts:29` |
| ⬜ | [Q-300](quality/Q-300.md) | S | complexity | computeWeightedMedianPrice uses a lower-fence boundary (>= halfWeight) that selects the fi |  | `worker/src/lib/dex-price-estimators.ts:L38-L45` |
| ⬜ | [Q-301](quality/Q-301.md) | S | security | Transitive advisories in build/dev chain (ws high, postcss moderate) tracked but the prod- |  | `package.json:scripts.audit:deps (`npm audit --au` |
| ⬜ | [Q-302](quality/Q-302.md) | M | error-handling | Inline AbortSignal.any timeout composition in worker fetch-retry bypasses the shared creat |  | `worker/src/lib/fetch-retry.ts:42-49 vs shared/li` |
| ⬜ | [Q-303](quality/Q-303.md) | S | type-safety | Unsafe key cast into CRON_STATUS_COLORS duplicated in two render paths |  | `src/app/admin/sections/cron-lane-table.tsx:106, ` |
| ⬜ | [Q-304](quality/Q-304.md) | S | naming | OG card 24h change derived from adjacent daily supply_history snapshots, not a true 24h wi |  | `worker/src/api/og.tsx:236-243,288-291` |
| ✅ | [Q-305](quality/Q-305.md) | S | type-safety | events.ts accepts negative since/until and unbounded epoch values without validating they  | codex | `worker/src/api/events.ts:44-49,111-114` |
| ⬜ | [Q-306](quality/Q-306.md) | M | type-safety | digest-snapshot casts DB-stored JSON straight to DigestInputData without shape validation |  | `worker/src/api/digest-snapshot.ts:89-107` |
| ⬜ | [Q-307](quality/Q-307.md) | S | security | Client-supplied X-Forwarded-For used as rate-limit IP fallback when CF-Connecting-IP is ab |  | `worker/src/api/api-key-requests/request.ts:121-1` |
| ⬜ | [Q-308](quality/Q-308.md) | S | error-handling | Non-deterministic Math.random idempotency-key fallback can collide and weakens the dedupe  |  | `src/lib/api-key-request-admin-view-model.ts:86-9` |
| ⬜ | [Q-309](quality/Q-309.md) | M | complexity | buildAddressPriceTargetsByProvider is a long, multi-responsibility function with several h |  | `worker/src/lib/address-price-providers/index.ts:` |
| ⬜ | [Q-310](quality/Q-310.md) | S | type-safety | Provider metadata copies arbitrary upstream fields (any) into quote.metadata without valid |  | `worker/src/lib/address-price-providers/moralis.t` |
| ⬜ | [Q-311](quality/Q-311.md) | M | complexity | Front-end view-model modules approach god-module size, mixing config tables, parsing, face |  | `src/lib/yield-view-model.ts:1-1247 (33 exports; ` |
| ⬜ | [Q-312](quality/Q-312.md) | S | type-safety | Legacy stablecoin redirect JSON is cast to Record<string,string> with no runtime validatio |  | `functions/stablecoin/[[path]].ts:1-21` |
| ⬜ | [Q-313](quality/Q-313.md) | S | error-handling | Site-data cache existence check via cached!==null doesn't distinguish negative cache or er |  | `functions/_site-data/[[path]].ts:159-166` |
| ⬜ | [Q-314](quality/Q-314.md) | S | security | Pages site-data origin gate accepts any *.pages.dev preview subdomain via isPagesAppHostna |  | `functions/lib/site-data-origin.ts:6-22; shared/l` |
| 🚫 | [Q-315](quality/Q-315.md) | S | security | Telegram callback queries are not re-authorized in private chats beyond the chat binding |  | `worker/src/api/telegram-webhook-callbacks.ts:49-` |

## sustainability (152)

### High (2)

| | ID | E | Category | Title | Owner | Loc |
|---|---|---|---|---|---|---|
| ⬜ | [S-008](sustainability/S-008.md) | M | coupling | useMotionPreference and usePrefersReducedMotion are parallel but unconnected motion-prefer |  | `src/hooks/use-motion-preference.ts:L1-L101 + src` |
| ⬜ | [S-062](sustainability/S-062.md) | M | scalability | Selector-snapshot public write lane relies on a spoofable origin header plus a best-effort |  | `functions/selector-snapshot/[[path]].ts:34-72,13` |

### Medium (49)

| | ID | E | Category | Title | Owner | Loc |
|---|---|---|---|---|---|---|
| ⬜ | [S-001](sustainability/S-001.md) | M | config | check-telegram-load.ts hardcodes a stale migration list; new telegram migrations are silen |  | `scripts/ci/check-telegram-load.ts:L821-L843` |
| ⬜ | [S-002](sustainability/S-002.md) | S | dead-code | ChainCohortLattice ships 390 LOC that always renders null in production |  | `src/components/chains/chain-cohort-lattice.tsx:L` |
| ⬜ | [S-004](sustainability/S-004.md) | M | config | manifest.ts sourceFilePaths for stablecoin-redeem is a manually-maintained list with no sy |  | `shared/lib/redemption-backstop-configs/manifest.` |
| ⬜ | [S-005](sustainability/S-005.md) | S | config | Model identifier hardcoded as string literal with no env-var or constant abstraction |  | `worker/src/cron/digest/platform.ts:L110` |
| ⬜ | [S-007](sustainability/S-007.md) | M | complexity | check-unused-code.mjs EXPORT_ALLOWLIST validates file existence only, not symbol existence |  | `scripts/ci/check-unused-code.mjs:L34-L240, L308-` |
| ⬜ | [S-013](sustainability/S-013.md) | M | complexity | smoke-ui.mjs serializes a 500-line function into a string for eval via Function() construc |  | `scripts/maintenance/smoke-ui.mjs:L188-L529, L829` |
| ⬜ | [S-014](sustainability/S-014.md) | M | scalability | UniV3 and Aerodrome subgraph queries silently truncate at page-one cap |  | `worker/src/cron/dex-liquidity/subgraph-source-fa` |
| 🚫 | [S-015](sustainability/S-015.md) | M | coupling | crvusd adapter hardcodes Ethereum-only RPC URLs and contract addresses as module-scope con |  | `worker/src/cron/reserve-adapters/crvusd.ts:L108-` |
| ⬜ | [S-018](sustainability/S-018.md) | M | scalability | status-supplements.ts reads the stablecoins cache row from D1 three times in a single requ |  | `worker/src/api/status-supplements.ts:L171 (loadC` |
| ⬜ | [S-022](sustainability/S-022.md) | M | complexity | ContagionGraphSvg accepts 37-field prop interface — all propagated from model via stage vi |  | `src/components/contagion-graph/contagion-graph-s` |
| ⬜ | [S-024](sustainability/S-024.md) | S | hardcoded-values | Hardcoded methodology version extraction via regex in build-og-editorial.mjs creates a sil |  | `scripts/maintenance/build-og-editorial.mjs:L36-L` |
| ⬜ | [S-025](sustainability/S-025.md) | M | config | stablecoin-static-data.ts: three large manually-curated arrays that must be kept in sync |  | `src/lib/stablecoin-static-data.ts:L79-L486, src/` |
| ⬜ | [S-026](sustainability/S-026.md) | L | coupling | use-url-filters monkey-patches History.pushState/replaceState with module-scope mutable gl |  | `src/hooks/use-url-filters.ts:L16-L63` |
| ⬜ | [S-027](sustainability/S-027.md) | M | complexity | analyzeDexLiquidityPostScoring is a 350-line god function with a 6-query Promise.all |  | `worker/src/cron/dex-liquidity/orchestrator-analy` |
| ⬜ | [S-028](sustainability/S-028.md) | M | scalability | Ten sequential independent collector awaits in buildDailyDigestInput inflate cron wall tim |  | `worker/src/cron/daily-digest/input.ts:L209-L218` |
| ⬜ | [S-029](sustainability/S-029.md) | M | coupling | runCronStalenessWatchdog builds observation objects twice—once via evaluateCronStaleness,  |  | `worker/src/cron/cron-staleness-watchdog.ts:240-2` |
| ⬜ | [S-030](sustainability/S-030.md) | M | config | Public Solana RPC URL hardcoded in Jupiter pass — no env-var override path |  | `worker/src/cron/sync-stablecoins/enrich-prices-j` |
| ⬜ | [S-031](sustainability/S-031.md) | M | config | LOW_VOLUME_CG_FALLBACK_IDS is a hardcoded manually-maintained allowlist with no expiry or  |  | `worker/src/cron/sync-stablecoins/enrich-prices-c` |
| ⬜ | [S-032](sustainability/S-032.md) | S | config | SECONDARY_FX_CURRENCY_TO_PEG uses lowercase keys while REALTIME_FX_CURRENCY_TO_PEG uses up |  | `worker/src/lib/fx-config.ts:L41-L62` |
| ⬜ | [S-033](sustainability/S-033.md) | M | config | Inline <style> block with 130 lines of CSS and keyframe animations injected at component m |  | `src/components/selector/selector-callout.tsx:L19` |
| ⬜ | [S-034](sustainability/S-034.md) | S | coupling | Hardcoded TELEGRAM_LIFECYCLE_SNAPSHOT_REFRESH_SECONDS duplicates a worker-side constant wi |  | `src/components/status/telegram-bot-stats.tsx:L14` |
| ⬜ | [S-035](sustainability/S-035.md) | S | scalability | BENCHMARK_PROVIDER_ORDER and BENCHMARK_DEGRADATION_ORDER maintained as parallel arrays wit |  | `worker/src/cron/fetch-tbill-rate.ts:L1024-1051` |
| ⬜ | [S-036](sustainability/S-036.md) | M | docs | `EndpointDirectory` links every endpoint card to the same generic anchor, making individua |  | `src/app/about/api/page.tsx:L323-L327` |
| ⬜ | [S-037](sustainability/S-037.md) | M | coupling | Legacy URL param aliases (`tokenType`, `pegCurrency`) silently supported without expiry pl |  | `src/app/compliance/client.tsx:L82, L86` |
| ⬜ | [S-038](sustainability/S-038.md) | M | complexity | SelectorClient (screener picker) contains a 6-step wizard fully inlined as a 500-line if-e |  | `src/app/screener/picker/client.tsx:L51-L369` |
| ⬜ | [S-039](sustainability/S-039.md) | S | scalability | centralized-custody quadratic find in recursion |  | `shared/lib/centralized-custody.ts L39-L72` |
| ⬜ | [S-040](sustainability/S-040.md) | S | clone | Three morpho venue-risk entries must stay byte-identical by comment, but nothing enforces  |  | `shared/lib/yield-source-risk-registry.ts:205-250` |
| ⬜ | [S-041](sustainability/S-041.md) | M | scalability | loadBlacklistConfigStates fires N separate D1 queries (one per config) via Promise.all |  | `worker/src/cron/blacklist/sync-support.ts:L52-L6` |
| ⬜ | [S-042](sustainability/S-042.md) | M | config | generate-reserve-coverage-audit.ts embeds 27-entry per-coin source-quality review table as |  | `scripts/maintenance/generate-reserve-coverage-au` |
| ⬜ | [S-043](sustainability/S-043.md) | S | complexity | Module-scope `validateValidationCommandImpactRegistry()` side-effect runs on every import  |  | `scripts/lib/validate-contract.mjs:L184` |
| ⬜ | [S-044](sustainability/S-044.md) | M | scalability | useCompareDataModel spreads the entire raw query result bag back to callers |  | `src/hooks/use-compare-data-model.ts:L190-L224` |
| ⬜ | [S-047](sustainability/S-047.md) | M | coupling | flow-machine-scene-shredder.tsx uses styled-jsx — the only inline JSX-in-CSS mechanism in  |  | `src/components/flow-machine-scene-shredder.tsx:L` |
| ⬜ | [S-048](sustainability/S-048.md) | M | coupling | portfolio-analysis.ts hardcodes a MAJOR_CENTRALIZED_IDS allowlist that is not keyed to any |  | `src/lib/portfolio-analysis.ts:84-97` |
| ⬜ | [S-049](sustainability/S-049.md) | M | scalability | Supply-gap reconciliation makes unbounded sequential per-coin CoinGecko market-chart API c |  | `worker/src/cron/sync-stablecoins/supply-gap-reco` |
| ⬜ | [S-050](sustainability/S-050.md) | M | complexity | DEWS SQL uses two different query shapes selected at runtime with undocumented fallback se |  | `worker/src/cron/stability-index.ts:126-148` |
| ⬜ | [S-051](sustainability/S-051.md) | S | coupling | SupplementalSourceFamilyKey union type defined twice; the two definitions can silently dri |  | `worker/src/cron/yield-sync/cache/supplemental-ca` |
| ⬜ | [S-052](sustainability/S-052.md) | M | scalability | loadCronHealth issues 10+ sequential D1 awaits within the status-self-check cron's 6-conne |  | `worker/src/lib/status/cron-health.ts:L163-L176 (` |
| ⬜ | [S-053](sustainability/S-053.md) | M | docs | flow-machine-scene-printer.tsx uses `<style jsx>` tagged-template CSS, which requires the  |  | `src/components/flow-machine-scene-printer.tsx:L1` |
| ⬜ | [S-055](sustainability/S-055.md) | S | coupling | GeckoTerminal pool-kind heuristic conflates v3/v4 substring matching with pool shape |  | `worker/src/cron/dex-liquidity/geckoterminal-shar` |
| ⬜ | [S-056](sustainability/S-056.md) | M | scalability | buildStabilityInputForDay recomputes the PSI universe twice per day in O(\|eligible coins\ |  | `worker/src/lib/psi-recompute.ts:L164-L165` |
| ⬜ | [S-058](sustainability/S-058.md) | S | scalability | tape-digest.ts digestByDay is a backward-compat shim that re-wraps mergeDigestedPages but  |  | `src/lib/tape-digest.ts:344-346` |
| ⬜ | [S-059](sustainability/S-059.md) | S | coupling | Hardcoded stablecoin IDs (usdt-tether, usdc-circle, usds-sky/dai-makerdao) in presentation |  | `src/lib/homepage-static-snapshot.ts:57-63, src/l` |
| ⬜ | [S-060](sustainability/S-060.md) | L | scalability | Heavy OG-image stack (satori + 2 WASM modules) statically bundled into the single hot API/ |  | `worker/src/routes/dynamic-routes.ts:12, worker/s` |
| ⬜ | [S-061](sustainability/S-061.md) | M | dependency | Worker depends on full viem (53M) only for pure ABI encode/decode helpers from viem/utils |  | `worker/package.json:dependencies.viem (2.51.3); ` |
| ⬜ | [S-063](sustainability/S-063.md) | M | complexity | public.ts handlers carry deep nesting and ~21 repeated console.error/.catch boilerplate |  | `worker/src/api/api-key-requests/public.ts:63-204` |
| ⬜ | [S-064](sustainability/S-064.md) | M | coupling | stablecoin-detail-view-model re-exports a large surface of another module, acting as a bar |  | `src/lib/stablecoin-detail-view-model.ts:56-70, 9` |
| ⬜ | [S-065](sustainability/S-065.md) | M | scalability | backfill-stability-index uses a fixed-name physical rebuild table (DROP/CREATE stability_i |  | `worker/src/api/backfill-stability-index.ts:38-47` |
| ⬜ | [S-066](sustainability/S-066.md) | M | config | Per-cron connection budgets are 48 hand-maintained literals coupled to runtime fan-out the |  | `shared/lib/cron-jobs.ts:91-208 (maxConnections/c` |
| ⬜ | [S-142](sustainability/S-142.md) | M | scalability | ensureCanonicalIncidents issues N sequential D1 round-trips per unlinked event |  | `worker/src/lib/depeg-resolver-incident-store.ts:` |

### Low (101)

| | ID | E | Category | Title | Owner | Loc |
|---|---|---|---|---|---|---|
| ⬜ | [S-003](sustainability/S-003.md) | S | coupling | groups.find('Fiat') repeated three times in render — fragile string coupling |  | `src/components/peg-distribution-grid.tsx:L90, L9` |
| ⬜ | [S-006](sustainability/S-006.md) | S | complexity | Confusingly-named warnStartSec / warnEndSec parameters invert semantic expectation |  | `worker/src/cron/telegram-inactive-cleanup.ts:L96` |
| ⬜ | [S-009](sustainability/S-009.md) | S | coupling | Data-access layer telegram-store/disambiguation.ts imports from the API parsing layer |  | `worker/src/api/telegram-store/disambiguation.ts:` |
| ⬜ | [S-010](sustainability/S-010.md) | S | testing | No CI gate validates annotation object keys against the stablecoin coin registry |  | `shared/data/annotations/__tests__/curated-annota` |
| ⬜ | [S-011](sustainability/S-011.md) | S | config | Two methodology sections hardcode versionLabel as a string literal instead of a version co |  | `src/app/methodology/sections/monitoring/contagio` |
| ⬜ | [S-012](sustainability/S-012.md) | S | dead-code | command-palette 'view' verb is parsed and routed but always returns false / 'not yet shipp |  | `src/components/command-palette-actions.ts:L53-L5` |
| ⬜ | [S-016](sustainability/S-016.md) | S | complexity | Synthetic 1-second effectiveAt increments encode sort order for same-day entries |  | `shared/data/methodology-changelogs/depeg-dews/v6` |
| ⬜ | [S-017](sustainability/S-017.md) | M | coupling | repair-non-usd-fiat-depeg-history.ts uses module-scope mutable D1 and operation-mode const |  | `worker/scripts/repair-non-usd-fiat-depeg-history` |
| ⬜ | [S-019](sustainability/S-019.md) | S | coupling | currentVersion string in lib files is manually synced with the top entry version in data f |  | `shared/lib/methodology-versions/yield-methodolog` |
| ⬜ | [S-020](sustainability/S-020.md) | S | complexity | getChainTrackedDeploymentCount calls getTrackedDeploymentsForChain which re-scans all 406  |  | `src/app/chains/static-chain-content.ts:L75-L113` |
| ⬜ | [S-021](sustainability/S-021.md) | S | config | check-cron-schedule-sync.ts reads wrangler.toml with a relative path and no explicit root  |  | `scripts/ci/check-cron-schedule-sync.ts:L15` |
| ⬜ | [S-023](sustainability/S-023.md) | M | coupling | exit-route-map.tsx hard-codes SVG coordinate literals with no connection to EXIT_ROUTE_SCE |  | `src/components/exit-route-map.tsx:L203-L348` |
| ⬜ | [S-045](sustainability/S-045.md) | S | config | NO_FREEZE_IMPL hardcoded implementation address bypasses probe for the known-safe impl |  | `worker/src/cron/sync-usds-status.ts:17-18,99` |
| ⬜ | [S-046](sustainability/S-046.md) | S | scalability | Module-scope mutable Map in fx-rate-state.ts grows unboundedly across isolate lifetime |  | `worker/src/lib/fx-rate-state.ts:L183-L218` |
| ⬜ | [S-054](sustainability/S-054.md) | M | coupling | variants.ts hard-wires the module-level ACTIVE_META_BY_ID singleton, preventing isolated t |  | `shared/lib/stablecoins/variants.ts:L19-L28` |
| ⬜ | [S-057](sustainability/S-057.md) | S | scalability | alt-peg-packing O(n²) collision loop with fixed 90-iteration cap may silently under-separa |  | `src/lib/alt-peg-packing.ts:L83-L151` |
| ✅ | [S-067](sustainability/S-067.md) | S | config | hotspot-ratchet.mjs imports `fs` and `path` without the `node:` protocol prefix | codex | `scripts/lib/hotspot-ratchet.mjs:L1-L2` |
| ✅ | [S-068](sustainability/S-068.md) | S | config | Hardcoded stability-index URLs in check-seo-static.mjs bypass the PHAROS_ORIGIN constant | codex | `scripts/ci/check-seo-static.mjs:L1137-L1141` |
| ✅ | [S-069](sustainability/S-069.md) | S | config | build-l2beat-bridge-route-candidates.ts uses fragile suffix-match to detect its own entry  | codex | `scripts/maintenance/build-l2beat-bridge-route-ca` |
| ⬜ | [S-070](sustainability/S-070.md) | S | docs | fetch-slipstream.ts zero volume is undocumented as a known API limitation |  | `worker/src/cron/dex-liquidity/fetch-slipstream.t` |
| ⬜ | [S-071](sustainability/S-071.md) | S | config | Footer lighthouse beam animation is injected via dangerouslySetInnerHTML while all other p |  | `src/components/footer.tsx:31-43, 48` |
| ⬜ | [S-072](sustainability/S-072.md) | S | config | SLOT_EXECUTION_RETENTION_SEC computed with raw 60-second multiplier instead of named const |  | `worker/src/cron/prune-cron-history.ts:10` |
| ⬜ | [S-073](sustainability/S-073.md) | S | testing | Filename-to-dateRange.to convention is untested |  | `src/data/changelogs/__tests__/index.test.ts:L28-` |
| ⬜ | [S-074](sustainability/S-074.md) | M | complexity | Projector boilerplate (watermark read, since/until, limit, dryRun) is copy-pasted across 6 |  | `worker/src/lib/tape-projectors/score.ts:L40-L46,` |
| ⬜ | [S-075](sustainability/S-075.md) | S | coupling | Unnecessary optional chain on a statically-typed non-optional AbortSignal |  | `worker/src/cron/sync-live-reserves.ts:268, worke` |
| ⬜ | [S-076](sustainability/S-076.md) | S | coupling | LRU delete+set promotion in getCachedApiKeyByPrefix is undocumented, creating maintenance  |  | `worker/src/lib/api-key-core.ts:L404-L418` |
| ⬜ | [S-077](sustainability/S-077.md) | S | docs | timeline/page.tsx stamps TIMELINE_DATE_MODIFIED with build-time new Date() at module scope |  | `src/app/timeline/page.tsx:25` |
| ⬜ | [S-078](sustainability/S-078.md) | S | coupling | toTimestampMs from yield-history-chart-model is imported by a page-level module, coupling  |  | `src/components/yield-history-chart-model.ts:L203` |
| ⬜ | [S-079](sustainability/S-079.md) | S | config | PEG_FILTER_OPTIONS is a hardcoded three-entry subset with no documentation of the selectio |  | `shared/lib/classification/pegs.ts:L416-L421` |
| ⬜ | [S-080](sustainability/S-080.md) | S | config | Worker runtime binding order numbers in env-contract registry are non-unique across status |  | `shared/lib/env-contract/registry.ts:L200-272` |
| ⬜ | [S-081](sustainability/S-081.md) | S | config | render-env-example.ts applies an initial alphabetical sort that is unconditionally discard |  | `shared/lib/env-contract/render-env-example.ts:L1` |
| ⬜ | [S-082](sustainability/S-082.md) | S | error-handling | eEARN admin-configurable fee hardcoded as 0 with no enforcement of noted future telemetry |  | `shared/lib/redemption-backstop-configs/stablecoi` |
| ⬜ | [S-083](sustainability/S-083.md) | L | complexity | weekly-recap.ts is a 1302-line monolith mixing data collection, aggregation, and LLM orche |  | `worker/src/cron/weekly-recap.ts:L1-L1302` |
| ⬜ | [S-084](sustainability/S-084.md) | S | naming | Commit hash lengths are inconsistent across entries — 7-char vs 8-char |  | `src/data/changelogs/2026-03-08.ts:L18, src/data/` |
| ⬜ | [S-085](sustainability/S-085.md) | S | coupling | `aria-label` hard-codes `CPI-linked stablecoins` in ConstellationCohort |  | `src/app/alt-pegs/fiat-world-atlas/constellation-` |
| ⬜ | [S-086](sustainability/S-086.md) | M | complexity | GATED_SENTINEL magic string is an undocumented out-of-band signal across a function bounda |  | `worker/src/api/webhook-commands/action-runner.ts` |
| ⬜ | [S-087](sustainability/S-087.md) | M | config | Bot username hardcoded as a plain string constant PHAROS_BOT_USERNAMES in telegram-webhook |  | `worker/src/api/telegram-webhook.ts:L106` |
| 🚫 | [S-088](sustainability/S-088.md) | S | config | Large-flow severity thresholds are module-private magic numbers with no shared constant |  | `worker/src/lib/tape-projectors/mint-burn.ts:L36-` |
| ⬜ | [S-089](sustainability/S-089.md) | S | scalability | MAX_DELETIONS_PER_RUN and MAX_WARNINGS_PER_RUN are undocumented magic numbers with no obse |  | `worker/src/cron/telegram-inactive-cleanup.ts:L37` |
| ⬜ | [S-090](sustainability/S-090.md) | S | config | changelog-page-utils.ts is a single-function module consumed in only one place |  | `src/app/methodology/changelog-page-utils.ts:L1-L` |
| ⬜ | [S-091](sustainability/S-091.md) | S | hardcoded-values | TELEGRAM_ESTIMATED_CAPACITY_WATCHERS is an undocumented magic number with no review trigge |  | `src/app/pharoswatchbot/telegram-pulse-strip.tsx:` |
| ⬜ | [S-092](sustainability/S-092.md) | S | scalability | upsert-github-pr-comment.mjs fetches only first 100 PR comments; old contract comment not  |  | `scripts/ci/upsert-github-pr-comment.mjs:L55, L59` |
| ⬜ | [S-093](sustainability/S-093.md) | S | docs | Spike detection constants in yield-history-chart-model have no documented rationale |  | `src/components/yield-history-chart-model.ts:L16-` |
| ⬜ | [S-094](sustainability/S-094.md) | M | complexity | applyTrackedReviewedDocs mutation-after-export pattern used in 5 files creates fragile ini |  | `shared/lib/redemption-backstop-configs/offchain-` |
| ⬜ | [S-095](sustainability/S-095.md) | S | coupling | variant-display.ts is a pass-through re-export with no added value |  | `src/lib/variant-display.ts:L1` |
| ⬜ | [S-096](sustainability/S-096.md) | S | config | non-usd-share hardcodes the 86400 day literal six times instead of importing DAY_SECONDS |  | `worker/src/api/non-usd-share.ts:67,77,78,94,96,9` |
| ⬜ | [S-097](sustainability/S-097.md) | S | config | Hard-coded public Ethereum RPC in reconcile-blacklist-events-from-kyc-rip.ts |  | `worker/scripts/reconcile-blacklist-events-from-k` |
| ⬜ | [S-098](sustainability/S-098.md) | M | coupling | Forbidden tics list maintained in two places: voice-guards.ts and WEEKLY_SYSTEM_PROMPT pro |  | `worker/src/cron/daily-digest/voice-guards.ts:L2-` |
| ⬜ | [S-099](sustainability/S-099.md) | S | config | Hardcoded Sky LitePSM contract addresses and RPC URLs in sky-makercore.ts are not sourced  |  | `worker/src/cron/reserve-adapters/sky-makercore.t` |
| ⬜ | [S-100](sustainability/S-100.md) | S | scalability | LOGGED_STATUS_PERSISTENCE_FAILURES Set grows without bound within an isolate |  | `worker/src/lib/status-reliability-shared.ts:L37,` |
| ⬜ | [S-101](sustainability/S-101.md) | S | clone | blacklist-gaps.ts hardcodes status string literals in SQL that duplicate the closed enum |  | `worker/src/lib/blacklist-gaps.ts:L168-L219` |
| ⬜ | [S-102](sustainability/S-102.md) | S | scalability | STRUCTURAL_SUPPLEMENTAL_CHART_CONFIGS throws at module initialization time if an unsupport |  | `worker/src/lib/stablecoin-charts-reconciliation.` |
| ✅ | [S-103](sustainability/S-103.md) | S | config | SEARCH_EVENT_LIMIT=10 in generate-depeg-event-search-data.ts is an unexplained magic const | codex | `scripts/maintenance/generate-depeg-event-search-` |
| ⬜ | [S-104](sustainability/S-104.md) | S | coupling | Priority case-study slugs in `page.tsx` are hardcoded strings with no validation at import |  | `src/app/learn/case-studies/page.tsx:L12-L31` |
| ⬜ | [S-105](sustainability/S-105.md) | S | scalability | NOTABLE_QUAKES in intervention-seismograph is a hardcoded static list with no growth path |  | `src/components/freezewatch/intervention-seismogr` |
| ⬜ | [S-106](sustainability/S-106.md) | S | complexity | report-card.tsx DimensionRow has an implicit coupling between dimKey string values and thr |  | `src/components/report-card.tsx:L191-L380` |
| ⬜ | [S-107](sustainability/S-107.md) | M | documentation | screener handoff maps engine's pegScore exclusions to a different signal (safetyPegStabili |  | `shared/lib/selector/answers-to-screener.ts:L86, ` |
| ⬜ | [S-108](sustainability/S-108.md) | S | config | Balancer chain-map is a local duplicate of chain-registry and will silently miss new chain |  | `worker/src/cron/dex-liquidity/fetch-balancer.ts:` |
| ⬜ | [S-109](sustainability/S-109.md) | S | naming | getArchiveFallbackRpcUrls misleadingly implies archive-node capability |  | `worker/src/lib/public-rpc-registry.ts:27-30` |
| ⬜ | [S-110](sustainability/S-110.md) | M | scalability | Chainlink reference feed fetching is fully serialized with two sequential RPC calls per fe |  | `worker/src/lib/chainlink-feeds.ts:L236-L284` |
| ⬜ | [S-111](sustainability/S-111.md) | S | coupling | GLOSSARY_JUMP_RAIL_LETTERS is a static hardcoded A-Z alphabet, independent of which letter |  | `src/app/learn/glossary/content.ts:L28-L55` |
| ⬜ | [S-112](sustainability/S-112.md) | S | scalability | home-alt-hero-live-chart.tsx hard-codes four specific stablecoin IDs for cohort history |  | `src/components/home-alt-hero-live-chart.tsx:L35-` |
| ✅ | [S-113](sustainability/S-113.md) | S | documentation | lighthouse-static-export.mjs pins a specific Lighthouse version via npx string but has no  | codex | `scripts/maintenance/lighthouse-static-export.mjs` |
| ⬜ | [S-114](sustainability/S-114.md) | S | scalability | inline-homepage-critical-css.mjs processes ~800 HTML files sequentially at ~60ms each |  | `scripts/maintenance/inline-homepage-critical-css` |
| ⬜ | [S-115](sustainability/S-115.md) | M | scalability | smoke-api.mjs REDEMPTION_ENUMS const is 60+ entries in a single 450-line file that accumul |  | `scripts/maintenance/smoke-api.mjs:L280-L346` |
| ⬜ | [S-116](sustainability/S-116.md) | S | scalability | buildCemeteryYearSections assumes coins are pre-sorted by date; no guard on malformed deat |  | `src/lib/cemetery.ts:10-28` |
| ⬜ | [S-117](sustainability/S-117.md) | S | dependency | LightApiFetchError is a stripped-down duplicate of ApiFetchError without the status or bod |  | `src/lib/light-api-client.ts:7-12, src/lib/api.ts` |
| ⬜ | [S-118](sustainability/S-118.md) | M | scalability | Fluid pool enrichment makes 3 concurrent RPC calls sequentially per pool, risks connection |  | `worker/src/cron/dex-liquidity/fetch-fluid.ts:L87` |
| ⬜ | [S-119](sustainability/S-119.md) | S | dead-code | telegram-pending-queue.ts is a trivial compatibility barrel with no added value |  | `worker/src/cron/telegram-pending-queue.ts:L1-L3` |
| ⬜ | [S-120](sustainability/S-120.md) | S | config | TVL/seconds-per-year thresholds hardcoded inline instead of using the named constants besi |  | `worker/src/cron/yield-sync/sources-optional-prot` |
| ✅ | [S-121](sustainability/S-121.md) | S | config | SAFE_SCORE_THRESHOLD and RISKY_SCORE_THRESHOLD are undocumented magic numbers not linked t | codex | `worker/src/lib/flight-to-quality-classification.` |
| ⬜ | [S-122](sustainability/S-122.md) | S | config | Hardcoded 30-second Etherscan timeout in evm-logs with no caller override path |  | `worker/src/lib/evm-logs.ts:L284` |
| ⬜ | [S-123](sustainability/S-123.md) | S | complexity | yield-health.ts buildCoverageAuditQueue maintains two parallel legacy-item construction pa |  | `worker/src/lib/status/yield-health.ts:L464-L531` |
| ⬜ | [S-124](sustainability/S-124.md) | S | scalability | Sub-decimal countdown versioning (3.997, 5.99…) creates a finite runway with no migration  |  | `shared/data/methodology-changelogs/blacklist-tra` |
| ⬜ | [S-125](sustainability/S-125.md) | S | coupling | Chain profile page duplicates plural/singular helper functions already present or triviall |  | `src/app/chains/[chain]/page.tsx:43-45, 79-81` |
| ⬜ | [S-126](sustainability/S-126.md) | S | coupling | useJustEntered in screener-toolbar reimplements animation-entrance tracking that could be  |  | `src/components/screener/screener-toolbar.tsx:L40` |
| ⬜ | [S-127](sustainability/S-127.md) | M | docs | depeg-resolver-reviewer-module.tsx renders feature-flag-gated UI with no fallback skeleton |  | `src/components/depeg-resolver-reviewer-module.ts` |
| ⬜ | [S-128](sustainability/S-128.md) | M | config | FxSyncRunState has multiple public mutable fields with no setter guard |  | `worker/src/cron/sync-fx-rates-helpers.ts:170-175` |
| ⬜ | [S-129](sustainability/S-129.md) | S | config | Changelog route factory hardcodes 'from v1.0' in lead text without validating the actual f |  | `src/app/methodology/changelog-route-factory.tsx:` |
| ⬜ | [S-130](sustainability/S-130.md) | S | docs | Glossary methodology version pins are manually maintained and can drift from the versioned |  | `src/app/learn/glossary/content.ts:L65-L229` |
| ⬜ | [S-131](sustainability/S-131.md) | S | dead-code | blacklist/page.tsx is a legacy redirect wrapper that renders FreezeWatchClient under a noi |  | `src/app/blacklist/page.tsx:L1-L30` |
| ⬜ | [S-132](sustainability/S-132.md) | S | modularity | BACKING_SENTENCE_LABELS is a local Record covering the entire BackingType union without ex |  | `src/components/stablecoin-detail/hero-card-ident` |
| ✅ | [S-133](sustainability/S-133.md) | S | config | backfill-ai-summary-provenance.mjs hard-codes model name 'claude-opus-4-7' that will becom | codex | `scripts/maintenance/backfill-ai-summary-provenan` |
| ✅ | [S-134](sustainability/S-134.md) | S | config | Magic 400ms and 500ms Playwright settle delays are undocumented and fragile on slow CI run | codex | `scripts/maintenance/build-og-editorial.mjs:L194,` |
| ✅ | [S-135](sustainability/S-135.md) | S | config | getStatusPageActions falls back to probePath for status page action path, which is semanti | codex | `shared/lib/api-endpoints/status.ts:L9-10` |
| ⬜ | [S-136](sustainability/S-136.md) | S | coupling | Duplicated isBlacklistStablecoin guard across blacklist endpoints |  | `worker/src/api/blacklist-summary.ts:65-67 (dupli` |
| ⬜ | [S-137](sustainability/S-137.md) | S | coupling | intake.ts mutates the upstream DefiLlama payload array in-place six times |  | `worker/src/cron/sync-stablecoins/intake.ts:243,2` |
| ⬜ | [S-138](sustainability/S-138.md) | S | type-safety | safetyScores map shape re-declared inline instead of reusing SafetyResult / SafetyScoreSna |  | `worker/src/cron/yield-sync/state-loading.ts:60-6` |
| ⬜ | [S-139](sustainability/S-139.md) | S | config | SUPPORTED_COINGECKO_NATIVE_PEG_CURRENCIES hardcoded in native-peg-quotes with no shared re |  | `worker/src/lib/native-peg-quotes.ts:L15-L37` |
| ⬜ | [S-140](sustainability/S-140.md) | S | dead-code | DdrCoinStructural carries fields the engine never reads (deploymentModel) or only the work |  | `shared/lib/depeg-resolver/inputs.ts:21-24 (deplo` |
| ⬜ | [S-141](sustainability/S-141.md) | S | config | GHO_TOKEN contract address is hardcoded in gho.ts with no mechanism to override per-config |  | `worker/src/cron/reserve-adapters/gho.ts:L19` |
| ⬜ | [S-143](sustainability/S-143.md) | S | coupling | Tracked-asset chain:address key construction is inconsistent across supplemental sources |  | `worker/src/cron/yield-sync/sources-optional-prot` |
| ⬜ | [S-144](sustainability/S-144.md) | M | coupling | Report-card detail strings are serialized then re-parsed via fragile ': ' splitting |  | `shared/lib/report-card-detail.ts:3-29` |
| ⬜ | [S-145](sustainability/S-145.md) | M | config | Inconsistent logging: structured logWorkerEvent in admin.ts vs raw console.* in public.ts/ |  | `worker/src/api/api-key-requests/admin.ts:213-228` |
| ⬜ | [S-146](sustainability/S-146.md) | S | scalability | Orphan-claim cleanup UPDATE runs inline (awaited) on every public submission |  | `worker/src/api/api-key-requests/public.ts:103-10` |
| ⬜ | [S-147](sustainability/S-147.md) | M | config | Ops-admin proxy hardcodes per-path timeout overrides as inline magic constants |  | `functions/api/admin/[[path]].ts:42-65` |
| ⬜ | [S-148](sustainability/S-148.md) | S | documentation | compareYieldPegs omits USD/SGD/MXN from YIELD_PEG_PRIORITY with no note, relying on filter |  | `src/lib/yield-view-model.ts:208-234, 389-400` |
| ⬜ | [S-149](sustainability/S-149.md) | S | coupling | Per-isolate detailRefreshesInFlight de-dupe map gives no protection across isolates; docum |  | `worker/src/api/stablecoin-detail.ts:14,16-51` |
| ⬜ | [S-150](sustainability/S-150.md) | S | config | Hardcoded magic-number RPC URL, multiplier haircut, and per-vault address constants embedd |  | `worker/src/lib/authoritative-price-sources/erc46` |
| ⬜ | [S-151](sustainability/S-151.md) | M | docs | No ADR/decision record surface for the many locked architectural choices |  | `docs/ (no adr/ or decisions/ dir — `find docs -i` |
| ⬜ | [S-152](sustainability/S-152.md) | S | coupling | Confirmation-time alias writes depend on map iteration order |  | `worker/src/cron/depeg-resolver/incident-state.ts` |
