# PSI Dedicated Page — Design

**Date:** 2026-02-25
**Status:** Approved

## Goal

A dedicated page at `/stability-index` showing the full historical narrative of the Pharos Stability Index — score over time with band-colored zones, annotated crisis events, component breakdown charts, and a methodology explainer. The page answers: "When did major events happen, how bad were they, and what drove the score?"

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Purpose | Historical narrative | Users explore past events and understand the score over time |
| Component data | Score line + component breakdown | Shows what drove each dip — unique insight |
| Annotations | Manual event markers | Known crises (UST, SVB) add narrative value |
| Approach | Full-page narrative | Hero + score chart + component chart + methodology |

## Page Structure

**URL:** `/stability-index`
**Nav:** Added to `NAV_ITEMS` in `header.tsx` — label "Stability Index"

### 1. Hero Section

Larger version of the homepage widget:
- `PsiLighthouse` at 64px (reuse component with larger size prop)
- Score in `text-4xl` with band color
- Band name + delta from yesterday
- "Days in [BAND]" streak counter (computed from history)

### 2. Main Score Chart

Full-width Recharts AreaChart:
- **Y domain:** 0–100 (fixed)
- **Band zone backgrounds:** Horizontal `ReferenceArea` strips for each band range, faded colors
- **Score line:** Area with gradient fill, stroke colored by current band
- **Event annotations:** Vertical `ReferenceLine` with labels:
  - May 7, 2022: "UST Collapse"
  - Mar 10, 2023: "SVB Weekend"
  - (hardcoded array, easy to extend later)
- **Time range filter:** `useTimeRangeFilter` — 30d / 90d / 1y / All
- **Tooltip:** Date, score, band name

### 3. Component Breakdown Chart

Stacked area chart (same time range) showing what drives the score:
- **Severity** (0–60): area, warm color
- **Breadth** (0–15): area, contrasting color
- **Freezes** (0–10): area, red-ish
- **Trend** (−5 to +5): separate line overlay (can be negative, not stacked)

### 4. Methodology Card

Collapsible section at the bottom:
- Formula: `Score = 100 − severity − breadth − freezes + trend`
- Component definitions table (name, range, purpose)
- Band thresholds table (range, name, color, meaning)

## API Extension

Extend `GET /api/stability-index`:

**New query param:** `?detail=true`

**When `detail=true`:**
- Return full history (all available, not just 90 days)
- Include `components` JSON per history entry:
  ```json
  { "date": 1740384000, "score": 95.1, "band": "BEDROCK",
    "components": { "severity": 0.01, "breadth": 3.84, "freezes": 0, "trend": 0.26 } }
  ```

**Default (no param):** Existing lightweight 90-day response unchanged. Homepage widget stays fast.

The DB already stores `components` TEXT (JSON) per row — this is a query-only change.

## Frontend Hook

New hook or extend existing:
- `useStabilityIndexDetail()` — calls `/api/stability-index?detail=true`
- Returns same shape but with components in history entries
- Longer staleTime since this is mostly historical data

## Files

| File | Action |
|------|--------|
| `worker/src/api/stability-index.ts` | Extend: add `?detail=true` support |
| `src/hooks/use-stability-index.ts` | Extend: add `useStabilityIndexDetail()` hook |
| `src/app/stability-index/page.tsx` | Create: server component (metadata, breadcrumb) |
| `src/app/stability-index/client.tsx` | Create: client component (hero, charts, methodology) |
| `src/components/header.tsx` | Modify: add nav entry |
| `src/components/stability-index.tsx` | Modify: make `PsiLighthouse` accept optional size prop, export it |

## Event Annotations

```typescript
const PSI_EVENTS = [
  { date: new Date("2022-05-07").getTime() / 1000, label: "UST Collapse" },
  { date: new Date("2023-03-10").getTime() / 1000, label: "SVB Weekend" },
];
```

Stored as a constant in the client component. Easy to extend.
