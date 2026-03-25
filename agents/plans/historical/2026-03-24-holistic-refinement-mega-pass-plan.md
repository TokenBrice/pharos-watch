# Pharos Holistic Refinement Mega-Pass Plan

Date: 2026-03-24

Review status:
- Re-audited against current `main` after subsequent repo updates
- Second-pass reviewed specifically against:
  - maximizing the professional feel of Pharos
  - maximizing the practical usefulness of the app
- Current judgment after revision: no remaining medium issues in this plan; only low-risk execution tradeoffs remain

Scope:
- Execute one integrated refinement pass across the Pharos product
- Focus on refinement, not feature expansion
- Exclude recommendation `#7` (repeat-user memory/statefulness beyond current session and URL behavior)

Included recommendations:
1. Product-wide trust layer
2. Entrance-page hierarchy pass
3. Cross-surface workflow continuity
4. Editorial decisiveness
5. Visual importance normalization
6. First-render/loading-state polish
8. Mobile power-user ergonomics
9. Micro-interaction and response-system unification
10. Comparison and benchmark framing
11. Repetition reduction
12. Exception and edge-case presentation

Excluded recommendation:
- `#7` remembered compare sets / resume state / persistent recent-context systems

---

## 1. Outcome Definition

This pass should make Pharos feel:
- more authoritative
- more internally coherent
- more useful at first glance
- more continuous across routes
- more intentionally designed in partial-data and edge-case states

This pass should not:
- add new product areas
- add new data pipelines or scoring systems
- materially expand worker/API scope
- introduce account-like persistence or saved-workspace behavior
- redesign strong surfaces just because they can be redesigned

Success criteria:
- the product reads as one cohesive research system rather than several strong pages
- users can quickly tell what is live, what is partial, what matters now, and what to do next
- top-fold hierarchy is clearer on the highest-value routes
- loading, stale, unavailable, and structural-only states feel intentional and trustworthy
- mobile dense-use flows remain professional and usable

---

## 2. Confirmed Current Baseline

The original draft of this plan predated several polish-related changes that are now present in the repo. The mega-pass must treat the current baseline accurately.

### 2.1 Already-landed foundations

These are already present and should be treated as baseline, not pending work:

- Regime bar:
  - `src/components/regime-bar.tsx`
  - mounted in `src/app/layout.tsx`
- Shared chart tooltip shell:
  - `src/components/pharos-chart-tooltip.tsx`
  - used by multiple chart components
- Confidence typography:
  - `src/lib/confidence.ts`
  - used in list/detail price presentation
- Shared onboarding / empty-state shell:
  - `src/components/empty-state-surface.tsx`
- Strong compare empty-state composition:
  - `src/components/compare-empty-state.tsx`
- Consolidated detail-page next-step hub:
  - `src/components/stablecoin-detail/explore-next-section.tsx`
- PSI presentation consistency helpers:
  - `shared/lib/psi-view-model.ts`
- Homepage KPI / PSI snapshot improvements:
  - `src/components/kpi-bar.tsx`
- Footer repetition reduction pass:
  - `src/components/footer.tsx`

### 2.2 What this means for execution

The mega-pass should not spend time “creating” those patterns.

Instead it should:
- normalize them where needed
- close gaps around them
- avoid regressing already-strong surfaces

### 2.3 Highest-leverage unfinished gaps

Despite the stronger baseline, the most important unfinished areas are still:

1. Trust-language precision and route-level data-integrity framing
2. Stablecoin detail first-render / dossier feel
3. Generic feature-shell hierarchy and repeated route lead copy
4. Cross-surface continuity and benchmark framing
5. Edge-state and partial-data presentation
6. Mobile ergonomics and micro-interaction consistency on dense routes

---

## 3. Current Repo State And Guardrails

### 3.1 Current worktree state

At review time:
- tracked worktree is clean on `main`
- only untracked planning/research notes exist under `/agents/`

Implication:
- there is no longer a PSI-specific merge-conflict blocker
- the mega-pass can start from a clean branch/worktree

### 3.2 Repo guardrails

