# /alt-pegs MVP Implementation Plan

Date: 2026-04-23

## Scope decision

Confirmed product decision:

- `TotalMcapChart` stays on the homepage.

MVP position:

- Build `/alt-pegs/` as a frontend-only feature route using existing APIs and hooks.
- Move the non-USD-specific homepage research surfaces off the homepage and replace them with a compact teaser linking into the new route.

Route naming decision:

- Keep path: `/alt-pegs/`
- Use explicit user-facing labels:
  - nav label: `Non-USD`
  - page title: `Non-USD Market Structure`
  - metadata title: `Non-USD Stablecoins: Market Structure`

## Primary user job

The page should own one clear job:

- Help a user decide whether non-USD stablecoin growth is broadening, which peg cohorts matter now, and which single cohort they should inspect next.

That means the MVP should read as:

1. current structure
2. historical growth context
3. one clear path into cohort drill-down

It should not read like a homepage overflow area with loosely related modules.

## Assumptions

- The route should be indexable and first-class, not hidden behind homepage-only navigation.
- Commodity pegs remain in scope for `/alt-pegs/`; the page is about non-USD market structure, not only fiat non-USD.
- MVP should avoid worker or shared-runtime changes unless we discover a clear frontend blocker.
- We should keep new aggregation logic in frontend-only `src/` code, with shared computations in `src/lib/`, so worker validation scope does not expand unnecessarily.

## MVP success criteria

1. `/alt-pegs/` exists as a static, indexable feature route using `FeaturePageShell`.
2. The route shows:
   - a top-fold market snapshot for the non-USD segment
   - a current peg-currency distribution module
   - a full-width historical non-USD share chart
   - a historical peg-cohort growth module
   - a server-rendered peg link hub linking into existing `/stablecoins/[peg]/` pages
3. The homepage no longer renders `NonUsdShareChart` and `PegDiversityChart` in the Research Surfaces band.
4. The homepage instead renders a compact teaser / CTA into `/alt-pegs/`.
5. The route is added to sitemap and navigation.
6. The route includes a required route-level render test and a server-rendered crawlability path for peg links.
7. The change ships without new worker endpoints.

## Explicit non-goals for MVP

- No new API endpoint
- No fiat-only vs commodity-only history toggle yet
- No new chain concentration or issuer concentration sub-pages
- No redesign of the homepage research band beyond replacing the removed charts with a compact alt-peg teaser
- No dedicated client-side cohort directory card; MVP should use one smaller static link hub instead of duplicating the distribution module
- No `About` page or footer feature-card expansion unless discoverability still feels weak after nav + homepage CTA

## Existing data we should use

Primary hooks / sources:

- `useStablecoins()` for live coin list, supply, chain count, and deltas
- `useNonUsdShare()` for historical share split between commodity and fiat non-USD
- `useStablecoinCharts()` for historical peg-currency totals
- `usePegSummary()` for peg score / current deviation context
- `useDexLiquidity()` for liquidity score context
- `useReportCards()` for structure/risk context
- `useLogos()` for leaderboard presentation

Current plan assumes all route-level analytics can be derived from those datasets in the browser.

Important contract note:

- `useStablecoins()` does not expose peg metadata directly.
- Any alt-peg filtering or grouping built from live rows must join those rows against tracked metadata from the frontend registry, not assume the API list already carries `pegCurrency`.

## Recommended file shape

### New shared frontend model files

- `src/lib/alt-peg-market.ts`
- `src/lib/__tests__/alt-peg-market.test.ts`

Why:

- The shared model is needed by both `/alt-pegs/` and the homepage teaser.
- Putting the canonical derivation under `src/app/alt-pegs/` would either force a route-folder import from homepage code or duplicate the logic.

### New route files

- `src/app/alt-pegs/page.tsx`
- `src/app/alt-pegs/page.test.tsx`
- `src/app/alt-pegs/client.tsx`
- `src/app/alt-pegs/client.test.tsx`
- `src/app/alt-pegs/static-link-hub.tsx`
- `src/app/alt-pegs/static-link-hub.test.tsx`

### Likely route-local UI files

Keep these local to the route unless a second consumer appears:

- `src/app/alt-pegs/presentational.tsx`
- or split into:
  - `src/app/alt-pegs/hero.tsx`
  - `src/app/alt-pegs/distribution-card.tsx`

### Existing files to modify

- `src/components/homepage-client.tsx`
- `src/components/homepage-client.test.tsx`
- `src/lib/nav-config.ts`
- `src/lib/__tests__/nav-config.test.ts`
- `src/app/sitemap.ts`
- `README.md`
- `docs/architecture.md`
- `docs/homepage.md`
- `docs/README.md`
- `scripts/generate-llms-txt.ts` or the checked-in route source it reads
- new route contract doc: `docs/alt-pegs-page.md`

## Implementation phases

