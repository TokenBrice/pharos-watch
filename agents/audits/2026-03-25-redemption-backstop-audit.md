# Redemption Backstop Audit

Date: 2026-03-25

## Scope

This audit covers the full live redemption backstop implementation:

- shared registry and scoring:
  - `shared/lib/redemption-backstops.ts`
  - `shared/lib/redemption-backstop-configs/*`
  - `shared/lib/redemption-backstop-scoring.ts`
  - `shared/lib/redemption-backstop-confidence.ts`
- worker build/store/API path:
  - `worker/src/cron/sync-redemption-backstops.ts`
  - `worker/src/lib/redemption-backstop-sources.ts`
  - `worker/src/lib/redemption-backstop-live-metadata.ts`
  - `worker/src/lib/redemption-backstops-store.ts`
  - `worker/src/api/redemption-backstops.ts`
- downstream scoring / UI consumers:
  - `shared/lib/report-cards.ts`
  - `worker/src/lib/report-cards-snapshot.ts`
  - `src/components/stablecoin-detail/redemption-backstop-card.tsx`
- all reserve adapters that can influence redemption capacity or fee telemetry:
  - `openeden-usdo`
  - `sky-makercore`
  - `gho`
  - `infinifi`
  - `falcon`
  - `ethena`
  - `reservoir`
  - `single-asset`
  - `evm-branch-balances`
  - `fx`
  - `asymmetry`

## Verification

The current implementation is operational and its dedicated checks are green:

- `npm run check:redemption-backstops`
- `npx vitest run shared/lib/__tests__/redemption-backstop-consistency.test.ts shared/lib/__tests__/redemption-backstops.test.ts shared/lib/__tests__/redemption-backstop-scoring.test.ts worker/src/lib/__tests__/redemption-backstop-sources.test.ts worker/src/lib/__tests__/redemption-backstops-store.test.ts worker/src/cron/__tests__/sync-redemption-backstops.test.ts worker/src/api/__tests__/redemption-backstops.test.ts`

Result:

- registry check passed
- 7 redemption-focused test files passed
- 93/93 tests passed

That does not mean the module is already where it should be. Several of the main issues below are modeling-boundary, evidence-quality, and maintainability problems that current tests either allow or do not cover.

## Snapshot

- Configured routes: 143
- Route families:
  - offchain-issuer: 78
  - stablecoin-redeem: 20
  - collateral-redeem: 20
  - queue-redeem: 14
  - psm-swap: 8
  - basket-redeem: 3
- `reserve-sync-metadata` routes: 9
- Routes with `reviewedAt`: 131
- Routes with explicit `docs[]`: 95
- Routes with no `reviewedAt`: 12
- Routes still using heuristic capacity (excluding `reserve-sync-metadata`): 12

The system is feature-complete enough to be useful, but the current confidence and evidence model overstates how clean some live paths really are.

## Findings

### 1. Critical: redemption consumes reserve metadata with a much weaker trust boundary than collateral scoring

Evidence:

- `worker/src/lib/live-reserves-store.ts:880-895` filters collateral passthrough to fresh independent `ok` snapshots.
- `worker/src/lib/live-reserves-store.ts:898-923` returns redemption metadata from the latest successful snapshot without filtering on:
  - `last_status === "ok"`
  - evidence class
  - degrading warnings
- `worker/src/lib/redemption-backstop-live-metadata.ts:19-34` treats reserve metadata as fresh using only `fetchedAt`.
- `worker/src/cron/sync-live-reserves.ts:276-324` writes snapshots as `degraded` when warnings are present, but still records them as latest-success snapshots.
- `worker/src/lib/redemption-backstop-sources.ts:152-225` and `worker/src/lib/redemption-backstop-sources.ts:262-327` consume that metadata for fee and capacity scoring without checking `warningCount`, `warnings`, `evidenceClass`, or sync status.
- `worker/src/lib/__tests__/redemption-backstop-sources.test.ts:258-274` explicitly accepts weak-live-probe fee telemetry as valid input for redemption scoring.

Why this matters:

