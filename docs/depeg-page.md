# Depeg & Recovery Page

Route contract for `/depeg/` (nav label "Depeg & Recovery") and its `/depeg/archive/` companion.

---

## Purpose

One live incident board answering four questions in order:

1. **What is off peg right now?** — the hero's One Beam count, worst live move, and early-warning radar.
2. **Will it recover, and when?** — the Depeg Duration Resolver worklist.
3. **How does the rest of the universe look?** — the peg control board.
4. **What has happened before?** — the recent-event handoff, the permanent archive, and the Timeline.

The route is an **Analytics**-tier surface (`design-language.md#context`). Density is the default; the
softening rules for discovery surfaces do not apply here.

---

## Route Shape

- **Server shell:** `src/app/depeg/page.tsx` via `createClientFeaturePage`, which owns the `h1`, the
  methodology version link, the Telegram alert header action, the lead paragraph, and the Depeg
  History Dataset JSON-LD.
- **Client:** `src/app/depeg/client.tsx` (`DepegClient`).
- **After the client, as server content:** `DepegEventArchivePreview`, then `FaqSection`.
- **Archive route:** `src/app/depeg/archive/page.tsx` renders the complete `DepegEventArchive`.
- **Per-event pages:** `src/app/depeg/[event]/page.tsx`.

---

## Section Order

With the default-on DDR/DDRR feature flags enabled, the order is deliberate:

1. `QueryFreshnessNotices`
2. **`DepegOutlookHero`** (`src/components/depeg-outlook-hero.tsx`) — the signature hero
3. `DepegResolverModule` — bounded recovery-forecast worklist
4. Forecast-grading disclosure (`#forecast-grading`) wrapping `DepegResolverReviewerModule`
5. `DepegControlBoard` — the universe workbench
6. `DepegFeed` + Timeline link — recent resolved events
7. `DepegEventArchivePreview` (server) — latest month of permanent event pages
8. `FaqSection` (server)

The board deliberately follows the forecast worklist rather than preceding it: a visitor arriving
during an incident needs the verdict on the live incidents before scanning every tracked asset.