### Phase 1. Route scaffold and metadata

Goal:

- Create the new route skeleton with the same feature-page pattern used by `stability-index`, `liquidity`, and similar routes.

Tasks:

- Add `src/app/alt-pegs/page.tsx` using `createClientFeaturePage(...)`
- Add `buildPageMetadata(...)` metadata with canonical `/alt-pegs/`
- Choose initial metadata copy:
  - title: `Non-USD Stablecoins: Market Structure`
  - description: focused on euro, gold, CPI-linked, and other non-USD market structure
- Add a simple loading skeleton sized for a feature page

Notes:

- No need for a bespoke shell. `FeaturePageShell` is the correct baseline.

### Phase 2. Shared frontend data model

Goal:

- Centralize all filtering and aggregation for alt-peg-only views in one shared frontend-only model.

Tasks:

- Add `src/lib/alt-peg-market.ts`
- Build helpers that derive:
  - `altPegCoins` by joining `useStablecoins()` rows against tracked frontend metadata, then excluding `pegCurrency === "USD"`
  - snapshot totals: total alt-peg market cap, total share of global market, fiat non-USD cap, commodity cap, active alt-peg coin count, active peg count
  - peg distribution rows from latest live market caps
  - compact trend stats from `useNonUsdShare()` for hero copy
  - peg link-hub rows using the taxonomy source of truth rather than re-deriving hrefs from live data
- Use:
  - `ACTIVE_META_BY_ID` or `TRACKED_META_BY_ID` for live-row joins
  - `PEG_TAXONOMY_PAGES`, `PEG_SLUGS`, or `peg-landing` metadata as the route-link source of truth
- Keep this logic in `src/lib/`, not `shared/lib/`, for MVP so the change stays frontend-only

Why:

- This keeps the change surgical and avoids pulling worker/shared validation into a route that can be computed entirely client-side, while still serving the homepage teaser and the route from one canonical model.

### Phase 3. Route UI composition

Goal:

- Build the page around one current-state block, one historical block, and one crawlable drill-down path.

Recommended section order:

1. `StaleDataBanner` / `QueryErrorNotice`
2. Hero snapshot
3. Current distribution by peg
4. Full-width non-USD share chart
5. Historical cohort growth
6. Server-rendered peg link hub

Tasks:

- Build a route-local hero card that shows:
  - current alt-peg market cap
  - share of total stablecoin market
  - fiat non-USD vs commodity split
  - tracked coin and peg counts
- Build a route-local distribution card:
  - ranked rows by peg market cap
  - share of alt-peg market
  - coin count
  - largest coin in the cohort
  - deep link into `/stablecoins/[peg]/`
- Reuse `NonUsdShareChart` as the main historical share module, unless route framing forces a light wrapper for copy/header control
- Do not treat `PegDiversityChart` as drop-in reuse. It is currently homepage-specific and titled `Fiat-pegged, other than USD`.
- For historical cohort growth, lock the MVP path now:
  - build a route-local `AltPegCohortHistoryChart` from `useStablecoinCharts()`
  - do not broaden `PegDiversityChart` in the MVP
- Add a smaller server-rendered peg link hub:
  - generated from taxonomy config, not live route data
  - visible or at least static-rendered in HTML
  - intended as crawlable drill-down support, not as a second full directory surface

Important implementation choice:

- Do not retrofit `PegBrowseStrip` for this route. Its homepage-specific collapsed behavior and `Fiat Except USD` shortcut are homepage browse semantics, not route-directory semantics.
- Do not alternate current and historical sections. Keep all “current structure” modules together before the history block so mixed source cadences are easier to trust.

### Phase 4. Homepage integration

Goal:

- Free the homepage from the two non-USD charts while keeping the research band coherent.

Tasks:

- Update `src/components/homepage-client.tsx`
- Remove:
  - `PegDiversityChart`
  - `NonUsdShareChart`
- Add a compact teaser card in the Research Surfaces band:
  - one strong headline
  - 2-3 compact stats
  - CTA into `/alt-pegs/`
- Keep `TotalMcapChart` on homepage unchanged

Recommended teaser positioning:

- Place it in the existing Research Surfaces band after `TotalMcapChart`
- Keep `CategoryStats` if it still earns its place after the alt-peg route is introduced

### Phase 5. Discoverability and SEO

Goal:

- Treat `/alt-pegs/` as a real product surface, not an orphan route.

Tasks:

- Add `/alt-pegs` to `src/lib/nav-config.ts`
- Update `src/lib/__tests__/nav-config.test.ts`
- Add `/alt-pegs/` to `src/app/sitemap.ts`
- Add an explicit server-rendered crawlability surface for peg links:
  - implement as `src/app/alt-pegs/static-link-hub.tsx`
  - render it from `page.tsx` through `beforeClient` / `afterClient` or an equivalent static page-level section
