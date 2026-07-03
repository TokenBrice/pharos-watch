import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

// Versioning convention (see compareMethodologyVersions in
// @shared/lib/methodology-versions/base): each dotted segment is compared as an
// INTEGER, not a decimal fraction — so `3.997` parses to [3, 997] and sorts after
// `3.99` ([3, 99]) and `3.9` ([3, 9]). The minor segment is therefore an
// open-ended integer counter within the v3 bucket; routine changes bump it
// (…3.9 → 3.99 → 3.997 → 3.9971 → 3.9972 → 3.9973 …) and stay in this file. Create a new `v4.ts`
// (and a sibling vN file array) only for a genuine major/breaking change to the
// blacklist-tracker methodology, not merely to "roll over" the counter. There is
// no implicit cap that forces a v4; entries below are newest-first by version.
export const BLACKLIST_TRACKER_V3: readonly MethodologyChangelogEntry[] = [
  {
    version: "3.9973",
    title: "Current-balance stale warning restoration",
    date: "2026-07-02",
    effectiveAt: 1782950400, // 2026-07-02T00:00:00Z
    summary:
      "Restores stale current-balance freeze-ledger snapshots as public data-quality warnings while keeping historical bootstrap rows, permanent limitations, and deferred coverage diagnostic-only.",
    impact: [
      "Current-balance rows older than the blacklist-summary stale threshold again set `dataQuality.freezeLedger.staleSnapshotCount` and emit `stale-current-balance-snapshots`",
      "FreezeWatch data-quality status becomes `stale` when stale current-balance snapshots are present, so the public banner warns before stale tracked frozen totals are presented as healthy",
      "Bootstrap/history-preserved rows, permanently unavailable amount rows, and deferred coverage inventory remain diagnostics unless their existing actionable thresholds are crossed",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.9972",
    title: "Actionable data-quality warning scope",
    date: "2026-07-01",
    effectiveAt: 1782864000, // 2026-07-01T00:00:00Z
    summary:
      "Scopes FreezeWatch data-quality warnings to actionable degraded conditions instead of treating permanent historical limitations, deferred coverage inventory, or old resolved ledger snapshots as stale failures.",
    impact: [
      "Resolved freeze-ledger snapshots keep their age diagnostics in `freezeLedgerMeta` without opening the stale warning banner solely because the snapshot is old",
      "Permanently unavailable amount rows remain visible as audit limitations but no longer count as warning-level amount gaps",
      "Deferred coverage configs remain exposed in coverage metadata without degrading the public FreezeWatch summary by themselves",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.9971",
    title: "Legacy derived-zero retry ceiling",
    date: "2026-06-23",
    effectiveAt: 1782172800, // 2026-06-23T00:00:00Z
    summary:
      "Bounds historical amount recovery for legacy derived-zero EVM rows so unrecoverable rows stop consuming provider backfill budget every sync-blacklist run.",
    impact: [
      "Legacy derived-zero EVM rows are selected for recovery only while below the three-attempt ceiling",
      "Rows that still cannot be recovered on the final attempt are marked `permanently_unavailable` while retaining the legacy amount/source for audit context",
      "The regular recoverable/provider/ambiguous amount-gap lane remains unchanged and still runs before legacy derived-zero retries",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.997",
    title: "Same-cycle freeze snapshot capture",
    date: "2026-06-06",
    effectiveAt: 1780704000, // 2026-06-06T00:00:00Z
    summary:
      "Captures freeze-ledger snapshots for blacklist events seen in the same cron batch even when a later unblacklist event is also ingested.",
    impact: [
      "Same-batch blacklist -> unblacklist sequences now still fetch a current-balance snapshot for the freeze ledger",
      "Later unblacklist rows remain non-deleting release markers, preserving the existing historical ledger semantics",
      "The change is scoped to rows observed in the current ingestion/repair batch and does not backfill older transient freezes by itself",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.996",
    title: "Fresh price-cache valuation gate",
    date: "2026-06-06",
    effectiveAt: 1780704000, // 2026-06-06T00:00:00Z
    summary:
      "Requires non-USD blacklist ledger USD conversions to use a fresh price-cache row instead of silently reusing stale cached prices.",
    impact: [
      "A7A5, EURC, BRZ, EURI, TGBP, EURCV, JPYC, PAXG, XAUT, and XAUM freeze-ledger USD values now require a positive `price_cache` row newer than the 6-hour replay budget",
      "Stale or malformed conversion prices leave `amountUsd` unresolved so existing amount-gap status and remediation paths remain visible",
      "Current-balance snapshots, duplicate-row repair, fresh ingestion, and admin amount-gap remediation share the same freshness gate through the blacklist price-cache reader",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.995",
    title: "Full unfreezable set re-audit",
    date: "2026-05-25",
    effectiveAt: 1779667200, // 2026-05-25T00:00:00Z
    summary:
      "Re-audits every active stablecoin that resolved to `No` after the four-status FreezeWatch migration, correcting direct freeze, possible-control, and upstream reserve/redemption exposure.",
    impact: [
      "M by M0, ISC, and USG move from `No` to `Yes` based on Solana freeze authority or arbitrary holder-burn evidence",
      "DLLR, FXD, CJPY, USDQ, and USDK move to `Possible` where mutable proxy, pause, manager-burn, or protocol-control paths exist without confirmed active blacklist functions",
      "JUSD, SILK, NXUSD, LUAUSD, KRWO, and BNUSD move to `Upstream` through stablecoin reserves, DAI collateral, Open Voucher redemption rails, or Stability Fund stablecoin collateral",
      "Curated upstream reviews are honored even for centralized assets when no direct holder-token freeze surface is identified and the exposure sits in backing or redemption rails",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.994",
    title: "Four-status FreezeWatch exposure model",
    date: "2026-05-24",
    effectiveAt: 1779580800, // 2026-05-24T00:00:00Z
    summary:
      "Removes the Dilutable bucket from FreezeWatch so the surface reports holder-freeze, upstream-block, possible-control, and no-resolved-freeze exposure only. Privileged mint authority remains available through the separate Mint Authority review.",
    impact: [
      "The public `/freezewatch` exposure summary now uses Yes, Upstream, Possible, and No",
      "Freezable market-cap totals no longer include pure admin-mint dilution risk",
      "Former Dilutable assets are re-reviewed under freeze-only semantics and retain supply-control context in Mint Authority",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.993",
    title: "FreezeWatch rebrand and primary-nav promotion",
    date: "2026-05-12",
    effectiveAt: 1778544000, // 2026-05-12T00:00:00Z
    summary:
      "Promotes the Blacklist Tracker surface to a primary navigation hero under the FreezeWatch name, adding three issuer-sovereignty visualizations (Freezable Supply Meter, Intervention Seismograph, Sovereignty Lattice) above the existing intervention ledger. Event ingestion, status resolution, and the underlying coverage manifest are unchanged.",
    impact: [
      "Page moved from `/blacklist/` to `/freezewatch/` with a 301 redirect; sitemap priority raised to 0.85",
      "Primary navigation gains a 7th entry (`FreezeWatch`), replacing the `Blacklist` entry in the TRACK group",
      "User-facing copy on the surface refers to freeze interventions and issuer freezes; internal data model, table names, cron jobs, and API endpoints continue to use the `blacklist` term",
      "Three new client-side components render above the legacy intervention ledger: Freezable Supply Meter (sovereignty headline), Intervention Seismograph (quarterly cadence), Sovereignty Lattice (issuer × chain coverage grid)",
      "Analytics page identifier changed from `blacklist` to `freezewatch` for filter, sort, and search events emitted by the page",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.992",
    title: "Public contract clarification",
    date: "2026-05-11",
    effectiveAt: 1778457600, // 2026-05-11T00:00:00Z
    summary:
      "Clarifies the public blacklist contract without changing event ingestion: `/blacklist` status charts use the five-status model, CSV export covers the currently loaded table page, `/api/blacklist-summary` distinguishes legacy active-state fields from tracked freeze-ledger fields, coverage counts are manifest-derived, and chain identifiers are documented as `chainId` response/join fields rather than the `chain` display-name filter.",
    impact: [
      "The blacklist exposure model is documented as Yes, Dilutable, Upstream, Possible, and No",
      "Reserve, backing, custody, parent-asset, and CEX/custody-rail exposure resolve to Upstream through the any-reserve policy instead of Possible",
      "`/blacklist` CSV export is documented as the current server-returned page after filters, sorting, search, and pagination",
      "`/api/blacklist-summary` consumers are directed to `trackedAddressCount`, `trackedFrozenTotal`, and `trackedAmountGapCount`; legacy `active*` fields remain for local net-active state-machine compatibility",
      "Coverage docs now treat deferred config counts as runtime-manifest-derived and document the required coverage fields, including `chainId`",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.991",
    title: "Public transparency and snapshot semantics",
    date: "2026-05-05",
    effectiveAt: 1777939200, // 2026-05-05T00:00:00Z
    summary:
      "Clarifies public API artifacts, UI provenance, and freeze-ledger snapshot semantics without changing event ingestion. `/api/blacklist` integration examples now use uppercase tracker symbols, frozen totals are labeled as last-known successful snapshots, and Tron missing-balance behavior is documented as provider-missing rather than false zero.",
    impact: [
      "OpenAPI/Postman document `/api/blacklist?stablecoin=` as an uppercase blacklist-tracker symbol filter",
      "Blacklist UI/CSV surfaces amount source/status plus contract/config/event provenance",
      "Public frozen totals are presented as last-known successful freeze-ledger snapshots, with provider failures preserving the previous successful value",
      "New freeze-ledger snapshots are described as contract/config scoped, with legacy symbol/chain/address fallback for older rows",
      "Tron missing account/token-balance data remains null/provider-missing instead of being converted to zero",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.99",
    title: "Same-run Tron ledger reconciliation",
    date: "2026-04-21",
    effectiveAt: 1776729600, // 2026-04-21T00:00:00Z
    summary:
      "Reapplies the Tron freeze-ledger mirror after current-balance cache writes so newly ingested Tron blacklist rows resolve in the same `sync-blacklist` cycle, and aligns admin recovery guidance away from destructive sync resets for generic amount-gap warnings.",
    impact: [
      "Fresh Tron blacklist/unblacklist rows no longer wait for the next 6-hour cron cycle before `current_balance_snapshot` amounts appear on matching event rows",
      "The admin current-balance backfill action now re-applies the Tron ledger mirror after rebuilding `blacklist_current_balances`",
      "Blacklist-gap recommendations now prioritize balance backfill, sync-state inspection, and targeted remediation ahead of `reset-blacklist-sync`",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.98",
    title: "USDA destroy-event correction",
    date: "2026-04-20",
    effectiveAt: 1776643200, // 2026-04-20T00:00:00Z
    summary:
      "Narrows Avalon USDa event tracking to the two events its verified contract actually emits: AddedBlackList(address) and RemovedBlackList(address). USDa remains directly freezable and role-burnable, but it no longer subscribes to Tether's DestroyedBlackFunds(address,uint256) topic because the verified USDa ABI/source does not expose that event.",
    impact: [
      "USDA blacklist/unblacklist event ingestion remains unchanged",
      "USDA no longer advertises or scans a non-existent DestroyedBlackFunds event in CONTRACT_CONFIGS",
      "The report-card and blacklistability metadata still mark USDA as directly freezable because isBlackListed gates transfers and manager-controlled add/remove blacklist functions exist",
      "Role-gated burn(address,uint256) is documented as a privileged destroy capability, but not mapped to blacklist-tracker destroy rows without a dedicated destroy event",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.97",
    title: "Status amount-gap tolerance",
    date: "2026-04-19",
    effectiveAt: 1776556800, // 2026-04-19T00:00:00Z
    summary:
      "Keeps isolated recent blacklist amount gaps below the incident threshold so a single unresolved provider/parser miss among thousands of events remains visible in diagnostics without degrading `/status` or `/admin` health.",
    impact: [
      "Recent amount gaps now need at least 5 rows in the 24-hour monitoring window before data quality degrades",
      "The stale threshold remains unchanged at 25 recent gaps or a 2% missing-amount ratio",
      "The ratio-based degraded threshold remains 1%, so broad amount-attribution failures still surface promptly",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.96",
    title: "Gentle amount-gap recovery acceleration",
    date: "2026-04-18",
    effectiveAt: 1776502800, // 2026-04-18T09:00:00Z
    summary:
      "Unblocks the EVM amount recovery lane by excluding Tron rows that are owned by the separate Tron ledger mirror, and raises the per-run recovery cap from 50 to 100 rows while staying inside the 6-hour sync cadence, D1 batch helper, rate limiters, and 900-subrequest run budget.",
    impact: [
      "EVM historical amount gaps no longer wait behind recent Tron pending rows in the per-row recovery selection",
      "Amount recovery now processes up to 100 rows per 6-hour sync-blacklist run instead of 50",
      "The acceleration remains bounded by the existing 7-minute sync runtime budget, 900-subrequest cap, and shared D1 batch chunking",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.95",
    title: "Tier-1 coverage expansion",
    date: "2026-04-17",
    effectiveAt: 1776466971, // 2026-04-17T00:00:00Z
    summary:
      "Adds eleven new tracked stablecoins across four new event families and six existing families. TUSD joins through a new TRUEUSD_EVENT_FAMILY that discriminates blacklist vs unblacklist via the bool at data slot 0 through the new BlacklistEventDef.eventTypeFromDataBoolIndex extension. JPYC adds CENTRE_BLOCKLISTED_FAMILY (Blocklisted/UnBlocklisted), FRXUSD adds FRAX_FREEZE_FAMILY (AccountFrozen/AccountThawed with non-indexed address), EURCV adds SOCGEN_FREEZE_FAMILY (batch AddressesFrozen/AddressesUnFrozen), NUSD adds NEUTRL_DENYLIST_FAMILY, and FIDD adds FIDELITY_RESTRICTION_FAMILY (TransferRestrictionImposed/Removed). USDA joins through legacy AddedBlackList/RemovedBlackList signatures, while USAT, AEUR, XUSD, and XAUM reuse existing families. Several BSC/Avalanche/Base deployments remain deferred pending block-explorer API access, and apxUSD is intentionally deferred because the verified ABI exposes no direction discriminator.",
    impact: [
      "Added TUSD on Ethereum (TRUEUSD_EVENT_FAMILY with bool-discriminator Blacklisted(address,bool) + DestroyedBlackFunds)",
      "Added NUSD on Ethereum (NEUTRL_DENYLIST_FAMILY: AddedToDenylist / RemovedFromDenylist)",
      "Added EURCV on Ethereum (SOCGEN_FREEZE_FAMILY: batch AddressesFrozen(address[]) / AddressesUnFrozen(address[]))",
      "Added USDA on Ethereum using legacy AddedBlackList / RemovedBlackList signatures; USAT on Ethereum reusing USDT0 family; AEUR on Ethereum reusing DUAL_INDEX_FREEZE family",
      "Added XUSD on Ethereum + BSC reusing the Circle USDC blacklist family; XAUm on Ethereum + BSC reusing the USDT0 family",
      "Added JPYC on Ethereum + Polygon (CENTRE_BLOCKLISTED_FAMILY: Blocklisted / UnBlocklisted)",
      "Added FRXUSD on Ethereum (FRAX_FREEZE_FAMILY: AccountFrozen / AccountThawed with addressDataIndex=0)",
      "Added FIDD on Ethereum (FIDELITY_RESTRICTION_FAMILY: TransferRestrictionImposed / TransferRestrictionRemoved)",
      "BSC / Avalanche / Base deployments for TUSD, USDA, AEUR, JPYC, AID, TGBP deferred pending Etherscan v2 free-tier contract-creation coverage for those chains",
      "apxUSD deferred: verified ABI emits a single event without a direction discriminator",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.94",
    title: "Correctness + efficiency + minor coverage gaps",
    date: "2026-04-17",
    effectiveAt: 1776466970, // 2026-04-17T00:00:00Z
    summary:
      "Worker correctness fixes (Gnosis dRPC 9k-block scan cap, dual-index-freeze family split from WLFI destroy events, TronGrid failure propagation to the circuit breaker, EURC mirror-zero rows locked to permanently_unavailable, address[] expansion capped, Tron maxBlock cursor init), five D1 migrations (derived-row reset, sync_state dedup, EURC mirror-zero stamp, blacklist_events index adjustments, amount-status backfill), summary endpoint rewritten to aggregate in SQL with post-fetch counters inlined, frontend polish (data-driven stats strip, amount-status badge, per-coin stat border, CSV column split, page-clamp + filter-reset coverage), and minor chain-coverage additions (Polygon USDQ, Arbitrum AID, Polygon TGBP; Base AID plus Base/BSC TGBP remain deferred).",
    impact: [
      "Gnosis BRZ scans now stay within the dRPC free-tier 10k-block cap and drain the ~12.5M-block backlog that previously masked 2 missed events",
      "FDUSD / EURI / AEUR configs use DUAL_INDEX_FREEZE_EVENT_FAMILY without inheriting WLFI FrozenAccountDrained / FrozenFundsReallocated topics they cannot emit",
      "TronGrid outages now throw through the per-config circuit breaker instead of silently returning empty arrays",
      "EURC rows flagged as circle_mirror_zero_balance are stamped amount_status='permanently_unavailable' and no longer re-enter the recoverable-pending backfill pool",
      "Batch address[] events (USDtb, AID, EURCV) apply a per-log row cap so a single malformed payload cannot blow out the write batch",
      "Tron sync cursor initialises from max(block_number) for legacy configs that were left at 0",
      "Five D1 migrations applied: 0100 dedup mixed-case blacklist_sync_state keys, 0101 reset legacy derived amount rows, 0102 Gnosis BRZ cursor reseed, 0103 backfill + API composite indexes, 0104 stamp EURC mirror-zero rows as permanently_unavailable",
      "/api/blacklist-summary aggregates quarterly chart points and per-coin counts in SQL, dropping summary-endpoint memory from ~5-10MB to a few KB per cache miss",
      "Frontend: data-driven stats strip + amount-status badge, per-coin stat border rendered via inline style, CSV splits native / unit / USD / status columns, page-clamp + zero-total + filter-reset covered by tests",
      "Three new chain-coverage rows for existing coins: Polygon USDQ, Arbitrum AID, and Polygon TGBP; Base AID plus Base/BSC TGBP remain deferred",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.93",
    title: "Backlog-safe scanner guardrails",
    date: "2026-04-16",
    effectiveAt: 1776297602, // 2026-04-16T00:00:00Z
    summary:
      "Keeps EVM sync cursors pinned when the subrequest budget is exhausted before every configured event topic is scanned, marks budget-exhausted runs as degraded, and lowers the duplicate-row check chunk below D1's practical SQL-variable ceiling.",
    impact: [
      "Partial multi-topic EVM scans no longer advance cursors past unscanned topics",
      "Runs that skip configs after exhausting the subrequest budget now surface as degraded instead of ok",
      "Duplicate-row checks use smaller D1-safe chunks for high-row event batches",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.92",
    title: "Amount attribution: Tron ledger mirror + derived-zero recovery",
    date: "2026-04-16",
    effectiveAt: 1776297601, // 2026-04-16T00:00:00Z
    summary:
      "Introduces current_balance_snapshot amount source for Tron freeze-ledger mirroring, widens backfill to include legacy derived-zero EVM rows, and adds provenance badge for snapshot-sourced amounts.",
    impact: [
      "Tron USDT blacklist/unblacklist rows receive amounts from the freeze-ledger snapshot (~6,921 rows)",
      "Legacy derived-zero EVM rows re-enter the backfill pool (~4,381 rows)",
      "Snapshot badge renders on amounts sourced from current_balance_snapshot",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.91",
    title: "Coverage quality + USDP addition",
    date: "2026-04-16",
    effectiveAt: 1776297600, // 2026-04-16T00:00:00Z
    summary:
      "Extends wlfi-freeze family with FrozenAccountDrained/FrozenFundsReallocated destroy events (USD1/U/FDUSD/EURI), adds USDP Paxos coverage on Ethereum, and corrects Arbitrum FDUSD/AUSD/BUIDL startBlocks.",
    impact: [
      "Added FrozenAccountDrained + FrozenFundsReallocated destroy tracking for USD1/U/FDUSD/EURI",
      "Added USDP (Pax Dollar) Ethereum coverage via Paxos freeze family (65 existing events)",
      "Corrected Arbitrum startBlocks for FDUSD/AUSD/BUIDL to actual deployment blocks",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.9",
    title: "Direct EVM coverage wave",
    date: "2026-04-15",
    effectiveAt: 1776211201, // 2026-04-15T00:00:00Z
    summary:
      "Adds direct EVM blacklist/freeze coverage for FDUSD, BRZ, AUSD, MNEE, EURI, USDQ, USDO, USDX, AID, TGBP, and EURC, plus BUIDL seize-only tracking. Introduces indexed amount-topic parsing, explicit data-slot extraction for omnibus seize events, EURC mirror-zero suppression, and expanded non-USD valuation.",
    impact: [
      "Added FDUSD Ethereum/BSC/Arbitrum dual-index Freeze/Unfreeze tracking",
      "Added BRZ Ethereum/Gnosis, AUSD Arbitrum/Base, EURI Ethereum/BSC, USDQ Ethereum, USDO Ethereum/Base, USDX Ethereum, AID Ethereum, TGBP Ethereum/Avalanche, and EURC Ethereum/Base/Avalanche event coverage",
      "Added MNEE Ethereum freeze/unfreeze plus confiscation/burn tracking with indexed amount extraction",
      "Extended price-cache USD conversion to EURC, BRZ, EURI, and TGBP",
      "Added suppression metadata so Circle mirror-zero EURC rows stay auditable without entering public aggregates",
      "Added BUIDL Securitize Seize/OmnibusSeize tracking as destroy/seized-value events",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.8",
    title: "First-wave CeFi coverage expansion",
    date: "2026-04-15",
    effectiveAt: 1776211200, // 2026-04-15T00:00:00Z
    summary:
      "Expands blacklist/freeze tracking to first-wave centralized issuers with verified event surfaces: USDG, RLUSD, U, USDtb, and A7A5. Adds batch address-array parsing and non-USD A7A5 price-cache valuation while keeping clawback, allowlist/KYC, and non-EVM surfaces out of this release.",
    impact: [
      "Added USDG Ethereum FreezeAddress/UnfreezeAddress/FrozenAddressWiped coverage using the Paxos pattern",
      "Added RLUSD Ethereum AccountPaused/AccountUnpaused coverage; clawback remains out of scope until transaction-input classification exists",
      "Added U Ethereum and BSC Freeze/Unfreeze coverage using the dual-indexed address pattern",
      "Added USDtb Ethereum AccountsBlocked/AccountsUnblocked coverage with one row per address in batch events",
      "Added A7A5 Ethereum Blacklisted/DeBlacklisted/DestroyedBlackFunds coverage with price-cache USD conversion for the RUB-pegged token",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.7",
    title: "Balance recovery accuracy and provider resilience",
    date: "2026-04-08",
    effectiveAt: 1775606400, // 2026-04-08T00:00:00Z
    summary:
      "Remediates 16 audit findings across the balance recovery pipeline, freeze-ledger cache, and aggregation layer. Eliminates silent wrong-data paths, adds Ethereum mainnet dRPC/chain-RPC fallback, and fixes gold stablecoin USD conversion in all enrichment paths.",
    impact: [
      "Invalid block tags now return null instead of silently querying latest balance (Critical)",
      "Ethereum mainnet historical balance lookups now fall through dRPC and chain-RPC before Etherscan (Critical)",
      "Tron REST API returns null for missing token entries instead of false zero (Major)",
      "PAXG/XAUT events now receive USD conversion in enrichment and backfill paths (Major)",
      "Zero-balance override restricted to gold stablecoins only, preventing false non-zero cache entries (Major)",
      "XAUT now uses its own price entry instead of PAXG price (Major)",
      "Destroyed records excluded from activeFrozenTotal (Major)",
      "New Tron blacklist/unblacklist events immediately marked permanently_unavailable (Major)",
    ],
    commits: [],
    reconstructed: false,
  },
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
];
