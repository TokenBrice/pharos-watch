# Wrapper / Staked Variant Framework Follow-Up Implementation Plan

Date: 2026-04-22
Status: Review-pass candidate after iterative reviewer loop
Baseline: `60bf859e`, `fc59649e`, `a9a58eb0`, `7d664812`, `a2b8547f`

## Goal

Finish the second wave of the wrapper / staked variant framework by extending the shipped parent/child model into the remaining high-value product, runtime, and documentation surfaces without reopening settled v1 contracts accidentally.

This plan covers all six follow-up candidates:

1. Graph-consumer parity
2. Yield-ownership cleanup + migration tooling
3. Alert/source-cache hardening
4. Variant information architecture
5. Broaden the framework beyond the two shipped kinds
6. Metadata / SEO / social parity

## Current shipped baseline

The repo now has:

- canonical `variantOf` / `variantKind` metadata and validation for the 9 in-scope tracked wrappers
- variant-aware dependency edges in report cards and dependency graph generation
- parent overall caps and stress recomputation support
- tracked-wrapper yield ownership moved off the affected parent ids and onto the tracked children
- parent/child relationship treatment on stablecoin detail pages and the homepage table/filter bar
- methodology/version/doc updates for the shipped v1 scope

Still missing are broader graph-consumer parity, stronger operational hardening, richer discovery/navigation, and the next semantic layer for non-simple NAV / strategy products.

## Non-negotiable rollout rules

- Do **not** ship all six buckets in one PR.
- Matching docs, version sources, timeline docs, `/methodology` copy, API examples, generated public API artifacts, and route-inventory docs move in the same PR as the behavior change. There is no doc catch-up phase.
- The current shipped yield-history contract for the five affected parent ids remains authoritative throughout this program:
  - parent-side wrapper rows are filtered immediately at read time
  - parent-side wrapper rows are purged on the hourly yield sync path
  - any retention/cutoff alternative is out of scope unless a separate pre-work spec explicitly changes the public contract and bumps the methodology/docs first
- Destructive cleanup must be operator-run, not cron-run.
- Code rollback is not data rollback. Any destructive data phase must define a separately restorable D1 artifact and a tested restore drill.
- Phase 4 is capped to:
  - one spec-only PR first
  - one implementation PR for at most one new semantic family

## Recommended PR order

This is the default order. Parallelism is allowed only when it does not change rollout safety assumptions.

1. **PR 1 / Phase 1**: Graph-consumer parity
2. **PR 2 / Phase 2A.1**: Yield read-path hardening
3. **PR 3 / Phase 2A.2a**: Alert-source backend/API hardening
4. **PR 4 / Phase 2A.2b**: Alert-source admin/status UI parity
5. **PR 5 / Phase 3A**: Variant IA spec-only checkpoint
6. **PR 6 / Phase 2B**: Yield cleanup tooling + controlled mutation rollout
7. **PR 7 / Phase 3B**: Variant browse/discovery implementation + metadata / SEO parity
8. **PR 8 / Phase 4A**: Post-v1 semantic expansion spec matrix
9. **PR 9 / Phase 4B**: One-family implementation from the approved spec

Reason:

- Phase 1 closes correctness gaps on already-live graph consumers without broadening into discovery semantics.
- Phase 2A.1 ships leak-prevention readers before any destructive cleanup.
- Phase 2A.2 is split so the backend/API contract lands before admin/status UI parity consumes it.
- Phase 3A is the stop/go checkpoint for browse/discovery ownership before any public browse implementation ships.
- Phase 2B performs operational cleanup only after safe readers and alert visibility are live, and before the program can be considered operationally complete.
- Phase 3B delivers the first user-visible browse/discovery improvement after the cleanup lane is no longer easy to defer.
- Phase 4A is the stop/go checkpoint for methodology expansion.
- Phase 4B is the only implementation step for new semantic families and remains deliberately narrow.

## Assumptions

- The current 9 v1 tracked variants remain the canonical shipped baseline.
- `variantOf` continues to mean “true tracked parent stablecoin”, not generic dependency.
- The current parent-cap rule remains:
  - cap only when parent overall score is non-null
  - skip the cap when parent is unrated
