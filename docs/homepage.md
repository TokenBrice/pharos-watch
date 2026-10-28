# Homepage

Contract for `/`. `src/app/page.tsx` owns server metadata/JSON-LD, `src/components/home-alt-hero.tsx` the heading/summary and `home-alt-client.tsx` the deferred workbench. Component order lives in source, not a second inventory here.

## Top-Fold Contract

Keep exactly one raw visible `h1` across breakpoints. Metadata is canonical `/` with the shared OG card; the title and description use the headline count authority `HEADLINE_STABLECOIN_COUNT`/`HEADLINE_STABLECOIN_LABEL` in `src/lib/universe-vocabulary.ts` ("{N} active stablecoins", the active universe), shared with the site description, `llms.txt` and the About headline; any larger total must name its universe; CollectionPage/ItemList JSON-LD uses core stablecoins/cash equivalents. The server hero fallback and market-cap KPI exclude variants and stable-value investments.

`getHomepageHeroSnapshot()` in `src/lib/homepage-static-snapshot.ts` reads checked-in public market data and acquires a bounded dated history preview at build time as fallback only. Preserve that selection through hydration, then reconcile from the dedicated cache-sharing `useHomepageSnapshot()` query. Fallback must be dated and at most 72 hours old; older/undated data is unavailable without live data. A minute clock reevaluates each lane's producer age and fallback expiry. Build history acquisition failures leave the existing dated headline available; they never create an empty or fresh history claim.

The hero and market-state line share the site-only compact homepage snapshot, not the full stablecoins or peg-summary feeds. Its market lane uses `buildLiveHomepageHeroSnapshot`, PSI uses `getDisplayedPsi`, and incidents use the same confirmed non-NAV peg-summary count as `/depeg/`. Each lane independently carries data or null, source identity, original producer generation, assessment time, effective freshness budgets and machine-readable unavailable/degraded reasons. The PSI lane retains the older sample clock. No DEWS claim is added. Missing sources say unavailable, not zero; one failed lane does not withhold successful siblings. Pulse/rankings consumers needing rows may still fetch full publications behind their existing visibility gates.

The global recent-events rail is in normal flow below sticky navigation on desktop; only navigation remains pinned. On mobile it mounts only on the homepage, not invisibly on interior routes. The fresh-blog banner uses build-time eligibility; expiry disappears on the next deploy, not the visitor's clock, and never precedes the page heading.

Homepage server-only blog/media chrome uses inline decorative SVG and explicit-size, lazy native host-logo images. Do not import shared client icon/image leaves into these server branches: Next's root homepage client-reference group can otherwise attach the homepage and chart chunk list to unrelated routes.

## Data Health

The homepage never renders data-health warnings: no stale/degraded/failed/retained banners, notices, chips, state words, amber/red health tones or retry buttons. Data that is present (fresh, stale, degraded or retained) renders normally, with at most a neutral "as of" producer-generation stamp where a card already dates itself; no usable data keeps the card shape with a neutral placeholder (`—` or "Updating"), never zero, healthy or empty. Neutral data qualifiers stay (unavailable per-value cells, cohort gaps); the hero shows no supply-completeness text. The status bar is a plain muted "System status" link to `/status/`, and section render crashes (`HomeSectionErrorBoundary`) log the error but show only the same neutral placeholder. Ops state lives in admin and alerts. ESLint bans the warning components as direct imports of homepage files. Shared descendants are covered by `homepage-no-health-warnings.test.tsx`, which renders every homepage section (with real dynamic children) under stale, degraded, failed-refresh and 503 states, and walks the homepage import tree for banned components against a reviewed allowlist.

## Query And State Model

Cache-sharing clients isolate heavy rankings/signal queries from the eager summary. Shared loading/ready/empty/unavailable/stale-with-data semantics still decide what renders: failed reads without retained data show the neutral placeholder, never healthy/empty; only successful zero-row responses claim empty.

Rankings use the site-only `/api/dex-liquidity-table` projection rather than full DEX liquidity. Its nullable score is shared by row display, sorting and export; source health and CSV generation provenance retain the original producer metadata. It is not a capped cohort statistic or a replacement for the full liquidity page.


### Supply And Cohorts

