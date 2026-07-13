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
- **Persistence helpers:** `src/lib/portfolio-codec.ts`, `src/lib/portfolio-analysis.ts`
- **Shared scoring source:** `docs/report-cards.md`

`src/app/portfolio/page.tsx` uses `createClientFeaturePage(...)` to keep the route shell static while lazy-loading the interactive client. The shell is intentionally `noindex,follow` and uses canonical `/portfolio/`.

---

## Data Contract

The interactive page depends on three local/runtime sources:

1. `useReportCards()` for live stablecoin grades and per-dimension scores.
2. `useLogos()` for static logo assets from `data/logos.json`.
3. `usePortfolio(reportData?.cards)` for holdings state, browser persistence, portfolio grade math, and upstream exposure derivation.

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

- `components.tsx` renders the holdings editor, summary, exposure, and supporting sections.
- `model.ts` owns route-local projections and presentation helpers.
- `presets.ts` owns the curated preset definitions.
- `src/components/portfolio-empty-state.tsx` owns preset-first empty-state onboarding.

The page uses `CLIENT_ACTIVE_STABLECOINS` for `PORTFOLIO_COIN_OPTIONS`, excluding pre-launch and frozen assets. It does not filter against `DEAD_STABLECOINS`.

---

## Update Rules

When changing portfolio behavior, update this doc alongside the relevant runtime source:

1. Route-shell metadata or noindex behavior -> `src/app/portfolio/page.tsx`
2. Holdings persistence / share encoding -> `src/hooks/use-portfolio.ts`, `src/lib/portfolio-codec.ts`
3. Exposure math or grouping -> `src/lib/portfolio-analysis.ts`
4. Portfolio-grade semantics -> `docs/report-cards.md` and any affected methodology copy

---

## File Index

| File | Role |
|------|------|
| `src/app/portfolio/page.tsx` | Static route shell, metadata, breadcrumb/shell config |
| `src/app/portfolio/client.tsx` | Client orchestration, hooks, actions, and URL workflow |
| `src/app/portfolio/components.tsx` | Route-local holdings, summary, and exposure presentation |
| `src/app/portfolio/model.ts` | Route-local projections and display helpers |
| `src/app/portfolio/presets.ts` | Curated portfolio preset definitions |
| `src/hooks/use-portfolio.ts` | Browser persistence, share-link helpers, portfolio score derivation |
| `src/lib/portfolio-codec.ts` | Query/localStorage encoding + canonical-only validation |
| `src/lib/portfolio-analysis.ts` | Upstream exposure grouping and collateral categorization |
| `src/components/portfolio-empty-state.tsx` | Preset-first onboarding and empty-state copy |
| `docs/report-cards.md` | Underlying scoring model consumed by the portfolio page |
