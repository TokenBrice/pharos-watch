# Wrapper / Staked Variant Framework Implementation Plan

Date: 2026-04-22
Status: Implementation-ready rewrite after multi-review audit
Source spec: `agents/specs/2026-04-22-wrapper-variant-framework-design-implementation-ready.md`

## Goal

Ship a low-risk parent-variant framework for true wrapped/staked stablecoins whose user expectation is still exposure to a tracked parent stablecoin.

This rollout makes the parent relationship first-class in metadata, report-card dependency/cap logic, and core UI surfaces without trying to solve independent NAV products, anchor-asset vaults, or new taxonomy route families in the same change.

## Scope

### In scope

The 9 active parent-pegged variants from the revised spec:

- `susde-ethena`
- `susds-sky`
- `sdai-sky`
- `sfrxusd-frax`
- `scrvusd-curve`
- `cusdo-openeden`
- `syusd-aegis`
- `stusds-sky`
- `stkgho-umbrella-aave`

### Explicitly out of scope

- `susdai-usd-ai`
- `msy-main-street`
- `stcusd-cap`
- `said-gaib`
- `yusd-yieldfi`
- `syrupusdc-maple`
- `syrupusdt-maple`
- `busd0-usual`
- `sbold-k3-capital` (`strategy-vault`, deferred from v1)
- parent-specific taxonomy routes under `/stablecoins/variants/*`
- command palette grouping
- comparison page logic
- contagion-graph mode changes
- yield leaderboard logo overlays
- OG / JSON-LD variant work
- resilience/decentralization/liquidity inheritance
- any `navToken` semantic rewrite
- any `pegReferenceId` stripping

## Architecture summary

The implementation has four moving parts:

1. Metadata:
   - add `variantOf` and a narrow `variantKind`
   - validate the relationship through a shared helper called by both the runtime registry and `check:stablecoin-data`
   - annotate only the 9 in-scope assets
2. Report-card plumbing:
   - synthesize a canonical parent `wrapper` edge for variant-aware paths
   - use that edge in topological ordering, dependency scoring, dependency graph generation, stressed recomputation, and inherited severe-depeg handling
   - add a parent overall cap for the 9 in-scope variants
3. UI:
   - expose the relationship on detail pages, parent pages, the directory table, and the homepage filter bar
4. Methodology / rollout:
   - bump to v7.09
   - keep public safety history unchanged while making the internal Telegram safety snapshot advance to the new methodology version
   - remove base-side yield-wrapper duplication for tracked savings wrappers

## Assumptions

- Single PR is the preferred path.
- `pegReferenceId` remains the authoritative peg-inheritance key for all 9 in-scope variants.
- The current `navToken` skip behavior in peg analytics remains untouched in v1.
- No new public API field removal ships in this change.
- No D1 migration is required for report-card cache storage.

## Success criteria

- Exactly 9 active stablecoins validate as tracked variants.
- Every tracked variant has:
  - `variantOf`
  - `variantKind`
  - `pegReferenceId === variantOf`
  - an active tracked parent different from itself
- Dependency Risk sees the parent relationship even when reserves alone would not expose it.
- `computeStressedGrades()` re-applies variant dependency edges and parent overall caps.
- Parent severe-active-depeg caps still cascade to wrappers that inherit peg from the parent.
- Base assets no longer publish duplicated wrapper yield sources for tracked savings wrappers.
- Variant detail pages and parent detail pages expose the relationship with no new route family.
- The homepage table can filter `All variants / Savings / Risk-Abs`.
- Final validation passes:
  - `npm run check:stablecoin-data`
  - `npm test -- shared/lib/__tests__/stablecoins.test.ts`
  - `npm test -- shared/lib/stablecoins/__tests__/variants.test.ts`
  - `npm test -- shared/lib/__tests__/dependency-graph.test.ts`
  - `npm test -- shared/lib/__tests__/report-cards.test.ts`
  - `npm test -- worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts`
  - `npm test -- worker/src/lib/__tests__/report-cards-snapshot.test.ts`
  - `npm test -- worker/src/api/__tests__/report-cards.test.ts`
  - `npm test -- worker/src/cron/__tests__/yield-config-registry.test.ts`
  - `npm test -- worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`
  - `npm test -- src/app/stablecoin/[id]/client.test.tsx`
  - `npm test -- src/lib/__tests__/stablecoin-detail-view-model.test.ts`
  - `npm test -- src/components/stablecoin-detail/__tests__/hero-card.test.tsx`
  - `npm test -- src/components/__tests__/report-card.test.tsx`
  - `npm test -- src/components/__tests__/stablecoin-table-logic.test.ts`
  - `npm test -- src/hooks/__tests__/use-homepage-filters.test.ts`
  - `npm run lint`
  - `npm run typecheck`
  - `npm run serve:static-export` + `npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local` for the homepage overflow canary
  - `cd worker && npx tsc --noEmit`
  - `npm run build`
  - `npm run seo:check`
  - `npm run test:merge-gate`

