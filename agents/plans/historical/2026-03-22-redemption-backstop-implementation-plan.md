# Redemption Backstop Implementation Plan

Date: 2026-03-22

Source audit: `agents/2026-03-22-redemption-backstop-audit.md`

## Objectives

- Execute all eight audit findings without mixing correctness work and cleanup work.
- Improve redemption-backstop data accuracy before expanding or polishing the modeled surface.
- Make route evidence explicit, typed, and testable.
- Reduce maintainability cost only after the correctness and evidence model are stable.
- Keep each step independently deployable and locally verifiable.

## Non-Goals

- No broad redesign of the public stablecoin detail page.
- No speculative coverage expansion beyond the routes already identified by the audit.
- No D1 schema migration unless a later implementation round proves a JSON-backed additive field is insufficient.
- No breaking public API changes when an additive field or stricter internal rule can solve the issue.

## Constraints

- Use the existing hourly redemption cron and live-reserve lane. No schedule changes are planned.
- Prefer additive API fields over enum churn where possible.
- Methodology-affecting changes must update:
  - `docs/redemption-backstops.md`
  - `docs/report-cards.md`
  - `src/app/methodology/sections/core-sections.tsx`
  - the relevant methodology version/timeline surfaces in code and docs
- If a remediation introduces a new external source during route review, update the about page.
- Final program gate remains `npm run test:merge-gate`.

## Delivery Rules

- Land correctness fixes before evidence-tier or registry refactors.
- Do not combine route research batches with structural refactors.
- Add or tighten tests in the same PR as the behavior change.
- Keep public API changes additive unless the audit found a hard correctness bug that requires a contract correction.
- Preserve the current “configured but unrated” behavior for unresolved routes unless the specific workstream intentionally changes it.

## Recommended Sequence

1. Workstream 0: Characterization and fixture baseline
2. Workstream 1: Correct resolved-evidence semantics and stale-data handling
3. Workstream 2: Type the reserve-to-redemption metadata contract
4. Workstream 3: Make snapshot methodology metadata reflect stored rows
5. Workstream 4: Strengthen provenance and evidence rendering
6. Workstream 5: Introduce explicit evidence tiers and stronger guardrails
7. Workstream 6: Fix adapter-specific modeling gaps and placeholder routes
8. Workstream 7: Mutualize and reduce LOC after semantics are stable

## Parallelization

- Workstreams 2 and 3 can run in parallel after Workstream 1.
- Workstream 4 should start after Workstream 2 because it depends on a more explicit evidence contract.
- Workstream 5 can begin once Workstreams 2 and 4 define the evidence vocabulary.
- Workstream 6 should not start until Workstream 5 defines how placeholder and reviewed routes are represented.
- Workstream 7 must be last. It should not share a PR with semantic corrections.

## PR Map

1. `redemption-characterization-baseline`
2. `redemption-fallback-confidence-fix`
3. `redemption-stale-metadata-expiry`
4. `redemption-reserve-metadata-contract`
5. `redemption-adapter-metadata-tests`
6. `redemption-snapshot-methodology-consistency`
7. `redemption-provenance-contract`
8. `redemption-provenance-ui`
9. `redemption-evidence-tier-foundation`
10. `redemption-guardrail-hardening`
11. `redemption-honey-gho-model-fixes`
12. `redemption-placeholder-route-review-batch-1`
13. `redemption-placeholder-route-review-batch-2`
14. `redemption-registry-mutualization`
15. `redemption-entry-builder-refactor`

## Workstream 0: Characterization And Fixture Baseline

Findings covered: prerequisite support for 1, 2, 5, 6, 7

### Scope

- `worker/src/lib/__tests__/redemption-backstop-sources.test.ts`
- `worker/src/lib/__tests__/redemption-backstops-store.test.ts`
- `worker/src/cron/__tests__/sync-redemption-backstops.test.ts`
- New targeted fixtures/helpers under `worker/src/lib/__tests__/` as needed

### Implementation

- Add characterization cases for the audit’s representative routes:
  - `usdo-openeden`
  - `gho-aave`
  - `iusd-infinifi`
  - `wsrusd-reservoir`
  - `bold-liquity`
  - `lusd-liquity`
  - `honey-berachain`
  - the five explicit placeholder-ratio routes
- Add regression assertions for:
  - resolved vs unresolved semantics
  - stale reserve metadata handling
  - fallback ratio behavior
  - methodology metadata returned by the snapshot builder
- Freeze the current public payload expectations before semantic changes begin.

### Tests

