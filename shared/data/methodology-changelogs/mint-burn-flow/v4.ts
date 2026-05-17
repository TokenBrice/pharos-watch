import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const MINT_BURN_FLOW_V4: readonly MethodologyChangelogEntry[] = [
  {
    version: "4.9",
    title: "Deterministic repair loops and adapter provenance disclosures",
    date: "2026-03-24",
    effectiveAt: 1774351800,
    summary:
      "Mint/burn repair and coverage semantics were tightened through historical-first valuation repair, deterministic cleanup backlogs, aligned FTQ classification, and explicit adapter provenance on public coverage metadata.",
    impact: [
      "Historical price repair now values events from event-day `supply_history` instead of current `price_cache` snapshots",
      "NULL-price healing and atomic-roundtrip sweeping now use deterministic ordered backlog queries",
      "The daily digest now shares the same report-card-cache FTQ classification semantics as `/api/mint-burn-flows`",
      "Per-coin coverage now exposes `adapterKinds`, `startBlockSource`, and `startBlockConfidence` so blanket start-block defaults are visible in the API",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.8",
    title: "Ethereum coverage wave for long-tail mint/burn tracking",
    date: "2026-03-24",
    effectiveAt: 1774348200,
    summary:
      "Mint/burn flow coverage expanded materially by restoring and adding long-tail Ethereum ERC-20 configs that can be tracked with the standard zero-address Transfer path.",
    impact: [
      "Added 40 additional Ethereum transfer-based configs for previously uncovered tracked assets",
      "Extended flow coverage now includes more long-tail fiat, non-USD, commodity, and yield-bearing assets where shared metadata already exposes an Ethereum contract",
      "Coverage scope increased from 84 contract configs / 83 stablecoin IDs to 124 contract configs / 123 stablecoin IDs while preserving the existing critical-lane set",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.7",
    title: "Closed-day baseline, fixed aggregate 24h semantics, and coverage disclosures",
    date: "2026-03-10",
    effectiveAt: 1773144000,
    summary:
      "Pressure Shift now compares live 24-hour flows against trailing fully closed daily baselines, aggregate API 24h fields are fixed regardless of chart window, and the product now exposes Ethereum-only scope plus coverage/freshness metadata.",
    impact: [
      "Pressure Shift baseline now excludes the current UTC day and uses the last 30 fully closed daily buckets",
      "Aggregate `/api/mint-burn-flows?hours=N` now keeps coin-level 24h fields fixed to the canonical 24h window while only the hourly series respects `hours`",
      "Aggregate flow API now exposes `scope`, `sync`, `windowHours`, and per-coin `coverage` metadata",
      "The `/flows` page now labels the feature as Ethereum-only and visually marks partial-history or lagging coverage states",
      "Flow freshness headers now follow successful sync timestamps instead of latest event timestamps, avoiding false staleness during quiet periods",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.6",
    title: "Safe-frontier ingestion and counted event-history alignment",
    date: "2026-03-09",
    effectiveAt: 1773057600,
    summary:
      "Mint/burn ingestion now advances only to a shared safe coverage frontier under partial scans, and product event-history surfaces now default to counted economic-flow rows.",
    impact: [
      "Partial event-definition coverage no longer advances sync state past uncovered log ranges",
      "Missing block timestamps now cap advancement at the earliest unresolved block instead of silently skipping rows forever",
      "The event API now exposes `flowType` and supports `scope=counted` for rows that participate in aggregates",
      "Detail-page flow history now excludes bridge burns, review-required burns, and atomic roundtrips by default",
      "Unpriced event rows now render native token amounts instead of false dollar values",
      "`minAmount` filtering is now strictly USD-only when `amountUsd` is available",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.5",
    title: "Data quality: noise filtering, auto-heal, and activity gating",
    date: "2026-03-09",
    effectiveAt: 1773014400,
    summary:
      "Improves flow data reliability by excluding flash-loan roundtrips from aggregation, auto-healing missing USD prices, and gating pressure shift for low-activity coins.",
    impact: [
      "Transactions containing both mint and burn for the same token (flash loans, atomic arb) are now flagged as atomic_roundtrip and excluded from all flow aggregates",
      "Events synced without USD price are now automatically backfilled within 48h by the sync cron",
      "Coins with less than $50K absolute 24h flow now return NR instead of a potentially misleading pressure shift score",
      "New observability counters in cron metadata: atomicRoundtripsDetected, nullPricesHealed",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.4",
    title: "Two-signal flow semantics and baseline-aware interpretation",
    date: "2026-03-07",
    effectiveAt: 1772841600,
    summary:
      "Per-coin flow UI now separates raw 24h net flow from baseline-relative pressure shift while preserving the underlying formula.",
    impact: [
      "Per-coin flow UI now separates raw 24h net flow from baseline-relative pressure shift",
      "API now exposes canonical `pressureShiftScore` and interpretation fields while retaining `flowIntensity` as a deprecated alias",
      "Frontend printer and shredder visuals now key off actual net flow direction instead of score sign",
      "Methodology and product copy now distinguish current direction from pressure-versus-baseline context",
    ],
    commits: [],
    reconstructed: true,
  },
  {
    version: "4.3",
    title: "NR gating for no-activity flow windows",
    date: "2026-03-04",
    effectiveAt: 1772655490,
    summary:
      "Coins with no mint/burn activity in the active 24h window now publish NR flow intensity and are excluded from gauge weighting.",
    impact: [
      "Removed synthetic neutral intensity fallback for sparse no-activity windows",
      "No-activity windows now return `flowIntensity = null` (NR) instead of `0`",
      "Bank Run Gauge now excludes those NR windows from the market-cap-weighted composite",
      "Frontend flow-intensity UI now displays NR explicitly for null values",
    ],
    commits: [],
    reconstructed: true,
  },
  {
    version: "4.2",
    title: "Signed zero-baseline flow-intensity semantics",
    date: "2026-03-04",
    effectiveAt: 1772614800,
    summary:
      "Flow Intensity Score and Bank Run Gauge moved from midpoint semantics to canonical signed outputs centered at zero baseline.",
    impact: [
      "Flow Intensity Score now emits signed values via `clamp(-100, 100, z * 50)`",
      "Gauge score now uses signed -100 to +100 output with neutral baseline at 0",
      "Band thresholds were remapped around zero while retaining existing band labels",
      "Frontend midpoint conversion shim was removed; UI now consumes canonical signed API values directly",
    ],
    commits: [],
    reconstructed: true,
  },
  {
    version: "4.1",
    title: "Reliability remediation and controlled backfill recovery",
    date: "2026-03-04",
    effectiveAt: 1772610868,
    summary:
      "Ingestion moved to a reliability-first runtime policy with degraded/error health signaling and operator-grade recovery controls.",
    impact: [
      "Added run-state rotation plus per-chain quotas so coverage remains balanced under budget pressure",
      "Added degraded/error escalation from sustained low coverage or repeated API failures",
      "Introduced authenticated chunked backfill endpoint (`/api/backfill-mint-burn`) reusing ingestion parsing and aggregation",
    ],
    commits: ["20f56c3"],
    reconstructed: true,
  },
  {
    version: "4.0",
    title: "reUSD deposit amount scale correction",
    date: "2026-03-04",
    effectiveAt: 1772609391,
    summary:
      "Fixed a scale mismatch in reUSD mint decoding that overstated deposit-side mint volume.",
    impact: [
      "reUSD `Deposited` events now decode with 18 decimals instead of 6",
      "Removed artificial inflation in reUSD mint flow and related aggregates",
      "Added regression test validating a known on-chain `Deposited` payload decodes to 10 tokens",
    ],
    commits: ["a49abfa"],
    reconstructed: true,
  },
];
