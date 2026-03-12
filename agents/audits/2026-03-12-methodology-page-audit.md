# Methodology Page Audit

Date: 2026-03-12
Route: `/methodology`
Audited surface: `src/app/methodology/page.tsx`

Validation performed:
- Source review of `src/app/methodology/page.tsx`, `src/components/longform-scrollspy-nav.tsx`, and `src/components/methodology-mode-toggle.tsx`
- Rendered checks in Playwright at desktop and mobile breakpoints, plus light mode
- `axe-core` WCAG A/AA scan on the rendered page
- Production build via `npm run build`

## Anti-Patterns Verdict

Pass, with caveats.

This does not read as generic AI-generated UI. The typography scale, restrained accent usage, and dense reference-manual tone feel authored and consistent with Pharos. The near-misses are:

- repeated rounded card shells stacked inside larger rounded card shells
- intro scaffolding that repeats information before the actual methodology starts
- section treatments that become visually uniform over a long scroll

Those are quality issues, not a full AI-slop failure.

## Executive Summary

- Total issues: 4
- Critical: 0
- High: 1
- Medium: 2
- Low: 1
- Overall quality score: 8/10

Most critical issues:
- Mobile hides the only Reader/Analyst mode control while the page still explains that feature.
- The mobile top fold is consumed by orientation chrome instead of the methodology itself.
- The in-page jump rail is workable but undersized for touch and horizontally scroll-only.

Recommended next steps:
1. Restore Reader/Analyst mode access on mobile.
2. Distill the intro so the first methodology section lands in the first mobile viewport.
3. Rework the jump rail for mobile touch ergonomics and clearer overflow affordance.

## Detailed Findings By Severity

### Critical Issues

None.

### High-Severity Issues

#### 1. Reader/Analyst mode is unavailable on mobile even though the page advertises it

- Location: `src/app/methodology/page.tsx:174-183`, `src/components/methodology-mode-toggle.tsx:38-57`
- Severity: High
- Category: Responsive / Accessibility
- Description: The page renders the mode toggle inside `hidden md:block`, so the primary disclosure control disappears below `md`. In the rendered 390x844 mobile viewport, Playwright measured both mode buttons at `0x0`, confirming they are not accessible. The adjacent "Reader Guide" copy still tells users that Analyst mode exists and expands the page.
- Impact: Mobile users are told about a core page feature they cannot use. On a reference page whose main complexity-management pattern is disclosure, this removes feature parity on the breakpoint that needs it most.
- WCAG/Standard: Frontend-design responsive guideline: "Don't hide critical functionality on mobile." No direct WCAG A/AA failure was detected by `axe`, but this is a clear responsive usability regression.
- Recommendation: Keep the mode control available on mobile, or replace it with an equivalent mobile-specific pattern such as an inline segmented control above the first section.
- Suggested command: `/adapt`

### Medium-Severity Issues

#### 2. The mobile top fold is over-explained and pushes the actual methodology below the first screen

- Location: `src/app/methodology/page.tsx:156-214`
- Severity: Medium
- Category: Responsive
- Description: The mobile first viewport contains the page title, a Reader Guide panel, the sticky jump rail, and the full "How to Read This Page" explainer before the first methodology section begins. In the rendered 390x844 viewport, the first section card started at `1121.95px`, well below the fold.
- Impact: This page is explicitly framed as a reference manual, but mobile users must scroll past multiple layers of framing before reaching the content they came for. That increases time-to-insight and weakens the power-user feel.
- WCAG/Standard: Frontend-design guidance against redundant copy and overusing scaffolding before core content.
- Recommendation: Compress or merge the Reader Guide and "How to Read" blocks on small screens so at least part of the first methodology section is visible above the fold.
- Suggested command: `/distill`

#### 3. The jump rail is horizontally scroll-only and its touch targets are undersized for mobile

- Location: `src/components/longform-scrollspy-nav.tsx:78-95`
- Severity: Medium
- Category: Responsive / Accessibility
- Description: On mobile, the jump rail relies on horizontal scrolling (`scrollWidth 1121px` vs `clientWidth 356px`). The first jump pills measured `38px` tall in Playwright, below the commonly accepted `44px` touch-target preference for thumb interaction.
- Impact: The page is long, so the jump rail is important navigation. Small pill targets inside a horizontally scrolling strip increase precision demands and make one-handed use more error-prone.
- WCAG/Standard: Below platform touch-target guidance (44x44 preferred). Note: this still clears WCAG 2.2 `2.5.8 Target Size (Minimum)` at 24x24, so this is a quality/usability issue rather than an AA blocker.
- Recommendation: Increase target height on mobile and consider a wrapped two-row layout, a compact dropdown, or stronger overflow cues for the horizontal rail.
- Suggested command: `/adapt`

### Low-Severity Issues

#### 4. The page leans too hard on nested card patterns, which flattens hierarchy over a long scroll

- Location: `src/app/methodology/page.tsx:185-214` and repeated section card/fact-grid/detail-panel patterns throughout the route
- Severity: Low
- Category: Theming / Anti-pattern
- Description: The page repeatedly nests rounded cards inside rounded cards: the intro explainer card contains four smaller cards, while each section card contains additional fact tiles and disclosure boxes. The structure is disciplined, but over eight sections it starts to feel mechanically repeated.
- Impact: Scanability drops because sections start to feel interchangeable. This is also the page's main brush with the frontend-design anti-patterns around wrapping everything in cards and repeating identical card grids.
- WCAG/Standard: Frontend-design anti-pattern guidance against card-overuse and identical card grids.
- Recommendation: Flatten some of the inner surfaces or vary section rhythm so the page reads as an editorial reference, not a stack of repeated modules.
- Suggested command: `/distill`

## Patterns & Systemic Issues

- Mobile adaptation is the main weak spot. The page is stronger on desktop than on the breakpoint where progressive disclosure and fast scanning matter most.
- Introductory framing is repeated in multiple places. The route explains itself more than once before it starts delivering methodology.
- Visual hierarchy depends heavily on borders and rounded containers rather than stronger changes in rhythm, spacing, or sectional composition.

## Positive Findings

- `axe-core` returned **0 WCAG A/AA violations** on the rendered page.
- Semantic structure is solid: one `h1`, clear `h2`/`h3` hierarchy, proper nav landmarks, and native `details/summary` disclosures.
- No full-page horizontal overflow was present on the 390px viewport; only the jump rail intentionally scrolls.
- Dark and light themes both rendered cleanly with no obvious contrast regression during manual review.
- `npm run build` completed successfully and `/methodology` was prerendered cleanly.

## Recommendations By Priority

1. Immediate
   - Restore mobile access to Reader/Analyst mode.
2. Short-term
   - Compress the mobile top fold so users reach actual methodology sooner.
   - Improve mobile jump-rail ergonomics.
3. Medium-term
   - Reduce nested card repetition and introduce more sectional rhythm.
4. Long-term
   - Revisit the longform template for other reference-heavy routes so the same mobile/scaffolding issues do not spread.

## Suggested Commands For Fixes

- Use `/adapt` to restore mobile access to the mode toggle and improve jump-rail ergonomics.
- Use `/distill` to remove redundant intro scaffolding and flatten repeated card nesting.
- Use `/polish` for final spacing, hierarchy, and target-size refinement after the structural fixes land.
