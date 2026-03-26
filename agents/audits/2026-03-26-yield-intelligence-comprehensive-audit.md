# Yield Intelligence Comprehensive Audit

Date: 2026-03-26
Owner: Codex audit pass
Status: Research only, no implementation performed

## Scope

This audit reviewed the full yield intelligence module with two goals:

1. Data accuracy: make sure the module resolves the correct yield sources, computes defensible APYs, and publishes reliable rankings.
2. Maintainability: make sure the code is coherent, testable, and scalable as adapter coverage expands.

Reviewed inputs:

- Docs:
  - `docs/architecture.md`
  - `docs/api-reference.md`
  - `docs/testing.md`
  - `docs/worker-and-api-limits.md`
  - `docs/yield-intelligence.md`
  - `docs/yield-intelligence-timeline.md`
- Core implementation:
  - `worker/src/cron/sync-yield-data.ts`
  - `worker/src/cron/yield-config.ts`
  - `worker/src/cron/yield-helpers.ts`
  - `worker/src/cron/yield-coverage-audit.ts`
  - `worker/src/cron/yield-sync/{sources,resolve,evaluation,publication,history,rankings,cache,pool-filter,types}.ts`
  - `worker/src/api/{cache-handlers,yield-history}.ts`
  - `worker/src/lib/{yield-source-links,yield-utils}.ts`
  - `shared/types/yield.ts`
- Prior local audits and investigations:
  - `agents/research/2026-03-19-yield-pipeline-audit.md`
  - `agents/research/2026-03-24-yield-coverage-assessment.md`
  - `agents/audits/2026-03-24-yield-safety-module-audit.md`
  - `agents/audits/2026-03-15-yield-intelligence-audit.md`
  - `agents/investigations/yield-sync-investigation-2026-03-23.md`

Verification performed:

- Targeted tests:
  - `npm test -- worker/src/cron/__tests__/yield-*.test.ts worker/src/cron/__tests__/sync-yield-data.test.ts worker/src/cron/__tests__/yield-resolve.test.ts worker/src/api/__tests__/yield-history.test.ts worker/src/api/__tests__/yield-rankings.test.ts worker/src/lib/__tests__/yield-source-links.test.ts shared/lib/__tests__/yield-scoring.test.ts src/lib/__tests__/yield-constants.test.ts`
  - Result: 22 files passed, 213 tests passed.
- Live and upstream checks on 2026-03-26:
  - `https://api.pharos.watch/api/yield-rankings`
  - `https://bima.money/api/earn/pools?...`
  - `https://usyc.hashnote.com/api/price-reports`
  - `https://api.morpho.org/graphql`
  - `https://api-v2.pendle.finance/core/v1/.../markets`
  - `https://kong.yearn.fi/api/gql`
  - `https://api.beefy.finance/{apy,vaults}`

## Executive Summary

The module is no longer in a “coverage-only” phase. It has enough adapters and enough ambiguity in the upstream data that identity resolution is now the primary correctness problem.

The highest-risk issue is symbol-driven misattribution. Several protocol-native adapters and the generic DeFiLlama auto-discovery path still match assets by raw symbol across the full tracked stablecoin universe. That is already causing live production errors: unrelated assets with duplicate symbols are receiving the same discovered source and APY.

The second major issue is observability and safety accounting. The runtime has more yield strategies than the manifest and the coverage audit understand, and the coverage regression guard is mathematically weak enough that added non-yield-bearing rows can mask a collapse in real yield-bearing coverage.

The third major issue is maintainability. The module works through a growing set of parallel registries, string labels, ad hoc matcher rules, and large hotspot files. The code is still understandable, but it is no longer cheap to change safely. Every new adapter requires edits in multiple places, and some config fields are already not enforced at runtime.

Bottom line:

- The current module is not yet accurate enough to trust symbol-based discovery paths.
- The current module is not yet maintainable enough to keep expanding adapter coverage without increasing regression risk.
- Remediation should prioritize identity and coverage correctness first, then consolidate adapter registration and publication logic.

## Current Inventory

Runtime inventory as of this audit:

- `49` yield-bearing stablecoins in `YIELD_BEARING_STABLECOINS`
- `34` curated DeFiLlama native pool mappings in `YIELD_POOL_MAP`
- `28` wrapper/variant mappings in `YIELD_VARIANT_MAP`
- `13` on-chain exchange-rate readers in `ON_CHAIN_RATE_CONFIGS`
- `5` explicit rate-derived coins in `RATE_DERIVED_CONFIGS`
- `9` explicit auto-lending overrides in `AUTO_LENDING_POOL_MAP`
- `10` direct/protocol-native adapter families in `sources.ts`:
  - B.Protocol
  - BIMA
  - Hashnote
  - Ondo USDY oracle
  - Morpho
  - Pendle
  - Yearn/Kong
  - Beefy
  - Compound V3
  - Aave V3

Coverage shape:

- Several coins have multiple surfaces, which is good for resilience.
- Several coins are still single-path and therefore fragile.
- Two yield-bearing coins are not represented by the adapter manifest at all:
  - `cetes-etherfuse`
  - `usg-tangent`

Sparse or fragile yield-bearing coverage:

- No configured runtime strategy at all:
  - `usg-tangent`
- Implicit-only or single fragile path:
  - `cetes-etherfuse` via implicit nav-token price-derived behavior
  - `usbd-bima` via BIMA-specific path plus variant-only DL match
  - `ftusd-flying-tulip` via variant-only DL match
  - `dusd-dtrinity` via variant-only DL match
  - `usdh-hermetica` via variant-only DL match
  - `usdb-blast` via price-derived fallback only
  - `buidl-blackrock` via rate-derived only

Live ranking coverage on 2026-03-26:

- Yield-bearing assets missing from `api.pharos.watch/api/yield-rankings`:
  - `usbd-bima`
  - `usg-tangent`
  - `ftusd-flying-tulip`

## Priority Findings

### 1. Critical: live symbol-collision misattribution is happening now

Files:

- `worker/src/cron/yield-helpers.ts:164-225`
- `worker/src/cron/yield-sync/resolve.ts:342-397`
- `worker/src/cron/yield-sync/resolve.ts:460-565`

What is wrong:

- `findBestLendingPool()` prefers exact symbol matches before address matches, so duplicate-symbol assets resolve to the wrong pool whenever a symbol collision exists.
- Generic protocol-native adapters match to `TRACKED_STABLECOINS` by raw symbol only.
- Auto-discovery uses an incomplete chain mapping, so many assets lose chain scoping and become cross-chain eligible.
- Explicit override pools are not reserved from dynamic discovery, so the same manually assigned pool can later be attached to a different coin with the same symbol.

Live evidence from `https://api.pharos.watch/api/yield-rankings` on 2026-03-26:

- `cusd-cap` and `cusd-celo` both use source key `d26e8398-82fa-4aaa-ae59-231418be8720`
- `reusd-re-protocol` and `reusd-resupply` both use `cca4dedb-569c-49ab-b053-d48d8d41dfd4`
- `usdm-mega` and `usdm-moneta` both use `ce3021c9-af52-46b0-a61a-3e92acdfd79b`
- `pusd-plume` and `pusd-polaris` both use `add30093-8fb6-4972-bb6a-a0f3add8bfe8`

Impact:

- Wrong yield source attribution in production.
- Wrong APY and source provenance for affected assets.
- Wrong history continuity because the wrong source key is persisted as canonical.

Assessment:

- This is the top remediation priority.

### 2. High: the yield coverage regression guard is mathematically weak

Files:

- `worker/src/cron/sync-yield-data.ts:103-108`
- `worker/src/cron/sync-yield-data.ts:223-242`

What is wrong:

- The coverage guard uses `resolvedIds.length / yieldCoins.length`.
- `resolvedIds` includes all coins with any resolved yield row, not just yield-bearing coins whose native coverage is the thing we want to protect.
- Extra discovered lending rows for non-yield-bearing assets can therefore inflate the numerator and hide a real collapse in yield-bearing coverage.

Impact:

- The main safety guard can fail open during the exact kind of regression it was meant to stop.

Assessment:

- This is a correctness and operational-risk issue, not just a reporting bug.

### 3. High: curated variant metadata is not actually enforced

Files:

- `worker/src/cron/yield-config.ts:5-15`
- `worker/src/cron/yield-helpers.ts:97-153`

What is wrong:

- `YIELD_VARIANT_MAP` stores `variantChain` and often `variantAddress`.
- `matchAllDlPools()` ignores both and resolves the variant layer by wrapper symbol only.
- In practice, a large part of the “curated” variant configuration is just documentation; runtime matching does not use it.

Impact:

- Cross-chain or duplicate-symbol wrapper pools can be misattributed.
- Future growth increases the risk because the unused config fields create false confidence.

Assessment:

- This is both an accuracy issue and a maintainability smell. The code suggests stronger matching than it actually performs.

### 4. High: protocol-native adapters still resolve by symbol only

Files:

- `worker/src/cron/yield-sync/resolve.ts:342-397`

What is wrong:

- Morpho, Pendle, Yearn/Kong, Beefy, and Compound V3 resolve to tracked coins by symbol equality only.
- This happens across the full `TRACKED_STABLECOINS` set, where duplicate symbols are common:
  - `CUSD`
  - `REUSD`
  - `USDM`
  - `PUSD`
  - `USDA`
  - `USDF`
  - `MSUSD`
  - `USDP`

Impact:

- This is the same failure class as the auto-discovery bug, just on a different input lane.
- The live API already shows the effect for Pendle, Morpho, and Silo-derived rows.

Assessment:

- Protocol-native adapter expansion should stop using symbol-only resolution entirely.

### 5. High: Aave V3 publishes an invalid `yieldType`

Files:

- `worker/src/cron/yield-sync/resolve.ts:423-447`
- `shared/types/core.ts:135-154`

What is wrong:

- Aave rows are created with `yieldType: "lending"`.
- `"lending"` is not part of the shared `YieldType` schema.
- Valid values are `lending-vault`, `rebase`, `fee-sharing`, `lp-receipt`, `nav-appreciation`, `governance-set`, and `lending-opportunity`.

Impact:

- Any rankings payload containing one of these rows can fail schema validation before publish.
- Current tests do not catch this because adapter fetch tests do not exercise the full publication schema.

Assessment:

- This is a latent production failure that should be fixed early in remediation.

### 6. High: manifest and coverage audit are not a reliable source of truth

Files:

- `worker/src/cron/yield-config.ts:647-682`
- `worker/src/cron/yield-coverage-audit.ts:53-117`
- `worker/src/cron/yield-coverage-audit.ts:142-173`

What is wrong:

- `YIELD_ADAPTER_MANIFEST` only enumerates config surfaces and quarantines.
- Runtime strategies such as implicit nav-token price-derived paths are not first-class manifest entries.
- `yield-coverage-audit.ts` only treats `YIELD_POOL_MAP` pool IDs as “covered”.
- The `trackedSymbols` parameter is loaded and passed but ignored.

Concrete examples:

- `cetes-etherfuse` has a runtime price-derived path but no manifest entry.
- `usg-tangent` is yield-bearing but has no adapter surface and no manifest entry.
- The audit cannot tell whether a coin is covered by variants, on-chain rate readers, rate-derived logic, protocol-native adapters, or auto-overrides.

Impact:

- Coverage reporting is incomplete.
- Planning tools cannot reliably distinguish intentional fallback coverage from accidental gaps.

Assessment:

- The module currently lacks a single trustworthy inventory of yield strategies.

### 7. Medium: warning signals use a different median than the public API

Files:

- `worker/src/cron/yield-sync/evaluation.ts:497-499`
- `worker/src/cron/yield-sync/publication.ts:114-119`
- `worker/src/cron/yield-sync/publication.ts:190-199`

What is wrong:

- `evaluateYieldSources()` computes `medianApy` as a simple median of current best-row APYs.
- `buildYieldRankingsPayloadFromEvaluatedSources()` publishes `medianApy` as a TVL-weighted median of `apy30d`.
- `persistEvaluatedYieldSources()` uses the simple median to generate `yield-divergence` warnings.

Impact:

- Internal warnings and public median are based on different peer baselines.
- The API and the warning system can tell different stories about the same market.

Assessment:

- This is a consistency bug. It weakens trust in warning semantics.

### 8. Medium: publication can still leave read surfaces out of sync