- The current `navToken` and `pegReferenceId` semantics remain unchanged unless Phase 4B explicitly expands them.
- Multiple PRs are acceptable and preferred.

## Success criteria

At the end of the full follow-up program:

- `/dependency-map`, coverage dependency status, and any shared dependency fallback paths all consume the same variant-aware edge semantics as the canonical shared edge builder and remain API-parity-checked against `/api/report-cards.dependencyGraph`.
- No parent stablecoin continues to expose child-owned savings-wrapper APY history through `/api/yield-history` for:
  - `usde-ethena`
  - `usds-sky`
  - `dai-makerdao`
  - `frxusd-frax`
  - `crvusd-curve`
- The 5-minute Telegram alert lane depends on an explicit live-card source contract with observable degraded-mode behavior in:
  - cron metadata
  - `/api/status`
  - `/api/health` where relevant freshness/degraded state is surfaced
  - ops/admin surfaces that summarize cron status
- Users can discover tracked variants through exactly one named primary browse entry point beyond the current detail-page treatment.
  Default assumption for this program: the existing homepage stablecoin table plus durable variant filter state is the primary owner unless the approved IA spec proves that is insufficient.
- OG, JSON-LD, metadata, API docs, public route inventory docs, and sitemap ownership are consistent with the shipped variant model and current methodology versions.
  `docs/README.md` is the canonical owner for public route inventory/crawl policy updates when browse-route ownership changes.
- For post-v1 variant semantics, the repo ends in one of two states:
  - exactly one new semantic family is implemented with methodology/docs/tests, plus matching yield-side updates if that family changes yield ownership or `/api/yield-history`
  - all candidate non-v1 families remain explicitly deferred behind a reviewed spec matrix with named non-goals

## Per-PR exit gate

Every implementation PR in this program must pass the relevant subset of:

1. `npm run check:stablecoin-data`
2. `npm run lint`
3. `npm run typecheck`
4. `npm test`
5. `npm run coverage:critical` when the diff is deploy-impacting
6. `npm run typecheck:worker-scripts` when worker-bound support tooling moves
7. `cd worker && npx tsc --noEmit`
8. `cd worker && npx tsc --noEmit -p tsconfig.scripts.json`
9. `npm run check:migrations` when D1 mutation logic, migrations, or worker-bound cleanup tooling move
10. `npm run check:sql-safety` when D1 statements or mutation tooling move
11. `npm run build` when indexable/frontend/metadata routes move
12. `npm run seo:check` when indexable/frontend/metadata routes move
13. `npm run check:doc-sync` whenever methodology versions, thresholds, or canonical docs move
14. `npm run check:openapi` when public API contract/docs move
15. `npm run check:postman` when public API contract/docs move
16. `npm run check:llms-txt` when crawlable route ownership or route inventory moves
17. refresh markdown fixtures under `scripts/__tests__/fixtures/markdown/` when `/methodology`, changelog, or detail-page markdown output changes
18. `npm run test:merge-gate`
19. deploy-stage `npm run test:smoke-api` for API-affecting PRs
20. deploy-stage `npm run test:smoke-ui` / `npm run test:smoke-ops` when the PR changes public host behavior, operator visibility, or indexable route ownership
21. deploy-stage `npm run test:smoke-transport` when the PR changes public/ops host or transport routing behavior

The per-PR exit gate above is the authoritative rollout bar. The final validation section below is an additional full-program overlay, not a weaker replacement for the enforced gate.

## Phase 1 — Graph-Consumer Parity

### Goal

Make graph consumers use the same variant-aware synthetic wrapper edges already used by report cards, without bundling in broader discovery semantics.

### In scope

- dependency-map page and shared graph/layout logic
- coverage-page dependency presence / dependency-map feature status
- any shared fallback still deriving dependency edges directly from static reserves

### Explicitly out of scope

- compare peer suggestions
- related stablecoin heuristics
- command-palette grouping
- new browse routes

### Primary files

