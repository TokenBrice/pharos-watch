# Homepage

Contract for `/`. `src/app/page.tsx` owns server metadata/JSON-LD, `src/components/home-alt-hero.tsx` the heading/summary and `home-alt-client.tsx` the deferred workbench. Component order lives in source, not a second inventory here.

## Top-Fold Contract

Keep exactly one raw visible `h1` across breakpoints. Metadata is canonical `/` with the shared OG card; CollectionPage/ItemList JSON-LD uses core stablecoins/cash equivalents. The server hero fallback and market-cap KPI exclude variants and stable-value investments.

`getHomepageHeroSnapshot()` in `src/lib/homepage-static-snapshot.ts` reads checked-in public data as fallback only. Preserve that selection through hydration, then reconcile from the existing cache-sharing `useStablecoins()` query. Fallback must be dated and at most 72 hours old; older/undated data is unavailable without live data. A minute clock reevaluates producer age and fallback expiry.

The market-state line reuses regime-bar PSI and Active Depegs peg-summary queries, including the same confirmed incident count as `/depeg/` (excluding NAV tokens). It adds no source and no DEWS claim. Missing sources say unavailable, not zero; non-fresh evidence carries shared health notices.

The global recent-events rail is in normal flow below sticky navigation on desktop; only navigation remains pinned. On mobile it mounts only on the homepage, not invisibly on interior routes. The fresh-blog banner uses build-time eligibility; expiry disappears on the next deploy, not the visitor's clock, and never precedes the page heading.

## Query And State Model

Cache-sharing clients isolate heavy rankings/signal queries from the eager summary. Shared loading/ready/empty/unavailable/stale-with-data semantics apply: failed reads without retained data show unavailable plus retry, never healthy/empty. Retained values keep age/notices; only successful zero-row responses claim empty. Rankings name failed source families.

### Supply And Cohorts

Current supply records observed/expected core IDs, present-but-unavailable rows and omitted rows independently. No observations means a nullable headline, then eligible dated fallback or unavailable; explicit observed zeros stay zero. Partial coverage is a Known market cap subtotal with observed/expected census. Named cohorts require every member; unobserved subgroups are unavailable. Others sums observed assets outside named cohorts. Cohort/non-USD shares use positive observed subtotal, labeled Shares of known market cap subtotal when incomplete; missing supply enters neither numerator nor denominator.

Only successful data with a fresh producer `updatedAt` is Live. Without producer time say Freshness unavailable / generation unavailable; query `dataUpdatedAt` is receipt time, never displayed source time or freshness authority. Stale/degraded/failed refreshes preserve producer dates and notices.

### Instrument Cards

Each card uses its destination hero's selector, basis, format and universe, not an independent approximation: displayed PSI (not raw instant when rolling is published), freezable share, confirmed active incidents and best-paid risk in the Yield landing band. Yield overview and top-PYS rows use that same landing view; retained values preserve API quality warnings and retry. Transition names and reduced motion follow the shared view-transition owner.

Active-depeg rows come from peg-summary incident flags within active IDs, independent of event pagination/current-deviation availability. Display bounds name Top N of M; missing observations/ages stay unavailable. Zero incidents does not mean every asset is at peg.

Supply movers partition observed positive/negative changes before ranking; never fill one side with opposite-sign rows. Both endpoints must be observed and the previous value positive; explicit current zero can be a contraction. `supply-moves-card.tsx` owns admission and reviewed-protocol-internal-flow exclusion windows. The measured change is not netted/rewritten elsewhere; digest absolute-dollar ranking is a different population. Mint/burn activity uses the canonical signal: offsetting flows are balanced activity, unvalued active nets unavailable.

DDR overview separates resolver/reviewer generations/reasons, freshness and retry. `computedAt` anchors the dated envelope; absent transport status defaults fresh only absent stale/degraded evidence. Retained rows are not live; empty means no published active forecasts in that snapshot. Only valid frozen predictions count as verdicts; pending/no-call/invalidated rows remain visible without calls. Durations stay locked; elapsed-deadline overlays never rewrite frozen evidence.

Digest promo without data shows unavailable and Telegram CTA, not fabricated archive copy; decorative prior-edition folds remain blank without archive data.

### Browser State

Shared watchlist `pharos-watchlist-v1` holds normalized IDs. Legacy homepage/yield keys migrate once and are deleted. Homepage projects the first 12 unique active IDs without truncating canonical storage; starring a saved ID below that cap promotes it, unstarring a visible pin removes it. Pins do not bypass filters/search.

`pharos-shortcuts` holds ordered local nav hrefs. Legacy six-item defaults expand; the non-editing panel backfills visible defaults while edit mode shows only saved hrefs. Neither store is server identity or a shared watchlist.

### HomepageTape

`src/components/homepage-tape.tsx` reads the canonical latest-events query through same-origin site data, excludes score events and applies `collapseForHomepageStrip`. Query errors/valid empty collapsed data render no ticker; smoke checks the underlying endpoint, not visible copy. `formatTapeEventTitle()` maps stored warning keys/chain IDs to shared public labels. Hover/focus pauses motion; reduced motion provides horizontal scrolling. One nonduplicated View all events link opens `/timeline/`; [Timeline](./tape-page.md) owns archival/publication semantics.

## URL Filter Contract

`use-home-alt-filters.ts` and the shared codec own `peg` (one cohort) and `variant` (core default, variants or catalog). Invalid peg state normalizes to all; all/empty/default values clear the key. Updates replace history without scroll jumps. Peg browse links/counts derive from the canonical taxonomy, not route-local copies.

## Stablecoin Overview

Before hydration, a real leading-core profile directory plus Screener link remains visible/crawlable alongside the shape-matched table placeholder. Background metric refresh preserves page/scroll; filter/search/sort/pinning resets them and shrinking results clamp the page.

Deviation text/severity uses published `peg-summary.currentDeviationBps`, not a second calculation from independently refreshed price. Liquidity zero remains measured/coloured; only missing data is `—`. Mint is the published Economic Control component, never a second score lane; missing breakdowns show NR. Curated route describes review coverage, not score. Shared table/export owners define headers and band keys; homepage suppresses header methodology hints while Screener retains them.

## Loading Strategy

The eager summary preserves first-paint content. Idle/viewport gates defer the live SVG history chart; heavier sections use shape-matched progressive fallbacks. Each lazy section retains measured responsive height until offscreen; update reserves when layout height changes so mounting does not shift the footer.

Historical total is independent of cohort query availability. Keep provider-era peg-bucket census; never retroactively require later buckets. Unavailable buckets remain gaps. Supplements add only observed bounded as-of data and never erase provider buckets when archives are absent. Rebuild publication from provider history/supplemental archives so corrected data replaces poisoned cache.

A cohort is null before its first observation and on loading/failure, including failed refresh with cached history. Only successful nonempty history plus authored launch date establishes pre-existence zero; archive start alone does not. USDS+DAI requires both histories after launch. Others requires all operands and a nonnegative residual; over-attribution remains unavailable. Retain all points/gap boundaries, omit degenerate filled singletons, mark unavailable hovers and disclose real gaps after initial loading. Cohort recovery must not replace the aggregate.

## Update Rules

Update this owner for cohort, unavailable/freshness, URL/persistence, server/live handoff and SEO contracts. Source owns layout/component order. [Architecture](./architecture.md) owns integrity rules, [Design Language](./design-language.md) visual grammar and [Data Flow Map](./data-flow-map.md) source-to-hook routing.
