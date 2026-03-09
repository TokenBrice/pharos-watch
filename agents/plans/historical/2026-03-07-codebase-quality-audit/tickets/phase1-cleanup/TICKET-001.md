---
title: "Remove dead code and unused exports from frontend"
agent: "codex"
model: "gpt-5.3-codex-spark"
reasoning_effort: "medium"
done: false
---

## Goal

Remove confirmed dead code and unused exports from `src/components/`, `src/lib/`, and `src/hooks/` to reduce LOC without affecting features.

## Context

A codebase audit confirmed these items are never imported or used. Each has been verified via import analysis across the entire `src/` tree.

## Task

### 1. Delete unused component file
- **`src/components/flow-gauge.tsx`**: Delete entire file. `GAUGE_BANDS`/`FlowGaugeBandConfig` are defined but never imported anywhere in `src/`.

### 2. Remove dead exports from src/lib/

- **`src/lib/chart-colors.ts`** (~line 38): Remove export `CHART_TEAL` — never imported.

- **`src/lib/flow-intensity.ts`** (~lines 18-33): Remove these 3 exported functions — none are imported anywhere:
  - `getPressureShiftMagnitude`
  - `getFlowIntensityDisplay`
  - `getFlowIntensityMagnitude`

  If the file becomes empty after removal (check if other exports remain), delete the file entirely.

- **`src/lib/nav-config.ts`** (~line 20): Remove `export` keyword from `LighthouseIcon` — it's only used internally by `NAV_GROUPS` in the same file.

- **`src/lib/stablecoin-detail-derive.ts`** (~line 40): Remove `export` keyword from `hasPositivePegReference` — only used internally.

### 3. Remove dead hook

- **`src/hooks/use-api-query.ts`** (~line 111): Remove the exported function `useApiQueryWithMeta` — never imported anywhere in `src/`. Keep everything else in the file.

### 4. Remove unnecessary export modifiers on component types

- **`src/components/feedback-modal.tsx`** (~line 17): Remove `export` from internal type.
- **`src/components/stale-data-banner.tsx`** (~line 12): Remove `export` from internal type.
- **`src/components/flow-machine-scene.tsx`** (~line 15): Remove `export` from internal type.
- **`src/components/flow-brrr-overview.tsx`** (~line 528): Remove `export` from internal type.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `src/components/flow-gauge.tsx` does not exist
- `grep -r 'CHART_TEAL' src/lib/chart-colors.ts` returns no matches
- `grep -r 'useApiQueryWithMeta' src/hooks/use-api-query.ts` returns no matches
- `grep -c 'getPressureShiftMagnitude\|getFlowIntensityDisplay\|getFlowIntensityMagnitude' src/lib/flow-intensity.ts` returns 0 (or file doesn't exist)
