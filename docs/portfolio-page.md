# Portfolio Page

`/portfolio/` is a noindex/follow personal risk workspace, canonical to itself. `src/app/portfolio/page.tsx` provides the static `FeaturePageShell`; route client/model compose shared scoring and `usePortfolio`. Holdings remain client-side; there is no `/api/portfolio` endpoint.

## Data Contract

`useReportCardsV9Table()` supplies accepted grades/pillars/dependencies from the site-only compact representation, never the full report. `buildV9PortfolioProjection()` is the V9-named consumer of current Safety Score outputs, not another asset score. It computes amount-weighted informational aggregate and modeled route count. Held publication, missing cards or NR positive holdings make the aggregate unavailable. Pipeline gaps/unavailable pillars leave known-only subtotals with separate USD coverage denominators, never zero scores. Portfolio dependency exposure is unavailable, not $0, when a basket link's share is unknown. Observed zero shares stay $0, and unknown-share links still count as routes.

The holdings editor waits only for URL/local-storage initialization, not report cards. Report cards are enabled only when initialized holdings exist. Pending enrichment has an explicit loading state beside the still-editable holdings; it never implies a zero-risk portfolio.

The first-visit hero, editor and empty state prerender directly after the page header, outside Suspense. The client is imported directly: a dynamic island would move the LCP note into a hidden document-tail segment awaiting a reveal script. One workspace DOM tree survives hydration without a static duplicate or handoff. Before the workspace is parsed, synchronous same-origin `public/portfolio-bootstrap.js` sets `data-portfolio-empty` only when neither a shared URL nor a nonempty stored array exists. CSS defaults to the reserved loading areas until initialization or an explicit first-visit selection, so a blocked or failed script cannot flash an empty workspace for returning/shared visits.

The external script is allowed by the static CSP's `script-src 'self'` and bypasses Pages Functions. It only selects presentation; holdings validation and writeback remain owned by `usePortfolio`. Initialized content no longer depends on the selector.

Critical-CSS extraction temporarily matches `data-portfolio-empty` only on documents containing this bootstrap, then restores the original HTML root. Both first-visit visibility rules must be inline; otherwise the workspace still waits for the asynchronous full stylesheet despite being in the first flush.

Coin options derive from `CLIENT_ACTIVE_STABLECOINS`, excluding every other lifecycle state, not by subtracting cemetery rows. Static logos and local holdings introduce no new server data source.

## Persistence And Sharing

Priority: URL `?p=<encoded-holdings>` → localStorage `pharos:portfolio` → empty. Validate canonical IDs, discard unknown/noncanonical IDs and merge duplicates. Normalize/write back only after a successful storage-backed read. URL holdings normalize in the URL but never overwrite localStorage.

The temporary query-free hydration snapshot cannot erase an incoming link. Bootstrap uses actual browser URL until shared URL readiness; rendered holdings and all persistence/writeback wait for initialization. Preserve this barrier when refactoring state ownership. Shared `?p=` holdings stay in the browser URL but are never sent to analytics: GA page-view URLs and referrers are origin+path only ([Privacy](./privacy-page.md#website-analytics)).

## Update Rules

Persistence/codec changes update `src/hooks/use-portfolio.ts` and `src/lib/portfolio-codec.ts` with focused tests. Projection changes update `src/lib/safety-score-v9-consumers.ts` and [report-card methodology](./report-cards.md). Shell changes preserve noindex/canonical behavior; route-local module responsibilities and layout order remain source-owned.