- `src/app/dependency-map/client.tsx`
- `src/app/dependency-map/client.test.tsx`
- `src/lib/contagion-layout.ts`
- `src/lib/__tests__/contagion-layout.test.ts`
- `src/lib/coverage.ts`
- `src/lib/__tests__/coverage.test.ts`
- `shared/lib/dependency-graph.ts`
- `shared/lib/__tests__/dependency-graph.test.ts`
- `worker/src/api/__tests__/report-cards.test.ts`
- `docs/dependency-map.md`
- `docs/coverage-page.md`
- `docs/api-reference.md`

### Tasks

- Replace reserve-only dependency derivation in graph consumers with the canonical shared variant-aware edge builder.
- Keep the frontend/runtime logic parity-checked against `/api/report-cards.dependencyGraph`.
- Audit fallback paths that still call `buildDependencyGraphEdges(ACTIVE_STABLECOINS)` and ensure those fallbacks remain variant-aware and documented.
- Keep wrapper-edge semantics visually distinct so parity does not turn into graph clutter.
- Add regression coverage for:
  - parent -> child synthetic wrapper edge visibility
  - stable layout totals after the extra synthetic edges
  - no duplicate parent edge when reserves already point at the same tracked parent
  - API snapshot / fallback semantic parity where relevant

### Phase 1 docs/version obligations

- Update `docs/dependency-map.md`, `docs/coverage-page.md`, and `docs/api-reference.md` where dependency-edge semantics change.

### Phase 1 checkpoint

- `npm test -- shared/lib/__tests__/dependency-graph.test.ts`
- `npm test -- worker/src/api/__tests__/report-cards.test.ts`
- `npm test -- src/app/dependency-map/client.test.tsx`
- `npm test -- src/lib/__tests__/contagion-layout.test.ts`
- `npm test -- src/lib/__tests__/coverage.test.ts`
- `npm run build`
- `npm run seo:check`
- `npm run test:merge-gate`

## Phase 2A.1 — Yield Read-Path Hardening

### Goal

Ship safe runtime read behavior first, before any destructive cleanup.

### Primary files

- `worker/src/cron/yield-sync/history.ts`
- `worker/src/api/yield-history.ts`
- `worker/src/api/__tests__/yield-history.test.ts`
- `docs/yield-intelligence.md`
- `docs/yield-intelligence-timeline.md`
- `docs/api-reference.md`
- `shared/lib/yield-methodology-version.ts`
- `src/app/methodology/sections/monitoring/yield-intelligence-section.tsx`

### Tasks

- Lock to the already-shipped contract:
  - parent-side wrapper rows for the five affected parent ids are not served
  - no retention/cutoff alternative is explored in this phase
- Tighten the read path so parent ids cannot leak child-owned rows through alternative source keys.
- Add explicit docs/API disclosure of the discontinuity and ownership handoff.
- Treat the read-path tightening as an unconditional yield-methodology/timeline update because it changes public `/api/yield-history` behavior for parent ids.
- Bump `shared/lib/yield-methodology-version.ts` numerically in this phase, not implicitly.

### Phase 2A.1 docs/version obligations

- Update:
  - `shared/lib/yield-methodology-version.ts`
  - `docs/yield-intelligence.md`
  - `docs/yield-intelligence-timeline.md`
  - `docs/api-reference.md`
  - `src/app/methodology/sections/monitoring/yield-intelligence-section.tsx`

### Phase 2A.1 checkpoint

- `npm test -- worker/src/api/__tests__/yield-history.test.ts`
- explicit `mode=source` / `?sourceKey=` regressions for the five affected parent ids
- `npm run check:openapi`
- `npm run check:postman`
- `npm run check:doc-sync`
- `npm run test:merge-gate`

## Phase 2A.2 — Alert Source-Cache Hardening

### Goal

Make the alert source-cache failure mode explicit and operator-visible on the real 5-minute Telegram alert lane.

### Contract decision

This phase locks the contract:

