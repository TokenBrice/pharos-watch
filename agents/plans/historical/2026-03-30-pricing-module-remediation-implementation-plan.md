# 2026-03-30 Pricing Module Remediation Implementation Plan

Companion audit:
- `agents/audits/2026-03-30-pricing-module-audit-report.md`

Goal:
- remediate every finding in the 2026-03-30 pricing audit
- prioritize accuracy and trust correctness first
- reduce hotspot complexity and mutualize pricing behavior so the next iteration on pricing is cheaper and safer

## Objectives

1. Make published price freshness honest, explicit, and policy-usable.
2. Eliminate identity-weak or sequencing-weak fallback behavior that can either publish or suppress the wrong price.
3. Make consensus output easier to reason about by separating cluster selection, published price estimation, and authority policy.
4. Preserve and improve the current multi-source design without weakening the existing safety properties.
5. Reduce hotspot file size and duplicated pricing logic through explicit adapters, canonical metadata types, and clearer policy boundaries.

## Current Baseline

Validation already completed during the audit:

- `npm run audit:pricing-providers`
- `npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/lib/__tests__/price-consensus.test.ts worker/src/lib/__tests__/price-validation.test.ts worker/src/lib/__tests__/authoritative-price-sources.test.ts`

Baseline status:

- provider drift audit: passed
- targeted pricing slice: passed

This baseline should be re-run after each phase, then expanded to repo-level validation before merge.

## Scope

In scope:

- primary pricing freshness/provenance semantics
- fallback sequencing and identity hardening
- source-registry cleanup and policy explicitness
- consensus output-model refinement
- DEX bridge freshness/provenance correctness
- CEX capability and trust-policy hardening
- source-by-source cleanup called out in the audit
- hotspot decomposition and mutualization
- required docs/methodology/version updates for any methodology-facing behavior changes

Out of scope for this plan:

- adding brand-new providers not required by the audit
- redesigning the DEX-liquidity system outside the pricing-relevant surfaces
- changing public API contracts unless the plan explicitly calls for it and the docs/version surfaces are updated together

## Implementation Constraints

These constraints apply to every workstream:

1. Migrations must remain backward-compatible.
   If any workstream needs new `price_cache` or cache-payload fields, the migration and runtime rollout must preserve the current live worker until the new code is deployed.
2. Preserve current API contracts unless a deliberate contract change is documented.
   This applies especially to:
   - `/api/stablecoins`
   - `/api/peg-summary`
   - price provenance fields exposed in cache-backed payloads
3. No manual price overrides or ad hoc asset exceptions beyond the existing authoritative-source model.
4. Any methodology-facing runtime change must update the methodology/docs surfaces in the same implementation phase, not as a later cleanup.
5. Any source-budget or timeout change must stay within the documented worker connection-budget and cron-budget constraints.

## Success Criteria

Functional:

1. Every selected price has explicit, truthful freshness semantics.
2. No fallback path can suppress a stronger later fallback merely because it claimed a weak unvalidated price first.
3. DexScreener symbol search cannot attach a price to an asset without a strong identity match.
4. DEX bridge freshness is preserved per source, not flattened to row-write time.
5. Consensus publication is easier to explain: cluster selection and published-price estimation are distinct.
6. CEX sources have explicit capability and freshness handling rather than being treated as uniformly strong hard-market inputs.
7. Pool-challenge replacement and GT probe retain transparent provenance instead of only mutating the final price/source label.

Engineering:

1. Primary and fallback source behavior are adapterized behind stable interfaces.
2. Pricing metadata has one canonical internal representation.
3. Structural validation and publication policy are separate layers.
4. The current hotspot files shrink materially and become easier to review.

Operational:

1. Provider-config drift checks are part of a reliable operator or CI workflow rather than an ad hoc local-only tool.
2. Status/debug surfaces can explain source freshness derivation and replacement provenance.

## Findings Coverage Matrix

Every finding in `agents/audits/2026-03-30-pricing-module-audit-report.md` is covered below.

