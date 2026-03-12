# Stablecoin Detail Audit: `/stablecoin/usdc-circle/`

Date: March 12, 2026

Scope: stablecoin-specific detail page using `/stablecoin/usdc-circle/` as the rendered reference

Audit basis:
- code review of the route and supporting components
- browser pass on `http://localhost:3000/stablecoin/usdc-circle/`
- desktop check at `1280x720`
- mobile check at `390x844`
- dark mode and light mode review
- keyboard/hash-navigation spot checks
- runtime console inspection

## Anti-Patterns Verdict

Pass, with some template drift.

This page does not read as generic AI output overall. It avoids the usual AI tells from the frontend-design baseline:
- no purple/cyan dark-theme cliché
- no gradient text
- no glassmorphism overload
- no decorative hero KPI billboard pretending to be a product

The main drift comes from safer repetition patterns:
- the hero still leans on a familiar metric-card quartet
- the lower-page discovery areas (`Research Paths`, `Static Comparison Pages`, `Related Stablecoins`) become a stack of near-identical bordered link grids
- several custom interactions feel utilitarian rather than authored

Net: distinct enough to pass, but not fully exempt from safe dashboard habits.

## Executive Summary

- Total issues: 8
- Critical: 0
- High: 4
- Medium: 3
- Low: 1
- Overall quality score: 74/100

Most critical issues:
1. The sticky jump rail obscures section starts after hash navigation.
2. Primary controls miss WCAG 2.2 target-size minimum on touch.
3. The PYS explanation is hover-only and inaccessible on keyboard/touch.
4. Several custom controls lack explicit visible focus treatment.

Recommended next steps:
1. Fix the anchor-offset and target-size issues first.
2. Convert hover-only explanatory UI to keyboard/touch-safe controls.
3. Clean up custom focus states and chart mount behavior.
4. Reduce repetitive discovery-card stacks at the end of the page.

## Detailed Findings by Severity

### Critical Issues

None found.

### High-Severity Issues

#### 1. Sticky section rail hides the start of target sections

- Location: `src/components/longform-scrollspy-nav.tsx:63-79`, `src/app/stablecoin/[id]/client.tsx:154-195`, `src/components/stablecoin-detail/overview-section.tsx:34`
- Severity: High
- Category: Responsive
- Description: Clicking in-page section links such as `Overview` scrolls the page so the sticky jump rail sits on top of the destination content. In the browser repro, `#overview` landed with the top of the overview content visibly clipped under the sticky rail.
- Impact: The primary jump navigation looks unreliable. Users arriving from the rail or a shared `#section` URL miss the first heading/content and may think the section did not change correctly.
- WCAG/Standard: No clean WCAG mapping, but it is a significant in-page navigation usability defect.
- Recommendation: Add `scroll-margin-top`/`scroll-mt-*` to every target section, or intercept anchor clicks and scroll with an offset equal to the sticky rail height. Verify hash loads, keyboard navigation, and direct deep links.
- Suggested command: `/adapt`

#### 2. Primary touch targets are below the 44x44 minimum

- Location: `src/components/longform-scrollspy-nav.tsx:86-90`, `src/components/stablecoin-detail/hero-card.tsx:179-186`, `src/components/share-button.tsx:92-99`, `src/components/ui/button.tsx:23-31`
- Severity: High
- Category: Accessibility
- Description: Key interactive elements on this page are undersized:
  - the section-nav pills render at `38px` height in-browser
  - the hero `Compare` link renders at `40px` height in-browser
  - the `Share` trigger uses shadcn `size="sm"`, which is `h-8` (`32px`)
- Impact: On a touch-heavy page with horizontal section navigation and dense controls, missed taps become much more likely. This is especially problematic on mobile and tablet.
- WCAG/Standard: WCAG 2.2 SC 2.5.8 Target Size (Minimum)
- Recommendation: Raise primary targets to at least `44x44`. For pills and lightweight links, use `min-h-11`, more horizontal padding, and a larger click box than the visual label.
- Suggested command: `/adapt`

#### 3. PYS help content is hover-only

- Location: `src/components/yield-detail-section.tsx:210-233`
- Severity: High
- Category: Accessibility
- Description: The PYS breakdown appears only on `group-hover`. The trigger is a plain `div` with `cursor-help`, not a focusable control, and the content does not appear on focus or tap.
- Impact: Keyboard users and touch users cannot access the explanation behind a core score. That removes interpretability from one of the page’s main yield metrics.
- WCAG/Standard: WCAG 2.1.1 Keyboard, WCAG 1.4.13 Content on Hover or Focus
- Recommendation: Replace the hover-only wrapper with a real button plus accessible tooltip/popover behavior that opens on focus and click/tap, not only hover.
- Suggested command: `/harden`

#### 4. Several custom controls have no explicit focus-visible styling

- Location: `src/components/stablecoin-detail/hero-card.tsx:179-186`, `src/components/stablecoin-detail/hero-card.tsx:254-260`, `src/components/stablecoin-detail/hero-card.tsx:382-388`, `src/components/bluechip-header-badge.tsx:20-29`, `src/components/report-card.tsx:96-99`, `src/components/report-card.tsx:188-191`
- Severity: High
- Category: Accessibility
- Description: A number of custom links, buttons, and `summary` toggles define hover states but no shared `focus-visible` treatment. The page does use `pharos-focus-ring` in some places, but coverage is inconsistent.
- Impact: Keyboard users lose their place on a very dense page with many controls and hidden panels.
- WCAG/Standard: WCAG 2.4.7 Focus Visible
- Recommendation: Apply the shared `pharos-focus-ring` pattern or equivalent visible `focus-visible` styling to every custom interactive control, not just shadcn buttons.
- Suggested command: `/harden`

