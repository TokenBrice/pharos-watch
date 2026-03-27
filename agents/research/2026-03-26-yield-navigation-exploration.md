# Yield Navigation Exploration

Date: 2026-03-26
Scope: Explore the main UX patterns that would let users navigate the growing per-stablecoin yield-source set, with special focus on the coin-first question: "what are the yield sources for this stablecoin?"

## Inputs Reviewed

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `docs/yield-intelligence.md`
- `docs/stablecoin-detail-page.md`
- `docs/design-context.md`
- `docs/design-language.md`
- `docs/design-tokens.md`
- `src/app/yield/client.tsx`
- `src/components/yield-leaderboard.tsx`
- `src/components/yield-detail-section.tsx`
- `src/components/yield-history-chart.tsx`
- `shared/types/yield.ts`
- `worker/src/api/cache-handlers.ts`
- `worker/src/api/yield-history.ts`
- `agents/audits/2026-03-26-yield-intelligence-comprehensive-audit.md`

Also checked the live `https://api.pharos.watch/api/yield-rankings` payload on 2026-03-26 to understand the current source-count distribution.

## Current Product Read

The data model is already richer than the navigation model.

What the backend and shared types already support:

- one best source per ranking
- `altSources[]` per stablecoin
- source provenance, freshness, selection reason, and source-switch state
- source-specific history via `GET /api/yield-history?sourceKey=...`
- chart-level source switching

What the UI currently emphasizes instead:

- a coin leaderboard
- a single selected source per row
- small alternative-source disclosure
- source-aware history only after the user expands a row or reaches the detail-page yield section

That means the product can answer "what sources exist for this coin?" technically, but the navigation path is indirect.

## Current Discoverability Gaps

### 1. `/yield` is still leaderboard-first, not explorer-first

`src/app/yield/client.tsx` filters only by peg universe and then hands off to the leaderboard. There is no text search, no stablecoin picker, no source/protocol filter, and no alternate browse mode by source family.

Implication:

- if a user starts with a stablecoin in mind, the page does not help them reach it quickly unless they manually scan the table

### 2. Source disclosure is compressed into a small `+N` affordance

`src/components/yield-leaderboard.tsx` shows the chosen source inline, then hides alternatives behind `AltSourcesPopover`, a small popover opened from a `+N` chip.

Implication:

- this works for 1 to 3 alternatives
- it stops being a usable navigation pattern once a coin has a long source tail
- it is weak on mobile and poor for deliberate comparison

### 3. The best source-history control arrives late in the journey

`src/components/yield-history-chart.tsx` already supports source-specific history through a `History` source selector, but the control only appears after the user has already opened the chart.

Implication:

- the most powerful source-navigation control exists, but too deep in the flow

### 4. Stablecoin detail pages expose sources, but only inside the yield section

`src/components/yield-detail-section.tsx` does show the primary source, alternative sources, and a source-selectable history chart, but the user has to navigate to the coin page and then reach the yield section.

Implication:

- discoverability is acceptable for users already doing deep single-coin research
- it is weak for users who begin on the yield page and want a fast answer

## Dataset Shape Matters

Live payload check on 2026-03-26:

- `89` ranking rows
- `39` rows with at least one alternative source (`43.8%`)
- average source count per ranking: `3.55`
- `27` rows with `3+` sources
- `6` rows with `5+` sources

That already argues against keeping alternative sources in a tiny popover.

But there is an important caveat: some current source density is likely pathological, not just rich. The yield audit from 2026-03-26 documents live symbol-collision misattribution, where duplicate-symbol assets can inherit the wrong protocol-native or discovered sources. The live payload currently includes extreme outliers such as USDC and USDT with very large alternative-source counts, which are not realistic as a raw end-user disclosure shape.

Design consequence:

- the UI should not assume every raw source row deserves equal display weight
- navigation should prefer grouping and hierarchy over dumping a flat list
- source-browser work should ideally land alongside identity cleanup

## Main Navigation Patterns

### 1. Coin-First Source Explorer

Best for the direct user ask: "show me the yield sources for this stablecoin."

Pattern:

- Add a stablecoin search / combobox at the top of `/yield`
- Let users jump directly to a coin row
- Replace the current `+N` popover with a proper drawer/sheet/panel opened from a "Sources" chip
- Inside that panel, show:
  - selected best source
  - grouped alternative sources
  - APY, TVL, type, data source, freshness
  - source-specific history toggle
  - deep link to the detail page

