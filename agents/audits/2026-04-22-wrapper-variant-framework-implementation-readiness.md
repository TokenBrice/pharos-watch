# Wrapper Variant Framework Implementation Readiness Audit

Date: 2026-04-22
Reviewer: Codex synthesis of 6 GPT-5.4 xhigh reviewer subagents
Scope:
- `agents/specs/2026-04-22-wrapper-variant-framework-design.md`
- `agents/plans/2026-04-22-wrapper-variant-framework-plan.md`
- Referenced repo code and docs in `src/`, `shared/`, `worker/`, and `docs/`

## Verdict

Not ready for implementation as written.

The design direction is viable, but the current spec/plan has multiple repo-level blockers where the proposed behavior is not actually representable in the live architecture, or where the rollout/verification story relies on surfaces that do not exist.

## Findings

### 1. `variantOf` is overloaded again for fiat-anchor vaults

The spec says `variantOf` is the canonical parent pointer and exists to stop overloading `pegReferenceId`, but the plan still uses `variantOf: usdc-circle/usdt-tether` for `yusd-yieldfi` and `syrupusdc/t-maple` even though those are strategy vaults over anchor assets, not product variants of Circle/Tether.

Why this matters:
- `variantOf` drives taxonomy pages, parent cards, inheritance, and the overall cap.
- That means the UI and scoring will assert a product relationship that the underlying metadata does not actually describe.

Key evidence:
- [design.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/specs/2026-04-22-wrapper-variant-framework-design.md:60)
- [design.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/specs/2026-04-22-wrapper-variant-framework-design.md:531)
- [plan.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-22-wrapper-variant-framework-plan.md:245)
- [shared/data/stablecoins/usd-minor.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json:9686)
- [shared/data/stablecoins/usd-minor.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json:9946)

### 2. Dependency-risk ceilings do not work for `variantOf`-only wrappers

The scoring plan depends on parent-first ordering plus archetype-specific wrapper ceilings, but the current dependency scorer only looks at `deriveDependencies(meta)` and only ceilings resolved deps typed as `wrapper` or `mechanism`.

That means strategy-vault wrappers that point to a parent only via `variantOf` will not inherit a dependency ceiling at all unless the dependency model is expanded beyond reserve-derived edges.

Key evidence:
- [shared/lib/report-card-dependency.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-card-dependency.ts:24)
- [shared/lib/report-card-dependency.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-card-dependency.ts:100)
- [worker/src/lib/report-cards-snapshot-card.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/report-cards-snapshot-card.ts:121)
- [worker/src/lib/report-cards-snapshot-card.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/report-cards-snapshot-card.ts:131)
- [plan.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-22-wrapper-variant-framework-plan.md:150)

### 3. Stress-mode recomputation cannot apply the variant framework

The plan requires the hard parent cap and variant dependency logic to hold inside `computeStressedGrades()`, but the current stressed path only persists ordinary dependencies and reconstructs a reduced meta without `variantOf`/`variantKind`.

As written, stress mode cannot:
- discover `variantOf`-only children
- reapply archetype-specific wrapper ceilings
- cap a wrapper against the parent's stressed score

Key evidence:
- [shared/lib/report-card-overall.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-card-overall.ts:65)
- [shared/lib/report-card-overall.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-card-overall.ts:143)
- [shared/types/report-cards.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/report-cards.ts:72)
- [shared/types/report-cards.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/report-cards.ts:111)
- [shared/lib/dependency-graph.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/dependency-graph.ts:11)

### 4. Independent-peg variants cannot score through the current nav-token pipeline

The spec expects `strategy-vault` and `bond-maturity` wrappers to compute peg from their own price data after `pegReferenceId` is stripped. The worker currently excludes all `navToken` assets from peg analytics.

So the planned direct-peg path does not exist for the very variants that need it unless peg analytics and API handling change first.

Key evidence:
- [worker/src/lib/report-cards-snapshot.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/report-cards-snapshot.ts:76)
- [worker/src/lib/peg-analytics.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/peg-analytics.ts:63)
- [worker/src/api/peg-summary.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/peg-summary.ts:173)
- [shared/data/stablecoins/usd-major.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-major.json:3086)
- [shared/data/stablecoins/usd-major.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-major.json:3649)
- [shared/data/stablecoins/usd-minor.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json:7420)
- [shared/data/stablecoins/usd-minor.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json:9934)

### 5. Reserve-shape migration is not authoritative because live reserves win

The plan treats JSON `reserves` edits as the primary migration surface, but resilience scoring and the reserve API prefer live reserve output when `liveReservesConfig` exists.

So changing authored `reserves` alone is insufficient for:
- strategy-vault resilience floors
- reserve API output
- wrapper depType cleanup where live adapters still emit the old shape

Key evidence:
- [shared/lib/report-card-resilience.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-card-resilience.ts:199)
- [worker/src/api/stablecoin-reserves.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/stablecoin-reserves.ts:24)
- [shared/data/stablecoins/usd-major.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-major.json:2834)
- [worker/src/cron/reserve-adapters/usdai-proof-of-reserves.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/usdai-proof-of-reserves.ts:241)
- [shared/data/stablecoins/usd-major.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-major.json:1167)