## Phase 1 — Metadata foundation

### Task 1.1: Add narrow variant fields to shared types and schema

Files:

- `shared/types/core.ts`
- `shared/lib/stablecoins/schema.ts`

Changes:

- [ ] Add:

```ts
export const VARIANT_KIND_VALUES = [
  "savings-passthrough",
  "risk-absorption",
] as const;
export type VariantKind = typeof VARIANT_KIND_VALUES[number];
```

- [ ] Extend `StablecoinMeta`:

```ts
variantOf?: string;
variantKind?: VariantKind;
```

- [ ] Add schema fields and a local co-require refine:

```ts
variantOf: z.string().optional(),
variantKind: z.enum(VARIANT_KIND_VALUES).optional(),
```

```ts
.refine(
  (meta) => (meta.variantOf == null) === (meta.variantKind == null),
  {
    message: "variantOf and variantKind must both be set or both be absent",
    path: ["variantOf"],
  }
)
```

Notes:

- No pre-launch exception in v1.
- No extra schema rule for parent existence here; that belongs in post-load validation.

### Task 1.2: Add registry-level variant validation after full load

Files:

- `shared/lib/stablecoins/index.ts`
- optional new helper: `shared/lib/stablecoins/validate-variants.ts`
- `scripts/check-stablecoin-data.ts`

Changes:

- [ ] Add a post-load validation pass over `TRACKED_STABLECOINS` / `ACTIVE_IDS`.
- [ ] Call the same validation helper from `scripts/check-stablecoin-data.ts` so the repo's primary data gate sees the new rules.
- [ ] Enforce:
  - only active coins can declare variant fields
  - parent exists in `ACTIVE_IDS`
  - parent is not self
  - parent does not itself declare `variantOf`
  - parent is not a `navToken`
  - `pegReferenceId === variantOf`
  - `flags.navToken === true`

Suggested shape:

```ts
function validateVariantRelationships(tracked: StablecoinMeta[]): string[]
```

Runtime loader behavior:

- throw if `validateVariantRelationships()` returns any errors

Script behavior:

- print each error and fail `npm run check:stablecoin-data`

### Task 1.3: Add shared variant helpers

Files:

- new `shared/lib/stablecoins/variants.ts`
- `shared/lib/stablecoins/index.ts` re-export

Changes:

- [ ] Implement:
  - `getVariantParent`
  - `getVariants`
  - `getVariantRelationship`
  - `isTrackedVariant`
- [ ] Keep the module graph acyclic:
  - `variants.ts` must read from a lower-level registry data module or live inside the registry layer itself
  - `variants.ts` must not import `shared/lib/stablecoins/index.ts` if `index.ts` also re-exports it

### Task 1.4: Annotate the 9 in-scope assets only

Files:

- `shared/data/stablecoins/usd-major.json`
- `shared/data/stablecoins/usd-minor.json`

Changes:

- [ ] Add `variantOf` + `variantKind` to the 9 in-scope assets.
- [ ] Do **not** modify the 9 out-of-scope assets.
- [ ] Do **not** strip `pegReferenceId` anywhere in v1.

Exact assignments:

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

### Task 1.5: Add metadata tests

Files:

- `shared/lib/__tests__/stablecoins.test.ts`
- new `shared/lib/stablecoins/__tests__/variants.test.ts`