| Audit finding | Remediation workstreams |
| --- | --- |
| Synthetic freshness dominates most non-oracle sources | `W1`, `W2`, `W7` |
| DefiLlama contract fallback blocks stronger later fallbacks before validation | `W3`, `W4` |
| DexScreener symbol search is identity-weak | `W4` |
| Consensus publishes one member price, not cluster median | `W5` |
| DEX bridge freshness flattened to row write time | `W2`, `W6` |
| CEX sources treated as stronger than their actual semantics justify | `W2`, `W7`, `W8` |
| Source registry semantics are too coupled / partially derived | `W2`, `W9` |
| Pricing code still concentrated in hotspots | `W3`, `W9`, `W10` |
| CoinGecko `/simple/price` freshness weakness | `W1` |
| CG ticker spread/freshness weakness | `W1`, `W7` |
| DefiLlama list provenance ambiguity | `W1`, `W2`, `W3` |
| DefiLlama contract fallback chain/address heuristic weakness | `W4` |
| Pyth coarse confidence downweighting | `W5`, `W8` |
| RedStone permissive venue admission / equal venue weighting | `W5`, `W8` |
| Curve local-fetch freshness and quote-size simplicity | `W1`, `W8` |
| Promoted DEX bridge provenance opacity | `W2`, `W6` |
| GeckoTerminal local-fetch freshness weakness | `W1`, `W6` |
| Pool-challenge replacement provenance weakness | `W6` |
| CoinMarketCap limited-identity fallback weakness | `W4`, `W8` |
| Jupiter local-fetch-only fallback semantics | `W1`, `W8` |
| DexScreener request-cap ordering weakness | `W4`, `W8` |
| Protocol-redeem provider implementation remains bespoke | `W8`, `W10` |
| Replay continuity hard to audit across types/layers | `W2`, `W9` |

## Delivery Strategy

Ship this in ten workstreams grouped into four phases.

Order matters:

- freshness and provenance integrity must land before trust-policy refinements are fully correct
- fallback identity and sequencing hardening must land before deeper refactors so current accuracy risk is reduced early
- output-model changes should follow provenance cleanup so the behavior is easier to verify
- hotspot simplification should follow the policy decisions so it consolidates the right abstractions

### Phase A. Characterize and fix current accuracy risks

`W0` Characterization and observability
`W1` Freshness and provenance integrity
`W4` Fallback identity and sequencing hardening

### Phase B. Refine trust and consensus behavior

`W2` Canonical source registry and source-fact model
`W5` Consensus output-model hardening
`W6` DEX bridge / GT / pool-challenge provenance hardening
`W7` CEX capability and trust-policy hardening

### Phase C. Simplify implementation and long-tail source behavior

`W3` Fallback candidate model and merge layer
`W8` Source-specific long-tail cleanup
`W9` Canonical metadata / validation / replay simplification

### Phase D. Structural simplification and release readiness

`W10` Hotspot decomposition, docs, methodology/versioning, and full validation

## Phase Exit Criteria

### Exit Phase A

- characterization tests exist for all Phase B semantic changes
- freshness/provenance semantics are explicit for current primary and fallback sources
- fallback identity and sequencing risks are materially reduced

### Exit Phase B

- source-registry semantics are explicit and not policy-coupled by accident
- consensus output behavior is updated and documented
- DEX provenance is preserved end to end
- CEX trust handling is capability-aware

### Exit Phase C

- fallback execution no longer relies on in-place mutation as its core control-flow contract
- canonical pricing metadata types and validation layers are in place
- long-tail source-specific weaknesses identified in the audit are closed or deliberately retired

### Exit Phase D

- hotspot decomposition is complete enough that the remaining pricing files are orchestration-thin or meaningfully reduced
- docs and methodology surfaces match the runtime
- full repo validation passes

## Workstreams

### W0. Characterization and Observability

Objective:
- lock in the current behavior before changing semantics
- add missing tests and operator-visible metadata for the audit-risk areas

Primary files:
- `worker/src/cron/__tests__/enrich-prices.test.ts`
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `worker/src/lib/__tests__/price-consensus.test.ts`
- `worker/src/lib/__tests__/price-validation.test.ts`
- `worker/src/lib/__tests__/depeg-helpers.test.ts`
- `worker/src/lib/__tests__/cex-tickers.test.ts`
- `worker/src/lib/__tests__/geckoterminal-price-probe.test.ts`
- status/admin metadata surfaces as needed

Tasks:

1. Add characterization tests for `observedAt` vs `syncedAt` and `observedAtMode`.
2. Add regression tests for “bad early fallback blocks later better fallback”.
3. Add tests for DexScreener symbol-search ambiguity and fail-closed behavior.
4. Add tests for per-protocol DEX freshness preservation.
5. Add tests covering current cluster-winner vs published-price behavior so the eventual change is explicit.
6. Add tests for GT/pool-challenge provenance after replacement.
7. Expose enough debug metadata in cron/status surfaces to audit source freshness mode and replacement provenance.

