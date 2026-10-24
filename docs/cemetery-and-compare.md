# Cemetery and Compare

## Overview

This document covers two frontend-only feature surfaces that are not backed by dedicated page-specific worker endpoints:

- `/cemetery` — static memorial dataset + interactive UI
- `/compare` — indexable multi-source live compare tool plus static pair-directory hub
- `/compare/[slug]` — static comparison landing pages generated from tracked metadata

## Stablecoin Cemetery (`/cemetery`)

`src/app/cemetery/page.tsx` owns the static shell. `shared/lib/cemetery-merged.ts` supplies data; `src/lib/cemetery-stats.ts`, `cemetery-register.ts` and `cemetery-selection.ts` own projections/navigation. `src/components/cemetery/` owns rendering and interaction.

### Data model

Cemetery data is static and versioned in-repo. The curated dead-coin dataset lives in `shared/data/dead-stablecoins.json` and is validated and exported as `DEAD_STABLECOINS` by `shared/lib/dead-stablecoins.ts` through `parseDeadStablecoinAssets`. The route, the public dataset export, the `/feed/cemetery.xml` RSS feed (`src/app/feed/cemetery.xml/route.ts`), the logo atlas and the worker cemetery tape projector (`worker/src/lib/tape-projectors/cemetery.ts`) consume `CEMETERY_ENTRIES` from `shared/lib/cemetery-merged.ts`, which combines those curated dead rows with frozen tracked stablecoins.

- `recordedAt`: <!-- GENERATED-START: cemetery-recorded-at-description -->UTC cemetery-entry/documentation date (YYYY-MM-DD); tracked rows default to frozenAt unless obituary.recordedAt explicitly overrides it. Distinct from deathDate; null when not recorded.<!-- GENERATED-END: cemetery-recorded-at-description --> Drives "Latest record added" and dataset `updatedAt`.

Frozen rows also carry `archivedDataAvailable: true` (the `CemeteryEntry` type); curated rows leave it absent.

`DeadStablecoinSchema` owns identity/narrative fields. Death dates use strict Gregorian `YYYY-MM` or `YYYY-MM-DD`; impossible days reject, never roll forward. Approximate peak is optional when not reliably sourced, never a zero placeholder. Mechanism is how the peg was designed, independently of cause of death.

Cause labels, approved definitions and theme colours derive from `shared/lib/classification.ts`; `shared/lib/cause-of-death.ts` adds `CAUSE_ORDER`. Consumers must not maintain independent vocabularies or imply a loss/risk ranking from categorical cause colours.

### Curating a record

The page prints its inclusion and primary-cause rules in the methodology section (`CEMETERY_INCLUSION_RULE` and `CEMETERY_PRIMARY_CAUSE_RULE` in `src/components/cemetery/cemetery-context.tsx`). That copy describes the whole archive as it stands: each record links one public source, most of which document the failure or discontinuation directly, while a coin that faded without an announcement links the best public context Pharos found. The page never calls the set "primary sources". New curated rows in `shared/data/dead-stablecoins.json` meet a stricter bar:

- **Inclusion.** A new record needs a public market and a primary public source documenting failure/discontinuation: issuer/protocol announcement, governance record, official docs/status, regulator/court/registry filing or on-chain evidence. Prefer that source in `sourceUrl`; reputable press qualifies only when it documents the same event. Listings, provider ended/deprecated markers, launch/fundraising articles and general wikis do not qualify. There is no size floor. Older contextual-source records do not weaken this new-row bar; never represent the whole archive as primary-source evidence.
- **Primary cause.** Each record carries one primary cause: the root reason the coin failed or its issuance and operation ended, whether or not it lost its peg. Triggers such as runs, exploits or orders are described in the obituary.

Every new curated row sets `recordedAt` to the UTC date it is added to Pharos. `parseDeadStablecoinAssets` rejects a curated row without a valid strict `YYYY-MM-DD` `recordedAt`. Set `mechanismArchetype` as well: the schema accepts its absence, but every curated row is classified today and `shared/lib/__tests__/cemetery-merged.test.ts` fails on an unclassified curated row. Classify how the coin was designed to hold its peg, independently of how it died.

