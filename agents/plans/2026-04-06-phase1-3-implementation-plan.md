# Phase 1-3 Implementation Plan

Date: 2026-04-06  
Source audit: `agents/audits/2026-04-06-comprehensive-codebase-remediation-blueprint.md`

Companion execution artifacts:

- `agents/plans/2026-04-06-phase1-3-execution-control-board.md`
- `agents/specs/2026-04-06-characterization-fixture-tickets.md`
- `agents/research/2026-04-06-phase1-3-plan-revalidation.md`

## Objective

Execute all Phase 1, Phase 2, and Phase 3 remediation items from the comprehensive audit, plus two targeted pull-ins from Phase 4, in a sequence that is:

1. Safe for production worker and Pages surfaces.
2. Small enough to review and verify incrementally.
3. Explicit about documentation, methodology, and rollout obligations.
4. Structured so the repo's own guardrails tighten as the refactors land.

This plan still excludes the full Phase 4 strategic overhauls. It pulls forward only:

- the contract-driven governance checks for env/docs/hotspot freshness
- a no-behavior-change worker cron contract foundation slice that de-risks the later cron decompositions

## Scope Map

Included findings:

- Phase 1: `CQ-01`, `CQ-02`, `CQ-03`, `CQ-04`, `CQ-05`, `CQ-09`, `R-04`, `S-07`, `S-08`, `S-09`, `R-01`
- Phase 2: `R-03`, `S-01`, `S-04`, `CQ-08`, `CQ-06`, `R-02`
- Phase 3: `S-02`, `S-05`, `S-06`, `CQ-07`, `S-03`
- Pulled forward from Phase 4:
  - `C-01`, `S-07`, `S-08` governance checks: env-contract verification, verified-doc link checks, hotspot inventory freshness
  - `C-04` foundation only: shared cron stage/handoff contracts and conventions for later worker decompositions

Cross-cutting constraints that must be honored during execution:

- Worker/API behavior changes require docs updates when public contracts change.
- DEWS work is a methodology-surface change; update `/methodology` and the DEWS changelog/timeline as required.
- Yield work is a methodology-surface change if source-resolution, arbitration, freshness, or publication semantics change.
- Pricing-pipeline work is a methodology-surface change if pass ordering, fallback semantics, or validation semantics change.
- Every merge back to `main` must pass `npm run test:merge-gate`.

## Operating Rules

1. Use one worktree branch per slice.
2. Keep correctness fixes separate from structural refactors.
3. Add characterization tests before large decompositions where behavior must remain invariant.
4. Expand guardrails in non-blocking mode first; make them blocking only after existing violations are removed.
5. For worker-impacting branches, run targeted tests during development, then `cd worker && npx tsc --noEmit`, then `npm run test:merge-gate` before merge.
6. For Pages-impacting branches, run targeted tests during development, then `npm run build` when the diff touches the app surface, then `npm run test:merge-gate` before merge.
7. Do not batch independent subsystems into one PR just to "finish a phase".

## Success Criteria

- All Phase 1 findings are fixed with regression coverage.
- Phase 2 produces reusable contracts/guardrails without changing public behavior unintentionally.
- Phase 3 decomposes the worker hotspots while preserving published behavior through characterization coverage.
- Contract-driven governance checks keep env docs, verified-doc links, and hotspot inventory freshness from drifting again.
- Shared worker cron stage/handoff conventions exist before the big stablecoin, yield, and DEWS decompositions.
- Expanded cycle detection is blocking after the existing worker cycles are removed.
- Hotspot governance no longer depends on stale manual backlog state and covers the current risk surface.

## Execution Hardening Addendum

These controls exist to reduce coordination failures, merge conflicts, and accidental semantic drift while multiple agents are active on the repo.

### Ownership and Serialization Map

Only one active slice may own each lane at a time.

