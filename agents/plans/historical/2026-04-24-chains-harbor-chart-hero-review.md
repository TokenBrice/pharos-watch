# Chains Harbor Chart Hero Review

Date: 2026-04-24

Scope: `/chains/` harbor chart hero module, especially `src/app/chains/nautical-chart.tsx` and `src/app/chains/nautical-chart.css`.

Implementation status:
- Immediate priorities implemented in `440f4450 feat(chains): smooth harbor chart interactions`.
- Short-term priorities implemented in `568662b5 feat(chains): improve harbor chart motion and mobile scale`.
- Medium-term priorities implemented in `626bf1e6 feat(chains): refine harbor chart depth and focus`.
- Long-term priorities implemented in `2be57ac3 refactor(chains): name harbor chart art palette`.

Assumptions:
- This is a flagship explanatory data-visualization, not a generic chart. The nautical metaphor should make chain supply distribution easier to understand while preserving Pharos' dense, calm financial-dashboard tone.
- The review is intentionally not an implementation pass. It identifies the highest effort/results opportunities for refinement, polish, animation smoothing, accessibility, and professional finish.

## Anti-Patterns Verdict

Pass with targeted refinement needed.

The module does not read as generic AI UI: it has a clear authored metaphor, real data encoding, stable geometry, and meaningful visual details. The highest-risk tells are not generic cards or gradients; they are animation coarseness and metaphor density. The current scene is impressive, but a few animations feel mechanically looped rather than physically motivated, and the mobile chart becomes more decorative than inspectable.

## Executive Summary

Issues found: 0 critical, 3 high, 5 medium, 4 low.

Top opportunities:
1. Make lighthouse beam movement feel intentional and physically smooth instead of linearly rotating between selected harbors.
2. Add a coherent selection/hover motion system for ships so interaction reads as precise and responsive.
3. Improve mobile presentation; the full chart currently compresses to about 356x95px on a 390px viewport, making ship/cargo detail difficult to inspect.
4. Normalize motion timing/easing so flags, waterline, harbor light, flame, and beam feel like one environment.
5. Add subtle depth/occlusion polish around water, reflections, and labels to reduce visual crowding.

Quality score: 8/10. The concept and core craft are strong; the next gains are polish and interaction quality, not structural replacement.

## High-Severity Opportunities

### H1. Lighthouse beam transition feels mechanical on harbor changes

Location: `src/app/chains/nautical-chart.tsx:137-160`, `src/app/chains/nautical-chart.css:150-156`

Category: Animation / Interaction

Description: The beam angle is updated via CSS variable and transitions with `transition: transform 6.2s linear`. Linear easing over 6.2s makes the beam feel like it is slowly dragging to the new target. During repeated hover across ships, this can lag behind the user's intent.

Impact: The lighthouse is the visual protagonist of the module. If its targeting feels delayed or robotic, the whole chart feels less professional despite the strong illustration.

Recommendation: Use a shorter, non-linear transition such as 900-1400ms with an ease-out curve. Consider separating "search sweep" from "target lock": on hover/focus, beam quickly retargets with eased motion; ambient beam shimmer continues via opacity only. Keep `prefers-reduced-motion` static.

Suggested command: `/animate`

### H2. Ship hover/focus lacks a physical response

Location: `src/app/chains/nautical-chart.tsx:1074-1094`, `src/app/chains/nautical-chart.css:157-179`

Category: Interaction / Polish / Accessibility

Description: Ships are interactive buttons and selection changes the harbor light, but the ship itself does not have a clear hover/focus lift, buoyancy, outline, or target ring. `nc-ship-lit` applies a glow, but it is not paired with a focused ship transform or an SVG-visible keyboard indicator.

Impact: The chart is beautiful, but the interaction feels less tactile than the visual craft promises. Keyboard users can tab to ships, but the focus indication is not strong enough inside the SVG scene.