This pass must preserve:
- current Pharos design language and identity
- static Tailwind class strings
- current route contracts unless docs are updated with behavior changes
- methodology/version integrity
- worker/frontend boundary discipline
- recently landed PSI, liquidity-confidence, and blacklist-confidence semantics

### 3.3 Do-not-regress surfaces

Treat these as “touch only if a clear problem is demonstrated”:

- `src/components/regime-bar.tsx`
- `src/components/pharos-chart-tooltip.tsx`
- `src/components/compare-empty-state.tsx`
- `src/components/empty-state-surface.tsx`
- `src/components/footer.tsx`
- confidence typography in:
  - `src/components/stablecoin-table.tsx`
  - `src/components/stablecoin-detail/hero-card.tsx`

These may be adjusted only if:
- a consistency gap is concrete
- the change materially improves professionalism or usefulness
- the result remains recognizably Pharos rather than more generic

### 3.4 Required validation before completion

```bash
npm run lint
npm test
npm run build
npm run seo:check
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

Recommended extra visual smoke:

```bash
npm run test:smoke-ui -- --url http://127.0.0.1:4173
```

---

## 4. Quality Bar For This Pass

Every implementation choice must survive both of these standards.

### 4.1 Professional-feel rules

- Prefer fewer, stronger signals over more UI.
- Do not add decorative complexity.
- Supporting chrome must never visually compete with the primary analytic task.
- States that differ in meaning must differ in language and treatment.
- If a rewrite makes Pharos feel more generic, reject it even if it is cleaner in isolation.

### 4.2 Usefulness rules

- Every changed sentence must improve interpretation, trust, or actionability.
- Every changed visual element must improve scanability or reduce ambiguity.
- If a block does not help the user decide what to do or how to interpret the data, remove or demote it.
- Do not explain for explanation’s sake; explain only when it reduces real friction.

### 4.3 Explicit anti-goals

Do not let this pass drift into:
- generalized redesign work
- novelty-driven motion
- more onboarding than the product needs
- more persistent UI surfaces than the density budget supports
- repeated helper copy that restates what the layout already makes obvious

---

## 5. Execution Strategy

Execute the pass in five layers, in this order:

1. Shared trust language and route-shell refinement
2. Stablecoin detail and major-route hierarchy pass
3. Workflow continuity and benchmark framing
4. Edge-state, loading-state, and exception normalization
5. Mobile ergonomics, micro-interactions, docs, and full verification

Why this order:
- trust and shell decisions drive later copy and state presentation
- stablecoin detail is the highest-leverage unfinished professionalism gap
- continuity and benchmark framing should inherit final hierarchy
- edge-state work should inherit final editorial and importance rules
- mobile and interaction polish is safest after layout stabilizes

### 5.1 Highest-ROI route order

Prioritize routes in this order:

1. `/stablecoin/[id]/`
2. `/`
3. `/compare/`
4. `/coverage/`
5. `/stability-index/`
6. `/depeg/`
7. `/about/`, `/methodology/`, `/start/`

Reason:
- these routes most strongly determine whether Pharos feels like a serious research product
- they also carry the highest mix of trust, interpretation, and next-step demands

---

## 6. Workstream Map

## Workstream A: Product-Wide Trust Layer

Recommendations covered:
- `#1`
- part of `#10`
- part of `#12`

Objective:
- make freshness, completeness, confidence, and provenance feel like one Pharos-native system
- improve trust without adding noise

Primary outputs:
- shared trust-language matrix
- more precise stale/degraded/unavailable language
- route-level integrity summaries where they materially help interpretation

Primary files:
- `src/components/stale-data-banner.tsx`
- `src/components/data-health-banner.tsx`
- `src/components/query-error-notice.tsx`
- `src/lib/data-health.ts`
- `src/lib/data-health-config.ts`
- `src/components/homepage-client.tsx`
- `src/app/compare/client.tsx`
- `src/app/coverage/client.tsx`
- `src/app/stablecoin/[id]/client.tsx`
- `src/components/stablecoin-detail/price-transparency-card.tsx`

