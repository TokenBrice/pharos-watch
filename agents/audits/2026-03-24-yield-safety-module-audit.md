# Yield Safety Module Audit

Date: 2026-03-24
Scope: End-to-end Yield Intelligence / yield safety module review across adapter coverage, source resolution, arbitration, persistence, cache publication, API surface, frontend consumers, and test strategy.

## Executive Summary

The yield module is directionally strong: source-aware history, confidence-tier arbitration, degraded-mode signaling, and multi-source retention are the right structural choices. The main remaining risks are not in the broad shape of the system, but in the reliability of its handwritten adapter/config surface and in a few publication/provenance choices that can misrepresent freshness or erase still-valuable state too aggressively.

Two conclusions stand out:

1. Data accuracy risk is now concentrated in adapter quality, freshness semantics, and degraded-run handling.
2. Maintainability risk is concentrated in config sprawl, duplicated helper logic, and tests that validate generic logic but not the actual production adapter registry.

## Method

- Read the repo guidance and the relevant docs:
  - `docs/architecture.md`
  - `docs/api-reference.md`
  - `docs/testing.md`
  - `docs/worker-and-api-limits.md`
  - `docs/yield-intelligence.md`
  - `docs/yield-intelligence-timeline.md`
- Audited the worker yield pipeline:
  - `worker/src/cron/sync-yield-data.ts`
  - `worker/src/cron/yield-config.ts`
  - `worker/src/cron/yield-helpers.ts`
  - `worker/src/cron/yield-sync/{cache,evaluation,history,pool-filter,publication,rankings,resolve,sources}.ts`
  - `worker/src/lib/yield-source-links.ts`
  - `worker/src/lib/safety-scores.ts`
- Audited the public API and frontend consumers:
  - `worker/src/api/yield-history.ts`
  - `worker/src/api/cache-handlers.ts`
  - `src/hooks/api-hooks.ts`
  - `src/components/{yield-history-chart,yield-detail-section,yield-table-logic}.tsx`
  - `src/app/yield/client.tsx`
- Reviewed prior local audit/investigation notes for already-observed operational issues:
  - `agents/research/2026-03-19-yield-pipeline-audit.md`
  - `agents/investigations/yield-sync-investigation-2026-03-23.md`
- Ran the targeted yield test suite:
  - `npm test -- worker/src/cron/__tests__/sync-yield-data.test.ts worker/src/cron/__tests__/yield-resolve.test.ts worker/src/cron/__tests__/yield-helpers.test.ts worker/src/api/__tests__/yield-history.test.ts worker/src/api/__tests__/yield-rankings.test.ts worker/src/lib/__tests__/yield-source-links.test.ts shared/lib/__tests__/yield-scoring.test.ts src/lib/__tests__/yield-constants.test.ts`
  - Result: `8` files passed, `149` tests passed

## Current Adapter Inventory

Repo-state inventory from the checked-in stablecoin metadata and `worker/src/cron/yield-config.ts`:

- Yield-bearing tracked coins: `46`
- Curated native pool adapters (`YIELD_POOL_MAP`): `33`
- Wrapper/variant adapters (`YIELD_VARIANT_MAP`): `25`
- Deterministic on-chain rate adapters (`ON_CHAIN_RATE_CONFIGS`): `13`
- Rate-derived adapters (`RATE_DERIVED_CONFIGS`): `7`
- Deterministic auto-lending overrides (`AUTO_LENDING_POOL_MAP`): `9`
- Safety-bypass auto-lending overrides: `5`

Yield-bearing coins with no configured source strategy at all:

- `cetes-etherfuse`
- `usg-tangent`

Yield-bearing coins with metadata gaps that make adapter quality harder to maintain:

- `dusd-dtrinity`: `yieldConfig = null`
- `pusd-polaris`: `yieldConfig = null`, `contracts = []`
- `usg-tangent`: `yieldConfig = null`, `contracts = []`

Allowlisted lending protocols without a curated source-link mapping in `worker/src/lib/yield-source-links.ts`:

- `morpho-blue`
- `lagoon`
- `liqwid`
- `lista-lending`
- `loopscale`
- `more-markets`
- `navi-lending`
- `overnight-finance`
- `smardex-usdn`
- `vesper`

## Findings

### High

