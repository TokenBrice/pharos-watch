# Pre-Launch Stablecoins

Introduce a "pre-launch" lifecycle stage for stablecoins. Pre-launch coins get a dedicated detail page with curated static content but no worker processing. A homepage module surfaces them to visitors.

## Context

Pharos currently has two states for a stablecoin: alive (in `TRACKED_STABLECOINS`, processed by all crons) or dead (in `DEAD_STABLECOINS`, displayed in the cemetery). There is no way to represent a stablecoin that has been announced but is not yet live — or is too early to justify full tracking.

The pre-launch stage fills this gap. It lets Pharos showcase upcoming stablecoins with curated editorial content before committing worker resources to them.

## Data Model

### New fields on `StablecoinMeta`

```ts
// shared/types/core.ts
status?: "pre-launch" | "active";       // defaults to "active"
announcedDate?: string;                // "YYYY-MM", pre-launch only
expectedLaunchDate?: string;            // "YYYY-MM" or "YYYY-QN", pre-launch only
launchPhase?: LaunchPhase;             // pre-launch only
launchPhaseDetail?: string;            // optional free-text context for launchPhase

type LaunchPhase = "announced" | "testnet" | "auditing" | "beta" | "launching-soon";
```

`status` is optional. Omitting it (or setting it to `"active"`) means the coin behaves exactly as today. Only coins explicitly marked `"pre-launch"` get the new treatment. `announcedDate`, `expectedLaunchDate`, `launchPhase`, and `launchPhaseDetail` are only meaningful for pre-launch coins and should be removed on promotion.

`launchPhase` provides a structured badge for consistent display across the homepage cards and detail page. `launchPhaseDetail` is an optional free-text string for specifics (e.g., "Live on Sepolia since Feb 2026", "Audited by Trail of Bits").

### Derived lists in `shared/lib/stablecoins/index.ts`

```ts
export const ACTIVE_STABLECOINS = TRACKED_STABLECOINS.filter(
  (c) => c.status !== "pre-launch"
);
export const ACTIVE_IDS = new Set(ACTIVE_STABLECOINS.map((c) => c.id));
export const ACTIVE_META_BY_ID = new Map(ACTIVE_STABLECOINS.map((c) => [c.id, c]));

export const PRE_LAUNCH_STABLECOINS = TRACKED_STABLECOINS.filter(
  (c) => c.status === "pre-launch"
);
```

`TRACKED_STABLECOINS`, `TRACKED_IDS`, and `TRACKED_META_BY_ID` remain unchanged — they include both active and pre-launch coins.

### Factory helper update

Add `status`, `announcedDate`, `expectedLaunchDate`, `launchPhase`, and `launchPhaseDetail` to `StablecoinOpts` in `shared/lib/stablecoins/factory.ts`, and spread them into the returned `StablecoinMeta` object. No new factory function needed.

### Pre-launch coin definition

Pre-launch coins are defined alongside active coins in the same category arrays (`USD_MAJOR_COINS`, `USD_MINOR_COINS`, etc.) using the existing `coin()`/`usd()`/`eur()` helpers with the additional opts:

```ts
usd("xyz-dollar", "XYZ Dollar", "XYZD", "rwa-backed", "centralized", {
  status: "pre-launch",
  announcedDate: "2026-01",
  expectedLaunchDate: "2026-Q3",
  launchPhase: "testnet",
  launchPhaseDetail: "Live on Sepolia since Feb 2026",
  jurisdiction: "US",
  links: [
    { label: "Website", url: "https://example.com" },
    { label: "Docs", url: "https://docs.example.com" },
    { label: "Twitter", url: "https://x.com/example" },
  ],
}),
```

Minimal required fields for a pre-launch coin: `id`, `name`, `symbol`, `backing`, `governance`, `pegCurrency`, `status: "pre-launch"`, and at least one link. Everything else is optional and can be populated as information becomes available.

### Logos

Pre-launch coin logos follow the existing pattern: image files in `public/logos/`, keyed by coin ID in `data/logos.json`. For coins that have a publicly available logo, download and add it. For coins without a logo yet, no entry is needed — `StablecoinLogo` already renders a first-letter fallback circle.

### Editorial summary storage

Pre-launch coin summaries use the existing `data/ai-summaries.json` file, keyed by coin ID — the same mechanism used for active coin summaries. The homepage card teaser is the first ~100 characters of this summary. If no summary exists for a pre-launch coin, the editorial summary section is omitted from the detail page and the card shows no teaser.

### Initial data seeding

The user will provide an initial list of pre-launch coins at implementation time with: ticker, Twitter link, official website, expected launch date, and docs URL (if available). These will be added to the appropriate category arrays. Editorial summaries will be written for each coin and added to `data/ai-summaries.json`.

## Worker Changes

All cron jobs switch from `TRACKED_STABLECOINS` to `ACTIVE_STABLECOINS` (or from `TRACKED_IDS` to `ACTIVE_IDS`). This is a one-line import change per cron file. Pre-launch coins are never processed by any worker job.

The implementation must grep all files under `worker/src/` (crons, API handlers, and lib) for imports of `TRACKED_STABLECOINS`, `TRACKED_IDS`, and `TRACKED_META_BY_ID` and evaluate each usage. Most will switch to `ACTIVE_STABLECOINS` / `ACTIVE_IDS` / `ACTIVE_META_BY_ID`. Some may legitimately need the full list (e.g., a lookup that resolves metadata for any coin, including pre-launch). Each usage must be assessed individually.

## Pre-Launch Detail Page

### Route

Same route as active coins: `/stablecoin/[id]`. The page component checks `meta.status` and renders a distinct layout for pre-launch coins.

`generateStaticParams()` already iterates `TRACKED_STABLECOINS`, which includes pre-launch coins. No change needed for static generation.

