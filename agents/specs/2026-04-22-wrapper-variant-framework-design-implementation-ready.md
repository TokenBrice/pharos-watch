# Wrapper / Staked Variant Framework Design

Date: 2026-04-22
Status: Implementation-ready rewrite after multi-review audit
Methodology target: Report Cards v7.08 -> **v7.09**

## Problem

Pharos needs a first-class way to model wrapped and staked stablecoins whose primary user expectation is still exposure to a tracked parent stablecoin.

Today that relationship is not canonical:

1. Parent/child links are inferred indirectly from `pegReferenceId`, reserve slices, and redemption notes.
2. Dependency scoring only sees the parent when a reserve-derived dependency exists.
3. Stress recomputation loses wrapper-only parent relationships because variant metadata is not persisted into the report-card payload.
4. The UI treats these assets as flat rows with almost no parent/child navigation.

The repo can support a safe v1 if the framework is narrowed to true tracked parent variants and if the parent relationship becomes an explicit runtime concept in report-card and UI plumbing.

## Scope

### In scope: true tracked parent variants

V1 covers active stablecoins whose economic story is "this is a wrapped or staked form of another tracked stablecoin" and whose peg behavior should continue to inherit from that parent.

| Child ID | Parent ID | Kind |
|---|---|---|
| `susde-ethena` | `usde-ethena` | `savings-passthrough` |
| `susds-sky` | `usds-sky` | `savings-passthrough` |
| `sdai-sky` | `dai-makerdao` | `savings-passthrough` |
| `sfrxusd-frax` | `frxusd-frax` | `savings-passthrough` |
| `scrvusd-curve` | `crvusd-curve` | `savings-passthrough` |
| `cusdo-openeden` | `usdo-openeden` | `savings-passthrough` |
| `syusd-aegis` | `yusd-aegis` | `savings-passthrough` |
| `stusds-sky` | `usds-sky` | `risk-absorption` |
| `stkgho-umbrella-aave` | `gho-aave` | `risk-absorption` |

### Out of scope for v1

These assets stay on their current modeling path until Pharos has a separate anchor-asset or fair-value/NAV framework:

- `susdai-usd-ai`
- `msy-main-street`
- `stcusd-cap`
- `said-gaib`
- `yusd-yieldfi`
- `syrupusdc-maple`
- `syrupusdt-maple`
- `busd0-usual`
- `sbold-k3-capital` (`strategy-vault`, deferred from v1)

Also out of scope:

- parent-specific taxonomy routes under `/stablecoins/variants/*`
- command palette grouping
- comparison-page variant logic
- contagion-graph mode changes
- yield leaderboard logo overlays
- OG / JSON-LD variant treatment
- any attempt to reinterpret `navToken` globally

## Core decisions

### 1. `variantOf` means true tracked parent only

`variantOf` is a canonical product-parent pointer, not a generic "starts from this asset" pointer.

If an asset is best described as an anchor-asset vault over USDC/USDT rather than a product variant of Circle/Tether, it does not receive `variantOf` in v1.

### 2. V1 `variantKind` is intentionally narrow

Only two values ship in v1:

```ts
"savings-passthrough" | "risk-absorption"
```

This keeps the first implementation aligned with the user's wrapped/staked use case and avoids inventing fair-value logic for strategy vaults or bond products.

### 3. `pegReferenceId` stays in place for all v1 variants

V1 does **not** strip `pegReferenceId`.

Reason:

- the worker still excludes `navToken` assets from direct peg analytics in report-card snapshot generation
- in-scope variants are all parent-pegged wrappers/staked products
- retaining `pegReferenceId === variantOf` keeps peg inheritance explicit and avoids a risky nav-token peg redesign in the same rollout

### 4. `navToken` semantics do not change in v1

`navToken` stays authored and keeps its existing runtime meaning.

V1 does not attempt to solve direct peg scoring for independent NAV products. That is deferred.

### 5. Variant relationships must exist as synthetic wrapper edges in report-card paths

The parent relationship cannot live only in metadata or only in reserves.

For report-card computation, dependency graph generation, and stressed recomputation, a variant contributes a synthetic `wrapper` dependency edge from parent -> child even if the authored reserve data does not create one.

### 6. V1 scoring changes are intentionally narrow

V1 changes only the parts that need an explicit parent relationship:

- dependency-risk ceiling
- overall parent cap
- inherited active-depeg cap propagation
- report-card transparency for parent-capped wrappers

V1 does **not** change:

- resilience inheritance
- decentralization inheritance
- liquidity inheritance
- live reserve adapter semantics

Those dimensions stay on current authored/runtime logic until a later phase.

### 7. UI scope is core detail + table only

The first rollout improves the surfaces users already use:

- variant detail page
- parent detail page
- homepage directory table
- homepage filters
- report-card overall summary chip

No new route family ships in v1.

### 8. Yield registry alignment is part of v1

For tracked savings wrappers that are already first-class stablecoins, v1 must stop publishing the wrapper yield source on the base asset through base-owned configuration of any kind, including:

- `YIELD_VARIANT_MAP`
- `YIELD_POOL_MAP`
- base-side on-chain wrapper readers
- wrapper-specific optional tracked-source entries

For the affected parent assets, wrapper-owned yield also stops being represented as parent-owned metadata. If the tracked child wrapper is the only yield path, the parent should no longer be treated as `yieldBearing`.

Historical yield rows that were recorded under those parent ids as wrapper-owned APY are not grandfathered. V1 must stop `/api/yield-history` from continuing to serve that misattributed history under the parent ids.

This is not a read-only audit item. It is a required dedup pass for the affected parent ids.

## Data model

### StablecoinMeta additions

Files:

- `shared/types/core.ts`
- `shared/lib/stablecoins/schema.ts`

```ts
export const VARIANT_KIND_VALUES = [
  "savings-passthrough",
  "risk-absorption",
] as const;

export type VariantKind = typeof VARIANT_KIND_VALUES[number];

variantOf?: string;
variantKind?: VariantKind;
```

### Validation model

Object-level Zod validation remains local-file only. Canonical parent validation must happen in a shared helper that is called by both the runtime registry loader and `scripts/check-stablecoin-data.ts`.

V1 rules:

1. `variantOf` and `variantKind` co-require.
2. Only active assets may declare them.
3. `variantOf` must point to an active tracked stablecoin.
4. `variantOf !== id`.
5. The parent may not itself declare `variantOf`.
6. The parent may not be a `navToken`.
7. `pegReferenceId === variantOf` for every v1 variant.
8. `flags.navToken === true` for every v1 variant.

Implementation note:

- keep schema-level co-require validation
- add a shared validation helper used by both the registry loader and `scripts/check-stablecoin-data.ts`

### Variant helper surface

Create `shared/lib/stablecoins/variants.ts`:

```ts
getVariantParent(id: string): StablecoinMeta | null
getVariants(parentId: string): StablecoinMeta[]
getVariantRelationship(id: string): {
  parent: StablecoinMeta
  kind: VariantKind
  siblings: StablecoinMeta[]
} | null
isTrackedVariant(id: string): boolean
```

These helpers are the shared source of truth for UI and report-card plumbing.

## Report-card and dependency design

### Variant-aware dependency helper

Do **not** overload `deriveDependencies()` in `shared/lib/reserve-templates.ts`.

Instead add a wrapper helper used only by report-card and dependency-graph paths:

```ts
deriveVariantAwareDependencies(meta)
```

Behavior:

1. Start from `deriveDependencies(meta)`.
2. If `meta.variantOf` is absent, return those dependencies unchanged.
3. If `meta.variantOf` is present, normalize the parent relationship to one synthetic dependency:
   - `id = meta.variantOf`
   - `type = "wrapper"`
   - `weight = 1`
4. If a reserve-derived dependency already points to the same parent, replace it rather than duplicating it.

Reason:

- topological order must see the parent
- dependency risk must always see a wrapper ceiling
- stress recomputation must carry the same edge
- this should not depend on authored reserve-shape quirks

### Dependency Risk

V1 uses an archetype-keyed wrapper penalty:

```ts
"savings-passthrough" -> 3
"risk-absorption" -> 5
```

Fallback rule:

- existing non-variant `wrapper` dependencies keep the legacy `upstream - 3` ceiling

`scoreDependencyRisk()` should therefore receive explicit dependencies plus optional `variantKind`, while preserving legacy wrapper behavior for out-of-scope assets.

### Overall parent cap

For v1 variants only:

```ts
wrapper.overallScore <= parent.overallScore
```

Enforce in both:

- live report-card computation
- `computeStressedGrades()`

Surface the result as:

```ts
overallCapped?: boolean
uncappedOverallScore?: number | null
```

If the parent overall score is `null`, skip the cap and keep the child's computed score. `overallCapped` stays false.

`baseScore` keeps its existing meaning. When a parent cap fires, UI and API consumers must use `uncappedOverallScore` to explain the parent-cap delta instead of treating the entire `baseScore - overallScore` gap as peg drag.

### Raw payload requirements for stress mode

Persist variant metadata into the report-card payload so stressed recomputation can reapply wrapper rules without rehydrating full stablecoin metadata:

```ts
rawInputs.variantParentId?: string | null
rawInputs.variantKind?: VariantKind | null
```

`rawInputs.dependencies` must be the variant-aware dependency list, not the reserve-only list.

### Active depeg cap propagation