Why this fits Pharos:

- preserves the current yield page as the main entry surface
- keeps the UI data-dense without turning the table into noise
- uses progressive disclosure instead of overloading the main row

Why this is the highest-value first move:

- directly solves the current coin-first navigation gap
- reuses existing ranking and history infrastructure
- scales better than more columns or bigger popovers

### 2. Detail-Page Source Navigator

Best for users already in dossier mode.

Pattern:

- Promote source count higher in the yield section header or even the hero secondary metrics
- Turn the current alternative-source grid into a more intentional source table
- Keep the source selector visible above the history chart, not only inside chart controls
- Allow deep linking to a specific source state on the detail page

Useful additions:

- `Sources (4)` chip near the section title
- sortable compact table of sources
- source row click updates the chart below
- explicit grouping: `Primary`, `Alternatives`, `Derived / fallback`

Why this matters:

- the detail page is already positioned as the research dossier
- it is the right place for provenance-heavy source exploration once the user has chosen a coin

### 3. Source-First Protocol Browser

Best for users who think in protocols or venues rather than tokens.

Pattern:

- Add a second browse mode on `/yield`: `By coin` / `By source`
- Group rows by protocol family or normalized source family, not raw source string
- Example groups: `Morpho`, `Pendle`, `Aave`, `Beefy`, `Native savings`, `Rate-derived`, `Price-derived`

Each source-family card or row would show:

- number of covered stablecoins
- total / median TVL
- top APY
- linked stablecoins using that source family

Why this matters:

- once source counts grow, users will want to answer "what can I earn via Morpho?" as often as "what can USDC earn?"
- this also helps compress the noisy long tail into a smaller, more legible information architecture

### 4. Embedded Two-Level Table Rows

This is a lighter-weight alternative if a new drawer feels too big.

Pattern:

- keep one summary row per stablecoin
- expand into a second-level source table directly below that row
- include source-specific history buttons per source row

This is better than the current popover, but weaker than a source explorer panel because:

- large source sets will make the table very tall
- mobile interaction will still be awkward
- it is harder to preserve focus and context

## Recommended Direction

Recommendation: build a hybrid of Pattern 1 and Pattern 2 first, then add Pattern 3 once the source taxonomy is cleaner.

### Recommended Phase 1

On `/yield`:

- add stablecoin search / picker
- add a dedicated `Sources` column or source-count chip
- open a source explorer panel instead of the `+N` popover

On `/stablecoin/[id]`:

- promote the source count higher in the yield section
- make source switching feel like a first-class control, not just a chart-local select

Why this first:

- highest user value
- smallest IA change
- minimal new backend surface area
- leverages existing source-specific history endpoint

### Recommended Phase 2

Add `By source` browse mode to `/yield`, grouped by normalized protocol/source families.

This should happen after or alongside source normalization work, otherwise the browser will inherit the current raw-string mess.

## UX Rules To Preserve

To fit the existing design system and Pharos product posture:

- keep the main table dense and scan-friendly
- avoid giant modals with marketing-style empty space
- use progressive disclosure for provenance and chart controls
- keep semantic color tied to warnings, switches, and risk signals
- use grouping and sorting, not long unstructured source lists

## What Not To Do

### Do not just add more columns

The current issue is navigability, not lack of raw data on the row. More columns would hurt scanability and still not solve source exploration.

### Do not keep scaling the `+N` popover

That interaction is already too small for the long-tail case.

### Do not expose raw source strings as the primary browse taxonomy

The current data is too heterogeneous and, in some cases, still too collision-prone. Users need a normalized source-family layer.

## Proposed Rollout Order

1. Clean up source identity / grouping enough to avoid pathological long tails dominating the UX.
2. Add stablecoin search plus a real source explorer panel on `/yield`.
3. Upgrade the detail-page yield section from "source summary" to "source navigator."
4. Add `By source` browse mode once protocol/source-family normalization is trustworthy.

## Bottom Line

The main product gap is not missing yield data. It is that the UI still treats yield as a ranked coin list when the underlying model has become a many-sources-per-coin graph.

The best first move is a coin-first source explorer:

- search for a stablecoin
- open all of its sources in one panel
- switch the chart by source
- then continue to the full detail page if needed

That solves the immediate user ask without requiring a brand-new route, and it fits the current Pharos architecture much better than a flat mega-table of source rows.
