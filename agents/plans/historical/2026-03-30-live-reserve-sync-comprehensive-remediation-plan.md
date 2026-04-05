# 2026-03-30 Live Reserve Sync Comprehensive Remediation Plan

> Execution plan for [2026-03-30-live-reserve-sync-audit.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-03-30-live-reserve-sync-audit.md).
> Scope covers every issue called out in that audit: evidence-depth overstatement, weak `single-asset` semantics, `tether` overconfidence, unknown-exposure inconsistency, `accountable` flattening risk, HTML-parser brittleness, helper/math inconsistency, numeric precision, mapping sprawl, hotspot maintainability, the `infinifi` metadata bug, and the low/mid-effort coverage-quality wins.

## Objective

Execute the remediation in a sequence that:

- improves reserve-data truthfulness before adding more coverage
- separates “live-enabled” from “independent evidence” operationally and in product semantics
- standardizes unknown exposure, freshness, and slice math across adapters
- reduces adapter-local duplication before the next coverage expansion
- keeps rollout safety high and methodology changes explicit

## Constraints And Guardrails

- No destructive migrations. Standard deploy applies D1 migrations before the new worker is live.
- Preserve public endpoint shapes unless the change is explicitly intended and documented.
- Any change that affects collateral passthrough, evidence eligibility, or reserve-side scoring semantics must update:
  - `docs/live-reserves.md`
  - `docs/report-cards.md`
  - `docs/report-cards-timeline.md`
  - `src/app/methodology/sections/core/safety-scores-section.tsx`
  - `src/app/methodology/scoring-changelog/*`
- If a new external reserve source is introduced during remediation, update the About page and matching docs per repo rules.
- Do not bundle optional coverage expansion into the same PRs as core accuracy fixes.
- Before pushing any implementation branch, run `npm run test:merge-gate`.

## Success Criteria

1. The system no longer overstates evidence depth. Operators and docs can distinguish:
   - `independent`
   - `static-validated`
   - `weak-live-probe`
2. `single-asset` stops implying stronger proof than it actually has, and weak single-asset names gain richer telemetry or are promoted into stronger adapter families.
3. `tether` no longer presents USDT as a single `100%` `very-low` bucket unless a richer source definitively proves that shape.
4. Unknown/unmapped exposure is handled through one repo-wide policy:
   - quantify and surface it when possible
   - degrade when material
   - fail closed only when it cannot be quantified honestly
5. Every `independent` adapter is forced into one of three freshness states:
   - timestamp-verified
   - intrinsically current latest-state (`not-applicable`)
   - downgraded from independent evidence
6. HTML adapters have fixture-backed parser coverage with explicit drift-failure tests.
7. Shared adapter math/fetch/classification infrastructure is consolidated enough that the next adapter batch does not add more local taxonomy sprawl.
8. All reserve-specific tests, lint, worker typecheck, and build remain green.

## Findings Coverage Matrix

| Audit issue | Plan coverage |
| --- | --- |
| `A1` Breadth materially exceeds evidence depth | `WS0`, `WS5`, `WS6` |
| `A2` `single-asset` is the largest structural accuracy weakness | `WS2` |
| `A3` `tether` is too coarse and overconfident | `WS3` |
| `A4` Unknown-exposure handling is inconsistent | `WS1`, `WS3`, `WS4` |
| `A5` `accountable` can hide schema drift and over-aggregate nested exposure | `WS3` |
| `A6` HTML adapters are the main reliability hotspot | `WS4` |
| `A7` `slicesFromValues()` is inconsistent with the normalized path | `WS1` |
| `A8` early `bigint -> number` conversion loses precision | `WS1`, `WS3` |
| `A9` manual symbol/farm maps are the main long-term maintenance burden | `WS1`, `WS3` |
| `A10` helper layer and `gho` are hotspot risks | `WS1`, `WS3`, `WS7` |
| `A11` `infinifi` metadata bug | `WS3` |
| `A12` low/mid-effort coverage-quality wins | `WS6` |

## Program Shape

Recommended merge train:

```text
PR-00 Contract lock, issue traceability, and characterization fixtures
PR-01 Shared slice/freshness/unknown-exposure contract
PR-02 Weak-live-probe family hardening (`single-asset`, `erc4626-single-asset`)
PR-03 High-impact adapter accuracy fixes (`tether`, `accountable`, `fx`, `usdd`, `infinifi`)
PR-04 Freshness review and evidence-tier normalization across all independent adapters
PR-05 HTML adapter fixtureization and parser hardening
PR-06 Mapping DSL / classification consolidation
PR-07 Hotspot cleanup (`helpers`, `gho`) and final docs/status surface updates
PR-08 Coverage-quality graduation batch and optional breadth additions
```

Parallelism guidance:

- `PR-01` must land before adapter-family work.
- `PR-02` and `PR-03` should stay separate; both touch shared semantics.
- `PR-05` can run in parallel with `PR-06` after `PR-01` lands.
- `PR-08` is explicitly last and optional per candidate; it must not block the core remediation.

## Required Validation Baseline

Run on every implementation branch unless the changed surface clearly allows a smaller targeted subset:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

Reserve-specific focused gates:

```bash
npm test -- --run \
  worker/src/cron/reserve-adapters/__tests__ \
  worker/src/cron/__tests__/sync-live-reserves.test.ts \
  worker/src/cron/__tests__/reserve-adapter-validate.test.ts \
  worker/src/lib/__tests__/live-reserves-store.test.ts \
  worker/src/api/__tests__/stablecoin-reserves.test.ts
```

Add these when shared/refactor work is touched:

```bash
npm run check:unused-code
npm run check:shared-cycles
npm run check:hotspot-ratchet
npm run check:doc-sync
```

## WS0 - Contract Lock And Characterization Baseline

### Goal

Freeze the semantic decisions that the rest of the remediation depends on and add characterization tests/fixtures before behavior changes.

### Tasks

1. Lock the evidence contract in code comments/docs:
   - `independent` means independently measured or directly provable
   - `static-validated` means curated/static composition with a live validation probe
   - `weak-live-probe` means the adapter proves liveness/structure more than reserve truth
2. Add a dedicated issue traceability note to the implementation PR series so every audit issue is closed explicitly.
3. Capture real upstream fixture payloads for all current HTML adapters:
   - `circle-transparency`
   - `fdusd-transparency`
   - `mento`
   - `re-metrics`
   - `sgforge-coinvertible`
4. Add characterization tests for the current `single-asset`, `tether`, `accountable`, and `fx` behaviors before changing them.

### Acceptance Criteria

- All core semantics decisions are written once and referenced from the later PRs.
- Fixture-backed parser tests exist before parser refactors begin.
- The series has a clear closure checklist per audit issue.

## WS1 - Shared Contract Hardening

### Goal

Fix the shared infrastructure first so the adapter work uses one consistent model for slices, freshness, unknown exposure, and valuation.

### Primary files

- `worker/src/cron/reserve-adapters/helpers.ts`
- `worker/src/cron/reserve-adapters/validate.ts`
- `shared/lib/live-reserve-adapters.ts`
- `shared/types/live-reserves.ts`

### Tasks

1. Unify `slicesFromValues()` with `normalizeSlices()`.
   - one dedupe path
   - one rounding path
   - one sort order
   - one metadata-preserving merge key
2. Add a shared decimal-safe valuation helper so adapters can keep `bigint` or decimal-string precision longer.
3. Introduce one shared unknown-exposure contract:
   - `unknownExposurePct`
   - optional explicit unknown slice
   - threshold-driven warning effect
   - fail-closed path when value cannot be honestly quantified
4. Add a small classification DSL for bucketed adapters:
   - matcher
   - bucket key
   - bucket label/risk/coinId/depType/blacklistable
   - unknown policy
5. Split `helpers.ts` into stable submodules only after the semantics in steps 1-4 land.
   Suggested split:
   - `slice-math.ts`
   - `freshness.ts`
   - `http-fetch.ts`
   - `onchain-fetch.ts`
   - `classification.ts`
6. Add validation that every `independent` adapter definition declares one admissible freshness mode:
   - verified timestamp path
   - `not-applicable` latest-state proof
   - explicit downgrade out of `independent`

### Acceptance Criteria

- No adapter has to choose its own slice-normalization semantics.
- Unknown-exposure handling is consistent across adapters.
- Shared helper modules are smaller and easier to test in isolation.

## WS2 - Weak-Live-Probe Family Hardening

### Goal

Fix the largest structural truthfulness issue in the system: the `single-asset` family.

### Primary files

- `worker/src/cron/reserve-adapters/single-asset.ts`
- `worker/src/cron/reserve-adapters/erc4626-single-asset.ts`
- `shared/lib/live-reserve-adapters.ts`
- `shared/types/live-reserves.ts`
- `src/components/stablecoin-detail/overview-section.tsx`
- `docs/live-reserves.md`

### Tasks

1. Expand `single-asset` params to support richer proofs, not just liveness:
   - optional reserve amount probe
   - optional supply amount probe
   - optional timestamp path/probe
   - optional collateral ratio computation
   - optional reserve source label/details
2. Change the adapter output contract so weak proofs are explicit in metadata and UI copy.
   - do not imply that “token exists” equals “reserve fully proved”
3. Bring `erc4626-single-asset` onto the same richer proof contract where possible:
   - total assets
   - underlying asset verification
   - optional supply/ratio telemetry
