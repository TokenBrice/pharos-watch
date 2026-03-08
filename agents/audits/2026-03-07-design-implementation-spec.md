# Pharos Design Implementation Spec

Date: March 7, 2026  
Source audit: `agents/audit/2026-03-07-design-audit-pharos-watch.md`  
Live baseline audited: `https://pharos.watch`  
Evidence set: `output/playwright/pharos-audit/`

## Purpose

This document converts the design audit into an execution-ready implementation plan for autonomous agents. It is intended to be sufficient for end-to-end execution without additional clarification.

The goal is not a visual reboot. The goal is to preserve the current dark-first, research-focused identity while removing the parts of the product that still feel unfinished, overly dense, or fragile on mobile.

## Non-Negotiables

- Preserve the existing dark-first Pharos brand direction.
- Do not edit `src/components/ui/*`.
- Keep Tailwind classes static strings.
- Keep `Geist` and `Geist Mono` as the primary font system.
- Do not introduce a broad new color palette. Tighten the current one.
- Preserve desktop data density on flagship pages unless this spec explicitly calls for a structural change.
- Do not remove routes or features unless this spec explicitly says to do so.
- Any reusable style, token, or shared UX pattern change must update:
  - `docs/design-language.md`
  - `docs/design-tokens.md` if tokens or semantic mappings change
- Every task must finish with:
  - `npm run build`
  - `npm run lint`
  - `npm test`
  - before/after screenshots for affected routes at `1440px` and `390px`

## Default Product Decisions

Use these assumptions unless the user explicitly overrides them.

- `Status` remains publicly reachable but stays `noindex`. Do not remove the route.
- `Compare` and `Portfolio` should not auto-populate data on first load. Presets should remain explicit user actions.
- The homepage should remain a combined dashboard + digest surface on desktop, but mobile should prioritize utility over editorial depth.
- The footer should remain present on all pages, but its link density should be reduced.
- The mobile solution for feedback and scroll controls should be a shared utility treatment, not separate floating widgets.
- The methodology page remains longform and technical; the goal is scanability, not simplification of content.

## Shared File Hotspots

These files are likely to cause merge conflicts. Do not run tasks touching the same hotspot in parallel unless one agent owns the file.

| Hotspot | Why it is sensitive |
|---|---|
| `src/app/globals.css` | shared layout, motion, and utility changes |
| `src/components/footer.tsx` | global footer seen on every route |
| `src/components/feature-page-shell.tsx` | shared header shell for most feature pages |
| `src/components/feedback-button.tsx` | global mobile overlap issue |
| `src/components/scroll-to-top.tsx` | interacts directly with floating control placement |
| `src/components/longform-scrollspy-nav.tsx` | shared by methodology and detail pages |
| `src/styles/tokens/primitives.css` | global type/spacing/radius changes |
| `src/styles/tokens/semantic.css` | global semantic color and motion changes |
| `docs/design-language.md` | multiple tasks must update this |
| `docs/design-tokens.md` | multiple tasks may update this |

## Parallelization Rules

- Safe to run in parallel:
  - `Compare`, `Portfolio`, and `Status`
  - `Blacklist` chart and `Yield` chart
  - `Dependency Map` mobile alternative and `Safety Scores` mobile flow
  - `404` and `Privacy`
- Must be serialized:
  - anything touching global floating controls
  - anything touching shared tokens
  - homepage hero/KPI changes
  - methodology shell and changelog template changes

## Execution Protocol For Autonomous Agents

For every task:

1. Read the target files listed in the task.
2. Implement only the scope described in that task.
3. Update `docs/design-language.md` if the visible shared behavior changes.
4. Update `docs/design-tokens.md` if tokens, scales, or semantic mappings change.
5. Run verification commands.
6. Capture before/after screenshots into `output/playwright/<task-id>/`.
7. If a task exposes a better shared abstraction than the current code but extraction is not listed in the task, do not extract yet unless duplication is severe.

## Verification Standard

Global commands:

```bash
npm run build
npm run lint
npm test
```

Viewport checks:

- Desktop: `1440x1200` minimum
- Mobile: `390x844`

Required route checks after any relevant UI task:

- `/`
- `/compare/`
- `/portfolio/`
- `/status/`
- `/methodology/`
- `/stablecoins/usd/`
- `/stablecoin/usdt-tether/`
- any task-specific route in scope

Definition of done for all tasks:

- No content overlap with floating controls at mobile width.
- No new console errors.
- No broken layout at desktop or mobile.
- No reduction in accessibility for focus, tap size, or readability.

## Phase 1 - Quick Wins

Phase 1 removes the highest-trust defects without changing the overall architecture.

### P1-01 Mobile Floating Controls Remediation

Goal: remove content overlap caused by fixed feedback and scroll controls.

Primary routes:

- `/`
- `/depeg/`
- `/yield/`
- `/stablecoins/usd/`
- `/privacy/`
- `/methodology/`

Files:

- `src/components/feedback-button.tsx`
- `src/components/scroll-to-top.tsx`
- `src/app/layout.tsx`
- `src/app/globals.css`
- `docs/design-language.md`

Implementation:

- Replace the current mobile floating pill with a shared mobile utility treatment.
- Preferred implementation:
  - render a compact circular feedback button on mobile only
  - render it inside a bottom utility dock or safe-area-aware rail
  - merge `Feedback` and `Scroll to top` into one shared mobile placement system
- On `sm` and above, keep the current floating behavior unless layout refinement is needed.
- Add mobile-safe content padding so the bottom utility treatment never covers final lines of text or lower chart edges.
- If adding a shared dock, place it in the app shell rather than per-page.

Acceptance criteria:

- At `390px`, no fixed control overlaps paragraph text, chart plotting area, table columns, filter chips, or footer links.
- The feedback affordance remains visible and reachable on mobile.
- The scroll-to-top control does not stack on top of feedback.
- No desktop regression.

Verification:

- Screenshot mobile and desktop for all primary routes.
- Manually confirm the bottom-right corner of tables and charts is clear.

Parallelization:

- Must run alone against other floating-control or global CSS tasks.

### P1-02 Compare Empty State Redesign

Goal: make the compare page feel launched, not empty.

Primary route:

- `/compare/`

Files:

- `src/app/compare/client.tsx`
- optional new component: `src/components/compare-empty-state.tsx`
- `docs/design-language.md`

Implementation:

- Replace the current dashed empty well with a guided onboarding surface.
- Keep the 5 selectors, but add:
  - a 3-step explainer
  - preset chips or cards with stronger visual priority
  - a non-interactive preview skeleton of the comparison output
- Do not auto-populate a comparison by default.
- Preserve the current presets list; only improve hierarchy and presentation.
- Keep the share controls hidden until at least 2 coins are selected.

Acceptance criteria:

- The empty state explains how to use the feature without relying on surrounding page copy.
- The first screen contains useful visual guidance, not a large empty field.
- The first useful explanatory content appears before `160px` of dead vertical space.

Verification:

- Desktop and mobile screenshots of empty state.
- One screenshot with a populated comparison to ensure no regression.

Parallelization:

- Can run in parallel with `P1-03`, `P1-04`, `P1-07`, `P1-08`.

### P1-03 Portfolio Empty State Redesign

Goal: make portfolio onboarding trustworthy and self-explanatory.

Primary route:

- `/portfolio/`

Files:

- `src/app/portfolio/client.tsx`
- optional new component: `src/components/portfolio-empty-state.tsx`
- `docs/design-language.md`

Implementation:

- Keep the holdings editor card, but add a first-run onboarding module below or integrated into it.
- Add:
  - preset starting portfolios
  - one short privacy/storage note: holdings are stored locally only
  - a preview of the eventual output: grade, radar, upstream exposure
- Keep sharing and clear controls hidden until holdings exist.
- Do not restructure the populated portfolio summary in this phase.

Acceptance criteria:

- A first-time user can understand what the page does without adding a coin.
- The route no longer presents a large empty void below the selector.
- The local-storage/privacy behavior is visible without opening dev tools or docs.

Verification:

- Desktop and mobile screenshots of the empty state.
- One screenshot with sample holdings populated to verify no regression.

Parallelization:

- Can run in parallel with `P1-02`, `P1-04`, `P1-07`, `P1-08`.

### P1-04 Status Access Screen Framing

Goal: make the public access screen look intentional and secure.

Primary route:

- `/status/`

