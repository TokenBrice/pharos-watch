# Stablecoin Taxonomy Pages

Static `/stablecoins/**` is the crawlable cohort family: directory plus peg, backing, governance and infrastructure axes. Membership/count/order are checked-in metadata facts; current measurements come from embedded live tables. This is not another Screener.

## Route Shape

`src/lib/stablecoin-taxonomy.ts` owns models, axis hub config and `ALL_STABLECOIN_TAXONOMY_PAGES`; `src/lib/peg-taxonomy.ts` owns peg pages. Routes under `src/app/stablecoins/` use shared taxonomy hub/static-slug factories. Generate exact params from models and `notFound()` unknown slugs, never empty fallback cohorts.

Peg has no `/stablecoins/peg/` hub. Peg slugs directly share `/stablecoins/` with backing/governance/infrastructure axis segments, so collisions are forbidden. Slug/href helpers in `stablecoin-taxonomy-urls.ts` and `peg-landing.ts` are authority; callers must not hand-build URLs or copy a generated route matrix.

## Cohort Membership

Cohorts derive from active registry (peg uses its client mirror). Any pre-launch/quarantine/delist/freeze transition can rewrite membership/count/title without a route edit. The A–Z directory deliberately uses tracked client registry so non-active profiles remain discoverable.

Empty handling is asymmetric: backing filters empty cohorts out of static params/hub/sitemap; governance and infrastructure retain empty indexed pages. Removing their last member is therefore a content decision. Peg routes require active members; pre-launch-only currency records do not activate one. Axis hubs sort by descending membership, not authored release order.

The embedded table's `page.filterTag` must match `shared/lib/filter-tags.ts` for exactly those members. A nonzero static cohort with an empty live table is not acceptable drift.

## Titles And Authored Copy

`buildCohortTitle()` owns count interpolation and 61-character budget; its only compaction fallback drops Infrastructure. Backing/governance and peg overflow do not have a broad automatic fallback: choose fitting base titles. Counts must not become literals in docs/fixtures.

Description serves metadata/hub blurb and the one-line instrument-header deck; intro (plus the peg risk summary) is visible explanation folded under "About … stablecoins" but still server-rendered. Peg intro/context is authored in `peg-landing.ts`, while top coins/risk composition derive from registry; each authored sentence renders once per page. Edit authored halves rather than generated sentences. Shared classification owns labels, tags and symbols.

Cohort pages lead with data: header (title, deck, Compare leaders/Alerts actions, folded intro), then the live table, then the static directory, linked directories and related hubs. Keep the table in the first desktop viewport; crawlable context belongs below it or in the fold, not above it.

The gold and silver peg pages add a static "Physical delivery terms" table directly under the live table (`src/components/physical-delivery-terms-table.tsx`). Rows come from cohort members whose reviewed `REDEMPTION_BACKSTOP_CONFIGS` route has metal-matched `physicalCommodityDelivery`: metal per token, minimum delivery, bar class, vaults, eligibility and review date, with `physicalToUsd` supplying the lot, bar and vault terms. A route past its `physicalToUsd.reviewExpiresAt`, or whose route review is older than the shared reviewed-evidence budget, is omitted; terms a route does not record read "Not recorded".

## Crawlability

`src/lib/public-route-inventory.ts` projects hubs/cohorts into sitemap; exact-inventory tests are the gate. Shared shell emits member ItemList and DefinedTerm (cohort tag, or peg currency, with parent axis defined-term set); hubs emit cohort-link ItemLists.

Keep legacy protocol-lineage redirects to infrastructure and out of sitemap. Directory/cohort discovery flows through footer hub, command palette and in-page links including homepage/Alt-Pegs, not individual primary-nav entries. Route lists belong to model projection, not a second doc index.

## Adding A Cohort Or Peg Slug

This adds indexed content, not just enum data:

1. Extend the owning enum; generated active peg currencies still derive from active registry during bootstrap.
2. Add the canonical slug map and confirm no peg/axis collision.
3. Author the matching taxonomy content or peg intro/context and check rendered title budget.
4. Verify shared filter-tag assignment matches members, including lifecycle/empty-cohort effects.
5. Run taxonomy hub and exact sitemap suites and regenerate sitemap dates for new routes. `src/app/stablecoins/__tests__/taxonomy-hub-pages.test.tsx` and `src/app/__tests__/sitemap-frozen.test.ts` own those checks.

## Update Rules

Update this contract for membership asymmetry, slug/title/authoring boundaries or indexing/schema changes. Generated route/coin rosters and currency-addition diaries stay out. Related owners: [Alt-Pegs](./alt-pegs-page.md), [Classification](./classification.md), [Architecture](./architecture.md).
