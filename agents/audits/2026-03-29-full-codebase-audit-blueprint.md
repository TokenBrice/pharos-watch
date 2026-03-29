# Stablecoin Dashboard Full Codebase Audit Blueprint

Date: 2026-03-29

Scope: full-repository review across `src/`, `shared/`, `worker/src/`, `functions/`, `scripts/`, `docs/`, `.github/workflows/`, `package.json`, and `worker/package.json`.

Audit basis:
- Repository inventory reviewed across frontend, worker, shared runtime, Pages Functions, scripts, docs, and workflows.
- Source surface reviewed: `src/` 529 files, `shared/` 124, `worker/src/` 599, `functions/` 7, `scripts/` 39.
- Local validation observed:
  - `npm run lint`
  - `npm run typecheck`
  - `cd worker && npx tsc --noEmit`
  - `npm test` -> 362 files passed, 3525 tests passed, 1 todo
  - `npm audit --audit-level=high --omit=dev` -> 0 vulnerabilities
  - `npm run check:unused-code` -> passed
  - `npm run check:shared-cycles` -> passed
  - `npm run check:hotspot-ratchet` -> passed
- Additional agent verification reported:
  - `npm run build` -> passed
  - `npm run test:merge-gate` -> skipped cleanly on a no-diff tree
  - clone scan via `jscpd`

## 1. Executive Summary

### Findings Count

| Pillar | Total | High | Medium | Low |
| --- | ---: | ---: | ---: | ---: |
| Redundancy elimination | 16 | 9 | 6 | 1 |
| Code quality improvement | 4 | 2 | 2 | 0 |
| Sustainability / maintainability | 4 | 0 | 2 | 2 |
| **Total** | **24** | **11** | **10** | **3** |

### Top 5 Findings Across All Pillars

