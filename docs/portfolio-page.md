# Portfolio Page

`/portfolio/` is a noindex/follow personal risk workspace, canonical to itself. `src/app/portfolio/page.tsx` provides the static `createClientFeaturePage()` shell; route client/model compose shared scoring and `usePortfolio`. Holdings remain client-side; there is no `/api/portfolio` endpoint.

## Data Contract

`useReportCardsV9()` supplies accepted grades/pillars/dependencies. `buildV9PortfolioProjection()` is the V9-named consumer of current Safety Score outputs, not another asset score. It computes amount-weighted informational aggregate and modeled route count. Held publication, missing cards or NR positive holdings make the aggregate unavailable. Pipeline gaps/unavailable pillars leave known-only subtotals with separate USD coverage denominators, never zero scores.

Coin options derive from `CLIENT_ACTIVE_STABLECOINS`, excluding every other lifecycle state, not by subtracting cemetery rows. Static logos and local holdings introduce no new server data source.

## Persistence And Sharing

Priority: URL `?p=<encoded-holdings>` → localStorage `pharos:portfolio` → empty. Validate canonical IDs, discard unknown/noncanonical IDs and merge duplicates. Normalize/write back only after a successful storage-backed read. URL holdings normalize in the URL but never overwrite localStorage.

The temporary query-free hydration snapshot cannot erase an incoming link. Bootstrap uses actual browser URL until shared URL readiness; rendered holdings and all persistence/writeback wait for initialization. Preserve this barrier when refactoring state ownership.

## Update Rules

Persistence/codec changes update `src/hooks/use-portfolio.ts` and `src/lib/portfolio-codec.ts` with focused tests. Projection changes update `src/lib/safety-score-v9-consumers.ts` and [report-card methodology](./report-cards.md). Shell changes preserve noindex/canonical behavior; route-local module responsibilities and layout order remain source-owned.