Recommendation: Wrap each ship in a stable `g` with a class such as `nc-ship-target`, then use selected/focused state to add a tiny `translateY(-2px)`, hull glow, and an explicit focus ring or wake highlight. Keep the motion under 180ms for hover/focus and avoid changing geometry.

Suggested command: `/polish` plus `/animate`

### H3. Mobile chart compresses into an illustrative strip

Location: `src/app/chains/nautical-chart.css:17-31`, `src/app/chains/nautical-chart.tsx:980-992`

Category: Responsive / Usability

Description: On a 390px viewport, Playwright measured the chart SVG at roughly 356x95px, with `overflow-x: hidden` and no scroll width. This preserves the full composition, but ship names, cargo marks, and health encodings become hard to inspect.

Impact: Mobile users can see the metaphor but cannot reliably read the data encoded inside it. This weakens the chart's analytical value on narrow screens.

Recommendation: Use a mobile-specific chart mode. Options: keep full scene as a cinematic overview plus a selected-harbor detail rail immediately below, or enable horizontal pan at a minimum SVG width from the first mobile breakpoint. If preserving no-scroll is important, add a magnified selected harbor inset.

Suggested command: `/adapt`

## Medium-Severity Opportunities

### M1. Motion system lacks a shared timing language

Location: `src/app/chains/nautical-chart.css:46-193`

Category: Animation / Polish

Description: Current animations use unrelated durations: waterline 8s, flag 5s, lighthouse pulse 4.5s, beam 7s, harbor light 4.8s, water 5.2s, glint 3.4s, flame 1.1-1.6s. This creates activity, but not a unified harbor rhythm.

Impact: The scene can feel like several independent looping animations layered together rather than one environment.

Recommendation: Group motion into families: fire 1.2-1.8s, water/reflection 6-9s, selection highlight 3.5-5s, beam shimmer 5-7s. Use shared CSS variables for duration/easing and a consistent ease-in-out curve for ambient loops.

Suggested command: `/animate`

### M2. Water/reflection masking is good, but reflections are too literal and static

Location: `src/app/chains/nautical-chart.tsx:740-785`, `src/app/chains/nautical-chart.tsx:1051-1059`

Category: Visual Polish / Animation

Description: Reflections are mirrored ship silhouettes with a vertical fade and static wave lines crossing them. The result is readable, but the mirrored shapes can look rigid compared with the animated waterline.

Impact: The water layer is central to the scene. Static perfect mirroring slightly breaks the illusion.

Recommendation: Add a subtle horizontal ripple distortion impression without expensive filters: stagger two or three clipped reflection bands with tiny `translateX` drift, or overlay more irregular wave masks near hulls. Avoid SVG displacement filters unless performance is measured.

Suggested command: `/polish` or `/animate`

### M3. Visual hierarchy between data encodings could be clearer

Location: `src/app/chains/nautical-chart.tsx:604-735`, `src/app/chains/nautical-chart.tsx:1098-1112`

Category: UX / Visual Design

Description: The scene encodes hull length, hull color, pennant length, cargo marks, depth ticks, wakes, labels, harbor light, and beam target. The header explains the main encodings, but the scene itself gives nearly equal visual weight to many small marks.

Impact: New users may enjoy the scene but miss what to read first. Power users benefit once learned, but first-glance comprehension can improve.

Recommendation: Emphasize the current selected harbor as the only fully "lit" ship: selected ship gets cargo marks and light detail at full opacity, non-selected ships remain rich but slightly quieter. Alternatively, reveal secondary marks on hover/focus.

Suggested command: `/distill` plus `/polish`

### M4. SVG `<defs>` are repeated inside every ship

Location: `src/app/chains/nautical-chart.tsx:645-655`, `src/app/chains/nautical-chart.tsx:703-708`

Category: Code Quality / Performance

Description: Each ship renders clip paths inside local `<defs>` blocks. It is functionally correct and small at eight ships, but it contributes to component density and makes future visual edits harder.

