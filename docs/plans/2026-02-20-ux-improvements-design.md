# UX Improvements Design — Pharos Dashboard

**Date:** 2026-02-20
**Scope:** 6 features across homepage, comparison, cemetery, and performance
**Implementation:** None in this session — design only

---

## Overview

Six improvements to make Pharos more engaging, dynamic, and compelling — organized from highest to lowest impact-to-effort ratio. Each section is self-contained and can be implemented independently.

---

## 1. Market Pulse — Homepage Hero Redesign

**Replaces:** The current 4-card `CategoryStats` grid (Total Tracked, By Governance, Dominance, Alt-Peg) and the static intro text block.

**Goal:** A returning user should instantly see *what changed* since their last visit, not the same structural overview every time.

### 1a. Collapsible Intro

The current intro block (title + subtitle + description paragraph, ~100px) becomes collapsible:

- **First visit** (no `localStorage` flag): Full intro visible — title, subtitle, description paragraph. A small "Got it" or collapse chevron sets `pharos-intro-collapsed = true` in localStorage.
- **Returning visits**: Collapsed to a single line: `"Stablecoin Analytics Dashboard"` as an h1, with a subtle expand chevron to re-read the full description. Saves ~70px of vertical space.
- **Implementation note**: The structured data (`ItemList` JSON-LD) in `page.tsx` stays unchanged — it's invisible to users but important for SEO. The collapsing is purely visual via a client component wrapper.

### 1b. Market Pulse Strip

Replaces the 4 `CategoryStats` cards with a unified "Market Pulse" component. Consolidates structural stats (governance split, dominance) with dynamic signals (active depegs, recent events, market delta).

**Layout:** A single responsive card (or borderless section) with 3 zones:

#### Zone 1: Key Numbers (left / top on mobile)
A compact row of the most important metrics:

| Metric | Source | Example |
|--------|--------|---------|
| Total Mcap | `useStablecoins()` → `getCirculatingRaw()` sum | `$312.1B ↑0.18% 7d` |
| Active Depegs | `usePegSummary()` → coins where `currentDeviationBps` exceeds threshold | `2 depegged` (red if >0) |
| 24h Freezes | `useBlacklistEvents()` → count where timestamp > now-24h | `3 freezes` |
| CeFi Dominance | Existing governance calculation | `91.6% CeFi` |

This replaces the "Total Tracked" and "By Governance" cards. The exact numbers that currently live there (count, CeFi/CeFi-Dep/DeFi split with mcap, governance bar) move into a hover/expandable detail or remain as secondary text under the key numbers.

#### Zone 2: Movers & Signals (center)
Dynamic signals that change throughout the day:

| Signal | Source | Example |
|--------|--------|---------|
| Biggest Depeg | `usePegSummary()` → worst `currentDeviationBps` | `FDUSD -85bps` (with severity color) |
| Biggest Supply Change (24h) | `useStablecoins()` → max abs delta vs prev day | `USDe ↑$420M` |
| USDT/USDC Dominance | Existing calculation | `USDT $183B · USDC $74B` |

This replaces the "All Stablecoin Dominance" and parts of "Market Highlights" cards.

#### Zone 3: Recent Activity Ticker (right / bottom on mobile)
Last 2-3 events across all event types, most recent first:

- `"USDT froze 0x1a2b...3c4d on Ethereum — 2h ago"`
- `"FDUSD depegged -85bps — 30min ago"`
- `"EURC supply +$12M — 1h ago"`

**Data sources:** Combines `useBlacklistEvents()`, `usePegSummary()` (active depegs), and `useStablecoins()` (supply deltas). All data already fetched on the homepage — no new API calls needed.

**Mobile layout:** Zones stack vertically: numbers → signals → ticker. Each zone is a compact horizontal row or small card.

**What happens to the existing data?**
- Governance split (CeFi/Dep/DeFi bar + percentages): Becomes a hoverable/expandable detail under the CeFi Dominance number, or moves to a "Market Structure" section further down the page.
- Alt-Peg breakdown (Gold/Euro/Ruble): Moves to a section near the Peg Diversity Chart (which already covers this topic).
- USDT/USDC/Others with 7d % changes: Integrated into Zone 2.

