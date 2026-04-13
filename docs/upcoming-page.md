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
- **Shared helpers:** `src/lib/pre-launch.ts`
- **Primary dataset:** `PRE_LAUNCH_STABLECOINS` from `@shared/lib/stablecoins`, loaded from `shared/data/stablecoins/pre-launch.json`

The route renders through `FeaturePageShell` with:

- `breadcrumbName="Upcoming Stablecoins"`
- `path="/upcoming/"`
- title `Upcoming Stablecoins`
- a single lead paragraph describing the page as the pre-launch tracker
- a launch-alert callout above the client grid that promotes `@PharosWatchBot`
- a copyable global command: `/subscribe launch all`
- copy that points users to individual upcoming coin pages for asset-specific exact commands

Metadata is authored directly in `src/app/upcoming/page.tsx` with canonical `/upcoming/`, route-specific title/description, and the default shared page-metadata helper path.

---

## Data Contract

`UpcomingClient` builds entirely from checked-in metadata and static assets:

| Source                   | Used for                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `PRE_LAUNCH_STABLECOINS` | the route's full card/filter universe                                                             |
| `shared/data/stablecoins/pre-launch.json` | checked-in pre-launch metadata source, kept separate from active stablecoin shards       |
| `data/logos.json`        | per-coin logo display                                                                             |
| `data/ai-summaries.json` | teaser copy shown on cards when available                                                         |
| `src/lib/pre-launch.ts`  | launch-phase labels, drift heuristics, fuzzy-date formatting, teaser truncation, and sort scoring |

The route does not call the Worker API directly. It is a metadata-driven surface over pre-launch stablecoin entries already checked into the repo.

---

## Filter And Sort Model

`src/components/upcoming-client.tsx` exposes:

- a top overview band summarizing tracked pre-launch coverage by phase
- multi-select `Phase` filters over `announced`, `testnet`, `auditing`, `beta`, and `launching-soon`
- multi-select `Peg` filters, shown only when the current pre-launch set contains more than one peg currency
- multi-select `Backing` filters, shown only when the current pre-launch set contains more than one backing class
- single-select `Sort` options:
  - `Expected Launch`
  - `Announced Date`
  - `Name`
- `Clear filters`, shown only while any filter set is active
- the filter surface now uses the shared Pharos card/pill treatment instead of standalone flat chip rows, so dark mode stays visually consistent with the rest of the product

Filtering always starts from the full `PRE_LAUNCH_STABLECOINS` set. Sorting is then applied to the filtered result.

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

`No pre-launch stablecoins match the current filters.`

## Launch Alert Promotion

The route now promotes the Telegram launch-alert workflow in two layers:

- a page-level callout, rendered by `src/app/upcoming/page.tsx`, that exposes the copyable global follow command `/subscribe launch all`
- asset-specific exact commands on the destination pre-launch detail pages, documented in [stablecoin-detail-page.md](./stablecoin-detail-page.md)

---

## SEO And Crawlability

- The route is indexable.
- `src/app/sitemap.ts` includes `/upcoming/` in the static sitemap output.
- `src/app/upcoming/page.tsx` renders an `sr-only` nav containing links for every `PRE_LAUNCH_STABLECOIN`, so the page remains crawlable even though the visible card grid is client-rendered.

This route is also referenced from the homepage through `UpcomingStablecoinsSection`.

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
3. any homepage copy that describes the upcoming-stablecoin surface (`src/components/upcoming-stablecoins-section.tsx` and [homepage.md](./homepage.md))

If pre-launch stablecoins stop linking into the normal `/stablecoin/[id]/` detail route, also update [stablecoin-detail-page.md](./stablecoin-detail-page.md).