1. The publication/pruning order can delete valid current rows before the public rankings cache is known-good.
   - Evidence:
     - `sync-yield-data` persists evaluated rows, then immediately prunes tables, then only afterwards attempts `yield-rankings` cache publication in [`worker/src/cron/sync-yield-data.ts:242`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-yield-data.ts#L242 ) through [`worker/src/cron/sync-yield-data.ts:289`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-yield-data.ts#L289 ).
     - `writeYieldRankingsCache()` can still refuse publication on schema failure or shrink-guard failure in [`worker/src/cron/yield-sync/publication.ts:269`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/publication.ts#L269 ) through [`worker/src/cron/yield-sync/publication.ts:309`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/publication.ts#L309 ).
   - Impact:
     - A run can update/prune `yield_data`, fail cache publication, and leave the API serving an older rankings cache that no longer matches the underlying tables.
     - This is an accuracy and operability issue, not just a cosmetic stale-cache issue.
   - Recommendation:
     - Treat rankings publication as part of the commit boundary.
     - Build and validate the payload before destructive pruning.
     - Fail closed on prune when the new public snapshot cannot be published.
     - Prefer a two-phase publish model: stage writes, validate payload, then flip current pointers.

2. Freshness provenance is understated for on-chain and price-derived rows.
   - Evidence:
     - `sourceAgeSeconds` is set to `0` for anything that is not DeFiLlama- or rate-derived in [`worker/src/cron/yield-sync/publication.ts:114`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/publication.ts#L114 ) through [`worker/src/cron/yield-sync/publication.ts:125`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/publication.ts#L125 ).
     - `getPriceDerivedApy()` uses whatever the newest `supply_history` row is, without checking whether that anchor is itself stale relative to the cron’s freshness budget in [`worker/src/cron/yield-sync/sources.ts:339`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/sources.ts#L339 ) through [`worker/src/cron/yield-sync/sources.ts:373`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/sources.ts#L373 ).
   - Impact:
     - The UI can imply “fresh” on-chain or price-derived observations even when the supporting price history or exchange-rate basis is materially older than the sync run.
     - This directly weakens goal 1: making the data informative and precise.
   - Recommendation:
     - Carry source-native observation timestamps per adapter family.
     - For price-derived, expose both `latestPriceSnapshotAt` and `anchorSnapshotAt`.
     - For on-chain, surface the actual RPC observation time and the age of the previous comparison anchor.
     - Add degraded/freshness warnings when the latest usable input is older than the cron interval budget.

3. The deterministic on-chain adapter model is too rigid and already has known broken adapters.
   - Evidence:
     - All 13 deterministic adapters are forced into the same `convertToAssets(uint256)` shape in [`worker/src/cron/yield-config.ts:333`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config.ts#L333 ) through [`worker/src/cron/yield-config.ts:453`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config.ts#L453 ).
     - The local investigation already recorded that `dusd-dtrinity` reverts and `reusd-re-protocol` returns empty data with the current selector strategy in `agents/investigations/yield-sync-investigation-2026-03-23.md`.
   - Impact:
     - Deterministic coverage looks broad on paper, but some adapters are structurally invalid rather than transiently flaky.
     - The current model encourages adding more same-shape configs even when protocol semantics diverge.
   - Recommendation:
     - Replace the single “ERC-4626-like reader config” model with adapter kinds:
       - `erc4626_convert_to_assets`
       - `vault_exchange_rate`
       - `governance_rate`
       - `protocol_specific`
     - Move dUSD and reUSD out of the generic reader until they have protocol-specific implementations or are explicitly downgraded to non-deterministic sources.
     - Add an adapter-health manifest so broken deterministic adapters are visible independently of global coverage counts.

4. Production adapter coverage still has real gaps and silent metadata debt.
   - Evidence:
     - Two yield-bearing coins have no configured strategy at all: `cetes-etherfuse`, `usg-tangent`.
     - Three yield-bearing coins still lack `yieldConfig`, and two of those also lack any tracked contracts: `pusd-polaris`, `usg-tangent`.
   - Impact:
     - Coverage expansion is incomplete in a way that is easy to miss because the system still produces a broad rankings table.
     - Missing `yieldConfig` also degrades label quality, source-link quality, and future maintainability.
   - Recommendation:
     - Make adapter completeness a checked invariant for all `flags.yieldBearing: true` assets.
     - Require each yield-bearing coin to declare:
       - a canonical yield methodology family
       - a fallback family
       - label/type metadata
       - at least one contract or an explicit reason it is off-chain-only
     - Add a repo guard that fails when a yield-bearing coin has neither configured strategy nor explicit exemption.

5. The current test strategy does not validate the real production adapter registry.
   - Evidence:
     - The main worker tests replace the real stablecoin set and real yield config with tiny mocked fixtures in [`worker/src/cron/__tests__/sync-yield-data.test.ts:6`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/sync-yield-data.test.ts#L6 ) through [`worker/src/cron/__tests__/sync-yield-data.test.ts:180`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/sync-yield-data.test.ts#L180 ).
     - The same pattern exists in [`worker/src/cron/__tests__/yield-resolve.test.ts:14`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/yield-resolve.test.ts#L14 ) through [`worker/src/cron/__tests__/yield-resolve.test.ts:211`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/yield-resolve.test.ts#L211 ).
   - Impact:
     - The logic is tested, but the real adapter inventory is not.
     - A broken production config can ship while the suite stays green.
   - Recommendation:
     - Add config-contract tests that run against the actual checked-in registry:
       - every `yieldBearing` coin has a strategy or explicit exemption
       - every on-chain adapter points to a tracked coin and a compatible wrapper/metadata row
       - every auto-lending override has a curated label/link and documented rationale
       - every allowlisted protocol has a source-link mapping or explicit exemption

### Medium

6. `yield-config.ts` has become a monolithic hotspot with several unrelated registries that can drift out of sync.
   - Evidence:
     - One file now owns variant metadata, native pool IDs, on-chain adapters, price-derived fallbacks, rate-derived fallbacks, lending allowlist labels, deterministic lending overrides, and safety bypasses across `643` lines in [`worker/src/cron/yield-config.ts`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config.ts ).
   - Impact:
     - Drift is likely because the same coin can appear in multiple disconnected registries.
     - Reviewing coverage changes is harder than it needs to be.
   - Recommendation:
     - Refactor into a single per-coin yield adapter manifest plus smaller shared registries for protocol labels/links.
     - Generate derived maps from that manifest instead of maintaining parallel structures by hand.

7. The resolver repeatedly rescans arrays and maps instead of using pre-indexed lookups.
   - Evidence:
     - `resolveYieldSources()` repeatedly uses `find`, `some`, `filter`, and full-array scans inside coin loops in [`worker/src/cron/yield-sync/resolve.ts:68`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/resolve.ts#L68 ) through [`worker/src/cron/yield-sync/resolve.ts:190`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/resolve.ts#L190 ) and again in the auto-discovery section in [`worker/src/cron/yield-sync/resolve.ts:281`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/resolve.ts#L281 ) through [`worker/src/cron/yield-sync/resolve.ts:368`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/resolve.ts#L368 ).
   - Impact:
     - This is not a critical runtime bottleneck at current scale, but it makes the code harder to reason about and longer than necessary.
   - Recommendation:
     - Precompute:
       - `onChainConfigById`
       - `dlPoolById`
       - `resolvedSourceKeysByCoin`
       - `autoOverridePoolById`
     - This would reduce repeated scanning and simplify the control flow materially.

8. Source-aware history exists in the API, but the frontend does not actually use it.
   - Evidence:
     - The API path builder supports `mode` and `sourceKey`, but the hook does not expose them in [`shared/lib/api-endpoints.ts:85`]( /Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/api-endpoints.ts#L85 ) through [`shared/lib/api-endpoints.ts:91`]( /Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/api-endpoints.ts#L91 ) and [`src/hooks/api-hooks.ts:159`]( /Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/api-hooks.ts#L159 ) through [`src/hooks/api-hooks.ts:165`]( /Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/api-hooks.ts#L165 ).
     - The chart always fetches best-source history in [`src/components/yield-history-chart.tsx:331`]( /Users/ahirice/Documents/git/stablecoin-dashboard/src/components/yield-history-chart.tsx#L331 ) through [`src/components/yield-history-chart.tsx:353`]( /Users/ahirice/Documents/git/stablecoin-dashboard/src/components/yield-history-chart.tsx#L353 ).
   - Impact:
     - Alternative sources are visible as small popovers, but not actually inspectable over time.
     - That limits the module’s explanatory power when source switches happen.
   - Recommendation:
     - Add source selection to the history hook and chart.
     - Let users compare “best historical source” versus “this specific source”.

9. The shared contract for yield history is out of sync with the real API.
   - Evidence:
     - `shared/types/yield.ts` declares `YieldHistoryResponse { current, history, methodology }` in [`shared/types/yield.ts:218`]( /Users/ahirice/Documents/git/stablecoin-dashboard/shared/types/yield.ts#L218 ) through [`shared/types/yield.ts:222`]( /Users/ahirice/Documents/git/stablecoin-dashboard/shared/types/yield.ts#L222 ).
     - `worker/src/api/yield-history.ts` actually returns a bare array.
   - Impact:
     - This is a contract-drift footgun for frontend and future API work.
   - Recommendation:
     - Either remove the stale shared type or upgrade the API to match it.
     - Do not leave both shapes around.

10. Source-link curation is incomplete for a meaningful slice of the lending allowlist.
   - Evidence:
     - Ten currently allowlisted protocols have no curated source-link mapping.
   - Impact:
     - The module is less informative than it could be, especially for long-tail lending discoveries.
   - Recommendation:
     - Treat source-link completeness as part of adapter quality, not as optional frontend polish.

### Low

11. Helper logic is duplicated across the worker/API boundary.
   - Evidence:
     - `buildOnChainSourceKey()` is duplicated in `yield-helpers.ts` and `yield-history.ts`.
     - Warning-signal parsing is duplicated in `yield-history.ts` and `yield-sync/rankings.ts`.
   - Impact:
     - Low direct risk, but unnecessary drift surface.
   - Recommendation:
     - Centralize both in a small shared yield-normalization utility.

12. The rankings cache write result under-reports why publication failed.
   - Evidence:
     - `writeYieldRankingsCache()` only returns `validationFailures: 1` for multiple distinct failure modes in [`worker/src/cron/yield-sync/publication.ts:279`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/publication.ts#L279 ) through [`worker/src/cron/yield-sync/publication.ts:304`]( /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-sync/publication.ts#L304 ).
   - Impact:
     - This is mostly an observability issue, but it makes operational triage harder.
   - Recommendation:
     - Return structured failure categories and counts rather than a generic `1`.

## Adapter-by-Adapter Review

### 1. Deterministic On-Chain Adapters

What is good:

- Highest-fidelity source family when the adapter is correct.
- Source-aware history and on-chain source-key separation are already in place.

Weaknesses:

- The adapter abstraction is too narrow: it assumes one selector/input model for all vaults.
- Two adapters are already known-bad (`dusd-dtrinity`, `reusd-re-protocol`).
- On-chain provenance is presented as if it were synced “now”, without exposing anchor age.

Primary improvements:

- Move from generic config rows to typed adapter classes.
- Add adapter-health checks and explicit quarantine for broken deterministic adapters.
- Expose richer provenance for deterministic calculations.

### 2. Curated Native DeFiLlama Pool Adapters

What is good:

- Coverage is broad.
- Static UUIDs are still the best way to avoid symbol ambiguity for native pools.

Weaknesses:

- The native pool map is still a large handwritten table with no automatic validation against metadata.
- Coverage is incomplete for some yield-bearing assets.
- This registry is separated from `yieldConfig`, which invites label drift.

Primary improvements:

- Fold pool IDs into a single per-coin manifest.
- Add a guard that every yield-bearing coin is either mapped, intentionally unmapped, or covered by another named strategy.

### 3. Wrapper / Variant Adapters

What is good:

- Wrapper preservation fixed a real blind spot.
- The variant map now carries meaningful label/type metadata.

Weaknesses:

- Several entries still only carry symbol-level matching with no variant address.
- The registry mixes matching hints and display metadata.
- It is not enforced that a variant-backed yield coin also has a coherent `yieldConfig`.

Primary improvements:

- Split “matching hints” from “display metadata”.
- Require a justification when variant address is missing.
- Add a config test that a variant-backed coin has a canonical label/type path.

### 4. Price-Derived Adapters

What is good:

- Efficient, no new external fetches.
- Early-anchor logic is better than the prior strict-window requirement.

Weaknesses:

- Freshness semantics are weak.
- The path depends completely on `supply_history` quality but does not surface that dependency clearly.
- There is no explicit “input too stale/thin” degraded annotation beyond returning `null`.

Primary improvements:

- Persist and expose anchor age.
- Add minimum recency thresholds for the newest priced sample.
- Differentiate “no data” from “stale data” from “insufficient history”.

### 5. Rate-Derived Adapters

What is good:

- Simple and deterministic.
- Good fit for dividend-distributing treasury products.

Weaknesses:

- Entirely benchmark-minus-spread, with no token-level sanity check against observed NAV behavior.
- A bad benchmark or stale retained benchmark affects every rate-derived asset together.
- Labels are static and not tied back to metadata completeness.

Primary improvements:

- Add optional token-specific cross-checks when price/NAV history exists.
- Distinguish benchmark freshness from token freshness in provenance.
- Consider an adapter manifest that records the fee rationale and evidence source for each spread.

### 6. Auto-Discovered Lending Adapters and Deterministic Overrides

What is good:

- This is the biggest coverage lever in the module.
- Quality gates and safety gating are directionally correct.

Weaknesses:

- The quality gates are still purely generic.
- Overrides are useful, but the safety-bypass list is sensitive and needs stronger documentation/testing.
- Informational quality is reduced by missing source-link mappings for part of the allowlist.

Primary improvements:

- Add a reviewed rationale field per override and per safety bypass.
- Add tests that every bypassed asset has an explicit note and source-link coverage.
- Consider per-protocol or per-chain quality gates where the generic floors are too blunt.

## Maintainability Themes

### A. Replace Parallel Maps With One Manifest

The single biggest maintainability win would be collapsing:

- `YIELD_POOL_MAP`
- `YIELD_VARIANT_MAP`
- `ON_CHAIN_RATE_CONFIGS`
- `PRICE_DERIVED_FALLBACK_IDS`
- `RATE_DERIVED_CONFIGS`
- `AUTO_LENDING_POOL_MAP`
- `AUTO_LENDING_SAFETY_BYPASS_IDS`

into a unified per-coin manifest with optional adapter blocks. That would reduce drift, review overhead, and LOC.

### B. Centralize Normalization Helpers

Centralize:

- on-chain source-key normalization
- warning-signal parsing
- source provenance formatting

These are currently split across worker cron and API code for no real gain.

### C. Pre-Index Resolver Inputs

The resolver would get materially shorter and easier to trust if it operated on indexed inputs instead of repeated scans over arrays.

### D. Promote Adapter Completeness To CI

The next quality step is not “more generic tests”; it is “tests that validate the real registry”.

## Recommended Remediation Workstreams

### Workstream 1: Publication Safety

- Reorder publish/prune flow so cache publication is validated before destructive cleanup.
- Add a fail-closed path when rankings cannot be published.
- Add a regression test that simulates successful row writes plus failed cache publication.

### Workstream 2: Adapter Registry Hardening

- Introduce a unified per-coin yield adapter manifest.
- Classify deterministic adapters by adapter kind instead of one generic selector model.
- Close the uncovered yield-bearing assets and metadata gaps.

### Workstream 3: Provenance and Freshness Accuracy

- Add true observed-at and age semantics for on-chain and price-derived sources.
- Surface anchor age and latest input age in provenance.
- Add degraded annotations for stale or thin fallback data.

### Workstream 4: Real Registry Validation

- Add CI checks for production adapter completeness.
- Add CI checks for source-link completeness across allowlisted protocols.
- Add CI checks for metadata completeness on all yield-bearing coins.

### Workstream 5: Source-Aware UX

- Extend `useYieldHistory()` to accept `mode` and `sourceKey`.
- Let the chart show best-history versus specific-source history.
- Surface source switches and fallback/default-safety usage more explicitly.

## Suggested Planning Priority

P0:

- Publication/pruning safety
- Broken deterministic adapters (`dusd-dtrinity`, `reusd-re-protocol`)
- Real registry validation tests

P1:

- Adapter manifest refactor
- Provenance/freshness accuracy for on-chain and price-derived sources
- Coverage completion for `cetes-etherfuse`, `usg-tangent`, and metadata debt assets

P2:

- Source-aware frontend history UX
- Source-link completeness
- Helper mutualization / LOC reduction cleanup

## Bottom Line

The yield module is no longer a weak prototype. It is a real system with credible architecture. The remaining problems are the kinds that appear after a successful coverage expansion:

- adapter sprawl,
- silent metadata debt,
- freshness overstatement,
- publication boundary fragility,
- and tests that do not yet prove the real production registry.

If the next remediation cycle focuses on those areas, both stated goals improve at the same time:

- data gets more accurate because freshness and adapter quality become explicit,
- and the code gets more maintainable because the adapter surface becomes declarative, validated, and less duplicated.
