# Chains Audit Remediation Plan

Date: 2026-04-08
Repo: `/Users/ahirice/Documents/git/stablecoin-dashboard`
Related audit: [agents/audits/2026-04-08-chains-audit.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-04-08-chains-audit.md)

## Objective

Remediate every finding from the `/chains` audit with an implementation program optimized for parallel sub-agent execution while preserving data accuracy as the top priority.

This plan covers:
- live chain aggregation correctness
- chain history correctness and recoverability
- chain detail route reliability
- freshness and dependency semantics
- registry coverage and guardrails
- targeted maintainability cleanup of the chain detail implementation

This plan does not include shipping a public chain-history UI. History correctness must be repaired first so future chart work starts from a defensible baseline.

## Plan Review Status

- Review pass 1 found 2 Medium issues:
  - the history-repair fallback was still too ambiguous
  - the freshness work did not yet name the frontend test surface explicitly
- Review pass 2 found 1 Medium issue:
  - registry-invariant ownership was duplicated across two workstreams
- Review pass 3 found 0 Medium-or-higher issues

## Success Criteria

The remediation is complete when all of the following are true:

1. Every chain-analytics path that consumes raw `chainCirculating` data uses the same canonical resolver.
2. Every tracked `contracts[].chain` in stablecoin metadata resolves through `CHAIN_META` or an explicit alias, enforced by automated tests.
3. `/chains/[chain]` no longer renders mixed or silently partial data when one of its dependencies fails or lags.
4. `/api/chains` freshness semantics are internally aligned across worker, shared constants, frontend freshness handling, and docs.
5. Chain health never presents stale report-card inputs as fresh.
6. The docs and checks catch methodology-version and contract drift for the chain surface.
7. The chain detail route is materially less hotspot-prone after the correctness work lands.

## Design Rules

- Use one canonical chain normalization path: `resolveChainId()` and `canonicalizeChainCirculating()`.
- Prefer fail-closed or explicit-unavailable behavior over silent partial rendering.
- Keep API additions additive unless a simplification materially reduces split-brain risk.
- Fix guardrails in the same tranche as the behavior they protect.
- Decompose the large chain detail client only after correctness semantics are stable.

## Recommended Architecture Decisions

These decisions remove ambiguity before implementation starts:

1. `snapshot-chain-supply` should consume `canonicalizeChainCirculating()` directly instead of reimplementing normalization.
2. Registry coverage should be enforced from tracked metadata, not by manual review of `CHAIN_META`.
3. `/api/chains` should expose authoritative freshness via `_meta` in addition to headers.
4. `API_FRESHNESS_MAX_AGE_SEC.chains` should be aligned to the worker’s `600s` freshness budget.
5. `handleChains()` should cap report-card cache age. If quality inputs are stale or unavailable, the chain health composite should become unavailable rather than silently using stale grades.
6. The chain detail route should move to one coordinated data hook that owns both `/api/chains` and `/api/stablecoins` query state and explicitly rejects mixed-snapshot rendering.
7. Existing historical `chain_supply_history` data must go through a recoverability gate before any history UI is built:
   - If a safe reconstruction path exists, backfill.
   - If not, mark or purge invalid pre-fix rows and restart the series from a known-good baseline date.

## Sub-Agent Topology

## Worker Handoff Contract

Every worker should operate under the same delivery contract:

1. Stay within the declared file ownership set. If a required edit falls outside that set, hand it back to the coordinator instead of expanding scope ad hoc.
2. Deliver a patch plus the exact targeted validation commands that were run for that patch.
3. Do not update shared docs until the coordinator freezes the interface or behavior being documented.
4. If a workstream needs destructive or irreversible data repair, the worker must provide a dry-run path and rollback notes before any live write path is approved.
5. The coordinator is the only owner of cross-workstream integration commits, merge-gate runs, and rollout sequencing.

### Coordinator

The coordinator owns:
- final sequencing
- interface decisions
- merge ordering
- cross-worker conflict resolution
- full validation
- review/fix loops

The coordinator should avoid making overlapping edits while workers are active.

### Worker A: Canonicalization And Registry

