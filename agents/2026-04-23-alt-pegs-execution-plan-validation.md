# Alt-Pegs Execution Plan Validation

Date: 2026-04-23

Validated artifact:

- [Alt-Pegs execution plan](/home/ahirice/Documents/git/stablecoin-dashboard/agents/2026-04-23-alt-pegs-execution-plan.md)

Validation method:

- 5 specialized `gpt-5.4 xhigh` subagents
- lenses:
  - product / UX sequencing
  - frontend implementation risk
  - data model / API architecture
  - QA / docs / rollout safety
  - original-brief alignment

## Overall Verdict

The plan is **acceptable**, not strong.

Common pattern across validators:

- direction is mostly right
- early frontend-first bias is mostly sound
- Releases 4 and 5 are correctly deferred
- but the release boundaries need rebalancing
- and the plan is missing some key contract and validation details

No validator called the plan weak, but none rated it strong.

## What The Plan Gets Right

- It starts with trust/readability fixes instead of immediately adding new analytics or worker/API work.
- It keeps the route frontend-first through the early releases, which matches the current route contract and avoids premature complexity.
- It defers large expansion bets like cohort dossiers, compare lab, and credibility matrix until the base route is more trustworthy and readable.
- It preserves key route invariants:
  - canonical `/alt-pegs/`
  - static crawlable link hub
  - commodity pegs remain in scope
- It separates current-state framing from historical-chart redesign, which is a good decomposition.

## Consensus Problems

### 1. The plan solves the original brief, but too late

The strongest repeated criticism:

- `Open large chart` / focused-view behavior is too far back in Release 3
- the main chart-density fix is too far back in Release 3
- the original complaint was about chart ergonomics and inspectability, not mainly hero framing

Implication:

- Release 2 currently gets too much priority relative to the original user pain

### 2. The scope split between `all alt-pegs` and `fiat non-USD` is under-specified

This is the biggest hidden architecture issue.

Current reality:

- the existing non-commodity bucket is not true fiat-only
- current code and `/api/non-usd-share` bucket all non-USD, non-commodity pegs together, including `VAR` and `OTHER`

Implication:

- the plan should not promise a clean `fiat non-USD` split in Release 1 or 2 unless it first defines whether:
  - the bucket will be renamed honestly
  - or the data contract will change

### 3. Release 3 is too broad and not well-specified enough

Right now Release 3 tries to do all of this at once:

- route/state contract for focused charts
- large-chart UX
- cohort-history redesign
- share-plus-absolute-cap pairing
- annotations
- mobile reordering

Implication:

- the release is too fuzzy to estimate or execute cleanly

### 4. Validation requirements are too generic

The plan does not yet name several repo-specific checks and route-specific coverage needs:

- `npm run test:merge-gate`
- direct tests for the chart components
- route-specific browser/smoke coverage for `/alt-pegs/`
- deep-link and URL-state behavior tests
- static HTML / metadata / canonical verification for focused states
- homepage regression coverage via the shared `buildAltPegSnapshot(...)` dependency

### 5. A few metrics/modules are conceptually right but not contract-ready

Specifically:

- `Broadening vs Concentration`
- `Leader Dependence`
- remembered range behavior
- `Top N + Other` grouping rule
- focused chart URL contract

Implication:

- the plan needs a small metric/state-contract pass before implementation, otherwise those definitions will drift during coding

## Recommended Changes To The Plan

### Change 1. Rebalance Releases 1-3

Recommended shape:

#### Release 1

- trust/readability fixes
- simplified above-the-fold scope clarity
- explicit chart-destination affordances

Specifically:

- default range to `1Y`
- unit/denominator cleanup
- coverage/cadence/provenance notes
- replace `Start with EUR`
- add `Open large chart`
- add a minimal split in the hero between:
  - `all alt-pegs`
  - `non-commodity non-USD` or another honest label if true fiat is not yet available

#### Release 2

- authored top fold and current-state cleanup
- mobile current-state cleanup

Specifically:

- thesis
- `What changed` / `What matters now`
- guided distribution
- mobile collapse/top-preview behavior
- concentration board
- leader-dependence read

#### Release 3

Make this a narrower, gated history redesign:

- `3A`: focus-state / routing / state contract
- `3B`: primary cohort-history redesign
- `3C`: optional annotations only if still needed

### Change 2. Add a naming and metric contract before Release 2

The plan needs a short design/contract checkpoint covering:

- whether `fiat non-USD` is true fiat or a renamed non-commodity bucket
- exact formulas for:
  - `Broadening vs Concentration`
  - `Leader Dependence`
- default grouping rule for:
  - `Top N + Other`
- exact focus-state URL contract:
  - query params
  - navigation behavior
  - back-button semantics
  - canonical ownership

### Change 3. Tighten Release 1 promises

Right now Release 1 implies it will fix the biggest trust issues.

Safer wording:

- Release 1 should promise to **reduce trust friction**

Reason:

- notes and labels help, but they do not fully solve the trust problem unless the page also adds a more visible visual or structural change
- if you want Release 1 to truly “fix” trust more strongly, pull one of these up:
  - a visual coverage treatment
  - pre-coverage shading / start markers
  - share + absolute-cap pairing

### Change 4. Add explicit validation requirements

The revised plan should name:

- `npm run test:merge-gate`
- direct tests for:
  - `src/components/non-usd-share-chart.tsx`
  - `src/app/alt-pegs/alt-peg-cohort-history-chart.tsx`
- route-specific browser coverage for `/alt-pegs/`
- URL-state tests for focused-chart deep links
- static HTML / canonical checks for the focused experience
- homepage regression checks where shared snapshot logic changes

## Recommended Validation Additions

Add these directly into the execution plan.

### Required local validation

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run seo:check`
- `npm run test:merge-gate`

### Route-specific tests to add

- range default behavior
- invalid stored preference fallback
- focused-chart URL restore on load
- back/forward behavior for focused view
- `Top N + Other` grouping logic
- `Other` membership logic
- denominator/tooltip wording contract
- crawlable link hub still present in built HTML after focus-state changes

### Browser/smoke coverage to add

- `/alt-pegs/` mobile overflow/readability path
- focused-chart path/deep link smoke
- one browser-level check for chart expansion affordance

## Recommended Architecture Clarifications

### Safe to keep frontend-only early

- range defaults
- coverage/cadence/provenance notes
- unit/denominator cleanup
- replacing `Start with EUR`
- large-chart focus states on `/alt-pegs/`
- share + absolute-cap pairing
- current-state concentration/leader-dependence reads
- `Top N + Other`, spotlight mode, or small multiples using current chart payloads

### Should not be promised as frontend-only without clarification

- a true `fiat non-USD` split
- breadth-over-time threshold charts
- exact first-seen / peak / drawdown stats
- coin-level contribution analytics

If those are needed later, the plan should prefer:

- one cached derived endpoint
- typed schema
- explicit provenance/freshness contract

## Go / No-Go Assessment

### Go, if revised

The plan is good enough to proceed **after** the following edits:

1. Move chart-destination affordances earlier.
2. Move minimal scope-clarity work earlier.
3. Narrow and gate Release 3.
4. Add a naming/metric contract checkpoint.
5. Add explicit repo-specific validation requirements.

### No-Go, if unchanged

Reasons:

- it leaves the most user-visible fixes one release too late
- it is too loose around `fiat non-USD`
- Release 3 is too underspecified for confident execution
- the test/rollout language is not yet strong enough

## Suggested Revised Release Shape

### Release 1

- default range to `1Y`
- unit/denominator cleanup
- coverage/cadence/provenance notes
- replace `Start with EUR`
- add `Open large chart`
- add minimal hero scope clarity using honest bucket names

### Release 2

- thesis
- `What changed`
- guided distribution
- mobile collapse/top-preview behavior
- concentration board
- leader-dependence read

### Release 3A

- choose focused-view UX contract
- choose URL/state contract
- choose `Top N + Other` grouping rule

### Release 3B

- ship the actual cohort-history redesign
- ship share + absolute-cap pairing if still needed

### Release 3C

- optional annotations and extra explanatory polish

## Bottom Line

The execution plan is **directionally correct but not yet implementation-ready**.

The core fix is not to rewrite the strategy, but to:

- pull the original pain-relief items earlier
- clarify the bucket semantics
- define the navigation and metric contracts before build work
- tighten the test and rollout requirements
