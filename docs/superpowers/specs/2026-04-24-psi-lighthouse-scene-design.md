# PSI Lighthouse Scene — Hero Rework

**Status:** Design approved. Ready for implementation.
**Scope:** /stability-index/ hero visualization.

## Problem

The current Stability Index hero shows two separate visualizations side-by-side: a small stylized lighthouse icon and a colored gauge arc. Together they communicate the current PSI band and score, but they read as disconnected pieces and the lighthouse barely reads as a lighthouse.

## Goal

Consolidate into a single prominent lighthouse-and-beam mini-scene that:

- Actually looks like the Pharos of Alexandria (architectural, three-tier, brazier with flames)
- Reuses the visual vocabulary established in `/chains/` (`nautical-chart.tsx`)
- Carries both band (color) and score (magnitude) information through the metaphor itself

## Non-goals

- No changes to beam dimmers, contributor table, event timeline, methodology card, component chart, or view-model.
- No refactor of `/chains/` to extract a shared lighthouse component. The chains lighthouse stays coupled to its scene; the PSI version is a sibling implementation sharing visual grammar.

## Design

### Component structure

A new component `PsiLighthouseScene` lives at `src/app/stability-index/psi-lighthouse-scene.tsx`, colocated with the page.

```tsx
<PsiLighthouseScene band={band} score={score} className={...} />
```

- No size prop — SVG scales via viewBox (`0 0 400 280`, `preserveAspectRatio="xMidYMid meet"`).
- No color prop — band drives color internally via `PSI_HEX_COLORS` from `@shared/lib/psi-colors`.
- Inline SVG `<defs>` are scoped with `useId()` so multiple instances (or co-existence with the /chains/ scene) don't collide.

The old homepage PSI lighthouse treatment is removed after confirming it has no remaining call sites in `src/components/kpi-bar.tsx`.

### Scene composition

SVG viewBox `400 × 280`, rendered back-to-front:

1. **Sky gradient** — vertical gradient filling the upper ~75% of the frame, using the `nc-sky` palette from `/chains/` (`oklch(0.18 0.04 258)` → `oklch(0.32 0.05 252)` → `oklch(0.5 0.05 245)`). Overlaid with a low-opacity (~0.15) band-color wash so the whole atmosphere subtly inherits the current condition.
2. **Stars** — 6–8 fixed positions in the upper half, styled as in /chains/. No twin-star motif.
3. **Beam** — primary fan sweeping up-and-left from the brazier at ~40° off vertical; secondary wider wedge behind for depth. Both use a gradient fading from band color (opaque near brazier) to transparent at the far edge.
4. **Lighthouse** — centered at x≈200; three tapering stone tiers (square base → octagonal middle → cylindrical colonnade) reproducing the geometry from `/chains/` `Lighthouse`. Tower fill uses the `nc-stone` gradient (warm limestone) regardless of band — architecture is static.
5. **Brazier** — open fire bowl at the top of tier 3. Flames are three stacked layered paths (outer, mid, core) all in band color. Halo glow behind flames also band-tinted.
6. **Rocky promontory** — small outcrop under the tower, dark-blue rock treatment copied from /chains/.
7. **Waterline** — dashed cyan line at y≈210 across the frame.
8. **Water** — gradient fill for the lower ~25%, using `nc-water` palette with the same low-opacity band wash.

No distant coastline (chains-specific horizontal motif).

### Score → magnitude mapping

Score ∈ [0, 100] drives three visual parameters:

- **Beam reach** — beam's far-edge x-coordinate linearly interpolated from `0.4 × frameWidth` at score 0 to `1.0 × frameWidth` at score 100.
- **Beam opacity** — base opacity from 0.25 at score 0 to 0.72 at score 100. Secondary wedge at roughly half the primary's opacity.
- **Flame + halo scale** — uniform scale transform on the flame group (and halo radius) from `0.55×` at score 0 to `1.0×` at score 100, anchored at the brazier lip so the base of the fire stays planted.

