# Pre-Launch Stablecoins Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "pre-launch" lifecycle stage for stablecoins with dedicated detail pages, a homepage module, and worker exclusions.

**Architecture:** New `status` field on `StablecoinMeta` (defaults to `"active"`). Derived `ACTIVE_STABLECOINS` / `PRE_LAUNCH_STABLECOINS` lists filter TRACKED_STABLECOINS. Workers and data-driven UI switch to `ACTIVE_*` lists. Pre-launch coins get a purpose-built detail page with editorial content, timeline, and classification info. A homepage card section surfaces them.

**Tech Stack:** TypeScript, Next.js 16 (static export), React 19, Tailwind CSS v4, shadcn/ui

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `src/components/pre-launch-detail.tsx` | Pre-launch detail page layout (banner, timeline, editorial, at-a-glance grid, reserves, chains, links, related) |
| `src/components/upcoming-stablecoins-section.tsx` | Homepage "Upcoming Stablecoins" card grid |

### Modified files
| File | Change |
|---|---|
| `shared/types/core.ts` | Add `status`, `announcedDate`, `expectedLaunchDate`, `launchPhase`, `launchPhaseDetail`, `LaunchPhase` type |
| `shared/lib/stablecoins/factory.ts` | Add new fields to `StablecoinOpts` and spread in `coin()` |
| `shared/lib/stablecoins/index.ts` | Add `ACTIVE_STABLECOINS`, `ACTIVE_IDS`, `ACTIVE_META_BY_ID`, `PRE_LAUNCH_STABLECOINS` exports + add 7 pre-launch coin IDs to `CANONICAL_ORDER` |
| `shared/lib/stablecoins/usd-minor.ts` | Add 5 USD pre-launch coin definitions |
| `shared/lib/stablecoins/non-usd.ts` | Add 1 EUR pre-launch coin definition |
| `shared/lib/stablecoins/commodity.ts` | Add 1 GOLD pre-launch coin definition |
| `src/app/stablecoin/[id]/page.tsx` | Conditional render: pre-launch layout vs active layout; filter related coins to active only |
| `src/components/homepage-client.tsx` | Import and render `UpcomingStablecoinsSection`; switch footer stats to `ACTIVE_STABLECOINS` |
| `src/components/command-palette.tsx` | Add "Pre-launch" sublabel for pre-launch coins |
| `src/lib/peg-landing.ts` | Switch `pegCoinCount()` to use `ACTIVE_STABLECOINS`; keep `ACTIVE_PEGS` on `TRACKED_STABLECOINS` |
| `src/components/stablecoin-table-logic.ts` | Switch to `ACTIVE_STABLECOINS` / `ACTIVE_IDS` |
| `src/components/category-stats.tsx` | Switch to `ACTIVE_IDS` / `ACTIVE_META_BY_ID` |
| `src/components/market-highlights.tsx` | Switch to `ACTIVE_IDS` / `ACTIVE_META_BY_ID` |
| `src/app/page.tsx` | Switch `TRACKED_STABLECOINS` to `ACTIVE_STABLECOINS` for count/itemList |
| `src/app/layout.tsx` | Switch `TRACKED_STABLECOINS.length` to `ACTIVE_STABLECOINS.length` in siteDescription |
| `src/app/stablecoins/[peg]/page.tsx` | Switch `TRACKED_STABLECOINS` to `ACTIVE_STABLECOINS` for coin filter |
| `src/lib/stablecoin-taxonomy.ts` | Switch `TRACKED_STABLECOINS` to `ACTIVE_STABLECOINS` |
| `src/lib/compare-config.ts` | Switch to `ACTIVE_STABLECOINS` |
| `src/app/coverage/page.tsx` | Switch `TRACKED_STABLECOINS.length` to `ACTIVE_STABLECOINS.length` |
| `src/app/about/page.tsx` | Switch `TRACKED_STABLECOINS.length` to `ACTIVE_STABLECOINS.length` |
| `src/app/liquidity/page.tsx` | Switch `TRACKED_STABLECOINS.length` to `ACTIVE_STABLECOINS.length` |
| `src/app/liquidity/client.tsx` | Switch `TRACKED_STABLECOINS` to `ACTIVE_STABLECOINS` |
| `src/app/depeg/page.tsx` | Switch `TRACKED_STABLECOINS.length` to `ACTIVE_STABLECOINS.length` |
| `src/app/compare/page.tsx` | Switch `TRACKED_STABLECOINS.length` to `ACTIVE_STABLECOINS.length` |
| `src/app/portfolio/client.tsx` | Switch `TRACKED_STABLECOINS` to `ACTIVE_STABLECOINS` |
| `src/lib/start-here-content.ts` | Switch `TRACKED_STABLECOINS.length` to `ACTIVE_STABLECOINS.length` |
| `src/hooks/use-stress-test.ts` | Switch `TRACKED_STABLECOINS` to `ACTIVE_STABLECOINS` |
| `src/hooks/use-coverage-matrix-model.ts` | Switch to `ACTIVE_STABLECOINS` / `ACTIVE_META_BY_ID` |
| `src/lib/contagion-layout.ts` | Switch `TRACKED_STABLECOINS` to `ACTIVE_STABLECOINS` |
| `src/lib/portfolio-analysis.ts` | Switch `TRACKED_STABLECOINS` to `ACTIVE_STABLECOINS` |
| `src/lib/stablecoin-url-codec.ts` | Switch `TRACKED_STABLECOINS` to `ACTIVE_STABLECOINS` |
| `shared/lib/classification.ts` | Switch `TRACKED_STABLECOINS` to `ACTIVE_STABLECOINS` |
| Worker cron files (12 files) | Switch data-processing iterations to `ACTIVE_STABLECOINS` / `ACTIVE_IDS` |
| Worker API files (5 files) | Switch data-returning endpoints to `ACTIVE_IDS` / `ACTIVE_STABLECOINS` |
| Worker lib files (8 files) | Switch data-processing to `ACTIVE_STABLECOINS` / `ACTIVE_IDS` |
| `scripts/check-doc-counts.mjs` | Count only active coins for doc checks |
| `data/ai-summaries.json` | Add 7 editorial summaries |
| Docs: `CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/report-cards.md`, `docs/supply-snapshot.md` | Update tracked stablecoin counts |

