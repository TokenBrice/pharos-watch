# PSI Lighthouse Visual — Design

**Date:** 2026-02-25
**Status:** Implemented

## Goal

Add a colored lighthouse icon to the PSI widget on the homepage. The lighthouse's lantern and beams reflect the current PSI band color, pulsing gently with urgency that scales with severity.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Color scope | Lantern + beams only | Realistic — a lighthouse changes its light, not its structure |
| Layout | Inline, left of score | Clean reading flow: [icon] [score] [band] [delta] [sparkline] |
| Animation | Subtle pulse, always on | Gentle at BEDROCK, urgent at MELTDOWN. Conveys liveness |
| Implementation | Inline SVG React component | Full control, no extra files or network requests |

## Component: `PsiLighthouse`

- **Location:** `src/components/stability-index.tsx` (private helper, same as `Sparkline`)
- **Props:** `{ band: string; color: string }`
- **Size:** 36px tall, scaled from 88×88 viewBox

### SVG color mapping

| SVG element | Default color | Dynamic? |
|-------------|--------------|----------|
| Lantern light (circle r=5) | white | Yes → band color |
| Glow gradient (radialGradient) | #E8DCC4 | Yes → band color |
| Beams (7 lines) | #E8DCC4 | Yes → band color |
| Shield outline | #E8DCC4 | No |
| Dome | #E8DCC4 | No |
| Lantern room | #F5F0E6 | No |
| Gallery | #E8DCC4 | No |
| Tower shaft | gradient | No |
| Tower bands | #0d1f3c | No |
| Base | #E8DCC4 | No |

### Pulse animation

CSS `@keyframes` on the glow circle, alternating opacity 0.3 ↔ 0.7:

| Band | Duration | Feel |
|------|----------|------|
| BEDROCK | 3s | Calm |
| STEADY | 3s | Calm |
| TREMOR | 2s | Alert |
| FRACTURE | 1.5s | Concerned |
| CRISIS | 1s | Urgent |
| MELTDOWN | 0.7s | Alarm |

Timing: `ease-in-out`, `infinite`. Applied via inline `style` on the glow `<circle>`.

## Layout

```
Before:
  [Stability Index label]
  [score] [band] [delta] [sparkline]

After:
  [Pharos Stability Index label]
  [lighthouse] [score] [band] [delta] [sparkline]
```

The label text was changed from "Stability Index" to "Pharos Stability Index". The lighthouse icon sits to the left of the score number, vertically centered.

## Accessibility

- SVG IDs namespaced with `React.useId()` to avoid collisions
- `prefers-reduced-motion: reduce` disables the pulse animation
- `aria-label` on the SVG describes the lighthouse and current band

## Files changed

- `src/components/stability-index.tsx` — add `PsiLighthouse` function, integrate into `StabilityIndex`

No new files. No new dependencies.