- Extend the three existing redemption worker suites above.
- Add adapter-targeted regression fixtures for the dynamic routes where useful.

### Docs

- No doc changes expected in this workstream.

### Acceptance Criteria

- There is direct fixture coverage for every dynamic route and every explicitly placeholder route.
- Pre-change behavior is characterized before semantic work begins.
- The later workstreams can tighten behavior without relying on brittle ad hoc mocks.

### Risks And Mitigation

- Risk: characterization tests overfit current quirks that should change.
- Mitigation: keep characterization scoped to behavior the later workstreams will intentionally review and update.

## Workstream 1: Correct Resolved-Evidence Semantics And Stale-Data Handling

Findings covered: 1 and 2

### Scope

- `worker/src/lib/redemption-backstop-sources.ts`
- `shared/lib/redemption-backstop-confidence.ts`
- `worker/src/lib/report-cards-snapshot.ts`
- `shared/lib/report-cards.ts`
- `worker/src/lib/__tests__/redemption-backstop-sources.test.ts`
- `worker/src/cron/__tests__/sync-redemption-backstops.test.ts`

### Implementation

#### Phase 1A: Fix fallback confidence

- Stop deriving capacity confidence purely from configured model kind for resolved entries.
- Introduce a resolved-evidence decision based on the actual resolution path:
  - fresh reserve metadata -> `dynamic`
  - configured fallback ratio -> `heuristic`
  - static supply model -> existing confidence behavior
- Keep the low-churn option: do not add a new public enum just to model fallback. Reuse `heuristic`.
- Ensure `provider = "reserve-sync-fallback"` cannot produce `medium` or `high` `modelConfidence`.

#### Phase 1B: Hard-expire stale reserve-derived inputs

- Treat `LIVE_RESERVE_FRESHNESS_SEC` as the usability ceiling for redemption scoring inputs, not just a cosmetic freshness label.
- For capacity:
  - fresh live metadata -> scoreable
  - stale live metadata with fallback ratio -> fall back to the configured ratio and downgrade confidence
  - stale live metadata without fallback ratio -> unresolved
- For fee telemetry:
  - formula / live-fee routes may use `redemptionFeeBps` only when the reserve metadata is fresh
  - otherwise revert to the reviewed descriptive bucket with no stale carried-forward fee number
- Require `lastStatus === "ok"` in addition to `lastSuccessAt` freshness before treating reserve-backed metadata as live usable evidence.

#### Phase 1C: Keep report-card gating aligned

- Reconfirm that only non-low-confidence resolved routes can uplift Safety Score liquidity.
- Add regression coverage proving that stale or fallback-derived routes do not stay eligible for liquidity uplift.

### Tests

- Add direct tests for:
  - fallback-ratio resolution producing `heuristic` confidence
  - stale reserve metadata producing fallback or unresolved rows as appropriate
  - stale live fee metadata reverting to descriptive fee handling
  - report-card liquidity gating after fallback or expiry

### Docs

- Update `docs/redemption-backstops.md`
- Update `docs/report-cards.md`
- Update `docs/api-reference.md`
- Update `src/app/methodology/sections/core-sections.tsx`
- Update the relevant methodology version entries in:
  - `shared/lib/redemption-backstop-version.ts`
  - `shared/lib/safety-score-version.ts` if the liquidity-uplift rule changes

### Acceptance Criteria

- `reserve-sync-fallback` never resolves to `dynamic` confidence.
- Stale reserve-derived capacity or fee telemetry is not silently reused as scoreable live evidence.
- Report cards cannot uplift liquidity from stale or fallback-derived routes unless the resulting model is intentionally low-risk and explicitly allowed.
- No unrelated route-family scores change without a test explaining why.

### Risks And Mitigation

- Risk: more routes become unresolved immediately after deploy.
- Mitigation: ship the fallback-confidence fix before broader route reviews so degraded routes fail conservatively instead of failing opaquely.

## Workstream 2: Type The Reserve-To-Redemption Metadata Contract

Findings covered: 7

### Scope

- `worker/src/lib/live-reserves-store.ts`
- `worker/src/lib/redemption-backstop-sources.ts`
- Live reserve adapters that emit redemption-relevant metadata:
  - `worker/src/cron/reserve-adapters/openeden.ts`
  - `worker/src/cron/reserve-adapters/gho.ts`
  - `worker/src/cron/reserve-adapters/reservoir.ts`
  - `worker/src/cron/reserve-adapters/infinifi.ts`
  - `worker/src/cron/reserve-adapters/single-asset.ts`
  - `worker/src/cron/reserve-adapters/evm-branch-balances.ts`