Files:

- `src/app/status/client.tsx`
- `src/components/status/admin-key-form.tsx`
- `src/components/feature-page-shell.tsx` only if needed
- `docs/design-language.md`

Implementation:

- Keep the route public and `noindex`.
- Redesign the unauthenticated state as a secure-access screen:
  - elevate the access card higher in the viewport
  - add one short explanatory paragraph
  - add a concise support or fallback line
  - keep the return link
- Avoid the current effect where the card looks stranded in a large empty field.
- Do not change the authenticated dashboard in this phase.

Acceptance criteria:

- The unauthenticated screen reads as deliberate secure access, not accidental public exposure.
- The form card is visually anchored in the upper-middle viewport region on both desktop and mobile.
- The route still behaves exactly the same functionally.

Verification:

- Desktop and mobile screenshots of unauthenticated state.
- Manual sign-in sanity check if credentials are available. If not, verify only the unauthenticated state.

Parallelization:

- Can run in parallel with `P1-02`, `P1-03`, `P1-07`, `P1-08`.

### P1-05 Homepage Mobile Hierarchy And Digest Compaction

REMOVED - ALREADY IMPLEMENTED, IGNORE

### P1-06 Footer Simplification

Goal: reduce footer clutter and duplicate navigation load.

Primary routes:

- all routes

Files:

- `src/components/footer.tsx`
- `docs/design-language.md`

Implementation:

- Reduce the primary footer route list to the most important product destinations.
- Keep social links and disclaimer.
- Keep category browsing, but reduce its prominence and duplication on mobile.
- Increase spacing between:
  - route links
  - social links
  - category browse control
  - disclaimer

Acceptance criteria:

- The footer no longer reads like a duplicate sitemap.
- On short mobile pages, the footer is lighter and easier to exit.
- No broken links and no missing critical destinations.

Verification:

- Desktop and mobile screenshots on home, privacy, and 404.

Parallelization:

- Must not overlap with another task editing `src/components/footer.tsx`.

### P1-07 Blacklist Hero Chart Refinement

Goal: make the top chart feel analytical rather than placeholder-like.

Primary route:

- `/blacklist/`

Files:

- `src/components/blacklist-chart.tsx`
- `src/lib/chart-colors.ts` only if needed
- `docs/design-language.md`

Implementation:

- Reduce chart height:
  - desktop target about `280px`
  - mobile target about `220px`
- Replace or refine the stacked-bar treatment so the large cyan blocks no longer dominate visually.
- Improve axis readability and quarter labeling.
- Add one annotation or summary cue for the major spike periods.
- Preserve the existing data logic and tooltip accuracy.

Acceptance criteria:

- The chart communicates issuer-specific changes more clearly.
- The first screen on blacklist feels balanced relative to the table below.
- No loss of data fidelity.

Verification:

- Desktop and mobile screenshots.
- Sanity check tooltip totals against existing behavior.

Parallelization:

- Can run in parallel with `P1-02`, `P1-03`, `P1-04`, `P1-08`.

### P1-08 Yield Scatter Plot Refinement

Goal: make the chart visually denser and easier to interpret.

Primary route:

- `/yield/`

Files:

- `src/app/yield/client.tsx`
- `src/components/yield-scatter-plot.tsx`
- `src/lib/yield-scatter.ts` if domain logic must change
- `docs/design-language.md`

Implementation:

- Reduce chart height:
  - mobile target about `240px`
  - desktop target about `340px`
- Tighten vertical dead space around the chart.
- Improve the quadrant explanation so users immediately understand:
  - below risk-free rate
  - high-yield / low-safety danger
  - high-safety / strong-yield sweet spot
- If domain clipping is too aggressive, refine the axis so the occupied area is easier to read.

Acceptance criteria:

- The scatter plot feels intentionally populated, not visually empty.
- Users can infer the "good zone" without reading the methodology.
- Clicking data points still navigates correctly.

Verification:

- Desktop and mobile screenshots.
- Click one point and verify route navigation.

Parallelization:

- Can run in parallel with `P1-02`, `P1-03`, `P1-04`, `P1-07`.

## Phase 2 - Structural Improvements

Phase 2 improves hierarchy and component behavior across the product.

### P2-01 Homepage Hero Hierarchy And Trust Strip