Impact: Low runtime risk today, but the component is already long and hand-authored. Repeated inline defs make maintenance and review more expensive.

Recommendation: Extract id builders and possibly `ShipCargoMarks` / `ShipSeal` subcomponents. Keep the current geometry style, but reduce repeated JSX blocks before adding more polish.

Suggested command: `/extract`

### M5. Hard-coded color literals are acceptable for SVG art, but should be named locally

Location: `src/app/chains/nautical-chart.tsx:18-27`, many SVG fill/stroke literals in `src/app/chains/nautical-chart.tsx:993-1022` and ship/lighthouse internals.

Category: Theming / Maintainability

Description: The chart intentionally uses many hard-coded SVG colors for art direction. That is defensible for a bespoke visualization, but the colors are scattered across the component.

Impact: Future polish will be slower and more error-prone. It is hard to rebalance scene contrast or light-mode behavior without hunting literals.

Recommendation: Keep local art constants near the top, not global tokens. Introduce a small `NAUTICAL_PALETTE` object for beam, flame, waterline, wood, sail cloth, and reflection colors.

Suggested command: `/normalize`

## Low-Severity Opportunities

### L1. Label readability varies by ship position

Location: `src/app/chains/nautical-chart.tsx:1098-1112`

Description: Labels sit directly over the water background at low opacity. They are elegant, but can get quiet under reflections and wave marks.

Recommendation: Add a subtle text shadow or a low-opacity backing stroke using duplicated text. Keep opacity restrained.

### L2. Health-band legend is disconnected from hull color

Location: `src/app/chains/nautical-chart.tsx:962-977`, `src/app/chains/nautical-chart.tsx:604-617`

Description: The legend shows health bands as badges, while hulls mostly read as wood plus accent stripe. The health encoding may not be immediately obvious.

Recommendation: Consider tinting a small hull plate or keel band with health color, or add a selected-harbor health chip in-scene.

### L3. Background fleet is underused

Location: `src/app/chains/nautical-chart.tsx:847-860`, `src/app/chains/nautical-chart.tsx:1043-1044`

Description: The horizon fleet elegantly hints at omitted chains, but it has little semantic weight beyond hidden titles.

Recommendation: Add a faint "other chains" count marker or make the horizon fleet size/position reflect omitted supply. Keep it subtle.

### L4. Console warnings from images are outside the chart but visible during page verification

Location: Runtime warning on `/chains/`; likely selected-harbor detail logos below the chart, not the SVG `<image>` elements.

Description: Playwright console showed Next image warnings about width/height aspect-ratio modification for several stablecoin logos.

Recommendation: Triage separately in the selected-harbor detail module. It does not appear to block the harbor chart but affects page polish.

## Positive Findings

- The chart has a distinctive, data-backed metaphor that fits the Pharos brand.
- The top-eight chain cap keeps the hero from becoming visually overloaded.
- SVG geometry is deterministic and test-covered.
- Keyboard interaction exists for ship selection.
- `prefers-reduced-motion` is partially respected for the beam transform.
- Recent lighthouse grounding work meaningfully improved the scene's physical credibility.
- The selected-harbor light wash is a better interaction indicator than a generic dotted frame.

## Recommended Priority

Immediate:
1. Smooth beam retargeting and make it feel like a target lock, not a slow linear drag.
2. Add a visible ship focus/hover/selected response that works for pointer and keyboard users.

Short-term:
1. Decide the mobile behavior: cinematic overview plus detail inset, or horizontally pannable analytical chart.
2. Normalize animation durations/easing into a small motion system.

Medium-term:
1. Refine water/reflection depth so the scene feels less static.
2. Quiet non-selected secondary marks and make the active harbor the focal point.
3. Extract repeated SVG substructures before adding more animation complexity.

Long-term:
1. Consolidate the nautical palette into local constants.
2. Give the background fleet a clearer but still subtle data role.