### Implementation

- Introduce a worker-local typed metadata schema for redemption consumers, for example:
  - `immediateRedeemableUsd`
  - `immediateRedeemableRatio`
  - `redemptionFeeBps`
  - future additive bounds/notes if needed
- Add decode/normalize helpers so `redemption-backstop-sources.ts` reads typed metadata instead of raw `Record<string, unknown>`.
- Validate the metadata contract at the reserve-sync persistence boundary, not only at read time.
- Keep the stored JSON shape backward-compatible; new validation should accept older rows and normalize missing fields to `null`.

### Tests

- Add direct adapter-level assertions that the following metadata fields are emitted correctly:
  - OpenEden immediate capacity
  - Reservoir immediate capacity
  - infiniFi immediate capacity
  - GHO capacity and fee bounds
  - `single-asset` fee probe
  - `evm-branch-balances` fee probe
- Add store-level decode tests for backward-compatible older metadata payloads.

### Docs

- Update `docs/redemption-backstops.md` to describe the typed reserve metadata dependency.
- Update `docs/testing.md` for the expanded adapter coverage.

### Acceptance Criteria

- The redemption module no longer depends on magic metadata keys without schema validation.
- All six contributing adapters have direct tests for the metadata used by redemption scoring.
- Older stored metadata rows remain readable.

### Risks And Mitigation

- Risk: write-time validation breaks a noisy adapter unexpectedly.
- Mitigation: land adapter tests first, then enforce validation, and keep decoder normalization tolerant for existing stored rows.

## Workstream 3: Make Snapshot Methodology Metadata Reflect Stored Rows

Findings covered: 5

### Scope

- `worker/src/lib/redemption-backstops-store.ts`
- `shared/lib/redemption-backstop-version.ts`
- `worker/src/lib/__tests__/redemption-backstops-store.test.ts`
- `worker/src/api/__tests__/redemption-backstops.test.ts`

### Implementation

- Stop building the API envelope purely from current constants.
- Derive snapshot methodology metadata from the stored snapshot:
  - use row `updated_at`
  - use row `methodology_version`
  - use `getRedemptionBackstopVersionAt(updatedAt)` to resolve the version metadata active when the snapshot was produced
- If the stored rows contain mixed versions:
  - keep the public payload backward-compatible
  - expose explicit mixed/stale status additively if needed
  - do not advertise `isCurrent: true` for a mixed snapshot
- Preserve current top-level fields unless an additive field materially improves operator visibility.

### Tests

- Add coverage for:
  - stored snapshot on current version
  - stored snapshot on previous version
  - mixed-version current rows
  - no-row bootstrap behavior remaining `503`

### Docs

- Update `docs/redemption-backstops.md`
- Update `docs/api-reference.md`

### Acceptance Criteria

- The top-level methodology envelope matches the stored snapshot, not just current code.
- One-cron-interval deployment drift is removed.
- Existing consumers still parse the response without a breaking change.

### Risks And Mitigation

- Risk: version metadata logic grows too clever.
- Mitigation: keep the algorithm simple and anchored to stored row timestamps plus stored row version strings.

## Workstream 4: Strengthen Provenance And Evidence Rendering

Findings covered: 3

### Scope

- `worker/src/lib/redemption-backstop-sources.ts`
- `shared/types/redemption.ts`
- `worker/src/lib/redemption-backstops-store.ts`
- `src/components/stablecoin-detail/redemption-backstop-card.tsx`
- `src/components/stablecoin-detail/__tests__/redemption-backstop-card.test.tsx`

### Implementation

#### Phase 4A: Provenance contract

- Add explicit provenance for the doc source path, for example:
  - `config-reviewed`
  - `live-reserve-display`
  - `proof-of-reserves`
  - `generic-link`
- Keep the public contract additive.
- Preserve `docs.sources[]` and make the selected primary source traceable instead of implicit.

#### Phase 4B: UI rendering

- Render `docs.sources[]` in the detail card, not just the top-level link.
- Surface `supports` badges so users can distinguish route evidence from capacity-only evidence.
- Label fallback sources as fallback sources rather than presenting them as reviewed route evidence.
- Render `capsApplied` and, where useful, stronger confidence/explanation copy.

### Tests

- Extend the detail-card test suite with:
  - multiple structured sources
  - reviewed vs fallback source labeling
  - support-tag rendering
- Extend store round-trip tests for the new additive provenance fields.

### Docs