Goal: make the homepage top fold more opinionated and trustworthy.

Primary route:

- `/`

Files:

- `src/components/site-header.tsx`
- `src/components/kpi-bar.tsx`
- `src/components/homepage-client.tsx`
- optional new component: `src/components/home-trust-strip.tsx`
- `docs/design-language.md`
- `docs/design-tokens.md` only if shared spacing or type tokens change

Implementation:

- Make PSI the dominant metric in the top summary hierarchy.
- Compress secondary KPIs visually into a supporting row or smaller tiles.
- Add a compact trust strip near the masthead with items such as:
  - update freshness
  - sources
  - tracking scope
- Keep the current dark shell and mono stat styling.
- Do not convert the top fold into generic landing-page marketing.

Acceptance criteria:

- The eye lands on PSI first.
- The top fold communicates "live market intelligence" before the digest starts.
- Trust information is visible without adding visual noise.

Verification:

- Desktop and mobile screenshots of the homepage top fold.
- Confirm no increase in mobile vertical clutter.

Parallelization:

- Must not run in parallel with `P1-05`.

### P2-02 Methodology Information Architecture Overhaul

Goal: make the methodology page easier to navigate and read without reducing content.

Primary route:

- `/methodology/`

Files:

- `src/app/methodology/page.tsx`
- `src/components/longform-scrollspy-nav.tsx`
- `src/components/methodology-mode-toggle.tsx`
- optional new components:
  - `src/components/methodology-section-card.tsx`
  - `src/components/methodology-facts-grid.tsx`
  - `src/components/methodology-callout.tsx`
- `docs/design-language.md`

Implementation:

- Constrain longform content width for better reading.
- Preserve the scrollspy but make the navigation feel more robust and less tiny.
- Break repeated card structures into clearer tiers:
  - summary
  - quick facts
  - technical details
  - worked examples
- Reduce the sense that every section has equal weight.
- Keep reader/analyst mode, but make its purpose more legible.

Acceptance criteria:

- The methodology page feels like a polished reference manual, not a long settings screen.
- Section transitions are visually distinct.
- Reader mode remains lighter than analyst mode.

Verification:

- Desktop and mobile screenshots from top, middle, and one expanded technical section.
- Keyboard check for jump links and details disclosure.

Parallelization:

- Must not overlap with `P2-03` if both modify `LongformScrollspyNav`.

### P2-03 Methodology Changelog Template Overhaul

Goal: improve scanability across all methodology changelog routes through the shared template.

Primary routes:

- `/methodology/scoring-changelog/`
- `/methodology/depeg-changelog/`
- `/methodology/blacklist-tracker-changelog/`
- `/methodology/liquidity-score-changelog/`
- `/methodology/stability-index-changelog/`
- `/methodology/mint-burn-flow-changelog/`
- `/methodology/yield-changelog/`

Files:

- `src/components/methodology-changelog-page.tsx`
- `src/components/methodology-version-card.tsx`
- `src/app/methodology/changelog-route-factory.tsx` only if required
- `docs/design-language.md`

Implementation:

- Keep the shared route factory.
- Improve the latest-version summary card.
- Make historical entries easier to scan with stronger hierarchy for:
  - version
  - date
  - summary
  - impact bullets
  - reconstructed note
- Keep the per-route accent color, but reduce visual repetition.

Acceptance criteria:

- All changelog routes improve through the shared template.
- Latest version is clear at a glance.
- Long lists of versions remain readable without opening every entry.

Verification:

- Desktop and mobile screenshots on at least two changelog routes.
- Confirm every route still renders through the shared route factory.

Parallelization:

- Can run in parallel with `P2-04`, `P2-05`, `P2-06`, `P2-07`.

### P2-04 Dependency Map Mobile Alternative

Goal: provide a mobile mode that is readable, not just technically responsive.

Primary route:

- `/dependency-map/`

Files:

- `src/app/dependency-map/client.tsx`
- `src/components/contagion-graph.tsx`
- optional new component: `src/components/dependency-map-mobile-summary.tsx`
- `docs/design-language.md`

Implementation:

- Under mobile width, provide one of these behaviors:
  - a full-screen expand action for the graph
  - a ranked dependency summary list under the graph
  - both, if implementation stays clean