Files:

- `worker/src/cron/yield-sync/publication.ts:171-327`
- `worker/src/cron/yield-sync/publication.ts:329-344`

What is wrong:

- The current flow validates preview rankings before persistence, which is good.
- But `yield_data` and `yield_history` are still persisted before the cache is updated.
- If cache publication fails after persistence, `yield-history` can advance while `yield-rankings` stays stale.

Impact:

- API surfaces can disagree about the latest run.
- Operators have fewer guarantees about what “published” means.

Assessment:

- This is less severe than the older destructive-cleanup issue, but the consistency model is still incomplete.

### 9. Medium: adapter source keys are inconsistent and sometimes collision-prone

Files:

- `worker/src/cron/yield-sync/sources.ts:587`
- `worker/src/cron/yield-sync/sources.ts:653`
- `worker/src/cron/yield-sync/sources.ts:732`
- `worker/src/cron/yield-sync/sources.ts:794`
- `worker/src/cron/yield-sync/sources.ts:854`
- `worker/src/cron/yield-sync/resolve.ts:423-447`

What is wrong:

- Several adapters use truncated-address source keys.
- Aave uses a single source key for every asset and every chain.
- Aave also discards the winning chain returned by the fetcher, so a coin can switch chains without that being visible in source identity.

Impact:

- Harder debugging.
- Unnecessary collision risk.
- History can silently merge semantically different sources.

Assessment:

- Not the first problem to fix, but part of making provenance trustworthy.

## Adapter-by-Adapter Review

### Curated DeFiLlama native pool map

Files:

- `worker/src/cron/yield-config.ts:226-360`
- `worker/src/cron/yield-helpers.ts:111-121`

Strengths:

- Explicit UUID matching is the safest DeFiLlama path.
- Good fit for protocol-native or wrapper-native pools with stable UUIDs.

Weaknesses:

- Coverage is incomplete for some yield-bearing assets.
- Pool inventory is kept in a large monolithic config with limited type safety.
- The coverage audit treats this map as the only notion of “covered”, which is no longer true.

Assessment:

- Good foundation, but it is no longer sufficient as the primary inventory model.

### Variant wrapper matching

Files:

- `worker/src/cron/yield-config.ts:5-223`
- `worker/src/cron/yield-helpers.ts:123-135`

Strengths:

- Useful abstraction for untracked savings wrappers.
- Correctly models the conceptual relationship between base asset and wrapper.

Weaknesses:

- Runtime ignores `variantChain` and `variantAddress`.
- Variant matching is exact-symbol only and chain-agnostic.
- Several assets rely on this as their only path:
  - `usdh-hermetica`
  - `dusd-dtrinity`
  - `ftusd-flying-tulip`
  - `usbd-bima` as fallback alongside the direct adapter

Assessment:

- This is currently weaker than it looks.

### Base-symbol DeFiLlama fallback

Files:

- `worker/src/cron/yield-helpers.ts:137-151`

Strengths:

- Helps catch symbol drift and incomplete static mapping.

Weaknesses:

- Uses `.includes()` on symbol.
- No chain scoping.
- No address scoping.
- No project scoping beyond whatever already exists upstream.

Assessment:

- Useful as an emergency fallback, unsafe as a quietly trusted path.

### Auto-lending discovery and explicit auto-overrides

Files:

- `worker/src/cron/yield-helpers.ts:164-225`
- `worker/src/cron/yield-sync/resolve.ts:455-565`
- `worker/src/cron/yield-config.ts:580-646`

Strengths:

- Good idea to separate deterministic overrides from generic discovery.
- Quality gates exist for APY, TVL, exposure, and allowlisted protocol set.

Weaknesses:

- Exact symbol wins before address matching.
- Incomplete chain mapping causes chain filter loss on many ecosystems.
- Explicit override pools are not reserved from dynamic discovery.
- Dynamic discovery searches the full tracked set, where duplicate symbols are common.

Assessment:

- This is the highest-risk lane in the module today.

### B.Protocol LQTY-only source

Files:

- `worker/src/cron/yield-sync/sources.ts:290-364`

Strengths:

- Deterministic on-chain model.
- Sensible null-return behavior when inputs are unavailable.