4. Review all current `single-asset`/`erc4626-single-asset` coins and classify each into:
   - keep as weak probe, with richer metadata
   - promote to stronger single-bucket proof
   - migrate to another adapter family
5. Update detail-page copy so the evidence class is more operationally honest for weak probes.

### Acceptance Criteria

- `single-asset` no longer means “100% reserve truth by default”.
- Weak-probe assets surface what was actually proved.
- Every currently configured `single-asset` coin has an explicit keep/promote rationale.

## WS3 - Adapter Accuracy Remediation

### Goal

Fix the adapters called out directly in the audit and remove their most important data-quality weaknesses.

### Primary targets

- `worker/src/cron/reserve-adapters/tether.ts`
- `worker/src/cron/reserve-adapters/accountable.ts`
- `worker/src/cron/reserve-adapters/fx.ts`
- `worker/src/cron/reserve-adapters/usdd-data-platform.ts`
- `worker/src/cron/reserve-adapters/infinifi.ts`
- `worker/src/cron/reserve-adapters/evm-branch-balances.ts`
- `worker/src/cron/reserve-adapters/gho.ts`

### Tasks

#### T1. `tether`

- Inspect the live payload shape actually returned by the current source.
- If a richer composition exists, parse it into explicit buckets.
- If it does not, replace the current one-bucket model with a conservative residual model:
  - explicitly modeled component(s)
  - `Unclassified / other reserves` residual slice
  - non-`very-low` treatment for the residual slice
- Do not keep a `100%` `very-low` single bucket unless the upstream definitively proves that structure.

#### T2. `accountable`

- Replace recursive `extractNestedNumericValue()` flattening with explicit per-bucket decoding.
- Stop defaulting unknown buckets into ordinary `medium` slices.
- Surface quantifiable unknown exposure explicitly and degrade only when thresholded.

#### T3. `fx`

- Move `fx` onto the shared unknown-exposure policy.
- If unmapped keys can be quantified honestly, emit an explicit unknown slice.
- If they cannot, fail closed with a clearer drift classification and operator-facing metadata.
- Add richer telemetry explaining why a failure happened.

#### T4. `usdd-data-platform`

- Keep the unknown vault slice, but make warning effect threshold-driven:
  - `info` below materiality
  - `degraded` above materiality
- Add clearer metadata about total vault coverage and unknown vault share.

#### T5. `infinifi`

- Fix `activeFarmCount` to reflect real active farms, not slice count.
- Move farm classification onto the shared classification DSL.

#### T6. `evm-branch-balances`

- Replace early float conversion with decimal-safe valuation.
- Add shared price fallback support:
  - coinId-aware price route where applicable
  - config price override only when explicitly justified
- Keep the adapter as the preferred family for simple multi-wallet reserve baskets.

#### T7. `gho`

- Keep current semantics, but make residual handling threshold-driven and better structured.
- Move decoder/loading logic into smaller internal modules once behavior is locked.

### Acceptance Criteria

- No high-impact adapter still has the exact overconfidence or drift behavior called out in the audit.
- The adapter-specific audit findings are all closed with tests.

## WS4 - Freshness And Evidence-Tier Normalization

### Goal

Eliminate the “freshness-unverified but still independent” ambiguity.

### Primary files

- `shared/lib/live-reserve-adapters.ts`
- `worker/src/cron/reserve-adapters/*.ts`
- `worker/src/cron/reserve-adapters/validate.ts`
- `worker/src/lib/live-reserves-store-view.ts`
- `worker/src/lib/report-cards-snapshot.ts`
- docs/methodology files listed in Constraints

### Independent adapters currently requiring review

- `asymmetry`
- `btcfi`
- `circle-transparency`
- `collateral-positions-api`
- `crvusd`
- `fx`
- `infinifi`
- `m0`
- `mento`
- `reservoir`

Affected coins now:

- `eurc-circle`
- `zchf-frankencoin`
- `ceur-celo`
- `deuro-deuro`
- `gbpm-mento`
- `usdc-circle`
- `m-m0`
- `crvusd-curve`
- `iusd-infinifi`
- `musd-metamask`
- `fxusd-f-x-protocol`
- `usdn-noble`
- `usdaf-asymmetry`
- `cusd-celo`
- `btcusd-btcfi`
- `wsrusd-reservoir`
- `ctusd-citrea`

### Tasks

1. For each reviewed adapter, choose exactly one path:
   - `verified`:
     extract and validate a source timestamp
   - `not-applicable`:
     prove that the source is intrinsically latest-state, not stale disclosure
   - downgrade:
     change the adapter definition out of `independent`
2. Encode the decision in tests and adapter definitions so the choice cannot silently regress.
3. Update `loadFreshIndependentLiveReserveMap()` eligibility to follow the locked contract only.
4. If evidence-tier changes affect scoring passthrough, update:
   - `docs/report-cards.md`
   - `docs/report-cards-timeline.md`
   - methodology section and scoring changelog content