- Preserve the existing desktop graph.
- Keep the current controls and legend, but do not rely on users reading the tiny graph alone.

Acceptance criteria:

- On mobile, users can identify major dependency hubs without pinch-zooming.
- Desktop graph remains unchanged or improved.

Verification:

- Mobile screenshot of default state.
- Mobile screenshot of expanded or alternate summary view.
- Desktop screenshot for regression check.

Parallelization:

- Can run in parallel with `P2-03`, `P2-05`, `P2-06`, `P2-07`.

### P2-05 Stablecoin Detail Mobile Fold Reduction

Goal: make the mobile hero easier to scan while keeping critical metrics visible.

Primary routes:

- `/stablecoin/usdt-tether/`
- `/stablecoin/usdc-circle/`
- `/stablecoin/usde-ethena/`
- `/stablecoin/xaut-tether/`

Files:

- `src/app/stablecoin/[id]/client.tsx`
- `src/components/stablecoin-detail/hero-card.tsx`
- `src/components/longform-scrollspy-nav.tsx` if sticky section behavior changes
- `docs/design-language.md`

Implementation:

- Keep the hero card structure, but reduce first-screen density on mobile.
- Above the fold, show only the most important items:
  - token identity
  - price / peg status
  - market cap
  - primary score signal
- Move secondary KPIs into a collapsible block or lower section.
- Make the section jump rail easier to use after the hero.

Acceptance criteria:

- The mobile hero does not feel overloaded.
- Critical trust and score information is still present above the fold.
- Desktop layout remains intact.

Verification:

- Desktop and mobile screenshots for the primary routes.
- Confirm tabs / section jumps still work.

Parallelization:

- Can run in parallel with `P2-03`, `P2-04`, `P2-06`, `P2-07`.

### P2-06 Peg Directory And Shared Table Mobile Ergonomics

Goal: improve mobile table handling and right-edge usability.

Primary routes:

- `/stablecoins/usd/`
- `/stablecoins/gold/`
- homepage stablecoin directory

Files:

- `src/app/stablecoins/[peg]/client.tsx`
- `src/components/stablecoin-table.tsx`
- `src/components/stablecoin-table-column-visibility.tsx`
- `src/components/table-pagination.tsx` only if needed
- `docs/design-language.md`

Implementation:

- Improve mobile table toolbar spacing and right-edge affordances.
- Ensure the column tools and export button remain accessible without crowding the first row.
- Keep horizontal scrolling, but make the affordance clearer and less cramped.
- Ensure the table does not visually collide with footer content or mobile utility controls.

Acceptance criteria:

- At `390px`, the table tools are usable and the first visible columns remain readable.
- The rightmost edge no longer competes with floating controls.
- Desktop table behavior remains unchanged.

Verification:

- Mobile screenshots of homepage directory, USD directory, and Gold directory.
- One desktop regression screenshot.

Parallelization:

- Can run in parallel with `P2-03`, `P2-04`, `P2-05`, `P2-07`.

### P2-07 Safety Scores Mobile Control Flow

Goal: reduce first-screen compression on mobile.

Primary route:

- `/safety-scores/`

Files:

- `src/app/safety-scores/client.tsx`
- `src/app/safety-scores/page.tsx` only if lead copy changes
- `src/components/stress-test-panel.tsx`
- `src/components/report-card-mini.tsx` only if spacing needs adjustment
- `docs/design-language.md`

Implementation:

- Increase separation between:
  - grade distribution
  - contagion simulator
  - filters
  - score grid
- Collapse or defer secondary controls on mobile.
- Surface the first visible score cards sooner.
- Keep desktop density unless a cleaner shared implementation is obvious.

Acceptance criteria:

- The mobile first fold is less compressed.
- The user can understand the simulator before reaching the card grid.
- Desktop simulator behavior remains stable.

Verification:

- Desktop and mobile screenshots.
- Stress test interaction sanity check.

Parallelization:

- Can run in parallel with `P2-03`, `P2-04`, `P2-05`, `P2-06`.

### P2-08 Shared Onboarding Surface Extraction

Goal: reduce duplication across the new empty-state pages after Phase 1 is complete.

Primary routes:

- `/compare/`
- `/portfolio/`
- `/status/`

