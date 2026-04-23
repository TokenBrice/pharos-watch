# Alt-Pegs Execution Plan v2

Date: 2026-04-23

Revises:

- [Original execution plan](/home/ahirice/Documents/git/stablecoin-dashboard/agents/2026-04-23-alt-pegs-execution-plan.md)
- [Validation memo](/home/ahirice/Documents/git/stablecoin-dashboard/agents/2026-04-23-alt-pegs-execution-plan-validation.md)

Status:

- Revised implementation plan
- Ready to execute after the contract decisions in Checkpoint 0 are accepted

## Why This Revision Exists

The original plan was directionally right, but the validation pass found four recurring problems:

1. It left the most user-visible chart fixes too late.
2. It treated `fiat non-USD` as cleaner than the current data contract really is.
3. It made Release 3 too broad and under-specified.
4. It did not name enough repo-specific validation and rollout requirements.

This v2 plan keeps the overall strategy, but it rebalances the releases and makes the key contracts explicit before implementation starts.

## Scope Decision

This plan still treats the following as the mainline work:

1. Reduce trust friction in the historical views.
2. Make chart units, denominators, provenance, and coverage explicit.
3. Make the dense chart surfaces feel like true destinations.
4. Clarify the page scope above the fold.
5. Reduce density in the primary cohort-history experience.
6. Add stronger current-state structure reads after the core chart pain is improved.

Still deferred unless later phases justify them:

- cohort dossier
- compare lab
- credibility matrix
- export/share surfaces
- large new backend work unless a defined gate is triggered

## Assumptions

- Releases 1 through 3 should stay frontend-first and use the current three fetches:
  - `stablecoins`
  - `non-usd-share`
  - `stablecoin-charts`
- Commodity pegs remain in scope for `/alt-pegs/`.
- The route should remain the canonical surface; early larger-chart behavior should stay on `/alt-pegs/` rather than branching into a new route family.
- The static link hub remains crawlable in the built HTML even if it becomes visually quieter.

## Contract Decisions To Make Before Building

This is a required pre-implementation checkpoint.

### Decision A. Bucket vocabulary

Current reality:

- the current non-commodity bucket is not pure fiat
- it also includes `VAR` and `OTHER`

Decision for Releases 1 to 3:

- do **not** market the current bucket as true `fiat non-USD`
- use an honest label such as:
  - `Non-commodity non-USD`
  - or `Currency and other non-commodity`

Gate:

- if product insists on a true fiat-only split in the hero or summary modules, pull backend/data-contract work forward before Release 2

### Decision B. Focused chart navigation contract

Chosen approach for Releases 1 to 3:

- same-route focused state on `/alt-pegs/`
- query-param-driven
- no new subroute yet
- no modal
- no dialog sheet

Recommended URL shape:

- `?chart=share|cohorts`
- `?range=7d|30d|90d|1y|all`
- `?view=focused`

Navigation behavior:

- opening a focused chart should create a history entry
- closing it should return to the previous state cleanly
- range changes inside a focused chart can use `replaceState`
- focused URLs must be shareable and restorable on load

### Decision C. Default range behavior

Chosen initial behavior:

- Release 1 defaults both history modules to `1Y`
- no remembered preference in Release 1
- persistence can come later only after the state contract is stable

### Decision D. Cohort grouping algorithm

Chosen initial rule for the Release 3 redesign:

- `Top N + Other`
- `N = 5` initially
- choose `Top N` by **peak market cap within the selected range**

Why:

- this is more historically honest than latest-point-only grouping
- it addresses the complaint that today’s winners should not erase past relevance

Fallback:

- if this still reads poorly after design review, move to small multiples as the primary default and keep the grouped stack as opt-in

### Decision E. Metric contracts

Define exact formulas before Release 2 for:

- `Broadening vs Concentration`
- `Leader Dependence`

Minimum contract fields:

- formula
- denominator
- included cohorts
- thresholds
- empty-state behavior
- whether the metric applies to all alt-pegs, non-commodity only, or both

## Tightened Success Criteria

1. A first-time visitor can tell above the fold:
   - this route covers all alt-pegs
   - and which sub-bucket is being compared beside commodities
2. Each history card must show:
   - unit
   - denominator
   - coverage start
   - cadence/update note
   - provenance distinction if it differs from the other history card
