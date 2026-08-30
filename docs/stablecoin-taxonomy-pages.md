# Stablecoin Taxonomy Pages

Route contract for the static `/stablecoins/**` taxonomy family.

---

## Purpose

`/stablecoins/**` is the crawlable cohort family: one directory hub plus four browse axes — peg currency, backing type, governance model, and shared infrastructure. Each cohort page is a static, indexable landing surface that introduces the cohort in authored prose, lists its members, and then hands off to the live filtered table.

It is not a second screener. Cohort membership, ordering, and counts are build-time facts derived from checked-in `StablecoinMeta`; current market data always comes from the embedded live table.

---

## Route Shape

| Route | Template | Page model |
| --- | --- | --- |
| `/stablecoins/` | `src/app/stablecoins/page.tsx` | `AXES` (all four axes) plus an A–Z profile directory |
| `/stablecoins/[peg]/` | `src/app/stablecoins/[peg]/page.tsx` | `PEG_TAXONOMY_PAGES` in `src/lib/peg-taxonomy.ts` |
| `/stablecoins/backing/` | `src/app/stablecoins/backing/page.tsx` | `STABLECOIN_TAXONOMY_HUB_ROUTES.backing` |
| `/stablecoins/backing/[backing]/` | `src/app/stablecoins/backing/[backing]/page.tsx` | `BACKING_TAXONOMY_PAGES` |
| `/stablecoins/governance/` | `src/app/stablecoins/governance/page.tsx` | `STABLECOIN_TAXONOMY_HUB_ROUTES.governance` |
| `/stablecoins/governance/[governance]/` | `src/app/stablecoins/governance/[governance]/page.tsx` | `GOVERNANCE_TAXONOMY_PAGES` |
| `/stablecoins/infrastructure/` | `src/app/stablecoins/infrastructure/page.tsx` | `STABLECOIN_TAXONOMY_HUB_ROUTES.infrastructure` |
| `/stablecoins/infrastructure/[infrastructure]/` | `src/app/stablecoins/infrastructure/[infrastructure]/page.tsx` | `INFRASTRUCTURE_TAXONOMY_PAGES` |

The page models and hub route configs live in `src/lib/stablecoin-taxonomy.ts`. The three axis hubs share one template — `buildStablecoinTaxonomyHubMetadata(route)` and `createStablecoinTaxonomyHubPage(route)` in `src/app/stablecoins/taxonomy-page.tsx` — so a hub route file carries no page-specific markup, only its `STABLECOIN_TAXONOMY_HUB_ROUTES` entry.

Every cohort page is a `createStaticSlugRoute(...)` route (`src/lib/static-slug-page.ts`): `generateStaticParams` enumerates the page model, and a slug outside it renders `notFound()` rather than an empty cohort.

Peg has no `/stablecoins/peg/` hub. Peg slugs sit directly under `/stablecoins/`, sharing that path segment with `backing`, `governance`, and `infrastructure`, so a peg slug may never collide with an axis segment.

---

## Cohort Membership

- Cohorts are filtered from `ACTIVE_STABLECOINS` (`shared/lib/stablecoins/registry.ts`); the peg axis uses the client mirror `CLIENT_ACTIVE_STABLECOINS` (`shared/lib/stablecoins/client-registry.ts`). A lifecycle change alone — pre-launch, quarantined, delisted, frozen — rewrites cohort membership, counts, and titles across this family with no edit to any route file.
- The hub's A–Z profile directory is the deliberate exception: it iterates `TRACKED_STABLECOINS`, so non-active profiles stay linked from `/stablecoins/`.
- Empty-cohort handling is asymmetric. `BACKING_TAXONOMY_PAGES` ends with `.filter((page) => page.coins.length > 0)`, so a backing cohort that empties silently drops its route from `generateStaticParams`, the hub, and the sitemap. `GOVERNANCE_TAXONOMY_PAGES` and `INFRASTRUCTURE_TAXONOMY_PAGES` are not filtered: an emptied governance or infrastructure cohort still publishes an indexed page with a zero-coin title. Removing the last coin from those axes is a content decision, not a no-op.
- Backing, governance, and infrastructure axes sort cohorts by descending member count, so hub card order is data-driven rather than authored.
- Slugs are owned by `GOVERNANCE_SLUGS` / `BACKING_SLUGS` / `INFRASTRUCTURE_SLUGS` in `src/lib/stablecoin-taxonomy-urls.ts` and by `PEG_SLUGS` in `src/lib/peg-landing.ts`, which is restricted to pegs with at least one tracked coin. Build these hrefs elsewhere through `buildGovernanceTaxonomyUrl(...)`, `buildBackingTaxonomyUrl(...)`, `buildInfrastructureTaxonomyUrl(...)`, and `buildPegLandingUrl(...)` instead of string templates.
- The live table on a cohort page is driven by `page.filterTag`, which must be the same tag `shared/lib/filter-tags.ts` assigns to member coins. A cohort whose `filterTag` drifts from the tag builder renders an empty table under a non-zero cohort count.