Acceptance criteria:

- every Phase A/B behavior change has characterization coverage first
- operators can inspect freshness mode and replacement provenance without reading worker logs only

Verification:

```bash
npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/lib/__tests__/price-consensus.test.ts worker/src/lib/__tests__/price-validation.test.ts worker/src/lib/__tests__/depeg-helpers.test.ts worker/src/lib/__tests__/cex-tickers.test.ts worker/src/lib/__tests__/geckoterminal-price-probe.test.ts
```

### W1. Freshness and Provenance Integrity

Objective:
- stop overstating freshness
- make every source explicit about whether its observation time is upstream, local-fetch, or unknown

Primary files:
- `worker/src/lib/pricing-types.ts`
- `worker/src/lib/primary-price-collector.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-shared.ts`
- `worker/src/lib/geckoterminal-price-probe.ts`
- `worker/src/lib/db-cache.ts`
- `worker/src/lib/depeg-helpers.ts`
- source adapters as needed

Tasks:

1. Define an explicit per-source freshness contract:
   - `observedAt`
   - `observedAtMode`
   - `freshnessKind`
   - `maxTrustedAgeSec`
2. Stop deriving these implicitly from default mode and call-site behavior.
3. Preserve true upstream timestamps where they already exist:
   - Pyth
   - RedStone
4. Mark known synthetic-local sources explicitly:
   - CoinGecko `/simple/price`
   - CoinGecko tickers
   - Binance/Kraken/Bitstamp/Coinbase current implementation
   - Curve on-chain
   - Curve oracle
   - GeckoTerminal probe
   - current fallback enrichments
5. Materialize DefiLlama list quotes as explicit typed input rather than inheriting timing from mutable asset state.
6. Persist these semantics through `price_cache`, replay, and public payloads.
7. Update depeg trust logic to prefer upstream-fresh authority over local-fetch-only authority when the result is near a state transition boundary.

Acceptance criteria:

- every selected price has explicit freshness semantics end to end
- no source silently “looks upstream-fresh” when it only has local fetch time
- downstream trust logic can distinguish freshness quality, not just freshness age

Verification:

```bash
npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/lib/__tests__/depeg-helpers.test.ts
cd worker && npx tsc --noEmit
```

### W2. Canonical Source Registry and Source-Fact Model

Objective:
- make the registry the true single source of truth for source facts and policy-relevant capabilities

Primary files:
- `shared/lib/pricing-source-registry.ts`
- `worker/src/lib/pricing-source-policy.ts`
- `worker/src/lib/primary-price-collector.ts`
- any status/UI consumers using source metadata

Tasks:

1. Replace partially-derived semantics with explicit fields.
2. Split source facts from downstream policy where needed:
   - source fact examples:
     - trust tier
     - default weight
     - has upstream timestamp support
     - default freshness kind
     - is search-derived
   - policy examples:
     - depeg-authoritative eligibility
     - single-source authoritative eligibility
     - pool-challenge exemption
     - GT-probe eligibility
3. Remove the current coupling where:
   - `supportsUpstreamObservedAt` is derived from `requiresObservedAt`
   - `canSingleSourceDepegAuthoritative` is derived from `defaultObservedAtMode`
4. Make the registry authoritative for runtime, status, and UI-facing source descriptions.

Acceptance criteria:

- registry semantics are explicit, not inferred through unrelated fields
- one source fact change does not implicitly mutate depeg-authority behavior unless intended

Verification:

```bash
npm test -- --run worker/src/lib/__tests__/price-consensus.test.ts worker/src/lib/__tests__/depeg-helpers.test.ts
```

### W3. Fallback Candidate Model and Merge Layer

Objective:
- remove in-place fallback mutation as the core control-flow mechanism

Primary files:
- `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-fallback.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-shared.ts`
- `worker/src/cron/sync-stablecoins/stages.ts`
- `worker/src/cron/sync-stablecoins/fallback.ts`

Tasks:

1. Introduce an internal `FallbackQuoteCandidate` shape.
2. Make each pass return candidates instead of mutating `PeggedAsset` directly.
3. Add a central merge/apply layer that:
   - validates candidates
   - resolves precedence
   - records provenance
   - preserves still-missing assets for later passes if earlier candidates fail validation
4. Keep pass order deterministic, but stop making shared object mutation the pass contract.

Acceptance criteria:

- pass order remains explicit
- bad early candidates do not prevent later stronger candidates from being considered
- fallback provenance is easier to test and inspect

