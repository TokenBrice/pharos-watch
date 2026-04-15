# Redemption Backstop Foundation Audit

Date: 2026-04-15

## Scope

This audit reviewed the current Redemption Backstop implementation end to end:

- static route registry and route-family configs in `shared/lib/redemption-backstop-configs/*`
- shared scoring, confidence, and API types in `shared/lib/redemption-backstop-*.ts` and `shared/types/redemption.ts`
- live-reserve adapter capabilities and reserve metadata bridge
- hourly worker sync, D1 persistence, and `/api/redemption-backstops`
- Safety Score / report-card consumption
- stablecoin detail page rendering
- registry checks, focused tests, and methodology/API docs

Assumption: this audit treats the feature as a Safety Score input, not only as an informational detail card. Findings are prioritized by score-correctness and operational-risk impact first, then maintainability.

## Verification

Focused validation passes on the current tree:

```text
npm run check:redemption-backstops

Redemption backstop checks passed (147 configs; offchain-issuer=81, stablecoin-redeem=21, collateral-redeem=19, queue-redeem=15, psm-swap=8, basket-redeem=3).
```

```text
npx vitest run \
  shared/lib/__tests__/redemption-backstop-consistency.test.ts \
  shared/lib/__tests__/redemption-backstops.test.ts \
  shared/lib/__tests__/redemption-backstop-scoring.test.ts \
  worker/src/lib/__tests__/redemption-backstop-sources.test.ts \
  worker/src/lib/__tests__/redemption-backstops-store.test.ts \
  worker/src/cron/__tests__/sync-redemption-backstops.test.ts \
  worker/src/api/__tests__/redemption-backstops.test.ts \
  worker/src/lib/__tests__/report-cards-snapshot.test.ts

Test Files  8 passed (8)
Tests       118 passed (118)
```

Passing tests do not invalidate the findings below; several risks are currently encoded as accepted behavior or are untested boundary cases.

## Current Shape

- Configured backstop routes: 147.
- Route families: 81 offchain issuer, 21 stablecoin redeem, 19 collateral redeem, 15 queue redeem, 8 PSM swap, 3 basket redeem.
- Reserve-sync capacity routes: 9:
  - `usdo-openeden` via `openeden-usdo` direct capacity
  - `dai-makerdao` and `usds-sky` via `sky-makercore` proxy capacity
  - `gho-aave` via `gho` direct capacity and live fee
  - `iusd-infinifi` via `infinifi` proxy capacity
  - `usdf-falcon` via `falcon` proxy capacity
  - `usde-ethena` via `ethena` proxy capacity
  - `zchf-frankencoin` via `collateral-positions-api` direct bridge capacity
  - `wsrusd-reservoir` via `reservoir` proxy capacity
- Low-confidence resolved config routes: 12.
- The registry split and checks are materially better than earlier audit baselines. The current issues are now mostly around evidence semantics, snapshot integrity, and downstream score communication.

## Findings

### P0 - Live capacity freshness can be bypassed by adapter capability metadata

The live reserve capacity gate treats an adapter's declared capacity capability as enough to pass the scoring-grade freshness branch:

- `worker/src/lib/redemption-backstop-live-metadata.ts:101-104` only returns the "lacks scoring-grade freshness evidence" reason when both `hasScoringEligibleFreshness` is false and no capacity telemetry is available.
- `worker/src/lib/redemption-backstop-live-metadata.ts:153-156` sets capacity telemetry as available whenever the adapter declares `direct` or `proxy`, even before checking whether the current metadata has a trustworthy source timestamp.
- `worker/src/lib/redemption-backstop-capacity.ts:96-124` then accepts the snapshot as dynamic capacity if `canUseCapacity` is true and an immediate-capacity field is present.

Impact:

Unverified or timestamp-poor protocol API snapshots can influence live redemption capacity as long as the adapter is marked `direct` or `proxy`. That is especially risky for proxy routes (`infinifi`, `reservoir`, `ethena`, `falcon`) where the "capacity" is inferred from a reserve bucket rather than a protocol-native redemption-limit feed. It also makes the docs promise stronger than the runtime boundary: the docs say reserve-sync capacity requires scoring-grade freshness evidence, but the code can accept current adapter telemetry without it.

Recommendation:

Introduce a typed `redemptionCapacityFreshness` contract separate from generic reserve freshness. Require scoring-grade freshness by default. Allow narrowly explicit exceptions only when the capacity proof is inherently current, such as same-run onchain balance reads, and record that basis in the row. For proxy protocol APIs without source timestamps, fall back to reviewed bounds or mark the route unrated instead of scoring it as dynamic capacity.

### P0 - Eventual-only routes can receive full capacity credit and uplift Liquidity / Exit

`supply-full` routes are correctly labeled `eventual-only`, but the scoring path still gives them full-capacity scoring inputs:

- `worker/src/lib/redemption-backstop-capacity.ts:187-198` turns `supply-full` into `scoringCapacityUsd = supplyUsd` and `scoringCapacityRatio = 1`.
- `shared/lib/redemption-backstop-scoring.ts:103-135` converts those values into a high or full capacity subscore.
- `shared/lib/report-card-peg-liquidity.ts:126-154` excludes only unresolved, low-confidence, impaired, unavailable, or severe-active-depeg non-live-direct routes. Medium-confidence `eventual-only` routes remain eligible for Safety Score Liquidity / Exit uplift.

Impact:

This is the largest methodology risk. The API tells users immediate capacity is "not separately quantified", while Safety Scores can still treat the route as a strong exit path when the route is documented-bound and medium confidence. This is defensible for some fully onchain systems, but too broad as a default because eventual redeemability and near-term exit liquidity are not equivalent.

Recommendation:

Split "redemption quality" from "liquidity uplift eligibility." Consider requiring `capacitySemantics === "immediate-bounded"` for report-card uplift, or apply a separate cap/penalty to `eventual-only` routes unless access, settlement, and current exercisability evidence prove it functions like an immediate exit. The detail card can still show eventual redeemability as a route attribute without allowing it to dominate Liquidity / Exit.

### P0 - Snapshot freshness is based on `MAX(updated_at)`, so partial writes can make mixed snapshots look fresh

Current persistence writes rows in chunks, then readers treat the freshest row as the freshness timestamp:

- `worker/src/lib/redemption-backstops-store.ts:376-391` chunks current/history upserts across many D1 batches.
- `worker/src/lib/redemption-backstops-store.ts:418-426` loads all rows and reports `latestUpdatedAt = MAX(updated_at)`.
- `worker/src/lib/report-cards-snapshot-inputs.ts:129-135` treats the entire redemption map as fresh when that single max timestamp is fresh.

Impact:

If an hourly sync updates some chunks and then fails, a mixed-generation snapshot can be reported as fresh. Report cards would consume old rows beside fresh rows without row-level freshness filtering. This is a low-frequency but high-blast-radius failure mode because the feature now directly affects Safety Scores.

Recommendation:

Add a snapshot generation identifier or manifest row. Readers should only serve a generation after all expected configured IDs have been written for that generation. At minimum, use `MIN(updated_at)` plus expected row count for freshness gating, or row-filter stale entries before report cards use them.

### P1 - `effectiveExitScore` means different things in the redemption API and report cards

The redemption snapshot computes `effectiveExitScore` for any resolved row unless DEX liquidity was stale or the route was impaired:

- `worker/src/lib/redemption-backstop-sources.ts:151-154` does not gate the stored `effectiveExitScore` on model confidence.
- `shared/lib/report-card-peg-liquidity.ts:126-154` later recomputes eligibility and excludes low-confidence routes and severe-active-depeg non-live-direct routes.
- `src/components/stablecoin-detail/redemption-backstop-card-view-model.ts:270-271` shows the exit score whenever it is non-null.
- `docs/api-reference.md:1621-1654` says report cards may recompute, but the field table still describes `effectiveExitScore` as the blended exit score used by report cards.

Impact:

The standalone redemption surface can show an "Exit" score that Safety Scores would not use. This creates avoidable confusion for users and downstream API consumers, especially on the 12 low-confidence resolved routes and any route where report cards apply additional active-depeg gating.

Recommendation:

Rename or split the field. For example:

- `modeledEffectiveExitScore`: raw redemption/Dex blend for the backstop snapshot.
- `safetyEligibleEffectiveExitScore`: report-card-gated score.
- `redemptionLiquidityEligibilityReason`: structured exclusion reason.

At minimum, the detail card should label non-eligible exits explicitly instead of presenting them as the same "Exit" concept used by Safety Scores.

### P1 - Ethena's immediate-capacity ratio uses backing assets as the denominator, not supply

The Ethena adapter publishes:

- `immediateRedeemableUsd = stableBucketUsd`
- `immediateRedeemableRatio = stableBucketUsd / computedTotalBackingAssetsInUsd`

Evidence: `worker/src/cron/reserve-adapters/ethena.ts:118-127`.

The rest of the redemption model and UI treat `immediateCapacityRatio` as share of supply:

- `worker/src/lib/redemption-backstop-capacity.ts:105-110` trusts a supplied ratio before deriving one from current supply.
- `src/components/stablecoin-detail/redemption-backstop-card-view-model.ts:178-180` renders it as "% of supply."

Impact:

For `usde-ethena`, the capacity ratio can be semantically different from every other route. If backing assets diverge from circulating supply, the capacity subscore and UI wording become inaccurate.

Recommendation:

Standardize ratio semantics in the resolver: when `immediateRedeemableUsd` is present and the current supply is available, derive `immediateCapacityRatio = immediateRedeemableUsd / supplyUsd` centrally. Adapter-provided ratios should either be validated as supply denominators or stored under an adapter-specific metadata key that does not feed scoring.

### P1 - Cron health uses a route-count tolerance, not score-impact or market-impact tolerance

The sync allows a 1% missing-capacity tail:

- `worker/src/cron/sync-redemption-backstops.ts:19-24` computes `ceil(configured * 1%)`, currently allowing 2 missing-capacity rows.
- `worker/src/cron/sync-redemption-backstops.ts:130-146` does not degrade while missing capacity remains within that count.

Impact:

One or two missing-capacity rows can include high-supply or high-score-impact assets and still leave the cron `ok`. The status signal is coverage-count based, while the product impact is score-weighted. This is now too weak for a Safety Score input.

Recommendation:

Report both route-count and impact-weighted health. Degrade or warn when missing capacity affects top-N market cap assets, assets whose report-card liquidity would change materially, or any route marked `live-direct`. Keep count tolerance for long-tail noise, but add impact-aware status metadata and alerting.

### P1 - Route availability is still only market-implied severe depeg evidence

The data model now has route status fields, but runtime evidence is narrow:

- `worker/src/lib/redemption-backstop-availability.ts` only loads open severe depeg events and emits `market-implied` degraded status.
- The type system reserves `operator-notice`, `protocol-api`, and `onchain`, but no current source path populates them.

Impact:

The USR-style failure mode is better covered, but the system still has no first-class path for known paused routes, cohort-limited redemptions, protocol API downtime, onchain pause flags, or incident notices until the market has already moved enough to create a severe active depeg. As backstops influence ratings more, this lag matters.

Recommendation:

Add a small route-availability source layer before expanding route coverage further. Start with a curated incident/status registry and a few onchain/API probes for protocols where pause state is cheap and reliable. Make `routeStatus` a primary scoring gate, not just an active-depeg fallback.

### P2 - Stored detail parsing trusts enum strings without validation

`redemption_backstop.details_json` is decoded best-effort, but enum fields are type-cast rather than schema-validated:

- `worker/src/lib/redemption-backstops-store.ts:88-128` accepts any string for fields such as `resolutionState`, `capacityConfidence`, `feeModelKind`, `routeStatus`, and `holderEligibility`.

Impact:

A malformed or forward-incompatible stored row can leak invalid enum values into the API response. The frontend query schema may reject the entire response, turning one bad row into a consumer-visible failure.

Recommendation:

Parse `details_json` with the shared Zod enums or small local allowlists, dropping invalid values to safe defaults. This is a low-effort hardening change with good blast-radius reduction.

### P2 - The adapter contract does not validate redemption telemetry bounds

Live reserve adapter validation checks slice quality and generic freshness, but it does not validate redemption-specific metadata such as:

- `immediateRedeemableUsd >= 0`
- `0 <= immediateRedeemableRatio <= 1`
- `redemptionFeeBps >= 0`
- ratio denominator semantics
- whether adapter-returned capacity fields are allowed for the declared telemetry mode

Impact:

Current adapters mostly look careful, but the contract is implicit. Future adapter changes can accidentally publish negative, over-1, stale, or wrongly-denominated telemetry and still pass generic reserve validation until redemption scoring behaves strangely.

Recommendation:

Add redemption telemetry validation in the live reserve validation pass, keyed by `redemptionTelemetry`. This belongs close to adapter output validation, before metadata is persisted and reused by the backstop sync.

## Healthy Foundation Areas

- The route-family registry split is maintainable and the duplicate/family checks are useful.
- The sync now preloads reserve metadata once for configured IDs instead of doing repeated per-coin metadata reads.
- Severe active depeg gating is a strong improvement over the earlier static-route-only model.
- Report cards correctly suppress stale redemption snapshots at the top level and recompute liquidity eligibility instead of blindly trusting stored `effectiveExitScore`.
- The detail card now exposes confidence, route status, provenance, capacity semantics, and unresolved/impaired states.
- Focused test coverage is strong around the intended current behavior.

## Recommended Remediation Order

1. Tighten live capacity freshness and telemetry eligibility. This directly affects dynamic capacity scores.
2. Decide how `eventual-only` should affect Safety Score Liquidity / Exit, then encode that as an explicit scorer rule.
3. Make redemption snapshots generation-consistent before readers treat them as fresh.
4. Split raw modeled exit from Safety Score eligible exit in API/UI.
5. Normalize immediate-capacity ratio semantics, starting with Ethena.
6. Add impact-weighted cron health for missing capacity.
7. Add route-availability sources beyond severe active depegs.
8. Harden stored details parsing and adapter telemetry validation.

