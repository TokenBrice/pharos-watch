---
title: "Extract MetricStatCard, consolidate KPI metric definitions, and deduplicate flow signal dictionaries"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Extract a shared `MetricStatCard` component, centralize KPI metric definitions, and consolidate duplicated flow signal dictionaries to eliminate ~180 LOC of repeated card/metric patterns.

## Context

The audit found:
1. KPI stat-card markup repeated across 5 dashboard stat components (~48 LOC)
2. KpiBar duplicates metric definitions for mobile/desktop render paths (~75 LOC)
3. Flow signal direction/pressure mappings duplicated between flow-summary-card and flow-brrr-overview (~90 LOC)

## Task

### 1. Extract MetricStatCard component

5 components repeat the same stat-card pattern: left-border card with title, value, and optional subtext.

Files with this pattern:
- `src/components/blacklist-stats.tsx` (~line 48)
- `src/components/depeg-tracker-stats.tsx` (~line 19)
- `src/components/liquidity-stats.tsx` (~line 181)
- `src/components/category-stats.tsx` (~line 123)
- `src/components/usds-status-card.tsx` (~line 70)

Read all 5 files to understand the exact pattern. Create **`src/components/metric-stat-card.tsx`** with a reusable component. Then replace the repeated patterns in all 5 files.

**Important:** Tailwind classes must be static strings. The left-border color varies per card — use a `borderColorClass` prop or similar.

### 2. Centralize KpiBar metric definitions

**`src/components/kpi-bar.tsx`** (~lines 367-518): The same 4 business metrics are manually duplicated for `KpiMiniTile` (mobile) and `KpiCell` (desktop) views.

Extract a single metric-definition array (label, value accessor, formatter, etc.) and map it into both mobile and desktop presenters. This eliminates the parallel maintenance of metric definitions.

### 3. Consolidate flow signal dictionaries

**`src/components/flow-summary-card.tsx`** (~lines 70-163) and **`src/components/flow-brrr-overview.tsx`** (~lines 83-147) maintain separate but equivalent:
- Direction labels and color classes
- Pressure mapping dictionaries
- Narrative text generation logic

Extract shared signal UI mappings into **`src/lib/flow-signal-ui.ts`** (or similar):
- Direction label/color maps
- Pressure state → display mappings
- Narrative builders

Then use the shared module in both component files.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `src/components/metric-stat-card.tsx` exists
- `grep -c 'MetricStatCard' src/components/blacklist-stats.tsx` returns >0
- `wc -l src/components/kpi-bar.tsx` shows reduced LOC
- Shared flow signal module exists and is imported by both flow components