- the alert source cache is **hard-required** for live safety alert generation
- if the cache is missing, corrupt, stale, or from the wrong generation, the alert lane enters degraded mode for safety alerts instead of silently falling back
- safety-alert evaluation must stay suppressed until `publish-report-card-cache` has published at least one fresh source snapshot under the current generation after deploy/config change
- freshness is generation-aware, not only age-aware:
  - the source snapshot must carry a generation marker / config fingerprint / equivalent deploy-aware marker
  - the dispatcher must not treat a pre-change snapshot as valid solely because it is recent
  - the persisted prior safety snapshot used for diffing must also be generation-aware and must be reseeded/invalidated on generation changes before live alerts resume
- stale threshold is fixed in this phase:
  - `stale` after 2 producer intervals without a fresh generation-valid source snapshot
  - if the producer remains unhealthy past that window, safety alerts stay suppressed and the operator path escalates through status/ops surfaces
- exact status fields are locked in this phase:
  - `safetyAlertSourceState` (`ok` / `missing` / `corrupt` / `stale` / `wrong-generation`)
  - `safetyAlertSourceAgeSeconds`
  - `safetyAlertsSuppressed`
  - `safetyAlertSourceGeneration`

### Delivery split

This phase is implemented in two PRs:

- **Phase 2A.2a / PR 3**: backend/API contract, scheduler sequencing, and operator-visible API/status surfacing
- **Phase 2A.2b / PR 4**: admin/status UI parity that consumes the finalized API/status contract

### Primary files