| Lane | Owned slices | Files/modules that must not be edited concurrently |
| --- | --- | --- |
| Auth/admin | `A2`, `B4` | `worker/src/lib/api-keys*`, `worker/src/handlers/http/gates.ts`, auth docs |
| DEWS | `A3`, `C5` | `worker/src/cron/compute-dews.ts`, `worker/src/lib/dews.ts`, DEWS docs/methodology files |
| DEX degraded-mode | `A4` | `worker/src/cron/dex-liquidity/*`, `worker/src/api/api-key-audit-log.ts` |
| Governance/docs/process | `A1`, `B7`, `C6`, `C7` | `.env.example`, `README.md`, `docs/testing.md`, `docs/deployment-process.md`, `scripts/lib/hotspot-ratchet*`, `scripts/lib/validate-contract.mjs`, `package.json`, CI workflow files |
| Status contract | `B1` | `shared/types/status.ts`, shared parser module, status consumers |
| Cycle enforcement | `B2`, `C1`, `C2`, `C7` | `scripts/check-shared-cycles.mjs`, cycle-bearing worker modules |
| Cron architecture | `B3`, `B6`, `C2`, `C4`, `C5` | `worker/src/cron/shared/*`, `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/sync-stablecoins*`, `worker/src/cron/compute-dews.ts`, `worker/src/cron/yield-sync/*` |
| Frontend analytics | `A5`, `B5` | `src/lib/admin-access.ts`, `src/app/admin/client.tsx`, `src/components/contagion-graph.tsx` |
| Stablecoin sync | `C2`, `C3` | `worker/src/cron/sync-stablecoins*`, pricing docs |
| Yield | `B6`, `C4` | `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/yield-sync/*`, yield docs |

If another agent lands or is actively editing files in a lane, the slice owner must pause, rebase, and either:

1. wait for the lane to clear, or
2. split the slice into a non-overlapping subset.

### Tranche Merge Gates

These gates control **merge order into `main`**, not whether an agent may prepare a branch in parallel. A later-tranche slice may be developed early in a worktree if:

1. its ownership lane is clear,
2. it does not overlap active files from an earlier-tranche slice, and
3. it is rebased and revalidated before merge once its gate opens.

Do not merge the next tranche into `main` until the gate is satisfied.

| Gate | Required state |
| --- | --- |
| Gate A -> B | `A1` through `A5` merged, critical correctness fixes closed, docs/config drift corrected |
| Gate B -> C | `B2`, `B3`, and `B7` merged so cycle reporting, cron contracts, and governance checks exist before major refactors |
| Gate C -> enforcement | `C1` and `C2` merged, expanded cycle report clean for current worker/src violations, hotspot governance automation stable enough for `C7` |

### Baseline Capture Checklist

Before any large decomposition slice (`B4`, `B6`, `C2`, `C3`, `C4`, `C5`):

1. Capture a characterization baseline in tests or fixtures, not only in prose.
2. Record the current guardrail output if the slice touches guardrails.
3. Record representative public behavior for the touched surface:
   - auth/admin: request/response and limiter behavior
   - DEWS: representative computed rows and edge-case inputs
   - yield: representative rankings/source-selection outcomes
   - stablecoin sync: representative publish/depeg/fallback outcomes
4. Note any methodology-doc expectation before editing code, so doc/versioning work is not forgotten at the end.

### Stop Conditions

A slice must stop and be re-planned if any of these happen:

1. It needs to change published API shape unexpectedly.
2. It changes methodology semantics when the slice was intended to be no-behavior-change.
3. It grows into more than one subsystem lane from the ownership map.
4. It cannot be covered by targeted tests plus `npm run test:merge-gate` without adding broad speculative edits.
5. A new shared abstraction is introduced but not adopted by at least one downstream consumer in the next scheduled slice.

### Rebase and Merge Discipline

For every active slice:

1. Rebase onto the latest `main` before the final validation run.
2. Re-run targeted tests after rebase if touched files changed upstream.
3. Run `npm run test:merge-gate` only on the rebased head that is about to merge.
4. If another agent landed overlapping changes, prefer re-slicing over large conflict-resolution edits.

## Delivery Structure

The plan is organized into three tranches and nineteen mergeable slices.

### Tranche A: Correctness and hygiene

Goal: land low-risk fixes that close live bugs, sync docs/config, and reduce operational noise.

| Slice | Findings | Goal | Primary files |
| --- | --- | --- | --- |
| A1 | `S-07`, `S-08`, `S-09`, `R-01` | Sync docs/config/hotspot hygiene | `.env.example`, `README.md`, `docs/testing.md`, `.gitignore`, `scripts/lib/hotspot-ratchet-baseline.json`, `agents/plans/historical/2026-03-29-hotspot-decomposition-backlog.md` |
| A2 | `CQ-01`, `CQ-04` | Fix invalid-key limiter bypass and add regression coverage | `worker/src/handlers/http/gates.ts`, `worker/src/lib/api-keys.ts`, worker auth tests, `docs/api-reference.md`, `docs/worker-and-api-limits.md`, `docs/worker-infrastructure.md` |
| A3 | `CQ-02`, `CQ-05` | Restore DEWS baseline semantics and add edge-case coverage | `worker/src/cron/compute-dews.ts`, `worker/src/lib/dews.ts`, DEWS tests, `docs/dews.md`, `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`, `docs/depeg-dews-timeline.md`, possibly `shared/lib/depeg-dews-version.ts` |
| A4 | `CQ-03`, `CQ-09` | Harden degraded-path handling in DEX coverage and audit-log parsing | `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`, `worker/src/cron/dex-liquidity/orchestrator.ts`, `worker/src/api/api-key-audit-log.ts`, related tests |
| A5 | `R-04` | Remove the single-mode admin wrapper | `src/lib/admin-access.ts`, `src/app/admin/client.tsx`, `src/hooks/use-admin-polling-query.ts` |

