# DEWS Radar Redesign

**Date:** 2026-03-02
**Scope:** Replace `DEWSSummary` (used on `/depeg/`) with a sonar-radar visualization
**Status:** Design approved — ready for implementation

---

## Context

The current `DEWSSummary` is a standard card with a coin list. It reads data well but doesn't communicate the nature of the component — a live, forward-looking early warning system. The redesign gives it a radar metaphor consistent with the project's design language (PSI lighthouse, cemetery tombstones, newspaper digest).

`DEWSDetail` on the stablecoin page is **out of scope** — it's fine as-is.

---

## Layout

Full-width card. Header row (title + coin count). SVG radar occupying most of the card height. Small band legend strip at the bottom.

```
┌───────────────────────────────────────────────────────────────┐
│  DEWS: Depeg Early Warning System        5 elevated · 140 calm │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│                   ·  DANGER zone  ·                           │
│               · WARNING zone         ·                        │
│            ·   ALERT zone   •FRAX      ·                      │
│           · WATCH zone   •USDT          ·                     │
│          |      ╭──────────────╮         |                    │
│          |      │   WATCH      │         |                    │
│          |      │  5 elevated  │         |                    │
│          |      ╰──────────────╯         |                    │
│           · •DAI             •LUSD      ·                     │
│            ·                           ·                      │
│               ·                     ·                         │
│                   ·  ·  ·  ·  ·  ·                            │
│                                                               │
│   ── WATCH   ── ALERT   ── WARNING   ── DANGER               │
└───────────────────────────────────────────────────────────────┘
```

**Card height:** ~440px desktop, scales proportionally on mobile via `width="100%"` on the SVG.
**SVG viewBox:** `0 0 560 480`
**Radar center:** (280, 240)

---

## Band Zones (radial ranges)

Bands are zones with inner and outer radii, not single rings. A coin's score maps proportionally to a radius within its zone.

| Band    | Score range | Inner r | Outer r | Color hex |
|---------|-------------|---------|---------|-----------|
| WATCH   | 16–35       | 75      | 108     | `#14b8a6` |
| ALERT   | 36–55       | 118     | 151     | `#eab308` |
| WARNING | 56–75       | 161     | 194     | `#f97316` |
| DANGER  | 76–100      | 204     | 240     | `#ef4444` |

**Radius formula per coin:**

```
bandMin, bandMax = score range of band (e.g. 16, 35 for WATCH)
innerR, outerR  = radial range of zone
r = innerR + ((score - bandMin) / (bandMax - bandMin)) * (outerR - innerR)
```

This places a score-16 WATCH coin at the inner edge and a score-35 WATCH coin near the outer edge — visually one step away from ALERT.

**Ring lines** (the visible circles) are drawn at the inner radius of each zone (75, 118, 161, 204, 240). They are zone boundaries, not placement tramlines.

---

## Angle Distribution

Coins on the same band are spread evenly around their zone. Angle spacing must be deterministic (same render = same positions, no shuffling on refetch).

```
baseAngle = -Math.PI / 2        // start at 12 o'clock
step      = (2 * Math.PI) / n   // n = number of coins in this band
angle_i   = baseAngle + i * step + deterministicOffset(id)
```

`deterministicOffset` is a small angular jitter derived from the coin ID string (e.g. `(charCodeSum(id) % 30) * (Math.PI / 180)`) so coins with adjacent IDs don't perfectly overlap their labels.

Cartesian conversion:
```
x = cx + r * Math.cos(angle)
y = cy + r * Math.sin(angle)
```

---

## Dot Visual Hierarchy (two tiers)

| Threat level        | Dot radius | Symbol label     | Glow intensity |
|---------------------|------------|------------------|----------------|
| DANGER / WARNING    | r = 9      | Always visible   | Strong         |
| ALERT / WATCH       | r = 6      | Hover only       | Subtle         |

Always-visible labels: `<text>` element, 10px monospace, floating 14px above the dot center, filled in the band color. No background — kept minimal.

Hover tooltip (for all coins): coin logo + full name + score + band label, positioned as an absolutely-placed div relative to the SVG container.

Click on any dot: navigates to `/stablecoin/${id}`.

---

## Sweep Line

A single `<line>` from center to r=240, rotated via CSS `@keyframes`.

**Revolution duration scales with highest active threat:**