Scope:
- [worker/src/cron/snapshot-chain-supply.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/snapshot-chain-supply.ts)
- [shared/lib/chain-circulating.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/chain-circulating.ts)
- [shared/lib/chains.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/chains.ts)
- `public/chains/` assets needed for new registry entries
- [worker/src/cron/__tests__/snapshot-chain-supply.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/snapshot-chain-supply.test.ts)
- [shared/lib/__tests__/chain-circulating.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/__tests__/chain-circulating.test.ts)
- [shared/lib/__tests__/chains.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/__tests__/chains.test.ts)

Primary goals:
- eliminate duplicated normalization logic
- add missing chain registry coverage, including `citrea`
- add hard invariants for tracked metadata chains

### Worker B: API Freshness And Health Dependency Semantics

Scope:
- [worker/src/api/chains.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/chains.ts)
- [worker/src/lib/report-card-cache.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/report-card-cache.ts)
- [shared/lib/api-freshness.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/api-freshness.ts)
- [src/lib/api.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts)
- [src/lib/__tests__/api-fetch-contracts.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/__tests__/api-fetch-contracts.test.ts)
- [src/hooks/__tests__/use-chains.test.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/__tests__/use-chains.test.tsx)
- [worker/src/api/__tests__/chains.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/chains.test.ts)

Primary goals:
- align freshness budgets
- make `/api/chains` freshness authoritative in the response body
- stop publishing stale report-card inputs as fresh chain health

### Worker C: Chain Detail Route Reliability

Scope:
- [src/hooks/use-chains.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-chains.ts)
- new coordinated route hook under `src/hooks/`
- [src/app/chains/[chain]/client.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/chains/[chain]/client.tsx)
- [src/app/chains/[chain]/client.test.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/chains/[chain]/client.test.tsx)

Primary goals:
- stop silent partial rendering
- coordinate both dependencies explicitly
- surface stale, error, and mismatch states clearly

### Worker D: Docs And Guardrails

Scope:
- [docs/api-reference.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md)
- [docs/chains-page.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/chains-page.md)
- [docs/architecture.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md)
- [docs/data-flow-map.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/data-flow-map.md)
- [docs/supply-snapshot.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/supply-snapshot.md)
- [scripts/check-doc-sync.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/scripts/check-doc-sync.ts)
- chain-surface tests that do not overlap Worker A or C ownership

Primary goals:
- fix current documentation drift
- make doc drift fail in CI
- remove unsafe test-shape drift on the chain surface

### Worker E: Chain Detail Decomposition

Scope:
- [src/app/chains/[chain]/client.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/chains/[chain]/client.tsx)
- [src/app/chains/[chain]/view-model.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/chains/[chain]/view-model.ts)
- new route-local or shared chain-detail presentational components

Primary goals:
- reduce hotspot size and cognitive load
- preserve behavior from Worker C exactly
- make future chain features easier to land

Worker E starts only after Worker C is merged because both touch the same route.

## Workstreams

## Workstream 1: Canonicalization And Registry Completeness

Owner: Worker A

Tasks:
- Replace the raw `CHAIN_ALIASES[rawId] ?? rawId` loop in `snapshot-chain-supply` with `canonicalizeChainCirculating()`.
- Add `citrea` to `CHAIN_META` with the required explorer/logo metadata, or add an explicit documented alias if the canonical key should differ.
- Audit the full tracked metadata set and add a test that fails when any `contracts[].chain` is not covered by `CHAIN_META` or a resolver alias.
- Add regression coverage for:
  - display-name keys like `Ethereum` and `BSC`
  - alias-plus-canonical dedupe into one chain bucket
  - unknown-chain dropping
  - snapshot aggregation through the canonical resolver

Recoverability gate:
- Inspect whether existing `chain_supply_history` can be safely repaired from retained sources.
- If recoverable, implement a repair/backfill path.
- If not recoverable, the default remediation is not “document and move on”. The coordinator must ship one of these concrete actions before closing the work:
  - purge the affected pre-fix `chain_supply_history` rows and restart the series from the remediation date, or
  - quarantine the table from all consumers and create a follow-up blocker that prevents any chain-history UI work from landing.
- Produce a concrete handoff note with the decision, exact operator steps, and baseline date so Worker D can update `docs/supply-snapshot.md` without re-investigating the data state.

Repair-safety requirements:
- export the current `chain_supply_history` rows before any destructive action
- provide a dry-run diff of repaired versus current row counts and totals
- require coordinator sign-off before purge or rewrite
- keep the repair path out of the same commit as the logic fix unless the repair can be proven reversible and dry-run safe