Grading sits directly under the worklist it grades, not at the end of the route, and renders open —
a reader who has just seen a forecast should find "how accurate are these?" in the next breath. The
hero's track-record figure links to `#forecast-grading`, which lands on rendered content rather than
a closed control. See [Forecast Grading](#forecast-grading) for the collapse behavior.

---

## Hero Contract

`DepegOutlookHero` is the route's single signature hero, in the "one full-width hero, one frost-blue
One Beam metric" shape required by `design-language.md#feature-page-heroes`.

- **Left command rail**, top to bottom, hairline-separated: One Beam =
  `PegSummaryStats.activeDepegCount` in frost blue, the only frost-blue figure on the route, with the
  worst live move beside it as the one semantic-coloured element; a four-cell figure grid (pending
  confirmations, DEWS ALERT-or-worse, holding peg, median deviation); **Recovery outlook · DDR** — the
  whole-book verdict split and calibration lineage; **Forecast track record · DDRR** — headline
  recovery-call accuracy; then the DEWS alert queue (`DEWSAlertFeed embedded`) as the rail's detail
  layer. Supporting figures stay neutral.
- **Right field:** `DEWSRadarPanel` (`src/components/dews-summary.tsx`) fills the full column height
  beside the rail. Radial ring encodes DEWS band, mark size encodes market cap, mark colour encodes
  band, and a **double-ring halo marks an elevated coin that is also in a confirmed live depeg**
  (`PegSummaryCoin.activeDepeg` intersected with the radar's elevated set — see
  [Universe scope](#universe-scope)). Every shape carries a field.
  Unavailable supply retains a neutral, band-based size rather than the measured-small tier.
  Tooltip and keyboard announcements name missing supply; an explicit observed zero remains a
  measured-zero cap, and unavailable caps sort after observations within each severity band.
- **Footer band:** conditional reliability caveats only, and nothing when the data is healthy.
- **Calm state:** at zero active depegs the One Beam reads `0 — all pegs holding` and no halos are
  drawn, but the radar still plots precursor WATCH/ALERT coins. Zero confirmed incidents is not the
  same claim as zero stress.
- **Independent availability:** missing peg summary, DEWS snapshot/catalog or first event page yields `—` and a source-specific reason for its headline figures. Successful empty responses retain observed zeroes; a query error never manufactures an empty observation.

### Metric ownership

The hero owns route-level headline figures: active depegs, worst live move, at-peg
split, catalog DEWS alerts, DDR verdict split, and DDRR accuracy. Lower modules
must not repeat verdict or accuracy headlines. The resolver header does repeat
book size, past-peak count, and calibration lineage; the embedded alert queue
suppresses its own count.

### Universe scope

Reader-visible universes must be distinguished; `summary.*` is not one cohort:

| Universe | Source | Where it appears |
| --- | --- | --- |
| Live-peg-status assets | `usePegSummary()` live aggregates, only where `currentBps !== null` | hero holding-peg split, median deviation, worst live move |
| Peg-catalog assets | `usePegSummary()` `coins[]`, every returned row | control board rows and pagination, `trackedIds`, alert-queue scope, tracked ALERT+ count |
| Confirmed active detections | `usePegSummary()` `summary.activeDepegCount`, non-NAV active rows regardless of `currentBps` | hero active count |
| DEWS-covered assets | `useStressSignals()` | radar marks, radar centre caption, legend band counts |
| Resolver incidents / valid frozen forecasts | `useDepegResolver()` | worklist includes all explicit states; tier summary counts only valid frozen predictions |

These cohorts differ whenever observations or coverage are missing. Label live
deviation aggregates "with live peg status" and catalog metrics "of the peg catalog";
do not imply the active count requires a current price.

Two eligibility caveats:

- Because calm radar marks are anonymous positions, a coin in a confirmed depeg that is still CALM on
  DEWS receives no halo. The legend counts halos actually drawn, not every active depeg.
- `summary.activeDepegCount` excludes NAV tokens; the halo candidate set uses
  every returned `coin.activeDepeg`. If NAV incidents are admitted, align this
  eligibility; actual halo count also depends on DEWS elevation.

---

## Resolver Worklist

`DepegResolverModule` renders the `DEFAULT_VISIBLE_ROWS` most urgent forecasts and keeps the rest
behind an explicit toggle that mounts them only when opened.

- **Urgency order:** incidents whose **live** deviation is past their event peak first, then the widest
  live deviation, then `stablecoinId`/`eventId` so equally urgent rows cannot reshuffle between
  refreshes. Both comparisons use `getLiveCurrentDeviationBps()`, never `getCurrentDeviationBps()` —
  the latter returns the lock-time value for frozen predictions and would rank incidents by where
  they were when their forecast sealed. The past-peak test carries an absolute noise floor so a 2%
  margin cannot be satisfied by a couple of basis points of jitter. DDR rows are not control-board
  rows, so the board's `__attention` comparator does not apply; this is the route's own policy.
- **Shared derivation:** `summarizeResolverBook()` in
  `src/components/depeg-resolver-book-summary.ts` owns the valid frozen prediction tier split,
  past-peak count and forecast total; `rowCount` separately counts incident browsing rows.
  The hero's recovery posture excludes pending, no-call and invalidated outcomes.
- **Availability:** the hero's recovery totals and the worklist's whole-book/visible-slice
  claims use the same availability gate as forecast cards. Non-staleness degraded responses
  withhold all three even if retained rows exist. Explicit `stale-cache` responses with rows
  retain frozen forecasts and the existing stale-overlay warning; this does not refresh any clock.
- **Header scope:** the verdict split belongs to the hero. This header shows
  forecast and incident-row counts, the visible slice, past-peak count, and
  calibration lineage/coin count. A four-card slice is not the whole book.
  The retired standalone "Outlook Posture" surface must not return.

---

## Control Board

`DepegControlBoard` is the exact-value workbench: URL-backed filters, sort modes, ranked rows,
pagination. It owns per-coin values only; page-level aggregates belong to the hero.

An absent live deviation or DEWS reading yields a neutral `unknown` status, never green `clear`;
known live, pending, floor, warning and danger states retain precedence. Nullable peg-health,
DEWS and deviation metrics sort last in both directions, separately from observed zero.

Its multi-column grid starts at `lg`, not `md`. The six minimum column tracks plus gaps need roughly
820px, and a 768px viewport leaves rows about 734px, which clipped the last column with no horizontal
access. Below `lg` the rows use the stacked card grammar, which preserves every field.

### URL filter contract

Managed through `useUrlFilters()` in `src/app/depeg/client.tsx`:

- `peg` — one peg-currency filter, validated against `PEG_LABELS_SHORT`, invalid values normalize to `all`
- `type` — one governance filter, validated against `GOVERNANCE_LABELS`, invalid values normalize to `all`
- `q` — free-text symbol/name search

Unrelated query parameters are preserved by the shared hook.

---

## Forecast Grading

`DepegResolverReviewerModule` renders **open by default**, directly under the worklist it grades, in
a `#forecast-grading` section. Its control collapses roughly 1,300px of ledger for a reader heading
to the board, and the collapsed state unmounts the module rather than hiding it, so the DOM cost
goes with it. It was previously collapsed by default and placed after the history handoff; readers
could not find it, which is the failure this placement fixes.

Its query is not gated by disclosure state: the hero needs `summary.headline`
on first paint. DDR and DDRR feature flags gate the query, section, freshness
entry, and error notice together.

---

## Event History And Crawlability

- `DepegFeed` shows a responsive slice of loaded resolved detections, with a
  local **Load more** control that reveals more loaded rows without fetching another
  API page. `/timeline/?type=depeg.*` is the unbounded operational handoff.
- `DepegEventArchivePreview` on `/depeg/` shows the latest month of permanent event pages and links to
  `/depeg/archive/`.
- `/depeg/archive/` is the complete server-rendered internal link hub for every permanent event page.

Indexability does not depend on the inline archive: `generateStaticParams()` in
`src/app/depeg/[event]/page.tsx`, the per-event entries in `src/app/sitemap.ts`, and the archive
route's own sitemap entry each stand alone. Keep the archive server-rendered — a client-fetched or
JS-only list would silently drop the link hub.

---

## Data Sources

| Hook | Endpoint | Feeds |
| --- | --- | --- |
| `usePegSummary()` | `/api/peg-summary` | hero figures, board rows |
| `useStressSignals()` | `/api/stress-signals` | radar, alert queue, board DEWS column |
| `useInfiniteDepegEvents({ includePending: true })` | `/api/depeg-events` | pending incidents, recent feed |
| `useDepegResolver()` | `/api/depeg-resolver` | forecast worklist, and the hero's recovery posture |
| `useDepegResolverReview()` | `/api/depeg-resolver-review` | hero forecast track record; full ledger behind the grading disclosure |

`DEWSRadarPanel` additionally reads `useStablecoins()` for market-cap mark sizing through the shared
query cache.

---

## Module Header Grammar

DDR/DDRR use a system mark, section title, version/status badge, and metadata.
The feed uses a title only; the control board pairs kicker/title with attention
counts; the archive pairs its title with permanent-page/latest-month metadata.

Titles use `pharos-section-title`, never a hand-copied size/weight recipe. Labels use
`pharos-kicker`; metadata uses `pharos-meta`; figures keep `pharos-numeric`.

---

## Update Rules

Update this document when any of these move:

- visible section order or the hero's composition
- which surface owns a headline metric, or the universe a figure is scoped to
- the resolver worklist's default size or urgency policy
- the board's breakpoint behavior or URL filter contract
- archive routing, the crawlable link hub, or the disclosure gating of the reviewer query

Methodology changes (DEWS, DDR, depeg detection semantics) belong to
[depeg-detection.md](./depeg-detection.md), [dews.md](./dews.md), and
[depeg-resolver.md](./depeg-resolver.md), and follow the ADR-3 targets in
[architecture.md](./architecture.md). A presentation change to this route does not bump any
methodology version.