- Ensure command palette discoverability is automatic through nav config
- Decide explicitly that `/alt-pegs/` should be included in `/llms.txt`, then update the source that drives `scripts/generate-llms-txt.ts`

Placement recommendation:

- Put `/alt-pegs` in the primary nav block immediately after `Risk-Adjusted Yield`, with a label like `Non-USD`.
- Update `src/lib/__tests__/nav-config.test.ts` to assert the new primary-nav order explicitly.

### Phase 6. Docs

Goal:

- Keep route contracts and homepage structure docs in sync with the shipped behavior.

Tasks:

- Add `docs/alt-pegs-page.md` describing:
  - route shape
  - section order
  - data hooks
  - homepage integration contract
  - metadata ownership and canonical path
  - crawlability mechanism for peg links
  - sitemap / nav / `/llms.txt` discoverability touchpoints
  - update rules
- Update `docs/README.md` route-contract list and `Public Route Coverage` map
- Update `docs/architecture.md` route list and major feature-page inventory
- Update `docs/homepage.md` Research Surfaces section and loading-strategy/dynamic-import contract
- Update `README.md` top-level route inventory / repo-map references for the new public feature route

Docs probably not needed for MVP:

- `docs/design-language.md`, unless the route introduces a genuinely new page pattern rather than standard `FeaturePageShell` composition

## Testing plan

### Unit tests

- `src/lib/__tests__/alt-peg-market.test.ts`
  - filters out USD assets correctly
  - joins live rows to tracked metadata correctly
  - computes snapshot totals correctly
  - ranks peg distribution correctly
  - builds taxonomy-backed deep-link rows for existing peg pages

### Client / integration-level tests

- `src/app/alt-pegs/page.test.tsx`
  - verifies `page.tsx` includes the static link hub in the route composition
  - verifies the route-level server/client wiring matches the planned crawlability contract
- `src/app/alt-pegs/client.test.tsx`
  - mocked hooks
  - verifies the route renders core current-state sections
  - verifies the history block renders
- `src/app/alt-pegs/static-link-hub.test.tsx`
  - verifies peg drill-down links render from taxonomy data in server-rendered HTML
  - verifies expected representative peg routes are present
- `src/components/homepage-client.test.tsx`
  - verifies homepage no longer renders the removed non-USD charts
  - verifies the new alt-peg teaser is present
- `src/lib/__tests__/nav-config.test.ts`
  - verifies route ordering after nav insertion

## Validation commands

Expected command set for this MVP:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run seo:check`
- `npm run check:llms-txt`
- `npm run test:merge-gate`

Required manual verification after the build:

- confirm `out/alt-pegs/index.html` contains crawlable peg links from the static link hub
- confirm generated `/llms.txt` output includes `/alt-pegs/`

Because the plan intentionally avoids `shared/` and `worker/` edits, worker typecheck should not be required unless implementation drifts into shared runtime code.

## Risks and mitigations

### Risk 1. Current vs historical numbers feel inconsistent

Cause:

- Live snapshot sections use `useStablecoins()`, while historical sections use `useStablecoinCharts()` and `useNonUsdShare()`.

Mitigation:

- Make the hero and distribution modules explicitly "current market structure"
- Keep historical charts visually separated and labeled as history
- Use one page-wide stale/freshness treatment so users understand this is one coherent snapshot with mixed source cadences

### Risk 2. Homepage research band becomes visually thin after chart removal

Mitigation:

- Replace the removed charts with a purposeful teaser, not just a text link
- Keep at least one compact market-structure story visible on the homepage

### Risk 3. Route-local logic becomes too broad

Mitigation:

- Keep the shared aggregation helpers in one frontend-only `src/lib/alt-peg-market.ts`
- Avoid splitting that model further unless a third consumer or a clearly separate responsibility appears

### Risk 4. Crawlability ends up hidden behind client rendering

Mitigation:

- Make peg drill-down links part of a server-rendered section, not only a client-computed table or directory
- Record the crawlability contract explicitly in the route doc and `/llms.txt` decision

## Recommended implementation order

1. Route scaffold + metadata
2. Shared alt-peg market model + tests
3. Hero + distribution modules
4. History block (`NonUsdShareChart` reuse + route-local `AltPegCohortHistoryChart`)
5. Homepage teaser swap
6. Server-rendered peg link hub
7. Nav + sitemap + `/llms.txt`
8. Docs
9. Full validation pass

## Final recommendation

For MVP, keep this intentionally tight:

- one new route
- one shared frontend-only alt-peg market model
- two route-local current-state modules
- one history block, with only `NonUsdShareChart` reused unchanged
- one homepage teaser swap
- one server-rendered link hub
- one nav + sitemap + docs + `/llms.txt` pass

That gets `/alt-pegs/` live quickly without dragging the worker, API contracts, or shared runtime into the change.
