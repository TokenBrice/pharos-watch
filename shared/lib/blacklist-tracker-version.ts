import { createMethodologyVersion } from "./methodology-version";

const blacklistTracker = createMethodologyVersion({
  currentVersion: "3.6",
  changelogPath: "/methodology/blacklist-tracker-changelog/",
  changelog: [
  {
    version: "3.6",
    title: "Freeze-ledger quarter attribution for the public chart",
    date: "2026-03-27",
    effectiveAt: 1774645600,
    summary:
      "The public blacklist chart now buckets the persistent freeze ledger by blacklist quarter instead of summing raw event-time blacklist rows, so the quarterly bars explain the same tracked frozen total shown in the summary cards.",
    impact: [
      "The `/api/blacklist-summary` chart now draws from `blacklist_current_balances` rather than raw `blacklist_events` intake amounts",
      "Each tracked balance is attributed to the latest recorded blacklist event for the same stablecoin/chain/address identity so re-blacklisted rows follow the active freeze cycle represented in the ledger",
      "Rows without a local blacklist timestamp fall back to the latest related event timestamp, then snapshot observation time, so tracked ledger value is not silently dropped from the chart",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.5",
    title: "Persistent freeze-ledger snapshots and bootstrap reconciliation",
    date: "2026-03-27",
    effectiveAt: 1774616400,
    summary:
      "The public frozen-total summary now uses a persistent freeze ledger instead of treating snapshot balances as a live current-state cache. Historical ETH/USDC, ETH/USDT, and TRON/USDT freeze rows were reconciled from the kyc.rip / stables.rip bootstrap so seized-and-burned balances remain visible after later unblacklist or destroy actions.",
    impact: [
      "Added tracked freeze-ledger metrics (`trackedAddressCount`, `trackedFrozenTotal`, `trackedAmountGapCount`) to blacklist summary responses",
      "Snapshot rows are now preserved across later unblacklist events instead of being deleted as if they were only live current balances",
      "Destroy events now persist their seized amount into the freeze ledger so burned balances remain counted",
      "Historical freeze-ledger bootstrap was reconciled against the external kyc.rip / stables.rip dataset for ETH USDC, ETH USDT, and TRON USDT",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.4",
    title: "Active frozen-total ledger and Tron current-balance separation",
    date: "2026-03-27",
    effectiveAt: 1774612800,
    summary:
      "Blacklist summary now distinguishes event-time amounts from active frozen balances, adds a dedicated current-balance cache for active blacklist records, and stops treating legacy Tron derived event amounts as authoritative history.",
    impact: [
      "Added `blacklist_current_balances` for current active blacklist balance snapshots",
      "Blacklist summary gained active-record metrics (`activeAddressCount`, `activeFrozenTotal`, `activeAmountGapCount`)",
      "Active Tron totals now prefer current TRC20 balances for active blacklist rows and destroy-event amounts when funds were seized and burned",
      "Legacy Tron `derived` blacklist/unblacklist event amounts are reset instead of being reused as event-time history",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.3",
    title: "pyUSD and USD1 blacklist tracking coverage",
    date: "2026-03-24",
    effectiveAt: 1774353600,
    summary:
      "Extended blacklist tracker to cover pyUSD (PayPal/Paxos) on Ethereum and Arbitrum, and USD1 (World Liberty Financial) on Ethereum, BSC, and Tron. Introduced configurable address topic index for two-indexed-address events.",
    impact: [
      "Added pyUSD FreezeAddress/UnfreezeAddress/FrozenAddressWiped event tracking (Paxos PaxosTokenV2 pattern)",
      "Added USD1 Freeze/Unfreeze event tracking with addressTopicIndex=2 for dual-indexed events",
      "EVM parser now supports configurable topic index for affected address extraction",
      "Tron parser extended with tronResultKey for non-standard event parameter names",
      "Aggregation layer (chart, summary stats) made dynamic to accommodate new stablecoins",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.2",
    title: "Provenance-aware rows and explicit amount semantics",
    date: "2026-03-24",
    effectiveAt: 1774310400,
    summary:
      "Blacklist rows now persist emitting-contract provenance and explicit native/USD amount status fields so reprocessing and public consumers no longer rely on implicit inference.",
    impact: [
      "Rows now store config/contract provenance plus event signature metadata",
      "Amount semantics split into token-native and USD-at-event fields with explicit source/status flags",
      "Gap monitoring now tracks recoverable attribution failures rather than nullable amounts alone",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.1",
    title: "API-error-aware sync cursor protection",
    date: "2026-02-25",
    effectiveAt: 1772013289,
    summary:
      "EVM scanning now distinguishes API failure from genuine no-event ranges so cursors do not advance on unreliable reads.",
    impact: [
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
    impact: [
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
    impact: [
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
    impact: [
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
    impact: [
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
  ],
});

/** Canonical Blacklist Tracker methodology version (no "v" prefix). */
export const BLACKLIST_TRACKER_METHODOLOGY_VERSION = blacklistTracker.currentVersion;

/** Display-ready Blacklist Tracker methodology version (with "v" prefix). */
export const BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL = blacklistTracker.versionLabel;

/** Public changelog route for Blacklist Tracker methodology history. */
export const BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH = blacklistTracker.changelogPath;

/** Reconstructed changelog data. */
export const BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG = blacklistTracker.changelog;

/** Resolve Blacklist Tracker methodology version active at a given Unix timestamp (seconds). */
export const getBlacklistTrackerMethodologyVersionAt = blacklistTracker.getVersionAt;