Verification:

```bash
npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
```

### W4. Fallback Identity and Sequencing Hardening

Objective:
- close the concrete fallback integrity risks identified in the audit

Primary files:
- `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`
- `worker/src/lib/dexscreener.ts`
- stablecoin metadata/config if needed

Tasks:

1. DefiLlama contract fallback:
   - validate pass 1 / 1b candidates before they claim the asset
   - remove raw address-shape chain inference where tracked deployment metadata exists
   - prefer explicit tracked deployment expansion over guessed `ethereum:` / `solana:` defaults
2. DexScreener:
   - keep exact chain+address lookup
   - tighten symbol-search fallback so it is fail-closed unless identity is proven
   - restrict symbol search to assets with no usable tracked address path
   - if request caps remain, prioritize candidates by expected recovery value rather than original array order
3. CoinMarketCap:
   - keep slug-first behavior
   - tighten symbol fallback to explicit unique-or-curated identity only
4. Ensure validated failure on one fallback path does not suppress later better candidates.

Acceptance criteria:

- same-symbol imposters can no longer satisfy DexScreener symbol search
- DL pass 1/1b cannot block better later fallbacks with unvalidated prices
- CMC and DexScreener symbol matching are both defensible from an identity standpoint

Verification:

```bash
npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
```

### W5. Consensus Output-Model Hardening

Objective:
- make consensus easier to explain and reduce discontinuity in published prices

Primary files:
- `worker/src/lib/price-consensus.ts`
- `worker/src/lib/primary-price-collector.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- docs/methodology surfaces

Tasks:

1. Separate:
   - cluster selection
   - provenance winner selection
   - published price estimation
2. Retain `selectedSource` for transparency.
3. Publish a cluster-level estimator:
   - default recommendation: cluster median
   - alternative if desired: weighted median
4. Revisit intra-cluster precedence so trust-tier ordering does not silently defeat methodology weights.
5. Revisit Pyth confidence-to-weight logic so it is smoother than the current 3-step threshold.
6. Revisit RedStone venue-admission threshold and whether equal venue weighting is still appropriate.

Acceptance criteria:

- cluster provenance remains transparent
- published price is no longer just one agreeing source’s raw print
- weight semantics become easier to explain and audit

Verification:

```bash
npm test -- --run worker/src/lib/__tests__/price-consensus.test.ts worker/src/cron/__tests__/enrich-prices.test.ts
```

### W6. DEX Bridge / GT Probe / Pool-Challenge Provenance Hardening

Objective:
- preserve true DEX source freshness and improve replacement transparency

Primary files:
- `worker/src/lib/depeg-helpers.ts`
- `worker/src/lib/geckoterminal-price-probe.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- DEX challenger persistence surfaces if needed

Tasks:

1. Preserve per-protocol `updatedAt` from `price_sources_json` instead of overwriting it with row write time.
2. Keep row write time only as fallback metadata.
3. Ensure GT probe carries explicit replacement metadata:
   - transport used
   - protocol count
   - pool provenance
   - freshness mode
4. Ensure pool-challenge replacement preserves both:
   - original consensus provenance
   - challenger replacement provenance
5. Ensure replacement does not only mutate `price`/`source` while leaving stale `agreeSources` semantics behind.

Acceptance criteria:

- DEX bridge freshness is preserved per source
- GT and pool-challenge replacement events are reconstructable from stored metadata
- replacement provenance is visible to operators and downstream debugging

Verification:

```bash
npm test -- --run worker/src/lib/__tests__/geckoterminal-price-probe.test.ts worker/src/lib/__tests__/depeg-helpers.test.ts worker/src/cron/__tests__/enrich-prices.test.ts
```

### W7. CEX Capability and Trust-Policy Hardening

Objective:
- align CEX trust treatment with the actual capabilities of each adapter