- A reserve snapshot can be degraded because the upstream source is stale, has material unknown exposure, or contains unmapped assets, and redemption will still use it as if it were clean.
- A recent local fetch can mask stale upstream data because redemption freshness is based on `fetchedAt`, not `sourceTimestamp`.
- The module therefore has a stronger public confidence presentation than its actual live evidence boundary.

Impact:

- Accuracy risk: live redemption capacity and fee inputs can drift away from true executable capacity.
- Confidence inflation: routes can surface as `dynamic` or even `high` confidence based on metadata that collateral scoring would refuse to use.

Recommendation:

- Add a redemption-specific eligibility gate, e.g. `isReserveMetadataEligibleForRedemption()`, and require:
  - `last_status === "ok"`
  - allowed evidence classes
  - no degrading warnings
  - verified source freshness when the adapter advertises a freshness budget
- Stop using `fetchedAt` alone as the freshness decision when `sourceTimestamp` exists.

### 2. Critical: `pusd-plume` is wired as a dynamic route, but its live adapter cannot currently produce dynamic capacity

Evidence:

- `shared/lib/redemption-backstop-configs/offchain-issuer.ts:327-338` configures `pusd-plume` as `reserve-sync-metadata` with `fallbackRatio: 1` and notes that fresh live reserve metadata can score against the tracked single-asset backing.
- `worker/src/cron/reserve-adapters/single-asset.ts:86-111` emits only:
  - `freshnessMode`
  - optional `redemptionFeeBps`
  - no `immediateRedeemableUsd`
  - no `immediateRedeemableRatio`
- `worker/src/lib/redemption-backstop-sources.ts:281-327` requires `immediateRedeemableUsd` or `immediateRedeemableRatio` for the route to resolve dynamically.
- `shared/lib/live-reserve-adapters.ts:460` marks `single-asset` as `weak-live-probe`.

What this means in practice:

- `pusd-plume` cannot currently resolve a dynamic redemption-capacity path from its live reserve adapter.
- It will always fall back to the configured 100% heuristic ratio when supply is available.
- The config note currently overstates what the implementation can actually do.

Impact:

- Accuracy risk: the route can look cleaner and more data-driven than it really is.
- Maintainability risk: config, adapter, and runtime semantics are out of sync.

Recommendation:

- Choose one of these paths explicitly:
  - keep `pusd-plume` as reviewed heuristic and remove the dynamic-capacity framing
  - add a dedicated adapter/output field that actually emits a redeemable-capacity metric
  - replace `reserve-sync-metadata` with a documented-bound model if no live redeemable metric exists

### 3. High: the module collapses very different live telemetry shapes into one `dynamic` confidence bucket

Evidence:

- `shared/lib/redemption-backstop-confidence.ts:12-16` maps all `reserve-sync-metadata` routes to `capacityConfidence = "dynamic"` by default.
- `shared/lib/redemption-backstop-confidence.ts:72-83` upgrades any resolved `dynamic + non-undisclosed fee` route to `modelConfidence = "high"`.
- `worker/src/lib/redemption-backstop-sources.ts:270-307` assigns `capacityConfidence = "dynamic"` whenever fresh reserve metadata resolves, regardless of adapter quality or whether the metric is direct or proxy-based.

The problem is that the 9 live-capacity routes are not equivalent:

- Stronger/direct capacity telemetry:
  - `openeden-usdo`
  - `sky-makercore`
  - `gho`
  - `infinifi`
- Proxy capacity telemetry:
  - `ethena` uses stable bucket / Liquid Cash as immediate capacity (`worker/src/cron/reserve-adapters/ethena.ts:79-125`)
  - `falcon` uses total stable bucket as immediate capacity (`worker/src/cron/reserve-adapters/falcon.ts:135-185`)
  - `reservoir` uses all USDC positions as immediate capacity (`worker/src/cron/reserve-adapters/reservoir.ts:139-209`)
- Weak probe:
  - `single-asset` is explicitly classified as `weak-live-probe` (`shared/lib/live-reserve-adapters.ts:460`)

Why this matters:

- A direct redeemable-liquidity measurement and a coarse stable-bucket proxy should not land in the same confidence band.
- Proxy routes can overstate "immediate capacity" because they infer executable liquidity from reserve composition rather than from a dedicated redeemable-buffer metric.

