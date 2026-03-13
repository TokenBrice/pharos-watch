# Contextual Methodology Surfacing Research - 2026-03-13

## Scope

Research only.

This document explores how Pharos can surface methodology context closer to live metrics and computed scores across the product, without changing implementation yet.

The goal is not to replace `/methodology`. The goal is to reduce the distance between:

- a user seeing a score, label, or warning
- the user understanding what that score means
- the user finding the exact long-form methodology when needed

## Prompt Behind The Research

Users want more direct access to context on the data and scores Pharos computes. Today that context exists, but it is concentrated in `/methodology` and page-level lead paragraphs. The result is that interpretation still requires a context switch.

## Sources Reviewed

- `src/app/methodology/page.tsx`
- `src/app/methodology/methodology-sections.tsx`
- `src/components/feature-page-shell.tsx`
- `src/components/ui/tooltip.tsx`
- `src/app/stability-index/client.tsx`
- `src/components/report-card.tsx`
- `src/components/dex-liquidity-card.tsx`
- `src/components/yield-leaderboard.tsx`
- `src/components/yield-detail-section.tsx`
- `src/components/dews-summary.tsx`
- `src/components/dews-detail.tsx`
- `src/components/stablecoin-detail/hero-card.tsx`
- `src/components/flow-summary-card.tsx`
- `src/components/flow-brrr-overview.tsx`
- `src/app/depeg/client.tsx`
- `src/app/liquidity/client.tsx`
- `src/app/yield/page.tsx`
- `src/app/depeg/page.tsx`
- `src/app/flows/page.tsx`
- `src/app/safety-scores/page.tsx`
- `src/app/blacklist/page.tsx`
- `docs/methodology-page.md`
- `docs/stability-index.md`
- `docs/report-cards.md`
- `docs/dex-liquidity.md`
- `docs/yield-intelligence.md`
- `docs/dews.md`
- `docs/depeg-detection.md`
- `docs/mint-burn-flows.md`
- `docs/blacklist-tracker.md`

Validation also included a rendered browser pass on:

- `/methodology`
- `/stablecoin/usdt-tether`
- `/liquidity`
- `/yield`
- `/depeg`
- `/flows`

## Current State

Pharos already exposes methodology in three ways:

1. A canonical long-form reference page at `/methodology`
2. Version and changelog links in feature-page headers
3. A small number of local explanations inside certain components

That is directionally correct, but not yet systematic.

## Main Findings

### 1. Methodology presence is visible, but not local enough

Most top-level pages show `Methodology vX.Y` plus a `Version history` link in the header through `FeaturePageShell`.

That confirms provenance, but it does not answer the question users usually have at the moment of interpretation:

- "What exactly is this score measuring?"
- "Why did this value move?"
- "Why is this unrated?"
- "What is included in this dimension and what is not?"

Those questions happen at the card, row, chart, and table-cell level, not at the page header.

### 2. Disclosure patterns already exist, but they are inconsistent

The app currently uses several partial patterns:

- Radix tooltip content in `yield-leaderboard.tsx` and parts of `dex-liquidity-card.tsx`
- native `title` tooltips in multiple places
- native `<details>` blocks in `report-card.tsx`, `yield-detail-section.tsx`, and `hero-card.tsx`
- a full methodology card on the Stability Index page
- page-lead explanatory paragraphs on feature pages

The product already has the raw ingredients for contextual methodology. The gap is that there is no shared disclosure model telling the user:

- what gets a tiny hint
- what gets an inline breakdown
- what gets a deeper expandable explainer
- what should deep-link to `/methodology`

### 3. Different metrics need different disclosure depth

Not every metric should get the same treatment.

Examples:

- `Peg Score`, `Liquidity Score`, `PYS`, `DEWS`, `PSI`, and `Bank Run Gauge` are composite, user-facing signals and need local explanation
- `Average Yield`, `Total DEX TVL`, or `Coins at Peg` usually need a short definition only
- failure states like `NR`, caps, penalties, and fallback rates need explicit "why" context near the affected value

### 4. The stablecoin detail page is the highest-value insertion point

The stablecoin detail route is where users encounter the broadest set of computed signals in one session:

- Peg Score
- Safety Score
- Yield Intelligence / PYS
- Mint/Burn Flows
- DEX Liquidity
- Depeg history

This is the best place to contextualize methodology because users are already in research mode and comparing dimensions on one asset.

### 5. Tooltip-only is not enough

Hover tooltips can solve small-definition problems, but they are not enough for:

- mobile users
- composite-score interpretation
- explaining NR and penalties
- explaining weighted dimensions or score components

The right solution is a disclosure ladder, not "add more tooltips everywhere."

## Recommended Disclosure Model

Use a three-level system across computed metrics.

### Level 1: Inline hint

Best for:

- short definitions
- threshold summaries
- one-sentence "what this means"