Detailed tasks:
1. Define canonical trust states and wording:
   - fresh
   - delayed
   - stale
   - unavailable
   - partial
   - structural-only
2. Ensure `deriveDataHealth()` and banner copy cleanly express those distinctions.
3. Replace generic messaging like “Some data is not yet available” with route-aware explanations:
   - what is missing
   - what still works
   - whether the route is using last successful data
4. Improve `QueryErrorNotice` so it distinguishes:
   - transport failure
   - dataset not yet populated
   - fallback / stale snapshot
   - structural-only usefulness
5. Add route-level trust framing where it is most valuable:
   - homepage
   - compare
   - coverage
   - stablecoin detail
   - avoid adding banners where a compact inline summary is enough
6. Standardize provenance/action labels:
   - `View methodology`
   - `Version history`
   - `Last updated`
   - `Source coverage`

Acceptance criteria:
- major routes communicate trust in recognizably consistent language
- unavailable data never reads like total failure if useful context remains
- trust cues increase confidence instead of adding clutter

---

## Workstream B: Entrance-Page Hierarchy Pass

Recommendations covered:
- `#2`
- part of `#4`
- part of `#5`
- part of `#11`

Objective:
- make the first screen of each major route communicate one job clearly

Priority routes:
- `/`
- `/stablecoin/[id]/`
- `/compare/`
- `/depeg/`
- `/stability-index/`
- `/coverage/`
- `/start/`
- `/about/`
- `/methodology/`

Primary files:
- `src/components/homepage-client.tsx`
- `src/components/kpi-bar.tsx`
- `src/app/stability-index/page.tsx`
- `src/app/stability-index/client.tsx`
- `src/app/depeg/page.tsx`
- `src/app/compare/page.tsx`
- `src/app/coverage/page.tsx`
- `src/app/about/page.tsx`
- `src/app/methodology/page.tsx`
- `src/components/feature-page-shell.tsx`
- `src/components/stablecoin-detail/hero-card.tsx`
- `src/app/stablecoin/[id]/page.tsx`

Detailed tasks:
1. Define explicit top-fold jobs:
   - homepage: live triage
   - detail: research dossier
   - compare: decision surface
   - coverage: breadth/completeness truth source
   - stability index: regime framing
   - depeg: incident/risk monitoring
   - methodology: reference manual
   - about: scope and credibility
2. Tighten route leads so they guide rather than describe.
3. Reduce repeated generic “Pharos tracks…” language across routes.
4. Demote low-value repeated route chrome where it competes with the route’s core job.
5. Improve stablecoin detail first render:
   - visible identity
   - visible first-layout scaffolding
   - preserve SEO and JSON-LD
   - make the fallback feel like a dossier shell, not generic loading UI

Acceptance criteria:
- each major route explains itself immediately
- repeated generic copy is reduced
- stablecoin detail no longer feels blank or anonymous before hydration

---

## Workstream C: Cross-Surface Workflow Continuity

Recommendations covered:
- `#3`
- part of `#10`
- part of `#11`

Objective:
- make movement between list, detail, compare, coverage, taxonomy, and methodology feel like one continuous research flow

Constraint:
- do not add persistent memory systems from excluded recommendation `#7`

Primary files:
- `src/components/stablecoin-table.tsx`
- `src/hooks/use-homepage-filters.ts`
- `src/hooks/use-url-filters.ts`
- `src/lib/urls.ts`
- `src/components/stablecoin-detail/explore-next-section.tsx`
- `src/app/compare/client.tsx`
- `src/components/comparison-table.tsx`
- `src/components/coin-selector.tsx`
- `src/components/command-palette.tsx`
- taxonomy landing components
- `src/lib/start-here-content.ts`

Detailed tasks:
1. Audit common research flows:
   - homepage -> detail
   - detail -> compare
   - compare -> detail
   - detail -> taxonomy
   - coverage -> detail
   - methodology -> relevant surface
2. Preserve context wherever it already fits naturally in URL state.
3. Improve “next move” surfaces without redoing already-strong patterns:
   - refine `ExploreNextSection`
   - ensure compare CTAs are contextually useful