Clamp score to [0, 100] defensively; render at score=0 treatment if score is null/undefined (defensive only — hero doesn't mount without `current`).

### Band → color mapping

`PSI_HEX_COLORS[band]` feeds:
- Beam gradient stops
- Flame fills (outer/mid/core — all the same hex, differentiated only by opacity layers so the core reads brighter)
- Halo glow fill
- Subtle sky/water tint wash

All inline styles or inline `fill`/`stroke` attributes — no dynamic Tailwind classes (per the CLAUDE.md static-strings rule).

Transitions: `transition: opacity 500ms ease-out, fill 500ms ease-out` on the band-reactive elements so band changes fade rather than pop. Matches the `duration-500` on the hero card's existing chrome (which is being removed, but the transition duration is preserved for visual consistency with other band-reactive elements on the page).

### Motion

- Halo glow: slow breathing pulse keyed to `PSI_PULSE_DURATION[band]` (preserved from the old `PsiLighthouse`).
- Flames: flicker animation using the same CSS keyframes as `/chains/` `nc-flame-outer` / `nc-flame-mid`. CSS lives in a new `psi-lighthouse-scene.css` colocated with the component, rather than importing `/chains/`'s `nautical-chart.css` (avoid coupling).
- `@media (prefers-reduced-motion: reduce)` disables all animations, leaving halo at a steady mid-opacity and flames static.

### Hero card layout

In `presentational.tsx`, `StabilityIndexHero`:

**Remove from the `<Card>`:**
- `border-l-4` + `PSI_BORDER_CLASSES[band]`
- `PSI_BG_OVERLAY_CLASSES[band]`
- The `transition-colors duration-500` on the card surface (card no longer reacts to band)

**Left column:** replace the `<div className="flex items-center gap-4 lg:gap-6">` cluster (which held `PsiLighthouse` + `ScoreArc`) with a single `<PsiLighthouseScene band={band} score={score} />`. Apply `rounded-lg overflow-hidden` and a responsive `max-w-md` cap so the scene doesn't balloon on tablet widths before the lg breakpoint kicks in.

**Right column:** unchanged structurally. Score typography + band label keep their `PSI_BAND_CLASSES` coloring — they remain the only band signal on the text side. Delta, days-in-band, and the historical stats grid are untouched.

**Mobile stacking:** scene on top (centered, capped width), text block below. The existing compact `PsiHistoryStatsGrid` with `lg:hidden` remains.

### Remove `ScoreArc`

`ScoreArc` and `ARC_BANDS` in `presentational.tsx` are no longer used after this change. Delete both along with their exports if unused elsewhere in the repo.

### Tests

New `src/app/stability-index/psi-lighthouse-scene.test.tsx`:
- Renders for each `ConditionBand` value
- Beam and flame elements carry the correct `PSI_HEX_COLORS[band]` fill/stroke
- Renders at score=0 and score=100 without crashing; beam-reach and flame-scale differ measurably between the two
- Respects `aria-label` and `role="img"` on the root SVG
- No snapshot tests of raw SVG paths — assert on attributes and semantic structure.

Existing tests referencing `PsiLighthouse` or `ScoreArc` are updated or removed as appropriate.

## Files touched

- `src/app/stability-index/psi-lighthouse-scene.tsx` — new
- `src/app/stability-index/psi-lighthouse-scene.css` — new
- `src/app/stability-index/psi-lighthouse-scene.test.tsx` — new
- `src/app/stability-index/presentational.tsx` — hero card chrome removal, left column swap, remove `ScoreArc` + `ARC_BANDS`
- `src/components/kpi-bar.tsx` — remove any old inline PSI lighthouse usage if still present
- Update any test referencing removed symbols

## Out of scope

- Beam dimmers rework
- Historical stats grid visual changes
- Nav changes, new pages, methodology edits
- Any /chains/ modifications