- Update `docs/redemption-backstops.md`
- Update `docs/stablecoin-detail-page.md`
- Update `docs/api-reference.md`

### Acceptance Criteria

- The UI no longer collapses all evidence into a generic single link.
- Users can tell whether a source was reviewed route evidence or a weaker fallback.
- Stored rows round-trip the additive provenance fields without schema churn.

### Risks And Mitigation

- Risk: UI becomes noisy.
- Mitigation: keep the card concise by prioritizing the primary source and collapsing secondary sources behind a compact list.

## Workstream 5: Introduce Explicit Evidence Tiers And Stronger Guardrails

Findings covered: 4 and 8

### Scope

- `shared/lib/redemption-backstop-configs/shared.ts`
- Route-family config modules under `shared/lib/redemption-backstop-configs/`
- `shared/lib/redemption-backstop-confidence.ts`
- `shared/types/redemption.ts`
- `src/lib/coverage.ts`
- `scripts/check-redemption-backstops.ts`
- `shared/lib/__tests__/redemption-backstop-consistency.test.ts`

### Implementation

#### Phase 5A: Evidence tiers

- Add an explicit evidence-tier concept, preferably additively, for example:
  - `dynamic`
  - `documented-bound`
  - `heuristic-reviewed`
  - `placeholder`
- Stop inferring placeholder status from a note regex.
- Encode placeholder routes explicitly in config.
- Ensure placeholder routes cannot accidentally reach `medium` or `high` confidence.

#### Phase 5B: Guardrail hardening

- Extend `check:redemption-backstops` to enforce:
  - every `placeholder` route is on an explicit allowlist
  - every route that can reach `medium` or `high` confidence has `docs` plus `reviewedAt`
  - every `reserve-sync-metadata` route maps to a real live-reserve adapter path
  - route-family and evidence-tier combinations are valid
- Move duplicated family-module metadata into one shared constant used by both the script and the consistency test.

#### Phase 5C: Coverage/UI integration

- Update coverage semantics so placeholder routes are visually distinct from reviewed heuristics.
- Keep additive public payload changes backward-compatible.

### Tests

- Extend config consistency tests for evidence-tier invariants.
- Add script-level tests if needed for the stricter guard behavior.
- Extend coverage tests if present for placeholder vs heuristic route display.

### Docs

- Update `docs/redemption-backstops.md`
- Update `docs/coverage-page.md`
- Update `docs/testing.md`

### Acceptance Criteria

- Placeholder status is explicit and machine-checked.
- Strong-confidence routes require reviewed evidence.
- Guardrails fail on evidence-quality regressions, not only registry shape issues.

### Risks And Mitigation

- Risk: guardrails become too brittle for legitimate future additions.
- Mitigation: prefer explicit allowlists and invariants over global quota thresholds.

## Workstream 6: Fix Adapter-Specific Modeling Gaps And Review Placeholder Routes

Findings covered: 6 and the route-quality part of 4

### Scope

- `shared/lib/redemption-backstop-configs/stablecoin-redeem.ts`
- `shared/lib/redemption-backstop-configs/psm-and-basket.ts`
- `shared/lib/redemption-backstop-configs/offchain-issuer.ts`
- Route-specific supporting docs/tests as needed

### Implementation

#### Phase 6A: Immediate route corrections

- `honey-berachain`
  - Reclassify the route to reflect the stress-state exit path, not the best-case normal path.
  - Preferred default: model basket semantics in the redemption route itself unless a richer conditional-route contract is introduced.
- `gho-aave`
  - Decide and implement one of two approved paths:
    - low-churn path: keep conservative bounded fee behavior but source the current bound from live metadata
    - richer path: expose live fee bounds additively and score against the conservative current bound
  - Do not keep measuring live fee ranges in the adapter while ignoring them in the scoring path.

#### Phase 6B: Placeholder-route review batches

- Review and resolve the five explicit placeholder-ratio routes first:
  - `dusd-standx`
  - `usdf-astherus`
  - `usr-resolv`
  - `yusd-aegis`
  - `usn-noon`
- For each route, end in exactly one state:
  - upgraded with reviewed evidence
  - kept as explicit placeholder
  - demoted to configured-unrated if the current assumption is not supportable
- After batch 1, review the remaining `supply-ratio` heuristics in descending priority:
  - market cap / user relevance
  - route-family diversity
  - confidence upgrade potential

### Tests

- Add route-specific tests for Honey and GHO semantics.
- Add config/regression tests for each reviewed placeholder route.

### Docs