4. Improve compare continuity:
   - keep current onboarding surface
   - improve post-selection orientation and panel framing
5. Tighten command palette usefulness:
   - sharper page descriptions
   - route naming aligned with actual route jobs

Acceptance criteria:
- route-to-route movement feels directed rather than reset-heavy
- navigation supports actual research flow rather than generic exploration

---

## Workstream D: Editorial Decisiveness Pass

Recommendations covered:
- `#4`
- part of `#11`
- part of `#12`

Objective:
- make copy feel like practitioner guidance rather than feature inventory or filler

Primary files:
- `src/components/homepage-client.tsx`
- `src/lib/start-here-content.ts`
- `src/app/about/page.tsx`
- `src/app/methodology/page.tsx`
- `src/app/coverage/client.tsx`
- `src/app/compare/client.tsx`
- `src/components/query-error-notice.tsx`
- `src/components/data-health-banner.tsx`
- route-level lead paragraphs in shells

Detailed tasks:
1. Apply a tone checklist:
   - decisive
   - concise
   - practitioner-oriented
   - specific about action or interpretation
2. Rewrite headings/subheads that merely describe the feature.
3. Make helper text answer one of:
   - what should the user do here?
   - what should the user compare this against?
   - what does this state imply?
4. Rewrite empty and partial-data states so they remain useful.
5. Standardize CTA verbs:
   - `Open`
   - `Review`
   - `Compare`
   - `Track`
   - `Read methodology`
6. Remove platform-filler copy:
   - repeated generic taglines
   - repeated “Pharos tracks…” statements
   - helper text that restates the obvious

Acceptance criteria:
- route intros read like an expert product
- helper/error/empty copy remains high-signal

---

## Workstream E: Visual Importance Normalization

Recommendations covered:
- `#5`
- part of `#2`
- part of `#9`

Objective:
- make primary, secondary, contextual, urgent, and reference information visually distinct at a glance

Primary files:
- `src/app/globals.css`
- `src/styles/tokens/semantic.css`
- `src/components/feature-page-shell.tsx`
- `src/components/header.tsx`
- `src/components/sidebar.tsx`
- `src/components/kpi-bar.tsx`
- `src/components/market-highlights.tsx`
- `src/components/stablecoin-detail/hero-card.tsx`
- major score/stat card surfaces

Detailed tasks:
1. Define visual tiers:
   - route-defining signal
   - supporting metric
   - contextual reference
   - metadata/legal/support chrome
2. Audit where too many blocks currently read as equally important.
3. Normalize:
   - kicker usage
   - metric label styling
   - badge weight
   - border emphasis
   - background contrast
   - shadow/elevation semantics
4. Preserve recently successful accents unless they clearly fail hierarchy:
   - regime bar
   - compare empty-state shell
   - homepage PSI snapshot card
5. Reserve urgency for true risk states.
6. Reduce visual competition from repeated pills and supporting controls.

Acceptance criteria:
- the route-defining signal wins the scan
- supporting chrome is visibly subordinate

---

## Workstream F: First-Render And Loading-State Polish

Recommendations covered:
- `#6`
- part of `#12`

Objective:
- make loading, hydration, and partial render states feel designed rather than tolerated

Primary files:
- `src/app/stablecoin/[id]/page.tsx`
- `src/app/stablecoin/[id]/client.tsx`
- `src/components/chart-skeleton.tsx`
- `src/components/ui/skeleton.tsx`
- `src/components/homepage-client.tsx`
- `src/app/compare/client.tsx`
- `src/app/coverage/page.tsx`
- `src/app/depeg/page.tsx`
- `src/app/stability-index/page.tsx`
- `src/app/liquidity/page.tsx`
- `src/app/portfolio/page.tsx`
- `src/app/yield/page.tsx`

Detailed tasks:
1. Inventory all major skeleton variants and inline loading placeholders.
2. Replace one-off placeholder patterns with a more consistent shell language.
3. Improve stablecoin detail SSR fallback:
   - visible identity
   - visible scaffolding
   - no fake-data theater
4. Ensure partially loaded sections still render useful context.
5. Normalize messaging for:
   - loading
   - refreshing
   - delayed
   - unavailable