New ids must not equal a section anchor or start with a reserved element-id prefix (`CEMETERY_SECTION_ANCHORS`, `CEMETERY_RESERVED_ID_PREFIXES`); `findCemeteryIdCollisions` must stay empty for the real set.

Every new death also has to fit the plot map. `src/lib/__tests__/cemetery-plot-map.test.ts` runs `validatePlotMapCapacity` on the real data in both presets, so a record that overfills a year block or shrinks plain stones below `PLOT_LAYOUT.faceFloorPx` fails the suite. Treat that failure as a design review: retune the lane depths in `PLOT_MAP_PRESETS` (or, as the archive approaches a few hundred records, add a deliberate overview and zoom policy), and never lower the face floor to make stones fit.

### Order authority

`sortCemeteryCoins` in `shared/lib/cemetery.ts` is the single cemetery order. The register's Died sort, the page's JSON-LD `ItemList`, the RSS feed, the dataset export and the case-study list all use it. Its keys, in order:

1. `deathDate` by year, month, then day, newest first (`oldest` reverses this key only). A month-precision date sorts as the start of its month, so newest-first lists a month's day-precision rows before its month-precision rows. A `deathDate` that does not parse follows every dated row in both modes.
2. Peak market cap descending; rows with no recorded peak follow known peaks.
3. Symbol ascending, then id ascending, compared by UTF-16 code unit so the order is identical in every runtime and locale.

Identical data always yields the same order regardless of input order. Source-file order is non-contractual. The dataset's `recordsOrderedBy` text describes these keys and must change with them.

### Public dataset export

`scripts/maintenance/generate-cemetery-dataset.ts` consumes `CEMETERY_ENTRIES` and writes one combined row set, in `sortCemeteryCoins` newest-first order, to static export files:

- `/datasets/stablecoin-cemetery.json`
- `/datasets/stablecoin-cemetery.csv`

The generator owns schema, field descriptions and CSV order. Metadata includes provenance/checksums, licensing, canonical URLs, ordering, counts and limitations. `updatedAt` is latest `recordedAt` (entry, not death/build time), null only when no record has one. JSON missing optionals are null, absent contracts an empty array; CSV missing cells are empty, never zero. `pharosUrl` points to archived detail when available, otherwise `/cemetery/#<id>`. Both formats contain the same merged ordered rows.

The `cemetery-dataset` artifact owns regeneration: run `npx --no-install tsx scripts/maintenance/generate-cemetery-dataset.ts` after source edits and commit outputs. Provenance pins curated JSON, frozen projection and consumed cause labels; label changes rotate checksum, unrelated active edits do not. Current Telegram snapshots use stable cemetery `id`; optional `llamaId` only aids legacy deduplication.

`buildCemeteryDatasetJsonLd` uses the checked-in header for Dataset schema at `/cemetery/#dataset`, alongside CollectionPage/ItemList. Link public JSON/CSV distributions, producer `updatedAt`, field descriptions/checksum/count, never private site-data URLs or fabricated dead-coin profiles.

### RSS feed

`/feed/cemetery.xml` publishes the 50 newest records in `sortCemeteryCoins` order (`CEMETERY_FEED_MAX_ITEMS` mirrors the limit for page copy). Each item is titled `Name (SYMBOL): Cause label` with the `CAUSE_META` label, links to `/cemetery/#<id>`, uses `pharos:cemetery:<id>` as its GUID, and dates `pubDate` from `deathDate` (a month-precision date uses the first of the month).

### Logo atlas

`scripts/maintenance/build-cemetery-logo-atlas.ts` owns atlas/manifest and shared logo resolution. Source-byte hash plus resampling identity deduplicates cells; missing logos stay missing. `npm run logos:cemetery-atlas` regenerates within the 150 KB budget. The `cemetery-logo-atlas` artifact checks input signatures, not platform-dependent WebP re-encoding.

### OG image

The `og-cemetery` artifact renders the real resting plot map, depends on the atlas and uses input-signature freshness. Run `npm run build:og-cemetery` after data changes and commit outputs. [OG Images](./og-images.md) owns rendering/review.

### Frozen entries in the cemetery

