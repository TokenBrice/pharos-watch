# Cemetery and Compare

## Overview

This document covers two frontend-only feature surfaces that are not backed by dedicated page-specific worker endpoints:

- `/cemetery` — static memorial dataset + interactive UI
- `/compare` — indexable multi-source live compare tool plus static pair-directory hub
- `/compare/[slug]` — static comparison landing pages generated from tracked metadata

## Stablecoin Cemetery (`/cemetery`)

Primary files:

- `src/app/cemetery/page.tsx`
- `src/components/cemetery/cemetery-hero.tsx`: `CemeteryHero`, the server half of the hero (route head, One Beam figure, legend, desktop rest pose)
- `src/components/cemetery/plot-map-hero.tsx`: `PlotMapHero`, the hero's only client entry and its desktop interaction state
- `src/components/cemetery/plot-map-scene.tsx`: `PlotMapScene` and `desktopPlotLayout`
- `src/components/cemetery/plot-map-shapes.tsx`: shared SVG defs, grave bodies, medallions and flowers
- `src/components/cemetery/plot-map-legend.tsx`: `PlotMapLegend`
- `src/components/cemetery/plot-map-record-card.tsx`: `PlotMapRecordCard`, the preview and pinned record card
- `src/components/cemetery/plot-map-portrait-slot.tsx`: `PlotMapPortraitSlot`, the phone layer and its interaction
- `src/components/cemetery/plot-map-portrait.tsx`
- `src/components/cemetery/plot-map-portrait-aspect.ts`: `getPortraitAspectRatio`
- `src/components/cemetery/plot-map-sheet.tsx`: `PlotMapSheet`, the phone bottom sheet
- `src/components/cemetery/use-plot-layout.ts`: `usePlotLayout`, which layer is live
- `src/components/cemetery/plot-map.module.css`
- `src/components/cemetery/plot-map-mobile.module.css`
- `src/lib/cemetery-plot-map.ts`: `buildCemeteryPlotMap`, the plot-map view model, plus camera, tag, chip and card placement
- `src/lib/cemetery-plot-geometry.ts`: projections and drawn shape geometry
- `src/lib/cemetery-plot-map-input.ts`: `toPlotMapInput` and `toPlotLogoAtlas`, what crosses the server/client boundary
- `src/components/cemetery/cemetery-selection-context.tsx`: `CemeterySelectionProvider`, the only owner of the URL hash
- `src/lib/cemetery-selection.ts`: section and record anchors, hash parsing, peak buckets and the register URL filters
- `src/lib/cemetery-stats.ts`: `buildCemeteryStats`, the below-the-hero view model, and `buildCemeteryFaq`
- `src/lib/cemetery-register.ts`: `buildCemeteryRegisterRows`, the server projection behind the register
- `src/lib/cemetery-editorial.ts`: editorial titles and the obituary sentence splitter
- `src/components/cemetery/cemetery-key-facts.tsx`
- `src/components/cemetery/cemetery-causes.tsx`
- `src/components/cemetery/cemetery-register.tsx`
- `src/components/cemetery/cemetery-register-model.ts`
- `src/components/cemetery/cemetery-register-row.tsx`
- `src/components/cemetery/cemetery-register-autopsy.tsx`
- `src/components/cemetery/cemetery-register.module.css`
- `src/components/cemetery/cemetery-analysis.tsx`
- `src/components/cemetery/deaths-by-year-chart.tsx`
- `src/components/cemetery/peak-by-cause-chart.tsx`
- `src/components/cemetery/cemetery-context.tsx`
- `src/components/cemetery/cemetery-dataset.tsx`
- `src/lib/cemetery-dataset-meta.ts`
- `src/lib/cemetery-json-ld.ts`
- `src/app/feed/cemetery.xml/route.ts`
- `shared/lib/cause-of-death.ts`
- `shared/lib/cemetery.ts`
- `shared/lib/cemetery-merged.ts`
- `shared/lib/dead-stablecoins.ts`
- `shared/data/dead-stablecoins.json`
- `scripts/maintenance/generate-cemetery-dataset.ts`
- `scripts/maintenance/build-cemetery-logo-atlas.ts`
- `scripts/maintenance/build-og-cemetery.ts`
- `public/datasets/stablecoin-cemetery.json`
- `public/datasets/stablecoin-cemetery.csv`
- `public/logos/atlas/cemetery-atlas.webp`
- `src/lib/cemetery-logo-atlas.generated.json`
- `public/og-cemetery.png`

### Data model

Cemetery data is static and versioned in-repo. The curated dead-coin dataset lives in `shared/data/dead-stablecoins.json` and is validated and exported as `DEAD_STABLECOINS` by `shared/lib/dead-stablecoins.ts` through `parseDeadStablecoinAssets`. The route, the public dataset export, the `/feed/cemetery.xml` RSS feed (`src/app/feed/cemetery.xml/route.ts`), the logo atlas and the worker cemetery tape projector (`worker/src/lib/tape-projectors/cemetery.ts`) consume `CEMETERY_ENTRIES` from `shared/lib/cemetery-merged.ts`, which combines those curated dead rows with frozen tracked stablecoins.

Each entry follows `DeadStablecoinSchema` (`shared/types/market.ts`):

