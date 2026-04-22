# Remaining Wrapper / Variant Gap Sweep And Integration Plan

Date: 2026-04-22
Status: audit + rollout recommendation

## Goal

Identify the tracked stablecoins that still semantically belong in the wrapper-variant framework but are not yet marked with `variantOf` / `variantKind`, then recommend the safest rollout path for bringing them in.

## Assumptions

- This is a planning pass only. No production behavior changes are proposed in this document.
- "Remaining wrapper / variants" means assets already tracked in `shared/data/stablecoins/*.json` whose primary user expectation is still exposure to an upstream tracked stablecoin or tracked parent rail, but whose relationship is still expressed only indirectly through fields such as `pegReferenceId`, `dependencies`, `reserves[].coinId`, live-reserve configs, yield ownership, or pricing inheritance.
- The current shipped framework is the source of truth for what already counts as a tracked variant.

## Current shipped baseline

The repo currently treats exactly 10 active assets as tracked variants:

- `susde-ethena`
- `susds-sky`
- `stusds-sky`
- `sdai-sky`
- `busd0-usual`
- `scrvusd-curve`
- `sfrxusd-frax`
- `cusdo-openeden`
- `syusd-aegis`
- `stkgho-umbrella-aave`

That baseline is enforced in [shared/lib/__tests__/stablecoins.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/__tests__/stablecoins.test.ts).

The current framework also still has these important hard constraints:

- only active assets may declare `variantOf` / `variantKind`
- the parent must be an active tracked stablecoin
- the parent must not itself be a variant
- the child must currently keep `flags.navToken === true`
- the child must currently keep `pegReferenceId === variantOf`
- the enum currently supports only:
  - `savings-passthrough`
  - `risk-absorption`
  - `bond-maturity`

Those constraints live in [shared/lib/stablecoins/validate-variants.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/stablecoins/validate-variants.ts) and [shared/types/core.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/core.ts).

## Audit method

I cross-checked:

- the current schema and validator
- the 10 shipped tracked variants
- all active tracked assets that still look wrapper-like through one or more of:
  - `pegReferenceId`
  - `dependencies[].type === "wrapper"`
  - `reserves[].depType === "wrapper"`
  - `governanceQuality: "wrapper"`
  - `yieldBearing + navToken`
- the current deferred wrapper-framework specs and follow-up audits in `/agents/`
- current pricing and redemption docs for M0 extension assets and anchor-asset vaults

The key prior repo artifacts I reused were:

- [agents/staked-wrapped-assets-methodology-audit-2026-04-21.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/staked-wrapped-assets-methodology-audit-2026-04-21.md)
- [agents/specs/2026-04-22-wrapper-variant-framework-design.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/specs/2026-04-22-wrapper-variant-framework-design.md)
- [agents/specs/2026-04-22-wrapper-variant-framework-post-v1-family-matrix.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/specs/2026-04-22-wrapper-variant-framework-post-v1-family-matrix.md)
- [agents/audits/2026-04-22-wrapper-variant-framework-implementation-readiness.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-04-22-wrapper-variant-framework-implementation-readiness.md)

That readiness audit is especially useful because it already captured a GPT-5.4 xhigh reviewer synthesis and explains why the repo intentionally stopped short of the broader design.

## Findings

### 1. High-confidence true child variants over tracked product parents

These are the clearest remaining gaps. Each one already has a tracked parent inside the registry and already encodes the relationship indirectly.

| Asset | Parent | Recommended family | Why it belongs |
| --- | --- | --- | --- |
| `susdai-usd-ai` | `usdai-usd-ai` | `strategy-vault` | Separate reserve book, queued withdrawals, GPU-credit exposure, direct `pegReferenceId` to parent |
| `msy-main-street` | `msusd-main-street` | `strategy-vault` | ERC-4626 over `msUSD`, strategy-vault share semantics already modeled in reserves/live adapter |
| `said-gaib` | `aid-gaib` | `strategy-vault` | ERC-4626 share over `AID`, 30-day queue, financing-book exposure |
| `stcusd-cap` | `cusd-cap` | `strategy-vault` | ERC-4626 share over `cUSD`, operator-lending exposure, parent-linked exit path |
| `sbold-k3-capital` | `bold-liquity` | `risk-absorption` or `strategy-vault` | Strong parent-child case, but family choice still needs an explicit call |