Acceptance criteria:
- the app feels stable and intentional while loading
- route identity is visible before heavy client hydration completes

---

## Workstream G: Mobile Power-User Ergonomics

Recommendations covered:
- `#8`
- part of `#2`
- part of `#9`

Objective:
- improve narrow-width usability without diluting density

Primary files:
- `src/components/header.tsx`
- `src/components/sidebar.tsx`
- `src/components/mobile-utility-dock.tsx`
- `src/components/longform-scrollspy-nav.tsx`
- `src/components/filter-bar.tsx`
- `src/components/stablecoin-table.tsx`
- `src/app/coverage/client.tsx`
- `src/app/compare/client.tsx`
- `src/components/stablecoin-detail/hero-card.tsx`
- `src/components/stablecoin-detail/explore-next-section.tsx`

Detailed tasks:
1. Audit key mobile flows:
   - homepage browse/filter
   - detail navigation
   - compare setup
   - coverage scan
   - depeg overview
   - yield overview
   - methodology navigation
2. Tune tap targets on dense surfaces.
3. Improve horizontal-scroll behavior for:
   - scrollspy rails
   - chip sets
   - compare selectors
   - taxonomy pills
4. Re-check sticky behavior and viewport occupancy:
   - header
   - utility dock
   - jump rails
5. Ensure mobile summary surfaces front-load the best signal.

Acceptance criteria:
- mobile feels dense but not cramped
- the core task remains obvious and comfortable

---

## Workstream H: Micro-Interaction And Response-System Unification

Recommendations covered:
- `#9`

Objective:
- make response states, affordances, and small interactions feel like one authored system

Primary files:
- `src/app/globals.css`
- `src/components/share-button.tsx`
- `src/components/command-palette.tsx`
- `src/components/mobile-utility-dock.tsx`
- `src/components/longform-scrollspy-nav.tsx`
- `src/components/feature-page-shell.tsx`
- route-level filter/action controls

Detailed tasks:
1. Standardize motion curves, durations, and pressed/active behavior.
2. Normalize share interaction states:
   - loading
   - copied
   - failed
   - disabled
3. Normalize tooltip/popover treatment only where inconsistencies remain after the landed tooltip work.
4. Normalize disclosure affordances:
   - `details`
   - show-more toggles
   - inline expanders
   - active pill rails
5. Confirm keyboard and focus behavior:
   - command palette
   - mobile menu
   - scrollspy rails
   - share controls

Acceptance criteria:
- interactions feel visibly related
- response states are immediate and consistent

---

## Workstream I: Comparison And Benchmark Framing

Recommendations covered:
- `#10`

Objective:
- help users answer “compared to what?” using existing data and current route context

Primary files:
- `src/app/compare/client.tsx`
- `src/components/comparison-table.tsx`
- `src/components/stablecoin-detail/hero-card.tsx`
- `src/components/homepage-safety-overview.tsx`
- `src/components/homepage-flow-overview.tsx`
- `src/components/market-highlights.tsx`
- `src/app/coverage/client.tsx`

Detailed tasks:
1. Identify isolated numbers that need immediate peer framing.
2. Improve compare route framing:
   - what comparison angle is active
   - how selected assets relate to the panels below
3. Add benchmark language using existing cohorts where useful:
   - major peers
   - governance cohort
   - asset class
   - tracked-universe share
4. Keep benchmark framing concise; do not turn it into explanatory clutter.

Acceptance criteria:
- more metrics are interpretable at a glance
- compare feels more like guided evaluation than raw juxtaposition

---

## Workstream J: Repetition Reduction

Recommendations covered:
- `#11`

Objective:
- reduce duplicated copy, repeated navigation patterns, and repeated support language

Primary files:
- `src/components/feature-page-shell.tsx`
- `src/components/footer.tsx`
- route intros on major pages
- `src/components/stablecoin-detail/explore-next-section.tsx`
- route-local CTA clusters in compare/start/about/methodology

