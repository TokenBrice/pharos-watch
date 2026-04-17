import {
  createMethodologyVersion,
} from "./methodology-version";

const mintBurnFlow = createMethodologyVersion({
  currentVersion: "6.0",
  changelogPath: "/methodology/mint-burn-flow-changelog/",
  changelog: [
  {
    version: "6.0",
    title: "Bridge classifier parity, LayerZero endpoint-only signal, canonical-chain gauge weighting",
    date: "2026-04-17",
    effectiveAt: 1776425040,
    summary:
      "Bridge classification now tags both mint and burn rows for CCIP/CCTP transactions, the LayerZero classifier recognizes endpoint-only fingerprints, and the Bank Run Gauge weights coins by their tracked-chain circulating supply rather than global supply. Atomic-roundtrip detection now requires mint/burn totals to match within 0.5%, and custom-event counterparty extraction supports unindexed address parameters.",
    impact: [
      "CCIP and CCTP bridge mints now tag as `flow_type='bridge_transfer'` (previously leaked into economic mint flow for USDC, EURC, USDO, USD1, avUSD, ZCHF)",
      "LayerZero classifier accepts endpoint-emitter signal alone, catching Executor-only mint patterns previously missed on USDai-Arbitrum",
      "Bank Run Gauge weights each coin's intensity by its circulating supply on tracked-chain scope only (e.g., USDC weighted by Ethereum supply, not global $36B+ total)",
      "Atomic-roundtrip detection requires sum(mint) and sum(burn) to match within 0.5% — partial same-tx mix is preserved as economic flow rather than erased",
      "Custom-event counterparty extraction now supports unindexed address parameters (reUSD `Deposited` user address no longer null)",
      "Historical rows reclassified via `/api/backfill-mint-burn` replay and `/api/reclassify-atomic-roundtrips` after deploy",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.2",
    title: "GYD retirement from active mint/burn coverage",
    date: "2026-04-14",
    effectiveAt: 1776169200,
    summary:
      "GYD was removed from active mint/burn flow tracking after its cross-chain contract incident left the token functionally dead and moved it to the cemetery dataset.",
    impact: [
      "Mint/burn flow configs no longer scan the Ethereum GYD token after the asset moved out of the active stablecoin registry",
      "Public flow coverage counts and stablecoin registry totals now exclude GYD from active surfaces",
      "Historical rows remain in D1 if previously ingested, but current API scope is driven by the active config registry",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.1",
    title: "Canonical-chain mint/burn scope for native issuance tracking",
    date: "2026-04-08",
    effectiveAt: 1775620800,
    summary:
      "Mint/burn coverage now follows each asset's configured issuance chain instead of assuming Ethereum-only scope, with USDai switched to native Arbitrum issuance/redemption tracking and stale non-canonical rows excluded from public aggregates.",
    impact: [
      "USDai mint/burn tracking now runs on Arbitrum as the canonical native issuance chain instead of Ethereum bridge-transfer noise",
      "Aggregate and per-coin APIs now read only configured `(stablecoinId, chainId)` pairs so stale historical rows on non-canonical chains do not contaminate public flow metrics",
      "Cron metadata, coverage helpers, status reconciliation, daily digest, and DEWS mint/burn inputs now honor chain-aware mint/burn scope",
      "Admin backfill auto-selection and explicit config replay now work across the configured issuance-chain set instead of Ethereum-only",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.0",
    title: "Bridge-transfer flow exclusion for omnichain tokens",
    date: "2026-04-08",
    effectiveAt: 1775606400,
    summary:
      "Bridge-aware classification now excludes bridge-transfer mints as well as burns, starting with USDai's LayerZero OFT path, and replay/backfill runs can repair previously inserted rows.",
    impact: [
      "LayerZero OFT transfers now mark both the mint-side and burn-side event rows as `flowType='bridge_transfer'` so they drop out of counted economic-flow aggregates",
      "USDai's Ethereum tracker now recognizes the documented USDai OAdapter / LayerZero packet flow instead of treating equal-sized bridge mints and burns as issuance activity",
      "Bridge classification now runs after all parsed rows are assembled for the config chunk, so mint-side bridge rows are visible to the classifier",
      "Replay and backfill persistence now updates `flow_type` on existing rows, allowing post-deploy repair of previously ingested bridge-transfer noise",
    ],
    commits: [],
    reconstructed: false,
  },
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
    commits: ["unreleased"],
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
    commits: ["unreleased"],
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
    commits: ["unreleased"],
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
    commits: ["unreleased"],
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
    commits: ["unreleased"],
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
    commits: ["unreleased"],
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
  {
    version: "3.2",
    title: "Event-time USD valuation for flow amounts",
    date: "2026-03-03",
    effectiveAt: 1772543607,
    summary:
      "Flow USD amounts moved from run-time spot pricing to event-time historical price attribution when available.",
    impact: [
      "Event valuation now prefers daily historical prices from `supply_history` at event day",
      "Price provenance persisted per event (`price_used`, `price_timestamp`, `price_source`)",
      "Row-drop accounting added for malformed/dust logs to improve data quality observability",
    ],
    commits: ["89ef4fa"],
    reconstructed: true,
  },
  {
    version: "3.1",
    title: "Alchemy migration and chain-aware scan controls",
    date: "2026-03-03",
    effectiveAt: 1772521900,
    summary:
      "Mint/burn ingestion migrated to Alchemy JSON-RPC with chain-specific scan behavior and stronger timestamp resolution guarantees.",
    impact: [
      "Replaced Etherscan log ingestion with Alchemy `eth_getLogs`",
      "Block timestamps now resolved in batch via `eth_getBlockByNumber`, with retry-on-missing semantics",
      "Scan ranges and safety margins calibrated per chain (including Optimism support)",
    ],
    commits: ["32f1e37", "8193ab3", "3b66c98"],
    reconstructed: true,
  },
  {
    version: "3.0",
    title: "reUSD multi-chain coverage and per-coin dedup correction",
    date: "2026-03-02",
    effectiveAt: 1772484868,
    summary:
      "Coverage expanded to Re Protocol reUSD across four chains, then corrected aggregate dedup logic to avoid multi-contract over-weighting.",
    impact: [
      "Added reUSD mint and redemption event tracking on Ethereum, Arbitrum, Base, and Avalanche",
      "Added nth-data-slot amount decoding for non-standard event payload layouts",
      "Aggregate flow loop now deduplicates by stablecoin ID to prevent duplicated rows and weighted overcounts",
    ],
    commits: ["34893a5", "aa2bcb8"],
    reconstructed: true,
  },
  {
    version: "2.1",
    title: "Grade-aware flight-to-quality classification",
    date: "2026-03-01",
    effectiveAt: 1772379888,
    summary:
      "Flight-to-quality shifted from static safe-haven lists to report-card score buckets, with fallback only when grade data is stale or missing.",
    impact: [
      "Safe/risky FTQ buckets now derive from report-card scores (safe >= 65, risky < 50, neutral ignored)",
      "Static safe-haven sets are now fallback-only for unavailable or stale report-card cache",
      "Largest-event attribution aligned to requested window semantics in aggregate mode",
    ],
    commits: ["dcdefde", "c1c1839"],
    reconstructed: true,
  },
  {
    version: "2.0",
    title: "USDT treasury-event capture and partial-data gauge support",
    date: "2026-03-01",
    effectiveAt: 1772375712,
    summary:
      "Coverage and scoring robustness were upgraded to capture USDT treasury mint/burn events and keep the gauge active during early-history ramp.",
    impact: [
      "Added `startBlock` per config for near-history initialization instead of scanning from genesis",
      "USDT now tracks `Issue` and `Redeem` events that do not emit standard `Transfer` mints/burns",
      "Gauge now computes from available non-null FIS inputs instead of returning null when any coin lacks sufficient history",
    ],
    commits: ["2144236", "1eddad0"],
    reconstructed: true,
  },
  {
    version: "1.0",
    title: "Initial Mint/Burn Flow release",
    date: "2026-03-01",
    effectiveAt: 1772369418,
    summary:
      "Launched baseline mint/burn flow tracking, scoring primitives, and public API surfaces for aggregate and per-coin analysis.",
    impact: [
      "Introduced phase-1 contract coverage for 10 tracked stablecoins",
      "Shipped FIS formula, seven-band Bank Run Gauge mapping, and flight-to-quality detection thresholds",
      "Deployed incremental sync cron with `/api/mint-burn-flows` and `/api/mint-burn-events`",
    ],
    commits: ["06ad0d9", "e36a0c1", "2473c86", "fea681c"],
    reconstructed: true,
  },
  ],
});

/** Display-ready Mint/Burn Flow methodology version (with "v" prefix). */
export const MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL = mintBurnFlow.versionLabel;

/** Public changelog route for Mint/Burn Flow methodology history. */
export const MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH = mintBurnFlow.changelogPath;

/** Reconstructed changelog data. */
export const MINT_BURN_FLOW_METHODOLOGY_CHANGELOG = mintBurnFlow.changelog;