- identity: `id`, `name`, `symbol`, optional `llamaId`, `geckoId`, `aliases` and `logo`
- context: `pegCurrency`, `causeOfDeath`, `deathDate` (`YYYY-MM` or `YYYY-MM-DD`)
- narrative: optional `epitaph`, `obituary`, `sourceUrl`, `sourceLabel`
- optional `peakMcap`: approximate peak market cap in USD; absent when no reliable figure was curated, never zero
- optional `contracts`: an array of `{ chain, address }` for block-explorer links in the register autopsy
- `mechanismArchetype`: how the coin was designed to hold its peg, one of `MECHANISM_ARCHETYPE_VALUES`. It is independent of `causeOfDeath` and is the one authority for cemetery mechanism links, the register's mechanism filter and the linked-death counts on mechanism explainers. `src/lib/__tests__/mechanism-explainers-cemetery.test.ts` checks every explainer `decommissioned` entry against the archetype of the cemetery record it names. Absent means not yet classified.
- `recordedAt`: the UTC `YYYY-MM-DD` date on which the record entered Pharos. It is not the death date: it separates recently died from recently documented, and it drives the "Latest record added" date and the dataset `updatedAt`.

Frozen rows also carry `archivedDataAvailable: true` (the `CemeteryEntry` type); curated rows leave it absent.

Cause metadata is centralized in `shared/lib/cause-of-death.ts`, the single authority for every cemetery surface and for the cause copy on the glossary, About and Start Here pages. `CAUSE_META` holds each cause's label, its approved one-sentence definition and its Tailwind text and border classes. `CAUSE_HEX` and `CAUSE_HEX_DARK` hold the light- and dark-theme mark colours, which `src/lib/cemetery-cause-style.ts` applies through CSS custom properties so no component reads the theme. `CAUSE_ORDER` fixes the cause order for legends, strips, columns and filters, and `CAUSE_LABEL_LIST` renders the labels as one prose list. Copy surfaces quote these values rather than restating them.

### Curating a record

The page prints its inclusion and primary-cause rules in the methodology section (`CEMETERY_INCLUSION_RULE` and `CEMETERY_PRIMARY_CAUSE_RULE` in `src/components/cemetery/cemetery-context.tsx`). That copy describes the whole archive as it stands: each record links one public source, most of which document the failure or discontinuation directly, while a coin that faded without an announcement links the best public context Pharos found. The page never calls the set "primary sources". New curated rows in `shared/data/dead-stablecoins.json` meet a stricter bar:

- **Inclusion.** A new record needs a public market and a primary public source that documents its failure or discontinuation: an issuer or protocol announcement, a governance record, official docs or a status page, a regulator, court or registry filing, or an on-chain record. `sourceUrl` links a source that documents the end, preferably that primary source; reputable press may be linked instead only when it documents the same event. A market-data listing, a provider "ended" or "deprecated" marker, a launch or fundraising article, or a general wiki never qualifies. There is no size floor; peak market cap is recorded when known. Records curated before 2026-10 do not all meet this bar; the September 2026 source audit left 20 records whose source is context only, and re-sourcing them is open curation work.
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

The JSON export is schema `1.1`. Its header carries `schemaVersion`, name, description, the MIT license, the canonical cemetery, JSON and CSV URLs, `sourceDataPath`, a combined `sourceChecksum`, per-source `sourceData`, `recordsOrderedBy`, `rowCount`, `updatedAt`, `limitations`, `datasetFields` and a description for every row field in `fields`. Dataset-level `updatedAt` is the latest row `recordedAt`: when the newest record entered Pharos. It tracks documentation, not deaths, and is null only when no row carries a `recordedAt`.

Each row carries `id`, `name`, `symbol`, `llamaId`, `logoUrl`, `pegCurrency`, `causeOfDeath`, `causeLabel` (from `CAUSE_META`), `deathDate`, `deathDatePrecision`, `peakMcapUsd`, `epitaph`, `obituary`, `sourceUrl`, `sourceLabel`, `archivedDataAvailable`, `contracts`, `pharosUrl`, `mechanismArchetype` and `recordedAt`. In JSON a missing optional value exports as `null` (missing contracts as an empty array), never as zero; the CSV leaves the cell empty. `pharosUrl` resolves to `/stablecoin/<id>/` when archived data is available and to the canonical `/cemetery/#<id>` anchor otherwise. The CSV export mirrors the same rows and column order, with contracts flattened as `chain:address` pairs.

Both exports are deterministic. The `cemetery-dataset` unit in `GENERATED_ARTIFACT_REGISTRY` (`scripts/lib/automation-registry.mjs`) is maintenance-only and auto-staged: the pre-commit hook regenerates and stages the exports when a staged change touches their sources, which include `shared/lib/cause-of-death.ts` because rows embed `causeLabel`. `npx --no-install tsx scripts/maintenance/generate-cemetery-dataset.ts` regenerates them by hand, and `npm run check:generated-artifacts -- --only=cemetery-dataset` fails when the checked-in exports drift from either source. The case-study OG unit (`og-case-studies`) depends on this one and reads the published JSON. Provenance pins `shared/data/dead-stablecoins.json` and `shared/lib/cemetery-merged.ts#frozenCemeteryProjection` (the `buildFrozenCemeteryProjection()` output, not the whole generated catalog), so an active-coin edit leaves the published checksum unchanged.

The stable `id` field is the primary dead-coin identifier across the cemetery UI, public dataset export, report-card defunct rows, and Telegram cemetery snapshots. `llamaId` remains optional provider metadata only.

The `/cemetery/` page emits a `Dataset` JSON-LD node (`buildCemeteryDatasetJsonLd` in `src/lib/cemetery-json-ld.ts`) built from the checked-in JSON export header, alongside the `CollectionPage` and `ItemList` nodes. Its `@id` is `/cemetery/#dataset`, which resolves to the page's "Download and cite" section. The node links JSON and CSV `DataDownload` distributions at the public `/datasets/stablecoin-cemetery.{json,csv}` URLs, sets `dateModified` from `updatedAt`, exposes every row field description as `variableMeasured` (new fields join automatically), includes source checksum and row-count metadata, and must not point crawlers at internal `/_site-data/*` URLs.