Detailed tasks:
1. Inventory repeated copy blocks and repeated route-end navigation clusters.
2. Decide what belongs in:
   - global shell
   - route-specific framing
   - optional support blocks
3. Remove or compress repeated generic text.
4. Consolidate overlapping navigation clusters where one stronger cluster can do the job.

Acceptance criteria:
- route copy feels more specific
- route endings feel intentional rather than duplicated

---

## Workstream K: Exception And Edge-Case Presentation

Recommendations covered:
- `#12`

Objective:
- make edge cases feel fully designed rather than awkward exceptions

Primary files:
- `src/components/pre-launch-detail.tsx`
- `src/lib/stablecoin-detail-view-model.ts`
- `src/components/stablecoin-detail/*`
- `src/app/coverage/client.tsx`
- `src/lib/coverage.ts`
- `src/components/query-error-notice.tsx`
- `src/components/data-health-banner.tsx`
- `src/components/coin-notice.tsx`
- `src/components/yield-detail-section.tsx`
- `src/components/dex-liquidity-card.tsx`
- `src/components/depeg-history.tsx`

Detailed tasks:
1. Enumerate visible edge states:
   - pre-launch
   - NAV / price-only
   - no liquidity / no yield / no flows
   - configured but unrated
   - structural coverage without live dataset
   - degraded cache
   - mobile-specific unsupported combinations
2. Review how each is currently presented.
3. Rewrite/redesign them so they:
   - explain the reason
   - preserve trust
   - keep the route useful
4. Ensure edge-state styling follows the same trust and hierarchy rules as the happy path.

Acceptance criteria:
- the product feels deliberate even in messy conditions
- partial/unsupported states do not read as accidental

---

## 7. File-Level Execution Sequence

### Phase 0: Preflight and inventory

1. Create a fresh execution branch/worktree from current `main`.
2. Capture before screenshots for:
   - homepage desktop/mobile
   - stablecoin detail desktop/mobile
   - compare desktop/mobile
   - coverage desktop/mobile
   - depeg desktop/mobile
   - stability index desktop/mobile
3. Note:
   - current trust banners
   - empty/loading states
   - repeated copy
   - mobile pain points
4. Mark already-strong surfaces as low-touch so they are not accidentally reworked.

### Phase 1: Shared trust and shell foundations

1. `src/lib/data-health.ts`
2. `src/components/data-health-banner.tsx`
3. `src/components/stale-data-banner.tsx`
4. `src/components/query-error-notice.tsx`
5. `src/app/globals.css`
6. relevant token files if needed
7. `src/components/feature-page-shell.tsx`

### Phase 2: Highest-leverage route pass

1. stablecoin detail SSR/top fold/first render
2. homepage hierarchy and trust presentation
3. compare hierarchy and post-selection orientation
4. coverage completeness framing
5. stability index / depeg hierarchy cleanup
6. methodology/about/start only where consistency requires it

### Phase 3: Continuity and benchmark framing

1. compare workflow and contextual framing
2. explore-next and taxonomy pathways
3. homepage -> detail -> compare pathways
4. coverage -> detail pathways
5. benchmark/context copy on compare and detail surfaces

### Phase 4: Edge and loading-state normalization

1. skeleton system normalization
2. route-level partial/unavailable states
3. pre-launch / NAV / unrated / structural-only treatment

### Phase 5: Mobile and interaction pass

1. header/mobile utility dock
2. scrollspy rails
3. compare mobile setup
4. coverage mobile cards
5. share/command-palette/disclosure behavior

### Phase 6: Repetition reduction and final copy trim

1. repeated taglines
2. repeated route-end nav clusters
3. repeated support/CTA phrasing

### Phase 7: Docs and full verification

1. update page-contract docs only where behavior changed
2. update design docs only where the live baseline changed materially
3. run full validation suite

### 7.1 Recommended commit batches

Prefer these reviewable commit boundaries:

1. `refactor: tighten shared trust language and shell semantics`
2. `feat: improve stablecoin detail first render and hierarchy`
3. `refactor: sharpen homepage compare and coverage route framing`
4. `refactor: normalize partial-data and edge-state presentation`
5. `refactor: align mobile ergonomics and interaction behavior`
6. `docs: update route contracts and design-language baseline`