### Tranche B: Contracts and guardrails

Goal: add the infrastructure, shared contracts, and governance checks that make the later refactors safer and more enforceable.

| Slice | Findings | Goal | Primary files |
| --- | --- | --- | --- |
| B1 | `R-03` | Replace duplicated status metadata coercion with a shared typed parser | `shared/types/status.ts`, new shared parser module, `src/components/status/cron-metadata-summary.ts`, `src/components/status/telegram-bot-stats.tsx`, `worker/src/lib/status/telegram-bot-stats.ts` |
| B2 | `S-01` | Expand cycle detection to report on `worker/src` and `src` without blocking yet | `scripts/check-shared-cycles.mjs`, `scripts/lib/validate-contract.mjs`, `package.json`, `docs/testing.md`, CI wiring if needed |
| B3 | `C-04` | Establish shared worker cron stage/handoff contracts and conventions before the large cron decompositions | new `worker/src/cron/shared/*` or equivalent contract modules, `worker/src/cron/sync-stablecoins/*`, `worker/src/cron/compute-dews.ts`, `worker/src/cron/sync-yield-data.ts`, `worker/src/cron/yield-sync/*`, `docs/architecture.md` if needed |
| B4 | `S-04` | Split `api-keys.ts` into focused modules behind a stable facade | `worker/src/lib/api-keys.ts`, new `worker/src/lib/api-key-*.ts` modules |
| B5 | `CQ-08` | Extract contagion graph model/traversal logic into testable helpers | `src/components/contagion-graph.tsx`, new helper modules/tests |
| B6 | `CQ-06` | Split `sync-yield-data.ts` into coordinator, publication, and state-loading units | `worker/src/cron/sync-yield-data.ts`, adjacent helper modules/tests |
| B7 | `R-02`, `C-01`, `S-07`, `S-08` | Add contract-driven governance checks for hotspot freshness, verified-doc links, and env-contract drift | `scripts/lib/hotspot-ratchet.mjs`, new docs/env verification tooling, `scripts/lib/validate-contract.mjs`, `package.json`, `worker/src/lib/env.ts`, `.env.example`, `README.md`, `docs/testing.md`, `docs/deployment-process.md`, `.github/workflows/validate-ci.yml` if needed |

### Tranche C: Structural decompositions

Goal: remove the remaining architectural hotspots while keeping behavior stable.

| Slice | Findings | Goal | Primary files |
| --- | --- | --- | --- |
| C1 | `S-01` | Break the `live-reserves` cycle so expanded cycle checks can eventually be blocking | `worker/src/lib/live-reserves-store-shared.ts`, `worker/src/lib/live-reserves-store-parsing.ts`, any new leaf contract module |
| C2 | `S-02` | Refactor `sync-stablecoins` into one-directional phase contracts and remove runtime back-edges | `worker/src/cron/sync-stablecoins.ts`, `worker/src/cron/sync-stablecoins/stages.ts`, `worker/src/cron/sync-stablecoins/fallback.ts`, `worker/src/cron/sync-stablecoins/intake.ts`, `worker/src/cron/sync-stablecoins/runtime.ts` |
| C3 | `S-06` | Split `enrich-prices-passes.ts` by provider family | `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`, new `enrich-prices/*` modules, pricing tests/docs if semantics move |
| C4 | `S-05` | Decompose yield resolver families out of the remaining large resolver | `worker/src/cron/yield-sync/resolve.ts`, `worker/src/cron/yield-sync/*`, yield tests/docs if semantics move |
| C5 | `CQ-07` | Rebuild DEWS into staged assembly -> derivation -> persistence modules | `worker/src/cron/compute-dews.ts`, `worker/src/lib/dews.ts`, DEWS tests, methodology docs if behavior/explanation changes |
| C6 | `S-03` | Replace fixed hotspot enrollment with generated candidate enrollment plus waivers | `scripts/lib/hotspot-ratchet.mjs`, `scripts/lib/hotspot-ratchet-baseline.json`, docs/process material |
| C7 | `S-01` | Flip expanded cycle detection from report-only to blocking after worker cycles are cleared | `scripts/check-shared-cycles.mjs`, `scripts/lib/validate-contract.mjs`, `package.json`, `.github/workflows/validate-ci.yml`, `docs/testing.md`, `docs/deployment-process.md`, `docs/scripts.md` |