3. `Open large chart` must:
   - open a shareable focused state
   - restore correctly on reload
   - behave correctly with back/forward navigation
4. The default history experience must be materially more readable on mobile:
   - no horizontal overflow at smoke width
   - density reduced before forcing users into the full all-cohort stack
5. The route must stay indexable and keep the crawlable static link hub in built HTML.

## Revised Release Structure

### Checkpoint 0: Contracts And Naming

Goal:

- Lock the decisions that would otherwise drift during implementation.

Required outputs:

- accepted bucket naming for Releases 1 to 3
- accepted focused-chart URL/state contract
- accepted `Top N + Other` grouping rule
- accepted formulas for `Broadening vs Concentration` and `Leader Dependence`
- decision on whether true fiat-only segmentation is required early

If true fiat-only segmentation is required now:

- pause after Checkpoint 0
- introduce backend/data-contract work before Release 2

### Release 1: Trust, Scope Clarity, And Chart Destinations

Goal:

- Relieve the original user pain first.

Deliverables:

- default both history charts to `1Y`
- explicit unit and denominator copy on both history modules
- coverage-start notes on both history modules
- cadence/provenance notes on both history modules
- replace `Start with EUR`
- add `Open large chart` affordances for both history modules
- implement the focused-chart same-route URL contract
- add minimal above-the-fold scope clarity using honest bucket names
- add a minimal visual trust treatment if feasible:
  - pre-coverage shading
  - start marker
  - or both
- pair share with absolute-cap context at least in the focused share experience

Why first:

- this directly addresses the original complaints:
  - history feels suspicious
  - charts are too cramped
  - dense views are hard to inspect comfortably

Likely file touchpoints:

- `src/app/alt-pegs/client.tsx`
- `src/components/non-usd-share-chart.tsx`
- `src/app/alt-pegs/alt-peg-cohort-history-chart.tsx`
- `src/app/alt-pegs/page.tsx`
- `src/lib/alt-peg-market.ts`
- `src/app/alt-pegs/*.test.tsx`

### Release 2: Authored Top Fold And Guided Current-State Surface

Goal:

- Improve interpretation and current-state structure after the basic chart pain is reduced.

Deliverables:

- page thesis
- `What changed` / `What matters now` strip
- guided distribution card
- mobile top-preview / collapse behavior for the distribution list
- `Broadening vs Concentration` board
- `Leader Dependence` read
- tighter top-fold summary elements
- contextual next-step routing around the main current-state insights

Important implementation rule:

- build these from `useStablecoins()` and shared alt-peg model helpers
- do not use `useNonUsdShare()` as the source of “what changed now” copy

Likely file touchpoints:

- `src/app/alt-pegs/client.tsx`
- route-local presentational components
- `src/lib/alt-peg-market.ts`
- homepage components/tests if shared snapshot outputs change

### Release 3A: History Redesign Scaffold

Goal:

- Remove ambiguity before the actual redesign lands.

Deliverables:

- implement the shared grouping helper for `Top N + Other`
- implement exact `Other` membership tests
- wire the redesigned cohort-history state shape behind a stable internal contract
- decide whether spotlight mode is needed in addition to grouping

This release exists to avoid turning the actual chart redesign into an open-ended refactor.

### Release 3B: Primary History Redesign

Goal:

- Replace the current over-dense historical experience with a clearer primary view.

Deliverables:

- ship the new primary cohort-history experience:
  - `Top N + Other` by peak within selected range
  - and/or spotlight mode if needed
- keep the full dense view only as secondary or opt-in if still valuable
- upgrade the share section if the Release 1 companion is still too weak
- ensure the focused chart state works cleanly with the redesigned history modules

Fallback rule:

- if grouped stacked history still underperforms in design review, promote small multiples to the primary default

### Release 3C: Optional Annotation Layer

Goal:

- Add only the minimum explanatory annotation needed after the history redesign.

Deliverables:

- sparse structural annotations only if the redesign still leaves key jumps unclear
- annotations should be manual/editorial unless a derived rule is explicitly defined

Do not include this by default if Release 3B already makes the history sufficiently understandable.

### Release 4: Signature Analytics Modules And Backend Gate

Goal:

- Add the strongest differentiated analytics only after the base route is trustworthy and readable.

Candidates:

- `Who Drove The Move?`
- breadth-over-time thresholds
- peak / drawdown / first-seen stats
- regional atlas
- curated compare presets

Backend gate:

- if a feature needs exact historical analytics, threshold counts, or true fiat-only history:
  - add one cached derived endpoint
  - do not solve it with client fan-out

Candidate endpoint shape:

- `GET /api/alt-peg-history`

If this endpoint is added, it must be:

- cached/precomputed
- typed
- provenance-documented
- freshness-documented

### Release 5: Optional Deep Research Surfaces

Candidates:

- cohort dossier
- compare lab
- credibility matrix

These remain follow-on bets, not part of the committed execution path.

## Recommended Order Of Work

1. Checkpoint 0 contracts.
2. Release 1 trust, scope clarity, and chart-destination work.
3. Release 2 current-state framing and mobile cleanup.
4. Release 3A/3B/3C history redesign.
5. Release 4 signature analytics and backend gate if needed.
6. Release 5 only if the route still feels underpowered.

## Validation Requirements

### Required local validation before push

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run seo:check`
- `npm run test:merge-gate`

### Tests that must be added explicitly

#### Chart component tests

- `src/components/non-usd-share-chart.tsx`
- `src/app/alt-pegs/alt-peg-cohort-history-chart.tsx`

Coverage to add:

- default range behavior
- title/subtitle wording contract
- tooltip denominator wording
- coverage/cadence/provenance note rendering
- focus-state open/close behavior
- invalid query-param fallback

#### Grouping/state tests

- `Top N + Other` helper behavior
- `Other` membership behavior
- grouping by peak within selected range
- focused-chart URL restore on load
- back/forward navigation behavior

#### Shared-model tests

- concentration helpers
- leader-dependence helpers
- homepage and `/alt-pegs/` shared snapshot consistency

### Browser/smoke coverage to add

- explicit `/alt-pegs/` mobile overflow/readability path
- focused-chart deep-link smoke case
- one smoke case covering the large-chart affordance

### Static and SEO verification to add

- verify built `out/alt-pegs/index.html` still contains the crawlable link hub
- verify focused URLs do not break canonical ownership of `/alt-pegs/`
- verify metadata/canonical behavior after query-param-driven focused states

## Docs To Update

Always update:

- `docs/alt-pegs-page.md`

Update when shared snapshot framing changes:

- `docs/homepage.md`

Update when route description or discoverability changes materially:

- `docs/architecture.md`
- `README.md`
- `docs/README.md`

If backend work is added:

- `docs/api-reference.md`
- `docs/worker-and-api-limits.md`
- generated API artifacts guarded by:
  - `npm run check:openapi`
  - `npm run check:postman`

## Risks And Mitigations

### Risk 1: The plan still over-promises a clean fiat split

Mitigation:

- use honest bucket naming in Releases 1 to 3
- only promise true fiat-only history after a data-contract change

### Risk 2: Focused-chart behavior becomes routing thrash

Mitigation:

- lock the same-route URL contract in Checkpoint 0
- use push-state for open/close
- use replace-state only for internal control changes

### Risk 3: The history redesign stays vague

Mitigation:

- split scaffold from actual redesign
- lock grouping rules before layout work

### Risk 4: Validation misses chart regressions

Mitigation:

- add direct chart tests
- add `/alt-pegs/` smoke coverage
- require `test:merge-gate`

### Risk 5: Current-state analytics become improvised

Mitigation:

- define metric formulas before Release 2
- keep derived helpers in shared alt-peg model code, not in JSX

## Practical Immediate Shortlist

If execution starts now, the first batch should be:

1. Checkpoint 0 decisions.
2. Default history to `1Y`.
3. Add unit/denominator/coverage/cadence/provenance notes.
4. Add `Open large chart` and focused-chart URL behavior.
5. Replace `Start with EUR`.
6. Add minimal above-the-fold scope clarity with honest bucket naming.
7. Add route-specific chart tests and `/alt-pegs/` browser coverage.

## Recommendation

Proceed with this v2 plan, not the original.

The strategy did not need to be replaced. It needed:

- better sequencing
- an honest bucket contract
- an explicit chart-state contract
- stronger validation requirements
