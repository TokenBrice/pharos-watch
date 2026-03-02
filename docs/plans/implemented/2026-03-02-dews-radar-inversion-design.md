# DEWS Radar Inversion Design

**Date:** 2026-03-02
**Status:** Approved

## Summary

Invert the DEWS radar so danger is at the center and calm coins form an ambient starfield at the periphery. Higher threat = closer to center. CALM coins (~145) appear as tiny, non-interactive ambient dots at the outer edge — visible but unobtrusive. This changes the threat metaphor from "targets at distance" to "things closing in."

---

## Radial Layout

Available radius: 45–240px (center label occupies 0–38px).

```
r 0–38    center label (unchanged)
r 45–90   DANGER zone
r 95–140  WARNING zone
r 143–175 ALERT zone
r 178–208 WATCH zone
r 212–238 CALM ambient starfield
```

Ring boundary circles (dashed) are drawn at the inner edge of each zone:
- r=45   DANGER inner edge
- r=95   WARNING inner edge
- r=143  ALERT inner edge
- r=178  WATCH inner edge
- r=212  CALM zone inner edge (new — very faint gray, not CALM green)
- r=240  outer boundary (unchanged)

---

## Score → Radius Mapping

Higher score maps to smaller radius. Same linear interpolation as before, new constants:

| Band    | Score range | Radius range |
|---------|-------------|--------------|
| WATCH   | 16–35       | 178–208      |
| ALERT   | 36–55       | 143–175      |
| WARNING | 56–75       | 95–140       |
| DANGER  | 76–100      | 45–90        |

---

## CALM Ambient Starfield

CALM coins are rendered as a separate, non-interactive layer beneath elevated coins.

- Dot radius: **2px**
- Fill: `var(--color-muted-foreground)`
- Fill opacity: **0.12**
- No hover, no click, no label, no pulse animation
- Angle: same `deterministicOffset(id)` mechanism as elevated coins
- Radius within zone: `212 + (idHash % 26)` — deterministic scatter within 212–238px, guarantees even radial distribution with no randomness and no clustering

The `deterministicOffset` function is extended to also export a `deterministicRadiusOffset(id, zoneWidth)` helper that returns `idHash % zoneWidth`, keeping both concerns in `dews-radar-utils.ts`.

---

## Legend Order Inversion (Refinement 1)

The `DEWSLegend` band array is reversed to read `DANGER → WARNING → ALERT → WATCH` left-to-right, matching the center-out spatial order. Without this, the legend contradicts the visual.

---

## CALM Zone Boundary Ring (Refinement 2)

A ring at r=212 is added to the ring system with the same faint gray stroke as the spokes (`rgba(255,255,255,0.04)`), not a CALM-colored ring. This gives the starfield a visual container and completes the concentric geometry without implying threat color semantics.

---

## Deterministic Radius Scatter (Refinement 3)

A new helper `deterministicRadiusOffset(id: string, zoneWidth: number): number` is added to `dews-radar-utils.ts`:

```ts
export function deterministicRadiusOffset(id: string, zoneWidth: number): number {
  const sum = id.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return sum % zoneWidth;
}
```

Used exclusively for calm dot placement: `r = 212 + deterministicRadiusOffset(id, 26)`.

---

## Files Affected

| File | Change |
|------|--------|
| `src/lib/dews-radar-utils.ts` | Invert `BAND_RADIUS` constants; add `deterministicRadiusOffset` |
| `src/components/dews-summary.tsx` | `computePositions` returns calm dots separately; new `DEWSCalmDot` micro-component; `DEWSRadar` renders calm layer; `RING_RADII` updated; calm boundary ring added; legend order reversed |
| `src/lib/__tests__/dews-radar-utils.test.ts` | Update `scoreToRadius` expected values to match new constants; add tests for `deterministicRadiusOffset` |

---

## What Does Not Change

- `SWEEP_DURATION`, `PULSE_DURATION` — animation speeds unchanged
- `DEWSCenter` — center label logic unchanged
- `DEWSDot` — elevated dot rendering unchanged
- `DEWSTooltip` — tooltip unchanged
- `highestBand`, `distributeAngles`, `sweepDuration`, `pulseDuration` — unchanged
- API, data pipeline, classification constants — untouched