## Ordered Execution Plan

The slices above are merged in this order.

### 1. A1 - Docs, env, ignore, and hotspot backlog hygiene

Why first:

- Low risk.
- Removes known drift from the docs corpus before later changes depend on those documents.
- Simplifies later hotspot-governance work.

Implementation notes:

- Sync `.env.example` to `worker/src/lib/env.ts`.
- Fix `README.md` to use `NEXT_PUBLIC_API_BASE`.
- Fix the stale hotspot backlog path in `docs/testing.md`.
- Add `worker/.next/` to `.gitignore`.
- Remove stale hotspot entries that now point to facade/barrel files.
- Repo revalidation note: because `scripts/lib/hotspot-ratchet-baseline.json` changed materially in recent `main` commits, land the docs/env/ignore fixes first. If the baseline or backlog note changes again before merge, defer the stale hotspot cleanup portion of `R-01` into `B7`/`C6` instead of doing a large governance-lane conflict merge.

Validation:

- `npm run check:doc-counts`
- `npm run check:doc-sync`
- `npm run check:hotspot-ratchet`
- `npm run lint`
- `npm run test:merge-gate`

### 2. A2 - Public API auth correctness

Why second:

- `CQ-01` is the highest-severity live bug.
- `B4` later restructures the same subsystem; land the bug fix first so the refactor has a known-good baseline.

Implementation notes:

- Reorder public protected-route handling so invalid `X-API-Key` requests on public routes fall through to the public IP limiter instead of returning early after D1-backed auth work.
- Preserve current valid-key behavior and ops/site-api behavior.
- Add one explicit regression test for invalid key -> public limiter path.
- Update public API docs and worker infra docs to match the final gate semantics.

Validation:

- Targeted worker tests for auth gates
- `cd worker && npx tsc --noEmit`
- `npm run lint`
- `npm run test:merge-gate`

Optional local smoke:

- `cd worker && npx wrangler dev`
- Probe one public protected route with no key, invalid key, and valid key.

### 3. A3 - DEWS baseline correctness

Why third:

- `CQ-02` is a live methodology bug and should be fixed before the larger DEWS decomposition.

Implementation notes:

- Build mint/burn flow inputs from the union of 24h and baseline rows.
- Add targeted tests for "no 24h rows, valid baseline rows".
- Review whether the fix changes external semantics or simply restores documented intent.
- If user-visible methodology semantics change or clarification is needed, update:
  - `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`
  - `docs/dews.md`
  - `docs/depeg-dews-timeline.md`
  - `shared/lib/depeg-dews-version.ts` only if a methodology version increment is warranted

Validation:

- Targeted DEWS tests
- `cd worker && npx tsc --noEmit`
- `npm run lint`
- `npm run test:merge-gate`

### 4. A4 - DEX degraded-mode hardening and audit-log resilience

Why here:

- Both are isolated worker fixes with clear regression boundaries.

Implementation notes:

- Replace the fake previous-coverage sentinel with an explicit unavailable state.
- Update the DEX guard to degrade safely on missing previous coverage.
- Parse audit-log `detail_json` per row with safe fallback behavior.

Validation:

- Targeted tests for DEX orchestrator metadata and audit-log endpoint
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

### 5. A5 - Admin access wrapper cleanup

Why here:

- Small frontend cleanup with minimal dependency footprint.

Implementation notes:

- Remove or inline `src/lib/admin-access.ts`.
- Keep behavior identical.
- Update tests that were only asserting the unnecessary abstraction.

Validation:

- Targeted admin UI/hook tests if present
- `npm run lint`
- `npm run build` if Pages-impacting surface changes require it during branch development
- `npm run test:merge-gate`

### 6. B1 - Shared status metadata contract

Why before larger UI/worker refactors:

- It removes duplicated parsing in a contained way and creates a reusable contract for future status work.

Implementation notes:

- Add one shared parser/normalizer in `shared/`.
- Narrow downstream consumption gradually; do not widen the metadata contract further.
- Keep the API payload shape backward-compatible.
- Repo revalidation note: recent status degradation work already changed `shared/types/status.ts` and several admin/status surfaces. Keep this slice focused on shared cron/telegram metadata normalization and duplicated coercion removal, not a second broad rewrite of status-state contracts.

Validation:

- Add parser unit tests
- Run status component tests and worker status tests
- `npm run typecheck`
- `npm run test:merge-gate`