### Medium-Severity Issues

#### 5. The detail page emits Recharts size warnings on first render

- Location: runtime console during initial page load; likely candidates on this route include `src/components/radar-chart.tsx:41-74`, `src/components/yield-history-chart.tsx:466-581`, and `src/components/flow-chart.tsx:103-168`
- Severity: Medium
- Category: Performance
- Description: The page logs Recharts warnings on load: `The width(-1) and height(-1) of chart should be greater than 0...`. The exact emitting chart still needs tracing, but the issue is reproducible on this route.
- Impact: This is a sign that at least one chart is mounting before it has a stable container size. That can cause extra layout work, noisy consoles, and brittle rendering under slow or unusual viewport conditions.
- WCAG/Standard: None
- Recommendation: Trace the emitting chart, then ensure it only mounts once the parent has a stable size or an explicit min-height. Keep chart hydration consistent with container readiness.
- Suggested command: `/optimize`

#### 6. The horizontal section rail hides its overflow affordance on mobile

- Location: `src/components/longform-scrollspy-nav.tsx:78-79`
- Severity: Medium
- Category: Responsive
- Description: The in-page nav intentionally scrolls horizontally, but it also hides the scrollbar with `scrollbar-none` and provides no fade, cut-off cue, or alternate affordance.
- Impact: Mobile users can miss later sections like `Liquidity` and `Depeg History`, especially because the rail already consumes a full row of pills above the fold.
- WCAG/Standard: None
- Recommendation: Show a partial next pill, add a fade edge, restore a visible scrollbar on touch devices, or switch to a more compact overflow pattern.
- Suggested command: `/adapt`

#### 7. Contract address controls are too small for comfortable touch use

- Location: `src/components/key-info-card.tsx:194-216`, `src/components/key-info-card.tsx:231-240`
- Severity: Medium
- Category: Accessibility
- Description: Chain selectors render as `28x28` icons, and the copy-address control is an icon-only button with no padded hit area.
- Impact: The contract section is a high-value utility surface for power users, but the current hit areas make it harder to use quickly and accurately on touch devices or with limited motor precision.
- WCAG/Standard: WCAG 2.2 SC 2.5.8 Target Size (Minimum)
- Recommendation: Expand hit boxes to at least `44x44`, while preserving the compact visual style inside the target area.
- Suggested command: `/harden`

### Low-Severity Issues

#### 8. The bottom-of-page discovery stack drifts into repetitive card-grid filler

- Location: `src/app/stablecoin/[id]/page.tsx:91-167`
- Severity: Low
- Category: Responsive / UX
- Description: `Research Paths`, `Static Comparison Pages`, and `Related Stablecoins` are three consecutive discovery blocks built from very similar bordered-card patterns.
- Impact: The page stays usable, but the lower half starts feeling templated and longer than necessary. It weakens the authored feel that the upper analytical sections establish.
- WCAG/Standard: None
- Recommendation: Compress these into one stronger discovery module or progressively disclose them so the page ends on signal, not navigation repetition.
- Suggested command: `/distill`

## Patterns & Systemic Issues

- Custom interactive elements are inconsistent: shadcn buttons get focus rings, but many bespoke links/buttons/summaries do not.
- Sticky in-page navigation exists without section-level scroll offsets, so deep-link behavior is not actually finished.
- Touch sizing is repeatedly treated as optional on important controls.
- Lower-page discovery content overuses safe bordered-card repetition.
- Chart readiness is mostly handled well, but at least one chart on this route still mounts too early.

## Positive Findings

- The page passes the “AI slop” test overall. It feels like a real product, not a generated theme demo.
- The top fold is dense, fast to scan, and aligned with the Pharos brand: calm, technical, and practitioner-first.
- Dark mode and light mode both preserve the core hierarchy reasonably well.
- Heavy detail sections are dynamically imported in `src/app/stablecoin/[id]/client.tsx:26-61`, which is the right performance posture for a long route.
- The page uses meaningful semantics in several places:
  - hidden `h1` for the route shell
  - breadcrumb navigation
  - labeled section nav
  - chart figures with accessible labels
- The page earns its density with real analytical sections: safety, DEWS, reserves, charting, yield, flows, liquidity, and depeg history.

## Recommendations by Priority

### Immediate

1. Fix anchor offsets for every `#section` target.
2. Bring the section rail, compare/share controls, and contract controls up to `44x44`.
3. Replace the hover-only PYS helper with accessible disclosure behavior.

### Short-term

1. Standardize `focus-visible` treatment across all custom controls on the route.
2. Trace and eliminate the Recharts zero-size warning on page load.
3. Add a visible mobile affordance for horizontally overflowing section pills.

### Medium-term

1. Tighten the lower-page discovery stack into a smaller number of more intentional modules.
2. Audit the rest of the stablecoin detail variants, especially states with `NR`, active depegs, and multi-warning yield cards, for the same interaction issues.

### Long-term

1. Consolidate repeated detail-page interaction patterns into shared primitives so focus, target size, and sticky-nav behavior do not drift route by route.

## Suggested Commands for Fixes

- Use `/adapt` to fix sticky anchor offsets, mobile rail overflow affordance, and target sizing across the responsive surfaces.
- Use `/harden` to repair keyboard/touch accessibility for PYS help, contract utilities, and missing focus-visible states.
- Use `/optimize` to trace and remove the Recharts zero-dimension warning.
- Use `/distill` to simplify the bottom discovery stack and reduce repetitive card-grid filler.