### Files that KEEP `TRACKED_*` (no change needed)
These use `TRACKED_*` for metadata lookup by ID, search indexing, static param generation, or sitemap — all of which should include pre-launch coins:
- `src/app/stablecoin/[id]/page.tsx` — `generateStaticParams()`, `generateMetadata()`, `TRACKED_META_BY_ID.get(id)`
- `src/app/sitemap.ts` — needs all coins in sitemap
- `src/components/command-palette.tsx` — `TRACKED_STABLECOINS` iteration for search (but adds badge)
- `src/lib/peg-landing.ts` — `ACTIVE_PEGS` computation (pre-launch peg pages should exist)
- `src/components/site-header.tsx` — `TRACKED_IDS` for path detection
- `src/components/report-card.tsx` — `TRACKED_STABLECOINS.find()` for dependency name lookup
- `src/components/depeg-history.tsx` — `TRACKED_STABLECOINS.find()` for meta lookup
- Worker: `stablecoin-detail.ts`, `confirm-pending-depegs.ts`, `dispatch-telegram-alerts.ts`, `peg-summary.ts`, `chains.ts`, `feedback.ts`, `audit-depeg-history.ts`, `status-derived-data.ts`, `mint-burn-flows.ts` — all use `TRACKED_META_BY_ID.get()` for lookups
- Worker: `price-validation.ts`, `authoritative-price-sources.ts`, `redemption-backstop-sources.ts`, `yield-source-links.ts` — metadata lookups
- Worker: `sync-stablecoins/stages.ts` — `TRACKED_META_BY_ID.get()` to match DL assets
- Worker: `yield-sync/resolve.ts`, `yield-sync/rankings.ts` — `TRACKED_META_BY_ID` lookups
- Worker: `dex-liquidity/price-sanity.ts` — `TRACKED_META_BY_ID.get()` for per-coin price bounds
- `src/components/stablecoin-filtered-table.tsx`, `flow-table.tsx`, `dependency-map-mobile-summary.tsx`, `compare-empty-state.tsx`, `portfolio-empty-state.tsx`, `yield-detail-section.tsx` — `TRACKED_META_BY_ID` lookups
- `src/hooks/use-compare-data-model.ts`, `use-chains.ts` — `TRACKED_META_BY_ID` lookups
- `src/lib/compare-pages.ts`, `stablecoin-detail-view-model.ts` — `TRACKED_META_BY_ID` lookups
- `src/app/dependency-map/client.tsx` — `TRACKED_META_BY_ID` lookups
- `src/components/stablecoin-table.tsx` — `TRACKED_META_BY_ID` (renders only API-returned data, pre-launch won't be in API)

---

## Task 1: Data Model — Types, Factory, Derived Lists

**Files:**
- Modify: `shared/types/core.ts:221-252`
- Modify: `shared/lib/stablecoins/factory.ts:1-80`
- Modify: `shared/lib/stablecoins/index.ts:197-215`

- [ ] **Step 1: Add LaunchPhase type and new fields to StablecoinMeta**

In `shared/types/core.ts`, add right before the `StablecoinMeta` interface (before line 221):

```ts
export type LaunchPhase = "announced" | "testnet" | "auditing" | "beta" | "launching-soon";
```

Then add these fields inside `StablecoinMeta` (after line 251, before the closing `}`):

```ts
  status?: "pre-launch" | "active";
  announcedDate?: string;
  expectedLaunchDate?: string;
  launchPhase?: LaunchPhase;
  launchPhaseDetail?: string;
```

- [ ] **Step 2: Add new fields to StablecoinOpts in factory.ts**

In `shared/lib/stablecoins/factory.ts`, add to the `StablecoinOpts` interface (after line 33, before `}`):

```ts
  status?: StablecoinMeta["status"];
  announcedDate?: string;
  expectedLaunchDate?: string;
  launchPhase?: StablecoinMeta["launchPhase"];
  launchPhaseDetail?: string;
```

Then add them to the `coin()` return object (after line 74, before the closing `}`):

```ts
    status: opts?.status,
    announcedDate: opts?.announcedDate,
    expectedLaunchDate: opts?.expectedLaunchDate,
    launchPhase: opts?.launchPhase,
    launchPhaseDetail: opts?.launchPhaseDetail,
```

- [ ] **Step 3: Add derived lists to index.ts**

In `shared/lib/stablecoins/index.ts`, add after line 215 (after `TRACKED_IDS`):

```ts
// --- Active vs Pre-Launch partitions ---

/** Stablecoins with full worker processing (excludes pre-launch). */
export const ACTIVE_STABLECOINS = TRACKED_STABLECOINS.filter(
  (c) => c.status !== "pre-launch",
);

/** Set of active stablecoin IDs (excludes pre-launch). */
export const ACTIVE_IDS = new Set(ACTIVE_STABLECOINS.map((s) => s.id));

/** Map of active stablecoin ID -> metadata (excludes pre-launch). */
export const ACTIVE_META_BY_ID = new Map(ACTIVE_STABLECOINS.map((s) => [s.id, s]));

/** Stablecoins in pre-launch stage. */
export const PRE_LAUNCH_STABLECOINS = TRACKED_STABLECOINS.filter(
  (c) => c.status === "pre-launch",
);
```

- [ ] **Step 4: Verify types compile**

Run: `cd shared && npx tsc --noEmit` (or from root: `npm run build` — type-check is part of build)
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add shared/types/core.ts shared/lib/stablecoins/factory.ts shared/lib/stablecoins/index.ts
git commit -m "feat(data-model): add pre-launch status, LaunchPhase type, and ACTIVE/PRE_LAUNCH derived lists"
```

---

## Task 2: Seed Pre-Launch Coin Definitions

**Files:**
- Modify: `shared/lib/stablecoins/usd-minor.ts`
- Modify: `shared/lib/stablecoins/non-usd.ts`
- Modify: `shared/lib/stablecoins/commodity.ts`
- Modify: `shared/lib/stablecoins/index.ts:16-175` (CANONICAL_ORDER)

- [ ] **Step 1: Add 5 USD pre-launch coins to usd-minor.ts**

Append to the end of the `USD_MINOR_COINS` array in `shared/lib/stablecoins/usd-minor.ts` (before the closing `];`):

```ts
  // ── Pre-Launch ──────────────────────────────────────────────────────
  usd("usdpt-western-union", "US Dollar Payment Token", "USDPT", "rwa-backed", "centralized", {
    status: "pre-launch",
    announcedDate: "2025-10",
    expectedLaunchDate: "2026-Q2",
    launchPhase: "announced",
    launchPhaseDetail: "Listed as 'Coming soon' on Anchorage Digital reserve page",
    jurisdiction: { country: "United States" },
    links: [
      { label: "Website", url: "https://www.westernunion.com" },
      { label: "Twitter", url: "https://x.com/WesternUnion" },
    ],
  }),
  usd("roughrider-bnd", "Roughrider Coin", "ROUGHRIDER", "rwa-backed", "centralized", {
    status: "pre-launch",
    announcedDate: "2025-10",
    expectedLaunchDate: "2026-09",
    launchPhase: "beta",
    launchPhaseDetail: "Pilot pending ND Industrial Commission approval (Mar 25, 2026 meeting)",
    jurisdiction: { country: "United States" },
    links: [
      { label: "Website", url: "https://bnd.nd.gov/roughrider/" },
      { label: "Docs", url: "https://bnd.nd.gov/fintech/" },
      { label: "Twitter", url: "https://x.com/BankofND" },
    ],
  }),
  usd("fiusd-fiserv", "Fiserv USD", "FIUSD", "rwa-backed", "centralized-dependent", {
    status: "pre-launch",
    announcedDate: "2025-06",
    expectedLaunchDate: "2026",
    launchPhase: "beta",
    launchPhaseDetail: "Platform built; end-of-2025 target slipped, no confirmed production launch",
    jurisdiction: { country: "United States" },
    links: [
      { label: "Website", url: "https://www.fiserv.com" },
      { label: "Twitter", url: "https://x.com/Fiserv" },
    ],
  }),
  usd("pusd-polaris", "Polaris USD", "pUSD", "crypto-backed", "decentralized", {
    status: "pre-launch",
    announcedDate: "2026-01",
    expectedLaunchDate: "2026-Q4",
    launchPhase: "testnet",
    launchPhaseDetail: "Private testnet live",
    yieldBearing: true,
    links: [
      { label: "Website", url: "https://polarisfinance.io" },
      { label: "Twitter", url: "https://x.com/polarisfinance_" },
    ],
  }),
  usd("klarnausd-klarna", "KlarnaUSD", "KLARNAUSD", "rwa-backed", "centralized", {
    status: "pre-launch",
    announcedDate: "2025-11",
    expectedLaunchDate: "2026",
    launchPhase: "testnet",
    launchPhaseDetail: "Live on Tempo testnet since Nov 2025",
    jurisdiction: { country: "Sweden" },
    links: [
      { label: "Website", url: "https://www.klarna.com" },
      { label: "Twitter", url: "https://x.com/Klarna" },
    ],
  }),
