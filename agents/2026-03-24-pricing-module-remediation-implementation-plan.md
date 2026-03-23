# Pricing Module Remediation Implementation Plan

Date: 2026-03-24

Companion audit:
- `agents/2026-03-24-pricing-module-comprehensive-audit.md`

Primary goals:
- Improve price accuracy, especially under ambiguous or stressed market conditions
- Make source freshness semantics honest and auditable
- Reduce the complexity and hotspot concentration of the pricing module
- Preserve current API contracts unless a documented contract change is deliberate

Verification baseline:
- Pricing-focused test slice currently passes
- Use that slice as the first regression gate for every phase before broader repo validation

## Executive Delivery Strategy

Ship this work in six phases.

Order matters:
- Freshness integrity must land before downstream trust hardening is fully correct
- Source-adapter refactoring should happen before adding more source-specific logic
- DEX estimator changes should land after the adapter/provenance cleanup so they are easier to review

Recommended order:

| Phase | Focus | Primary Outcome | Size |
| --- | --- | --- | --- |
| 0 | Characterization and observability | Lock in current behavior and add tests for the remaining weak points | S |
| 1 | Freshness and provenance integrity | Stop overstating freshness and make observation semantics explicit | M |
| 2 | Source adapter and registry refactor | Reduce hotspot complexity and centralize runtime source behavior | L |
| 3 | Validation and publish-policy simplification | Clarify policy boundaries and reduce repeated validation glue | M |
| 4 | DEX hardening estimator upgrade | Make GT probe and pool challenge more robust and less noise-sensitive | M |
| 5 | Provider-config auditability and long-tail cleanup | Reduce drift risk in CEX / RedStone support and finish maintainability cleanup | M |

## Success Criteria

Functional success:
- Published freshness reflects what was actually observed upstream, not just when Pharos fetched it
- Synthetic-local freshness is explicit and can be downgraded appropriately
- Hard market sources no longer rely on unchecked stale last-trade prints
- GT probe and pool-challenge replacement use more robust estimators than a single best pool or full-set weighted mean

Engineering success:
- `fetchPrimaryPrices()` is materially smaller and easier to reason about
- Source weights and source behavior come from one canonical runtime registry layer
- Pricing metadata is represented by one canonical internal shape rather than several overlapping partial types
- Validation stages are explicit and no longer repeated via ad hoc plumbing

Operational success:
- Status/admin surfaces can explain not just where a price came from, but how its freshness was derived
- Manual exchange / provider configuration drift is detectable through tests or audit tooling

## Phase 0: Characterization and Observability

Objective:
- Add tests and operator-visible metadata before behavior changes.

Primary files:
- `worker/src/cron/__tests__/enrich-prices.test.ts`
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `worker/src/lib/__tests__/cex-tickers.test.ts`
- `worker/src/lib/__tests__/geckoterminal-price-probe.test.ts`
- `worker/src/lib/__tests__/price-validation.test.ts`
- `worker/src/lib/__tests__/depeg-helpers.test.ts`

Implementation tasks:
- Add characterization tests for source freshness modes:
  - true upstream timestamp source
  - local-fetch freshness source
  - missing freshness source
- Add characterization tests for CEX stale-print handling once the policy is introduced
- Add tests for GT probe and pool challenge estimator behavior so later changes are explicit rather than accidental
- Add tests that preserve replay provenance expectations during cache write/read

Acceptance criteria:
- All remaining audit findings that can regress silently have targeted test coverage
- There is at least one test asserting the distinction between `observedAt` and `syncedAt`

Verification:
```bash
npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/lib/__tests__/cex-tickers.test.ts worker/src/lib/__tests__/geckoterminal-price-probe.test.ts worker/src/lib/__tests__/price-validation.test.ts worker/src/lib/__tests__/depeg-helpers.test.ts
```

## Phase 1: Freshness and Provenance Integrity

Objective:
- Make source freshness semantics explicit and stop overstating them.

Primary files:
- `worker/src/lib/pricing-types.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/lib/geckoterminal-price-probe.ts`
- `worker/src/lib/cex-tickers.ts`
- `worker/src/lib/curve-onchain.ts`
- `worker/src/lib/cg-ticker.ts`
- `worker/src/lib/db-cache.ts`
- `worker/src/lib/depeg-helpers.ts`
- `worker/src/cron/sync-stablecoins/shared.ts`
- `docs/api-reference.md`
- `docs/pricing-pipeline.md`