Changes:

- [ ] Assert exactly 9 active variants.
- [ ] Assert every variant parent exists and is active.
- [ ] Assert `pegReferenceId === variantOf` for each variant.
- [ ] Assert helper behavior for at least:
  - `susds-sky` -> `usds-sky`
  - `stusds-sky` siblings include `susds-sky`
  - `usds-sky` returns two children

- [ ] Run `npm run check:stablecoin-data` as the explicit Phase 1 checkpoint before starting report-card work.
- [ ] Run `npm test -- shared/lib/__tests__/stablecoins.test.ts` and `npm test -- shared/lib/stablecoins/__tests__/variants.test.ts` before starting Phase 2.

### Task 1.6: Remove base-side yield-wrapper duplication for tracked savings wrappers

Files:

- `shared/data/stablecoins/usd-major.json`
- `shared/data/stablecoins/usd-minor.json`
- `worker/src/cron/yield-config-variants.ts`
- `worker/src/cron/yield-config-pools.ts`
- `worker/src/cron/yield-config-rate-sources.ts`
- `worker/src/cron/yield-sync/tracked-optional-source-registry.ts`
- `worker/src/cron/yield-sync/history.ts`
- `worker/src/api/yield-history.ts`
- `worker/src/cron/__tests__/yield-config-registry.test.ts`

Changes:

- [ ] Remove or move every base-owned wrapper yield source for tracked savings wrappers so the wrapper APY is owned by the tracked child, not the base asset.
- [ ] Apply this to the base ids that currently point at tracked savings wrappers:
  - `usde-ethena` -> move wrapper yield ownership to `susde-ethena`
  - `usds-sky` -> move wrapper yield ownership to `susds-sky`
  - `dai-makerdao` -> move wrapper yield ownership to `sdai-sky`
  - `frxusd-frax` -> move wrapper yield ownership to `sfrxusd-frax`
  - `crvusd-curve` -> move wrapper yield ownership to `scrvusd-curve`
- [ ] Audit and clear the relevant parent-owned sources across:
  - `YIELD_VARIANT_MAP`
  - `YIELD_POOL_MAP`
  - on-chain wrapper readers
  - wrapper-specific optional tracked-source entries
  - parent-owned descriptive strategy metadata in `yield-config-rate-sources.ts`, including `DIRECT_PROTOCOL_API_STRATEGIES` and `QUARANTINED_DETERMINISTIC_ADAPTERS` where they describe the wrapper-owned path
- [ ] For those same five parent assets, remove wrapper-owned `yieldBearing` / `yieldConfig` metadata from the parent when the tracked child is the real yield surface.
- [ ] Add a one-time history cleanup for those same five parent ids so wrapper-owned APY already stored in `yield_history` no longer serves through the parent after the ownership handoff.
- [ ] Acceptable implementation:
  - purge the misattributed parent `yield_history` rows, and document the discontinuity in the Yield Intelligence changelog
  - do not leave old wrapper-owned parent history queryable through `/api/yield-history`
- [ ] Leave non-tracked wrapper mappings unchanged.
- [ ] Add a regression test that these five base ids no longer resolve wrapper-owned yield sources through the parent entry.
- [ ] Add a regression test for `/api/yield-history` or the history cleanup path so those parent ids no longer return the old wrapper-owned series after the cutoff.

Reason:

- the live duplicate path is parent-keyed, not child-keyed
- the repo already documents that tracked wrappers should not also be force-modeled through `YIELD_VARIANT_MAP`

## Phase 2 — Variant-aware report-card plumbing

### Task 2.1: Add a variant-aware dependency helper

Files:

- `shared/lib/stablecoins/variants.ts` or nearby shared helper

Changes:

- [ ] Add:

```ts
deriveVariantAwareDependencies(meta: Pick<StablecoinMeta, "variantOf" | "reserves" | "dependencies">): DependencyWeight[]
```

Behavior:

- start from `deriveDependencies(meta)`
- if `variantOf` is absent, return unchanged
- if `variantOf` is present:
  - remove any existing dependency entry pointing at `variantOf`
  - append exactly one synthetic dependency `{ id: variantOf, weight: 1, type: "wrapper" }`