5. Update `/status` reserve-health surfaces to include evidence-class counts or at least make them inspectable.

### Acceptance Criteria

- There are zero remaining `independent` adapters whose freshness admissibility is undefined.
- Any scoring-methodology impact is documented in both docs and methodology UI/changelog.

## WS5 - HTML Parser Hardening

### Goal

Reduce parser-drift risk without pretending HTML sources are APIs.

### Primary files

- all HTML adapters
- adapter fixture directories/tests
- `worker/src/cron/reserve-adapters/html.ts`

### Tasks

1. Back every HTML adapter with captured real-world fixtures.
2. Add explicit tests for:
   - happy path
   - layout-changed path
   - malformed embedded JSON path where applicable
3. Prefer structured extraction over raw regex when the page already embeds JSON.
4. Centralize shared HTML/escaped-JSON extraction helpers where the parsing shape is genuinely reused.
5. Keep parser failures distinct from ordinary network/upstream failures in logs and status.

### Acceptance Criteria

- HTML adapter regressions are catchable in tests using real fixture shapes.
- Parser drift produces a distinct, operator-useful failure mode.

## WS6 - Coverage-Quality And Breadth Wins

### Goal

Take the cheapest wins after core accuracy work is done, but keep them gated so they cannot destabilize the remediation.

### Scope split

#### C1. Coverage-quality promotions inside the existing live-enabled set

Tasks:

1. Review all `49` weak-live-probe coins and all `28` static-validated coins for immediate promotion candidates.
2. Prioritize promotions where repo research already suggests a public proof path:
   - stronger oracle/PoR path
   - ERC-4626 path
   - branch-balance path
3. Implement only candidates that satisfy both:
   - public source is live and machine-readable now
   - stronger evidence semantics are clear enough to document

#### C2. Low/mid-effort new or re-enabled breadth additions

Tasks:

1. Re-check `ousd-origin-protocol` for a restored public collateral endpoint before closing the series.
2. Add more `inputs.fallbacks` where a second public source already exists for the same adapter family.
3. Keep the optional candidate queue explicit and gated:
   - do not merge speculative source rediscovery into the core remediation PRs

### Acceptance Criteria

- The remediation series improves evidence quality even if zero optional breadth candidates graduate.
- Any optional coverage addition is source-verified at implementation time and documented.

## WS7 - Hotspot Cleanup, Docs, And Final Validation

### Goal

Close the maintainability loop and leave the subsystem easier to extend than it was at the start.

### Tasks

1. Finish helper splits only after behavior is stable.
2. Split `gho.ts` into smaller internal units if the earlier adapter work already touched it materially.
3. Update docs:
   - `docs/live-reserves.md`
   - `docs/status-dashboard.md`
   - `docs/report-cards.md`
   - `docs/report-cards-timeline.md`
   - `docs/coverage-page.md` if evidence-tier presentation changes there
4. Update methodology UI/changelog content if scoring/evidence eligibility changed.
5. If any new external source was added, update the About page and source documentation.
6. Refresh or add tests for:
   - helper modules
   - adapter fixtures
   - evidence-tier counts / status summaries

### Acceptance Criteria

- Docs match the post-remediation behavior.
- Hotspot ratchet remains compliant or improves.
- The audit issues can be closed directly against merged work.

## Phase Exit Gates

### Gate A - Core semantics landed

Required before adapter-family work continues:

- `WS1` merged
- fixture baseline exists
- unknown/freshness contract codified

### Gate B - Weak-probe truthfulness landed

Required before optional coverage promotions:

- `WS2` merged
- `tether` and `single-asset` issues closed

### Gate C - Evidence admissibility landed

Required before docs/methodology closeout:

- `WS4` merged
- all `independent` adapters have explicit admissibility mode

### Gate D - Series closeout

Required before final push/merge:

- all reserve-specific tests green
- `npm run lint` green
- `cd worker && npx tsc --noEmit` green
- `npm run build` green
- `npm run test:merge-gate` green
- docs/methodology updates committed where required

## Final Validation Checklist

1. Re-run the audit issue matrix and confirm every row is closed by code/docs/tests.
2. Confirm evidence-class counts and weak/static/independent semantics are reflected consistently in:
   - adapter definitions
   - reserve API/detail UI
   - status surface
   - docs
3. Verify no methodology-facing behavior changed without the matching methodology docs/changelog update.
4. Verify the optional coverage batch did not sneak speculative source work into the core remediation train.

## Bottom Line

The remediation should be executed as a truthfulness-and-contract program first, not as a coverage sprint. The system already works operationally. The next step is to make the evidence tiers, unknown exposure, freshness semantics, and weak-probe family honest and consistent, then consolidate the helper and classification layer, and only then take the cheap coverage wins.
