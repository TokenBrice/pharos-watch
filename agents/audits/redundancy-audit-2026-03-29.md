# Redundancy Audit - Stablecoin Dashboard

Date: 2026-03-29

Scope: `src/`, `shared/`, `worker/src/`, `functions/`, `scripts/`, and docs only where they justified stale or duplicated surfaces. Build artifacts and untracked cache directories were excluded from findings.

## Inventory Summary

- Repo shape: Next.js 16 static export frontend, Cloudflare Worker API, shared runtime-neutral library, and supporting scripts/docs.
- Source surface: 529 files in `src/`, 124 in `shared/`, 599 in `worker/src/`, 7 in `functions/`, and 39 in `scripts/`.
- Guardrails verified: `npm run check:unused-code` passed, `npm run check:shared-cycles` passed, and `npm run check:hotspot-ratchet` passed.
- Clone scan: `jscpd` reported 22 clone pairs across TypeScript/TSX/CSS. After filtering framework-expected repetition and docs scaffolding, 16 findings remain actionable.
- Dead code / stale runtime modules: none found by the repo’s dead-code guard or manual review of the audited surfaces.
- Redundant third-party dependencies: none identified in the audited manifests.

## Executive Summary

- Total findings: 16
- By category: 15 duplication findings, 1 redundant-abstraction finding, 0 dead-code findings, 0 redundant-dependency findings
- Highest-value consolidation targets are concentrated in worker cron helpers and a few shared frontend data-shaping utilities
- Overall technical debt from redundancy: moderate, with most duplication localized rather than widely distributed

## Findings

### High Priority

1. `worker/src/cron/sync-fx-rates.ts:35-107` and `worker/src/lib/fx-realtime.ts:9-72`

   The FX currency-to-peg mapping, rate bounds, and validation logic are duplicated across the scheduled FX sync path and the realtime FX helper. The two files now maintain the same peg catalog and almost the same plausibility rules in parallel, which makes provider changes easy to drift.

   Remediation: move the shared peg map and bounds into a single config module, then have both callers consume that source instead of maintaining parallel literals.

2. `worker/src/cron/sync-stablecoins/pricing.ts:207-244` and `worker/src/cron/sync-stablecoins/pricing.ts:285-320`

   `applyPrimaryPriceResults()` and `applyGtProbeResults()` repeat the same validation/accept/reject flow for asset prices, differing only in the source filter and warning text. The repeated structure makes it harder to change price gating consistently.

   Remediation: extract a small helper that takes the candidate source, the validation context, and the warning label, then have both entry points call it.

3. `worker/src/cron/sync-stablecoins/supplemental-assets.ts:119-154` and `worker/src/cron/sync-stablecoins/supplemental-assets.ts:238-290`

   Silver and gold supplemental assets are assembled through nearly identical `PeggedAsset` construction blocks. The only material differences are the source-specific mcap derivation and a few telemetry fields.

   Remediation: factor a shared asset-builder helper that accepts the source-specific `mcap`, `priceResolution`, and optional history fields.

4. `worker/src/cron/yield-sync/resolve.ts:595-612` and `worker/src/cron/yield-sync/resolve.ts:656-673`

   The auto-discovery resolver pushes the same resolved-yield object shape in two branches: deterministic lending-pool matches and dynamic lending-pool matches. This duplicates the object assembly and the `autoDiscoveredIds` bookkeeping.

   Remediation: extract a helper that builds and appends the resolved yield row, then call it from both branches.

5. `worker/src/cron/dex-liquidity/fetch-primary.ts:411-440` and `worker/src/cron/dex-liquidity/fetch-primary.ts:522-550`

   UniV3 and Aerodrome subgraph parsing both normalize token observations into the same `SubgraphPriceObservation` shape with the same resolution checks and pool-identity metadata. The branch-specific math differs, but the mapping and push logic are duplicated.

   Remediation: separate “derive prices from pool type” from “map resolved token prices into observations,” and reuse the mapping helper in both branches.

6. `worker/src/cron/dex-liquidity/fetch-crawlers.ts:122-149` and `worker/src/cron/dex-liquidity/fetch-crawlers.ts:241-267`

   `mergeCgPools()` and `mergeGtPools()` are the same stablecoin-to-metrics merge loop with one extra log field and an extra contribution path for CG pools. The repeated loop shape makes the merge behavior harder to evolve safely.

   Remediation: create a generic `mergeNewPools()` helper that handles the stablecoin lookup, metrics initialization, and contribution loop, then let the source-specific wrappers supply only the source-specific callback.