```

- [ ] **Step 2: Add EUR pre-launch coin to non-usd.ts**

Append to the end of the `NON_USD_COINS` array in `shared/lib/stablecoins/non-usd.ts` (before the closing `];`):

```ts
  // ── Pre-Launch ──────────────────────────────────────────────────────
  eur("eur-qivalis", "Qivalis Euro", "QEUR", "rwa-backed", "centralized", {
    status: "pre-launch",
    announcedDate: "2025-09",
    expectedLaunchDate: "2026-Q4",
    launchPhase: "announced",
    launchPhaseDetail: "Seeking Dutch Central Bank EMI license; in talks with crypto exchanges",
    jurisdiction: { country: "Netherlands" },
    links: [
      { label: "Website", url: "https://qivalis.eu" },
      { label: "Twitter", url: "https://x.com/qivaliseu" },
    ],
  }),
```

- [ ] **Step 3: Add GOLD pre-launch coin to commodity.ts**

Append to the end of the `COMMODITY_COINS` array in `shared/lib/stablecoins/commodity.ts` (before the closing `];`):

```ts
  // ── Pre-Launch ──────────────────────────────────────────────────────
  other("pgold-polaris", "Polaris Gold", "pGOLD", "crypto-backed", "decentralized", "GOLD", {
    status: "pre-launch",
    announcedDate: "2026-01",
    expectedLaunchDate: "2026-Q4",
    launchPhase: "testnet",
    launchPhaseDetail: "Private testnet live (shared infrastructure with pUSD)",
    links: [
      { label: "Website", url: "https://polarisfinance.io" },
      { label: "Twitter", url: "https://x.com/polarisfinance_" },
    ],
  }),
```

- [ ] **Step 4: Add 7 coin IDs to CANONICAL_ORDER in index.ts**

Append before the closing `];` of `CANONICAL_ORDER` in `shared/lib/stablecoins/index.ts` (after `"apxusd-apyx"` on line 174):

```ts
  // Pre-launch
  "usdpt-western-union",
  "roughrider-bnd",
  "fiusd-fiserv",
  "eur-qivalis",
  "pusd-polaris",
  "pgold-polaris",
  "klarnausd-klarna",
```

- [ ] **Step 5: Verify no ID conflicts and types compile**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 6: Commit**

```bash
git add shared/lib/stablecoins/usd-minor.ts shared/lib/stablecoins/non-usd.ts shared/lib/stablecoins/commodity.ts shared/lib/stablecoins/index.ts
git commit -m "feat(data): seed 7 pre-launch stablecoin definitions"
```

---

## Task 3: Worker Migration — Switch Data-Processing to ACTIVE_*

All worker cron jobs, lib files, and API endpoints that **iterate** over the stablecoin list for data processing must switch from `TRACKED_STABLECOINS` / `TRACKED_IDS` to `ACTIVE_STABLECOINS` / `ACTIVE_IDS`. Files that only do **lookups by ID** (`TRACKED_META_BY_ID.get(id)`) keep `TRACKED_*`.

**Files to change** (each is a one-line import change + find-replace of the variable name):

### Cron files
- Modify: `worker/src/cron/sync-stablecoins.ts:2,123` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/sync-live-reserves.ts:1,13` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/daily-digest.ts:3,436` — `TRACKED_IDS` → `ACTIVE_IDS`
- Modify: `worker/src/cron/enrich-prices.ts:9,155` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/discovery-scan.ts:5,141` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/sync-yield-data.ts:3,837` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS` (keep `TRACKED_META_BY_ID` for lookups on lines 262, 279)
- Modify: `worker/src/cron/sync-stablecoins/shared.ts:3,12-13` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/sync-stablecoins/supplemental-assets.ts:1,15,19,20,21` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/dex-discovery/orchestrator.ts:3,151` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/dex-discovery/crawl-sources.ts:1,44` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`