### Layout (top to bottom)

1. **Pre-Launch Banner** — Full-width, purple/indigo accent. Text: "Pre-Launch — Not yet tracked by Pharos". Displays the `launchPhase` as a badge (e.g., "Testnet") and `launchPhaseDetail` as secondary text if present.

2. **Header** — Name, symbol, peg currency, classification badges (backing, governance). Same style as active coin headers but without price/supply stats.

3. **Launch Timeline** — Horizontal progress bar from announcement date to expected launch date, with a "Today" marker positioned proportionally. Left anchor: "Announced" + `announcedDate`. Right anchor: "Expected Launch" + `expectedLaunchDate`. The progress fill uses the Pharos purple/indigo gradient. For quarter-based launch dates, use the start of the quarter as the target (Q2 → April 1). If `announcedDate` is missing, omit the timeline and fall back to a simple "Expected Launch: Q2 2026" label.

4. **Editorial Summary** — Hand-written overview. Front and center — this is the primary content.

5. **At a Glance Grid** — Responsive grid of classification cards:
   - Backing type
   - Governance model
   - Jurisdiction (if known)
   - Peg currency
   - Yield-bearing (if applicable)

6. **Reserve/Collateral Design** — If `reserves[]` is populated, show intended collateral composition with a "Planned" qualifier. Uses existing reserve display components.

7. **Target Chains** — From `contracts[]` if known. Chain icon list.

8. **Links & Resources** — Website, whitepaper, docs, socials. Reuses existing link component.

9. **Related Stablecoins** — "Similar tracked stablecoins" using existing similarity logic (backing, governance, peg), filtered to `ACTIVE_STABLECOINS` only. Links to active coins with live data. Provides useful outbound navigation.

### What is NOT shown

No supply chart, price data, peg history, depeg events, liquidity metrics, report card, safety score, or any worker-derived data. These sections are completely absent (not shown as empty placeholders).

## Homepage Module

### Placement

After the "Browse by peg" block, before the next existing section.

### Visibility

The entire section is conditionally rendered. If `PRE_LAUNCH_STABLECOINS` is empty, nothing is shown — no empty state.

### Section header

"Upcoming Stablecoins" with a count badge (e.g., "3") on the right side of the heading.

### Card layout

- Desktop: responsive grid, 3-4 columns
- Mobile: horizontally scrollable row
- Typically 2-5 cards, but must handle more gracefully (grid wraps to additional rows)

### Card contents

Each card contains:
- Coin logo placeholder (or actual logo if available) + name + symbol
- Peg currency
- Classification badges (backing type, governance model)
- Launch phase badge (e.g., "Testnet", "Beta", "Announced")
- One-line teaser (~100 chars from editorial summary)
- Expected launch date
- Entire card is clickable → `/stablecoin/[id]`

### Data source

`PRE_LAUNCH_STABLECOINS` from `shared/lib/stablecoins` — static build-time data, no API call.

## Search Integration

Pre-launch coins appear in global search results with a "Pre-launch" badge. Clicking navigates to their detail page. The search already indexes `TRACKED_STABLECOINS` metadata, so pre-launch coins are included automatically. Only visual change: add a badge when `status === "pre-launch"`.

## Exclusions

Pre-launch coins are excluded from all data-driven features. Every consumer of the stablecoin list must use `ACTIVE_STABLECOINS` / `ACTIVE_IDS` instead of the full tracked list:

- KPI bar counts (total stablecoins, total supply)
- Main stablecoin table on homepage
- Filter/category pages (`/stablecoins/[peg]`, `/stablecoins/backing/[backing]`, `/stablecoins/governance/[governance]`)
- Compare tool
- Safety scores, PSI, report cards, stability index
- All charts (total mcap, peg diversity, flows, etc.)
- DEX liquidity, depeg events, digest
- Coverage page
- Homepage footer stats ("Pharos tracks X stablecoins...")
- Peg landing page coin counts (`pegCoinCount()`)
- All worker cron jobs and API handlers

The same grep-and-assess approach from the Worker Changes section applies to frontend files: search all `src/` files for `TRACKED_STABLECOINS` / `TRACKED_IDS` / `TRACKED_META_BY_ID` imports and switch data-driven usages to the `ACTIVE_*` equivalents. Usages that need the full list (e.g., search indexing, `generateStaticParams`, metadata lookup by ID) keep `TRACKED_*`.

The `doc-counts` CI check (`npm run check:doc-counts`) must be updated to account for the active vs. pre-launch distinction.

Not affected: cemetery (separate data structure), about page, methodology page.

## Promotion Workflow

To promote a pre-launch coin to active tracking:

1. Remove `status: "pre-launch"`, `announcedDate`, `expectedLaunchDate`, `launchPhase`, and `launchPhaseDetail` from the coin definition
2. Add worker-specific config as needed (`llamaId`, `geckoId`, full `contracts[]`, `liveReservesConfig`, etc.)
3. Deploy

The detail page automatically switches to the full active layout. The homepage card disappears. Workers begin processing on the next cron cycle.

## Summary

| Concern | Approach |
|---|---|
| Data model | `status` + `announcedDate` + `expectedLaunchDate` + `launchPhase` / `launchPhaseDetail` on `StablecoinMeta` |
| Shared helpers | `ACTIVE_STABLECOINS`, `ACTIVE_IDS`, `PRE_LAUNCH_STABLECOINS` derived lists |
| Workers | All crons switch to `ACTIVE_STABLECOINS` |
| Detail page | Purpose-built pre-launch layout, same route |
| Homepage | Card section after "Browse by peg" |
| Search | Included with "Pre-launch" badge |
| Data-driven features | All excluded via `ACTIVE_STABLECOINS` |
| Promotion | Remove status, add worker config, deploy |