7. `worker/src/lib/live-reserves-store.ts:331-345` and `worker/src/lib/live-reserves-store.ts:371-385`

   The row-to-record conversion for `reserve_sync_state` is repeated in both the single-row fetch and the batched map loader. The SQL column list is also duplicated, which increases the chance of one path drifting when the schema changes.

   Remediation: extract a `mapReserveSyncStateRow()` helper and reuse the same select-column constant in both queries.

8. `worker/src/cron/status-self-check.ts:202-217` and `worker/src/cron/status-self-check.ts:273-288`

   The external and internal probe paths build almost identical `ProbeResult` objects after their response checks. That duplicated return-shape assembly makes probe-policy changes easy to miss in one path.

   Remediation: pull the shared `ProbeResult` construction into a helper that takes the path, status, latency, semantic result, and error state.

9. `worker/src/api/stability-index.ts:28-58` and `worker/src/api/stability-index.ts:61-91`

   `decodePsiComponents()` and `decodePsiInputSnapshot()` are copy-paste siblings with only the caller context name changed. They perform the same strict JSON decode, shape validation, malformed-path logging, and error return.

   Remediation: extract a generic PSI JSON decoder that accepts the context label and the malformed-path source fields.

### Medium Priority

10. `worker/src/api/discovery.ts:57-69` and `worker/src/api/status-supplements.ts:159-171`

    The `discovery_candidates` row mapping is duplicated in two API surfaces, including the `daysSeen` calculation and the `gecko_id`/`llama_id` coercions. This is a narrow but real data-shaping overlap.

    Remediation: factor a shared discovery-candidate row mapper in `worker/src/lib/` and reuse it in both handlers.

11. `worker/src/api/backfill-supply-history.ts:209-243`, `worker/src/api/backfill-supply-history.ts:36-70`, and `worker/src/api/stablecoin-detail/commodity.ts:100-131`

    The CoinGecko market-chart plus coin-detail fetch/sanity-check flow is duplicated in three places: the backfill API’s commodity branch, its CoinGecko-only branch, and the commodity detail handler. The same helper currently exists in spirit in each path, but the fetch/cancel/parse pattern is maintained separately.

    Remediation: centralize the CoinGecko market-chart/detail loader so both API surfaces consume the same fetch-and-sanity routine, then keep only the row-writing and response-shaping logic local.

12. `src/components/psi-history-chart.tsx:354-361` and `src/app/stability-index/client.tsx:579-586`

    PSI chart-data assembly is duplicated between the standalone chart component and the page client. Both reverse history, append the current sample, and build the same `{ ts, score }` array.

    Remediation: extract a shared `buildPsiChartData()` helper near the PSI view-model layer and use it in both components.

13. `src/hooks/use-blacklist-events.ts:30-42` and `src/lib/blacklist-api.ts:25-36`

    The blacklist event query-parameter normalization is repeated in the hook and the fetch helper. This is thin-wrapper duplication, not a framework requirement.

    Remediation: expose a single `buildBlacklistEventsPath()` or `normalizeBlacklistEventsParams()` helper from `src/lib/blacklist-api.ts` and reuse it from the hook.

14. `src/components/homepage-client.tsx:326-337` and `src/components/stablecoin-filtered-table.tsx:26-38`

    Both components rebuild the same `Map`/object lookup structures from `pegSummaryData.coins` and `reportCardsData.cards`. The repetition is small, but it is central enough to justify a shared helper.

    Remediation: move the two map builders into a tiny shared utility so table and homepage consumers derive the same lookup structures from one implementation.

15. `src/styles/tokens/semantic.css:155-164` and `src/styles/tokens/semantic.css:276-285`

    `--sidebar-width-expanded` and `--sidebar-width-collapsed` are defined twice with the same values in both light and dark theme blocks. That is pure duplicate token configuration.

    Remediation: hoist the unchanged sidebar-dimension variables into the root token block and keep only theme-specific overrides in `.dark`.

### Lower Priority

16. `worker/src/cron/yield-sync/variant-scanner.ts:36-52` and `worker/src/cron/yield-sync/variant-scanner.ts:55-70`

    The wrapper-token scan repeats the same match-and-push shape for prefix and suffix patterns. The only difference is whether the candidate is trimmed from the front or back.

    Remediation: add a small helper that accepts a matcher and a string-slicing strategy, then reuse it for both prefix and suffix scans.

## Prioritized Remediation Roadmap

### Phase 1 - Quick Wins