### DEX liquidity files
- Modify: `worker/src/cron/dex-liquidity/persistence.ts:1,96,182,228` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/dex-liquidity/orchestrator.ts:2,242` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/dex-liquidity/fetch-primary.ts:1,601` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/dex-liquidity/fetch-crawlers.ts:1,160,362` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/dex-liquidity/fetch-fallbacks.ts:1,24,25` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/dex-liquidity/process-pools.ts:1,164` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/dex-liquidity/scoring.ts:1,531` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/dex-liquidity/constants.ts:10,76` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/cron/dex-liquidity/pool-helpers.ts:1,265,278` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`

### Worker lib files
- Modify: `worker/src/lib/report-cards-snapshot.ts:2,128,133,225,248` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/lib/collateral-drift.ts:1,28` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/lib/safety-scores.ts:1,101` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/lib/telegram-alerts.ts:2,37,51` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/lib/peg-analytics.ts:1,53` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS` (keep `TRACKED_META_BY_ID` for lookups)
- Modify: `worker/src/lib/twitter.ts:1,72` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/lib/geckoterminal-price-probe.ts:8,90` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/lib/live-reserves-store.ts:2,117` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS` (keep `TRACKED_META_BY_ID` for lookups)

### Worker API files
- Modify: `worker/src/api/og.tsx:13,149,234` — `TRACKED_IDS` → `ACTIVE_IDS`
- Modify: `worker/src/api/stress-signals.ts:19,37,144` — `TRACKED_IDS` → `ACTIVE_IDS`
- Modify: `worker/src/api/stablecoin-reserves.ts:2,13` — `TRACKED_IDS` → `ACTIVE_IDS` (keep `TRACKED_META_BY_ID` for lookups)
- Modify: `worker/src/api/backfill-cg-prices.ts:1,30` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/api/backfill-fx.ts:1,233` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS` (keep `TRACKED_META_BY_ID` for lookups)
- Modify: `worker/src/api/status.ts:33,832,852,854` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`
- Modify: `worker/src/api/telegram-webhook-shared.ts:1,149` — `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS`