### 6. The planned variants taxonomy route does not fit the current taxonomy stack

The plan assumes `/stablecoins/variants/[parent]/` can reuse the existing taxonomy page model with one new `FilterTag`, but the live taxonomy stack is global-tag driven and only passes one filter tag into the filtered table.

That architecture cannot express “all variants of this specific parent” without either:
- a parent-scoped dataset/selector, or
- a new page implementation separate from the global taxonomy filter flow

Key evidence:
- [src/components/stablecoin-taxonomy-page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/stablecoin-taxonomy-page.tsx:11)
- [src/components/stablecoin-filtered-table.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/stablecoin-filtered-table.tsx:20)
- [src/components/stablecoin-table-logic.ts](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/stablecoin-table-logic.ts:67)
- [shared/types/core.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/core.ts:435)

### 7. The verification plan does not match the repo's actual test/browser surface

The plan relies on a broad “Playwright” verification lane that does not exist in the repo as a focused UI assertion suite. The actual browser lane is `npm run test:smoke-ui`, and it does not cover most of the surfaces the spec lists.

The plan also cites several targeted test files and commands that do not exist or do not match the repo's current test layout.

Key evidence:
- [package.json](/home/ahirice/Documents/git/stablecoin-dashboard/package.json:30)
- [package.json](/home/ahirice/Documents/git/stablecoin-dashboard/package.json:36)
- [scripts/smoke-ui.mjs](/home/ahirice/Documents/git/stablecoin-dashboard/scripts/smoke-ui.mjs:24)
- [docs/testing.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md:533)
- [shared/lib/__tests__/report-cards.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/__tests__/report-cards.test.ts:219)

### 8. `YIELD_VARIANT_MAP` reconciliation is overbroad

The proposed cleanup keys off parent ids, but some existing yield-variant mappings under those parents are not duplicates of the newly tracked wrappers.

That means the current rule can remove legitimate yield sources that the framework did not intend to touch.

Key evidence:
- [plan.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-22-wrapper-variant-framework-plan.md:276)
- [shared/data/stablecoins/usd-minor.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json:3964)
- [shared/data/stablecoins/usd-minor.json](/home/ahirice/Documents/git/stablecoin-dashboard/shared/data/stablecoins/usd-minor.json:4049)
- [worker/src/cron/yield-config-variants.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config-variants.ts:29)
- [worker/src/cron/yield-config-variants.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config-variants.ts:60)

### 9. Rollout/alert assumptions are stale

The spec/plan expect a post-deploy Telegram alert spike from grade changes and propose a mute window. The live runtime suppresses safety alerts across methodology-version changes, and snapshot history only writes when the grade itself changes.

So the current operational issue is not “mute the spike”; it is “version-transition rows may be missing or later grade changes may be suppressed once.”

Key evidence:
- [worker/src/cron/snapshot-safety-grade-history.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/snapshot-safety-grade-history.ts:69)
- [worker/src/cron/dispatch-telegram-alerts.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dispatch-telegram-alerts.ts:482)

### 10. The spec/plan still have documentation and authoring-rule drift

Examples:
- `variantOf`/`variantKind` are described as co-required, then immediately allowed to appear partially on pre-launch entries.
- The plan targets `docs/report-cards-input-reference.md`, which does not exist.
- `yUSD` is treated like a fiat-anchor special case but is missing from the explicit operator sign-off set.

Key evidence:
- [design.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/specs/2026-04-22-wrapper-variant-framework-design.md:60)
- [plan.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-22-wrapper-variant-framework-plan.md:90)
- [plan.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-22-wrapper-variant-framework-plan.md:1444)
- [plan.md](/home/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-22-wrapper-variant-framework-plan.md:48)

## Minimum Revisions Before Implementation

1. Decide whether `variantOf` means true product parent only.
If yes, introduce a separate field for deposit/anchor asset relationships or drop the fiat-anchor vaults from the first rollout.

2. Make variant relationships first-class in dependency/stress plumbing.
That means `variantOf` must be represented in dependency risk, stress recomputation, and any exported dependency graph used by the UI.

3. Split or refine `navToken` semantics before stripping `pegReferenceId`.
Independent-peg wrappers cannot score until peg analytics and API handling stop blanket-skipping them.

4. Treat live reserve adapters/config as part of the migration, not just authored JSON.
Otherwise resilience scoring and reserve API output will not match the new taxonomy.

5. Redesign `/stablecoins/variants/*` around parent-scoped data, not a global `FilterTag` reuse.

6. Rewrite the verification plan around actual repo seams.
Use the existing unit/integration test surface plus `test:smoke-ui`, and add explicit topo/stress cases for `variantOf`-only wrappers.

7. Narrow the `YIELD_VARIANT_MAP` cleanup rule to true duplicates only.

8. Correct the rollout/docs plan.
Handle methodology-version transitions explicitly, fix the documentation targets, and include `yUSD` in the sign-off set if it remains a special-case classification.
