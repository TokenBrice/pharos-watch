# Dependency Map

## Overview

The dependency map route (`/dependency-map`) presents the canonical Safety Score V9 dependency graph as ranked upstream hubs and direct dependent exposure. The retired V8 force-directed contagion simulator and its stress controls have been removed.

Primary files:

- `src/app/dependency-map/page.tsx`
- `src/app/dependency-map/client.tsx`
- `src/app/dependency-map/dependency-hubs-model.ts`
- `src/app/dependency-map/dependency-hubs-board.tsx`
- `src/app/dependency-map/dependency-hero.tsx`
- `src/components/dependency-map-mobile-summary.tsx`

## Data Inputs

The page combines:

1. `useReportCardsV9()` (`GET /api/report-cards/v9`) for current cards and canonical dependency edges.
2. `useStablecoins()` (`GET /api/stablecoins`) for circulating USD context through `getCirculatingRaw()`.
3. `useLogos()` for static token logos.

A held V9 publication is shown with the shared status notice. Missing or invalid V9 data renders unavailable; the page never falls back to V8 or reconstructs dependency edges from a retired card model.

## Hub Model

`buildDependencyHubsModel({ cards, edges, mcapMap })` derives one shared desktop/mobile model from live V9 cards and edges.

The model reports:

- ranked upstream hubs
- unique direct dependent count
- summed direct dependency weight
- direct dependent market-cap context, deduplicated per hub
- the hub's own market cap
- up to three direct dependent examples
- direct edge counts and weights by collateral, mechanism, and wrapper relationship

The market-cap figure is descriptive context, not a transitive loss estimate. Duplicate direct edges to the same dependent count once for dependent count and market-cap context, while each edge still contributes to summed relationship weight.

## Presentation

`DependencyHero` summarizes the current graph. `DependencyHubsBoard` renders the desktop exact-value table, and `DependencyMapMobileSummary` renders the same model for compact screens.

The route contains no client-side scoring, contagion simulation, force layout, or V8 stress recomputation.