What these assets already have today:

- a tracked parent stablecoin
- `navToken: true`
- child-owned yield surfaces
- parent-linked reserve or peg metadata
- wrapper-like semantics already reflected in scoring or reserve composition

Why they are still unmarked:

- the shipped framework does not yet have `strategy-vault`
- `sBOLD` was left out because its dominant risk semantics were not frozen

### 2. Anchor-asset vaults that should not be forced into `variantOf`

These assets are wrappers over a tracked anchor asset, but not true product children of the anchor issuer.

| Asset | Anchor | Recommended family | Recommendation |
| --- | --- | --- | --- |
| `yusd-yieldfi` | `usdc-circle` | `anchor-asset-vault` | Do not use `variantOf: usdc-circle` |
| `yousd-yield-optimizer` | `usdc-circle` | `anchor-asset-vault` | Do not use `variantOf: usdc-circle` |
| `syrupusdc-maple` | `usdc-circle` | `anchor-asset-vault` | Do not use `variantOf: usdc-circle` |
| `syrupusdt-maple` | `usdt-tether` | `anchor-asset-vault` | Do not use `variantOf: usdt-tether` |

Why these are different:

- the economic starting asset is clear
- the product-parent relationship is not
- using `variantOf` here would make the UI and scoring imply that Circle or Tether is the parent product
- the readiness audit already flags this as semantic overload

These belong in a broader wrapper framework, but not in the current `variantOf = true product parent` contract.

### 3. Parent-missing case

| Asset | Missing parent | Recommendation |
| --- | --- | --- |
| `wsrusd-reservoir` | base `rUSD` is not tracked | Do not mark yet; add `rUSD` first or keep `wsrUSD` standalone |

`wsrUSD` is clearly a child savings token, but the current framework requires the parent to be an active tracked stablecoin. The repo does not currently track `rUSD`, so there is no clean parent to point at.

### 4. M0 extension units are a separate family, not a v1-style variant

The repo already treats several M0-lineage assets as inheriting pricing from `wm-m0`, but the current variant schema cannot represent them cleanly.

Current examples:

- `wm-m0` over `m-m0`
- `usdn-noble`
- `usdk-kast`
- `xo-exodus`
- `usdnr-nerona`
- `usdsc-startale`

Why they do not fit the current variant contract:

- some are not `navToken: true`
- some are extension or distribution units rather than staked/NAV vault shares
- the repo currently models them through authoritative pricing inheritance, redemption docs, and infrastructure taxonomy rather than through `variantOf`

These deserve their own later family such as `extension-unit` or `parent-rail extension`, but they should not be folded into the shipped nav-child framework without an explicit schema expansion.

Relevant current evidence:

- [worker/src/lib/authoritative-price-sources.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/authoritative-price-sources.ts)
- [docs/pricing-pipeline.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/pricing-pipeline.md)
- [docs/pricing-pipeline-timeline.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/pricing-pipeline-timeline.md)

### 5. Assets that look wrapper-like but are not current marking gaps

These should stay out of this rollout:

- `usdat-saturn`
  - this is the tracked base token, not the missing child savings token
  - the untracked child is `sUSDat`, not a missing `variantOf` on `USDat`
- `fpi-frax`
  - parent dependency exists, but the product is a CPI/index unit rather than a simple wrapped child whose primary expectation is direct FRAX exposure
- `ousd-origin-protocol`, `iusd-infinifi`, and similar base products
  - they are standalone products with their own reserve stacks, not merely unmarked child rows

## Recommended rollout plan

### Phase 1: extend the current framework to true `strategy-vault` children only

Scope:

- `susdai-usd-ai`
- `msy-main-street`
- `said-gaib`
- `stcusd-cap`

Optional with explicit sign-off:

- `sbold-k3-capital`

Recommended new enum:

- `strategy-vault`

Why this should be the next implementation step:

- these are true child products over already-tracked parents
- they are the highest-signal remaining metadata gaps
- they avoid semantic abuse of `variantOf`
- the repo already has a deferred design for them

Required repo work before data annotation:

1. Make `variantOf` first-class in dependency and stress plumbing, not just reserve-derived dependency edges.
2. Add explicit parent-first ordering for `variantOf` relationships.
3. Decide how `strategy-vault` handles peg:
   - either keep the current parent-linked behavior temporarily
   - or add a real wrapper-direct peg/NAV path first
   The current nav-token pipeline still skips these assets for direct peg analytics, so stripping `pegReferenceId` immediately is not safe.
4. Include live reserve adapters in the migration, because live reserve output can override authored JSON semantics.
5. Add UI/filter/docs support for the new family.

This phase should land only after the blockers from [agents/audits/2026-04-22-wrapper-variant-framework-implementation-readiness.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-04-22-wrapper-variant-framework-implementation-readiness.md) are explicitly closed.

### Phase 1b: classify `sBOLD` explicitly

`sBOLD` is a real remaining gap, but it should not be bundled into the first `strategy-vault` PR by default.

Recommended decision rule:

- choose `risk-absorption` if Stability Pool loss-absorption is the primary economic risk
- choose `strategy-vault` if K3 vault governance / solver / conversion logic is judged dominant

If the team wants the smallest incremental follow-up after Phase 1, `sBOLD` can be its own PR.

### Phase 2: add a separate anchor-asset wrapper family

Scope:

- `yusd-yieldfi`
- `yousd-yield-optimizer`
- `syrupusdc-maple`
- `syrupusdt-maple`

Recommended direction:

- do not overload `variantOf`
- introduce a separate field such as `anchorAssetId` or `underlyingAssetId`
- keep these under the broader wrapper framework, but outside the strict parent-child variant contract

Why this should be separate:

- the semantic parent is the asset rail, not the issuer product
- the readiness audit already identified `variantOf` overloading here as a design bug

### Phase 3: add an extension-unit family for M0 lineage

Scope candidates:

- `wm-m0`
- `usdn-noble`
- `usdk-kast`
- `xo-exodus`
- `usdnr-nerona`
- `usdsc-startale`

Recommended direction:

- add a new family for direct wrapper or extension units over a parent rail
- relax the current `child must be navToken` invariant if this family is adopted
- reuse the current pricing and redemption inheritance behavior as the starting point

This is conceptually different from the stablecoin-vault families and should not be coupled to Phase 1.

### Phase 4: resolve parent coverage blockers

Scope:

- `wsrusd-reservoir`
- any future tracked `sUSDat`

Recommended direction:

- if the product wants `wsrUSD` inside the variant framework, track base `rUSD` first
- do not invent synthetic parent ids
- treat untracked-parent cases as data-coverage gaps, not schema exceptions

## Smallest safe next step

If the goal is to keep scope tight and get immediate value, the next concrete implementation target should be:

1. design-lock `strategy-vault`
2. close the current readiness blockers for dependency, stress, peg, and live-reserve plumbing
3. annotate the four strongest true-child products:
   - `susdai-usd-ai`
   - `msy-main-street`
   - `said-gaib`
   - `stcusd-cap`
4. handle `sBOLD` in a separate follow-up decision PR

That gives the framework the biggest remaining product gain without re-opening the already-rejected `variantOf = USDC/USDT` shortcut.

## Summary

The remaining gaps are not one homogeneous backlog.

There are three distinct classes:

1. **True missing tracked variants**
   - `sUSDai`, `msY`, `sAID`, `stcUSD`, and probably `sBOLD`
2. **Wrapper products that need a broader family, not `variantOf`**
   - `yUSD-YieldFi`, `yoUSD`, `syrupUSDC`, `syrupUSDT`
3. **Extension units and parent-missing cases**
   - M0 extension assets and `wsrUSD`

The correct next move is therefore not "mark every remaining wrapper." It is:

- expand the current variant framework to `strategy-vault` for true child products first
- keep anchor-asset vaults and extension units as separate follow-up families
- avoid overloading `variantOf` beyond true product-parent relationships