Recommended internal model expansion:
```ts
type PriceObservedAtMode = "upstream" | "local_fetch" | "unknown";

interface PriceMetadata {
  source: string;
  confidence: PriceConfidence | null;
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode;
  syncedAt: number | null;
  consensusSources?: string[];
  agreeSources?: string[];
  diagnostics?: PriceSourceDiagnostics;
}
```

Implementation tasks:
- Extend source outputs to include:
  - `observedAt`
  - `observedAtMode`
- Mark Pyth and RedStone as `upstream`
- Mark CoinGecko simple price, current CEX tickers, GT probe, Curve on-chain, Curve oracle, and CG ticker as `local_fetch` unless a real upstream timestamp is available
- Persist `observedAtMode` into `price_cache`
- Update downstream trust logic to treat `local_fetch` freshness as weaker than `upstream` freshness when source authority is borderline
- Surface the distinction in status metadata where useful

Important policy recommendation:
- Do not block publication solely because freshness is `local_fetch`
- Do downgrade depeg-authority or require stronger corroboration when a price is both:
  - from a source that only has local-fetch freshness
  - near a state transition threshold

Acceptance criteria:
- Every selected price carries explicit freshness semantics
- `price_cache` replay preserves freshness mode
- `classifyPrimaryDepegTrust()` can incorporate freshness mode rather than only age and source key

Verification:
```bash
npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/lib/__tests__/geckoterminal-price-probe.test.ts worker/src/lib/__tests__/depeg-helpers.test.ts
cd worker && npx tsc --noEmit
```

## Phase 2: Source Adapter and Registry Refactor

Objective:
- Reduce the size and coupling of the primary pricing hotspot.

Primary files:
- `worker/src/cron/enrich-prices.ts`
- New: `worker/src/lib/primary-price-adapters.ts`
- New: `worker/src/lib/primary-price-collector.ts`
- `shared/lib/pricing-source-registry.ts`
- `worker/src/lib/pricing-source-policy.ts`

Implementation tasks:
- Introduce a source-adapter executor for primary sources
- Move repetitive fetch / parse / breaker-accounting patterns behind adapter helpers
- Stop hardcoding most weights inline in `fetchPrimaryPrices()`
- Extend the source registry so it can answer:
  - default weight
  - trust tier
  - freshness capability
  - authoritative eligibility
  - probe / challenge eligibility
- Keep only dynamic weight transformations outside the registry, such as Pyth confidence downweighting

Recommended decomposition:
- `collectPrimaryQuotes()`
- `buildPrimarySourceCandidates(asset, collectedQuotes)`
- `runPrimaryConsensus(asset, candidates, references)`
- `applyPostConsensusHardening(results, ...)`

Acceptance criteria:
- `fetchPrimaryPrices()` becomes orchestration-only
- Runtime weight assignment is registry-driven for all stable source keys
- Adding a new source no longer requires touching multiple unrelated sections of one file

Verification:
```bash
npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/lib/__tests__/price-consensus.test.ts worker/src/lib/__tests__/pyth.test.ts worker/src/lib/__tests__/redstone.test.ts worker/src/lib/__tests__/cex-tickers.test.ts worker/src/lib/__tests__/curve-onchain.test.ts
npm run check:hotspot-ratchet
```

## Phase 3: Validation and Publish-Policy Simplification

Objective:
- Separate structural sanity checks from publish-policy decisions and reduce repeated validation calls.

Primary files:
- `worker/src/lib/price-validation.ts`
- `worker/src/cron/sync-stablecoins/pricing.ts`
- `worker/src/cron/sync-stablecoins/post-enrichment.ts`
- New: `worker/src/lib/price-publish-policy.ts`

Implementation tasks:
- Split the current validator into:
  - structural bounds validation
  - publish policy evaluation
- Make policy-stage functions explicit:
  - `validatePrimaryConsensusCandidate`
  - `validateFallbackCandidate`
  - `validateReplayCandidate`
  - `validatePublishedAssetPrice`
- Centralize severe downside and temporal jump rules into the publish-policy layer
- Reduce the number of places where raw `validatePublishablePrice()` is wired manually

Important design constraint:
- Keep the safety properties
- Do not weaken replay gating or temporal jump quarantine during simplification

Acceptance criteria:
- It is obvious from the call site whether a check is structural or publication-grade
- Validation logic is reused through stage-specific helpers rather than repeated argument plumbing
- The pricing pipeline has fewer redundant validation passes at the orchestration layer

