# Depeg & Recovery Page

Route contract for `/depeg/` (nav label "Depeg & Recovery") and its `/depeg/archive/` companion.

---

## Purpose

One live incident board answering four questions in order:

1. **What is off peg right now?** — the hero's headline count, worst live move, and early-warning radar.
2. **Will it recover, and when?** — the Depeg Duration Resolver worklist.
3. **How does the rest of the universe look?** — the peg control board.
4. **What has happened before?** — the recent-event handoff, the permanent archive, and the Timeline.

The route is an **Analytics**-tier surface (`design-language.md#context`). Density is the default; the
softening rules for discovery surfaces do not apply here.

---

## Route Shape

- **Server shell:** `src/app/depeg/page.tsx` via `createClientFeaturePage` with the instrument
  header (`header: "instrument"` on `FeaturePageShell`), which owns the `h1`, the one-line deck, the
  meta row (methodology version link plus the compact `AlertsHeaderLink` Telegram action and Share),
  and the Depeg History Dataset JSON-LD.
- **Client:** `src/app/depeg/client.tsx` (`DepegClient`).
- **After the client, as server content:** `DepegEventArchivePreview`, then `FaqSection`.
- **Archive route:** `src/app/depeg/archive/page.tsx` renders the complete `DepegEventArchive`.
- **Per-event pages:** `src/app/depeg/[event]/page.tsx`.
  `buildDepegEventTitle` renders `{SYMBOL} Depeg, {Month D, YYYY}: {deviation} Below|Above Peg`
  with no clause dash; it is also the H1 of every non-curated event, while curated
  annotation labels keep their own H1. An unavailable deviation is omitted, never printed
  as a placeholder. The description leads with `{name} ({SYMBOL}) fell|rose {deviation}
  below|above its peg on {date}`.
  Metadata, `NewsArticle` description, synopsis and event summary use the canonical
  `classifyDepegClosure` result: only recovered and legacy-recovered records claim
  recovery. Coverage loss, superseded direction, removed tracking and unknown
  closure remain tracking closures; an end timestamp alone is not recovery.
  Authored editorial entries add the briefing lede, timeline and watchpoints;
  unauthored pages retain the structural event record. Editorial presence does
  not change the 500 bps route-admission threshold.

---

## Section Order

With the default-on DDR/DDRR feature flags enabled, the order is deliberate:

1. `QueryFreshnessNotices`
2. **`DepegOutlookHero`** (`src/components/depeg-outlook-hero.tsx`) — the signature hero
3. `DepegResolverModule` — bounded recovery-forecast worklist
4. `DepegControlBoard` — the universe workbench
5. Forecast-grading section (`#forecast-grading`) wrapping `DepegResolverReviewerModule`
6. `DepegFeed` + Timeline link — recent resolved events
7. `DepegEventArchivePreview` (server) — latest month of permanent event pages
8. `FaqSection` (server)

The route reads answer → table to act on → evidence/audit. The board deliberately follows the
forecast worklist rather than preceding it: a visitor arriving during an incident needs the verdict
on the live incidents before scanning every tracked asset.

Grading is audit evidence, so it follows the board rather than standing between the forecasts and
the table a reader acts on. It is always rendered, still precedes the history handoff, and the
hero's track-record figure links to `#forecast-grading`. See [Forecast Grading](#forecast-grading).

---

## Hero Contract

`DepegOutlookHero` is the route's single signature hero, in the "one full-width hero, one answer
KPI" shape required by `design-language.md#feature-page-heroes`.