Fix the inherited-cap bug:

- when peg is inherited from `pegReferenceId`
- use the referenced coin id, not `meta.id`, when resolving `activeDepegPeakBpsById`

This keeps severe parent depegs from disappearing on wrappers.

### Redemption runtime alignment

For the 9 in-scope variants, inherited severe-depeg handling must stay aligned between:

- report-card active-depeg caps
- redemption-route impairment logic

V1 therefore extends inherited-parent handling into the redemption-backstop availability path for tracked variants whose `pegReferenceId === variantOf`.

This inherited impairment only applies where a redemption-backstop config already exists for the wrapper. V1 does not add new backstop configs for the remaining in-scope variants.

### Dependency graph

`shared/lib/dependency-graph.ts` should include the same synthetic wrapper edges used by report-card logic so the safety-score graph and stressed dependency traversal stay consistent.

This is a passive shared-data change that will affect existing dependency-map / contagion / coverage outputs even though no bespoke UI redesign ships in v1.

## UI design

### Variant detail pages

Add:

1. Hero chip: `Variant of [parent symbol]`
2. Underlying asset card above the current overview/notices block
3. Overall cap note in the report-card summary when `overallCapped === true`

No dimension-by-dimension inheritance chips ship in v1.

Placement rule:

- collapse the duplicate `#overview` ownership to one section
- the outer detail-page composition owns `id="overview"`
- the nested overview component should not keep a second `id="overview"`
- v1 does not add a new scrollspy section id

### Parent detail pages

Add a dedicated `Variants` card that lists children from `getVariants(parentId)`.

Do not try to reuse `CollateralUsageSection` for this relationship.

Tracked variants rendered in the new `Variants` card must be excluded from the collateral-usage surface so parents do not show the same child twice.

### Homepage directory

Add:

1. small variant badge in the symbol cell

V1 badge vocabulary:

- `Savings`
- `Risk-Abs`

Density/accessibility rule:

- `list` and `compact` densities show the badge only
- `comfortable` and `spacious` keep the same row-height and name-cell structure as today
- both the focusable row and the inner detail link must expose full variant wording when present, for example `Savings variant` or `Risk absorption variant`

### Homepage filter bar

Add a global variant filter group:

- `All variants`
- `Savings`
- `Risk-Abs`

Semantics:

- `All variants` means "one of the 9 v1 tracked variants"
- no `Base` / `Non-variant` bucket ships in v1

This is implemented through `FilterTag` and `getFilterTags()`, not through new routes.

## Documentation and rollout

### Methodology

V1 is a methodology change in three surfaces:

- Safety Scores: parent-variant dependency ceilings and overall caps become explicit
- Yield Intelligence: wrapper-owned yield moves off affected parent assets onto tracked children
- Redemption Backstops: inherited severe-parent-depeg impairment applies to configured tracked wrappers

Update:

- `shared/lib/safety-score-version-data.ts` -> `7.09`
- `shared/lib/yield-methodology-version.ts`
- `shared/lib/redemption-backstop-version.ts`
- `docs/report-cards.md`
- `docs/yield-intelligence.md`
- `docs/redemption-backstops.md`
- `src/app/methodology/sections/core/safety-scores-section.tsx`
- methodology scoring changelog content
- `agents/process/adding-a-stablecoin.md`

### Safety-grade history / alerts

Do not add bridge rows to `safety_grade_history`.

That would create fake public history transitions and still leave alert timing ambiguous.

Instead:

- keep `safety_grade_history` as the public daily history contract
- add a private alert-only safety source cache written on the same cadence as the live report-card publication path
- store all live cards in that private cache, including:
  - `grade`
  - `score | null`
  - `methodologyVersion`
- have `dispatch-telegram-alerts` compare `alert:safety-snapshot` against that same alert-only safety source cache
- keep methodology-change safety alerts suppressed on that single shared clock

This keeps alerts on one runtime clock while leaving the public history surface unchanged.

## Deferred follow-ups

1. Strategy-vault and bond-maturity variant semantics
2. Anchor-asset relationships for USDC/USDT vaults
3. Fair-value/NAV-aware peg evaluation for independent NAV products
4. Parent-specific taxonomy routes
5. Command palette grouping
6. Contagion / comparison / yield leaderboard / OG work

## Success criteria

1. Exactly the 9 in-scope assets above validate as tracked variants.
2. Every tracked variant has:
   - a valid active tracked parent
   - `pegReferenceId === variantOf`
   - `variantKind` in the v1 enum
3. Report-card dependency risk and stress recomputation both see the parent relationship even when reserves alone would not.
4. A parent severe active depeg still caps the child wrapper.
5. Variant detail and parent detail pages expose the relationship without new route families.
6. The homepage can filter variants globally with existing filter mechanics.