This helper is the only dependency source used in variant-aware report-card paths.

### Task 2.2: Use variant-aware dependencies in topological order and raw inputs

Files:

- `worker/src/lib/report-cards-snapshot-card.ts`

Changes:

- [ ] Update `topologicalOrder()` to recurse through `deriveVariantAwareDependencies(meta)`.
- [ ] Update `computeReportCard()` so `rawInputs.dependencies` is variant-aware, not reserve-only.

This closes the parent-before-child ordering gap for wrappers whose reserve data is not the canonical parent relation.

### Task 2.3: Refactor dependency scoring to consume explicit dependencies

Files:

- `shared/lib/report-card-dependency.ts`
- callers in `worker/src/lib/report-cards-snapshot-card.ts`
- callers in `shared/lib/report-card-overall.ts`

Changes:

- [ ] Stop deriving dependencies internally inside `scoreDependencyRisk()`.
- [ ] Accept explicit dependency inputs plus optional `variantKind`.

Suggested direction:

```ts
scoreDependencyRisk(
  args: {
    governance: GovernanceType;
    dependencies: DependencyWeight[];
    variantParentId?: string | null;
    variantKind?: VariantKind | null;
  },
  overallScores: Map<string, number>,
)
```

- [ ] Apply a wrapper ceiling penalty map:
  - `savings-passthrough` -> `3`
  - `risk-absorption` -> `5`
- [ ] Preserve the legacy `wrapper -> upstream - 3` ceiling for non-variant wrapper dependencies so out-of-scope wrapper assets do not regress.

Reason:

- live compute and stressed compute need the same dependency list
- stress mode should not reconstruct dependency meaning from reserves

### Task 2.4: Persist variant metadata into report-card payloads

Files:

- `shared/types/report-cards.ts`
- `shared/lib/report-card-raw-inputs.ts`
- `worker/src/lib/report-cards-snapshot-card.ts`
- `worker/src/lib/report-cards-snapshot-finalize.ts`
- `worker/src/api/__tests__/report-cards.test.ts`

Changes:

- [ ] Add to `RawDimensionInputs`:

```ts
variantParentId: z.string().nullable().optional().default(null)
variantKind: z.enum(VARIANT_KIND_VALUES).nullable().optional().default(null)
```

- [ ] Add top-level `overallCapped?: boolean` to `ReportCard`.
- [ ] Add top-level `uncappedOverallScore?: number | null` to `ReportCard`.
- [ ] Update raw-input defaults and the defunct-card path so the new fields are always present/initialized.

These fields exist for:

- stressed recomputation
- report-card UI transparency
- API contract clarity for internal consumers

### Task 2.5: Add parent overall cap in live and stressed paths

Files:

- `shared/lib/report-card-overall.ts`
- `worker/src/lib/report-cards-snapshot-card.ts`

Changes:

- [ ] Do **not** widen `computeOverallGrade()` with variant-specific options.
- [ ] Instead add a small helper that caps an already-computed overall score/grade against the parent's overall score.

Suggested direction:

```ts
applyVariantOverallCap(
  overall: { grade: ReportCardGrade; score: number | null; baseScore: number | null; ratedDimensions: number },
  parentScore: number | null,
): { ...overall, overallCapped: boolean; uncappedOverallScore: number | null }
```

- [ ] Use it in live report-card computation.
- [ ] Use it again in `computeStressedGrades()`.
- [ ] When `parentScore == null`, skip the cap and keep the child's computed score.
- [ ] Preserve `baseScore` semantics by using `uncappedOverallScore` for any parent-cap explanation in the UI/API.
- [ ] Explicitly apply the cap to directly overridden variant cards in the stress-path override branch before downstream recomputation begins.

### Task 2.6: Align inherited severe-depeg handling across report cards and redemption

Files:

- `worker/src/lib/report-cards-snapshot-card.ts`
- `worker/src/cron/sync-redemption-backstops.ts`
- `worker/src/lib/redemption-backstop-availability.ts`
- `worker/src/lib/redemption-backstop-sources.ts`

Changes:

- [ ] When peg input is inherited from `pegReferenceId`, resolve `activeDepegPeakBpsById` against the inherited id, not `meta.id`.
- [ ] Extend redemption-route impairment for the 9 in-scope variants so parent severe depegs can impair the wrapper redemption path when `pegReferenceId === variantOf`.
- [ ] Apply that inherited impairment only where the wrapper already has a redemption-backstop config in this repo; adding new backstop configs is not part of v1.

This keeps report-card caps and redemption-route availability aligned for tracked parent variants.

### Task 2.7: Make the dependency graph variant-aware

Files:

- `shared/lib/dependency-graph.ts`
- any callers consuming graph edges from report-card snapshot

Changes:

- [ ] Build edges from `deriveVariantAwareDependencies(meta)`.

This keeps the graph consistent with scoring and stress-mode traversal.

Note:

- this is a passive shared-data change that will affect dependency-map / contagion / coverage outputs
- no bespoke UI redesign is planned, but the data-path change itself is in scope

### Task 2.8: Advance Telegram safety snapshots from the live report-card cache

Files:

- `worker/src/cron/publish-report-card-cache.ts`
- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/cron/telegram-alert-snapshots.ts`
- optional new helper: `worker/src/lib/alert-safety-source-cache.ts`

Changes:

- [ ] Keep `safety_grade_history` unchanged: seed row + real grade changes only.
- [ ] Add a private alert-only safety source cache written on the same cadence as live report-card publication.
- [ ] Store every live card in that private cache, including `grade`, `score | null`, and `methodologyVersion`.
- [ ] Have `dispatch-telegram-alerts` derive safety changes from the previous `alert:safety-snapshot` and the new alert-only safety source cache, not from `safety_grade_history`.
- [ ] Keep methodology-change safety alerts suppressed on that single shared alert clock.
- [ ] Make `publish-report-card-cache` the only writer of the alert-only safety source cache.
- [ ] Replace the old first-seen suppression rule with explicit seed semantics for the alert-only diff path:
  - ids missing from the prior alert snapshot are treated as seed-only / no-alert cases unless a later diff occurs

Goal:

- no fake public history rows
- no alert/snapshot clock drift between quarter-hourly report-card publication and daily public history snapshots
- rollout suppression still happens once at the alert layer, not in the public history contract

### Task 2.9: Scoring and stress tests

Files:

- `shared/lib/__tests__/dependency-graph.test.ts`
- `shared/lib/__tests__/report-cards.test.ts`
- `worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts`
- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`
- `worker/src/api/__tests__/report-cards.test.ts`
- `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`
- `src/lib/__tests__/contagion-layout.test.ts`
- `src/lib/__tests__/coverage.test.ts`

Add tests for:

- [ ] `variantOf`-only parent ordering in topo traversal
- [ ] variant-aware dependency edge appears exactly once
- [ ] dependency graph emits the synthetic wrapper edge exactly once
- [ ] savings wrapper dependency ceiling
- [ ] risk-absorption dependency ceiling
- [ ] non-variant wrapper dependencies still keep the legacy wrapper ceiling
- [ ] live overall cap against parent
- [ ] stressed overall cap against parent
- [ ] directly overridden variant cards in stress mode still respect the parent cap
- [ ] unrated parent skips the cap
- [ ] inherited `activeDepegBps` cascade through `pegReferenceId`
- [ ] redemption-route impairment inherits the parent's severe depeg for in-scope variants
- [ ] suppressed methodology-change safety alerts still advance the cached safety snapshot to the new methodology version
- [ ] `NR` assets remain represented in the Telegram safety snapshot after the methodology rollover path
- [ ] API response shape accepts `variantParentId`, `variantKind`, and `overallCapped`
- [ ] passive dependency-graph consumers still produce stable layouts and coverage totals with the new synthetic wrapper edge
- [ ] Run `npm run typecheck` and `cd worker && npx tsc --noEmit` as the explicit Phase 2 checkpoint.

## Phase 3 — Core UI surfaces

### Task 3.1: Add shared variant display metadata

Files:

- new `src/lib/variant-display.ts`

Changes:

- [ ] Define label + tone mapping for:
  - `savings-passthrough` -> `Savings`
  - `risk-absorption` -> `Risk-Abs`