Weaknesses:

- No major correctness issue found in this pass.
- It is still a single-source adapter with no alternate lane if either on-chain or CoinGecko input fails.

Assessment:

- Low concern relative to the rest of the module.

### BIMA sUSBD source

Files:

- `worker/src/cron/yield-sync/sources.ts:366-430`

Strengths:

- Direct protocol API is appropriate for this asset.

Weaknesses:

- Accepts `currentApy === 0`.
- Accepts `amountTVL >= 0`, including negligible TVL.
- Current upstream sample on 2026-03-26 had TVL around `$11.84` and APR `0`.
- Live rankings currently omit `usbd-bima`.

Assessment:

- The adapter lacks the quality gating used elsewhere in the module and is too noisy to trust as-is.

### Hashnote USYC source

Files:

- `worker/src/cron/yield-sync/sources.ts:433-479`

Strengths:

- Reasonable idea: derive APY from NAV growth over time.

Weaknesses:

- Assumes the API payload is already sorted newest-first.
- Does not sort by timestamp before choosing the latest and anchor rows.
- A payload order change would silently break the calculation.

Assessment:

- Medium-risk adapter bug; easy to miss, easy to fix later.

### Ondo USDY oracle source

Files:

- `worker/src/cron/yield-sync/sources.ts:487-531`
- `worker/src/cron/yield-sync/resolve.ts:287-309`

Strengths:

- Uses deterministic on-chain price data.

Weaknesses:

- Annualizes from the most recent persisted snapshot, which is often only one sync interval old.
- This makes the APY effectively a short-interval annualized spot rate, not a 7-day or longer anchor.
- Methodology is inconsistent with the more stable anchor windows used by other NAV-appreciation paths.

Assessment:

- Medium concern. Likely too noisy for a flagship direct adapter.

### Morpho vault adapter

Files:

- `worker/src/cron/yield-sync/sources.ts:533-600`
- `worker/src/cron/yield-sync/resolve.ts:342-350`

Strengths:

- Pulls protocol-native APY and TVL directly.

Weaknesses:

- Query only asks for `asset.symbol`, not asset address.
- Resolver matches by symbol only.
- Fetched `chain.id` is not used for identity resolution.
- Source key is truncated.
- Link resolution does not understand `Morpho: ...` prefixed labels.

Assessment:

- High-risk until identity uses address and chain instead of symbol.

### Pendle market adapter

Files:

- `worker/src/cron/yield-sync/sources.ts:603-667`
- `worker/src/cron/yield-sync/resolve.ts:353-361`

Strengths:

- Good protocol-native addition for an important yield venue.

Weaknesses:

- Stable market resolution is symbol-only.
- Upstream currently exposes duplicate-symbol stable markets.
- Uses hardcoded chain list and `limit=100` with no completeness guard.
- Source key is truncated.
- Link resolution does not understand `Pendle: ...` prefixed labels.

Assessment:

- High-risk; already involved in live misattribution.

### Yearn/Kong adapter

Files:

- `worker/src/cron/yield-sync/sources.ts:669-746`
- `worker/src/cron/yield-sync/resolve.ts:364-372`

Strengths:

- Sensible category and retirement filtering.

Weaknesses:

- Symbol-only resolution.
- No address-based matching.
- Source key prefix is always `protocol-api:kong:` even for Yearn-native vaults.
- Link resolution does not understand `Yearn: ...` or `Kong: ...`.

Assessment:

- High concern for future symbol collisions, medium concern for current correctness.

### Beefy adapter

Files:

- `worker/src/cron/yield-sync/sources.ts:748-807`
- `worker/src/cron/yield-sync/resolve.ts:375-383`

Strengths:

- Pulls both APY and vault metadata.

Weaknesses:

- Symbol-only resolution.
- Ignores available chain and token address metadata for identity.
- No TVL gate.
- Sanity filter only rejects `apy > 10`, which is better than nothing but still weak.
- Source key is truncated.
- Link resolution does not understand `Beefy: ...`.

Assessment:

- High maintainability risk, medium current data-quality risk.

### Compound V3 direct supply adapter

Files:

- `worker/src/cron/yield-sync/sources.ts:810-867`
- `worker/src/cron/yield-sync/resolve.ts:386-397`