### Files to modify
- `src/app/page.tsx` — wrap intro in collapsible client component
- `src/components/category-stats.tsx` — replace entirely with new `MarketPulse` component
- `src/components/homepage-client.tsx` — swap `<CategoryStats>` for `<MarketPulse>`
- New: `src/components/market-pulse.tsx`

### Complexity: Medium
No new API calls. All data already available. Main work is designing the responsive layout and deciding exact information hierarchy. The collapsible intro is trivially a `useState` + `localStorage` check.

---

## 2. Daily Digest — LLM-Generated Editorial Summary

**Position:** A standalone card immediately below the Market Pulse, above the charts.

**Goal:** A natural-language summary of what happened in the last 24 hours, written in an editorial/newsletter tone. Makes the dashboard feel alive and authored, not just a data grid.

### Tone & Style

Personality-driven, slightly opinionated:

> *"A quiet day for stablecoins — total market cap climbed past $312B while FDUSD wobbled briefly to -85bps before recovering. Tether froze two addresses on Ethereum, both flagged for OFAC compliance. The only real action was USDe's supply surge, adding $420M in 24 hours."*

When nothing notable happened:

> *"A remarkably uneventful 24 hours in stablecoin land. All 132 tracked coins holding their pegs, no new freezes, and market cap drifted up a lazy 0.04%. Enjoy the calm."*

### Generation Pipeline

**Worker-side (Cloudflare Worker cron):**

1. A new cron job (piggyback on an existing 5-minute slot with a minute check, e.g., run at minute 0 of each hour) collects structured data:
   - Total mcap + 24h delta
   - Count of active depegs + worst deviation
   - Count of freeze events in last 24h
   - Biggest supply change (24h, absolute)
   - Any notable peg recovery events
   - Death count change (if a new coin was added to cemetery — rare)

2. Structured data is passed to Claude API (`claude-haiku-4-5` for cost efficiency) with a system prompt defining the editorial voice. Prompt includes:
   - Factual data payload (JSON)
   - Tone guidelines: concise, slightly editorial, never alarmist, factual
   - Length constraint: 2-4 sentences max
   - No emojis, no clickbait

3. Generated text cached in D1 table:
   ```sql
   CREATE TABLE daily_digest (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     generated_at INTEGER NOT NULL,
     digest_text TEXT NOT NULL,
     input_data TEXT NOT NULL  -- JSON of the structured data used
   );
   ```
   Only regenerate if the latest row is >1 hour old. Keep 7 days of history.

4. **Cost:** ~$0.001-0.003 per generation (Haiku). At 24 generations/day = ~$0.05/day = ~$1.50/month.

**API endpoint:** New `/api/daily-digest` endpoint returns the latest digest text + generation timestamp.

**Frontend:**

- New hook: `useDailyDigest()` with `staleTime: 60 * 60 * 1000` (1 hour).
- New component: `DailyDigest` card — editorial styling, perhaps with a subtle newspaper-column feel. Muted border, slightly different typography (serif accent for the digest text? or italic?). Shows the generated timestamp as "Updated 2h ago".
- Skeleton: 3 lines of varying width.

### Fallback

If the Claude API call fails or the digest is missing, the card simply doesn't render. No placeholder text — the page works fine without it.

### Files to create/modify
- New: `worker/src/cron/daily-digest.ts` — structured data collection + Claude API call
- New: `worker/src/api/daily-digest.ts` — GET endpoint
- New: `src/hooks/use-daily-digest.ts` — TanStack Query hook
- New: `src/components/daily-digest.tsx` — card component
- Modify: `src/components/homepage-client.tsx` — add `<DailyDigest />` below Market Pulse
- Modify: `worker/wrangler.toml` — add `ANTHROPIC_API_KEY` secret
- New: D1 migration for `daily_digest` table

### Complexity: Medium-High
The structured data collection is straightforward (all queries already exist). The Claude API integration is new infrastructure but simple. The main risk is prompt engineering for consistently good editorial output — expect iteration.

---

## 3. Stablecoin Comparison Page

**Route:** `/compare/`
**Entry:** Dedicated page with coin selectors. URL-shareable: `/compare/?coins=usdt,usdc,dai`

### Coin Selection