Current supply records observed/expected core IDs, present-but-unavailable rows and omitted rows independently. No observations means a nullable headline, then eligible dated fallback or unavailable; explicit observed zeros stay zero. Partial coverage keeps the plain Core market cap label over the known subtotal; the observed/expected census is computed but not rendered on the homepage (OG cards still use it). A recorded partial-chain remainder also blocks completeness: the hero counts `supplyPartialCount` and `supplyCoverageUnknownCount` (coverage not recorded, e.g. a static dataset row without `supplyProvenance`) inside `supplyObservedCount`, and is complete only when every core member is observed and none is partial. Unrecorded coverage is legacy, never partial, so a pre-provenance static fallback is never counted as partial. The census numerator excludes partial members. Named cohorts require every member observed and not partial; unobserved or partial subgroups are unavailable. Others sums observed assets outside named cohorts. Cohort/non-USD shares use positive observed subtotal; missing supply enters neither numerator nor denominator.

The hero stamps "As of" the displayed snapshot's producer date. Without producer time it shows no date; query `dataUpdatedAt` is receipt time, never displayed source time or freshness authority.

### Instrument Cards

Each card uses its destination hero's selector, basis, format and universe, not an independent approximation: displayed PSI (not raw instant when rolling is published), freezable share, confirmed active incidents and best-paid risk in the Yield landing band. Yield overview and top-PYS rows use that same landing view. Transition names and reduced motion follow the shared view-transition owner.

Active-depeg rows come from peg-summary incident flags within active IDs, independent of event pagination/current-deviation availability. Display bounds name Top N of M; missing observations/ages stay unavailable. The card counts coins with open confirmed incidents (the market-state line keeps "active depegs" to fit mobile); zero does not mean every asset is at peg. Rows carry the `/depeg/` recovery-evidence label in their accessible name and tooltip; ages and evidence use a hydration-safe minute clock, not receipt time.

Supply movers partition observed positive/negative changes before ranking; never fill one side with opposite-sign rows. Both endpoints must be observed and the previous value positive; explicit current zero can be a contraction. The table's shared provenance classifier excludes partial-chain remainders. `supply-moves-card.tsx` owns the floor and reviewed-internal-flow exclusion windows. Digest absolute-dollar ranking is a different population. Mint/burn activity uses the canonical signal: offsetting flows are balanced activity, unvalued active nets unavailable.

DDR overview stamps resolver and reviewer `computedAt` independently. Its track record adds the hero's [promoted-accuracy lines](./depeg-page.md#forecast-grading). Rows from an unusable snapshot are not shown; empty means no published active forecasts in that snapshot. Only valid frozen predictions count as verdicts; pending/no-call/invalidated rows remain visible without calls. Durations stay locked; elapsed-deadline overlays never rewrite frozen evidence. Rows order by live deviation, else the live event peak (never the frozen lock peak).