---

## 8. Documentation Update Plan

Update only when the final implementation changes a documented behavior, contract, section order, or shared visual rule.

Potential docs to update:
- `docs/homepage.md`
- `docs/start-page.md`
- `docs/stablecoin-detail-page.md`
- `docs/cemetery-and-compare.md`
- `docs/coverage-page.md`
- `docs/about-page.md`
- `docs/methodology-page.md`
- `docs/design-language.md`
- `docs/design-tokens.md` if token semantics change

---

## 9. Verification Plan

### 9.1 Required automated validation

```bash
npm run lint
npm test
npm run build
npm run seo:check
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

### 9.2 Strongly recommended visual validation

Do not stop at automated checks. The primary goals are professionalism and usefulness, so manually verify:

- route top folds
- stale/degraded/unavailable states
- compare before/after selection
- detail-page load and partial-data behavior
- mobile sticky and scroll interactions

If available:

```bash
npm run test:smoke-ui -- --url http://127.0.0.1:4173
```

### 9.3 Additional targeted checks

1. Route checks:
   - homepage
   - stablecoin detail
   - compare
   - coverage
   - depeg
   - stability index
   - methodology
2. Mobile checks:
   - narrow-width screenshots for the routes above
3. State checks:
   - fresh data
   - delayed/stale banner
   - unavailable dataset
   - compare with fewer than two selections
   - detail-page loading fallback
   - pre-launch
   - NAV token
   - unrated / partial-coverage coin
4. Accessibility spot-checks:
   - command palette focus restore
   - mobile menu focus behavior
   - share controls
   - scrollspy rails
   - sticky surfaces do not trap focus or obscure content

### 9.4 Professional-feel review checklist

For every touched route, confirm:

1. The route’s purpose is obvious in the first screen.
2. The primary action or interpretation path is obvious.
3. Trust/freshness signals are precise but not noisy.
4. Supporting chrome is visually subordinate.
5. No repeated copy survives unless it is intentionally global.
6. Empty/loading/partial states still feel premium and informative.

### 9.5 Usefulness review checklist

For every touched route, confirm:

1. A user can tell what to do next.
2. A user can tell what to compare the numbers against.
3. A user can tell what is missing and whether the page is still trustworthy.
4. Navigation out of the route feels directional, not random.
5. Mobile users do not lose the core task because of dense UI.

---

## 10. Execution Notes

Treat this as a guided product-hardening refactor, not a loose polish sweep.

The easiest failure mode is many small UI tweaks without a clear system. Avoid that by asking, for every change:

1. Does this make the route’s job clearer?
2. Does this increase trust without increasing noise?
3. Does this make the route more useful in a real research flow?
4. Does this feel more like Pharos specifically, not just a nicer dashboard?

Additional guardrail:
- when a surface is already strong, tighten rather than replace

---

## 11. Final Definition Of Done

The mega-pass is done when all of the following are true:

- shared trust language is consistent across major routes
- top-fold hierarchy is clearer on homepage, detail, compare, depeg, stability index, and coverage
- stablecoin detail first render feels anchored and professional
- cross-surface movement feels more continuous
- copy is more decisive and less repetitive
- visual priority is more legible
- loading and edge states feel intentional
- mobile ergonomics improve on the core routes
- micro-interactions feel unified
- benchmark framing is stronger without new metrics
- relevant docs are updated
- the full validation suite passes

---

## 12. Second-Pass Review Outcome

Medium issues resolved during review:
- outdated assumption that the repo still had unresolved PSI/UI conflicts
- failure to account for already-landed tooltip shell, regime bar, confidence typography, compare onboarding shell, and footer cleanup
- insufficient prioritization of stablecoin detail as the highest-leverage unfinished professionalism gap
- risk of wasting effort reworking already-strong surfaces

Remaining issues:
- low only: the exact amount of copy reduction and benchmark framing will still require judgment during implementation

Conclusion:
- this plan is now accurate enough to execute
- it is narrowly focused on the parts of the product that still move professionalism and usefulness materially
