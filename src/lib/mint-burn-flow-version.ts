/** Canonical Mint/Burn Flow methodology version (no "v" prefix). */
export const MINT_BURN_FLOW_METHODOLOGY_VERSION = "4.1";

/** Display-ready Mint/Burn Flow methodology version (with "v" prefix). */
export const MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL = `v${MINT_BURN_FLOW_METHODOLOGY_VERSION}`;

/** Public changelog route for Mint/Burn Flow methodology history. */
export const MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH = "/methodology/mint-burn-flow-changelog/";

export interface MintBurnFlowMethodologyChangelogEntry {
  version: string;
  title: string;
  date: string; // YYYY-MM-DD
  effectiveAt: number; // Unix seconds (UTC)
  summary: string;
  methodologyImpact: readonly string[];
  commits: readonly string[];
  reconstructed: boolean;
}

/**
 * Reconstructed Mint/Burn Flow methodology timeline from git commit history.
 *
 * Notes:
 * - Effective timestamps use commit timestamps (UTC) of methodology-impacting changes.
 * - Entries marked reconstructed=true were inferred from commit history because
 *   mint/burn flows did not initially ship with explicit version tags.
 */
export const MINT_BURN_FLOW_METHODOLOGY_CHANGELOG: readonly MintBurnFlowMethodologyChangelogEntry[] = [
  {
    version: "4.1",
    title: "Reliability remediation and controlled backfill recovery",
    date: "2026-03-04",
    effectiveAt: 1772610868,
    summary:
      "Ingestion moved to a reliability-first runtime policy with degraded/error health signaling and operator-grade recovery controls.",
    methodologyImpact: [
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
    methodologyImpact: [
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
    methodologyImpact: [
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
    methodologyImpact: [
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
    methodologyImpact: [
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
    methodologyImpact: [
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
    methodologyImpact: [
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
    methodologyImpact: [
      "Introduced phase-1 contract coverage for 10 tracked stablecoins",
      "Shipped FIS formula, seven-band Bank Run Gauge mapping, and flight-to-quality detection thresholds",
      "Deployed incremental sync cron with `/api/mint-burn-flows` and `/api/mint-burn-events`",
    ],
    commits: ["06ad0d9", "e36a0c1", "2473c86", "fea681c"],
    reconstructed: true,
  },
] as const;

const MINT_BURN_FLOW_VERSION_WINDOWS_ASC = [...MINT_BURN_FLOW_METHODOLOGY_CHANGELOG]
  .map((entry) => ({ version: entry.version, effectiveAt: entry.effectiveAt }))
  .sort((a, b) => a.effectiveAt - b.effectiveAt);

/** Resolve Mint/Burn Flow methodology version active at a given Unix timestamp (seconds). */
export function getMintBurnFlowMethodologyVersionAt(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return MINT_BURN_FLOW_METHODOLOGY_VERSION;

  let resolved =
    MINT_BURN_FLOW_VERSION_WINDOWS_ASC[0]?.version ??
    MINT_BURN_FLOW_METHODOLOGY_VERSION;
  for (const window of MINT_BURN_FLOW_VERSION_WINDOWS_ASC) {
    if (unixSeconds >= window.effectiveAt) {
      resolved = window.version;
    } else {
      break;
    }
  }
  return resolved;
}

export function toMintBurnFlowMethodologyVersionLabel(version: string): string {
  return `v${version}`;
}