### Files that KEEP TRACKED_* (no change)
- `worker/src/api/stablecoin-detail.ts` — `TRACKED_META_BY_ID.get()` lookup (must resolve pre-launch coins too for detail page API)
- `worker/src/api/peg-summary.ts` — `TRACKED_META_BY_ID` for peg rate derivation + iteration on line 163 (pre-launch coins have no data rows, so this is harmless)
- `worker/src/api/chains.ts` — `TRACKED_META_BY_ID` for peg rate derivation
- `worker/src/api/feedback.ts` — `TRACKED_META_BY_ID.get()` lookup
- `worker/src/api/audit-depeg-history.ts` — `TRACKED_META_BY_ID.get()` lookup
- `worker/src/api/status-derived-data.ts` — `TRACKED_META_BY_ID.get()` lookups
- `worker/src/cron/confirm-pending-depegs.ts` — `TRACKED_META_BY_ID` for peg rate + lookup
- `worker/src/cron/dispatch-telegram-alerts.ts` — `TRACKED_META_BY_ID.get()` lookup
- `worker/src/cron/sync-stablecoins/stages.ts` — `TRACKED_META_BY_ID.get()` lookup
- `worker/src/cron/yield-sync/resolve.ts` — `TRACKED_META_BY_ID` lookups + `TRACKED_STABLECOINS` filter (lending candidates should stay full list since it's a metadata query)
- `worker/src/cron/yield-sync/rankings.ts` — `TRACKED_META_BY_ID.get()` lookup
- `worker/src/cron/dex-liquidity/price-sanity.ts` — `TRACKED_META_BY_ID.get()` lookup
- `worker/src/lib/price-validation.ts` — `TRACKED_META_BY_ID.get()` lookup
- `worker/src/lib/authoritative-price-sources.ts` — `TRACKED_META_BY_ID.get()` lookup
- `worker/src/lib/redemption-backstop-sources.ts` — `TRACKED_META_BY_ID.get()` lookup
- `worker/src/lib/yield-source-links.ts` — `TRACKED_META_BY_ID.get()` lookup
- `worker/src/api/mint-burn-flows.ts` — local `TRACKED_IDS` (not from `@shared/lib/stablecoins`)
- `worker/src/lib/flight-to-quality-classification.ts` — local `TRACKED_IDS` (not from `@shared/lib/stablecoins`)

- [ ] **Step 1: Batch-update worker cron file imports**

For each cron file listed above, change the import from `TRACKED_STABLECOINS` to `ACTIVE_STABLECOINS` (or `TRACKED_IDS` to `ACTIVE_IDS`) and update all usages in the file. The import path stays `@shared/lib/stablecoins`.

Example for `worker/src/cron/sync-stablecoins.ts`:
```ts
// Before:
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
// After:
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";

// And usage on line 123:
// Before: for (const meta of TRACKED_STABLECOINS) {
// After:  for (const meta of ACTIVE_STABLECOINS) {
```

For files that import BOTH (e.g., `sync-yield-data.ts`), keep `TRACKED_META_BY_ID` and only replace `TRACKED_STABLECOINS`:
```ts
// Before:
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
// After:
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
```

- [ ] **Step 2: Batch-update DEX liquidity file imports**

Same pattern as Step 1 for all files under `worker/src/cron/dex-liquidity/`.

- [ ] **Step 3: Batch-update worker lib file imports**

Same pattern for all files under `worker/src/lib/` listed above.

- [ ] **Step 4: Batch-update worker API file imports**

Same pattern for all files under `worker/src/api/` listed above.

- [ ] **Step 5: Verify worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 6: Run worker tests**

Run: `cd worker && npx vitest run`
Expected: All tests pass (tests that mock `TRACKED_STABLECOINS` may need import updates if they import from the source).

- [ ] **Step 7: Commit**

```bash
git add worker/
git commit -m "feat(worker): switch all data-processing to ACTIVE_STABLECOINS, excluding pre-launch coins"
```

---

## Task 4: Frontend Exclusions — Switch Data-Driven UI to ACTIVE_*

**Files:** All frontend `src/` files listed in the "Modified files" table that switch from `TRACKED_*` to `ACTIVE_*`.

- [ ] **Step 1: Update classification.ts**

In `shared/lib/classification.ts:17`, change:
```ts
// Before:
import { TRACKED_STABLECOINS } from "./stablecoins";
// After:
import { ACTIVE_STABLECOINS } from "./stablecoins";
```
And update all usages of `TRACKED_STABLECOINS` in that file to `ACTIVE_STABLECOINS`.

- [ ] **Step 2: Update stablecoin-table-logic.ts**

In `src/components/stablecoin-table-logic.ts:6`, change:
```ts
// Before:
import { TRACKED_IDS, TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
// After:
import { ACTIVE_IDS, TRACKED_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
```
Update `TRACKED_IDS` → `ACTIVE_IDS` and `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS` in the file. Keep `TRACKED_META_BY_ID`.

- [ ] **Step 3: Update homepage-client.tsx footer stats**

In `src/components/homepage-client.tsx:21`, change import:
```ts
// Before:
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
// After:
import { ACTIVE_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
```
Update lines 542-546 to use `ACTIVE_STABLECOINS` instead of `TRACKED_STABLECOINS`.

- [ ] **Step 4: Update peg-landing.ts pegCoinCount**

In `src/lib/peg-landing.ts:2,57`, change the import to add `ACTIVE_STABLECOINS` while keeping `TRACKED_STABLECOINS` for `ACTIVE_PEGS`:
```ts
import { TRACKED_STABLECOINS, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
```
Update `pegCoinCount` to use `ACTIVE_STABLECOINS`:
```ts
export function pegCoinCount(peg: PegCurrency): number {
  return ACTIVE_STABLECOINS.filter((c) => c.flags.pegCurrency === peg).length;
}
```

- [ ] **Step 5: Update category-stats.tsx**

In `src/components/category-stats.tsx:10`, change:
```ts
// Before:
import { TRACKED_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
// After:
import { ACTIVE_IDS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
```
Update usages: `TRACKED_IDS` → `ACTIVE_IDS`, `TRACKED_META_BY_ID` → `ACTIVE_META_BY_ID`.

- [ ] **Step 6: Update market-highlights.tsx**

In `src/components/market-highlights.tsx:12`, change:
```ts
// Before:
import { TRACKED_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
// After:
import { ACTIVE_IDS, ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
```
Update usages.

- [ ] **Step 7: Batch-update remaining frontend files**

Apply the same import swap in these files (each is a simple `TRACKED_STABLECOINS` → `ACTIVE_STABLECOINS` in import + usages):
- `src/app/page.tsx:2,28,31`
- `src/app/layout.tsx:12,26`
- `src/app/stablecoins/[peg]/page.tsx:5,66`
- `src/lib/stablecoin-taxonomy.ts:1,94,113`
- `src/lib/compare-config.ts:1,9,16`
- `src/app/coverage/page.tsx:4,24`
- `src/app/about/page.tsx:30,232,370`
- `src/app/liquidity/page.tsx:1,10,31`
- `src/app/liquidity/client.tsx:17,53,94,131`
- `src/app/depeg/page.tsx:3,15,75`
- `src/app/compare/page.tsx:1,6`
- `src/app/portfolio/client.tsx:15,34`
- `src/lib/start-here-content.ts:24,135`
- `src/hooks/use-stress-test.ts:5,62`
- `src/hooks/use-coverage-matrix-model.ts:5,52,62` — switch to `ACTIVE_META_BY_ID` and `ACTIVE_STABLECOINS`
- `src/lib/contagion-layout.ts:11,206`
- `src/lib/portfolio-analysis.ts:1,30`
- `src/lib/stablecoin-url-codec.ts:2,7`

- [ ] **Step 8: Verify frontend type-check and build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 9: Run frontend tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/ shared/lib/classification.ts
git commit -m "feat(frontend): switch data-driven UI to ACTIVE_STABLECOINS, excluding pre-launch coins"
```

---

## Task 5: Pre-Launch Detail Page Component

**Files:**
- Create: `src/components/pre-launch-detail.tsx`
- Modify: `src/app/stablecoin/[id]/page.tsx`

- [ ] **Step 1: Create pre-launch-detail.tsx**

Create `src/components/pre-launch-detail.tsx` with the purpose-built pre-launch layout:

```tsx
import Link from "next/link";
import { ArrowLeft, ExternalLink, Globe, FileText } from "lucide-react";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { buildStablecoinUrl } from "@/lib/urls";
import type { StablecoinMeta, LaunchPhase } from "@shared/types";

// ── Launch Phase Badge ──────────────────────────────────────────────

const LAUNCH_PHASE_LABELS: Record<LaunchPhase, string> = {
  announced: "Announced",
  testnet: "Testnet",
  auditing: "Auditing",
  beta: "Beta",
  "launching-soon": "Launching Soon",
};

function LaunchPhaseBadge({ phase }: { phase: LaunchPhase }) {
  return (
    <span className="inline-flex items-center rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-xs font-medium text-indigo-400">
      {LAUNCH_PHASE_LABELS[phase]}
    </span>
  );
}

// ── Timeline ────────────────────────────────────────────────────────

function parseDate(dateStr: string): Date | null {
  // "YYYY-MM"
  if (/^\d{4}-\d{2}$/.test(dateStr)) return new Date(`${dateStr}-01`);
  // "YYYY-QN"
  const qMatch = dateStr.match(/^(\d{4})-Q([1-4])$/);
  if (qMatch) {
    const month = (Number(qMatch[2]) - 1) * 3; // Q1→0, Q2→3, Q3→6, Q4→9
    return new Date(Number(qMatch[1]), month, 1);
  }
  // "YYYY"
  if (/^\d{4}$/.test(dateStr)) return new Date(Number(dateStr), 6, 1); // mid-year
  return null;
}

function formatDateLabel(dateStr: string): string {
  if (/^\d{4}-Q[1-4]$/.test(dateStr)) return dateStr.replace("-", " ");
  if (/^\d{4}-\d{2}$/.test(dateStr)) {
    const d = new Date(`${dateStr}-01`);
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }
  return dateStr;
}

function LaunchTimeline({ announcedDate, expectedLaunchDate }: { announcedDate?: string; expectedLaunchDate?: string }) {
  if (!announcedDate || !expectedLaunchDate) {
    if (expectedLaunchDate) {
      return (
        <div className="rounded-lg border border-border/60 bg-card/50 p-4">
          <p className="text-sm text-muted-foreground">
            Expected Launch: <span className="font-medium text-foreground">{formatDateLabel(expectedLaunchDate)}</span>
          </p>
        </div>
      );
    }
    return null;
  }

  const start = parseDate(announcedDate);
  const end = parseDate(expectedLaunchDate);
  const now = new Date();

  if (!start || !end) return null;

  const totalMs = end.getTime() - start.getTime();
  const elapsedMs = now.getTime() - start.getTime();
  const progress = totalMs > 0 ? Math.max(0, Math.min(1, elapsedMs / totalMs)) : 0;

  return (
    <div className="rounded-lg border border-border/60 bg-card/50 p-4 space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Announced {formatDateLabel(announcedDate)}</span>
        <span>Expected Launch {formatDateLabel(expectedLaunchDate)}</span>
      </div>
      <div className="relative h-2 rounded-full bg-muted/50">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-indigo-600 to-purple-500"
          style={{ width: `${progress * 100}%` }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2"
          style={{ left: `${progress * 100}%` }}
        >
          <div className="flex flex-col items-center">
            <div className="h-4 w-4 rounded-full border-2 border-indigo-400 bg-background" />
            <span className="mt-1 text-[10px] font-medium text-indigo-400">Today</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── At a Glance Grid ────────────────────────────────────────────────

function AtAGlanceItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/50 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{value}</dd>
    </div>
  );
}

// ── Related Stablecoins ─────────────────────────────────────────────

function getRelatedActive(coin: StablecoinMeta, limit = 6): StablecoinMeta[] {
  const others = ACTIVE_STABLECOINS.filter((s) => s.id !== coin.id);
  const scored = others.map((s) => {
    let score = 0;
    if (s.flags.governance === coin.flags.governance) score += 3;
    if (s.flags.backing === coin.flags.backing) score += 2;
    if (s.flags.pegCurrency === coin.flags.pegCurrency) score += 1;
    return { coin: s, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.coin);
}

// ── Link Icon Helper ────────────────────────────────────────────────

function linkIcon(label: string) {
  const l = label.toLowerCase();
  if (l.includes("doc")) return <FileText className="h-4 w-4" />;
  return <Globe className="h-4 w-4" />;
}

// ── Main Component ──────────────────────────────────────────────────

interface PreLaunchDetailProps {
  coin: StablecoinMeta;
  logoSrc?: string;
  summary: { title: string; text: string; updatedAt: string } | null;
  logos: Record<string, string>;
}

export function PreLaunchDetail({ coin, logoSrc, summary, logos }: PreLaunchDetailProps) {
  const related = getRelatedActive(coin);
  const jurisdictionLabel = coin.jurisdiction?.country ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-6 py-6">
      {/* Back link */}
      <Link
        href="/"
        className="pharos-focus-ring inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Dashboard
      </Link>

      {/* Pre-Launch Banner */}
      <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-indigo-400">Pre-Launch</span>
          <span className="text-sm text-muted-foreground">Not yet tracked by Pharos</span>
          {coin.launchPhase && <LaunchPhaseBadge phase={coin.launchPhase} />}
        </div>
        {coin.launchPhaseDetail && (
          <p className="mt-1.5 text-sm text-muted-foreground">{coin.launchPhaseDetail}</p>
        )}
      </div>

      {/* Header */}
      <div className="flex items-center gap-4">
        <StablecoinLogo src={logoSrc} name={coin.name} size={48} />
        <div>
          <h1 className="text-2xl font-extrabold tracking-tighter">{coin.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono font-semibold">{coin.symbol}</span>
            <span className="text-border">|</span>
            <span>{PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}</span>
            <span className="text-border">|</span>
            <span>{BACKING_LABELS[coin.flags.backing]}</span>
            <span className="text-border">|</span>
            <span>{GOVERNANCE_LABELS[coin.flags.governance]}</span>
          </div>
        </div>
      </div>

      {/* Launch Timeline */}
      <LaunchTimeline
        announcedDate={coin.announcedDate}
        expectedLaunchDate={coin.expectedLaunchDate}
      />

      {/* Editorial Summary */}
      {summary && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold tracking-tight">{summary.title}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">{summary.text}</p>
        </section>
      )}

      {/* At a Glance Grid */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">At a Glance</h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <AtAGlanceItem label="Backing" value={BACKING_LABELS[coin.flags.backing]} />
          <AtAGlanceItem label="Governance" value={GOVERNANCE_LABELS[coin.flags.governance]} />
          <AtAGlanceItem label="Peg Currency" value={PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency} />
          {jurisdictionLabel && <AtAGlanceItem label="Jurisdiction" value={jurisdictionLabel} />}
          {coin.flags.yieldBearing && <AtAGlanceItem label="Yield-Bearing" value="Yes" />}
        </dl>
      </section>

      {/* Reserve/Collateral Design */}
      {coin.reserves && coin.reserves.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Planned Collateral Composition</h2>
          <div className="rounded-lg border border-border/60 bg-card/50 p-4">
            <ul className="space-y-2 text-sm">
              {coin.reserves.map((r, i) => (
                <li key={i} className="flex items-center justify-between">
                  <span>{r.name}</span>
                  <span className="font-mono text-muted-foreground">{r.pct != null ? `${r.pct}%` : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Target Chains */}
      {coin.contracts && coin.contracts.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Target Chains</h2>
          <div className="flex flex-wrap gap-2">
            {[...new Set(coin.contracts.map((c) => c.chain))].map((chain) => (
              <span
                key={chain}
                className="inline-flex items-center rounded-md border border-border/60 bg-card/50 px-2.5 py-1 text-xs font-medium"
              >
                {chain}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Links & Resources */}
      {coin.links && coin.links.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Links & Resources</h2>
          <div className="flex flex-wrap gap-2">
            {coin.links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-card/50 px-3 py-2 text-sm transition-colors hover:bg-accent"
              >
                {linkIcon(link.label)}
                <span>{link.label}</span>
                <ExternalLink className="h-3 w-3 text-muted-foreground" />
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Related Stablecoins */}
      {related.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Similar Tracked Stablecoins</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {related.map((r) => (
              <Link
                key={r.id}
                href={buildStablecoinUrl(r.id)}
                className="pharos-focus-ring flex items-center gap-2.5 rounded-lg border border-border/60 bg-card/50 p-3 transition-colors hover:bg-accent"
              >
                <StablecoinLogo src={logos[r.id]} name={r.name} size={28} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-muted-foreground">{r.symbol}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update the detail page to conditionally render pre-launch layout**

In `src/app/stablecoin/[id]/page.tsx`, add imports and conditional render:

Add import at top:
```ts
import { PreLaunchDetail } from "@/components/pre-launch-detail";
```

Change the `getRelatedStablecoins` function (line 36-56) to filter active coins only:
```ts
import { TRACKED_STABLECOINS, TRACKED_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";

function getRelatedStablecoins(coinId: string, limit = 6) {
  const coin = TRACKED_META_BY_ID.get(coinId);
  if (!coin) return [];

  const others = ACTIVE_STABLECOINS.filter((s) => s.id !== coinId);
  // ... rest unchanged
```

In the page component (line 58+), add conditional rendering for pre-launch:

```tsx
export default async function StablecoinDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const coin = TRACKED_META_BY_ID.get(id);
  const typedLogos = logos as Record<string, string>;

  if (!coin) {
    return (
      <div className="space-y-4 py-12 text-center">
        <h1 className="text-3xl font-extrabold tracking-tighter">Stablecoin Not Found</h1>
        <p className="text-muted-foreground">No stablecoin found with ID &ldquo;{id}&rdquo;.</p>
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
          &larr; Back to Dashboard
        </Link>
      </div>
    );
  }

  if (coin.status === "pre-launch") {
    return (
      <PreLaunchDetail
        coin={coin}
        logoSrc={typedLogos[coin.id]}
        summary={typedSummaries[id] ?? null}
        logos={typedLogos}
      />
    );
  }

  // Active coin — existing layout
  const related = getRelatedStablecoins(id);
  const staticComparisonPages = getStaticComparisonPagesForCoin(id);

  return (
    <>
      <div className="sr-only">
        {/* ... existing active layout unchanged ... */}
      </div>
      <StablecoinDetailClient ... />
      <ExploreNextSection ... />
      ...
    </>
  );
}
```

- [ ] **Step 3: Verify the page builds**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/components/pre-launch-detail.tsx src/app/stablecoin/[id]/page.tsx
git commit -m "feat(detail): add pre-launch stablecoin detail page layout"
```

---

## Task 6: Homepage "Upcoming Stablecoins" Section

**Files:**
- Create: `src/components/upcoming-stablecoins-section.tsx`
- Modify: `src/components/homepage-client.tsx`

- [ ] **Step 1: Create upcoming-stablecoins-section.tsx**

```tsx
import Link from "next/link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";
import { BACKING_LABELS_SHORT, GOVERNANCE_LABELS_SHORT, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { buildStablecoinUrl } from "@/lib/urls";
import type { LaunchPhase } from "@shared/types";
import aiSummaries from "../../data/ai-summaries.json";

const typedSummaries = aiSummaries as Record<string, { title: string; text: string; updatedAt: string }>;

const LAUNCH_PHASE_LABELS: Record<LaunchPhase, string> = {
  announced: "Announced",
  testnet: "Testnet",
  auditing: "Auditing",
  beta: "Beta",
  "launching-soon": "Launching Soon",
};

function formatExpectedDate(dateStr?: string): string {
  if (!dateStr) return "";
  if (/^\d{4}-Q[1-4]$/.test(dateStr)) return dateStr.replace("-", " ");
  if (/^\d{4}-\d{2}$/.test(dateStr)) {
    const d = new Date(`${dateStr}-01`);
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }
  return dateStr;
}

interface UpcomingStablecoinsSectionProps {
  logos: Record<string, string>;
}

export function UpcomingStablecoinsSection({ logos }: UpcomingStablecoinsSectionProps) {
  if (PRE_LAUNCH_STABLECOINS.length === 0) return null;

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-semibold tracking-tight">Upcoming Stablecoins</h2>
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-500/15 px-1.5 text-xs font-medium text-indigo-400">
          {PRE_LAUNCH_STABLECOINS.length}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {PRE_LAUNCH_STABLECOINS.map((coin) => {
          const summary = typedSummaries[coin.id];
          const teaser = summary?.text ? summary.text.slice(0, 100) + (summary.text.length > 100 ? "..." : "") : null;

          return (
            <Link
              key={coin.id}
              href={buildStablecoinUrl(coin.id)}
              className="pharos-focus-ring group flex flex-col gap-3 rounded-xl border border-border/60 bg-card/50 p-4 transition-colors hover:border-foreground/20 hover:bg-accent"
            >
              {/* Logo + Name */}
              <div className="flex items-center gap-2.5">
                <StablecoinLogo src={logos[coin.id]} name={coin.name} size={32} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{coin.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {coin.symbol} · {PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency}
                  </p>
                </div>
              </div>

              {/* Badges */}
              <div className="flex flex-wrap gap-1.5">
                <span className="rounded-md border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {BACKING_LABELS_SHORT[coin.flags.backing]}
                </span>
                <span className="rounded-md border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {GOVERNANCE_LABELS_SHORT[coin.flags.governance]}
                </span>
                {coin.launchPhase && (
                  <span className="rounded-md border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400">
                    {LAUNCH_PHASE_LABELS[coin.launchPhase]}
                  </span>
                )}
              </div>

              {/* Teaser */}
              {teaser && (
                <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{teaser}</p>
              )}

              {/* Expected launch */}
              {coin.expectedLaunchDate && (
                <p className="mt-auto text-[10px] text-muted-foreground">
                  Expected: {formatExpectedDate(coin.expectedLaunchDate)}
                </p>
              )}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Add the section to homepage-client.tsx**

Import the component at the top of `src/components/homepage-client.tsx`:
```ts
import { UpcomingStablecoinsSection } from "@/components/upcoming-stablecoins-section";
```

Insert after the `<PegBrowseSection>` (after line 441, inside the same `<SectionErrorBoundary>` or immediately after it). Place it right after the closing `</section>` of the stablecoin table section (line 442) and before the "Core Monitoring" section (line 445):

```tsx
      <SectionErrorBoundary name="upcoming-stablecoins">
        <UpcomingStablecoinsSection logos={logos} />
      </SectionErrorBoundary>
```

Note: `logos` is already available from `const { data: logos = {} } = useLogos();` (already in scope in the component).

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add src/components/upcoming-stablecoins-section.tsx src/components/homepage-client.tsx
git commit -m "feat(homepage): add Upcoming Stablecoins card section"
```

---

## Task 7: Search Integration — Pre-Launch Badge

**Files:**
- Modify: `src/components/command-palette.tsx`

- [ ] **Step 1: Add pre-launch badge in search results**

In `src/components/command-palette.tsx`, find the section where `TRACKED_STABLECOINS` items are mapped to search results (around line 120). Add a `sublabel` for pre-launch coins:

```tsx
// Around the search result generation for stablecoins:
for (const coin of TRACKED_STABLECOINS) {
  // ... existing fuzzy match logic
  results.push({
    id: coin.id,
    label: `${coin.name} (${coin.symbol})`,
    sublabel: coin.status === "pre-launch" ? "Pre-launch" : undefined,
    // ... rest of existing properties
  });
}
```

Then in the rendering section, display the sublabel as a badge:

Find where `result.sublabel` would be rendered (or the result label display). Add after the label text:

```tsx
{result.sublabel && (
  <span className="ml-1.5 rounded border border-indigo-500/30 bg-indigo-500/10 px-1 py-0.5 text-[10px] font-medium text-indigo-400">
    {result.sublabel}
  </span>
)}
```

Note: Read the full command-palette.tsx to see where exactly to insert the sublabel rendering — it already has a `sublabel` field in the `SearchResult` interface (line 18).

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add src/components/command-palette.tsx
git commit -m "feat(search): add Pre-launch badge for pre-launch coins in command palette"
```

---

## Task 8: Editorial Summaries

**Files:**
- Modify: `data/ai-summaries.json`

- [ ] **Step 1: Write 7 editorial summaries**

Use the `write-ai-summaries` skill to generate editorial summaries for each of the 7 pre-launch coins. The summaries should be added to `data/ai-summaries.json` keyed by coin ID with the format:

```json
{
  "usdpt-western-union": {
    "title": "Western Union's Stablecoin Entry via Anchorage Digital",
    "text": "USDPT is a fiat-backed stablecoin being developed by Anchorage Digital Bank in partnership with Western Union, targeting the Solana blockchain. Anchorage, the first federally chartered OCC-regulated digital asset bank, will serve as the issuer, while Western Union provides the global distribution network spanning 200+ countries. The token promises 1:1 USD redeemability backed by cash and cash-equivalent reserves.",
    "updatedAt": "2026-03-17"
  },
  ...
}
```

One summary per coin. Content should be factual, based on the verified research in `agents/plans/pre-launch-stablecoins-verified.md`. Keep each summary at ~150-250 words.

- [ ] **Step 2: Commit**

```bash
git add data/ai-summaries.json
git commit -m "feat(content): add editorial summaries for 7 pre-launch stablecoins"
```

---

## Task 9: Doc-Counts CI Update

**Files:**
- Modify: `scripts/check-doc-counts.mjs`
- Modify: `CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/report-cards.md`, `docs/supply-snapshot.md`

- [ ] **Step 1: Update check-doc-counts.mjs to count active vs total**

The script currently counts all entries in CANONICAL_ORDER. After adding 7 pre-launch coins, CANONICAL_ORDER will have 165 entries (currently 158 + 7 new).

Option A (simpler): Update the docs to say "tracking 165 stablecoins" (total including pre-launch).
Option B (more accurate): Make the script count only active entries.

Go with Option A — docs should reflect total CANONICAL_ORDER since pre-launch coins ARE tracked (just not worker-processed). The `tracking X stablecoins` phrase in docs already aligns with CANONICAL_ORDER length.

Update the hardcoded count in all docs from 158 to 165:
- `CLAUDE.md`: `tracking 158 stablecoins` → `tracking 165 stablecoins`
- `AGENTS.md`: `tracking 158 stablecoins` → `tracking 165 stablecoins`
- `README.md`: `tracking 158 stablecoins` → `tracking 165 stablecoins`
- `docs/report-cards.md`: `158 tracked` → `165 tracked`
- `docs/supply-snapshot.md`: `158 tracked` and `currently 160 entries` → `165 tracked` and `currently 167 entries` (165 tracked + 2 shadow)

- [ ] **Step 2: Run the CI check**

Run: `npm run check:doc-counts`
Expected: All doc counts are in sync.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-doc-counts.mjs CLAUDE.md AGENTS.md README.md docs/report-cards.md docs/supply-snapshot.md
git commit -m "chore: update doc stablecoin counts for 7 pre-launch additions"
```

---

## Task 10: Final Build + Test Verification

- [ ] **Step 1: Full type-check**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 2: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Run worker tests**

Run: `cd worker && npx vitest run`
Expected: All tests pass.

- [ ] **Step 5: Run doc-counts check**

Run: `npm run check:doc-counts`
Expected: All counts in sync.

- [ ] **Step 6: Run linter**

Run: `npm run lint`
Expected: No new lint errors.

- [ ] **Step 7: Commit any remaining fixes**

If any verification steps revealed issues, fix them and commit.

---

## Task 11: Push and Monitor

- [ ] **Step 1: Push to remote**

Push the feature branch (or main if working on main).

- [ ] **Step 2: Monitor build**

Watch the CI pipeline for any failures.

- [ ] **Step 3: Verify live site**

After deployment, check:
1. Homepage shows "Upcoming Stablecoins" section after "Browse by peg"
2. Each pre-launch card links to `/stablecoin/[id]`
3. Pre-launch detail pages render the banner, timeline, editorial summary, at-a-glance grid, links, and related coins
4. Command palette shows "Pre-launch" badge for pre-launch coins
5. Main stablecoin table does NOT include pre-launch coins
6. Homepage footer stats exclude pre-launch coins from counts
7. Peg landing pages show correct coin counts (active only)
8. No 500 errors in the worker or Pages Functions logs