Files:

- any newly created phase-1 empty-state components
- optional new shared component: `src/components/empty-state-surface.tsx`
- `docs/design-language.md`

Implementation:

- Only do this after `P1-02`, `P1-03`, and `P1-04` are merged.
- Extract the common structure only if the compare, portfolio, and status implementations clearly share:
  - eyebrow
  - explainer list
  - CTA row
  - preview panel shell
- Do not over-abstract if the pages need different structures.

Acceptance criteria:

- Shared logic is reduced without forcing awkward props.
- Visual consistency improves across onboarding states.

Verification:

- Diff review for duplication reduction.
- Desktop and mobile screenshots across all three pages.

Parallelization:

- Must run after `P1-02`, `P1-03`, and `P1-04`.

## Phase 3 - Polish And Finish

Phase 3 addresses the remaining consistency and micro-quality issues.

### P3-01 Token Logo Normalization

Goal: reduce visual quality variance from third-party token assets.

Primary routes:

- homepage directory
- peg directories
- stablecoin detail pages
- comparison presets
- portfolio holdings

Files:

- `src/components/stablecoin-logo.tsx`
- `src/components/stablecoin-table.tsx`
- `src/components/stablecoin-detail/hero-card.tsx`
- `src/app/compare/client.tsx`
- `src/app/portfolio/client.tsx`
- `docs/design-language.md`

Implementation:

- Wrap token logos in a consistent container with:
  - neutral background
  - subtle ring
  - consistent sizing
- Ensure low-quality or transparent logos do not visually collapse into dark backgrounds.
- Keep the existing logo API and caching behavior.

Acceptance criteria:

- Logo quality variation is noticeably reduced without replacing upstream assets.
- No icon becomes blurrier or oversized.

Verification:

- Before/after comparison on at least:
  - home table
  - compare presets
  - stablecoin hero

Parallelization:

- Can run in parallel with `P3-02`, `P3-03`, `P3-04`, `P3-05`.

### P3-02 Badge Semantics And Accent Palette Tightening

Goal: make badge meaning clearer and reduce non-data color noise.

Primary routes:

- any route using `FeatureStatusBadge`
- methodology cards
- detail pages

Files:

- `src/components/feature-status-badge.tsx`
- `src/components/feature-page-shell.tsx`
- `src/app/methodology/page.tsx`
- `src/styles/tokens/semantic.css` only if semantic colors need tightening
- `docs/design-language.md`
- `docs/design-tokens.md` if tokens change

Implementation:

- Standardize badge semantics:
  - mature = green
  - experimental = amber
  - version = neutral
- Reduce decorative accent-border sprawl on non-data surfaces.
- Keep strong color only where it encodes actual status or risk.

Acceptance criteria:

- Badges are easier to interpret.
- The first screen of a page no longer carries too many competing accent colors.

Verification:

- Desktop and mobile screenshots on compare, yield, dependency map, methodology.

Parallelization:

- Can run in parallel with `P3-01`, `P3-03`, `P3-04`, `P3-05`.

### P3-03 Digest Editorial Rhythm Refinement

Goal: keep the digest voice but improve reading ergonomics.

Primary routes:

- `/digest/`
- `/digest/2026-03-07/`
- homepage digest block

Files:

- `src/components/daily-digest.tsx`
- `src/app/digest/page.tsx`
- `src/app/digest/[date]/page.tsx`
- `docs/design-language.md`

Implementation:

- Constrain longform width to about `68ch`.
- Reduce all-italic density where it hurts scanability.
- Add a compact executive-summary treatment where useful.
- Preserve the distinctive Pharos editorial tone.
- Do not rewrite content generation logic.

Acceptance criteria:

- Dedicated digest pages read more comfortably on desktop.
- Homepage digest remains compact and useful.
- Mobile digest pages feel less like a wall of italicized text.

Verification:

- Desktop and mobile screenshots for archive and one digest entry.

Parallelization:

- Can run in parallel with `P3-01`, `P3-02`, `P3-04`, `P3-05`.

### P3-04 Privacy And 404 Recovery/Support Pass

Goal: make sparse supporting pages feel deliberate.

Primary routes:

- `/privacy/`
- `404`

Files:

- `src/app/privacy/page.tsx`
- `src/app/not-found.tsx`
- `docs/design-language.md`

Implementation:

- `Privacy`:
  - keep the narrow reading column
  - add one support/contact or policy summary callout
  - tighten page rhythm so the page does not feel abandoned
- `404`:
  - keep the current mood and copy tone
  - add clear recovery routes:
    - dashboard
    - browse stablecoins
    - digest
    - search if practical

Acceptance criteria:

- Both pages feel intentionally designed.
- Recovery paths are obvious.

Verification:

- Desktop and mobile screenshots for both routes.

Parallelization:

- Can run in parallel with `P3-01`, `P3-02`, `P3-03`, `P3-05`.

### P3-05 Loading States And Chart First-Paint Stability

Goal: eliminate visual jank and reduce chart mount instability.

Primary routes:

- `/`
- `/blacklist/`
- `/yield/`
- any chart-heavy route touched in prior phases

Files:

- `src/components/kpi-bar.tsx`
- `src/components/blacklist-chart.tsx`
- `src/components/yield-scatter-plot.tsx`
- any chart component still producing unstable initial dimensions
- `src/app/globals.css` only if shared skeleton utilities are introduced
- `docs/design-language.md`

Implementation:

- Reserve exact chart heights from first paint.
- Align skeleton dimensions with final chart dimensions.
- Eliminate chart containers that can render with negative or unresolved width/height.
- Specifically verify the home page Recharts warnings observed during the audit.

Acceptance criteria:

- No visible jump when charts hydrate.
- No new console warnings related to chart dimensions on the affected routes.
- Skeletons closely match final chart footprints.

Verification:

- Console check on desktop and mobile for home, blacklist, yield.
- Before/after screenshots of loading states if possible.

Parallelization:

- Must be serialized with any other task touching the same chart file.

### P3-06 Microcopy Readability Pass

Goal: improve small-text readability without flattening the visual language.

Primary routes:

- footer
- methodology
- chart legends
- table metadata
- detail-page helper copy

Files:

- `src/app/globals.css`
- `src/styles/tokens/primitives.css` only if scale changes
- `src/styles/tokens/semantic.css` only if contrast changes
- `src/components/footer.tsx`
- `src/app/methodology/page.tsx`
- targeted components discovered during implementation
- `docs/design-language.md`
- `docs/design-tokens.md` if tokens change

Implementation:

- Raise minimum functional microcopy size on mobile where needed.
- Reduce overuse of low-opacity text for functional information.
- Keep decorative/secondary metadata quieter, but do not hide useful labels.

Acceptance criteria:

- Metadata and helper text are easier to scan on mobile.
- No global type scale regression.

Verification:

- Mobile screenshots on methodology, footer, and at least one chart-heavy page.

Parallelization:

- Must be serialized with any other token-scale task.

## Recommended Delivery Order

Recommended merge order inside each phase:

1. `P1-01`
2. `P1-02`, `P1-03`, `P1-04`, `P1-07`, `P1-08` in parallel
3. `P1-05`
4. `P1-06`
5. `P2-01`
6. `P2-02` and `P2-03`
7. `P2-04`, `P2-05`, `P2-06`, `P2-07` in parallel
8. `P2-08`
9. `P3-01`, `P3-03`, `P3-04`, `P3-05` where file overlap permits
10. `P3-02`
11. `P3-06`

## Required Documentation Updates

After any merged task:

- If shared visual behavior changes, update `docs/design-language.md`.
- If type scale, spacing, color semantics, radii, or motion tokens change, update `docs/design-tokens.md`.
- If a new reusable empty-state or page-shell pattern is introduced, document it in `docs/design-language.md`.

## Final Completion Checklist

The design implementation program is complete only when all of the following are true:

- No mobile content is obscured by floating controls.
- `Compare`, `Portfolio`, and `Status` no longer feel unfinished on first load.
- Homepage mobile hierarchy prioritizes stablecoin browsing before long prose.
- Methodology and changelog pages are materially easier to scan.
- Dependency map and stablecoin detail pages are more usable on mobile.
- Footer, badges, and supporting pages feel more intentional and less cluttered.
- Chart loading and first-paint behavior are stable.
- `docs/design-language.md` and `docs/design-tokens.md` reflect the shipped system.