### 7. B2 - Expand cycle detection in report-only mode

Why before structural cleanup:

- The guardrail must exist before the cleanup work starts, but cannot block until current cycles are removed.

Implementation notes:

- Evolve `check:shared-cycles` into a broader import-cycle check or add a companion command.
- Initial behavior should report worker/src and src cycles without failing the build for already-known violations.
- Update `scripts/lib/validate-contract.mjs` and docs so the repo explains the temporary report-only state consistently across local and CI validation.

Validation:

- `npm run check:shared-cycles` or replacement command
- `npm run test:merge-gate`

Acceptance criteria:

- CI/local validation now surfaces current worker cycles explicitly.
- The repo is not yet blocked on them.

### 8. B3 - Worker cron contract foundation

Why before the large cron decompositions:

- `sync-stablecoins`, `sync-yield-data`, and `compute-dews` are all about to be split further.
- A shared contract layer gives those refactors one vocabulary for stage inputs, stage outputs, degraded states, and handoff objects.
- This captures the highest-value part of the Phase 4 worker architecture effort without forcing a big-bang rewrite.

Implementation notes:

- Introduce a small shared contract surface for cron stages, for example:
  - typed handoff/result objects
  - common degraded/error result shapes
  - naming conventions for phase modules vs helper modules
- Keep this slice no-behavior-change.
- Prefer additive modules under a shared cron contract path; do not migrate every consumer at once.
- Update `docs/architecture.md` only if the shared contract path becomes a real architectural convention worth documenting.

Validation:

- `cd worker && npx tsc --noEmit`
- Targeted cron tests for any touched subsystem
- `npm run test:merge-gate`

Acceptance criteria:

- At least one shared cron contract module exists and is adopted by the next cron refactor slices.
- Later slices (`B6`, `C2`, `C4`, `C5`) can point to this contract layer instead of inventing their own stage result shapes.
- This slice must merge before `B6`, `C2`, `C4`, and `C5`.

### 9. B4 - API keys module split

Why after A2:

- The correctness bug is already fixed, so the refactor can preserve the patched behavior.

Implementation notes:

- Extract at minimum:
  - auth/token parsing
  - rate limiting / usage accounting
  - admin store mutations
  - audit log helpers
- Keep `worker/src/lib/api-keys.ts` as a stable facade/export surface initially.
- Do not change public API response shapes in this slice.

Validation:

- Characterization tests around current public/admin key flows before extraction
- Auth/admin targeted tests after extraction
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

### 10. B5 - Contagion graph model extraction

Why independent:

- Pages-only refactor with little interaction with worker work.

Implementation notes:

- Extract graph shaping and traversal into plain TypeScript helpers.
- Keep the React component focused on interaction and rendering.
- Prefer characterization tests over visual-only assertions.

Validation:

- New helper tests
- Existing component tests if present
- `npm run build`
- `npm run test:merge-gate`

### 11. B6 - `sync-yield-data` coordinator split

Why before yield resolver decomposition:

- It shrinks the outer orchestration shell first, which makes the later resolver split more tractable.
- The shared cron contract foundation from `B3` should be reused here instead of creating yield-specific stage shapes.

Implementation notes:

- Separate:
  - cache/state loading
  - publication assembly
  - top-level orchestration
- Keep the resolver behavior unchanged in this slice.
- Add characterization fixtures around current ranking publication behavior before the split.

Docs review:

- If no published semantics change, architecture docs may be sufficient.
- If freshness or degraded-mode semantics move, update:
  - `src/app/methodology/sections/monitoring/yield-intelligence-section.tsx`
  - `docs/yield-intelligence.md`
  - `docs/yield-intelligence-operations.md`
  - `docs/yield-intelligence-timeline.md`
  - `shared/lib/yield-methodology-version.ts` only if methodology versioning is warranted

Validation:

- `worker/src/cron/__tests__/sync-yield-data.test.ts`
- `worker/src/cron/__tests__/yield-cache.test.ts`
- `npm run test:merge-gate`

### 12. B7 - Contract-driven governance checks

Why before hotspot automation:

- This turns the current manual hygiene fixes into enforceable contracts before the repo starts larger refactors.
- It captures the highest-value Phase 4 governance item without waiting for a later strategic process pass.

Implementation notes:

- Add stale-entry detection/pruning to the hotspot tooling.
- Add a repo-link validation check for the verified docs corpus: `README.md` plus `docs/**`.
- Add an env-contract verification check that compares `worker/src/lib/env.ts` against `.env.example`, and where practical against documented env names in the verified docs corpus.
- Wire the new governance checks into the validate contract so local merge-gate and CI stay aligned.
- Prefer explicit commands such as `npm run check:verified-doc-links` and `npm run check:env-contract` over burying the behavior invisibly inside unrelated checks.
- Keep the initial scope narrow to avoid false positives from historical agent notes outside the verified docs corpus.
- Repo revalidation note: current HEAD still has the wrong `README.md` env name, the wrong hotspot backlog path in `docs/testing.md`, missing `.env.example` bindings, and an unignored `worker/.next/`. This slice should treat those as fixed acceptance cases for the new checks.

Validation:

- `npm run check:verified-doc-links` and/or the final dedicated verified-doc link command
- `npm run check:env-contract` and/or the final dedicated env-contract command
- `npm run check:doc-sync`
- `npm run check:hotspot-ratchet`
- `npm run test:merge-gate`

### 13. C1 - Break the `live-reserves` import cycle

Why before making cycle checks blocking:

- `S-01` is not only `sync-stablecoins`; the `live-reserves` cycle must also be removed.

Implementation notes:

- Move shared contracts/types into a true leaf module with no runtime imports.
- Preserve current store parsing behavior.

Validation:

- Add/import-cycle-focused tests if needed
- Run the expanded cycle checker and confirm the `live-reserves` cycle is gone
- `npm run test:merge-gate`

### 14. C2 - `sync-stablecoins` phase-contract refactor

Why before provider-family extraction:

- The subsystem needs one-directional boundaries before provider modules are split out further.
- Reuse the shared cron contract layer from `B3` for phase inputs/outputs instead of inventing stablecoin-only handoff types.

Implementation notes:

- Define explicit phase inputs/outputs.
- Remove runtime back-edges between `stages`, `fallback`, `intake`, and `runtime`.
- Preserve current publish/depeg semantics.
- Add characterization coverage before moving code:
  - primary happy path
  - fallback path
  - missing-price path
  - depeg detection/confirmation path
  - cache publication path

Docs review:

- If pipeline ordering or fallback semantics change, update:
  - `src/app/methodology/sections/core-sections-pricing.tsx`
  - `docs/data-pipeline.md`
  - `docs/pricing-pipeline.md`
  - pricing timeline/changelog material if versioned

Validation:

- Existing sync-stablecoins tests plus new characterization fixtures
- Expanded cycle checker must show the `sync-stablecoins` cycle cluster removed
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

### 15. C3 - Price enrichment provider-family split

Why after C2:

- Provider passes should move only after the enclosing stablecoin pipeline boundaries are explicit.

Implementation notes:

- Split by provider family:
  - identity/shared helpers
  - DefiLlama pass
  - CoinMarketCap pass
  - DexScreener pass
  - Jupiter pass
- Preserve pass order and validation semantics exactly in this slice.
- Use golden/fixture tests to verify identical outcomes on representative coins.
- Repo revalidation note: recent pricing commits added wrapper/NAV behavior around USDAI/PYUSD and NAV-wrapper peg inheritance. The characterization baseline for this slice must include those cases, not just generic USD-pegged fallback/enrichment examples.

Docs review:

- Update pricing methodology/docs only if pass order, source precedence, or validation semantics change.

Validation:

- Targeted pricing pipeline tests
- Characterization fixtures comparing pre/post split output
- `npm run test:merge-gate`

### 16. C4 - Yield resolver family decomposition

Why after B6:

- `sync-yield-data` is already narrowed to a coordinator, so the resolver can be decomposed with less blast radius.
- Reuse the shared cron contract layer from `B3` for resolver-family outputs and degraded states.

Implementation notes:

- Split deterministic on-chain, explicit protocol, optional timed-provider, and auto-discovery families.
- Preserve arbitration and publication outcomes in this slice unless intentionally changing methodology.
- Add characterization coverage around source selection and degraded-mode behavior before moving code.

Docs review:

- If any source selection, freshness, or degraded-mode semantics change, update methodology and timeline docs listed in B6.

Validation:

- `worker/src/cron/__tests__/yield-resolve.test.ts`
- `worker/src/cron/__tests__/sync-yield-data.test.ts`
- `npm run test:merge-gate`

### 17. C5 - DEWS staged decomposition

Why after A3:

- The live correctness bug is already fixed, so the decomposition can aim for behavior preservation.
- Reuse the shared cron contract layer from `B3` for DEWS stage handoffs where it fits cleanly.

Implementation notes:

- Split:
  - source/data assembly
  - signal derivation
  - persistence/publication