- `worker/src/lib/alert-safety-source-cache.ts`
- `worker/src/cron/publish-report-card-cache.ts`
- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/cron/telegram-alert-snapshots.ts`
- `worker/src/handlers/scheduled/quarter-hourly.ts`
- `worker/src/handlers/scheduled/five-minute-telegram.ts`
- `worker/src/__tests__/index.scheduled.test.ts`
- `shared/types/status.ts`
- `worker/src/lib/status/*`
- `worker/src/api/status.ts`
- `worker/src/api/health.ts`
- `worker/src/api/__tests__/status.test.ts`
- `worker/src/api/__tests__/health.test.ts`
- `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`
- `worker/src/cron/__tests__/telegram-alert-snapshots.test.ts`
- `src/app/admin/**`
- `src/components/status/**`
- `docs/telegram-alerts.md`
- `docs/status-dashboard.md`
- `docs/api-reference.md`
- `docs/worker-infrastructure.md`
- `docs/data-flow-map.md`
- `docs/worker-and-api-limits.md`

### Tasks

- Define first-run / bootstrap behavior for:
  - missing prior alert snapshots
  - missing/corrupt source cache
  - backfilled or repaired source cache after deploy
- Prevent fallback code from rewriting the daily-history-derived snapshot as if it were a valid live source snapshot.
- Ensure degraded/stale/skipped source-cache states are visible to operators through:
  - `/api/status`
  - `/api/health` where relevant freshness/degraded state is surfaced
  - ops proxy surfaces
  - `/admin/` UI surfaces that already summarize cron/status metadata
- Add producer-path coverage for the source-cache writer:
  - cache write success
  - cache write failure/degraded behavior
  - stale metadata handling
  - no invalid fallback rewrite behavior

### Phase 2A.2 docs/version obligations

- Update:
  - `docs/telegram-alerts.md`
  - `docs/status-dashboard.md`
  - `docs/api-reference.md`
  - `docs/worker-infrastructure.md`
  - `docs/data-flow-map.md`
  - `docs/worker-and-api-limits.md`

### Phase 2A.2 checkpoint

- `npm test -- worker/src/cron/__tests__/publish-report-card-cache.test.ts` (new) covering producer-side source-cache write success/failure/stale handling
- `npm test -- worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`
- `npm test -- worker/src/cron/__tests__/telegram-alert-snapshots.test.ts`
- `npm test -- worker/src/__tests__/index.scheduled.test.ts` with explicit producer -> consumer fan-out coverage for:
  - missing/stale/wrong-generation source snapshot => safety alerts suppressed
  - fresh publish under the current generation => safety alerts resume on the next consumer tick
- `npm test -- worker/src/api/__tests__/status.test.ts worker/src/api/__tests__/health.test.ts`
- `npm test -- src/app/admin/__tests__/client.test.tsx`
- `npm test -- src/components/status/__tests__/cron-metadata-summary.test.ts`
- required sequencing harness:
  - local scheduled harness via the existing scheduled-entrypoint/manual-trigger path
  - seed a recent but pre-change source snapshot
  - verify `wrong-generation` suppression
  - verify alerts resume only after a fresh producer publish under the new generation
- optional deployed non-prod replay only if a cron-enabled non-production environment exists; do not assume the standard HTTP-smoked candidate preview can exercise cron behavior
- `npm run check:openapi`
- `npm run check:postman`
- `npm run check:doc-sync`
- `npm run test:merge-gate`

## Phase 3A — Variant IA Spec Checkpoint

### Goal

Lock the browse/discovery IA before any public browse implementation ships.

### Decision model

Eligible existing owners for this program:

1. the existing homepage stablecoin table plus durable variant filter state
2. the existing `/stablecoins/` browse hub

New surfaces are exceptions, not peers:

3. first-class indexable dedicated variant route family
4. dedicated but non-indexable browse surface, with detail/homepage hubs linking into it

Exception rule:

- do not approve a new dedicated surface unless the IA spec documents why both existing surfaces fail on product, navigation, or crawlability grounds
- command-palette changes are optional parity work, not a route-ownership driver

### IA spec requirements

Write a short reviewed IA spec in `agents/specs/` that:

- compares the two existing owner candidates and selects one
- if a new dedicated surface is proposed, documents why both existing candidates fail and why the chosen exception is safer
- defines selection criteria
- names the owning browse surface
- names the persistent user-visible browse entry point
- defines the durable URL/query-state contract for that owning browse surface
- treats the chosen owner as v1-only for this phase; Phase 4A can later decide whether that owner extends to post-v1 families
- locks sitemap ownership
- locks JSON-LD / OG ownership
- locks `llms.txt` / public route-inventory ownership
- locks how filtered states on the owning surface are treated for canonical / `noindex` / sitemap purposes
- defines UX acceptance for the owning browse surface:
  - a normal user can discover tracked variants from the owning entry point
  - parent/sibling context is understandable from that surface
  - the resulting browse state is durable and shareable/bookmarkable
- defines secondary-surface behavior for:
  - homepage modules
  - detail-page hubs
  - command palette only if needed
- defines which non-owning routes/pages are canonicalized or `noindex`

### Phase 3A checkpoint

- reviewed IA spec in `agents/specs/`
- explicit owning browse surface selected
- explicit non-owning route/page behavior selected (`canonical` / `noindex` / link-only)
- explicit route/query-state contract for the owner recorded in the spec
- no implementation PR until the IA spec is approved

## Phase 3B — Variant Browse/Discovery Implementation And Metadata Parity

### Goal

Ship one owning browse/discovery surface and only the minimum supporting parity required for launch.

### Primary files

- `src/app/**`
- `src/app/sitemap.ts`
- `src/lib/json-ld.ts`
- `src/components/homepage-client.tsx`
- `src/components/stablecoin-detail/*`
- `src/app/stablecoins/**`
- `docs/homepage.md`
- `docs/stablecoin-detail-page.md`
- `docs/architecture.md`
- `docs/README.md`
- `docs/api-reference.md`

### Tasks

- Implement only the chosen IA shape.
- Ship exactly one owning browse surface in this phase.
- Audit existing homepage/detail variant affordances first and demote any peer browse flows into secondary pointers into the owner.
- Add only the minimum supporting parity required for launch:
  - explicit “view parent / view siblings / view variants” discovery affordances where appropriate
  - homepage/detail entry links if required by the chosen browse surface
- Treat command-palette changes as follow-on parity unless the approved IA spec makes them required for launch.

### Phase 3 docs/version obligations

- Update `docs/homepage.md`, `docs/stablecoin-detail-page.md`, `docs/architecture.md`, `docs/README.md`, and `docs/api-reference.md` where route ownership changes.

### Phase 3 checkpoint

- `npm test -- src/components/homepage-client.test.tsx`
- `npm test -- src/app/stablecoin/[id]/client.test.tsx`
- `npm test -- src/hooks/__tests__/use-command-palette-history.test.ts` if command-palette behavior changes
- `npm test -- src/__tests__/page-metadata.test.ts`
- `npm test -- worker/src/api/__tests__/og.test.tsx`
- explicit JSON-LD assertion coverage for the owning browse surface and any non-owning alternates
- explicit sitemap assertion coverage for the chosen IA shape, including `src/app/sitemap.ts` ownership expectations
- explicit canonical / `noindex` verification for every non-owning alternate route/page surface introduced by the chosen IA shape
- direct route/UI regression coverage for the owning browse surface itself
- if the owner is `/stablecoins/**`, add explicit route-level coverage there rather than relying only on homepage/detail tests
- `npm run check:llms-txt` when route ownership changes
- `npm run build`
- `npm run seo:check`
- `npm run test:merge-gate`

## Phase 2B — Yield Cleanup Tooling And Controlled Mutation Rollout

### Goal

Execute the operational cleanup only after Phase 2A.1 readers are live and verified.

### Execution surface

Phase 2B uses an **operator-run script**, not a scheduled job.

### Rollout owner and rehearsal model

- Owner: the operator performing the rollout during a normal deploy window
- Rehearsal target: a bounded local/throwaway D1 dataset populated from an export of the affected `yield_history` rows; do **not** assume a separate pre-provisioned remote non-prod D1 database exists
- If API-level rehearsal checks are used, the rehearsal seed must also include the supporting `cache['yield-rankings']` row and the recent `cron_runs` metadata needed for `/api/yield-history` freshness logic
- Production execution: only after the bounded rehearsal and public-read verification both pass

### Primary files

- small shared helper under `worker/src/lib/` for the canonical suppression map / row selection logic, if needed
- new operator-run script under `worker/scripts/`
- `worker/scripts/__tests__/yield-history-cleanup.test.ts` (new)
- `docs/yield-intelligence-operations.md`
- `docs/deployment-process.md`
- `docs/scripts.md`

### Tasks

- Reuse the exact same suppression map/predicate as the live read/write path; do not create a second cleanup contract.
- Build a one-shot cleanup tool for the five affected parent ids:
  - `usde-ethena`
  - `usds-sky`
  - `dai-makerdao`
  - `frxusd-frax`
  - `crvusd-curve`
- Require:
  - dry-run inventory
  - explicit pre-run restorable artifact:
    - a bounded row export/snapshot for the targeted parent/source rows used for rehearsal, plus
    - an operator-owned D1 backup/export artifact for the real production window
    - retention of that artifact until post-cleanup verification and the next hourly sync verification both pass, with a minimum 7-day retention window unless the ops runbook says otherwise
  - named rehearsal dataset and operator owner
  - an explicit restore drill on the rehearsal dataset before any production mutation
  - before/after row-count verification
  - rollback path
  - explicit operator sign-off step
  - the script defaults to non-destructive mode and requires an explicit execute/confirm flag for production mutation
- Serialize the cleanup against the live hourly yield publisher:
  - no concurrent writer during the cleanup window
  - required mechanism: explicit writer pause/guard for the cleanup window, verified through the current `sync-yield-data` lease/status path or an equivalent checked contract
  - abort immediately if the current lease/status check shows an active `sync-yield-data` run or the writer pause/guard is not active
- Use a deploy-safe order:
  1. ship read-path leak prevention
  2. deploy and verify public reads
  3. run dry-run inventory
  4. create the restorable artifact
  5. rehearse on the bounded local/throwaway D1 dataset
  6. execute the restore drill end to end on that rehearsal dataset:
     - import the exported rows into the rehearsal dataset
     - run the cleanup
     - restore the rows from the artifact
     - prove the row counts and API responses return to the pre-cleanup state
  7. execute bounded mutation/backfill in production
  8. verify exact row counts and API responses before/after
  9. run the next hourly `sync-yield-data` cycle or an equivalent targeted verification and confirm the rows do not reappear

### Required verification queries / checks

- exact parent/source row counts for the five affected parent ids before and after execution
- `GET /api/yield-history?stablecoin=<parent>` returns no child-owned savings-wrapper rows afterward
- source-specific `GET /api/yield-history?stablecoin=<parent>&mode=source&sourceKey=<affected-key>` queries return no child-owned rows afterward
- child ids still return the expected current/best rows
- targeted automated rehearsal checks for the five parent ids plus child/source-key cases; do not rely on generic `smoke-api` alone
- explicit post-`sync-yield-data` verification so the next hourly writer does not reintroduce the rows
- saved evidence of the restore drill, including row counts and API outputs before cleanup, after cleanup, and after restore

### Phase 2B docs obligations

- Update `docs/yield-intelligence-operations.md` with the execution runbook.
- Update `docs/deployment-process.md` if the cleanup becomes part of the release checklist.
- Update `docs/scripts.md` for the new operator-run entrypoint.
- Store the dry-run inventory, restore-drill evidence, and operator sign-off record under `/agents/` as part of the rollout record.
- Do not change the public history contract here unless Phase 2A.1 already versioned and documented it.

### Phase 2B checkpoint

- `npm test -- worker/scripts/__tests__/yield-history-cleanup.test.ts`
- `npm run typecheck:worker-scripts`
- `npm run check:migrations`
- `npm run check:sql-safety`
- targeted rehearsal validation for the affected parent/child ids, including explicit before/after/restore evidence
- explicit restore-drill signoff on the rehearsal dataset
- `npm run test:merge-gate`

## Phase 4A — Post-V1 Semantic Expansion Spec Matrix

### Goal

Define the next methodology layer for deferred non-v1 products before any code ships.

### Candidate semantic families

- strategy-vault products
- bond / maturity wrappers
- anchor-asset vaults over USDC / USDT
- fair-value / NAV products whose stability should not be modeled as a simple parent peg

### Candidate assets

- `susdai-usd-ai`
- `msy-main-street`
- `stcusd-cap`
- `said-gaib`
- `yusd-yieldfi`
- `syrupusdc-maple`
- `syrupusdt-maple`
- `busd0-usual`
- `sbold-k3-capital`

### Tasks

- Create a spec that maps each deferred asset to:
  - semantic family
  - intended peg treatment
  - dependency semantics
  - overall-cap semantics
  - yield ownership semantics
  - UI labeling
  - explicit non-goals
- Choose exactly one family as the candidate for Phase 4B.

### Spec acceptance checklist

- family definitions are mutually exclusive
- each deferred asset is assigned to one family or explicitly deferred again
- peg/dependency/overall-cap/yield/UI rules are written per family
- named non-goals are explicit
- required methodology/version/doc surfaces are listed for the implementation PR

### Phase 4A checkpoint

- reviewed spec in `agents/specs/`
- explicit stop/go decision on whether any family is ready for implementation

## Phase 4B — One-Family Implementation From The Approved Spec

### Goal

Implement exactly one new semantic family from the approved Phase 4A spec.

### Primary files

- `shared/data/stablecoins/*.json`
- `shared/types/core.ts`
- `shared/types/report-cards.ts`
- `shared/lib/stablecoins/schema.ts`
- `shared/lib/stablecoins/validate-variants.ts`
- `shared/lib/stablecoins/variants.ts`
- `shared/lib/report-card-dependency.ts`
- `shared/lib/report-card-overall.ts`
- `shared/lib/report-card-peg-liquidity.ts`
- `shared/lib/safety-score-version-data.ts`
- `shared/lib/yield-methodology-version.ts` when yield ownership/public yield behavior changes
- `docs/stablecoin-data.md`
- `docs/classification.md`
- `docs/api-reference.md`
- `docs/report-cards.md`
- `docs/report-cards-timeline.md`
- `docs/yield-intelligence.md` when yield ownership/public yield behavior changes
- `docs/yield-intelligence-timeline.md` when yield ownership/public yield behavior changes
- `src/app/methodology/page.tsx`
- `src/app/methodology/sections/core/safety-scores-section.tsx`
- `src/app/methodology/sections/monitoring/yield-intelligence-section.tsx` when yield ownership/public yield behavior changes
- `src/app/methodology/scoring-changelog/*`

### Phase 4B docs/version obligations

- Update the exact canonical version surfaces in the same PR:
  - `shared/lib/safety-score-version-data.ts`
  - `shared/types/report-cards.ts`
  - `docs/api-reference.md`
  - `docs/report-cards.md`
  - `docs/report-cards-timeline.md`
  - `docs/stablecoin-data.md`
  - `docs/classification.md`
  - `/methodology` copy under `src/app/methodology/`
  - scoring changelog route content under `src/app/methodology/scoring-changelog/`
- Treat Phase 4B as an unconditional Safety Score methodology version bump with a numeric increment plus matching timeline/changelog updates.
- If the approved family changes yield ownership or public yield behavior, also update in the same PR:
  - `shared/lib/yield-methodology-version.ts`
  - `docs/yield-intelligence.md`
  - `docs/yield-intelligence-timeline.md`
  - `docs/api-reference.md`
  - `/methodology` yield copy under `src/app/methodology/sections/monitoring/yield-intelligence-section.tsx`
  - yield-history and ranking tests that cover the changed contract

### Phase 4B checkpoint

- targeted scoring tests before broader integration
- `npm run check:stablecoin-data` when metadata turns on a new family
- `npm test -- shared/lib/stablecoins/__tests__/variants.test.ts`
- `npm test -- shared/lib/__tests__/report-cards.test.ts`
- `npm test -- worker/src/lib/__tests__/report-cards-snapshot.test.ts`
- `npm test -- worker/src/api/__tests__/report-cards.test.ts`
- `npm test -- src/app/methodology/scoring-changelog/content.test.tsx`
- `npm run check:openapi`
- `npm run check:postman`
- targeted taxonomy/registry validation for the chosen family
- refresh markdown fixtures under `scripts/__tests__/fixtures/markdown/` when `/methodology`, changelog, or detail-page markdown output changes
- `npm run check:doc-sync`
- `npm run test:merge-gate`

## Suggested PR breakdown

### PR 1

- Phase 1 graph-consumer parity
- matching dependency-map / coverage / API docs

### PR 2

- Phase 2A.1 yield read-path hardening only
- matching yield docs and version/timeline updates

### PR 3

- Phase 2A.2a alert-source backend/API hardening only
- source-cache contract, scheduler sequencing, and operator-visible API/status surfacing

### PR 4

- Phase 2A.2b admin/status UI parity only
- consumes the finalized alert-source API/status contract

### PR 5

- Phase 3A IA spec-only checkpoint

### PR 6

- Phase 2B cleanup tool + runbook only
- no public contract change beyond the already-shipped purge model

### PR 7

- Phase 3B chosen IA implementation
- metadata / JSON-LD / OG / sitemap parity

### PR 8

- Phase 4A spec matrix only

### PR 9

- Phase 4B implementation of exactly one semantic family

## Final validation set

Minimum full-program validation:

1. `npm run check:stablecoin-data`
2. `npm run lint`
3. `npm run typecheck`
4. `npm test`
5. `npm run coverage:critical`
6. `npm run typecheck:worker-scripts`
7. `cd worker && npx tsc --noEmit`
8. `cd worker && npx tsc --noEmit -p tsconfig.scripts.json`
9. `npm run check:migrations`
10. `npm run check:sql-safety`
11. `npm run build`
12. `npm run seo:check`
13. `npm run check:doc-sync`
14. `npm run check:openapi`
15. `npm run check:postman`
16. `npm run check:llms-txt` when route ownership or crawlable route inventory changes
17. `npm run test:merge-gate`
18. deploy-stage `npm run test:smoke-api` for API-affecting PRs
19. deploy-stage `npm run test:smoke-ui` / `npm run test:smoke-ops` when the affected PR changes public host behavior, operator visibility, or route ownership
20. deploy-stage `npm run test:smoke-transport` when the affected PR changes public/ops host or transport routing behavior

## Recommendation

If only one follow-up PR is approved next, do this:

1. Phase 1 graph-consumer parity only

That is the highest-signal next PR because it closes correctness gaps across already-live graph consumers without combining rollout-sensitive cleanup or broader IA/methodology work.