- Update `docs/redemption-backstops.md`
- Update `docs/report-cards.md` if effective-exit semantics change
- Update `src/app/methodology/sections/core-sections.tsx`
- Update methodology version/timeline surfaces for any scoring or route-model change
- Update the about page if a new external source is introduced during route review

### Acceptance Criteria

- Honey no longer models the wrong stress-state exit semantics.
- GHO no longer ignores meaningful live fee data the adapter already measures.
- Every placeholder route in the explicit batch ends in a deliberate evidence state.

### Risks And Mitigation

- Risk: route research balloons and blocks the whole program.
- Mitigation: keep batch reviews capped and separate from platform-wide correctness work.

## Workstream 7: Mutualize Builders, Registry Policy, And Reduce LOC

Findings covered: overall maintainability, mutualization, and LOC reduction goals

### Scope

- `shared/lib/redemption-backstop-configs/index.ts`
- `shared/lib/redemption-backstop-configs/shared.ts`
- Route-family config modules
- `worker/src/lib/redemption-backstop-sources.ts`
- `scripts/check-redemption-backstops.ts`
- `shared/lib/__tests__/redemption-backstop-consistency.test.ts`

### Implementation

#### Phase 7A: Registry mutualization

- Move family-module metadata into one shared source consumed by:
  - registry build
  - guard script
  - consistency tests
- Convert obvious repeated registry patterns into table-driven helpers:
  - repeated offchain issuer groups
  - repeated placeholder ratio groups
  - repeated fixed-fee / undocumented-fee blocks

#### Phase 7B: Entry-construction mutualization

- Extract a shared entry-builder path so resolved and failed entries do not duplicate the full response shape.
- Keep field ordering and serialized payloads stable where possible to minimize noisy diffs.

#### Phase 7C: File-size and readability cleanup

- Split `redemption-backstop-sources.ts` if the correctness work left it too dense:
  - docs resolution
  - capacity resolution
  - fee resolution
  - entry assembly
- Do not refactor for aesthetics alone; target duplication and drift risk.

### Tests

- Keep all existing redemption suites green.
- Add focused tests only where extraction changes behavior or moves shared constants.

### Docs

- Update `docs/redemption-backstops.md`
- Update `docs/architecture.md`
- Update `docs/testing.md` if ownership tables or file references change

### Acceptance Criteria

- Registry family metadata is declared once.
- Entry construction no longer duplicates the full payload shape across resolved and failed code paths.
- Any file split or helper extraction is behavior-preserving outside the intentional semantic fixes from earlier workstreams.

### Risks And Mitigation

- Risk: cleanup refactor obscures earlier correctness diffs.
- Mitigation: keep this workstream after the semantic changes and land it in isolated PRs.

## Validation Matrix

| Audit finding | Covered by |
| --- | --- |
| 1. Fallback mislabeled as dynamic | Workstream 1 |
| 2. Stale reserve metadata never ages out | Workstream 1 |
| 3. Evidence/provenance too weak | Workstream 4 |
| 4. Heuristic dominance / low-confidence registry | Workstreams 5 and 6 |
| 5. Top-level methodology drift | Workstream 3 |
| 6. Adapter-specific semantics gaps | Workstream 6 |
| 7. Stringly typed reserve metadata contract | Workstream 2 |
| 8. Guardrails only check registry shape | Workstream 5 |

## Validation Strategy

### Per-PR Gate

- `npm run check:redemption-backstops`
- targeted redemption Vitest suites for the touched files
- doc updates in the same PR when methodology, API, or UI behavior changes

### Program-Level Gate

- `npm run lint`
- `npm test`
- `npm run check:redemption-backstops`
- `npm run check:doc-sync`
- `npm run build`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

### Behavioral Validation

- Re-run the focused redemption suites after each semantic workstream.
- Verify the representative-route fixture set after Workstreams 1, 3, 5, and 6.
- Confirm that:
  - fallback-derived routes cannot uplift Safety Score liquidity
  - stale reserve metadata becomes unusable on the defined schedule
  - dynamic routes retain scoreability when live reserve sync is healthy
  - placeholder routes are explicit and visually distinct
  - snapshot methodology metadata matches the stored rows

## Plan Validation Results

- Every audit finding is mapped in the validation matrix.
- Every workstream includes scope, implementation, tests, docs, acceptance criteria, and risk handling.
- Methodology-affecting workstreams explicitly call out methodology docs/version updates.
- No workstream requires a destructive migration or a breaking API change by default.
- The sequence keeps correctness ahead of refactor and keeps route research isolated from platform fixes.