Strengths:

- Deterministic on-chain source.

Weaknesses:

- Hardcoded market set.
- Resolver still maps results back to tracked coins by symbol.
- Source key is truncated.

Assessment:

- Lower risk than Morpho/Pendle because the hardcoded targets are currently unambiguous, but still built on a brittle pattern.

### Aave V3 direct supply adapter

Files:

- `worker/src/cron/yield-sync/sources.ts:945-1031`
- `worker/src/cron/yield-sync/resolve.ts:400-453`

Strengths:

- Deterministic on-chain read.
- Batching is reasonable.

Weaknesses:

- Invalid `yieldType`.
- Source identity discards chain even though the fetcher returns it.
- Same source key reused for all assets and chains.
- No explicit distinction between chain-specific Aave opportunities for the same coin.

Assessment:

- High priority because it can break publish validation and muddies source provenance.

### Price-derived and rate-derived fallbacks

Files:

- `worker/src/cron/yield-sync/sources.ts:869-910`
- `worker/src/cron/yield-sync/resolve.ts:199-263`
- `worker/src/cron/yield-config.ts:490-522`

Strengths:

- Necessary for NAV tokens and instruments without robust protocol APIs.

Weaknesses:

- Some assets rely on these as their only practical source.
- Implicit nav-token price-derived behavior is not represented in the manifest.
- Generic source keys like `price-derived` and `rate-derived` are acceptable per coin, but they hide sub-strategy identity in audits and reporting.

Assessment:

- Fallbacks are valid, but they need to become explicit first-class strategies in inventory and coverage reporting.

## Code Quality and Mutualization Opportunities

### 1. The module has grown beyond comfortable hotspot size

Current line counts:

- `worker/src/cron/yield-sync/sources.ts`: `1032`
- `worker/src/cron/yield-config.ts`: `682`
- `worker/src/cron/yield-sync/resolve.ts`: `586`
- `worker/src/cron/yield-sync/evaluation.ts`: `520`
- `worker/src/cron/yield-sync/publication.ts`: `447`
- `worker/src/cron/sync-yield-data.ts`: `401`

Assessment:

- This is now a hotspot cluster, not a set of small focused modules.
- Adapter logic, identity logic, and publication logic are still too entangled.

### 2. Adapter registration is fragmented across too many files

A new adapter may require edits in:

- `yield-config.ts`
- `sources.ts`
- `resolve.ts`
- `yield-source-links.ts`
- tests
- documentation

Assessment:

- There is no single adapter registry that defines:
  - identity rules
  - fetcher
  - label
  - source key strategy
  - coverage status
  - documentation surface

### 3. Some configuration is stringly typed or only partially enforced

Files:

- `worker/src/cron/yield-config.ts:5-15`

Examples:

- `YieldVariant.yieldType?: string` instead of shared `YieldType`
- `variantChain` and `variantAddress` are stored but not used by DL matching

Assessment:

- Type safety and runtime semantics are drifting apart.

### 4. Provenance construction is duplicated

Files:

- `worker/src/cron/sync-yield-data.ts:245-317`
- `worker/src/cron/yield-sync/publication.ts:272-316`

What is duplicated:

- source observed-at derivation
- source age derivation
- comparison anchor derivation
- selection reason assembly
- previous best handling
- anomaly propagation

Assessment:

- This should be a shared helper, otherwise the preview payload and persisted payload can drift.

### 5. There is dead or unused reconstruction code

Files:

- `worker/src/cron/yield-sync/publication.ts:346-447`

Finding:

- `buildYieldRankingsPayload()` appears to be unused; repository search only finds its definition.

Assessment:

- Dead paths increase maintenance cost and mental load in a part of the module that is already crowded.

### 6. Chain mapping logic should be shared with the DEX-liquidity identity layer

Files:

- `worker/src/cron/yield-sync/resolve.ts:513-529`

Finding:

- Yield currently carries its own incomplete `PHAROS_TO_DL_CHAIN` map.
- The repo already has stronger chain-scoped asset-resolution work in the DEX-liquidity area.

Assessment:

- Yield should reuse a shared identity/matching utility rather than maintain its own partial mapping.