- Top of page: a row of 2-3 coin selector slots (max 3 for layout sanity).
- Each slot: a search input (combobox) that filters the tracked stablecoin list by name/symbol. Shows logo + name + symbol in the dropdown. Selecting a coin fills the slot.
- Empty slots show "Add stablecoin..." placeholder.
- Remove button (X) on each filled slot.
- URL updates as coins are selected: `?coins=usdt,usdc,dai` (uses symbol, lowercased).

### Comparison Layout

A vertical stack of comparison sections, each showing the selected coins side-by-side:

#### Section 1: Vital Stats Table

A comparison table (coins as columns, metrics as rows):

| Metric | USDT | USDC | DAI |
|--------|------|------|-----|
| Price | $1.0001 | $0.9998 | $1.0003 |
| Peg Score | 97 | 98 | 92 |
| Market Cap | $183B | $74B | $5.2B |
| 24h Change | +0.01% | -0.02% | +0.15% |
| 7d Change | +0.7% | +1.0% | +2.1% |
| Liquidity Score | 95 | 88 | 72 |
| Governance | CeFi | CeFi | DeFi |
| Backing | RWA | RWA | Crypto |
| Peg Currency | USD | USD | USD |
| Bluechip Rating | A+ | A | B |
| Chains | 12 | 8 | 4 |

Color-code the "best" value in each row (highest peg score = green, lowest deviation = green, etc.).

#### Section 2: Overlaid Supply Chart

A single Recharts area chart with one series per selected coin. Different colors per coin. Time range selector (7d/30d/90d/1y/all).

- **Data source:** `useSupplyHistory(id)` for each selected coin.
- **Normalization toggle:** Option to normalize to 100 at the start of the period (indexed view) for comparing growth rates when absolute values differ wildly (e.g., USDT $183B vs DAI $5B).

#### Section 3: Overlaid Peg Deviation Chart

A line chart showing peg deviation (in bps) over time for each coin, overlaid.

- **Data source:** `useDepegEvents()` per coin, or derive from `usePegSummary()` if it contains historical deviation snapshots.
- **Zero line** highlighted — deviations above/below clearly visible.
- Time range selector.

### Data Requirements

All data already available from existing hooks/endpoints:
- `useStablecoins()` — current price, mcap, supply, chains
- `usePegSummary()` — peg scores, current deviation
- `useDexLiquidity()` — liquidity scores
- `useBluechipRatings()` — safety grades
- `useSupplyHistory(id)` — per-coin supply time series
- `useDepegEvents(id)` — per-coin depeg events

No new API endpoints needed. The page just calls existing hooks with per-coin parameters.

### Files to create/modify
- New: `src/app/compare/page.tsx` — server component with metadata
- New: `src/app/compare/client.tsx` — client component with selectors + charts
- New: `src/components/comparison-table.tsx` — vital stats comparison grid
- New: `src/components/comparison-chart.tsx` — overlaid Recharts chart (reusable for supply + deviation)
- Modify: navigation — add "Compare" to nav? Or just link from stablecoin detail pages / table?

### Navigation Decision (to be decided at implementation)
Options:
- **A)** Add to main nav (7th item). Risk: nav gets crowded.
- **B)** Don't add to nav. Discoverable via a "Compare" button on stablecoin detail pages and a link near the homepage table. Less prominent but cleaner nav.
- **C)** Add to nav but as a secondary/utility link (different styling, or in a "Tools" dropdown).

Recommend **B** — keep nav clean, add "Compare with..." buttons on detail pages.

### Complexity: Medium-High
Multiple chart instances with different data. Coin selector combobox needs good search UX. Normalization toggle adds logic. URL state management for coin selection. But no new API work — all data exists.

---

## 4. Cemetery Experience Overhaul

**Route:** `/cemetery/` (existing)
**Goal:** Three enhancements layered onto the existing tombstone grid.

### 4a. Filterable & Sortable Tombstone Grid

Add controls above the tombstone grid:

**Filter chips** (toggle, multi-select):
- By cause: Algorithmic Failure, Counterparty Failure, Liquidity Drain, Regulatory, Abandoned
- Use the existing `CAUSE_META` colors for chip styling.