Primary files:
- `worker/src/lib/cex-tickers.ts`
- `shared/lib/pricing-provider-config.ts`
- `shared/lib/pricing-source-registry.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- `scripts/audit-pricing-provider-config.ts`
- CI/scheduled workflow surfaces as needed

Tasks:

1. Add explicit capability metadata per CEX source:
   - bid/ask support
   - upstream timestamp availability
   - last-trade-only fallback
   - trade-age support
2. Prefer richer ticker surfaces when available without violating connection budgets.
3. If no source-native freshness exists, keep the source but do not over-claim authority.
4. Revisit whether all current CEX sources should remain equally `hard_market` for single-source authority purposes.
5. Operationalize provider-config drift detection:
   - CI gate, scheduled CI, or explicit operator cron
   - not local-only

Acceptance criteria:

- CEX trust policy is capability-aware rather than label-only
- provider-config drift cannot sit silently for long

Verification:

```bash
npm run audit:pricing-providers
npm test -- --run worker/src/lib/__tests__/cex-tickers.test.ts worker/src/cron/__tests__/enrich-prices.test.ts
```

### W8. Source-Specific Long-Tail Cleanup

Objective:
- address the smaller but real source-specific weaknesses called out in the audit

Primary files:
- `worker/src/lib/cg-ticker.ts`
- `worker/src/lib/curve-onchain.ts`
- `worker/src/lib/redstone.ts`
- `worker/src/lib/pyth.ts`
- `worker/src/lib/authoritative-price-sources.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`

Tasks:

1. CoinGecko ticker:
   - add spread/quality heuristics where available
   - preserve upstream time if exposed
2. Curve:
   - preserve block timestamp when feasible
   - evaluate whether quote-size sampling needs to be richer for fragile pools
3. RedStone:
   - revisit venue-agreement floor
   - evaluate trusted-venue weighting
4. Pyth:
   - replace coarse downweight thresholding with smoother confidence handling
5. CoinMarketCap:
   - expand explicit slug coverage where it materially improves safety
6. Jupiter:
   - preserve provider freshness metadata if a reliable field becomes available
7. Protocol-redeem:
   - move toward a provider-registry pattern so adding future authoritative sources is cheaper and less bespoke

Acceptance criteria:

- long-tail sources no longer have obvious unaddressed weaknesses from the audit
- source-specific behavior stays explainable and tested

Verification:

```bash
npm test -- --run worker/src/lib/__tests__/pyth.test.ts worker/src/lib/__tests__/redstone.test.ts worker/src/lib/__tests__/curve-onchain.test.ts worker/src/lib/__tests__/authoritative-price-sources.test.ts worker/src/cron/__tests__/enrich-prices.test.ts
```

### W9. Canonical Metadata, Validation, and Replay Simplification

Objective:
- reduce overlap between pricing types and clarify structural-vs-policy validation boundaries

Primary files:
- `worker/src/lib/pricing-types.ts`
- `worker/src/lib/price-validation.ts`
- `worker/src/lib/price-publish-policy.ts`
- `worker/src/cron/sync-stablecoins/pricing.ts`
- `worker/src/lib/db-cache.ts`
- replay surfaces

Tasks:

1. Introduce one canonical internal selected-price type.
2. Use adapters at the boundaries rather than field-by-field propagation across the pipeline.
3. Split validation into:
   - structural bounds validation
   - publication policy evaluation
   - replay policy evaluation
4. Re-express replay continuity through the canonical type so it is easier to audit end-to-end.
5. Reduce repeated validation plumbing at orchestration call sites.

Acceptance criteria:

- fewer overlapping pricing metadata shapes
- call sites make it obvious whether a check is structural, publication-grade, or replay-grade
- replay continuity is easier to audit and test

Verification:

```bash
npm test -- --run worker/src/lib/__tests__/price-validation.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/enrich-prices.test.ts
```

### W10. Hotspot Decomposition, Docs, Methodology, and Release Readiness

Objective:
- finish the structural cleanup and ship with all methodology/docs surfaces aligned

Primary files:
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`
- `worker/src/cron/sync-stablecoins/pricing.ts`
- `worker/src/lib/geckoterminal-price-probe.ts`
- `worker/src/lib/authoritative-price-sources.ts`
- `docs/pricing-pipeline.md`
- `docs/pricing-pipeline-timeline.md`
- `src/app/methodology/sections/core-sections-pricing.tsx`
- `shared/lib/pricing-pipeline-version.ts`
- About/data-source surfaces if any externally visible source treatment changes

Tasks:

1. Decompose remaining hotspot files behind stable interfaces introduced in earlier workstreams.
2. Update methodology docs for any behavior change affecting:
   - source freshness semantics
   - consensus output methodology
   - fallback identity policy
   - DEX hardening methodology
3. Update `shared/lib/pricing-pipeline-version.ts` and `docs/pricing-pipeline-timeline.md`.
4. Update `/methodology` pricing copy.
5. Update the API contract docs if provenance or freshness semantics exposed to consumers change:
   - `docs/api-reference.md`