| System state         | Revolution duration |
|----------------------|---------------------|
| All calm             | 12 s                |
| Highest band = WATCH | 8 s                 |
| Highest band = ALERT | 6 s                 |
| Highest band = WARNING | 4 s               |
| Highest band = DANGER | 2.5 s              |

**Sweep color:** matches the highest active band color (green when all calm).

**Wake trail:** An SVG `<path>` arc sector spanning 90° behind the sweep line, filled with a radial gradient from `bandColor @ 0.20 opacity` at the center to `transparent` at r=240. The arc rotates with the line using the same `@keyframes`. Implemented as:
- `<defs>` containing a `<radialGradient>` from center outward
- `<path>` describing a 90° wedge sector, same rotation animation as the line

**Reduced motion:** `@media (prefers-reduced-motion: reduce)` — sweep line and dot pulses are paused; static snapshot instead.

---

## Center Readout

Circle at r=35, filled with current highest-threat band color at 15% opacity, bordered by band color at 40% opacity. Contains two lines of text:

- **Line 1:** Band name in all-caps, bold, 13px, band color. E.g. `WATCH` or `ALL CALM`
- **Line 2:** Count string, 11px, muted. E.g. `5 elevated` or `145 monitored`

Center pulses slowly (opacity 0.6 → 1.0 → 0.6, 3s ease-in-out infinite) — slower when calm, matches sweep duration.

---

## Ring Lines

Four `<circle>` elements at r = 75, 118, 161, 204 + one outer boundary at r = 240.
Stroke: band color at 25% opacity, `strokeDasharray="4 6"`, no fill.
Ring at r = 240: slightly higher opacity (35%) as the outer boundary.

Faint radial grid lines (8 spokes at 45° intervals): stroke `rgba(255,255,255,0.04)`, from r=10 to r=240. They give the radar surface without competing with the data.

---

## Dot Pulse Animation

Each dot has its own `@keyframes` pulsing the `r` attribute or a `filter: drop-shadow`:

| Band    | Pulse duration | Behaviour          |
|---------|--------------|--------------------|
| WATCH   | 3.0 s        | Gentle glow        |
| ALERT   | 2.0 s        | Medium glow        |
| WARNING | 1.2 s        | Fast glow          |
| DANGER  | 0.6 s        | Rapid, urgent glow |

Implementation: `filter: drop-shadow(0 0 4px bandColor)` animated opacity, applied per dot via inline `style` with CSS custom property.

---

## States

### Loading
Skeleton: a single `animate-pulse` rounded `div` at the card height (440px). No SVG rendered.

### All calm
- Center: `ALL CALM` in green, `145 monitored`
- All ring lines visible at low opacity
- Sweep line: green, 12s revolution
- No dots

### Elevated (1+ coins above CALM)
- Center: highest band name + `N elevated`
- Ring lines at occupied bands brighten slightly
- Sweep, dots, labels as specified above

### No data
Existing null return behavior (returns `null` from the component).

---

## Legend

Horizontal row beneath the radar:

```
─── WATCH   ─── ALERT   ─── WARNING   ─── DANGER
```

Each item: a 20px dash in the band color + band name in `text-xs text-muted-foreground`. Only the four non-CALM bands are shown. Right-aligned: `Updated Xm ago` from `data.updatedAt`.

---

## Component Structure

The redesign replaces `src/components/dews-summary.tsx` entirely. Internal structure:

```
<DEWSSummary>
  <Card>
    <CardHeader>           title + count string
    <CardContent>
      <DEWSRadar>          pure SVG component, receives processed coin data
        ring lines
        radial grid spokes
        sweep line + wake arc
        center readout
        <DEWSDot> × n      one per elevated coin
      </DEWSRadar>
      <DEWSLegend>         band color key + updatedAt
```

`DEWSRadar` and `DEWSDot` and `DEWSLegend` are unexported sub-components within the same file. No new files needed.

---

## Data Flow

No new data fetching. Uses the existing `useStressSignals()` hook which is already called in `client.tsx` and passed down — or `DEWSSummary` calls it directly (current pattern).

Inputs used:
- `data.signals[id].score` — radial placement
- `data.signals[id].band` — zone + color + tier
- `data.updatedAt` — legend timestamp
- `PSI_ELIGIBLE_META_BY_ID` — symbol + name
- `logos` prop — coin logo URLs (already passed from `DepegClient`)

---

## Files Changed

| File | Change |
|------|--------|
| `src/components/dews-summary.tsx` | Full replacement |

No other files change.
