import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const BLACKLIST_TRACKER_V1: readonly MethodologyChangelogEntry[] = [
  {
    version: "1.2",
    title: "Coverage expansion: USDT0 and gold contract families",
    date: "2026-02-11",
    effectiveAt: 1770795558,
    summary:
      "Expanded event coverage beyond legacy USDT/USDC patterns and fixed multiple cross-chain parsing mismatches.",
    impact: [
      "Added USDT0 event signatures and indexed-address parsing for upgraded Tether contracts",
      "Added PAXG and XAUT contract/event support with contract-specific mappings",
      "Per-contract decimals and Tron `0x -> 41` address normalization improved amount fidelity",
    ],
    commits: ["b257569", "9281531", "eeb92e9", "2fd5065", "29a4759"],
    reconstructed: true,
  },
  {
    version: "1.1",
    title: "Ingestion-time enrichment and backfill foundation",
    date: "2026-02-11",
    effectiveAt: 1770794846,
    summary:
      "Blacklist rows began storing balance context during ingestion, with a companion path for retroactive recovery of missing amounts.",
    impact: [
      "Blacklist/unblacklist rows are enriched with token balances before insert",
      "Backfill pipeline introduced for historical rows missing amount values",
      "Set groundwork for later destroy-event amount recovery hardening",
    ],
    commits: ["1dec7aa"],
    reconstructed: true,
  },
  {
    version: "1.0",
    title: "Initial Blacklist Tracker release",
    date: "2026-02-09",
    effectiveAt: 1770625242,
    summary:
      "Launched multi-chain blacklist event ingestion, persistence schema, public API, and dashboard surface.",
    impact: [
      "Initial incremental EVM + Tron event sync for major fiat-backed stablecoins",
      "Introduced `blacklist_events` and `blacklist_sync_state` tables",
      "Exposed tracker data through `/api/blacklist` and frontend event views",
    ],
    commits: ["093c11e", "ea9dbab", "5158601", "ac0d823"],
    reconstructed: true,
  },
];
