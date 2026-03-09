---
title: "Standardize N/A display convention and add font-mono to key numeric surfaces"
agent: "codex"
model: "gpt-5.1-codex-max"
reasoning_effort: "high"
done: true
---

## Goal

Standardize the null/missing-data display convention across the UI and ensure key numeric data surfaces use `font-mono` per the design system.

## Context

**Research findings addressed:**
- R6-I3: Inconsistent null conventions — `N/A`, `--`, `—`, `n/a`, empty string used across different components
- R6-C3: Numeric typography rule broken — numbers rendered without `font-mono` on several high-visibility surfaces
- R6-I1: PSI/classification band colors redefined locally instead of using canonical `shared/lib/classification.ts`

## Task

### 1. Standardize null display convention

The project standard is `—` (em-dash) for missing data in tables/numeric contexts. Search for and replace inconsistent patterns:

- Search `src/components/` and `src/app/` for patterns: `"N/A"`, `"n/a"`, `"--"`, `"- -"` used as null/missing-data displays
- Replace with `"—"` (em-dash, Unicode U+2014)
- **Exception:** Do NOT change `"N/A"` in tooltips or help text where it stands for "Not Applicable" in explanatory context (as opposed to "no data")
- **Exception:** Do NOT change formatted date displays or chart axis labels

Likely locations (from research):
- `src/components/stablecoin-table.tsx` — supply change columns
- `src/components/depeg-tracker-table.tsx` — peak deviation, duration columns
- `src/components/yield-leaderboard.tsx` — APY/PYS columns
- `src/hooks/use-stablecoin-detail-view-model.ts` — formatted values

### 2. Add font-mono to key numeric surfaces

The design system mandates `font-mono` (Geist Mono) on all numeric data. Research found 17+ files with numbers not using `font-mono`. Focus on the highest-visibility surfaces:

- `src/components/stablecoin-table.tsx` — supply, price, change columns. Ensure `<td>` cells containing numbers have `font-mono` class.
- `src/components/depeg-tracker-table.tsx` — deviation, duration numeric cells
- `src/components/yield-leaderboard.tsx` — APY, PYS numeric cells
- `src/components/liquidity-table.tsx` — liquidity score, TVL numeric cells

For each: wrap or add `className="font-mono"` to the numeric `<span>` or `<td>` content. Use `tabular-nums` via `font-mono tabular-nums` for alignment.

**Do NOT add font-mono to labels, headers, or text — only to numeric data values.**

### 3. Use canonical PSI band colors

Search for local PSI band color definitions in `src/` that duplicate the canonical colors from `shared/lib/classification.ts`. Replace with imports from the shared source.

Likely locations (from research):
- `src/components/stability-index.tsx` — PsiLighthouse component may define band colors locally
- `src/app/stability-index/client.tsx` — band color map

## Files Modified

- `src/components/stablecoin-table.tsx`
- `src/components/depeg-tracker-table.tsx`
- `src/components/yield-leaderboard.tsx`
- `src/components/liquidity-table.tsx`
- `src/components/stability-index.tsx`
- `src/app/stability-index/client.tsx`
- `src/hooks/use-stablecoin-detail-view-model.ts`
- Other components as needed for N/A standardization

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -rn '"N/A"\|"n/a"\|"--"' src/components/ | grep -v test | grep -v tooltip` returns fewer matches than before
- `grep 'font-mono' src/components/stablecoin-table.tsx` shows font-mono on numeric cells
- No local PSI band color maps duplicating shared/lib/classification.ts