Use existing design language and static class strings.

### Task 3.2: Extend the stablecoin detail view model

Files:

- `src/lib/stablecoin-detail-view-model.ts`

Changes:

- [ ] Expose:
  - `variantParent`
  - `variantSiblings`
  - `childVariants`
  - `isVariant`
  - `hasVariants`

Source them from the new shared variant helpers.

### Task 3.3: Add variant detail-page treatment

Files:

- `src/components/stablecoin-detail/hero-card.tsx`
- `src/app/stablecoin/[id]/client.tsx`
- `src/components/stablecoin-detail/overview-section.tsx`
- optional new component:
  - `src/components/stablecoin-detail/underlying-asset-card.tsx`

Changes:

- [ ] Add a hero chip linking to the parent.
- [ ] Add an underlying-asset card above the current overview/notices block.
- [ ] Collapse duplicate `#overview` ownership so the outer detail-page section is the only `id="overview"` anchor.
- [ ] Place the new card inside that outer `#overview` section; do not introduce a new scrollspy section id in v1.
- [ ] Keep the layout inside the existing detail page, no new route family.

### Task 3.4: Add parent detail-page variants card

Files:

- `src/app/stablecoin/[id]/client.tsx`
- `src/components/stablecoin-detail/overview-section.tsx`
- `src/components/stablecoin-detail/collateral-usage-section.tsx`
- optional new component:
  - `src/components/stablecoin-detail/parent-variants-card.tsx`

Changes:

- [ ] Render a dedicated variants card when `childVariants.length > 0`.
- [ ] Place it inside the outer `#overview` section so jump navigation remains correct.
- [ ] Exclude tracked variants from the collateral-usage path so the parent page does not surface the same child twice.
- [ ] Do not overload `CollateralUsageSection`.

### Task 3.5: Add overall-cap UI note in the report-card summary

Files:

- `src/components/report-card.tsx`
- `src/components/__tests__/report-card.test.tsx`

Changes:

- [ ] When `card.overallCapped === true` and `rawInputs.variantParentId` is present, show a short note such as:
  - `Overall capped at parent stablecoin`
- [ ] Use `uncappedOverallScore` to show the parent-cap delta separately.
- [ ] Suppress the existing `Peg: -X` explanation when a parent cap fired so peg drag and parent-cap drag are not conflated.

Keep this as a small summary chip/note, not a per-dimension inheritance system.

### Task 3.6: Add homepage table badge and variant accessibility context

Files:

- `src/components/stablecoin-table-row.tsx`
- `src/components/stablecoin-table-logic.ts`
- `src/components/stablecoin-table.tsx`
- `src/components/__tests__/stablecoin-table.test.tsx`
- `src/components/__tests__/stablecoin-table-logic.test.ts`

Changes:

- [ ] Add the variant badge in the symbol cell.
- [ ] Widen the row props so the component can distinguish `list`, `compact`, `comfortable`, and `spacious`, not just `list` vs non-`list`.
- [ ] Keep row heights unchanged in v1.
- [ ] Keep compact visible badge text such as `Risk-Abs`, but use full accessibility wording such as `Risk absorption variant`.
- [ ] Ensure both the focusable row and the inner detail link expose that full variant context when present.
- [ ] Ensure child interactions swallow both pointer and keyboard activation if a nested interactive element is added later.

### Task 3.7: Add homepage variant filters

Files:

- `shared/types/core.ts`
- `shared/types/__tests__/core.test.ts`
- `src/hooks/use-homepage-filters.ts`
- `src/components/filter-bar.tsx`
- `src/components/homepage-client.tsx`
- `scripts/smoke-ui.mjs`
- `src/hooks/__tests__/use-homepage-filters.test.ts`

Changes:

- [ ] Add filter tags:
  - `variant-tracked`
  - `variant-savings-passthrough`
  - `variant-risk-absorption`