Recommendation:

- Split current `dynamic` into at least:
  - `direct-live-capacity`
  - `proxy-live-buffer`
  - `weak-live-probe`
- Make `modelConfidence` depend on adapter evidence and telemetry kind, not only on `capacityConfidence` and fee confidence.

### 4. High: docs provenance and UI messaging can overstate evidence quality

Evidence:

- `worker/src/lib/redemption-backstop-sources.ts:67-142` falls back from explicit reviewed docs to:
  - live reserve display links
  - proof-of-reserves links
  - generic project links
- The same helper always copies `reviewedAt` into the returned docs object when `config.reviewedAt` exists (`worker/src/lib/redemption-backstop-sources.ts:77-83`).
- `src/components/stablecoin-detail/redemption-backstop-card.tsx:177-182` renders the resolved source list.
- `src/components/stablecoin-detail/redemption-backstop-card.tsx:151-161` has provenance labels, but
- `src/components/stablecoin-detail/redemption-backstop-card.tsx:323-327` prefers `Reviewed <date>` over showing fallback provenance whenever `reviewedAt` exists.

Current inventory:

- 48 of 143 configs have no explicit `docs[]`
- 131 of 143 configs have `reviewedAt`

That combination means a reviewed route can show a fallback link while visually reading like it is the reviewed primary source.

Impact:

- Informational integrity issue: the UI can make fallback evidence look stronger than it is.
- Reviewability issue: future maintainers cannot tell which exact sources supported the judgment without redoing the manual research.

Recommendation:

- Require explicit `docs[]` for every `documented-bound` route.
- Preserve and display both:
  - `reviewedAt`
  - provenance (`config-reviewed`, `proof-of-reserves`, `preferred-link`, etc.)
- Never let a fallback source visually replace the fact that the displayed link is only a fallback.

### 5. High: the main guardrails do not enforce the evidence rules the feature now depends on

Evidence:

- `scripts/check-redemption-backstops.ts:98-110` only checks:
  - dynamic-or-unclear fee description exists
  - `feeBps >= 0`
  - `0 < supply-ratio <= 1`
- It does not check:
  - documented-bound routes must have `reviewedAt`
  - documented-bound routes must have explicit `docs[]`
  - `reserve-sync-metadata` routes must point to adapters that emit `immediateRedeemable*`
  - weak-live-probe adapters are blocked from dynamic capacity
  - degraded reserve snapshots are excluded from redemption

Impact:

- Registry quality can regress without CI noticing.
- Config/adapter mismatches like `pusd-plume` are easy to introduce and hard to detect.

Recommendation:

- Extend `check:redemption-backstops` and the consistency tests with:
  - documented-bound source requirements
  - reserve-sync adapter capability checks
  - evidence-class allowlist checks
  - no-weak-live-probe dynamic-capacity rule

### 6. Medium: 12 routes remain unreviewed and 12 remain heuristic, concentrated in a small tail

Unreviewed routes:

- `zarp-zarp`
- `cetes-etherfuse`
- `cgo-comtech`
- `dgld-gold-token-sa`
- `dai-makerdao`
- `usds-sky`
- `dusd-alto`
- `ussd-sonic-labs`
- `usdp-parallel`
- `iusd-infinifi`
- `dusd-dtrinity`
- `yousd-yield-optimizer`

Heuristic-capacity routes:

- `zarp-zarp`
- `cetes-etherfuse`
- `cgo-comtech`
- `dgld-gold-token-sa`
- `dusd-alto`
- `ussd-sonic-labs`
- `usdp-parallel`
- `uty-xsy`
- `dusd-dtrinity`
- `yousd-yield-optimizer`
- `yusd-aegis`
- `usn-noon`

This is not catastrophic because low-confidence routes do not uplift report-card liquidity, but it is still a live-data quality gap and should be handled as an explicit remediation backlog rather than left implicit in code.

### 7. Medium: the config surface is harder to review than it needs to be

Evidence:

- `shared/lib/redemption-backstop-configs/offchain-issuer.ts` is 839 lines.
- The combined config surface is 1,824 lines across the family files.
- The offchain file in particular is a long sequence of similar object literals with repeated:
  - `...issuerBase`
  - `...reviewedDirectRedemptionSupplyFull`
  - `costModel`
  - `docs`
  - `notes`

Impact:

- High copy/paste risk.
- Hard to spot missing `docs`, missing `reviewedAt`, or inconsistent access/settlement changes in review.
- Difficult to mass-update policy across similar issuer routes.

Recommendation:

- Move to family-specific factories or data-first records, for example:
  - `reviewedIssuer({ ids, fee, docs, notes, settlement })`
  - `reviewedFormulaCollateral({ id, docs, outputAssetType, adapterExpectation })`
- Keep code for route mechanics, move data rows into thinner objects.

### 8. Medium: the cron path does unnecessary per-coin D1 work

Evidence:

- `worker/src/cron/sync-redemption-backstops.ts:65-97` processes all 143 configs one by one.
- `worker/src/lib/redemption-backstop-sources.ts:276-279` fetches reserve snapshot metadata on demand when it is not provided.
- `worker/src/lib/redemption-backstop-sources.ts:447-456` also fetches that metadata per coin before building each entry.

Impact:

- N+1 D1 reads during every hourly pass.
- More code paths to reason about than necessary.

Recommendation:

- Preload latest reserve metadata for all redemption-enabled coins once per run.
- Pass a map into entry builders.
- Optionally precompute static score fragments from config since access/settlement/output/family logic is immutable between runs.

### 9. Medium: history storage is not rich enough for real forensic replay

Evidence:

- `worker/src/lib/redemption-backstops-store.ts:188-200` stores only selected details in `details_json`.
- `worker/src/lib/redemption-backstops-store.ts:306-333` history rows persist:
  - `score`
  - `effective_exit_score`
  - `dex_liquidity_score`
  - methodology version
  - partial details JSON
- It does not persist:
  - component subscores
  - `immediateCapacityUsd`
  - `immediateCapacityRatio`
  - `feeBps`
  - provider/source fields

Impact:

- Hard to explain historical score changes.
- Hard to audit whether a score moved because of fee telemetry, reserve buffer drift, DEX input, or config changes.

Recommendation:

- Expand history payload to persist the full runtime entry or at least:
  - component subscores
  - capacity and fee runtime fields
  - provider, source mode, and model confidence

## Adapter Review

### Route-family adapters

#### `offchain-issuer`

Assessment: broad coverage, weakest maintainability profile.

Strengths:

- Good breadth across fiat-backed and commodity-backed issuer rails.
- Most routes were reviewed and upgraded to documented-bound.

Weaknesses:

- 78 routes in one file.
- 27 routes have no explicit `docs[]`.
- 4 routes still have no `reviewedAt`.
- A large share of the family depends on eventual-only full-supply assumptions, which is acceptable as a floor but not especially precise.

#### `psm-and-basket`

Assessment: small and mostly coherent.

Strengths:

- Low route count.
- Mostly explicit docs and notes.

Weaknesses:

- `dai-makerdao` and `usds-sky` are still unreviewed and undocumented despite being core routes.
- `dusd-alto` remains unreviewed heuristic.

#### `collateral-redeem`

Assessment: conceptually strong, but source traceability is mixed.

Strengths:

- Formula-backed routes are modeled consistently.
- `fxUSD`, `fpi`, `gyd`, `cUSD`, `cEUR` are reasonably well described.

Weaknesses:

- 12 of 20 entries have no explicit docs.
- Several routes use formula fees but have no machine-readable proof source attached.
- Mixed-collateral formula routes with different live adapter quality can still compress into the same confidence tiers.

#### `queue-redeem`

Assessment: good semantics, moderate precision.

Strengths:

- Queue semantics are modeled honestly.
- Maple and Falcon are reasonably well described.

Weaknesses:

- `iusd-infinifi` is still unreviewed and undocumented.
- `uty-xsy` remains heuristic by design and should stay explicitly flagged until a true buffer metric exists.

#### `stablecoin-redeem`

Assessment: mixed-quality family with some of the best and some of the weakest entries.

Strengths:

- Good reviewed routes for `OUSD`, `frxUSD`, `JupUSD`, `msUSD`, `AID`, `USD.AI`, `USDe`.

Weaknesses:

- 4 heuristic routes remain.
- `wsrUSD-reservoir` is driven by a proxy capacity signal, not a dedicated redeemable-liquidity metric.
- `yousd-yield-optimizer` and `dusd-dtrinity` remain thinly evidenced.

### Live reserve adapters used by redemption

#### Stronger direct capacity sources

- `openeden-usdo`
  - good shape: direct `usdcAmount` buffer plus supply ratio
  - still uses unverified freshness metadata, so redemption currently trusts local fetch freshness more than upstream freshness certainty
- `sky-makercore`
  - reasonable direct signal for current PSM USDC
  - biggest issue is not the adapter itself, but redemption ignoring degraded reserve status
- `gho`
  - strongest live implementation in the set
  - explicitly excludes frozen/seized modules and captures fee range
- `infinifi`
  - better than a proxy because it consumes `totalLiquidAssetNormalized`
  - freshness remains unverified

#### Proxy capacity sources

- `ethena`
  - current immediate capacity is entire `Liquid Cash` bucket
  - useful signal, but still a bucket proxy rather than an explicit redeemable-liquidity field
- `falcon`
  - current immediate capacity is all stable bucket exposure
  - useful floor, but too optimistic to carry the same `dynamic` confidence as direct liquidity telemetry
- `reservoir`
  - current immediate capacity is all USDC positions
  - especially fragile proxy because these are positions, not necessarily idle same-block redeemable liquidity

#### Weak / unsuitable for dynamic capacity

- `single-asset`
  - fine for reserve display and fee probes
  - not sufficient for dynamic redemption capacity
  - should not back `reserve-sync-metadata` capacity unless it is extended to emit an explicit redeemable-capacity field

#### Fee-only live telemetry

- `evm-branch-balances`
  - acceptable for onchain fee probes
- `fx`
  - acceptable as protocol-specific live reserve input
- `asymmetry`
  - acceptable as protocol-specific live reserve input

The core issue is not that these adapters are bad. It is that the redemption layer currently treats them as more interchangeable than they really are.

## Test and Guardrail Gaps

Current coverage is good for happy-path construction and contract stability, but weak on evidence-policy enforcement.

Missing or insufficient tests:

- reserve-sync routes must reject weak-live-probe capacity inputs
- degraded reserve snapshots must not feed redemption
- `sourceTimestamp` staleness must block redemption even when local `fetchedAt` is recent
- `documented-bound` routes must carry explicit docs
- `reserve-sync-metadata` configs must map to adapters that emit capacity fields
- fallback docs plus `reviewedAt` must not render as if the fallback link itself was reviewed

## Recommended Remediation Order

### P0: correctness and confidence boundary

1. Introduce a redemption metadata eligibility gate.
2. Block degraded, weak-live-probe, and stale-upstream snapshots from affecting redemption.
3. Fix `pusd-plume` so the config matches what the adapter can actually provide.
4. Stop using proxy bucket telemetry as plain `dynamic` without qualification.

### P1: traceability and guardrails

1. Require `docs[]` and `reviewedAt` for every documented-bound route.
2. Extend `check:redemption-backstops` with evidence and compatibility rules.
3. Fix the detail card so provenance is always visible alongside review date.
4. Add tests for degraded/warning/evidence-class gating.

### P2: maintainability and auditability

1. Refactor config files into factories or data-first tables.
2. Preload reserve metadata during the hourly sync to remove N+1 reads.
3. Persist richer history so score changes can be explained after the fact.

## Bottom Line

The redemption backstop module is already useful and reasonably well tested, but it is not yet strict enough about what counts as trustworthy live redemption evidence.

The top remediation priority is not more coverage. It is tightening the trust boundary between live reserve snapshots and redemption scoring so that:

- weak probes cannot masquerade as dynamic capacity
- degraded or stale upstream data cannot silently influence live scores
- confidence labels mean what they imply

Once that boundary is fixed, the next best return is cleaning up the config surface and enforcing explicit source traceability for every reviewed route.