The desktop digest promo reads only site-only `/api/digest-promo`: latest daily title/edition/excerpt and two prior title/edition leaves, without full archive or intelligence reads. Its CSS-controlled `@4xl` slot is measured before mounting; hidden slots make no digest requests, and the desktop grid track stays reserved through hydration. Without data it shows the Telegram CTA; prior leaves stay blank. The `/digest/` lead retains [API-ranked risk evidence](./digest-pipeline.md#archive-lead-preview).

### Browser State

Shared watchlist `pharos-watchlist-v1` holds normalized IDs. Legacy homepage/yield keys migrate once and are deleted. Homepage projects the first 12 unique active IDs without truncating canonical storage; starring a saved ID below that cap promotes it, unstarring a visible pin removes it. Pins do not bypass filters/search.

`pharos-shortcuts` holds ordered local nav hrefs. Legacy six-item defaults expand; the non-editing panel backfills visible defaults while edit mode shows only saved hrefs. Neither store is server identity or a shared watchlist.

The compact homepage snapshot is retained in a versioned, schema-validated IndexedDB envelope containing public market evidence only. It restores after hydration, never changes server/first-client markup or seeds React Query, and never waits in front of the live request. Restored lanes keep their original generation until an equal/newer successful live generation qualifies them. Each lane expires under the existing 72-hour fallback ceiling, reevaluated by the hydration-safe minute clock even without a live response; newer live/build generations take precedence. Corruption, unavailable storage and methodology/schema changes discard the saved evidence, not the live read (envelope version 2 discards v1 envelopes, which lack the chain-coverage counts). Full publications/history and personal preferences are excluded; [browser evidence handoff](./process/worker-infrastructure-appendix.md#browser-critical-data-and-retained-evidence) owns storage/lifecycle details.

### HomepageTape

`src/components/homepage-tape.tsx` reads the canonical latest-events query through same-origin site data, excludes score events, drops operational-only yield warnings via `projectTapeEventsForReader()` (ADR-42), and applies `collapseForHomepageStrip`. Query errors/valid empty collapsed data render no ticker; smoke checks the underlying endpoint, not visible copy. `formatTapeEventTitle()` maps stored warning keys/chain IDs to shared public labels. Hover/focus pauses motion; reduced motion provides horizontal scrolling. One nonduplicated View all events link opens `/timeline/`; [Timeline](./tape-page.md) owns archival/publication semantics.

`CoreTopRail` dynamically loads the tape. Text-first routes share `isEditorialPath()` in `src/lib/editorial-routes.ts`: their desktop tape mounts only after document load and an idle opportunity, with a persistent 40 px rail reserve. Interior mobile routes do not mount it. Deferral creates no empty/healthy event claim and does not change polling or producer freshness.

## URL Filter Contract

`use-home-alt-filters.ts` and the shared codec own `peg` (one cohort) and `variant` (core default, variants or catalog). Invalid peg state normalizes to all; all/empty/default values clear the key. Updates replace history without scroll jumps. Peg browse links/counts derive from the canonical taxonomy, not route-local copies.

## Stablecoin Overview

Before hydration, a real leading-core profile directory plus Screener link remains visible/crawlable alongside the shape-matched table placeholder. Background metric refresh preserves page/scroll; filter/search/sort/pinning resets them and shrinking results clamp the page.

Deviation text/severity uses published `peg-summary.currentDeviationBps`, not a second calculation from independently refreshed price. Liquidity zero remains measured/coloured; only missing data is `—`. Mint is the published Economic Control component, never a second score lane; missing breakdowns show NR. Curated route describes review coverage, not score. Shared table/export owners define headers and band keys; homepage suppresses header methodology hints while Screener retains them.

Pins retain filtered-sort ranks. CSV keeps those ranks, full displayed order (not the page/virtual slice) and source-generation preamble. Partial-chain supply stays visible; its 24h/7d changes and sparkline are withheld via the shared provenance classifier. Changes show `—`, sort last in either direction and export empty; observed zero stays numeric.

## Loading Strategy

The eager summary preserves first-paint content. Idle/viewport gates defer the live SVG history chart; heavier sections use shape-matched progressive fallbacks. Each lazy section retains measured responsive height until offscreen; update reserves when layout height changes so mounting does not shift the footer. Static skeletons read shared axis geometry from `chart-theme.ts`, never the Recharts axes module, so placeholders do not eagerly pull in charts.

The server-rendered history preview contains at most the last 90 provider-series points, with all gaps retained, and explicitly says Fallback history with its source date. It is a preview rather than a shorter live-history default. Only the aggregate lane's own clock admits that drawing under the same 72-hour fallback limit; it is never relabeled live or installed in a full-history/global query cache.

The homepage emits a plain, route-local parser-executed inline script before its content; Pages middleware adds the per-response CSP nonce. It starts only the compact `homepageSnapshot` and shared light `stabilityIndex` descriptor transports, with the same same-origin site-data admission and browser Accept attribution as normal API reads. An explicit API-base override disables this bootstrap. No full stablecoins/peg-summary publication, schema graph, QueryClient or live DOM update is bootstrapped.

The canonical query attempt atomically adopts each raw `{status, headers, bodyText}` outcome once; same-key observers share TanStack's attempt. Network/body transfer and lazy schema loading overlap, but JSON/schema validation and normal metadata processing still precede cache admission. Startup failures remain failures and ordinary query retries fetch normally. The shared ten-second request deadline starts at parser launch and includes body consumption; adoption never resets it. Query cancellation retains its original reason, including cancellation while a schema is loading.

Unclaimed transports are released on the first pathname transition, popstate, pagehide (including bfcache departure), request-fingerprint mismatch, or the bounded twenty-second document handoff expiry. Later polls and SPA visits use ordinary transport; the document registry cannot restart on A→B→A. Startup/adoption clocks never replace producer timestamps, freshness budgets, warnings or unavailable reasons, and static/first-client markup remains unchanged.

The visible, hydrated hero chart uses a 2.5-second idle deadline where `requestIdleCallback` exists. Without it, two animation frames plus a separate 150 ms fallback delay activate the gate after paint rather than imposing that deadline as a fixed wait. Analytics schedules idle work immediately in its effect with its own two-second deadline/post-paint fallback, without waiting for window `load`.

An initial URL anchor force-mounts only its owning deferred section; unrelated panels keep their viewport gates and responsive height reserves. Section headings inside unloaded chunks are resolved and scrolled to once their DOM arrives. `/#home-alt-rankings` and its heading target mount rankings, not the pulse cards or lower overview modules. Unknown/top-fold hashes do not bypass any gates. The Horizon constellation and its registry/logo dependencies are dynamically imported only when its below-fold gate mounts, including a matching anchor entry.

Historical total is independent of cohort query availability. Keep provider-era peg-bucket census; never retroactively require later buckets. Unavailable buckets remain gaps. Supplements add only observed bounded as-of data and never erase provider buckets when archives are absent. Rebuild publication from provider history/supplemental archives so corrected data replaces poisoned cache.

The live hero issues one dedicated `homepage-history` query. The Worker joins the published aggregate chart with four completion-fenced 5,000-day supply histories using the shared `buildTotalMcapChartRows` authority. It adds no upstream fetches, cron fanout or migration. Each input retains its own clock/budget/reason; failures remain independent and do not erase the aggregate. The browser no longer downloads the five raw inputs or repeats their alignment. SVG area/line strings are memoized independently of pointer hover.

A cohort is null before its first observation and on loading/failure, including failed refresh with cached history. Only successful nonempty history plus authored launch date establishes pre-existence zero; archive start alone does not. USDS+DAI requires both histories after launch. Others requires all operands and a nonnegative residual; over-attribution remains unavailable. Retain all points/gap boundaries, omit degenerate filled singletons, mark unavailable hovers and leave real gaps visible in the chart without a caption. Cohort recovery must not replace the aggregate.

## Shared Shell Loading

Theme, query cache, source navigation and global search remain stable providers across navigation. Optional shortcut/toast/route-progress plumbing is a sibling lazy island, never an async parent of route content. `src/lib/editorial-routes.ts` owns the text-first route policy used by that island and the deferred desktop market tape. PSI chrome imports the narrow classification leaf; `shared/types/stability-constants.ts` owns its band vocabulary without executable schemas, while full API readers still validate before cache admission.

Retained-homepage evidence is route-local: only the homepage mounts its provider under the shared query client. Other routes do not load its persistence module or subscribe to homepage query publications; detail has its own bounded per-coin retained-evidence provider.

Footer research and about/legal links retain their crawlable anchors, order and labels but explicitly disable Next route prefetch. They are discovery links, not an instruction to download every hub as soon as a short route exposes the footer. The blog banner and homepage teaser profile links disable Next route prefetch, so unvisited destinations do not download their cover or Tweet media.

Desktop top-nav section panels (`src/components/top-nav.tsx`) stay mounted, so every `nav-config.ts` destination is a crawlable anchor in static HTML. A closed panel is `hidden` + `inert` (neither visible nor focusable); open, focus, hover-intent and Escape behavior is state-driven as before, and the Status link is a plain destination with no health read, dot or state word.

## Update Rules

Update this owner for cohort, unavailable/freshness, URL/persistence, server/live handoff and SEO contracts. Source owns layout/component order. [Architecture](./architecture.md) owns integrity rules, [Design Language](./design-language.md) visual grammar and [Data Flow Map](./data-flow-map.md) source-to-hook routing.

Section composition stays in its live consumers; do not retain unused section-wrapper exports as a parallel layout API.