- [ ] Emit them from `getFilterTags()` only for the 9 tracked variants in scope.
- [ ] Add a `Variant` filter group to `FILTER_GROUPS`.
- [ ] Use visible wording `All variants`, `Savings`, and `Risk-Abs`, but keep full accessibility wording such as `Risk absorption variant`.
- [ ] Update the filter-bar layout from five groups to six groups.
- [ ] Update the homepage toolbar helper copy so it no longer says only `peg, backing, governance, grade`.
- [ ] Keep the homepage active-filter chips and remove buttons using the same full accessibility wording, not the compact `Risk-Abs` label.
- [ ] Extend the local smoke canary so the homepage overflow check opens the filter panel before measuring layout.
- [ ] Add a desktop-expanded filter-panel overflow check in that canary so the `lg` six-group grid is exercised, not only the mobile viewport.

### Task 3.8: UI tests

Files:

- `src/app/stablecoin/[id]/client.test.tsx` (new)
- `src/components/homepage-client.tsx`
- `src/components/homepage-client.test.tsx` (new)
- `src/lib/__tests__/stablecoin-detail-view-model.test.ts`
- `src/components/stablecoin-detail/__tests__/hero-card.test.tsx`
- `src/components/__tests__/report-card.test.tsx`
- `src/components/__tests__/stablecoin-table.test.tsx`
- `src/components/__tests__/stablecoin-table-logic.test.ts`
- `src/hooks/__tests__/use-homepage-filters.test.ts`

Add tests for:

- [ ] variant parent appears in the detail view model
- [ ] parent detail composition renders the `Variants` card inside the resolved `#overview` section
- [ ] parent detail pages expose child variants
- [ ] parent pages do not surface tracked variants again inside `CollateralUsageSection`
- [ ] HeroCard renders the `Variant of [parent]` chip as a link
- [ ] report-card summary renders the overall-cap note
- [ ] report-card summary separates parent-cap drag from peg drag when `overallCapped === true`
- [ ] variant detail composition renders exactly one `#overview` anchor and places the underlying-asset card inside it
- [ ] table row and inner detail link both include variant context
- [ ] nested controls and inner links swallow `Enter` / `Space` without triggering row navigation
- [ ] table logic emits variant labels/filter behavior
- [ ] shared filter-tag tests confirm only the 9 in-scope assets emit `variant-*` tags
- [ ] filter parsing handles the new `variant-*` values
- [ ] `compact` and one of `comfortable` / `spacious` are exercised in UI tests so the widened density behavior is covered
- [ ] homepage filter panel renders the sixth group when opened
- [ ] homepage active-filter chips and remove controls expose full accessibility wording for the variant labels
- [ ] Run `npm run lint` as the explicit Phase 3 checkpoint.

## Phase 4 — Methodology and process docs

### Task 4.1: Bump Safety Score methodology to v7.09

Files:

- `shared/lib/safety-score-version-data.ts`
- `docs/architecture.md`
- `docs/worker-and-api-limits.md`
- `docs/report-cards.md`
- `docs/report-cards-timeline.md`
- `docs/api-reference.md`
- `docs/classification.md`
- `docs/homepage.md`
- `docs/stablecoin-detail-page.md`
- `docs/dependency-map.md`
- `docs/coverage-page.md`
- `docs/redemption-backstops.md`
- `docs/yield-intelligence.md`
- `docs/yield-intelligence-timeline.md`
- `docs/telegram-alerts.md`
- `docs/stablecoin-data.md`
- `src/app/methodology/sections/core/safety-scores-section.tsx`
- methodology scoring-changelog content files

Changes:

- [ ] Bump `currentVersion` to `7.09`.
- [ ] Document:
  - true parent-variant scope
  - dependency-risk wrapper ceiling by variant kind
  - parent overall cap
  - inherited parent active-depeg cap propagation
  - legacy wrapper-ceiling fallback for out-of-scope wrapper assets
  - explicit non-goals for strategy vaults / bond products

### Task 4.2: Bump Yield and Redemption methodology versions

Files:

- `shared/lib/yield-methodology-version.ts`
- `shared/lib/redemption-backstop-version.ts`
- `docs/yield-intelligence.md`
- `docs/yield-intelligence-timeline.md`
- `docs/redemption-backstops.md`
- `docs/api-reference.md`

Changes:

- [ ] Bump Yield Intelligence for the parent->child yield-source ownership change.
- [ ] Bump Redemption Backstops for inherited severe-parent-depeg impairment on tracked wrappers.
- [ ] Update the canonical version modules and the public docs that surface those version labels.
- [ ] Document the intentional yield-history discontinuity for the affected parent ids after wrapper-yield ownership moves to the tracked child.

Suggested targets:

- Yield Intelligence `v7.42 -> v7.43`
- Redemption Backstops `v3.991 -> v3.992`

### Task 4.3: Update process guidance

Files:

- `agents/process/adding-a-stablecoin.md`

Changes:

- [ ] Add `variantOf` / `variantKind` guidance for true wrapped/staked children only.
- [ ] Explicitly distinguish canonical tracked-parent `variantOf` authoring from ordinary `dependencies[]` / reserve-slice wrapper modeling.
- [ ] State that v1 variants must keep `pegReferenceId === variantOf`.
- [ ] State that v1 variant metadata is active-only.
- [ ] State that the parent may not itself be a variant or a `navToken`.
- [ ] State that every v1 variant keeps `flags.navToken === true`.
- [ ] State that anchor-asset vaults do not use `variantOf` in this phase.
- [ ] Add the new parent-yield ownership cleanup rule:
  - when a tracked savings wrapper becomes the canonical yield surface, remove wrapper-owned yield metadata and history ownership from the parent rather than leaving the parent `yieldBearing`
- [ ] Preserve the existing warning:
  - tracked wrappers should not also be forced through `YIELD_VARIANT_MAP`

## Final verification

Run, in this order:

1. `npm run check:stablecoin-data`
2. `npm test -- shared/lib/__tests__/stablecoins.test.ts`
3. `npm test -- shared/lib/stablecoins/__tests__/variants.test.ts`
4. `npm test -- shared/lib/__tests__/dependency-graph.test.ts`
5. `npm test -- shared/lib/__tests__/report-cards.test.ts`
6. `npm test -- worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts`
7. `npm test -- worker/src/lib/__tests__/report-cards-snapshot.test.ts`
8. `npm test -- worker/src/api/__tests__/report-cards.test.ts`
9. `npm test -- worker/src/cron/__tests__/yield-config-registry.test.ts`
10. `npm test -- worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`
11. `npm test -- src/lib/__tests__/contagion-layout.test.ts`
12. `npm test -- src/lib/__tests__/coverage.test.ts`
13. `npm test -- src/app/stablecoin/[id]/client.test.tsx`
14. `npm test -- src/lib/__tests__/stablecoin-detail-view-model.test.ts`
15. `npm test -- src/components/homepage-client.test.tsx`
16. `npm test -- src/components/stablecoin-detail/__tests__/hero-card.test.tsx`
17. `npm test -- src/components/__tests__/report-card.test.tsx`
18. `npm test -- src/components/__tests__/stablecoin-table.test.tsx`
19. `npm test -- src/components/__tests__/stablecoin-table-logic.test.ts`
20. `npm test -- shared/types/__tests__/core.test.ts`
21. `npm test -- src/hooks/__tests__/use-homepage-filters.test.ts`
22. `npm run lint`
23. `npm run typecheck`
24. `cd worker && npx tsc --noEmit`
25. `npm run build`
26. `npm run seo:check`
27. Start a local static-export server with `npm run serve:static-export`, then run `SMOKE_UI_OVERFLOW_ROUTES='/,/stablecoin/susds-sky/,/stablecoin/usds-sky/' npm run test:smoke-ui -- --url http://127.0.0.1:4173 --mode local` after extending the smoke canary to open the homepage filter panel before measuring overflow
28. Refresh markdown fixtures if methodology, changelog, or stablecoin-detail markdown output changed, then rerun the affected tests
29. `npm run test:merge-gate`

Note:

- Step 25 is primarily a homepage/detail layout and overflow canary unless you also point the static-export server at a non-production API/site-data target via the normal env overrides.

## Review gate

This plan is considered review-passable only if a review round reports:

- no blocker or high-severity issues
- fewer than 3 minor issues total

If a review round returns more than that, revise the plan and rerun specialized review before implementation starts.