1. `Q1` High: Binance depeg-confirmation probes do not record circuit outcomes, so a degraded upstream can be retried indefinitely. Location: [worker/src/cron/confirm-pending-depegs.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L98).
2. `Q2` High: unexpected `dex_prices` DB failures are converted into empty data, masking real persistence/query regressions on both API and depeg-confirmation paths. Locations: [worker/src/api/dex-liquidity.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/dex-liquidity.ts#L228), [worker/src/lib/depeg-helpers.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/depeg-helpers.ts#L60).
3. `Q3` High: Bluechip cache JSON is trusted on both write and read paths without schema validation, allowing malformed cache content to contaminate downstream report-card scoring. Locations: [worker/src/cron/sync-bluechip.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-bluechip.ts#L68), [worker/src/lib/report-cards-snapshot.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/report-cards-snapshot.ts#L186).
4. `R1` High: FX peg mapping and validation rules are duplicated between scheduled and realtime paths, creating drift risk in a sensitive pricing surface. Locations: [worker/src/cron/sync-fx-rates.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-fx-rates.ts#L35), [worker/src/lib/fx-realtime.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/fx-realtime.ts#L9).
5. `S2` Medium: the hotspot backlog is explicit, but several very large operational modules still concentrate too much logic and keep review/change locality weak. Scope: [scripts/lib/hotspot-ratchet-baseline.json](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/hotspot-ratchet-baseline.json#L122), [worker/src/cron/daily-digest.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest.ts), [worker/src/cron/daily-digest/collectors.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest/collectors.ts), [worker/src/lib/live-reserves-store.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/live-reserves-store.ts), [worker/src/cron/yield-sync/sources.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/sources.ts).

### Health Scores

| Pillar | Score | Justification |
| --- | ---: | --- |
| Redundancy elimination | 7/10 | Duplication is real but mostly localized; there is little dead code and existing guardrails already catch some structural drift. |
| Code quality improvement | 8/10 | Lint, typecheck, worker typecheck, and the full test suite are clean; the meaningful issues sit at a few trust and degraded-mode boundaries. |
| Sustainability / maintainability | 7/10 | Build/deploy discipline and docs are strong, but hotspot concentration, regex-based doc-sync, and partially centralized origin handling will keep compounding maintenance cost. |

Estimated technical debt profile: roughly `10-12%` of the codebase’s maintenance-relevant surface is affected by significant findings. The debt is concentrated in worker cron/API boundary logic, a small number of shared/config surfaces, and a backlog of intentionally tolerated large modules.

## 2. Findings by Pillar

### Redundancy Elimination

#### High

`R1` High
- Location: [worker/src/cron/sync-fx-rates.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-fx-rates.ts#L35), lines 35-107; [worker/src/lib/fx-realtime.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/fx-realtime.ts#L9), lines 9-72.
- Issue: FX currency-to-peg mapping, rate bounds, and validation logic are duplicated between the scheduled sync and realtime helper.
- Recommendation: move peg config and plausibility rules into one shared module and have both paths consume it.

`R2` High
- Location: [worker/src/cron/sync-stablecoins/pricing.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/pricing.ts#L207), lines 207-244 and lines 285-320.
- Issue: `applyPrimaryPriceResults()` and `applyGtProbeResults()` repeat the same validation/accept/reject control flow with only source-specific differences.
- Recommendation: extract a single price-application helper parameterized by source label and validation context.

`R3` High
- Location: [worker/src/cron/sync-stablecoins/supplemental-assets.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/supplemental-assets.ts#L119), lines 119-154 and lines 238-290.
- Issue: silver and gold supplemental assets are assembled through near-identical `PeggedAsset` construction blocks.
- Recommendation: factor a shared supplemental asset builder with source-specific callbacks for `mcap`, `priceResolution`, and optional history.

`R4` High
- Location: [worker/src/cron/yield-sync/resolve.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/resolve.ts#L595), lines 595-612 and lines 656-673.
- Issue: deterministic and dynamic lending-pool auto-discovery branches assemble the same resolved-yield object and bookkeeping.
- Recommendation: extract a shared append/build helper for resolved yield rows.

`R5` High
- Location: [worker/src/cron/dex-liquidity/fetch-primary.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/fetch-primary.ts#L411), lines 411-440 and lines 522-550.
- Issue: UniV3 and Aerodrome parsing both normalize token observations into the same `SubgraphPriceObservation` shape.
- Recommendation: split pool-specific price derivation from shared observation mapping.

`R6` High
- Location: [worker/src/cron/dex-liquidity/fetch-crawlers.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/fetch-crawlers.ts#L122), lines 122-149 and lines 241-267.
- Issue: `mergeCgPools()` and `mergeGtPools()` repeat the same stablecoin-to-metrics merge loop.
- Recommendation: create a generic pool-merge helper and keep source-specific differences in thin adapters.

`R7` High
- Location: [worker/src/lib/live-reserves-store.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/live-reserves-store.ts#L331), lines 331-345 and lines 371-385.
- Issue: row-to-record conversion for `reserve_sync_state` is duplicated across single-row and batched loaders, along with select-column lists.
- Recommendation: extract a row mapper and shared column constant.

`R8` High
- Location: [worker/src/cron/status-self-check.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/status-self-check.ts#L202), lines 202-217 and lines 273-288.
- Issue: internal and external probe paths build nearly identical `ProbeResult` objects.
- Recommendation: centralize `ProbeResult` construction behind a helper.

`R9` High
- Location: [worker/src/api/stability-index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/stability-index.ts#L28), lines 28-58 and lines 61-91.
- Issue: `decodePsiComponents()` and `decodePsiInputSnapshot()` are copy-paste siblings with only context labels changed.
- Recommendation: extract a generic PSI JSON decode/validation helper.

#### Medium

`R10` Medium
- Location: [worker/src/api/discovery.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/discovery.ts#L57), lines 57-69; [worker/src/api/status-supplements.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/status-supplements.ts#L159), lines 159-171.
- Issue: `discovery_candidates` row mapping is duplicated across two API surfaces.
- Recommendation: move row mapping into a shared worker library helper.

`R11` Medium
- Location: [worker/src/api/backfill-supply-history.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-supply-history.ts#L36), lines 36-70 and 209-243; [worker/src/api/stablecoin-detail/commodity.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/stablecoin-detail/commodity.ts#L100), lines 100-131.
- Issue: CoinGecko market-chart plus coin-detail fetch/sanity-check flows are duplicated across backfill and commodity detail paths.
- Recommendation: centralize the CoinGecko commodity loader and keep only response/persistence logic local.

`R12` Medium
- Location: [src/components/psi-history-chart.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/psi-history-chart.tsx#L354), lines 354-361; [src/app/stability-index/client.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/stability-index/client.tsx#L579), lines 579-586.
- Issue: PSI chart-data assembly is duplicated between the page client and chart component.
- Recommendation: extract a shared `buildPsiChartData()` helper near the PSI view-model layer.

`R13` Medium
- Location: [src/hooks/use-blacklist-events.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-blacklist-events.ts#L30), lines 30-42; [src/lib/blacklist-api.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/blacklist-api.ts#L25), lines 25-36.
- Issue: blacklist event query-parameter normalization is repeated in the hook and fetch helper.
- Recommendation: expose one canonical param builder or path builder from `src/lib/blacklist-api.ts`.

`R14` Medium
- Location: [src/components/homepage-client.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/homepage-client.tsx#L326), lines 326-337; [src/components/stablecoin-filtered-table.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/stablecoin-filtered-table.tsx#L26), lines 26-38.
- Issue: both components rebuild the same lookup maps from peg summary and report-card data.
- Recommendation: move shared lookup-map builders into a small frontend utility.

`R15` Medium
- Location: [src/styles/tokens/semantic.css](/Users/ahirice/Documents/git/stablecoin-dashboard/src/styles/tokens/semantic.css#L155), lines 155-164 and lines 276-285.
- Issue: sidebar width tokens are defined twice with identical values in both light and dark theme blocks.
- Recommendation: hoist unchanged sidebar dimensions to the root token block.

#### Low

`R16` Low
- Location: [worker/src/cron/yield-sync/variant-scanner.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/variant-scanner.ts#L36), lines 36-52 and lines 55-70.
- Issue: wrapper-token scanning repeats the same match-and-push structure for prefix and suffix patterns.
- Recommendation: extract a single matcher helper that accepts the trim strategy.

### Code Quality Improvement

#### High

`Q1` High
- Location: [worker/src/cron/confirm-pending-depegs.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L98), lines 98-107, function `confirmPendingDepegs`.
- Issue: the Binance confirmation probe checks the circuit breaker before fetching but never records success or failure afterward.
- Why it matters: a degraded upstream can be retried forever, wasting request budget and weakening the depeg-confirmation protection path.
- Recommendation: record outcome through `recordOutcomeSafe` or an equivalent wrapper and add a regression test for repeated Binance failure.

`Q2` High
- Location: [worker/src/api/dex-liquidity.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/dex-liquidity.ts#L228), lines 228-236; [worker/src/lib/depeg-helpers.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/depeg-helpers.ts#L60), lines 60-72.
- Issue: unexpected `dex_prices` query failures are caught and treated as empty data instead of a real failure or degraded state.
- Why it matters: DB corruption or query regressions can look like legitimate empty results in both public API output and depeg confirmation.
- Recommendation: only suppress the known missing-table case; propagate or explicitly degrade all other errors.

`Q3` High
- Location: [worker/src/cron/sync-bluechip.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-bluechip.ts#L68), lines 68-76 and 183-186; [worker/src/lib/report-cards-snapshot.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/report-cards-snapshot.ts#L186), lines 186-193.
- Issue: Bluechip cache JSON is trusted without runtime schema validation on both write and read paths.
- Why it matters: malformed cache content can silently distort downstream report-card scoring.
- Recommendation: add a shared schema validator and treat invalid cache shape as degraded data with explicit tests.

#### Medium

`Q4` Medium
- Location: [worker/src/cron/daily-digest.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest.ts#L265), lines 265-266, function `generateDailyDigest`.
- Issue: the worker logs the full Claude prompt payload before calling Anthropic.
- Why it matters: this creates unnecessary internal-data exposure and oversized logs on a scheduled path.
- Recommendation: replace the full prompt dump with concise metadata logging or gate prompt logging behind an explicit debug flag with redaction.

### Sustainability and Maintainability

#### Medium

`S1` Medium
- Location: [scripts/lib/doc-sync/shared.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/doc-sync/shared.ts#L35), lines 35-38, 64-78, 86-127, 150-159; [scripts/lib/doc-sync/checks.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/doc-sync/checks.ts#L25), lines 25-30, 33-95, 97-180, 182-279.
- Issue: doc-sync still derives truth from regex scraping of source and markdown instead of structured manifests.
- Long-term consequence: harmless wording/formatting changes can break checks, while some semantic drift can still escape the scraper.
- Recommendation: shift versioned doc surfaces toward exported manifests or structured metadata and reduce regex parsing to fallback status.

`S2` Medium
- Scope: [scripts/lib/hotspot-ratchet-baseline.json](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/lib/hotspot-ratchet-baseline.json#L122), [worker/src/cron/daily-digest.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest.ts), [worker/src/cron/daily-digest/collectors.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest/collectors.ts), [worker/src/lib/live-reserves-store.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/live-reserves-store.ts), [worker/src/cron/yield-sync/sources.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/sources.ts), [src/app/methodology/sections/core-sections.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/methodology/sections/core-sections.tsx#L1), [src/app/methodology/sections/monitoring-sections.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/methodology/sections/monitoring-sections.tsx#L1).
- Issue: hotspot management is explicit, but several very large operational and methodology modules remain long-lived exceptions rather than being actively simplified.
- Long-term consequence: change locality stays poor, review cost remains high, and onboarding into these modules remains expensive.
- Recommendation: turn the hotspot queue into an owned simplification program with target budgets and explicit split plans for the largest operational modules first.

#### Low

`S3` Low
- Location: [shared/lib/runtime-origins.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/runtime-origins.ts#L1), [src/lib/site-config.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/site-config.ts#L1), [src/lib/api.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts#L9), [scripts/serve-static-export.mjs](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/serve-static-export.mjs#L55), [worker/src/cron/status-self-check.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/status-self-check.ts#L47), [worker/src/lib/telegram-webhook-registration.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/telegram-webhook-registration.ts#L1), [functions/lib/ops-origin.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/functions/lib/ops-origin.ts#L1), [functions/lib/ops-env.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/functions/lib/ops-env.ts#L1), [src/lib/page-metadata.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/page-metadata.ts#L117), [src/app/depeg/page.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/depeg/page.tsx#L18), [src/app/stability-index/page.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/stability-index/page.tsx#L13), [src/app/safety-scores/page.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/safety-scores/page.tsx#L18).
- Issue: origin handling is mostly centralized, but several metadata and runtime surfaces still re-resolve or hardcode URLs independently.
- Long-term consequence: host or deployment-topology changes still require multi-file edits and invite drift.
- Recommendation: push host/origin decisions through shared runtime-origin helpers and add a dedicated OG-image URL helper.

`S4` Low
- Location: [package.json](/Users/ahirice/Documents/git/stablecoin-dashboard/package.json#L83), [worker/package.json](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/package.json#L11).
- Issue: tooling dependencies lag current majors: `eslint` `9.39.4 -> 10.1.0`, `lucide-react` `0.577.0 -> 1.7.0`, `typescript` `5.9.3 -> 6.0.2`.
- Long-term consequence: upgrade cost compounds over time even though current vulnerability posture is clean.
- Recommendation: schedule isolated upgrade passes validated through the existing merge gate rather than batching them with product work.

## 3. Cross-Cutting Concerns

`C1` Sensitive market/risk ingestion logic is both duplicated and too willing to degrade silently.
- Connected findings: `R1`, `R2`, `R3`, `R5`, `R6`, `Q2`, `Q3`.
- Why it matters: the same worker domain that carries the most business-critical data logic also has the most duplication and the weakest error surfacing at a few trust boundaries.
- Priority: high.

`C2` Operational observability is uneven across cron paths.
- Connected findings: `Q1`, `Q4`, `R8`, `S2`.
- Why it matters: some paths over-log internal payloads while others under-record circuit outcomes, which means the repo has both noisy logs and blind spots in the same operational layer.
- Priority: high.

`C3` The repo has a strong single-source-of-truth direction, but several surfaces still stop short of it.
- Connected findings: `R9`, `R10`, `R11`, `R13`, `S1`, `S3`.
- Why it matters: duplicated decode/mapping/origin logic and regex-based doc scraping all represent incomplete centralization, which keeps drift risk alive.
- Priority: medium.

`C4` Hotspot concentration amplifies both redundancy and review cost.
- Connected findings: `R7`, `R11`, `Q4`, `S2`.
- Why it matters: several of the problematic or duplicated behaviors live inside modules the repo already knows are too large.
- Priority: medium.

## 4. Prioritized Remediation Roadmap

### Phase 1 - Quick Wins

| Ref | Action | Affected files / modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `Q4` | Remove or redact full prompt logging from the daily digest cron. | `worker/src/cron/daily-digest.ts` | Small | None |
| `R15` | Hoist duplicate sidebar width tokens to the root semantic token block. | `src/styles/tokens/semantic.css` | Small | None |
| `R13` | Centralize blacklist param normalization/path building. | `src/hooks/use-blacklist-events.ts`, `src/lib/blacklist-api.ts` | Small | None |
| `R14` | Extract shared peg-summary/report-card lookup builders. | `src/components/homepage-client.tsx`, `src/components/stablecoin-filtered-table.tsx` | Small | None |
| `R16` | Collapse prefix/suffix wrapper-token matching behind one helper. | `worker/src/cron/yield-sync/variant-scanner.ts` | Small | None |
| `R12` | Share PSI chart-data assembly between page client and chart component. | `src/components/psi-history-chart.tsx`, `src/app/stability-index/client.tsx` | Small | None |
| `S4` | Stage isolated dependency upgrade passes for the current lagging majors. | `package.json`, `worker/package.json`, lockfile | Small | None |

### Phase 2 - Targeted Refactoring

| Ref | Action | Affected files / modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `Q1` | Record circuit outcomes around the Binance confirmation probe and add regression coverage. | `worker/src/cron/confirm-pending-depegs.ts`, related tests | Small-Medium | None |
| `Q2` | Stop swallowing unexpected `dex_prices` failures; only suppress the known missing-table path. | `worker/src/api/dex-liquidity.ts`, `worker/src/lib/depeg-helpers.ts` | Medium | None |
| `Q3` | Validate Bluechip cache JSON at both write and read boundaries. | `worker/src/cron/sync-bluechip.ts`, `worker/src/lib/report-cards-snapshot.ts` | Medium | None |
| `R9` | Replace duplicated PSI JSON decoders with one generic helper. | `worker/src/api/stability-index.ts` | Small | None |
| `R10` | Share `discovery_candidates` row mapping across API consumers. | `worker/src/api/discovery.ts`, `worker/src/api/status-supplements.ts` | Small | None |
| `R7` | Centralize reserve-sync row mapping and select-column lists. | `worker/src/lib/live-reserves-store.ts` | Medium | None |
| `R8` | Extract common probe-result construction for internal/external status checks. | `worker/src/cron/status-self-check.ts` | Medium | None |
| `S1` | Replace regex-based doc scraping with exported manifests for versioned doc surfaces. | `scripts/lib/doc-sync/*`, related doc checks | Medium | None |
| `S3` | Standardize remaining origin/OG helpers on top of `shared/lib/runtime-origins.ts`. | `src/lib/page-metadata.ts`, route pages, `scripts/serve-static-export.mjs`, `worker/src/cron/status-self-check.ts`, `functions/lib/*` | Medium | None |

### Phase 3 - Structural Improvements

| Ref | Action | Affected files / modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `R1` | Centralize FX peg config and validation across scheduled and realtime paths. | `worker/src/cron/sync-fx-rates.ts`, `worker/src/lib/fx-realtime.ts` | Medium | None |
| `R2` | Unify price-application flow for primary and GT probe results. | `worker/src/cron/sync-stablecoins/pricing.ts` | Medium | None |
| `R3` | Build one supplemental asset constructor for commodity assets. | `worker/src/cron/sync-stablecoins/supplemental-assets.ts` | Medium | None |
| `R4` | Share resolved-yield row assembly in auto-discovery branches. | `worker/src/cron/yield-sync/resolve.ts` | Medium | None |
| `R5` | Separate subgraph-specific price derivation from shared observation mapping. | `worker/src/cron/dex-liquidity/fetch-primary.ts` | Medium | None |
| `R6` | Create a generic pool-merge helper for crawler imports. | `worker/src/cron/dex-liquidity/fetch-crawlers.ts` | Medium | None |
| `S2` | Convert the hotspot backlog into an owned simplification program with budgets and split plans. | `scripts/lib/hotspot-ratchet-baseline.json`, `docs/testing.md`, hotspot files | Large | None |

### Phase 4 - Strategic Overhauls

| Ref | Action | Affected files / modules | Effort | Dependencies |
| --- | --- | --- | --- | --- |
| `R11` | Unify CoinGecko commodity loading and sanity checks across backfill and detail paths. | `worker/src/api/backfill-supply-history.ts`, `worker/src/api/stablecoin-detail/commodity.ts` | Large | Prefer after `S2` hotspot simplification in adjacent worker surfaces |

## 5. Appendices

### Complete File-by-File Finding Index

| File / module | Findings |
| --- | --- |
| `src/app/safety-scores/page.tsx` | `S3` |
| `src/app/stability-index/client.tsx` | `R12` |
| `src/app/stability-index/page.tsx` | `S3` |
| `src/app/depeg/page.tsx` | `S3` |
| `src/components/homepage-client.tsx` | `R14` |
| `src/components/psi-history-chart.tsx` | `R12` |
| `src/components/stablecoin-filtered-table.tsx` | `R14` |
| `src/hooks/use-blacklist-events.ts` | `R13` |
| `src/lib/api.ts` | `S3` |
| `src/lib/blacklist-api.ts` | `R13` |
| `src/lib/page-metadata.ts` | `S3` |
| `src/lib/site-config.ts` | `S3` |
| `src/styles/tokens/semantic.css` | `R15` |
| `functions/lib/ops-env.ts` | `S3` |
| `functions/lib/ops-origin.ts` | `S3` |
| `package.json` | `S4` |
| `scripts/lib/doc-sync/checks.ts` | `S1` |
| `scripts/lib/doc-sync/shared.ts` | `S1` |
| `scripts/lib/hotspot-ratchet-baseline.json` | `S2` |
| `scripts/serve-static-export.mjs` | `S3` |
| `shared/lib/runtime-origins.ts` | `S3` |
| `worker/package.json` | `S4` |
| `worker/src/api/backfill-supply-history.ts` | `R11` |
| `worker/src/api/dex-liquidity.ts` | `Q2` |
| `worker/src/api/discovery.ts` | `R10` |
| `worker/src/api/stability-index.ts` | `R9` |
| `worker/src/api/status-supplements.ts` | `R10` |
| `worker/src/api/stablecoin-detail/commodity.ts` | `R11` |
| `worker/src/cron/confirm-pending-depegs.ts` | `Q1` |
| `worker/src/cron/daily-digest.ts` | `Q4`, `S2` |
| `worker/src/cron/daily-digest/collectors.ts` | `S2` |
| `worker/src/cron/dex-liquidity/fetch-crawlers.ts` | `R6` |
| `worker/src/cron/dex-liquidity/fetch-primary.ts` | `R5` |
| `worker/src/cron/status-self-check.ts` | `R8`, `S3` |
| `worker/src/cron/sync-bluechip.ts` | `Q3` |
| `worker/src/cron/sync-fx-rates.ts` | `R1` |
| `worker/src/cron/sync-stablecoins/pricing.ts` | `R2` |
| `worker/src/cron/sync-stablecoins/supplemental-assets.ts` | `R3` |
| `worker/src/cron/yield-sync/resolve.ts` | `R4` |
| `worker/src/cron/yield-sync/sources.ts` | `S2` |
| `worker/src/cron/yield-sync/variant-scanner.ts` | `R16` |
| `worker/src/lib/depeg-helpers.ts` | `Q2` |
| `worker/src/lib/fx-realtime.ts` | `R1` |
| `worker/src/lib/live-reserves-store.ts` | `R7`, `S2` |
| `worker/src/lib/report-cards-snapshot.ts` | `Q3` |
| `worker/src/lib/telegram-webhook-registration.ts` | `S3` |

### Dependency Audit Summary

| Package / audit | Current | Latest | Scope | Result |
| --- | --- | --- | --- | --- |
| `npm audit --omit=dev` | n/a | n/a | root | `0` vulnerabilities |
| `npm audit --omit=dev` | n/a | n/a | worker | `0` vulnerabilities |
| `eslint` | `9.39.4` | `10.1.0` | root tooling | Major upgrade pending |
| `lucide-react` | `0.577.0` | `1.7.0` | frontend UI | Major upgrade pending |
| `typescript` | `5.9.3` | `6.0.2` | root + worker tooling | Major upgrade pending |
| Redundant runtime dependencies | n/a | n/a | root + worker | none identified |

### Glossary

| Term | Meaning in this audit |
| --- | --- |
| Clone pair | Two code regions with materially identical logic or object-shape assembly. |
| Thin wrapper | A function, hook, or module that mostly forwards arguments or reshapes data without adding meaningful behavior. |
| Hotspot | A large or high-change file tracked as a complexity risk that should not keep growing unchecked. |
| Drift | Divergence between multiple sources of truth for config, logic, docs, or host/origin handling. |
| Trust boundary | A point where external input, cache content, DB state, or upstream responses must be validated before use. |
| Fail closed | Prefer explicit degraded/error handling over silently acting as though bad data were valid empty data. |