- Add typed handoff objects between stages.
- Preserve methodology outputs unless intentionally changing semantics.
- Build characterization coverage from current DEWS fixtures before extraction.

Docs review:

- Same DEWS methodology docs as A3 if semantics or explanations change.

Validation:

- DEWS unit and cron tests
- Snapshot/fixture comparisons of representative DEWS outputs
- `npm run test:merge-gate`

### 18. C6 - Hotspot enrollment automation

Why late in Phase 3:

- It should land after the stale backlog is cleaned and the major in-flight decompositions are underway, so the generated inventory reflects the new state.
- It depends on the governance checks from `B7` so freshness is enforced, not just generated.

Implementation notes:

- Generate candidate enrollment from file metrics.
- Require each candidate to be enrolled, waived with rationale, or intentionally deferred.
- Keep facade/barrel handling explicit so reduced files do not stay trapped in the backlog.
- Repo revalidation note: current large omitted files now include at least `worker/src/lib/api-keys.ts`, `worker/src/cron/sync-stablecoins/enrich-prices-passes.ts`, `worker/src/cron/yield-sync/resolve.ts`, `worker/src/cron/compute-dews.ts`, `src/app/stability-index/client.tsx`, `src/components/stablecoin-detail/hero-card.tsx`, and `worker/src/cron/yield-sync/sources-optional-protocols.ts`. Candidate generation must reflect current HEAD, not only the older audit list.

Validation:

- `npm run check:hotspot-ratchet`
- Baseline update flow if required
- `npm run test:merge-gate`

### 19. C7 - Make expanded cycle checks blocking

Why last:

- Only flip the gate after `live-reserves` and `sync-stablecoins` cycles are cleared.

Implementation notes:

- Convert report-only worker/src and src cycle detection into blocking validation.
- Update CI, local merge-gate expectations, and docs.

Validation:

- Expanded cycle checker passes cleanly
- `npm run test:merge-gate`

## Verification Matrix

Every slice must define:

| Change class | Required verification |
| --- | --- |
| Worker correctness fix | targeted tests, `cd worker && npx tsc --noEmit`, `npm run test:merge-gate` |
| Pages/frontend refactor | targeted tests where present, `npm run build` when app surface changes, `npm run test:merge-gate` |
| Shared contract change | targeted tests on all consumers, `npm run typecheck`, `npm run test:merge-gate` |
| Guardrail/tooling change | run the guardrail directly, then `npm run test:merge-gate` |
| Methodology-surface change | targeted tests plus required docs/changelog/timeline review before merge |

For the large decompositions (`B4`, `B6`, `C2`, `C3`, `C4`, `C5`), add characterization fixtures before moving code. Those slices should fail review if they rely only on "existing tests still passed" without equivalence coverage.

## Rollout and Branching Model

1. Create one worktree per slice from `origin/main`.
2. Merge slices back in order.
3. After each merge into local `main`, run `npm run test:merge-gate`.
4. Push only after the merge gate passes.
5. Do not overlap slices that touch the same hotspot files unless one has fully merged first.

Recommended concurrency:

- Safe to run in parallel: `A1`, `A5`, `B5`
- Safe after `A1` lands: `B7`
- Safe after `A2` lands: `B4`
- Safe after `A3` lands: `C5`
- Safe after `B2` lands: `B3`
- Safe after `B3` lands: `B6`
- Safe after `B6` lands: `C4`
- Safe after `C2` lands: `C3`
- `B2` should land before `B3`, `C1`, `C2`, and `C7`
- `B7` should land before `C6`
- `C7` must be last in the cycle-enforcement stream

## Risks and Mitigations

| Risk | Where it applies | Mitigation |
| --- | --- | --- |
| Refactor accidentally changes public worker behavior | `B4`, `B6`, `C2`, `C3`, `C4`, `C5` | Add characterization fixtures before moving logic; keep public shapes invariant unless deliberately documented |
| Cycle check blocks the repo too early | `B2`, `C7` | Report-only first, blocking only after existing cycles are removed |
| Methodology docs drift during bug fixes | `A3`, `B6`, `C3`, `C4`, `C5` | Treat methodology docs/timelines as merge blockers when semantics move |
| Shared cron contracts become abstract-only and unused | `B3`, `B6`, `C2`, `C4`, `C5` | Keep `B3` small and require adoption by downstream refactor slices instead of a design-only drop |
| Hotspot or docs governance checks create noisy false positives | `B7`, `C6` | Scope checks to the verified docs corpus first, keep env checks contract-driven, and use waivers for justified hotspot outliers |
| Large worker PR becomes unreviewable | `C2`, `C4`, `C5` | Land characterization tests first, then refactor in a separate PR, then tighten guardrails |

