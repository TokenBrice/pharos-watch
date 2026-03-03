/** Canonical Blacklist Tracker methodology version (no "v" prefix). */
export const BLACKLIST_TRACKER_METHODOLOGY_VERSION = "3.1";

/** Display-ready Blacklist Tracker methodology version (with "v" prefix). */
export const BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL = `v${BLACKLIST_TRACKER_METHODOLOGY_VERSION}`;

/** Public changelog route for Blacklist Tracker methodology version history. */
export const BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH = "/methodology/blacklist-tracker-changelog/";

export interface BlacklistTrackerMethodologyChangelogEntry {
  version: string;
  title: string;
  date: string; // YYYY-MM-DD
  effectiveAt: number; // Unix seconds (UTC)
  summary: string;
  trackingImpact: readonly string[];
  commits: readonly string[];
  reconstructed: boolean;
}

/**
 * Reconstructed Blacklist Tracker methodology timeline from git commit history.
 *
 * Notes:
 * - Effective timestamps use commit timestamps (UTC) of tracker-impacting changes.
 * - Entries marked reconstructed=true were inferred from commit history because the
 *   tracker did not ship with explicit methodology version tags.
 */
export const BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG: readonly BlacklistTrackerMethodologyChangelogEntry[] = [
  {
    version: "3.1",
    title: "API-error-aware sync cursor protection",
    date: "2026-02-25",
    effectiveAt: 1772013289,
    summary:
      "EVM scanning now distinguishes API failure from genuine no-event ranges so cursors do not advance on unreliable reads.",
    trackingImpact: [
      "EVM log fetching differentiates API failures (`null`) from valid empty responses (`[]`)",
      "On API failure, sync state is held and retried on the next cycle instead of advancing",
      "Metadata now reports `apiErrors` for operational observability",
    ],
    commits: ["d40060a"],
    reconstructed: true,
  },
  {
    version: "3.0",
    title: "Indexer-lag safety margins for cursor advancement",
    date: "2026-02-25",
    effectiveAt: 1772010212,
    summary:
      "Head advancement added explicit safety buffers to prevent permanently skipping late-indexed explorer events.",
    trackingImpact: [
      "EVM no-event advancement now uses `head - safetyMargin` instead of raw head",
      "Tron no-event advancement now uses `now - 15m` instead of wall-clock `now`",
      "Reduces permanent event loss when explorer indexing lags chain tip",
    ],
    commits: ["e6de7eb"],
    reconstructed: true,
  },
  {
    version: "2.2",
    title: "Precision and integrity hardening",
    date: "2026-02-18",
    effectiveAt: 1771432970,
    summary:
      "Amount math and log parsing were hardened to reduce silent corruption and improve sync telemetry.",
    trackingImpact: [
      "Token amounts switched to BigInt-safe decimal conversion to avoid large-value precision loss",
      "Malformed EVM logs (invalid block/timestamp) are discarded instead of being inserted",
      "Sync now emits structured run metadata (`itemCount`, `contractsSkipped`, budget usage)",
    ],
    commits: ["c6c1391", "7bc5361", "e950f76"],
    reconstructed: true,
  },
  {
    version: "2.1",
    title: "Pre-block balance sampling and zero-amount recovery",
    date: "2026-02-18",
    effectiveAt: 1771426563,
    summary:
      "Balance attribution moved to pre-event block semantics, and backfill began explicitly reprocessing suspicious zero blacklist amounts.",
    trackingImpact: [
      "Balance enrichment samples `blockNumber - 1` for blacklist, unblacklist, and destroy",
      "Backfill now re-attempts rows with `amount = 0` for blacklist events",
      "Reduces same-block ordering artifacts that previously produced false zeros",
    ],
    commits: ["d7e0ad4"],
    reconstructed: true,
  },
  {
    version: "2.0",
    title: "L2 balance reliability and budgeted full-scan loop",
    date: "2026-02-12",
    effectiveAt: 1770882143,
    summary:
      "Major tracking architecture shift for L2 correctness and deterministic scan coverage under strict subrequest budgets.",
    trackingImpact: [
      "Introduced shared per-run subrequest budgeting with least-synced-first config ordering",
      "L2 balance sourcing evolved from Etherscan-only to RPC/dRPC archive-aware historical balance fetches",
      "Backfill moved ahead of incremental scan and EVM head caching reduced redundant rescans",
    ],
    commits: ["58c4f05", "77dad70", "28a7ead", "add68dc", "fb7e7d6", "7d9e677"],
    reconstructed: true,
  },
  {
    version: "1.2",
    title: "Coverage expansion: USDT0 and gold contract families",
    date: "2026-02-11",
    effectiveAt: 1770795558,
    summary:
      "Expanded event coverage beyond legacy USDT/USDC patterns and fixed multiple cross-chain parsing mismatches.",
    trackingImpact: [
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
    trackingImpact: [
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
    trackingImpact: [
      "Initial incremental EVM + Tron event sync for major fiat-backed stablecoins",
      "Introduced `blacklist_events` and `blacklist_sync_state` tables",
      "Exposed tracker data through `/api/blacklist` and frontend event views",
    ],
    commits: ["093c11e", "ea9dbab", "5158601", "ac0d823"],
    reconstructed: true,
  },
] as const;

const BLACKLIST_TRACKER_VERSION_WINDOWS_ASC = [...BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG]
  .map((entry) => ({ version: entry.version, effectiveAt: entry.effectiveAt }))
  .sort((a, b) => a.effectiveAt - b.effectiveAt);

/** Resolve Blacklist Tracker methodology version active at a given Unix timestamp (seconds). */
export function getBlacklistTrackerMethodologyVersionAt(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return BLACKLIST_TRACKER_METHODOLOGY_VERSION;

  let resolved = BLACKLIST_TRACKER_VERSION_WINDOWS_ASC[0]?.version ?? BLACKLIST_TRACKER_METHODOLOGY_VERSION;
  for (const window of BLACKLIST_TRACKER_VERSION_WINDOWS_ASC) {
    if (unixSeconds >= window.effectiveAt) {
      resolved = window.version;
    } else {
      break;
    }
  }
  return resolved;
}

export function toBlacklistTrackerMethodologyVersionLabel(version: string): string {
  return `v${version}`;
}
