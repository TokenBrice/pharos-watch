# Portfolio Page

Route contract for `/portfolio/`, the noindex personal stablecoin risk workspace.

---

## Route Shape

- **Server shell:** `src/app/portfolio/page.tsx`
- **Client orchestration:** `src/app/portfolio/client.tsx`
- **Page presentation:** `src/app/portfolio/components.tsx`
- **Page model/helpers:** `src/app/portfolio/model.ts`
- **Preset registry:** `src/app/portfolio/presets.ts`
- **Portfolio state hook:** `src/hooks/use-portfolio.ts`
- **Persistence helpers:** `src/lib/portfolio-codec.ts`
- **Shared scoring source:** `docs/report-cards.md`

`src/app/portfolio/page.tsx` uses `createClientFeaturePage(...)` to keep the route shell static while lazy-loading the interactive client. The shell is intentionally `noindex,follow` and uses canonical `/portfolio/`.

---

## Data Contract

The interactive page depends on three local/runtime sources:

1. `useReportCardsV9()` for canonical stablecoin grades, pillar scores, and dependency routes.
2. `logosById` from `src/lib/logos.ts` for static logo assets from `data/logos.json`.
3. `usePortfolio()` for holdings state and browser persistence.

The client derives the amount-weighted V9 aggregate and modeled dependency-route count with `buildV9PortfolioProjection(...)`. That projection is informational and is not an asset Safety Score.

There is no dedicated `/api/portfolio` endpoint. Portfolio holdings stay client-side.

---

## Persistence And Sharing

- **Primary storage key:** `pharos:portfolio` in browser `localStorage`
- **Share/query param:** `?p=<encoded-holdings>`
- **Priority order on load:** URL share payload -> `localStorage` -> empty state

`usePortfolio` validates canonical holdings only. Unknown or non-canonical IDs are dropped and duplicate canonical IDs are merged. Stored holdings are normalized and written back through `localStorage` after a successful storage-backed read. URL-sourced holdings take precedence and are normalized back into `?p=`, but they are not persisted to `localStorage`.

---

## UI Responsibilities

`src/app/portfolio/client.tsx` coordinates hooks, URL state, persistence actions, and the page-level workflow. The route-local modules split the remaining ownership:

- `components.tsx` renders the holdings editor, summary, and loading state.
- `model.ts` owns route-local projections and presentation helpers.
- `presets.ts` owns the curated preset definitions.
- `src/components/portfolio-empty-state.tsx` owns preset-first empty-state onboarding.

`client.tsx` owns the canonical V9 aggregate and per-holding grade presentation.

The page uses `CLIENT_ACTIVE_STABLECOINS` for `PORTFOLIO_COIN_OPTIONS`, excluding every non-active lifecycle state. It does not filter against `DEAD_STABLECOINS`.

---

## Update Rules

When changing portfolio behavior, update this doc alongside the relevant runtime source:

1. Route-shell metadata or noindex behavior -> `src/app/portfolio/page.tsx`
2. Holdings persistence / share encoding -> `src/hooks/use-portfolio.ts`, `src/lib/portfolio-codec.ts`
3. V9 aggregate or dependency-route projection -> `src/lib/safety-score-v9-consumers.ts`
4. Portfolio safety semantics -> `docs/report-cards.md` and any affected methodology copy
