# Upcoming Page

Route contract for the public `/upcoming/` surface.

---

## Purpose

`/upcoming/` is the public pre-launch stablecoin tracker. It exists to give users a filtered, crawlable view of tracked stablecoins whose metadata status is still `pre-launch`, without mixing them into the active-asset monitoring surfaces.

Primary audience:

- product and docs contributors who need the route contract
- engineers updating pre-launch metadata, launch phases, or filtering behavior

---

## Route Shape

- **Route:** `/upcoming/`
- **Server shell:** `src/app/upcoming/page.tsx`
- **Client implementation:** `src/components/upcoming-client.tsx`
- **Hero wrapper:** `src/components/upcoming-horizon-hero.tsx`
- **Shared constellation:** `src/components/horizon-constellation.tsx`, also composed by `src/components/home-alt-upcoming-horizon-constellation.tsx`
- **Shared helpers:** `src/lib/pre-launch.ts`
- **Primary dataset:** `page.tsx` projects `PRE_LAUNCH_STABLECOINS` (`@shared/lib/stablecoins/registry`) into the client card/filter payload; the full server registry remains available to the server shell for JSON-LD and the crawlable `sr-only` nav. Both derive from the catalog backed by `shared/data/stablecoins/coins/*.json`

The route renders through `FeaturePageShell` with:

- `breadcrumbName="Upcoming Stablecoins"`
- `path="/upcoming/"`
- title `Upcoming Stablecoins`
- a single lead paragraph describing the page as the pre-launch tracker
- a launch-alert callout above the client grid that promotes `@PharosWatchBot`
- a copyable global command: `/subscribe launch all`
- copy that points users to individual upcoming coin pages for asset-specific exact commands

Metadata is authored directly in `src/app/upcoming/page.tsx` through the shared `buildPageMetadata` helper (`src/lib/page-metadata.ts`), with canonical `/upcoming/`, route-specific title/description, and the route-specific OG image `/og-upcoming.png` in place of the helper's default card.

---

## Data Contract

`UpcomingClient` builds entirely from checked-in metadata and static assets:

| Source                                                                                                                                | Used for                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PRE_LAUNCH_STABLECOINS` (`@shared/lib/stablecoins/registry`)                                                                         | server-side source for the client card/filter projection, JSON-LD, and the crawlable `sr-only` nav             |
| `shared/data/stablecoins/coins/*.json`                                                                                                | editable stablecoin catalog source of truth; pre-launch membership comes from `status: "pre-launch"`         |
| Generated stablecoin projections                                                                                                     | full and client registries refreshed together with `npm run bootstrap:generated`                               |
| `data/logos.json`                                                                                                                     | per-coin logo display                                                                                        |
| `data/ai-summaries.json`                                                                                                              | teaser copy shown on cards when available                                                                    |
| `src/lib/pre-launch.ts`                                                                                                               | launch-phase labels, drift heuristics, fuzzy-date formatting, and sort scoring                               |

The route does not call the Worker API directly. It is a metadata-driven surface over pre-launch stablecoin entries already checked into the repo.

---

## Filter And Sort Model

`src/components/upcoming-client.tsx` exposes:

- the full-width `UpcomingHorizonHero`, which configures the shared `HorizonConstellation` for this route while the homepage composes the same primitive in its own section shell
- multi-select `Phase` filters over `announced`, `testnet`, `auditing`, `beta`, and `launching-soon`
- multi-select `Backing` filters, shown only when the current pre-launch set contains more than one backing class
- multi-select `Peg` filters, shown only when the current pre-launch set contains more than one peg currency
- single-select `Sort` options rendered as `pharos-control-pill` toggles:
  - `Expected Launch`
  - `Announced Date`
  - `Name`
- `Clear filters`, shown only while any filter set is active
- the filter surface now uses the shared Pharos card/pill treatment instead of standalone flat chip rows, so dark mode stays visually consistent with the rest of the product

Filtering always starts from the full pre-launch projection passed by `page.tsx`. Sorting is then applied to the filtered result.

The `phase`, `peg`, `backing`, and `sort` filters are URL-backed through the shared URL-state codec. Phase, peg, and backing are comma-delimited multi-selects; the default sort is `expected`, and defaults are omitted from the URL.

---

## Card Contract

Each card:

- links to the canonical stablecoin detail route via `buildStablecoinUrl(coin.id)`
- uses the shared `pharos-card-shell` / `pharos-interactive-card` surface treatment so the route matches the rest of the product in dark mode
- shows logo, name, symbol, peg/backing/governance badges, and launch-phase badge when present
- shows teaser copy only when `data/ai-summaries.json` has text for that coin
- shows `Expected <date>` when `expectedLaunchDate` exists
- shows a drift badge only when `getDriftStatus(...) !== "on-track"`
- shows milestone count only when `coin.milestones.length > 0`

The empty-state copy is:

`No pre-launch coins match. Drop a filter or two.`

It appears with a `Clear filters` action.

## Launch Alert Promotion

The route now promotes the Telegram launch-alert workflow in two layers:

- a page-level callout, rendered by `src/app/upcoming/page.tsx`, that exposes the copyable global follow command `/subscribe launch all`
- asset-specific exact commands on the destination pre-launch detail pages, documented in [stablecoin-detail-page.md](./stablecoin-detail-page.md)

---

## SEO And Crawlability

- The route is indexable.
- `src/app/sitemap.ts` includes `/upcoming/` in the static sitemap output.
- `src/app/upcoming/page.tsx` renders an `sr-only` nav containing links for every `PRE_LAUNCH_STABLECOIN`, so the page remains crawlable even though the visible card grid is client-rendered.
- The page emits `CollectionPage` and `ItemList` JSON-LD for the current pre-launch detail routes.

The visible route entrypoint is `/upcoming/`. The homepage renders only a compact `On The Horizon` logo constellation that links back to this route; `/upcoming/` remains the full filterable tracker and crawlable pre-launch surface.

---

## Update Rules

Update this doc when any of these contracts change:

- pre-launch filter dimensions or sort options
- card fields or badge semantics
- launch-alert promo placement or command copy on `/upcoming/`
- the route's canonical metadata or crawlability pattern
- the source of truth for pre-launch stablecoin membership

If launch-phase labels, drift heuristics, or fuzzy-date handling change, update:

1. `src/lib/pre-launch.ts`
2. this document
3. any homepage copy that describes the upcoming-stablecoin surface

If pre-launch stablecoins stop linking into the normal `/stablecoin/[id]/` detail route, also update [stablecoin-detail-page.md](./stablecoin-detail-page.md).