## Plan Validation Loop

Validation target: fewer than one medium issue means **zero remaining medium-or-higher planning issues**.

### Iteration 1

Medium issues found:

1. The draft did not explicitly cover the non-`sync-stablecoins` worker cycle in `live-reserves`, so the expanded cycle gate would have dead-ended.
2. The draft did not state methodology-doc obligations precisely enough for DEWS and yield changes.
3. The draft did not require characterization coverage before the large refactors.

Fixes applied:

- Added dedicated slice `C1` for the `live-reserves` cycle.
- Added explicit methodology doc targets for DEWS, yield, and pricing pipeline work.
- Added characterization-test requirements to `B4`, `B6`, `C2`, `C3`, `C4`, and `C5`.

Remaining medium issues after iteration 1: 1

### Iteration 2

Medium issue found:

1. The draft still did not define the exact guardrail transition from report-only to blocking for cycle enforcement, which left the enforcement path ambiguous.

Fix applied:

- Split cycle work into `B2` report-only expansion and `C7` blocking enforcement after cleanup, with explicit acceptance criteria and ordering.

Remaining medium issues after iteration 2: 1

### Iteration 3

Medium issues found:

1. The draft misstated the number of mergeable slices, which made the delivery structure inconsistent with the actual plan.
2. The cycle-enforcement slices did not explicitly include `scripts/lib/validate-contract.mjs`, so local merge-gate integration could have drifted from the new command behavior.

Fixes applied:

- Corrected the slice count from fifteen to eighteen.
- Added `scripts/lib/validate-contract.mjs` to both the report-only and blocking cycle-enforcement slices.
- Clarified that doc-link verification scope is the verified docs corpus: `README.md` plus `docs/**`.

Remaining medium issues after iteration 3: 0

### Iteration 4

Medium issues found:

1. After pulling in the Phase 4 governance work, the plan still described the new checks conceptually rather than as explicit repo commands, which left verification and CI wiring too ambiguous.
2. The new cron contract foundation slice was positioned correctly, but the plan did not yet make it an explicit prerequisite for all downstream cron decomposition slices.

Fixes applied:

- Added explicit command-level expectations for the governance stream, using dedicated checks such as `check:verified-doc-links` and `check:env-contract`.
- Added `package.json` to the governance slice so command wiring is part of the owned change set.
- Made `B3` an explicit prerequisite for `B6`, `C2`, `C4`, and `C5`, not just an implied architectural recommendation.

Remaining medium issues after iteration 4: 1

### Iteration 5

Medium issue found:

1. The post-pull-in validation pass still needed to confirm that the updated plan remained mechanically consistent: all required finding IDs present, slice count accurate, and ordered section count matching the slice table.

Fix applied:

- Ran a mechanical consistency check over the final plan and confirmed full finding coverage, nineteen slices in the delivery table, and nineteen ordered execution sections.

Remaining medium issues after iteration 5: 0

### Iteration 6

Medium issues found:

1. The plan still relied too much on implicit team discipline for parallel execution; ownership, tranche gates, and rebase/stop conditions were not explicit enough for a multi-agent repo state.
2. The plan required characterization coverage, but it did not yet require baseline capture and go/no-go criteria before the largest refactor slices.

Fixes applied:

- Added an execution hardening addendum covering lane ownership, serialization rules, tranche gates, baseline capture expectations, stop conditions, and rebase discipline.
- Tied the tranche transition into specific prerequisite slices so the plan now has explicit go/no-go checkpoints before major structural work begins.

Remaining medium issues after iteration 6: 0

### Iteration 7

Medium issue found:

1. The execution hardening addendum reused numbered `###` headings, which made the document look like it had more ordered execution steps than it actually did and risked confusing implementers about the real slice order.

Fix applied:

- Converted the addendum subsections to titled headings without numeric step prefixes so only the ordered execution plan uses numbered `###` sections.

Remaining medium issues after iteration 7: 0

### Iteration 8

Medium issue found:

1. The tranche-gate wording could be read as blocking all later-tranche branch preparation, while the concurrency guidance intentionally allowed some later-tranche worktrees to be prepared early. That ambiguity would have created coordination friction during execution.

Fix applied:

- Clarified that tranche gates are **merge gates into `main`**, not branch-creation gates.
- Added companion execution artifacts for branch ownership, worktree naming, characterization tickets, and merge control so agents can prepare non-overlapping branches without violating the tranche merge order.

Remaining medium issues after iteration 8: 0

### Final validation result

Plan status: **Accepted**

Remaining medium-or-higher issues: **0**