Deliverables:
- one normalization path
- complete registry coverage for tracked chains
- explicit historical-data decision with an executed fallback action if repair is impossible

## Workstream 2: `/api/chains` Freshness And Dependency Semantics

Owner: Worker B

Tasks:
- Align the chain freshness budget to `600s` across worker and shared constants.
- Emit `_meta` from `/api/chains` so the frontend reads worker-authoritative freshness classification instead of heuristics.
- Update `apiFetchWithMeta()` so the presence of a `Warning` header cannot leave a response classified as fresh when body `_meta` is absent.
- Apply a max-age policy to the report-card cache in `handleChains()`. Reuse the existing `2h` bound already used elsewhere unless implementation review finds a stricter live cadence is safer.
- When report-card inputs are stale or unavailable, ensure chain health becomes unavailable rather than implicitly stale-but-fresh-looking.
- Add focused tests for:
  - `_meta` extraction from `/api/chains`
  - `Warning`-header downgrade behavior when `_meta` is absent
  - the shared `useChains()` freshness contract after the `600s` alignment
- Keep the response contract additive unless a smaller surface is cleaner.

Implementation note:
- Avoid introducing a new dedicated dependency-status field unless the UI truly needs it. Prefer correct availability semantics first, then add explainers only if the generic “health unavailable” state is too ambiguous.

Deliverables:
- freshness alignment
- authoritative freshness metadata
- no hidden stale dependency in chain health

## Workstream 3: Chain Detail Route Coordination

Owner: Worker C

Tasks:
- Replace the current “one live hook plus one derived helper” arrangement with a coordinated route-level hook such as `useChainProfileData(chainId)`.
- That hook should own:
  - `/api/chains` query state
  - `/api/stablecoins` query state
  - merged loading/error states
  - merged stale-data inputs
  - snapshot-consistency checks
  - the route view model
- `useChainStablecoins()` should either become an internal helper that returns full query state or disappear in favor of the coordinated hook.
- Update the page so it no longer renders composition, backing, or the stablecoin table when the `/api/stablecoins` branch has failed.
- Feed both dependencies into `StaleDataBanner`.
- Replace the current “insufficient safety score coverage” fallback copy with wording that is also accurate when quality inputs are stale or unavailable.

Snapshot-consistency rule:
- treat the route as a coordinated snapshot only when both query payloads expose `meta.updatedAt` and the values are equal
- if one side lacks authoritative `updatedAt`, render the route as degraded rather than silently asserting consistency
- if the timestamps differ, either hold back split sections until the newer query settles or render an explicit degraded reconciliation notice; do not silently mix the two

Minimum route behavior after remediation:
- both sources loading: show route loading state
- `/api/chains` error and no data: show route error
- `/api/stablecoins` error and no usable data: show route error or route-level incomplete-data notice
- source timestamps materially diverge: do not render a mixed snapshot without an explicit degraded notice
- one source stale but usable: render with a stale banner that reflects both dependencies

Deliverables:
- no silent partial rendering
- no hidden split-brain route state
- one route-level data model

## Workstream 4: Docs And Guardrails

Owner: Worker D

Tasks:
- Update the `/api/chains` docs to the live Chain Health version and the final freshness semantics.
- Update `docs/chains-page.md` for the final detail-route data-flow contract if the route hook changes materially.
- Update `docs/architecture.md` only where the route/data-flow summary changed.
- Update `docs/data-flow-map.md` if the route moves to a coordinated hook or if `/api/chains` freshness/publication semantics change.
- Update `docs/supply-snapshot.md` with the final snapshot normalization path and the historical-data decision or baseline-date policy.
- Extend `check-doc-sync` so chain-health version drift in the public API docs fails the check.
- Add or tighten tests so fake `ChainSummary` objects cannot drift behind the runtime contract through `as unknown as` casts.
- Verify that Worker A's chain-registry invariant is enforced by the normal validation path, whether it lands as a shared test or inside `check:stablecoin-data`.

Deliverables:
- docs match runtime
- version drift caught automatically
- chain test fixtures are type-realistic

## Workstream 5: Chain Detail Decomposition

Owner: Worker E