6. Update operational/docs surfaces when behavior changes warrant it:
   - `docs/worker-and-api-limits.md` for timeout/budget/throttle changes
   - `docs/testing.md` if validation or operator checks change
   - `docs/scripts.md` if provider-audit or related tooling changes
7. Update About/data-source disclosures if source treatment or externally visible provider semantics materially change.
8. Run the full validation surface.

Acceptance criteria:

- hotspot files are materially smaller or at minimum behaviorally thinner
- docs and methodology copy match the runtime
- release is guarded by full validation, not only the targeted pricing slice

Verification:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

## Recommended Execution Order

```text
W0  Characterization and observability
W1  Freshness and provenance integrity
W4  Fallback identity and sequencing hardening
W2  Canonical source registry and source-fact model
W6  DEX bridge / GT / pool-challenge provenance hardening
W5  Consensus output-model hardening
W7  CEX capability and trust-policy hardening
W8  Source-specific long-tail cleanup
W3  Fallback candidate model and merge layer
W9  Canonical metadata / validation / replay simplification
W10 Hotspot decomposition, docs, methodology, and final validation
```

Why this order:

- `W1` and `W4` address the most direct correctness risks first
- `W2` and `W6` make later trust and consensus changes less ambiguous
- `W5` should land after provenance is honest
- `W3` and `W9` become safer after the policy decisions are settled
- `W10` consolidates and documents the stabilized behavior rather than refactoring toward a moving target

## Validation Strategy

### Per-workstream gate

For each workstream:

1. run the narrowest targeted pricing slice that covers the changed surfaces
2. keep `npm run audit:pricing-providers` green when CEX/RedStone config or trust semantics change
3. run `cd worker && npx tsc --noEmit` whenever worker/shared contracts change materially
4. if the workstream changes methodology-visible behavior, update the docs/version surfaces in the same branch before considering the workstream complete

### Behavioral comparison gate

For workstreams that change live price selection semantics, compare before/after behavior on representative assets before merge.

Minimum comparison set:

- one major USD peg with broad source coverage
- one non-USD fiat peg
- one commodity peg
- one Solana fallback-path asset
- one DEX-bridge-heavy asset
- one authoritative protocol-redeem asset

Recommended checks:

1. selected price
2. `priceSource`
3. `priceConfidence`
4. `priceObservedAt`
5. `priceObservedAtMode`
6. `agreeSources`
7. depeg-authority classification

If behavior changed, the PR should explicitly state whether the change is:

- intended accuracy improvement
- intended trust downgrade
- intended provenance correction
- unintended regression that must be fixed before merge

### Schema and replay gate

For workstreams touching `price_cache`, cache payloads, or replay behavior:

1. verify new fields are backward-compatible at read time
2. verify older rows without the new fields still parse safely
3. verify replay behavior with mixed old/new rows in tests
4. if a migration is needed, keep it backward-compatible and validate it with the existing migration gate

### Pre-merge gate

Before any push or merge for deploy-impacting work:

```bash
npm run test:merge-gate
```

### Completion gate

At the end of the full remediation program:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

## Risks and Watchpoints

1. Freshness-hardening can change depeg-authority behavior even when published prices do not change.
   Watchpoint:
   add explicit depeg-trust regression tests before changing authority policy.

2. Consensus publication switching from selected-source price to cluster estimator can change historical depeg sensitivity.
   Watchpoint:
   compare representative stressed assets before and after the change.

3. Tightening DexScreener / CMC identity rules may increase temporary missing-price counts.
   Watchpoint:
   treat “more missing but safer” as acceptable during rollout if the change is intentional and documented.

4. Hotspot refactors can accidentally weaken policy by moving behavior across files.
   Watchpoint:
   keep characterization tests in front of the refactor and avoid mixing semantic changes with pure decomposition when possible.

## Deliverables

By the end of this plan, the repo should have:

- corrected freshness semantics across the pricing pipeline
- hardened fallback identity and sequencing behavior
- refined consensus publication semantics
- improved DEX provenance and replacement transparency
- capability-aware CEX trust handling
- a cleaned-up and explicit source registry
- smaller and more modular pricing implementation surfaces
- updated pricing methodology docs and version/timeline surfaces

## Bottom Line

This plan intentionally front-loads correctness over elegance:

1. make freshness honest
2. make fallback identity safe
3. make provenance explicit
4. then simplify the code around the corrected behavior

That ordering addresses the highest-value risk first while still covering every finding identified in the 2026-03-30 audit.