- **Left command rail**, top to bottom, hairline-separated: the headline count =
  `PegSummaryStats.activeDepegCount` in neutral ink (`HERO_KPI_VALUE_CLASS`), with the worst live
  move beside it as the one semantic-coloured element and a `Peg catalog` `UniverseChip` under it (catalog size = rows in the live peg summary, omitted while unread); a four-cell figure grid (pending
  confirmations, DEWS ALERT-or-worse, holding peg, median deviation); **Recovery outlook · DDR** — the
  whole-book verdict split and calibration lineage; **Forecast track record · DDRR** — headline
  recovery-call accuracy with its same-denominator always-recover baseline and the frozen
  forecast majors the graded cohort came from (see [Forecast Grading](#forecast-grading)); then the DEWS alert queue (`DEWSAlertFeed embedded`) as the rail's detail
  layer. Supporting figures stay neutral.
- **Right field:** `DEWSRadarPanel` (`src/components/dews-summary.tsx`) fills the full column height
  beside the rail. Radial ring encodes DEWS band, mark size encodes market cap, mark colour encodes
  band, and a **double-ring halo marks an elevated coin that also has an open confirmed incident**
  (`PegSummaryCoin.activeDepeg` intersected with the radar's elevated set — see
  [Universe scope](#universe-scope)). Every shape carries a field.
  Unavailable supply retains a neutral, band-based size rather than the measured-small tier.
  Tooltip and keyboard announcements name missing supply; an explicit observed zero remains a
  measured-zero cap, and unavailable caps sort after observations within each severity band.
- **Footer band:** conditional reliability caveats only, and nothing when the data is healthy.
- **Open-incident wording:** the headline counts coins with open confirmed incidents
  (`endedAt=null`), not coins observed off peg now; recovery may be observed but not yet
  confirmed. At zero it reads `0 coins with open confirmed incidents` and no halos are
  drawn, but the radar still plots precursor WATCH/ALERT coins. Zero confirmed incidents is not the
  same claim as zero stress, nor that every peg holds.
- **Independent availability:** missing peg summary, DEWS snapshot/catalog or first event page yields `—` and a source-specific reason for its headline figures. Successful empty responses retain observed zeroes; a query error never manufactures an empty observation.

### Metric ownership

The hero owns route-level headline figures: active depegs, worst live move, at-peg
split, catalog DEWS alerts, DDR verdict split, and DDRR accuracy. Lower modules
must not repeat verdict or accuracy headlines. The resolver header does repeat
book size, new-worst count, and calibration lineage; the embedded alert queue
suppresses its own count.

The control board's attention count is scoped to its filtered rows: confirmed active
or pending incidents, plus validated DEWS bands at `THREAT_BAND_ORDER.ALERT` or above.
It shares the hero's canonical band ladder, not a separate numeric score threshold;
missing signals alone do not establish attention or a measured calm score.

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

- **Urgency order:** incidents at a new worst — **live** deviation beyond the **live** event peak
  (`row.live.peakDeviationBps`) — first, then the widest live deviation, then
  `stablecoinId`/`eventId` so equally urgent rows cannot reshuffle between refreshes. Both
  comparisons use live fields, never `getCurrentDeviationBps()`/`getPeakDeviationBps()` — those
  return lock-time evidence for frozen predictions, and a frozen lock peak can be far shallower
  than the live event. A null or zero live peak cannot establish a new worst. The test carries an
  absolute noise floor (`max(25 bps, 2%)`) so jitter cannot satisfy it. Hero and header caption it
  `{N} at a new worst`. DDR rows are not control-board
  rows, so the board's `__attention` comparator does not apply; this is the route's own policy.
- **Shared derivation:** `summarizeResolverBook()` in
  `src/components/depeg-resolver-book-summary.ts` owns the valid frozen prediction tier split,
  new-worst count and forecast total; `rowCount` separately counts incident browsing rows.
  The hero's recovery posture excludes pending, no-call and invalidated outcomes.
- **Tier vocabulary:** rows predicted under DDR 5.0+ read as evidence classes (No break
  signals / Stress signals / Terminal evidence); earlier locks keep Recovery likely / At risk /
  Recovery unlikely. The tier split counts each vocabulary separately and never relabels an
  earlier lock. Labels live in `shared/lib/classification/depeg.ts`.
- **Availability:** the hero's recovery totals and the worklist's whole-book/visible-slice
  claims use the same availability gate as forecast cards. Non-staleness degraded responses
  withhold all three even if retained rows exist. Explicit `stale-cache` responses with rows
  retain frozen forecasts without refreshing any clock; age admission belongs only to the route's
  shared DDR/DDRR freshness notice (ADR-42), and live-fact captions omit serving-path reasons.
- **Header scope:** the verdict split belongs to the hero. This header shows
  forecast and incident-row counts, the visible slice, new-worst count, and
  calibration lineage/coin count. A four-card slice is not the whole book.
  Lineage reads `_meta.lineage.incidentCount` as "historical incidents": the full
  calibration corpus (recovered, terminal and censored open incidents), not the recovered
  subset or a forecast's matched duration support.
  The retired standalone "Outlook Posture" surface must not return.
- **Review totals:** forecast grading uses the published reviewer summary, not a
  verdict or IQR breakdown recalculated from bounded browsing rows.

---

## Control Board

`DepegControlBoard` is the exact-value workbench: URL-backed filters, sort modes, ranked rows,
pagination. It owns per-coin values only; page-level aggregates belong to the hero.

An open confirmed incident's lifecycle pill reads `open`. Beside it,
`classifyOpenIncidentEvidence()` (`shared/lib/active-depegs.ts`, labels in
`shared/lib/classification/depeg.ts`) names the latest trusted observation of the coin's
unique open event from the active-events detail read: a gap-free off-peg observation within
`DEPEG_MAX_CONTINUOUS_OBSERVATION_GAP_SEC` reads "Observed outside recovery band"; a trusted
at-par observation within that limit reads "Inside recovery band, awaiting confirmation";
missing, ambiguous, blind, expired or future evidence reads "Recovery unconfirmed". Spot
bps never classify the band, the page minute clock expires the readings, and the census
stays `summary.activeDepegCount`, never the capped event detail.

An absent live deviation or DEWS reading yields a neutral `unknown` status, never green `clear`;
known live, pending, floor, warning and danger states retain precedence. Nullable peg-health,
DEWS and deviation metrics sort last in both directions, separately from observed zero.

The multi-column grid starts at `lg`; below it, stacked cards preserve every field.

Peg Health text and gauge share one tier from `getPegScoreTier` (90/70).

Peg occupancy beside Peg Health is a **recorded-window peg occupancy estimate**.
Its visible caption and row accessible description disclose that terminal tracking
closure can leave unobserved time: the percentage proves neither recovery nor
continuous observation. Board rows do not infer a closure reason from live status
or an event count; this qualification also applies to legacy/unknown provenance.
The presentation does not change PegScore or producer percentages.

### URL filter contract

Managed through `useUrlFilters()` in `src/app/depeg/client.tsx`:

- `peg` — one peg-currency filter, validated against `PEG_LABELS_SHORT`, invalid values normalize to `all`
- `type` — one governance filter, validated against `GOVERNANCE_LABELS`, invalid values normalize to `all`
- `q` — free-text symbol/name search

Unrelated query parameters are preserved by the shared hook.

---

## Forecast Grading

`DepegResolverReviewerModule` sits in `#forecast-grading` directly after the control
board and is **always displayed** (there is no show/hide toggle). A cold
`#forecast-grading` URL re-aligns the anchor once the ledger mounts after the
loading state.

The reviewer query runs with the page whenever the DDRR flag is on. Before its first read, the hero's track record stays unavailable rather than
claiming an empty or safe ledger. Retained review evidence keeps its original clock
and freshness notice. DDR/DDRR feature flags still gate the section and query.

Reviewer v5 metrics (always-recover baseline, terminal-call precision, duration as a
log-ratio multiplier with the within-2× share, open-past-band count, horizon Brier skill and
per-major Wilson intervals) render only when the snapshot carries them; older snapshots show
them unavailable, never zero. `terminal_at_lock` rows are labelled "Terminal at lock" and are
curation debt, not scored calls.

The hero and homepage DDR card promote that headline through `describePromotedAccuracy()`
(`src/lib/ddr-promoted-accuracy.ts`): `Recovery calls correct: c/s (p%)`, the always-recover
baseline `headline.baselineRecoverableCorrectCount` over the same `s` (missing reads `—`,
observed zero stays zero, a zero denominator has no percentage), and `Graded calls from
v2/v3/v4 · N from current v5`, folded from `byPredictionPolicy` segments. If the versioned
segments do not sum to the headline's scored count (another policy, unversioned rows) the
scope reads `Graded calls by version: —`; when every graded call is current-major the
qualifier is omitted. This is frozen historical performance, not current-model validation.

Once at least five recovery calls are scored, the ledger leads with the aggregate accuracy percentage (the homepage DDR card's track-record figure) over the `correct / scored` fraction; a thinner sample shows only the fraction.

Recovery-call progress reads `summary.headline.pendingRecoveryLikelihoodCount`:
published prediction reviews with a pending verdict, in exactly the headline
accuracy policy scope. Pending locks remain coverage debt, not maturing forecasts.
Neither capped browse rows nor all-policy per-coin totals supply this count.
Retained bodies without the additive field show “maturing unavailable,” not zero.

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

Permanent `/depeg/<event>/` pages cover confirmed events starting at or after
2026-01-01 (`DEPEG_ARCHIVE_EPOCH_SECONDS`) with absolute peak deviation ≥5.0%,
plus pinned authored pre-epoch incidents such as USDC 2023. The archive is grow-only:
`sync-depeg-events.ts` carries previously published rows forward after below-threshold
reclassification or consolidation verified by `/api/depeg-resolver` incident identity
and its current representative in the fetched event ledger (same coin/direction,
multiple constituents). The historical row keeps its reserved URL even when the
representative is sub-threshold; no replacement route or redirect is invented.
Unexplained missing IDs still fail the shrink guard without the reviewed
`--allow-archive-shrink` override. Rejection logs name the slug, event/representative
IDs, incident state and failed lineage checks; lookup logs identify the resolved
API lane or explain why no lookup ran. The release SEO gate also compares the deployed
sitemap, including refresh-only routes absent from the checked-in snapshot. Every
published URL must remain submitted or receive a direct 301 to its surviving
submitted incident when DDR consolidates fragments. Reviewed artifact removals use
the shrink override plus one-hop redirects in `public/_redirects`; follow
[artifact removal](./runbooks/depeg-artifact-removal.md#removal-sequence).

Permanent is not the same as indexed. `buildNoindexDepegEventSlugs()` in
`src/lib/depeg-event-config.ts` serves two thin-page tiers `noindex, follow` and drops them
from the sitemap and `public-route-inventory.ts`: events whose opening was held on a
low-confidence price input (`pendingReason` includes `low-confidence`), and secondary
events in a same-coin, same-UTC-day cluster, where the event with the largest absolute
peak (low-confidence events excluded) stays indexed. Pages that earned Search Console impressions in the
prior three months sit in a checked-in allowlist and are never noindexed. Noindexed pages
stay live, keep their URL and stay listed in the archive, so the continuity gate needs no
redirect. This replaced the former "no low-information noindex tier" rule under the
2026-10-25 SEO plan (decision D5); events are never merged, because the producer owns the
event vocabulary.

Published slugs and slug-keyed editorial entries are reserved by event ID before naming
new rows. Adding or reordering same-day events, including cross-coin duplicate symbols,
cannot rename existing URLs. An identity-rewriting repair must explicitly review the
old-to-surviving event/slug mapping and redirects; the sync never infers it from symbols.

Events sharing a coin, UTC date and direction include their exact UTC start time in
metadata, H1, metrics and adjacent navigation. Each has a factual synopsis and its
canonical URL as `NewsArticle.@id`. Sub-threshold feed rows link to the stablecoin
history anchor; the API, tracker, detail history and feeds retain the full event table.

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
The route starts that stablecoin read independently before the peg-summary loading
return, avoiding a peg-summary → radar-sizing request waterfall.

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
