# UI Consistency Polish Audit - 2026-03-04

## Scope

Rendered audit using Playwright screenshots across:

- `/` (desktop + mobile)
- `/stability-index`
- `/depeg`
- `/liquidity`
- `/portfolio`
- `/blacklist`
- `/yield`

Goal: refine and normalize without redesigning page structures.

## Inventory Findings

### Hero & first-screen hierarchy

1. Homepage hero metadata line was too dense in a single run-on sentence, reducing scanability.
2. Hero stat container had slight rhythm mismatch between header strip, mobile mini-tiles, and desktop KPI cells.
3. Hero interactive cards (Market Highlights) used hover-only affordances with weaker keyboard focus visibility.

### Card, container, and spacing consistency

1. Several custom containers reused card-like styling ad hoc (`rounded-xl border ...`) with minor border/background variance.
2. Dense table shell and feature cards did not fully share the same interaction/focus treatment pattern.
3. Mobile mini KPI cards and skeleton variants used a similar but not fully unified surface treatment.

### Typography and semantic color consistency

1. Small-caps labels were mostly consistent but repeated with slight tracking/value drift across hero components.
2. Warning text tones mixed `yellow` and `orange` in the same KPI context.

### Interaction/accessibility polish

1. Some custom links/buttons relied on hover only, with no unified focus ring utility.
2. Table row auxiliary action icon (feedback flag) was visually hidden unless hover, reducing keyboard discoverability.

## Changes Implemented

### System-level style utilities (`src/app/globals.css`)

Added reusable utility classes to avoid one-off styling drift:

- `.pharos-kicker` for consistent tiny uppercase labels.
- `.pharos-focus-ring` for unified focus-visible treatment.
- `.pharos-card-shell` for consistent card-like border/background shell.
- `.pharos-interactive-card` for restrained hover transitions.

Also set `text-rendering: optimizeLegibility` on `body` for crisper typography.

### Hero refinements

#### `src/components/site-header.tsx`

1. Converted dense one-line metadata into clearer chip-based summary (coins, pegs, chains, pipeline stats).
2. Added structured hero shell with improved spacing and hierarchy while preserving brand identity.
3. Kept desktop-only placement to avoid mobile redundancy with existing compact top nav/header.

#### `src/components/kpi-bar.tsx`

1. Unified chip styling through shared base class constant.
2. Normalized small-label typography via `.pharos-kicker`.
3. Aligned mobile and desktop KPI surfaces to consistent shell style.
4. Tightened header strip rhythm (`bg-muted/20`, normalized vertical spacing).
5. Normalized warning tone from mixed yellow/orange to amber in this KPI context.

#### `src/components/market-highlights.tsx`

1. Standardized highlight cards to shared shell + interactive-card pattern.
2. Added consistent keyboard focus rings for card rows/links.
3. Added underline affordance for keyboard focus (not only hover) on symbols.

### Supporting consistency pass

#### `src/components/stablecoin-table.tsx`

1. Standardized table wrapper to card-shell treatment for visual cohesion with other dashboard panels.
2. Added focus-ring utility to key inline links and clear-action buttons.
3. Made feedback flag action visible on keyboard focus (`focus-visible:opacity-100`).
4. Kept table density and structure unchanged (no redesign of columns/ordering).

#### `src/components/feature-highlights.tsx`

1. Unified card shell/interaction/focus behavior with hero cards.
2. Ensured CTA text state updates on keyboard focus as well as hover.

#### `src/components/filter-bar.tsx`

1. Replaced ad hoc focus classes with shared focus-ring utility on clear actions.

#### `src/app/page.tsx`

1. Normalized top-level section spacing (`space-y-6`).
2. Grouped `SiteHeader` + `KpiBar` in a dedicated spacing block for cleaner visual handoff into subsequent content.

## Intentionally Not Changed

1. No changes to shadcn primitives under `src/components/ui/`.
2. No structural redesign of page information architecture.
3. No semantic metric or API behavior changes.
4. No additional animation complexity beyond lightweight transition harmonization.

## Expected UX Impact

1. Faster first-screen comprehension from clearer hero stat grouping.
2. More uniform panel rhythm and reduced visual noise across data-heavy sections.
3. Improved keyboard accessibility and consistent interaction cues.
4. Better cross-page cohesion with minimal risk and no identity reset.