Pattern:

- info trigger attached to metric label or badge
- 1 short paragraph max
- optional 1-line formula fragment
- always ends with a deep link to the relevant `/methodology` anchor when useful

Good fits:

- `PSI`
- `DEWS`
- `PYS`
- `Liquidity Score`
- `Peg Score`
- `Effective TVL`
- `Pressure Shift vs 30D`
- `Bank Run Gauge`
- `Coverage class`

### Level 2: Inline expandable breakdown

Best for:

- composite-score explanation
- weights and components
- "why this score looks like this"
- penalty or cap explanation

Pattern:

- native `<details>` or compact disclosure panel inside the same card or row
- visible label such as `How this score works`, `Why NR?`, `Score breakdown`, or `What moved this?`
- remains attached to the component instead of navigating away

Good fits:

- `Safety Score`
- `Liquidity Score`
- `PYS`
- `Peg Score`
- `Flow pressure`
- `DEWS` signal stack

### Level 3: Deep reference

Best for:

- formulas
- edge cases
- methodology version notes
- changelog history

Pattern:

- targeted deep link to `/methodology#section-anchor`
- optional changelog link when version history matters

This should remain the canonical source of truth, but the app should stop making users start there.

## Surface-by-Surface Recommendations

### 1. Stablecoin detail hero

Current state:

- `Peg Score` and liquidity headline are visible immediately
- some edge-case explanation exists for `NR` and fallback peg rate
- no standard "what is this score?" affordance

Recommendation:

- add a Level 1 inline hint to `Peg Score`
- add a Level 1 inline hint to the liquidity headline when shown in the hero
- add Level 2 `Why NR?` / `How scored` disclosures only when relevant

Reason:

This is the first place users try to interpret Pharos-specific signals.

### 2. Safety Score card

Current state:

- `Show score breakdown` exists for base score vs peg multiplier
- dimension details exist, but they read like raw internals rather than guided interpretation
- no concise local definition of the overall score model

Recommendation:

- add a Level 1 inline hint on `Safety Score`
- add Level 1 hints on dimension labels where the label is not self-evident to new users, especially `Dependency Risk` and `Resilience`
- keep the existing breakdown, but frame it more explicitly as methodology context
- add direct deep links to the relevant methodology section from the card itself

Reason:

This is likely the most important computed score in the product, and users will ask what is weighted, what is penalized, and what is just descriptive context.

### 3. DEX Liquidity page and detail card

Current state:

- the page lead explains the score well
- the detail card already has one real tooltip for `Effective`
- the score breakdown uses native `title` attributes instead of consistent rich help

Recommendation:

- standardize all liquidity component definitions into Level 1 inline hints
- add one Level 2 `How liquidity is scored` disclosure near the score itself
- explicitly explain `coverage class`, `effective TVL`, and `unrated / not observed`

Reason:

Liquidity already has rich methodology, but the local presentation is split between page intro, native titles, and component bars.

### 4. Yield Intelligence and PYS

Current state:

- `PYS` already has one of the better local breakdowns in both leaderboard and detail views
- the page header explains risk-adjusted yield in prose
- definitions for warning signals and source arbitration remain distributed

Recommendation:

- keep PYS as the model for compact contextual explanation
- add a Level 1 inline hint to the `PYS` column header and detail-card label
- add Level 1 hints for `Safety`, `Yield Stability`, and `warning signals`
- add a small Level 2 explainer for source provenance and confidence-weighted source arbitration

Reason:

Yield already demonstrates that local breakdowns work. It is a strong candidate for standardizing the pattern elsewhere.

### 5. Stability Index page

Current state:

- this page already includes a full local methodology card
- it is more complete than other feature pages

Recommendation:

- do not add more hover help here by default
- instead use PSI as the pattern source for other pages
- optionally add Level 1 hints to chart legends or component labels if users struggle with `Severity`, `Breadth`, and `Stress Breadth`

Reason:

This page is already close to the right depth. The bigger opportunity is to export its clarity to other surfaces.

### 6. Depeg Tracker and DEWS

Current state:

- DEWS radar is visually strong but conceptually dense
- stats such as `Active Depegs`, `Median Deviation`, and `Worst Current` are legible but lightly framed
- `Peg Score` and `DEWS` are discussed in page-level copy, not tightly coupled to every interaction point

Recommendation:

- add a Level 1 inline hint to the `DEWS` label in the radar and any DEWS badge usage
- add Level 1 hints to `Peg Score` wherever it appears in tables
- add a Level 2 `What drives DEWS` disclosure that summarizes the 8 signals without forcing a route change
- add a targeted `How depeg events are confirmed` explainer near event history or event feed views

Reason:

DEWS is a Pharos-native concept. It needs local explanation more than commodity metrics do.

### 7. Mint/Burn Flows

Current state:

- the page copy explains `Net flow`, `Pressure Shift vs 30D`, and `Bank Run Gauge`
- the main overview is expressive, but the score logic still depends on reading the intro
- the stablecoin detail flow section has almost no methodology context

Recommendation:

- add a Level 1 hint to `Pressure Shift vs 30D`
- add a Level 1 hint to `Bank Run Gauge`
- add Level 2 `How pressure is measured` on both the main flows page and the per-coin flow summary card
- explicitly label Ethereum-only scope as methodology context, not just coverage context

Reason:

This feature uses product-specific terms that are meaningful only if the baseline-relative logic is explained locally.

### 8. Blacklist Tracker

Current state:

- less formula-heavy than the score pages
- methodology is mostly about event scope, sources, and semantics

Recommendation:

- lower priority
- use small Level 1 hints on `destroy`, `freeze`, and scope/coverage where needed
- do not overbuild a score-style explainer system here

Reason:

The user problem here is usually event semantics, not formula interpretation.

## Recommended Shared Patterns

If this moves forward, the product should converge on a small set of reusable disclosure components instead of one-off solutions.

### Pattern A: Metric label help

Use for one-sentence definitions.

Required characteristics:

- attached to the label, not floating elsewhere
- keyboard accessible
- works on touch
- can include an anchor link to `/methodology`

### Pattern B: Score breakdown tray

Use for composite scores.

Required characteristics:

- visible inside the same card or row
- compact by default
- opens inline, not in a modal
- can show weights, penalties, caps, and NR reasons

### Pattern C: Methodology footer line

Use for important score cards.

Example shape:

- `Methodology v5.6`
- `How scored`
- `Version history`

This creates a consistent "explainability footer" across score-bearing surfaces.

### Pattern D: Exception explainer

Use only when the displayed value is surprising:

- `NR`
- capped score
- fallback peg rate
- degraded coverage
- insufficient history

This should be conditional. It does not need to appear in normal cases.

## Content Rules

If contextual methodology is added, the copy should follow strict limits.

### Tooltips / inline hints

- one idea only
- under roughly 20 words for the first sentence
- avoid jargon unless the user already sees the same jargon in the metric label
- if a formula is shown, keep it fragment-sized

### Inline breakdowns

- explain the model in plain language first
- show weights or components second
- show caveats and exceptions last

### Deep links

- link to a precise anchor, not just `/methodology`
- keep terminology identical between the app and the methodology anchor

## Mobile Guidance

This should not be designed as desktop-hover help with a mobile afterthought.

Requirements:

- do not rely on hover as the only disclosure mechanism
- assume the user may be scrolling dense tables one-handed
- prefer tap-triggered inline disclosure over modal interruption
- reserve very small tooltips for low-stakes definitions only

For mobile, composite-score explanations should bias toward inline expansion, not tooltip bubbles.

## Anti-Patterns To Avoid

- adding an info icon to every metric on screen
- pushing every explanation into a modal
- hiding critical interpretation behind hover only
- repeating the same generic copy on every page
- treating methodology surfacing as pure decoration instead of user decision support
- adding rich disclosure to low-value metrics while leaving core scores unexplained

## Suggested Rollout Order

### Phase 1: Highest-value score surfaces

- stablecoin detail `Peg Score`
- stablecoin detail `Safety Score`
- stablecoin detail `DEX Liquidity`
- yield `PYS`
- depeg `DEWS`
- flows `Pressure Shift vs 30D` and `Bank Run Gauge`

### Phase 2: Page-level standardization

- add a consistent methodology footer/action pattern to score-heavy cards
- replace native `title` tooltips with accessible shared help where needed
- add precise deep links to `/methodology` anchors

### Phase 3: Lower-priority semantic coverage

- blacklist terminology
- secondary leaderboard stats
- coverage and confidence terms across edge cases

## Recommended Direction

Do not frame this as "tooltips."

The stronger product direction is:

`Contextual explainability for computed metrics`

That should use:

- small hints for definitions
- inline breakdowns for composite scores
- direct methodology deep links for full details

The product already has the content. What it lacks is a consistent way to reveal it at the point of interpretation.

## Practical Recommendation

If only one exploration outcome is taken forward, it should be this:

Standardize an explainability pattern on the stablecoin detail page first, then extend the same pattern to the score-heavy feature pages.

Reason:

- highest density of computed metrics
- strongest research intent from users
- easiest place to prove whether contextual methodology actually reduces confusion
- lowest risk of adding UI noise across the entire product prematurely

## Implementation Note For A Future Follow-Up

When this moves from research to design or implementation, the next step should be a narrow plan, not a broad rollout.

Recommended pilot:

1. `Safety Score`
2. `Peg Score`
3. `Liquidity Score`
4. `PYS`

Those four cover the main disclosure patterns Pharos needs:

- weighted composite score
- historical peg metric
- component-scored market-depth metric
- risk-adjusted ranking metric