**Sort dropdown** (single-select):
- Peak Market Cap (default, descending)
- Death Date (newest first / oldest first)
- Alphabetical (A-Z)

**Implementation:** Filter the `DEAD_STABLECOINS` array before passing to the tombstone grid. Sort within the filtered set. The grid re-renders with filtered/sorted tombstones.

**Current state:** The grid is hardcoded to `DEAD_STABLECOINS` order (chronological). The `stagger` and `rotation` are index-based — they'll naturally adjust when the array is filtered/reordered.

### 4b. Interactive Timeline View

A horizontal scrollable timeline as an alternative view to the tombstone grid:

**Toggle:** "Grid View" / "Timeline View" toggle buttons above the display area.

**Timeline layout:**
- Horizontal axis = time (years: 2018 → 2026).
- Each death is a point/node on the timeline, positioned by `deathDate`.
- Node size = peak market cap (same lg/md/sm sizing as tombstones).
- Node color = cause of death.
- Hover on a node shows the same tooltip as the tombstone hover.
- Click navigates to the autopsy card (scroll-to, same as current tombstone click behavior).

**Implementation:** A horizontally scrollable `div` with absolutely-positioned nodes. Year markers as vertical lines. CSS scroll-snap for year boundaries. Mobile: swipe to scroll.

**Data:** Pure client-side from `DEAD_STABLECOINS`. No API calls.

### 4c. Autopsy Reports (Expanded Story Cards)

Enhance the existing `StablecoinCemetery` obituary cards (the table/list below the tombstones):

Currently, clicking a tombstone scrolls to and highlights the corresponding row in the obituary table. Enhance this into a richer "autopsy report" card:

**Card contents:**
- **Header:** Logo + Name + Symbol + Death Date
- **Cause of Death** badge (colored)
- **Obituary** (existing `obituary` field — already well-written editorial text)
- **Key Facts** grid:
  - Peak Market Cap: `$X`
  - Peg Currency: `USD` / `EUR` / etc.
  - Lifespan: computed from first appearance to death date (if available)
  - Source link (existing `sourceUrl` + `sourceLabel`)
- **Optional "What killed it" tag line** — a one-liner extracted from the obituary or a new field in `DeadStablecoin` type.

**Expand/collapse:** Cards are collapsed by default (show logo, name, cause, peak mcap on one line). Click or tombstone-click expands to the full autopsy report. This replaces the current scroll-and-highlight behavior with something more structured.

### Files to modify
- `src/components/cemetery-tombstones.tsx` — add filter/sort state + controls, pass filtered array to grid
- `src/components/stablecoin-cemetery.tsx` — upgrade obituary cards to autopsy reports with expand/collapse
- New: `src/components/cemetery-timeline.tsx` — timeline view component
- `src/app/cemetery/page.tsx` — add view toggle state, render either grid or timeline
- Possibly `src/lib/types.ts` — add optional fields to `DeadStablecoin` if needed (lifespan, tagline)

### Complexity: Medium-High
The filter/sort is easy (4a). The timeline (4b) requires careful positioning math and responsive handling. The autopsy cards (4c) are mostly restructuring existing content. Total: a solid chunk of work but no API changes.

---

## 5. Skeleton-to-Content Transitions (Polish)

**Goal:** Eliminate layout shift when data loads, and add smooth content reveal.

### What to fix

Currently, skeleton placeholders may not match the exact dimensions of loaded content, causing elements to "jump" when data arrives. Additionally, the transition from skeleton to content is instantaneous (hard swap).

### Approach

**A) Dimension-matched skeletons:**
- Audit each skeleton usage (category stats, tables, charts) and ensure the skeleton dimensions match the loaded content.
- For dynamic content (variable-length text, variable row counts): use the most common case as the skeleton size. Accept minor shifts for outlier cases.

**B) Fade-in transition:**
- Wrap data-loaded content in a `<div className="animate-in fade-in duration-300">` (Tailwind animation utility).
- The skeleton fades out and the real content fades in, preventing the visual "pop."
- Use Tailwind's `animate-in` from `tailwindcss-animate` (already a dependency via shadcn).