---

## Titles And Authored Copy

- `buildCohortTitle(...)` in `src/lib/stablecoin-taxonomy.ts` renders `<Base>: N Coins Ranked by Risk` (or `: 1 Coin Tracked`) against a 61-character SEO title budget. Its only compaction fallback drops `Infrastructure` from an infrastructure base title; an overflowing backing or governance title is emitted long. Choose base titles that fit rather than widening the fallback. Peg titles use the parallel `buildPegTaxonomyTitle(...)` in `src/lib/peg-taxonomy.ts`, which has no compaction step at all.
- `intro`, `description`, and hub `leadParagraphs` are content contracts, not incidental markup: `description` is both the page meta description and the hub card blurb, and `intro` is the visible cohort explanation rendered as the lead paragraph.
- Peg copy is part authored and part derived: `buildPegIntro(...)` composes `PEG_INTRO` and `PEG_MARKET_CONTEXT` (`src/lib/peg-landing.ts`) with a generated top-coin list, and `buildPegRiskSummary(...)` derives the cohort's dominant backing, dominant governance, and freezable-coin count from the registry. Editing peg prose means editing the authored halves, not the generated sentence.
- Cohort sizes are interpolated into titles, descriptions, and directory copy. Never restate one as a literal in docs or fixtures; read the registry.

---

## Crawlability

- The four hubs are `reference` entries and every cohort page is a `taxonomy` entry in `src/lib/public-route-inventory.ts`, sourced from `ALL_STABLECOIN_TAXONOMY_PAGES` and `PEG_SLUGS`. `src/app/__tests__/sitemap-frozen.test.ts` asserts the sitemap is exactly the projection of that inventory, so any added or dropped cohort route surfaces there first.
- Hubs emit `ItemList` JSON-LD over their cohort links; cohort pages render through `StablecoinTaxonomyShell` (`src/components/stablecoin-taxonomy-shell.tsx`), which emits an `ItemList` of member coins plus a `DefinedTerm` whose `termCode` is the cohort's filter tag (peg pages use the peg currency) and whose defined-term set is the parent axis hub.
- Legacy `/stablecoins/protocol/*` lineage paths redirect to `/stablecoins/infrastructure/*` in `public/_redirects` and are not sitemap entries.
- The family has no primary-nav entry. Discovery runs through the hub, the command palette (`src/components/command-palette-model.ts` lists `/stablecoins/` and the three axis hubs), and in-page links such as the homepage peg strip and `/alt-pegs/`.

---

## Adding A Cohort Or Peg Slug

Both paths add indexed routes, so treat them as SEO changes rather than data edits.

1. Add the enum value at its owning source: `INFRASTRUCTURE_VALUES` or `BACKING_TYPE_VALUES` in `shared/types/core.ts`, `GOVERNANCE_TYPE_VALUES` in `shared/types/stablecoin-taxonomy.ts`, or `PEG_CURRENCY_VALUES` in `shared/types/core.ts`. The `stablecoin-client-projections` compile input derives `ACTIVE_PEG_CURRENCIES` from active registry entries during bootstrap.
2. Add the slug to the matching record in `src/lib/stablecoin-taxonomy-urls.ts` or `ALL_SLUGS` in `src/lib/peg-landing.ts`. Confirm a new peg slug does not collide with `backing`, `governance`, or `infrastructure`.
3. Author the cohort content entry — `INFRASTRUCTURE_CONTENT`, `BACKING_CONTENT`, or `GOVERNANCE_CONTENT` in `src/lib/stablecoin-taxonomy.ts`, or `PEG_INTRO` / `PEG_MARKET_CONTEXT` in `src/lib/peg-landing.ts` — and check the rendered title against the 61-character budget.
4. Confirm `shared/lib/filter-tags.ts` emits the cohort's filter tag for member coins.
5. Run the taxonomy hub and sitemap suites (`src/app/stablecoins/__tests__/taxonomy-hub-pages.test.tsx`, `src/app/__tests__/sitemap-frozen.test.ts`) and regenerate sitemap dates so the new route carries a last-modified value.

---

## Update Rules

Update this doc when any of these change:

- the route table, shared hub template, or slug-route behavior
- cohort membership scoping or the empty-cohort filtering asymmetry
- the title budget or its compaction fallback
- the split between authored and derived cohort copy
- inventory, sitemap, JSON-LD, or redirect contracts for the family

Related docs to update in the same change:

- [alt-pegs-page.md](./alt-pegs-page.md)
- [classification.md](./classification.md)
- [architecture.md](./architecture.md)