### RSS feed

`/feed/cemetery.xml` publishes the 50 newest records in `sortCemeteryCoins` order (`CEMETERY_FEED_MAX_ITEMS` mirrors the limit for page copy). Each item is titled `Name (SYMBOL): Cause label` with the `CAUSE_META` label, links to `/cemetery/#<id>`, uses `pharos:cemetery:<id>` as its GUID, and dates `pubDate` from `deathDate` (a month-precision date uses the first of the month).

### Logo atlas

`scripts/maintenance/build-cemetery-logo-atlas.ts` packs every cemetery logo into one WebP atlas, `public/logos/atlas/cemetery-atlas.webp`, with a manifest at `src/lib/cemetery-logo-atlas.generated.json`. Each row resolves its logo through `resolveCemeteryLogoUrl`, the same rule as the rest of the UI. Each distinct source image becomes a full-colour cell and a grayscale cell; rows that share source bytes share cells, and rows with no logo are listed as missing so the UI renders an initial. The atlas stays within a 150 KB budget.

It is the registered `cemetery-logo-atlas` generated artifact, auto-staged by the pre-commit hook when a staged change touches its sources: the cemetery logos, `data/logos.json`, the dead-coin data, the catalog or the cemetery modules. Freshness is judged on an input signature (`scripts/maintenance/state/cemetery-logo-atlas-signature.json`) rather than by re-encoding, because WebP bytes differ across platforms. `npm run logos:cemetery-atlas` regenerates it by hand, and `npm run check:generated-artifacts -- --only=cemetery-logo-atlas` verifies it.

### OG image

`/cemetery/` selects `public/og-cemetery.png`, a 1200×630 card rendered from the real plot map by `scripts/maintenance/build-og-cemetery.ts`: the light-theme desktop plan at rest under the route head and the frost recorded-deaths figure. It is the registered `og-cemetery` generated artifact. It depends on `cemetery-logo-atlas` and is auto-staged by the pre-commit hook, so a new death regenerates it. Freshness is an input signature (`scripts/maintenance/state/og-cemetery-signature.json`). [OG Images](./og-images.md) documents the pipeline.

### Frozen entries in the cemetery

Frozen tracked stablecoins (registry entries with `status: "frozen"`) merge into the cemetery alongside curated `DEAD_STABLECOINS` through `shared/lib/cemetery-merged.ts`:

- `frozenToDeadShape()` maps each `FROZEN_STABLECOINS` entry's registry `obituary` block to `deathDate`, `epitaph`, `obituary`, `causeOfDeath`, `peakMcap`, `sourceUrl` and `sourceLabel`, copies the coin's own `mechanismArchetype` and `contracts`, and sets `archivedDataAvailable: true`. In the register, frozen rows carry an `Archive` tag and, once opened, an "Archived data →" link to `/stablecoin/<id>/`, which serves the frozen detail page with the `<FrozenStateBanner>` and the "Data frozen on YYYY-MM-DD" chart footer. Curated rows leave `archivedDataAvailable` falsy and link only to the cemetery anchor.
- `recordedAt` for a frozen row is its `frozenAt` date unless `obituary.recordedAt` overrides it. The override is for coins whose `frozenAt` preserves a historical freeze date although the record reached the cemetery later: it records the entry date and leaves `frozenAt` untouched. `obituary.recordedAt` must be a strict UTC `YYYY-MM-DD`, and an invalid date throws rather than publishing a fabricated one.
- Identifier rules: the merged `id` for a frozen row is the registry `id` (the same canonical ticker-issuer ID used everywhere else on the site). Curated dead-coin ids (e.g. `ust-terrausd-2022-05`) keep their stable cemetery-only identifiers. An id that appears in both sources fails the merge.
- `frozenAt` itself is not copied onto the entry and does not participate in the sort key; `deathDate` does.

### Telegram channel notifications

The cemetery dataset now has a worker-side Telegram notification path:

- `worker/src/lib/telegram/digest-appendices.ts`
- runs as part of daily Telegram digest delivery
- diffs the deployed `DEAD_STABLECOINS` list against a cached snapshot in D1
- seeds silently on first run so existing graves do not backfill into Telegram
- appends one consolidated cemetery section to the next Telegram daily digest when a deploy adds one or more new entries

Each appendix includes the epitaph (when present) for every newly added coin plus a rotating darkly editorial footer line.

### UI behavior

The hero (`#cemetery`) is an isometric plot map: a walled cemetery on a headland, drawn in 2:1 dimetric with one light from the east-north-east, the lighthouse on the north-east rocks and the gate to the west. `buildCemeteryPlotMap` in `src/lib/cemetery-plot-map.ts` is its pure view model: no DOM, clock or randomness (every seed is an FNV-1a hash of the id), plain serialisable output, identical for identical input in any order. Every drawn element encodes a field; walls, paths, slab and sea play the role of chart axes. `PlotMapLegend` states each encoding with examples drawn by the same geometry.

Encodings:

- **Sections are causes of death** in `CAUSE_ORDER`, from Abandoned in the front lane to Regulatory under the sea wall. Each signpost prints the `CAUSE_META` label and count in sans small caps. Stone shape repeats the cause: a plain pillow marker (abandoned), an arched headstone split from the crown (counterparty failure), an emptied urn (liquidity drain), a broken column (algorithmic failure) and a sealed tablet with a "closed by order" seal plate (regulatory). Beds, curbs and stones carry a light cause tint from `CAUSE_HEX` and `CAUSE_HEX_DARK`.
- **Time runs through shared year blocks** aligned across every section: the newest year stands at the gate and the oldest under the lighthouse. Years with no recorded death share one strip (for example `2019-2020`). The model anchors world positions at the oldest end, so a new death extends the plan toward the gate without moving an existing grave.
- **Plinth steps are powers of ten of peak market cap**: `clamp(floor(log10(peak)) - 6, 0, 4)`, one step each at $10M, $100M, $1B and $10B (`PLOT_STEP_THRESHOLDS_USD`). Stone height follows a clamped log scale with an explicit floor and ceiling (`PLOT_HEIGHT`).
- **Lots grow with the class.** A peak of $1B or more takes a 2×2 lot (an abandoned coin becomes a chest tomb); $10B or more takes a 3×3 lot, where architecture carries the class instead of height. The algorithmic colossus is TerraUSD's snapped fluted column, the tallest element in the scene; any other cause at that size is a sealed mausoleum with a barred door and a gavel carved flat into the tympanum (Binance USD). Chips name both colossi.
- **Orderly exits read intact.** Only counterparty-failure headstones are cracked. Regulatory tablets and the Binance USD mausoleum stay whole at every weathering class, because the stone encodes the cause of death, not what holders recovered. The legend says so, and adds that peak market cap is not what holders lost.
- **Unrecorded peaks** stand at a neutral height (the lower median of the $10M to $100M class, never the floor) with a hatched face, an outlined plinth and their own legend swatch.
- **Age is measured against `asOf`**, the latest recorded `deathDate`, never the clock. Weathering is quantised into five classes at 0.5, 1.5, 3 and 5 years (`PLOT_WEATHER_BOUNDS_YEARS`): grime deepens, lichen appears from the third class and a moss band from the fourth, the oldest 1×1 stones lean, and the medallion logo fades. Fresh soil marks a death within `PLOT_FRESH_DAYS` (90) days of `asOf`.
- **Marks.** A bronze plaque means Pharos holds a frozen data page (`archivedDataAvailable`, the register's tracked archive). A footstone glyph marks a non-USD peg (`PLOT_PEG_GLYPHS`: € and ¥, ∿ for a variable peg, ◇ for any other), set in mono. The cypress verge outside the front railing carries one cypress per year, its height the number of deaths that year.
- **Logos** are cells of the logo atlas (see [Logo atlas](#logo-atlas)): grey at rest, fading with weathering, with the colour cell sliding in on hover, focus or pin. A row with no logo shows the first letter of its symbol.
- **One Beam.** The count of recorded deaths (`stats.total`) is the page's only frost figure, with the year span, the "interred" plaque and a one-line "Latest recorded death" under it. The drawn frost beam from the lantern rests on that figure and moves only on interaction.

Desktop interaction (above 760 px), owned by `PlotMapHero`:

- **Keyboard.** The plan is one tab stop (roving tabindex) that lands on the newest grave. ←/→ move to the previous or next death in the section, ↑/↓ to the adjacent section at the nearest date, and Home/End to the ends. The plan group's `aria-describedby` states this contract ahead of the reading rules, and the legend repeats it in one line. A "Skip the cemetery map" link to `#register` precedes the plan and the signposts follow it. Graves are `<a id="grave-<id>" href="#<id>" role="button" aria-pressed>` with a full accessible name (`plotGraveLabel`); their drawn bodies (stone, medallion logo, glyphs) and the scenery are `aria-hidden`. The desktop island handles only events from its own DOM while the desktop plan is the live layer: the phone layer and its portalled sheet sit inside the same hero section and own their own keys and taps.
- **Hover and focus** light a grave: a ground ring, the colour logo, a collision-aware tag (`placePlotTag`, clear of signposts, chips, their leaders, the figure and the card, and below the sticky chrome) and, at 1280 px and wider, a preview card with the cause, name, epitaph, obituary lead and facts. A grave shown in a card (the preview, or the pinned card docked or in flow) gets no tag. From 1024 px a hovered colossus lifts its chip instead of repeating it in a tag. The beam swings to a hovered grave after a `PLOT_BEAM_DWELL_MS` (180 ms) dwell and to a focused grave at once.
- **Pin.** A click, Enter or Space pins the grave. `PlotMapRecordCard` then shows the full obituary (scrollable), the Died, Peak, Peg and Record grid, and the Source, Archived data, Case study, Mechanism explainer and "Read in the register ↓" links. At 1280 px and wider the card docks beside the grave with a hairline to its medallion (`placeInspectorCard`), clear of the sticky chrome, the Feedback button, the route head (the zoom toolbar while zoomed) and, while an ordinary grave is read, the colossi. Within that free run it slides, and up to 48 px further from the grave, to cover as few signpost plates, colossus chips and year stamps as it can without ever shortening for them; a label it still covers hides whole, with its leader, rather than showing cut in half. From 761 to 1279 px it sits in flow below the plan and scrolls into view clear of the mobile bottom nav and the Feedback button; on landscape phones (500 px tall or less) it fits the band between the sticky header and the bottom nav and scrolls as a whole. A pin writes `#<id>` and is announced once through a polite status region. Escape or a click on empty ground unpins; the next Escape leaves a section zoom. While a grave is pinned or hovered, or a section is zoomed, Escape and F also work with focus elsewhere on the page.
- **Section zoom.** Hovering or focusing a signpost dims the other sections; clicking it brings the frame top under the sticky chrome and zooms the section (`fitSectionCamera`) so a plain stone reaches the 28 px floor, under a "← Whole cemetery" toolbar. The fit uses the band measured between the sticky chrome and any fixed bottom bar (the phone nav below 1024 px). When the whole section cannot reach the floor, the camera frames the contiguous run of years with the most graves and the chip reads "showing <years>, <n> of <total> (← → keys reach the rest)"; ←/→ pan to the graves outside it. At the 1440×800 reference viewport only Algorithmic failure opens in this partial window.
- **Year highlight.** Hovering a cypress or a year stamp lights that year across the plan.
- **Flowers.** Pressing F on a hovered or pinned grave, or the pinned card's "Leave a flower" button, leaves a flower for the session (at most `PLOT_FLOWER_MAX` per grave). The count stays hidden until the first flower, and the page lead does not mention the key.
- **Motion** is limited to the beam swing, the zoom glide and the flower bloom, all triggered by the reader. Under reduced motion (`usePrefersReducedMotion`, which honours the `data-motion` override) the beam jumps and the zoom cuts.

Phones (760 px and narrower, `PLOT_PORTRAIT_QUERY`) get a portrait plan from `PlotMapPortraitSlot`: sections become columns in `CAUSE_ORDER` and years run down the page. It mounts after hydration, built from the same register rows, into a box the server reserves from `getPortraitAspectRatio(rows, asOf)` plus the header row, so it lands without layout shift. It keeps one roving tab stop (↑/↓ along the column, ←/→ to the adjacent column at the nearest date) and resolves a tap to the nearest grave centre. Opening a grave scrolls it clear of the `PlotMapSheet` bottom sheet, which sits above the mobile bottom nav and carries the same record card; Escape or a tap on empty ground closes it. The One Beam figure folds into one row under the route head. The legend reads in the same order at every width: a two-line key ("Each stone is one coin. Sections show why; rows show when; bigger monuments mean bigger recorded peaks.", plus "Select a cause sign to look closer." where signposts zoom), shape = cause, plinth steps with the hatched unrecorded peak, then the finer marks (year blocks, weathering, fresh soil, plaque, footstone, cypress), which phones fold into a disclosure. Where the plans differ the legend describes the one on screen: the gate, lighthouse, cypresses and hover above 760 px; columns left to right, the newest row at the top and taps on phones.

On phones the margin year labels are placed from measurements (they push down past thin blocks, then the stack is pulled back inside the plan), a column head wider than its column grows centred on it (the last column rightwards), and the plan group's `aria-describedby` states the phone keyboard contract. The legend's disclosure folds once on phones, except when the page opened on a fragment or the legend's top is already above the viewport, so folding never moves content under the reader. Inside the sheet the record card drops its own frame, its close button is 44 × 44, and the facts row wraps whole items on narrow screens.

Render boundary. `CemeteryHero` is a server component: it renders the route head (the Newsreader h1, a one-sentence lead and the Methodology, Register and Dataset links), the One Beam figure and the legend, and solves the desktop rest pose with `desktopPlotLayout` (how far the plan slides under the header into its empty sky, where the colossus chips hang, and the beam's rest angle for each viewport band), which reaches CSS as custom properties. `PlotMapHero` is the hero's only client entry. It receives the same `buildCemeteryRegisterRows` array the register receives, the slim atlas from `toPlotLogoAtlas` and that layout, and builds the desktop model in a `useMemo`; the model never crosses the boundary, and client modules import no `CEMETERY_ENTRIES`. The portrait plan is client-only inside its reserved box. Without JavaScript a `<noscript>` rule hides the empty phone slot and shows the desktop plan at every width, and each grave link still resolves `#<id>` to its register row through the `:target` fold.

### Selection and deep links

`CemeterySelectionProvider` (`src/components/cemetery/cemetery-selection-context.tsx`) is the only owner of `location.hash` on `/cemetery/`. It parses the hash on mount and on every `hashchange` through `parseCemeteryHash`, ignores the echo of a hash it wrote itself, and never scrolls: registered handlers own scrolling and reduced motion. A record hash pins the grave (`pinGrave`) and reveals the record (`revealRecord`) with the source `hash`. Surfaces register their handlers with `registerPinGrave` and `registerRevealRecord`; a request made before its handler registers is queued, and the latest one wins. `setRecordHash` writes `#<id>` with `history.replaceState`, so opening records never adds history entries.

Anchors:

- `#<id>` is the canonical public record anchor. RSS items, dataset `pharosUrl` values for curated rows, and the register's "Copy link" all use it. The register's main row carries `id="<id>"` and a scroll margin that clears the sticky chrome.
- `#obituary-<id>` is a legacy alias. `parseCemeteryHash` resolves it to the record, and the provider rewrites the hash to `#<id>`.
- Section anchors are `CEMETERY_SECTION_ANCHORS` (`cemetery`, `key-facts`, `causes`, `register`, `analysis`, `methodology`, `dataset`, `faq`) plus `#cause-<cause>` for each cause column. The autopsy row takes `autopsy-<id>`, a desktop grave `grave-<id>` and a phone grave `walk-<id>`; grave links point at `#<id>`.
- Unknown ids, unknown cause slugs and malformed encodings resolve to nothing.

`/cemetery/#<id>` resolves in CSS without JavaScript. The server renders the first 25 register rows (`REGISTER_FOLD_COUNT`) in full, each followed by a `hidden` autopsy row; a `@layer base` rule in `cemetery-register.module.css` shows the autopsy row after a `:target` row until the register hydrates (`data-enhanced`). Rows past the fold render as one compact cell (`tr#<id>[data-folded]`: name, ticker, cause, death date, epitaph, obituary and source), hidden by `tr[data-folded]:not(:target)` so only a targeted record shows. Full rows replace the compact ones once the reader unfolds, filters, searches or sorts, or a reveal targets a folded record. From hydration on the client owns expansion, because `replaceState` never moves `:target`. The page shell itself still needs JavaScript today: `Providers` (`src/components/providers.tsx`) streams the whole body into a hidden boundary that a script reveals, so with JavaScript off the fold is correct but not on screen.

The register section uses `content-visibility: auto` with a per-width `contain-intrinsic-block-size` close to the folded register's real height, so the browser skips its layout on the first frame; its spacing uses `gap` because content-visibility stops child margins collapsing through it.

`revealRecord` in the register runs these steps in order: it clears any filters that exclude the row (keeping the sort) and announces that; unfolds the list; expands the row; scrolls it into view (instantly under reduced motion) and focuses its disclosure; highlights it (a static outline under reduced motion); and writes `#<id>`. The register registers its reveal handler only once the URL filters are readable, so a hash reveal queued during hydration judges the real filters. The peak chart's dots call `revealRecord` with the source `chart`, and the register's "Show on the field ↑" calls `pinGrave` with the source `register`.

Round trips between the surfaces:

- **Hero to register.** A hero pin writes `#<id>` through `setRecordHash`, and unpinning clears the hash. "Read in the register ↓" on the pinned card or the phone sheet calls `revealRecord` with the source `hero`.
- **Register to hero.** "Show on the field ↑" calls `pinGrave` with the source `register`. On the desktop plan the hero pins the grave, scrolls up to it (smoothly unless reduced motion applies) and hands it keyboard focus; on phones the portrait slot opens the sheet for it.
- **Chart to register.** A peak-chart dot calls `revealRecord` with the source `chart`.
- **Hash to both.** A record hash pins the grave without scrolling it (the register's reveal owns scrolling; on phones it only moves the tab stop, because a sheet would cover the revealed row) and reveals the register row.

The desktop hero registers the `pinGrave` handler while the desktop plan is live and the portrait slot registers it at 760 px and narrower (`usePlotLayout`), so exactly one layer answers a pin.

### Below the hero

`buildCemeteryStats(entries)` in `src/lib/cemetery-stats.ts` is the one view model for the key facts, cause band, charts, pattern headlines and FAQ. It is pure and SSR-deterministic, and its integrity rules bind every consumer:

- A missing, zero, negative or non-finite peak is "not recorded" (`null`), never zero. Sums and medians run over recorded peaks only, and every peak aggregate carries `knownCount`.
- `asOf` is the latest recorded `deathDate`, never the wall clock. `updatedAt` is the latest `recordedAt`.
- Headline counts use the full set. A trend claim ships only when it also holds on the curated records alone, because the tracked archive grew with Pharos's own coverage. A curated-only count is rising or falling only past both a 25% and a five-record change.
- Pattern headlines are guarded: a pattern whose guard fails is absent from `patterns`. "Counterparty failures are a larger share of recent deaths" compares curated records only, "Recorded deaths are becoming more frequent" appears only when the curated-only trend is rising, and "The largest coins did not all collapse" appears only when a discontinued cause (regulatory or abandoned) holds the largest recorded peak and a collapse cause has one.
- Copy says "peak market cap" and "failed or discontinued". Peak market cap measures size at the top, not holder losses; "destroyed", "wiped" or "lost" never label a peak sum, and "failure" never labels a regulatory or abandoned exit.
- `buildCemeteryFaq(stats)` templates every FAQ figure from the view model and quotes the inclusion rule.

Sections below the hero, in page order:

- **Key facts** (`#key-facts`, `CemeteryKeyFacts`): four neutral figures (the trailing 12 months with its tracked and curated split, the two-coin share of recorded peak, the median peak, and the tracked-archive count linked to its register filter). A footer rail prints "Latest record added" (latest `recordedAt`, not a last-edit time), the latest recorded death (`asOf`), the dataset schema and the short checksum, which identifies the revision.
- **How stablecoins die** (`#causes`, `CemeteryCauses`): a paired share strip of deaths against recorded peak, then one column per cause with its `CAUSE_META` definition, counts, shares, median and largest peak, and a register link.
- **Autopsy register** (`#register`, `CemeteryRegister`): every record, described below.
- **Analysis** (`#analysis`, `CemeteryAnalysis`): the two charts, described below.
- **Methodology** (`#methodology`, `CemeteryContext`): the two routes into the cemetery (tracked then frozen, and curated) linked to the lifecycle methodology, what stays out (active depegs, quarantined and delisted records), the inclusion and primary-cause rules verbatim, fields and limits templated from the view model, and links to case studies and mechanism explainers with their linked-death counts.
- **Download and cite** (`#dataset`, `CemeteryDataset`): row count, schema, license, latest-record-added date and short checksum from `CEMETERY_DATASET_META`; JSON, CSV, RSS, Telegram and Timeline links; and a copyable citation.

### Autopsy register

The page projects rows server-side with `buildCemeteryRegisterRows` and passes them to the client register as props; client modules import only types, never `CEMETERY_ENTRIES`. Columns are Coin (struck-through ticker plus name, so duplicate tickers stay distinct), Cause, Died, Peak market cap, Peg, Mechanism, Record (`Archive` and `Case study` tags), Epitaph and the disclosure. Narrow screens keep Coin, Died, Peak and the disclosure. A missing peak, mechanism or epitaph prints "—" with a screen-reader "not recorded".

Filters and sort live in the URL through `useUrlFilters`, written with replace semantics. `CEMETERY_REGISTER_PARAMS` defines the params in canonical order:

| Param | Values |
| --- | --- |
| `cause` | a `CAUSE_OF_DEATH_VALUES` slug |
| `year` | a four-digit death year |
| `peg` | a peg currency |
| `mechanism` | a `MECHANISM_ARCHETYPE_VALUES` slug |
| `record` | `tracked` (tracked archive), `curated`, `case-study` |
| `peak` | `1b-plus`, `100m-1b`, `10m-100m`, `under-10m`, `not-recorded` |
| `q` | search text, trimmed, at most 80 characters |
| `sort` | `died` (default), `peak`, `name`, `cause` |
| `dir` | `asc` or `desc` |

`parseRegisterFilters` drops every invalid value. `buildRegisterHref` builds links such as `/cemetery/?cause=abandoned#register`: it writes register params in canonical order, replaces the register params of a base URL and keeps its unrelated params after them. The register writes `sort` and `dir` only when they differ from the default (Died, newest first, or a column's default direction). Search is case- and accent-insensitive over name, ticker, id and epitaph; obituary text is not searchable client-side. Died follows `sortCemeteryCoins` in both directions. Peak sorts put unrecorded peaks last in both directions, and every tie falls back to the default order. Result-count changes are announced politely.

The server-rendered autopsy rows (first 25) carry the kicker, epitaph, obituary and source link, so a no-JS `#<id>` fragment shows them; the facts list (cause with a link to its definition, death date and precision, peak market cap, peg and record), mechanism (linked to its explainer), contracts, "Archived data →", the case study, "Copy link" and "Show on the field ↑" render once the row is expanded. Opening a row writes `#<id>`.

### Charts

Both charts are hand-rolled SVG driven by compact series props from `CemeteryStats`, with no Recharts on the route. Each has a `ChartDataTable` disclosure, which is also the screen-reader surface.

- **Documented deaths per year, by cause** (`DeathsByYearChart`): stacked bars on a continuous axis from the first to the latest year, so a year with no records reads "none recorded" (a dash below `sm`, where the word would touch its neighbour) rather than disappearing. A Count/Share toggle switches the scale. The tracked-archive share of every segment is hatched, the latest year is outlined dashed and marked partial when the data stops before its end, and a median-peak row under the axis prints "n/r" where no peak is recorded. The footnote names the tracked-archive share of the latest year and states that empty years are a catalog gap, not evidence of no failures. Only guarded headlines appear.
- **Peak market cap by cause** (`PeakByCauseChart`): a log-scale strip plot with one lane per cause in `CAUSE_ORDER` and one dot per record with a recorded peak. Jitter is seeded by an FNV-1a hash of the id (labelled dots only drop below the lane line, so their symbol clears the lane label), a tick marks each lane's median, and the global top five are labelled. Below `sm` the in-plot lane label omits the unrecorded count, which the footnote and data table carry. Its one headline prefers "The largest coins did not all collapse" over the two-coin concentration, which the key facts already print. Dots use a roving tabindex, and selecting one reveals its register row. The footnote counts unplotted records and the peak-size buckets.

Peak market cap is never presented as a loss: the section copy states that it measures size at the top, and the only peak sums shown are over recorded peaks with their `knownCount`.

## Compare (`/compare` + `/compare/[slug]`)

Primary files:

- `src/app/compare/page.tsx`
- `src/app/compare/[slug]/page.tsx`
- `src/components/compare/compare-client.tsx` — `CompareClient` + mobile selection controls
- `src/components/comparison-table.tsx`
- `src/components/comparison-chart.tsx`
- `src/components/compare-empty-state.tsx`
- `src/lib/compare-pages.ts`
- `src/lib/compare-config.ts` — `MAX_COMPARE_COINS`, `COMPARISON_PRESETS`
- `src/lib/compare-types.ts` — shared compare slot / preset types
- `src/lib/compare-share-image.ts`
- `src/hooks/use-compare-selection.ts` — selection state management
- `src/hooks/use-compare-data-model.ts` — data fetching and derived state
- `src/hooks/use-compare-share-actions.ts` — share/export logic

### Route shell and SEO

- `src/app/compare/page.tsx` is the indexable live comparison entry point. It uses `buildPageMetadata(...)` with canonical `/compare/`, serves the live client through `createClientFeaturePage(...)`, and keeps the client tool as the primary on-page workflow.
- The `/compare/` page also server-renders a crawlable pair directory from `STATIC_COMPARISON_PAGES` plus a compare FAQ. The directory includes a priority static-pair cluster for high-intent wrapper, gold-token, Liquity, and issuer-substitute searches, then links to every static pair brief and to matching live compare-tool URLs; the FAQ emits FAQ JSON-LD through `FaqSection`.
- `src/app/compare/[slug]/page.tsx` is the indexable static comparison surface. It statically generates params from `STATIC_COMPARISON_PAGES`, builds per-page metadata from each page descriptor, and calls `notFound()` for unknown slugs.
- Static comparison URLs follow `/compare/<left-id>-vs-<right-id>/`, with metadata/title/description derived from `src/lib/compare-pages.ts`.
- Pair-page actions open the matching live comparison, Telegram setup, digest RSS, or API access. They do not promise a saved watchlist. Directory copy describes the comparison workflow; crawlability rationale belongs in documentation.
- Three existing briefs (USDC/USDG, USDe/sUSDe and PAXG/XAUT) have pair-specific editorial introductions, short answers and practical comparison sections in `src/lib/compare-pages.ts`. Each section links its issuer sources; the visible sources-checked date describes source verification, not human review, an independent audit or live reserve freshness. The first FAQ answer uses the same short-answer copy. Other pairs retain the metadata-derived fallback. Coin-profile comparison lists prioritize these enriched briefs while preserving relative order within both groups.
- Static comparison pages emit route-specific `WebPage` + `ItemList` JSON-LD from `buildStaticComparisonJsonLd(...)`, including the two compared stablecoins as `Thing` nodes and the visible comparison rows as `PropertyValue` items.
- `src/app/sitemap.ts` includes both the `/compare/` hub and `/compare/[slug]/` pair pages. Pair-page `lastModified` uses the newest of the two compared stablecoin detail-page `LAST_EDITED` dates and any editorial `updatedAt`, because dynamic comparison slugs are not generated into `sitemap-dates.json`. Advance editorial `updatedAt` for substantive brief changes, not a build or a source recheck alone.
- `src/app/cemetery/page.tsx` emits `CollectionPage` and `ItemList` JSON-LD for the defunct-stablecoin archive. Dead coins stay `Thing` items rather than fabricated internal detail pages, and each item's `url` is its canonical `/cemetery/#<id>` record anchor, the same URL the RSS feed and the register's "Copy link" publish.

### Selection and URL contract

- Maximum selection: `MAX_COMPARE_COINS = 5`.
- URL is the source of truth for selection state.
- Query param `coins` accepts canonical ticker-issuer IDs only (for example `usdt-tether`). Unknown IDs, legacy DefiLlama/historical IDs, and raw ticker symbols are dropped rather than guessed.
- Query param `range` stores the market-cap chart window. Accepted values are `7d`, `30d`, `90d`, `1y`, and `all`; `all` is the default and is cleared from the URL instead of persisted.
- Static comparison landing pages are generated from `STATIC_COMPARISON_PAGES` in `src/lib/compare-pages.ts` and live at `/compare/<left-id>-vs-<right-id>/`.
- Mobile selection renders selected-coin chips plus one add selector instead of all five selector slots up front. The underlying URL state and five-coin maximum are unchanged; desktop keeps the full slot grid.

Initial load normalizes the `coins` URL param to the accepted canonical ID list. If invalid tokens were present, `useCompareSelection()` rewrites the URL to the surviving canonical IDs or removes `coins` entirely.

### Data dependencies

Compare combines multiple query sources:

- `/api/stablecoins` (`useStablecoins`)
- `/api/peg-summary` (`usePegSummary`)
- `/api/bluechip-ratings` (`useBluechipRatings`)
- `/api/dex-liquidity` (`useDexLiquidity`)
- `/api/report-cards/v9` (`useReportCardsV9`)
- `/api/redemption-backstops` (`useRedemptionBackstops`)
- `/api/yield-rankings` (`useYieldRankings`)
- `/api/stress-signals` (`useStressSignals`)
- `/api/mint-burn-flows` (`useMintBurnFlows`) for the shared flow dataset
- per-coin `/api/supply-history?stablecoin=<id>&days=1825` (via `useQueries`) for long-range supply charts
- per-coin `/api/mint-burn-flows?stablecoin=<id>&hours=<window>` (via `useQueries`) for comparison-specific flow panels

It also derives live peg references with `derivePegRates(...)` for commodity/non-USD normalization in displayed prices.

### Share and export

Compare includes client-side share/export rendering:

- Builds a canvas card via `src/lib/compare-share-image.ts`
- Supports clipboard image copy + Twitter intent flow
- Supports PNG download from the generated canvas
- The share card reads market cap and the 7-day supply change through `getCirculatingRawOrNull()` / `getPrevWeekRawOrNull()`; an unavailable operand renders `—`, never `$0.00` or a fabricated `-100%` change

### Compare table context

`src/components/comparison-table.tsx` presents one horizontally scrollable, sectioned matrix at every viewport size. It groups comparable fields into:

- overview
- peg track record
- Safety Score V9 construction
- exit and DEX liquidity
- issuance activity and yield
- structure, controls, reserves, and regulatory status

The matrix uses the shared contextual methodology labels for Peg Score, Liquidity Score, and Safety. Missing source coverage renders as a dash rather than zero. External Bluechip is the exception, because two different absences would otherwise collapse into one dash: a coin with no rating at all reads "Not rated", a rated coin whose audit flag the source omits reads "audit not reported" beside its grade, and a source that positively reports no audit reads "no audit flag". Directional fields such as issuance flow, supply change, and yield are not styled as universal winners because their desirability depends on the comparison task.

Market cap and the 24h/7d/30d supply-change rows read current supply through `getCirculatingRawOrNull()`. A coin whose current peg buckets are absent, empty or wholly invalid shows a dash for market cap and every supply change: a change is published only when both the current and the previous value are observed (and the previous value is positive), so missing current supply never becomes a `-100%` change. An explicitly observed zero still renders `$0.00` and its real change.

The peg-track-record row `Open recorded incident` reports `activeDepeg` as Yes/No (or a dash when the peg-summary row is missing). No means only that no recorded incident is open, never that the asset is currently at peg. This remains true for NAV tokens, unusable prices/references, and assets below event-collection coverage; current deviation is a separate measurement.

## Operational notes

- Both pages are part of static export and rely on client-side fetches where applicable.
- Cemetery reliability depends on repository data curation (`shared/data/dead-stablecoins.json` via `shared/lib/dead-stablecoins.ts`).
- Cemetery Telegram notifications depend on the daily Telegram digest post plus `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; additions are detected from the repo dataset, not from a separate API feed.
- Compare reliability depends on the eight core global datasets listed above plus the aggregate mint/burn dataset and per-coin supply-history and flow queries. The blocking global error and stale notices cover the eight core sources; aggregate flow has no dedicated global notice today. Per-coin flow panels degrade by omission unless all selected flow queries fail, in which case the page shows a flow-specific error notice.