### Key locations
- `src/components/category-stats.tsx` (or its Market Pulse replacement) — 4-card skeleton
- `src/components/stablecoin-table.tsx` — table row skeletons
- `src/components/peg-heatmap.tsx` — tile grid skeleton
- `src/components/liquidity-table.tsx` — table row skeletons
- `src/components/total-mcap-chart.tsx` — chart skeleton
- Any other component with a loading branch

### Complexity: Low
CSS-only changes + minor skeleton dimension adjustments. Can be done incrementally, one component at a time.

---

## 6. Prefetch on Hover

**Goal:** When hovering a stablecoin link (in any table or the heatmap), prefetch that coin's detail page data so navigation feels instant.

### Approach

**TanStack Query `prefetchQuery`:**

```typescript
// In a shared utility or hook
function usePrefetchStablecoin() {
  const queryClient = useQueryClient();

  return useCallback((coinId: string) => {
    // Prefetch the data that the detail page needs
    queryClient.prefetchQuery({
      queryKey: ["supply-history", coinId],
      queryFn: () => fetchSupplyHistory(coinId),
      staleTime: 60 * 60 * 1000, // 1 hour
    });
    queryClient.prefetchQuery({
      queryKey: ["depeg-events", coinId],
      queryFn: () => fetchDepegEvents(coinId),
      staleTime: CRON_5MIN,
    });
    queryClient.prefetchQuery({
      queryKey: ["dex-liquidity-history", coinId],
      queryFn: () => fetchDexLiquidityHistory(coinId),
      staleTime: 60 * 60 * 1000,
    });
  }, [queryClient]);
}
```

**Usage in components:**

Any component that renders a link to `/stablecoin/[id]/` adds an `onMouseEnter` handler:

```tsx
<Link
  href={`/stablecoin/${coin.id}/`}
  onMouseEnter={() => prefetch(coin.id)}
>
  {coin.name}
</Link>
```

**Scope:** Coin links only (per user preference). Not nav items, not viewport-proximity.

**Debounce:** Add a 100ms debounce to avoid firing on casual mouse sweeps across a table. Only prefetch if the hover persists.

**Dedup:** TanStack Query handles dedup automatically — if the data is already cached, `prefetchQuery` is a no-op.

### Key locations to add hover prefetch
- `src/components/stablecoin-table.tsx` — coin name links in the main table
- `src/components/peg-heatmap.tsx` — heatmap tiles (if they become clickable links, see note)
- `src/components/peg-leaderboard.tsx` — coin name links
- `src/components/liquidity-table.tsx` — coin name links
- `src/components/depeg-feed.tsx` — event links

### Note on heatmap tiles
The peg heatmap tiles are currently display-only. Making them link to `/stablecoin/[id]/` is a trivial change (wrap the tile `div` in a `<Link>`) and was one of the "very low complexity" ideas from the brainstorm. It should be implemented alongside or before this prefetch work, since prefetch on hover for heatmap tiles only makes sense if they're clickable.

### Complexity: Low
TanStack Query handles all the hard parts (caching, dedup, background fetch). Main work is creating the shared prefetch utility and adding `onMouseEnter` to ~5 components.

---

## Implementation Priority

Recommended order (can be done independently, but this sequence builds well):

| Order | Feature | Complexity | Impact | Dependencies |
|-------|---------|------------|--------|--------------|
| 1 | **Skeleton transitions** (#5) | Low | Medium | None — pure polish, do first |
| 2 | **Prefetch on hover** (#6) | Low | Medium | None — also heatmap clickability |
| 3 | **Market Pulse** (#1) | Medium | High | None |
| 4 | **Daily Digest** (#2) | Medium-High | High | Market Pulse should land first (digest sits below it) |
| 5 | **Cemetery overhaul** (#4) | Medium-High | Medium | None — independent of other features |
| 6 | **Comparison page** (#3) | Medium-High | High | None — but most work, save for last |

### Quick Wins to Bundle Early
These trivial improvements from the original brainstorm should be done alongside the first batch:
- **Clickable heatmap tiles** → wrap in `<Link>` (5 minutes of work, enables prefetch)
- **Clickable table rows** → add `onClick` + `cursor-pointer` to stablecoin table rows (10 minutes)
- **Share URL button** → copy-to-clipboard for current filter state (already in URL params)