## Testing and Observability Gaps

### 1. Individual adapters are tested; cross-adapter identity failures are not

Evidence:

- There are unit tests for fetchers such as `yield-morpho-source.test.ts`, `yield-pendle-source.test.ts`, `yield-beefy-source.test.ts`, `yield-aave-onchain-source.test.ts`, etc.
- There is no current test coverage for duplicate-symbol collisions across tracked coins in the generic resolver path.

### 2. No invariant test guarantees that every yield-bearing coin has an explicit runtime strategy or an intentional gap

Current reality:

- `usg-tangent` has no runtime strategy.
- `cetes-etherfuse` uses implicit nav-token behavior but is not represented in the manifest.

### 3. No test protects override-pool reservation

Current failure class:

- A pool explicitly assigned in `AUTO_LENDING_POOL_MAP` can still be dynamically attached to another asset with the same symbol.

### 4. No end-to-end publication test validates all adapter-produced `yieldType` values

Current failure:

- Aave uses invalid `yieldType: "lending"` and existing tests do not catch it.

### 5. No live-coverage invariant monitors missing yield-bearing rankings

Current live gap:

- `usbd-bima`
- `usg-tangent`
- `ftusd-flying-tulip`

### 6. Source-link behavior is only partially curated

Files:

- `worker/src/lib/yield-source-links.ts:107-123`

Current failure:

- Exact label matching works for plain labels like `Morpho` or `Pendle`.
- It does not work for emitted labels like `Morpho: ...`, `Pendle: ...`, `Yearn: ...`, `Beefy: ...`.

Impact:

- Users are often sent to the coin website or app instead of the actual yield venue.

## Recommended Remediation Workstreams

This section is intentionally scoped for implementation planning, not design-finalization.

### Workstream 1: identity and matching hardening

Priority: highest

Goals:

- Eliminate symbol-only resolution anywhere a stronger identity exists.
- Make chain and address part of the canonical yield-source identity.

Expected scope:

- Auto-discovery matcher
- Protocol-native resolver
- Variant matcher
- Chain mapping
- Override reservation logic

### Workstream 2: coverage truth model

Priority: highest

Goals:

- Create a single source of truth for runtime strategy coverage.
- Distinguish:
  - explicit deterministic coverage
  - curated protocol-native coverage
  - dynamic discovery coverage
  - fallback-only coverage
  - intentional gaps

Expected scope:

- adapter manifest redesign
- coverage audit rewrite
- invariant tests for yield-bearing assets
- live coverage alerting

### Workstream 3: adapter registry refactor

Priority: high

Goals:

- Replace the current scattered adapter registration pattern with a normalized registry model.
- Co-locate fetcher, identity rules, labeling, source-key policy, and link policy.

Expected scope:

- split `sources.ts`
- split `yield-config.ts`
- centralize source metadata
- remove dead reconstruction code

### Workstream 4: publication and warning consistency

Priority: medium

Goals:

- Unify preview/persist provenance derivation.
- Use one median definition for both warnings and published payload.
- Tighten publish consistency guarantees between DB and cache surfaces.

### Workstream 5: adapter-specific quality hardening

Priority: medium

Focus order:

- BIMA quality floor and fallback behavior
- Hashnote ordering robustness
- Ondo anchor-window methodology
- protocol-native pagination/completeness guards
- protocol-native source key normalization
- source-link prefix handling

## Proposed Remediation Order

Recommended sequence for planning:

1. Fix identity and matching first.
2. Fix coverage accounting and manifest truth second.
3. Fix schema/publish hazards next.
4. Then refactor the registry/module structure.
5. Then tighten adapter-specific quality heuristics.

This order minimizes the risk of polishing adapters while the resolver is still able to attach them to the wrong assets.

## Final Assessment

The yield intelligence module has crossed the point where adding more adapters is the main problem. The main problem now is source identity discipline.

The module already contains enough good structure to recover cleanly:

- deterministic and fallback lanes are conceptually separated
- publication is guarded better than in earlier iterations
- adapter-specific tests exist

But the next phase needs to treat asset identity, coverage truth, and registry structure as first-class problems. Without that, more adapter breadth will continue to increase both production error rate and maintenance cost.