Tasks:
- Split the 735-line chain detail client into smaller units after Workstream 3 lands.
- Extract route sections into focused components with stable props:
  - hero
  - health breakdown
  - composition
  - backing breakdown
  - stablecoin table
- Keep the view-model assembly in one place.
- Preserve the exact behavior from Workstream 3. This work is maintainability-only unless a correctness gap is discovered during extraction.

Target outcome:
- route shell plus small components instead of one hotspot client
- lower merge-conflict pressure for future chain features

## Parallel Execution Plan

### Wave 0: Coordinator Setup

Owner: Coordinator

Tasks:
- Create an execution tracker in `/agents/tasks/` if the implementation is going to span multiple branches or days.
- Lock the architecture decisions above.
- Confirm who owns the historical recoverability decision.

### Wave 1: Parallel Foundation

Run in parallel:
- Worker A: Workstream 1
- Worker B: Workstream 2

Coordinator duties during Wave 1:
- review interface changes early
- ensure no doc edits land yet if the contract is still moving
- freeze the post-Wave-1 `/api/chains` behavior contract before Worker C starts
- confirm whether Workstream 2 changed only `/chains` behavior or generic `apiFetchWithMeta()` semantics for the rest of the app

### Wave 2: Route Integration

Run after Wave 1 merges:
- Worker C: Workstream 3

Can run partly in parallel once the final interface is known:
- Worker D: Workstream 4

### Wave 3: Maintainability Cleanup

Run after Workstream 3 merges:
- Worker E: Workstream 5

### Wave 4: Full Validation And Release Readiness

Owner: Coordinator

Tasks:
- run the full verification set
- run review/fix loops
- decide the `chain_supply_history` rollout action if a repair path is not available

## Validation Matrix

### Per-Workstream Validation

Workstream 1:
- targeted shared tests
- targeted worker cron tests
- any new registry invariant test or `check:stablecoin-data` coverage added by Worker A

Workstream 2:
- `worker/src/api/__tests__/chains.test.ts`
- `src/lib/__tests__/api-fetch-contracts.test.ts`
- `src/hooks/__tests__/use-chains.test.tsx`
- any additional freshness/meta tests touched by the API helper changes

Workstream 3:
- `[chain]/client` tests
- hook tests for the coordinated route data model
- local UI smoke of `/chains/` and `/chains/[chain]/`
- at least one explicit test or smoke path for mixed-snapshot rejection / degraded notice behavior

Workstream 4:
- `npm run check:doc-sync`
- `npm run check:stablecoin-data` if the registry invariant lands there
- any added invariant or fixture-contract tests

Workstream 5:
- route tests
- build smoke

### Final Validation Gate

Run before considering the remediation complete:

```bash
npm test
npm run lint
npm run build
npm run seo:check
cd worker && npx tsc --noEmit
npm run check:doc-sync
npm run check:stablecoin-data
npm run test:merge-gate
```

If any workstream changes deploy-impacting code paths, do not skip the merge gate.

In addition to the command gate above, the coordinator should run a direct route sanity pass on:
- `/chains/`
- one large canonical chain such as `/chains/ethereum/`
- the newly added or repaired edge-case chain route, if applicable

## Review Loop

Every implementation wave should go through the same review loop:

1. sub-agent review focused on correctness and data-loss risk
2. sub-agent review focused on maintainability and integration risk
3. fix findings
4. rerun targeted validation
5. repeat until the review returns no High issues and fewer than 1 Medium issue

The same threshold applies to this plan itself before implementation starts.

## Key Risks And Mitigations

Risk: history repair is not reconstructable from retained data.
Mitigation: treat repair as a hard gate with a purge-or-rebuild decision before any history UI is exposed.

Risk: freshness changes alter generic frontend behavior outside `/chains`.
Mitigation: prefer additive `_meta` on `/api/chains`; keep generic `Warning` downgrade logic narrow and test-covered.

Risk: route coordination work and decomposition work conflict heavily.
Mitigation: do not run Worker E until Worker C is integrated.

Risk: new registry invariants fail on more chains than `citrea`.
Mitigation: treat that as useful discovery, not scope creep. Fix the registry comprehensively in Workstream 1.

## Done Definition

The remediation is done when:
- the five workstreams above are complete
- the final validation gate passes
- the latest review loop returns zero Medium-or-higher findings
- the historical `chain_supply_history` recoverability decision is documented and executed