- `src/styles/tokens/semantic.css:155-164` and `:276-285` - hoist duplicate sidebar dimensions; effort: small.
- `src/hooks/use-blacklist-events.ts:30-42` and `src/lib/blacklist-api.ts:25-36` - consolidate blacklist param normalization; effort: small.
- `src/components/homepage-client.tsx:326-337` and `src/components/stablecoin-filtered-table.tsx:26-38` - extract shared lookup-map helpers; effort: small.
- `worker/src/cron/yield-sync/variant-scanner.ts:36-52` and `:55-70` - collapse prefix/suffix scan helper; effort: small.

### Phase 2 - Targeted Refactoring

- `worker/src/api/stability-index.ts:28-58` and `:61-91` - unify PSI JSON decode and malformed-shape logging; effort: small.
- `worker/src/api/discovery.ts:57-69` and `worker/src/api/status-supplements.ts:159-171` - share discovery-candidate row mapping; effort: small.
- `src/components/psi-history-chart.tsx:354-361` and `src/app/stability-index/client.tsx:579-586` - share PSI chart-data builder; effort: small.
- `worker/src/cron/status-self-check.ts:202-217` and `:273-288` - extract common probe result assembly; effort: medium.
- `worker/src/lib/live-reserves-store.ts:331-345` and `:371-385` - extract row mappers and column lists; effort: medium.

### Phase 3 - Structural Improvements

- `worker/src/cron/sync-fx-rates.ts:35-107` and `worker/src/lib/fx-realtime.ts:9-72` - centralize FX peg config and validation; effort: medium.
- `worker/src/cron/sync-stablecoins/pricing.ts:207-244` and `:285-320` - unify price-application flow; effort: medium.
- `worker/src/cron/dex-liquidity/fetch-primary.ts:411-440` and `:522-550` - split token-price derivation from observation mapping; effort: medium.
- `worker/src/cron/dex-liquidity/fetch-crawlers.ts:122-149` and `:241-267` - create a generic pool-merge helper; effort: medium.
- `worker/src/cron/yield-sync/resolve.ts:595-612` and `:656-673` - factor yield-row assembly helper; effort: medium.
- `worker/src/cron/sync-stablecoins/supplemental-assets.ts:119-154` and `:238-290` - build a shared supplemental asset constructor; effort: medium.

### Phase 4 - Strategic Overhauls

- `worker/src/api/backfill-supply-history.ts:209-243`, `:36-70`, and `worker/src/api/stablecoin-detail/commodity.ts:100-131` - unify CoinGecko commodity loading across API surfaces; effort: large because it touches both backfill and detail-path behavior.

## Appendices

### File-by-File Finding Index

- `worker/src/cron/sync-fx-rates.ts`
- `worker/src/lib/fx-realtime.ts`
- `worker/src/cron/sync-stablecoins/pricing.ts`
- `worker/src/cron/sync-stablecoins/supplemental-assets.ts`
- `worker/src/cron/yield-sync/resolve.ts`
- `worker/src/cron/yield-sync/variant-scanner.ts`
- `worker/src/cron/dex-liquidity/fetch-primary.ts`
- `worker/src/cron/dex-liquidity/fetch-crawlers.ts`
- `worker/src/lib/live-reserves-store.ts`
- `worker/src/cron/status-self-check.ts`
- `worker/src/api/stability-index.ts`
- `worker/src/api/discovery.ts`
- `worker/src/api/status-supplements.ts`
- `worker/src/api/backfill-supply-history.ts`
- `worker/src/api/stablecoin-detail/commodity.ts`
- `src/components/psi-history-chart.tsx`
- `src/app/stability-index/client.tsx`
- `src/hooks/use-blacklist-events.ts`
- `src/lib/blacklist-api.ts`
- `src/components/homepage-client.tsx`
- `src/components/stablecoin-filtered-table.tsx`
- `src/styles/tokens/semantic.css`

### Dependency Audit Summary

| Result | Notes |
| --- | --- |
| No redundant dependencies identified | Reviewed `package.json` and `worker/package.json` against the audited import surface; no package stood out as a clear duplicate of built-in, already-present, or custom functionality. |

### Glossary

- `Thin wrapper`: a function/hook/module that only forwards parameters or reshapes data without adding real behavior.
- `Clone pair`: two code regions with the same control flow or object-shape assembly, modulo small naming or source-specific differences.
- `Hoist`: move a shared constant/helper to one place and import it from both call sites.
- `Row mapper`: a helper that turns a SQL row or API record into a typed domain object.
