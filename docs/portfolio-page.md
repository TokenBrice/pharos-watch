# Portfolio Page

Route contract for `/portfolio/`, the noindex personal stablecoin risk workspace.

---

## Route Shape

- **Server shell:** `src/app/portfolio/page.tsx`
- **Client implementation:** `src/app/portfolio/client.tsx`
- **Portfolio state hook:** `src/hooks/use-portfolio.ts`
- **Persistence helpers:** `src/lib/portfolio-codec.ts`, `src/lib/portfolio-analysis.ts`
- **Shared scoring source:** `docs/report-cards.md`

`src/app/portfolio/page.tsx` uses `createClientFeaturePage(...)` to keep the route shell static while lazy-loading the interactive client. The shell is intentionally `noindex,follow`, marks the route as beta, and uses canonical `/portfolio/`.

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

`usePortfolio` validates and normalizes holdings through the shared canonical-ID registries. Unknown IDs are dropped, duplicate canonical IDs are merged, and migrated data is written back once after a successful read.

---

## UI Responsibilities

`src/app/portfolio/client.tsx` owns:

- holdings entry and removal
- preset loading (`CeFi Core`, `Treasury Heavy`, `DeFi Native`, `Barbell Mix`)
- aggregate portfolio grade and radar chart
- upstream exposure view (grouped or detailed)
- share link generation
- empty-state onboarding via `src/components/portfolio-empty-state.tsx`

The page excludes cemetery assets from the selectable universe by filtering tracked assets against `DEAD_STABLECOINS`.

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
| `src/app/portfolio/client.tsx` | Interactive holdings editor, presets, grade/exposure presentation |
| `src/hooks/use-portfolio.ts` | Browser persistence, share-link helpers, portfolio score derivation |
| `src/lib/portfolio-codec.ts` | Query/localStorage encoding + canonical-ID migration |
| `src/lib/portfolio-analysis.ts` | Upstream exposure grouping and collateral categorization |
| `src/components/portfolio-empty-state.tsx` | Preset-first onboarding and empty-state copy |
| `docs/report-cards.md` | Underlying scoring model consumed by the portfolio page |
