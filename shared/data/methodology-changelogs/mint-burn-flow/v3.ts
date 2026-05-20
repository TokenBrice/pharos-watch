import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const MINT_BURN_FLOW_V3: readonly MethodologyChangelogEntry[] = [
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
];