`frozenToDeadShape()` in `shared/lib/cemetery-merged.ts` projects tracked obituaries, mechanism and contracts into archived entries linked to `/stablecoin/<id>/`; curated rows retain cemetery links. `recordedAt` defaults to `frozenAt`; a strict UTC `obituary.recordedAt` may override entry date without changing historical freeze date. Invalid dates throw. Frozen IDs are registry IDs, curated IDs remain stable cemetery identities; duplicates fail merge. Sort by deathDate, never frozenAt.

### Telegram channel notifications

`worker/src/telegram/digest/digest-appendices.ts` compares deployed dataset with D1 snapshot during daily digest delivery. Seed silently on first run; new rows become one consolidated next-digest appendix with available epitaphs. This is not a separate API feed.

### UI behavior

`buildCemeteryPlotMap` is a deterministic serializable model: no clock, DOM or randomness; identical input in any order yields identical output. Geometry/capacity live in `src/lib/cemetery-plot-map.ts` and `cemetery-plot-geometry.ts`; [scene kit](./data-visualization.md#scene-kit) owns shared drawing primitives.

Scene, flower and legend seeds use the frozen UTF-16 `fnv1a32` authority in `shared/lib/fnv1a.ts`; `shared/lib/scene/seed.ts` owns only the seeded stream. Import cutovers preserve serialized geometry and SVG bytes, including surrogate-pair ids.

Cause, date and recorded peak determine the drawing. Peak is size at the top, never holder losses; orderly regulatory/abandoned exits must not look like destruction. Unknown peaks have a distinct neutral/hatched encoding, not zero/floor. Age uses latest recorded death (`asOf`), not wall time. Legend examples use the same geometry and distinguish archive availability, peg and unknown data. The sole frost figure counts all records, not visible stones.

Both layouts provide one roving tab stop, full accessible grave names, button/pressed semantics and described keyboard rules; decorative geometry is hidden from assistive technology. Desktop ←/→ moves within a cause, ↑/↓ across causes at nearest date, Home/End to ends; portrait swaps axes. Skip the cemetery map reaches the equivalent register. Hover/focus previews; click/Enter/Space pins and announces once politely; Escape/background closes (the next Escape exits zoom). Keyboard access reaches graves outside a partial zoom window, whose label discloses years and `n of total`. Session flowers are not dataset statistics.

Exactly one responsive layer owns pin/key/tap events. Phone sheets keep record links and content clear of sticky/bottom navigation; layout handoff never reopens dismissed pins or replays scroll/focus. Hash-source portrait pins restore the tab stop, not a sheet covering the register. Reduced motion cuts beam, zoom and highlight transitions; no ambient motion is required.

The server renders context, legend, count and desktop rest pose. Clients receive slim register rows/atlas, not the full dataset/model. Portrait mounting reserves its measured aspect against layout shift. No-JS CSS falls back to the desktop plan and register targets, subject to the page-shell visibility limitation below. Capacity failure requires design review, never lowering minimum face sizes.

### Selection and deep links

`CemeterySelectionProvider` alone owns hash, parsing mount/hashchange with echo suppression. Registered handlers own scrolling/motion. Record hashes request both pin and reveal; pre-registration requests queue latest-wins. `setRecordHash` replaces history, never adds entries. Pin/source state is separate from register reveal; responsive handoff must not replay scroll/focus, reopen dismissed pins or show a portrait sheet for a hash reveal.

Anchors:

- `#<id>` is the canonical public record anchor. RSS items, dataset `pharosUrl` values for curated rows, and the register's "Copy link" all use it. The register's main row carries `id="<id>"` and a scroll margin that clears the sticky chrome.
- `#obituary-<id>` is a legacy alias. `parseCemeteryHash` resolves it to the record, and the provider rewrites the hash to `#<id>`.
- Section anchors are `CEMETERY_SECTION_ANCHORS` (`cemetery`, `key-facts`, `causes`, `register`, `analysis`, `methodology`, `dataset`, `faq`) plus `#cause-<cause>` for each cause column. The autopsy row takes `autopsy-<id>`, a desktop grave `grave-<id>` and a phone grave `walk-<id>`; grave links point at `#<id>`.
- Unknown ids, unknown cause slugs and malformed encodings resolve to nothing.

`/cemetery/#<id>` resolves in CSS without JavaScript. The server renders the first 25 register rows (`REGISTER_FOLD_COUNT`) in full, each followed by a `hidden` autopsy row; a `@layer base` rule in `cemetery-register.module.css` shows the autopsy row after a `:target` row until the register hydrates (`data-enhanced`). Rows past the fold render as one compact cell (`tr#<id>[data-folded]`: name, ticker, cause, death date, epitaph, obituary and source), hidden by `tr[data-folded]:not(:target)` so only a targeted record shows. Full rows replace the compact ones once the reader unfolds, filters, searches or sorts, or a reveal targets a folded record. From hydration on the client owns expansion, because `replaceState` never moves `:target`. The page shell itself still needs JavaScript today: `Providers` (`src/components/providers.tsx`) streams the whole body into a hidden boundary that a script reveals, so with JavaScript off the fold is correct but not on screen.

`revealRecord` in the register runs these steps in order: it clears any filters that exclude the row (keeping the sort) and announces that; unfolds the list; expands the row; scrolls it into view (instantly under reduced motion) and focuses its disclosure; highlights it (a static outline under reduced motion); and writes `#<id>`. The register registers its reveal handler only once the URL filters are readable, so a hash reveal queued during hydration judges the real filters. The peak chart's dots call `revealRecord` with the source `chart`, and the register's "Show on the field ↑" calls `pinGrave` with the source `register`.

Hero pin/unpin writes/clears the hash; Read in register reveals with source hero. Register Show on field pins with source register and hands focus to the desktop grave or opens the phone sheet. Chart selection reveals with source chart. Hash pins do not scroll; register reveal owns that action and portrait hash pins only move the tab stop. Exactly one live responsive layer answers pin requests.

### Below the hero

`buildCemeteryStats(entries)` in `src/lib/cemetery-stats.ts` is the one view model for the key facts, cause band, charts, pattern headlines and FAQ. It is pure and SSR-deterministic, and its integrity rules bind every consumer:

- A missing, zero, negative or non-finite peak is "not recorded" (`null`), never zero. Sums and medians run over recorded peaks only, and every peak aggregate carries `knownCount`.
- `asOf` is the latest recorded `deathDate`, never the wall clock. `updatedAt` is the latest `recordedAt`.
- Headline counts use the full set. A trend claim ships only when it also holds on the curated records alone, because the tracked archive grew with Pharos's own coverage. A curated-only count is rising or falling only past both a 25% and a five-record change.
- Pattern headlines are guarded: a pattern whose guard fails is absent from `patterns`. "Counterparty failures are a larger share of recent deaths" compares curated records only, "Recorded deaths are becoming more frequent" appears only when the curated-only trend is rising, and "The largest coins did not all collapse" appears only when a discontinued cause (regulatory or abandoned) holds the largest recorded peak and a collapse cause has one.
- Copy says "peak market cap" and "failed or discontinued". Peak market cap measures size at the top, not holder losses; "destroyed", "wiped" or "lost" never label a peak sum, and "failure" never labels a regulatory or abandoned exit.
- `buildCemeteryFaq(stats)` templates every FAQ figure from the view model and quotes the inclusion rule.

Methodology distinguishes curated versus tracked-then-frozen admission, excludes active depegs/quarantined/delisted rows, and quotes the owning inclusion/primary-cause rules. Citation surfaces use `CEMETERY_DATASET_META`, never local counts/build times.

### Autopsy register

`buildCemeteryRegisterRows` projects data server-side; clients import types, never `CEMETERY_ENTRIES`. Missing peak/mechanism/epitaph is visibly/accessibly not recorded; duplicate tickers retain names/IDs.

`CEMETERY_REGISTER_PARAMS` owns filter keys, accepted values and canonical order. Invalid values drop; bounded trimmed search is case/accent-insensitive over name/ticker/id/epitaph, not obituary. URL writes replace history, preserve unrelated params and omit default sort/direction. Died uses canonical order; missing peaks sort last both directions with default order breaking ties. Result counts announce politely.

The server-rendered autopsy rows (first 25) carry the kicker, epitaph, obituary and source link, so a no-JS `#<id>` fragment shows them; the facts list (cause with a link to its definition, death date and precision, peak market cap, peg and record), mechanism (linked to its explainer), contracts, "Archived data →", the case study, "Copy link" and "Show on the field ↑" render once the row is expanded. Opening a row writes `#<id>`.

### Charts

Both charts are hand-rolled SVG driven by compact series props from `CemeteryStats`, with no Recharts on the route. Each has a `ChartDataTable` disclosure, which is also the screen-reader surface.

- Deaths by year keeps a continuous axis, marks partial years and separates tracked/curated coverage. Empty years are catalog gaps, not evidence of no failures; absent peaks stay unrecorded. Count/share views and headlines use guarded stats.
- Peak-by-cause plots recorded peaks only, names omissions/denominators and uses deterministic jitter and roving tabindex. Jitter maps the same frozen `fnv1a32(id)` hash through `(hash / 0xffffffff) * 2 - 1`; labelled dots retain their below-lane placement. Selecting a dot reveals the register row; the data table is an equivalent screen-reader surface.

Peak market cap is never presented as a loss: the section copy states that it measures size at the top, and the only peak sums shown are over recorded peaks with their `knownCount`.

## Compare (`/compare` + `/compare/[slug]`)

`src/app/compare/` owns static shells; `src/components/compare/compare-client.tsx` composes live data. `src/lib/compare-pages.ts` owns pair descriptors, `compare-config.ts` limits/presets, and `use-compare-*` hooks selection/data/sharing.

### Route shell and SEO

`/compare/` is the indexable live tool plus complete server-rendered pair directory/FAQ. Registered `/compare/<left-id>-vs-<right-id>/` briefs generate static params/metadata from `STATIC_COMPARISON_PAGES` and reject unknown slugs. Pair actions do not promise saved watchlists.

Editorial briefs link issuer sources and keep visible short answers equal to FAQ answers. Sources-checked dates are source verification, not human review, independent audits or live reserve freshness. Enriched briefs lead without disturbing relative order within enriched/fallback groups.

Pair JSON-LD is WebPage/ItemList with coin Thing nodes and visible PropertyValue rows. Sitemap includes hub/pairs; pair lastModified is newest coin LAST_EDITED or substantive editorial updatedAt, never build/recheck time.

Each pair page ends with a "Related comparisons" section: "More {A} comparisons" and "More {B} comparisons" link lists built from `getStaticComparisonPagesForCoin()` (editorial briefs first), excluding the current pair, anchored with each pair's `{A} vs {B}` short title. A coin with no other pair contributes no list; the section is omitted when neither does.

`STATIC_COMPARE_PAIRS` (`src/lib/compare-links.ts`) admits only active, non-frozen coins with full static profiles on both sides; additions are demand-led (Search Console, or combined sibling-profile impressions where no pair query data exists). A pair without an editorial brief ships with the generated intro, summary and FAQ.

### Selection and URL contract

- Maximum selection: `MAX_COMPARE_COINS = 5`.
- URL is the source of truth for selection state.
- Query param `coins` accepts canonical ticker-issuer IDs only (for example `usdt-tether`). Unknown IDs, legacy DefiLlama/historical IDs, and raw ticker symbols are dropped rather than guessed.
- Query param `range` stores the market-cap chart window. Accepted values are `7d`, `30d`, `90d`, `1y`, and `all`; `all` is the default and is cleared from the URL instead of persisted.
- Static comparison landing pages are generated from `STATIC_COMPARISON_PAGES` in `src/lib/compare-pages.ts` and live at `/compare/<left-id>-vs-<right-id>/`.
- Mobile selection renders selected-coin chips plus one add selector instead of all five selector slots up front. The underlying URL state and five-coin maximum are unchanged; desktop keeps the full slot grid.

Initial load normalizes the `coins` URL param to the accepted canonical ID list. If invalid tokens were present, `useCompareSelection()` rewrites the URL to the surviving canonical IDs or removes `coins` entirely.

### Data dependencies

Compare composes stablecoins, peg summary, Bluechip, DEX, report cards, redemption, yield, stress and aggregate mint/burn queries plus per-coin supply/flow histories. `useCompareDataModel` owns query/window construction; successful aggregate evidence is required to claim tracking coverage.

An empty comparison admits only the stablecoin list used by its selector. Metric feeds enable as soon as at least one accepted comparison ID exists, including URL-initialized selections. Empty-state retries do not bypass those gates; pending evidence remains unavailable, not an empty or safe verdict.

Bluechip publication availability is separate from per-coin membership. A pending or failed whole-feed read without retained data leaves only Bluechip unavailable; a successful empty map is a usable publication. Refresh failures keep retained ratings and their existing dated observation qualifiers, with source error/freshness notices intact.

It also derives live peg references with `derivePegRates(...)` for commodity/non-USD normalization in displayed prices.

The safety radar baseline counts only rated cards with all three plotted pillars. Peg/mechanism cohorts below three usable members fall back to all usable rated cards; the displayed count and median use this same population. NR, pipeline-gap, and incomplete-pillar cards contribute neither counts nor scores. Fewer than three usable cards suppresses the median. A selected rated card missing one pillar is still drawn: its measured pillars plot as open segments, and the missing axis is a dashed "Unknown" spoke whose tooltip names the scoring assumption; the imputed value is never plotted.

The live-flow cards and comparison table both preserve an explicitly observed zero 24-hour net as `$0.00`, including inactive windows. Unavailable or partial valuation remains unavailable; the independent 30-day pressure rating may still be `NR`.

### Share and export

Compare includes client-side share/export rendering:

- Builds a canvas card via `src/lib/compare-share-image.ts`
- Supports clipboard image copy + Twitter intent flow
- Supports PNG download from the generated canvas
- The share card reads market cap and the 7-day supply change through `getCirculatingRawOrNull()` / `getPrevWeekRawOrNull()`; an unavailable operand renders `—`, never `$0.00` or a fabricated `-100%` change

### Compare table context

The horizontally scrollable matrix is the comparable-field surface at every width; preserve accessible/narrow-screen access. Directional market-cap/issuance/yield fields are not universal winners.

The matrix uses the shared contextual methodology labels for Peg Score, Liquidity Score, and Safety. Missing source coverage renders as a dash rather than zero. External Bluechip says "Not rated" only when a usable publication omits that coin, including a successfully loaded empty map; no whole-feed publication means a dash, not an unrated verdict. A rated coin whose audit flag the source omits reads "audit not reported" beside its grade, and a source that positively reports no audit reads "no audit flag". Retained ratings keep their observation labels. Directional fields such as issuance flow, market-cap change, and yield are not styled as universal winners because their desirability depends on the comparison task.

Market cap and the `Market-cap change · 24h/7d/30d` rows use the already-USD current and historical circulation buckets through the nullable supply helpers. These are USD market-cap movements, not token-supply changes or price returns: unchanged EUR/gold token balances can move solely with USD valuation. No current-price conversion is applied to historical buckets; native detail supply trends instead use paired native token-count checkpoints. A coin whose current peg buckets are absent, empty or wholly invalid shows a dash for market cap and every market-cap change: a change is published only when both the current and the previous value are observed (and the previous value is positive), so missing current supply never becomes a `-100%` change. An explicitly observed zero still renders `$0.00` and its real change. Shared stablecoin-table delta context and the 7-day sparkline likewise name USD market cap.

The peg-track-record row `Open recorded incident` reports `activeDepeg` as Yes/No (or a dash when the peg-summary row is missing). No means only that no recorded incident is open, never that the asset is currently at peg. This remains true for NAV tokens, unusable prices/references, and assets below event-collection coverage; current deviation is a separate measurement.

## Operational notes

- Both pages are part of static export and rely on client-side fetches where applicable.
- Cemetery reliability depends on repository data curation (`shared/data/dead-stablecoins.json` via `shared/lib/dead-stablecoins.ts`).
- Cemetery Telegram notifications depend on the daily Telegram digest post plus `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; additions are detected from the repo dataset, not from a separate API feed.
- Compare global error/freshness notices include aggregate mint/burn flows. Tracking coverage requires a successful aggregate read; failed or absent evidence is unavailable, not zero tracked. Per-coin flow-history failures get a retry notice; supply-history failures show inline "History unavailable". The shared retry includes both histories, preserving retained data and successful peers.