Verification:
```bash
npm test -- --run worker/src/lib/__tests__/price-validation.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/enrich-prices.test.ts
```

## Phase 4: DEX Hardening Estimator Upgrade

Objective:
- Improve the robustness of the GT probe and pool-challenge replacement mark.

Primary files:
- `worker/src/lib/geckoterminal-price-probe.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/lib/depeg-helpers.ts`
- Potentially `worker/src/cron/dex-liquidity/challenger-persistence.ts`
- `docs/pricing-pipeline.md`
- `src/app/methodology/sections/core-sections.tsx`
- `shared/lib/pricing-pipeline-version.ts`
- `docs/pricing-pipeline-timeline.md`

Implementation tasks:
- GT probe:
  - move from single highest-TVL pool to robust multi-pool estimation
  - aggregate by protocol first where possible
  - use protocol median or weighted median rather than single-pool selection
- Pool challenge replacement:
  - use only corroborating divergent protocol groups when building replacement price
  - prefer weighted median over full-set weighted mean
- Preserve the current 2-protocol corroboration requirement unless live evidence shows it is too strict

Acceptance criteria:
- DEX hardening remains conservative but produces less estimator noise
- Replacement marks are easier to explain operationally
- Tests cover multi-pool and multi-protocol edge cases explicitly

Verification:
```bash
npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/lib/__tests__/geckoterminal-price-probe.test.ts worker/src/lib/__tests__/depeg-helpers.test.ts
```

## Phase 5: Provider-Config Auditability and Long-Tail Cleanup

Objective:
- Reduce silent drift risk in provider support configuration and finish the maintainability cleanup.

Primary files:
- `worker/src/lib/cex-tickers.ts`
- `worker/src/lib/redstone.ts`
- New: `scripts/` or `worker/src/api/` audit helper, depending on preferred workflow
- `docs/testing.md`
- `docs/pricing-pipeline.md`
- `agents/` follow-up audit notes as needed

Implementation tasks:
- Move exchange market support definitions into auditable config objects
- Add a lightweight audit script or admin diagnostic path that can verify:
  - configured Binance/Kraken/Bitstamp/Coinbase pairs still exist
  - configured RedStone symbols are still supported
- If exchange APIs expose timestamps or ticker freshness metadata, upgrade adapters to reject stale last-trade prints
- Consolidate repeated helper patterns across source modules where practical

Acceptance criteria:
- Manual provider support lists are no longer "trust me" static code
- Drift in provider support is testable or auditable
- Source modules become smaller and more declarative

Verification:
```bash
npm test -- --run worker/src/lib/__tests__/cex-tickers.test.ts worker/src/lib/__tests__/redstone.test.ts
npm run lint
```

## Cross-Phase Guardrails

Apply these rules throughout the rollout:

1. Do not weaken current replay-safety rules.
2. Do not silently change public payload semantics without updating docs.
3. If methodology behavior changes, update:
   - `docs/pricing-pipeline.md`
   - `src/app/methodology/sections/core-sections.tsx`
   - `shared/lib/pricing-pipeline-version.ts`
   - `docs/pricing-pipeline-timeline.md`
4. Keep D1 changes backward-compatible.
5. Run the pricing-focused suite before broader validation on every phase.

## Final Validation Before Push

At the end of each landed phase:
```bash
npm test -- --run worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/lib/__tests__/price-consensus.test.ts worker/src/lib/__tests__/price-validation.test.ts worker/src/lib/__tests__/cex-tickers.test.ts worker/src/lib/__tests__/pyth.test.ts worker/src/lib/__tests__/redstone.test.ts worker/src/lib/__tests__/curve-onchain.test.ts worker/src/lib/__tests__/geckoterminal-price-probe.test.ts worker/src/lib/__tests__/authoritative-price-sources.test.ts
npm run lint
cd worker && npx tsc --noEmit
```

Before pushing any branch:
```bash
npm run test:merge-gate
```

## Recommended Immediate Next Step

Start with Phase 0 and Phase 1 together in one branch if you want a high-value first tranche:
- add the freshness/provenance characterization tests
- introduce explicit freshness modes
- persist them through `price_cache`
- update downstream trust classification to understand the difference

That gives the biggest accuracy benefit with the least algorithmic risk, and it also creates the right foundation for the later refactors.
