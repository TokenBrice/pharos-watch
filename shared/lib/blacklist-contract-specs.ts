import type { BlacklistStablecoin } from "../types/blacklist";

/**
 * Pure declarative blacklist-tracker contract specs upstream of generated
 * stablecoin registries.
 *
 * Build-time generators (such as `scripts/build-data/build-client-registry.mjs`)
 * import `BLACKLIST_TRACKED_STABLECOIN_IDS` from this module without pulling in
 * `coins.worker-runtime.generated.json` or Worker ABI/RPC helpers, avoiding a
 * bootstrap cycle on clean checkouts. `worker/src/lib/blacklist-contracts.ts`
 * consumes `BLACKLIST_CONTRACT_SPECS` as its single source of truth to resolve
 * addresses, decimals, chains, and ABI event definitions.
 */
export type BlacklistTrackedChainId =
  | "ethereum"
  | "arbitrum"
  | "base"
  | "optimism"
  | "polygon"
  | "avalanche"
  | "bsc"
  | "gnosis"
  | "tron";

export type BlacklistEventFamilyId =
  | "usdc"
  | "usdt"
  | "usdt0"
  | "usdt-upgraded"
  | "paxg"
  | "pyusd"
  | "dual-index-freeze"
  | "usd1"
  | "rlusd"
  | "usdtb"
  | "a7a5"
  | "account-freeze"
  | "frax-freeze"
  | "account-ban"
  | "added-removed-blacklist"
  | "deny-list"
  | "banned"
  | "securitize-seize"
  | "socgen-freeze"
  | "neutrl-denylist"
  | "fidelity-restriction"
  | "trueusd"
  | "centre-blocklisted"
  | "falcon-restriction";

export interface BlacklistContractSpec {
  chainId: BlacklistTrackedChainId;
  stablecoinId: string;
  stablecoin: BlacklistStablecoin;
  contractSource?: "primary" | "traded";
  contractAddressOverride?: string;
  decimalsOverride?: number;
  startBlock?: number;
  eventFamily: BlacklistEventFamilyId;
}

/**
 * Deferred-chain note (referenced inline as "deferred -- see consolidated
 * contract-creation note").
 *
 * Cause: Etherscan v2 free-tier `getcontractcreation` is only available for
 * Ethereum; it 400s on BSC, Avalanche, and Base. Without a verifiable deploy
 * block we can't bootstrap a bounded incremental sync on those chains.
 *
 * Workaround when we do add a deferred chain: use the chain's native explorer
 * (Blockscout / BscScan / Snowtrace / BaseScan) or a public-RPC `eth_getCode`
 * bisect to resolve the deploy block -- the XUSD + XAUm BSC entries landed that
 * way in Task 6.4.
 */
export const BLACKLIST_CONTRACT_SPECS: readonly BlacklistContractSpec[] = [
  // USDC
  { chainId: "ethereum", stablecoinId: "usdc-circle", stablecoin: "USDC", eventFamily: "usdc" },
  { chainId: "arbitrum", stablecoinId: "usdc-circle", stablecoin: "USDC", eventFamily: "usdc" },
  { chainId: "base", stablecoinId: "usdc-circle", stablecoin: "USDC", startBlock: 2_797_221, eventFamily: "usdc" },
  { chainId: "optimism", stablecoinId: "usdc-circle", stablecoin: "USDC", startBlock: 38_198_364, eventFamily: "usdc" },
  { chainId: "polygon", stablecoinId: "usdc-circle", stablecoin: "USDC", eventFamily: "usdc" },
  { chainId: "avalanche", stablecoinId: "usdc-circle", stablecoin: "USDC", startBlock: 7_388_829, eventFamily: "usdc" },

  // USDT (EVM)
  { chainId: "ethereum", stablecoinId: "usdt-tether", stablecoin: "USDT", eventFamily: "usdt" },
  { chainId: "arbitrum", stablecoinId: "usdt-tether", stablecoin: "USDT", eventFamily: "usdt-upgraded" },
  { chainId: "optimism", stablecoinId: "usdt-tether", stablecoin: "USDT", contractSource: "traded", startBlock: 133_193_269, eventFamily: "usdt0" },
  { chainId: "polygon", stablecoinId: "usdt-tether", stablecoin: "USDT", eventFamily: "usdt-upgraded" },
  // Avalanche has emitted the indexed family since deployment, not the legacy family.
  { chainId: "avalanche", stablecoinId: "usdt-tether", stablecoin: "USDT", startBlock: 4_663_628, eventFamily: "usdt0" },
  // Binance-Peg BSC and legacy Optimism USDT have no blacklist event surface.

  // USDT (Tron)
  { chainId: "tron", stablecoinId: "usdt-tether", stablecoin: "USDT", eventFamily: "usdt" },

  // PAXG (Ethereum only)
  { chainId: "ethereum", stablecoinId: "paxg-paxos", stablecoin: "PAXG", eventFamily: "paxg" },

  // XAUT (Ethereum only -- same event pattern as USDT0: BlockPlaced/BlockReleased/DestroyedBlockedFunds)
  { chainId: "ethereum", stablecoinId: "xaut-tether", stablecoin: "XAUT", eventFamily: "usdt0" },

  // pyUSD (Ethereum + Arbitrum)
  { chainId: "ethereum", stablecoinId: "pyusd-paypal", stablecoin: "PYUSD", eventFamily: "pyusd" },
  { chainId: "arbitrum", stablecoinId: "pyusd-paypal", stablecoin: "PYUSD", eventFamily: "pyusd" },

  // USD1 (Ethereum + BSC + Tron)
  { chainId: "ethereum", stablecoinId: "usd1-world-liberty-financial", stablecoin: "USD1", startBlock: 21_720_503, eventFamily: "usd1" },
  { chainId: "bsc", stablecoinId: "usd1-world-liberty-financial", stablecoin: "USD1", startBlock: 46_151_905, eventFamily: "usd1" },
  { chainId: "tron", stablecoinId: "usd1-world-liberty-financial", stablecoin: "USD1", eventFamily: "usd1" },

  // USDG (Paxos Global Dollar -- Ethereum only for first-wave coverage)
  { chainId: "ethereum", stablecoinId: "usdg-paxos", stablecoin: "USDG", startBlock: 20_915_336, eventFamily: "pyusd" },

  // RLUSD (Ripple USD -- Ethereum account pause/unpause; clawback is not event-covered here)
  { chainId: "ethereum", stablecoinId: "rlusd-ripple", stablecoin: "RLUSD", startBlock: 20_492_031, eventFamily: "rlusd" },

  // U (United Stables -- Ethereum + BSC, same dual-indexed freeze pattern as USD1)
  { chainId: "ethereum", stablecoinId: "u-united-stables", stablecoin: "U", startBlock: 24_030_193, eventFamily: "dual-index-freeze" },
  { chainId: "bsc", stablecoinId: "u-united-stables", stablecoin: "U", startBlock: 71_922_111, eventFamily: "dual-index-freeze" },

  // USDtb (Ethena / Anchorage -- Ethereum batch block/unblock events)
  { chainId: "ethereum", stablecoinId: "usdtb-ethena", stablecoin: "USDTB", startBlock: 21_287_284, eventFamily: "usdtb" },

  // A7A5 (Old Vector -- Ethereum only; Tron requires separate result-key verification)
  { chainId: "ethereum", stablecoinId: "a7a5-old-vector", stablecoin: "A7A5", startBlock: 22_080_045, eventFamily: "a7a5" },

  // Wave 2A direct EVM coverage
  { chainId: "ethereum", stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 17_144_262, eventFamily: "dual-index-freeze" },
  { chainId: "bsc", stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 27_850_220, eventFamily: "dual-index-freeze" },
  { chainId: "arbitrum", stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 336_278_229, eventFamily: "dual-index-freeze" },
  { chainId: "ethereum", stablecoinId: "brz-transfero", stablecoin: "BRZ", startBlock: 17_517_084, eventFamily: "usdc" },
  { chainId: "gnosis", stablecoinId: "brz-transfero", stablecoin: "BRZ", startBlock: 33_257_603, eventFamily: "usdc" },
  { chainId: "arbitrum", stablecoinId: "ausd-agora", stablecoin: "AUSD", startBlock: 342_153_906, eventFamily: "account-freeze" },
  { chainId: "base", stablecoinId: "ausd-agora", stablecoin: "AUSD", startBlock: 35_760_121, eventFamily: "account-freeze" },
  { chainId: "ethereum", stablecoinId: "euri-banking-circle", stablecoin: "EURI", startBlock: 20_217_556, eventFamily: "dual-index-freeze" },
  { chainId: "bsc", stablecoinId: "euri-banking-circle", stablecoin: "EURI", startBlock: 40_115_386, eventFamily: "dual-index-freeze" },
  { chainId: "ethereum", stablecoinId: "usdq-quantoz", stablecoin: "USDQ", startBlock: 21_179_575, eventFamily: "usdt0" },
  { chainId: "polygon", stablecoinId: "usdq-quantoz", stablecoin: "USDQ", startBlock: 69_326_454, eventFamily: "usdt0" },
  { chainId: "ethereum", stablecoinId: "usdo-openeden", stablecoin: "USDO", startBlock: 20_833_910, eventFamily: "account-ban" },
  { chainId: "base", stablecoinId: "usdo-openeden", stablecoin: "USDO", startBlock: 25_154_101, eventFamily: "account-ban" },
  { chainId: "ethereum", stablecoinId: "usdx-hex-trust", stablecoin: "USDX", startBlock: 21_062_695, eventFamily: "added-removed-blacklist" },
  { chainId: "ethereum", stablecoinId: "aid-gaib", stablecoin: "AID", startBlock: 23_682_560, eventFamily: "deny-list" },
  { chainId: "arbitrum", stablecoinId: "aid-gaib", stablecoin: "AID", startBlock: 394_608_077, eventFamily: "deny-list" },
  // AID on Base: deferred -- see consolidated contract-creation note.
  { chainId: "ethereum", stablecoinId: "tgbp-tokenised", stablecoin: "TGBP", startBlock: 23_046_391, eventFamily: "banned" },
  { chainId: "avalanche", stablecoinId: "tgbp-tokenised", stablecoin: "TGBP", startBlock: 69_696_101, eventFamily: "banned" },
  { chainId: "polygon", stablecoinId: "tgbp-tokenised", stablecoin: "TGBP", startBlock: 74_668_755, eventFamily: "banned" },
  // TGBP on Base + BSC: deferred -- see consolidated contract-creation note.

  // USDP (Paxos Pax Dollar -- same freeze pattern as PYUSD/USDG)
  { chainId: "ethereum", stablecoinId: "usdp-paxos", stablecoin: "USDP", startBlock: 6_294_931, eventFamily: "pyusd" },

  // EURC re-enabled with mirror-zero suppression
  { chainId: "ethereum", stablecoinId: "eurc-circle", stablecoin: "EURC", startBlock: 14_807_227, eventFamily: "usdc" },
  { chainId: "base", stablecoinId: "eurc-circle", stablecoin: "EURC", startBlock: 15_107_859, eventFamily: "usdc" },
  { chainId: "avalanche", stablecoinId: "eurc-circle", stablecoin: "EURC", startBlock: 26_857_185, eventFamily: "usdc" },

  // TUSD (TrueUSD) -- Ethereum proxy implementation emits both Blacklisted(address,bool) and
  // DestroyedBlackFunds(address,uint256). The ETH Blacklisted event indexes the account in
  // topics[1] and carries the direction bool at data slot 0, resolved via
  // eventTypeFromDataBoolIndex. DestroyedBlackFunds reuses USDT_DESTROYED_FUNDS_TOPIC.
  { chainId: "ethereum", stablecoinId: "tusd-trueusd", stablecoin: "TUSD", startBlock: 6_988_184, eventFamily: "trueusd" },
  // TUSD on BSC + Avalanche: deferred -- see consolidated contract-creation note.
  //   BSC proxy 0x40af3827f39d0eacbf4a168f8d4ee67c121d11c9 and Avalanche proxy
  //   0x1c20e891bab6b1727d14da358fae2984ed9b59eb both emit Blacklisted(address,bool)
  //   only (no DestroyedBlackFunds).
  // Polygon TUSD (UChildERC20Proxy at 0x2e1ad108ff1d8c782fcbbb89aad783ac49586756) is a bridged
  // token without Blacklisted / DestroyedBlackFunds events -- no blacklist pipeline to cover.
  // Optimism TUSD (L2StandardERC20 at 0xcb59a0a753fdb7491d5f3d794316f1ade197b21e) is a bridged
  // token without Blacklisted / DestroyedBlackFunds events -- no blacklist pipeline to cover.

  // NUSD (Neutrl) -- Ethereum only. Verified ABI uses separate
  // AddedToDenylist / RemovedFromDenylist events (not the DenyListUpdated
  // bool pattern the plan anticipated), so the direction is driven by topic hash.
  { chainId: "ethereum", stablecoinId: "nusd-neutrl", stablecoin: "NUSD", startBlock: 23_495_846, eventFamily: "neutrl-denylist" },

  // EURCV (Societe Generale Forge) -- Ethereum only. ERC1967 proxy delegates to
  // 0xf4ccc80c4b831a0d8d1414f2aca82a3d760ff05b which emits batch
  // AddressesFrozen/AddressesUnFrozen events. Reuses the addressArrayData path
  // already used by USDTB / AID / TGBP deny-list batches.
  { chainId: "ethereum", stablecoinId: "eurcv-societe-generale-forge", stablecoin: "EURCV", startBlock: 18_427_793, eventFamily: "socgen-freeze" },

  // USAT (Tether USAT) -- Ethereum proxy (impl 0x8b98bcd9b1f8ae112fb2b58b45c3bc9a75cc4d0e)
  // emits BlockPlaced / BlockReleased / DestroyedBlockedFunds with indexed address,
  // identical to the USDT0 family used by XAUT and USDQ.
  { chainId: "ethereum", stablecoinId: "usat-tether", stablecoin: "USAT", startBlock: 23_998_151, eventFamily: "usdt0" },

  // JPYC (JPY Coin -- CENTRE fork) -- Ethereum + Polygon. Implementation behind ERC1967Proxy
  // emits Blocklisted(address indexed) / UnBlocklisted(address indexed). JPY-pegged; price is
  // resolved via jpyc-jpyc entry in BLACKLIST_PRICE_ASSET_IDS.
  { chainId: "ethereum", stablecoinId: "jpyc-jpyc", stablecoin: "JPYC", startBlock: 22_622_960, eventFamily: "centre-blocklisted" },
  { chainId: "polygon", stablecoinId: "jpyc-jpyc", stablecoin: "JPYC", startBlock: 72_306_327, eventFamily: "centre-blocklisted" },
  // JPYC on Avalanche: deferred -- see consolidated contract-creation note.

  // FRXUSD (Frax USD) -- Ethereum only. TransparentUpgradeableProxy delegates to
  // 0x0000000048d2c8baf31742f6765383278bada4d5 which emits AccountFrozen /
  // AccountThawed with non-indexed address params (addressDataIndex: 0).
  { chainId: "ethereum", stablecoinId: "frxusd-frax", stablecoin: "FRXUSD", startBlock: 21_543_360, eventFamily: "frax-freeze" },

  // FIDD (Fidelity Digital Dollar) -- Ethereum only. ERC1967 proxy delegates to
  // 0x8ae9cb3d9095da33555494110f567e3d974c6753 which emits
  // TransferRestrictionImposed / TransferRestrictionRemoved events (plan
  // anticipated AccountRestricted / AccountUnrestricted names).
  { chainId: "ethereum", stablecoinId: "fidd-fidelity", stablecoin: "FIDD", startBlock: 16_991_820, eventFamily: "fidelity-restriction" },

  // BUIDL seize-only coverage (Securitize token family)
  { chainId: "ethereum", stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 19_343_293, eventFamily: "securitize-seize" },
  { chainId: "bsc", stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 63_931_579, eventFamily: "securitize-seize" },
  { chainId: "optimism", stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 127_565_419, eventFamily: "securitize-seize" },
  { chainId: "arbitrum", stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 270_969_308, eventFamily: "securitize-seize" },
  { chainId: "avalanche", stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 52_649_153, eventFamily: "securitize-seize" },
  { chainId: "polygon", stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 63_877_025, eventFamily: "securitize-seize" },

  // XUSD (StraitsX) -- Ethereum + BSC, Circle FiatTokenProxy pattern emits
  // Blacklisted/UnBlacklisted (USDC_EVENT_FAMILY). Implementation verified for
  // both chains; BSC deploy block resolved via public RPC eth_getCode bisect
  // (Etherscan v2 free plan does not support BSC getcontractcreation).
  { chainId: "ethereum", stablecoinId: "xusd-straitsx", stablecoin: "XUSD", startBlock: 19_132_912, eventFamily: "usdc" },
  { chainId: "bsc", stablecoinId: "xusd-straitsx", stablecoin: "XUSD", startBlock: 41_148_046, eventFamily: "usdc" },

  // XAUm (Matrixdock) -- Ethereum + BSC. Implementation emits indexed
  // BlockPlaced(address) / BlockReleased(address) with no DestroyedBlockedFunds,
  // so USDT0_EVENT_FAMILY matches the two observed events (destroy topic is
  // harmless when absent). Symbol override "XAUM" bypasses the case-sensitive
  // symbol lookup (data corpus uses "XAUm"). BSC deploy block resolved via
  // public RPC eth_getCode bisect.
  { chainId: "ethereum", stablecoinId: "xaum-matrixdock", stablecoin: "XAUM", startBlock: 20_624_233, eventFamily: "usdt0" },
  { chainId: "bsc", stablecoinId: "xaum-matrixdock", stablecoin: "XAUM", startBlock: 41_776_362, eventFamily: "usdt0" },

  // USDf (Falcon USD) -- Ethereum Wave-1 pilot (pinned block 26499592).
  // Verified implementation emits AddressRestrictionSet(address indexed,bool)
  // with direction bool at data word 0 (0 historical logs through 26499592).
  // Symbol override "USDF" bypasses the case-sensitive lookup ("USDf").
  { chainId: "ethereum", stablecoinId: "usdf-falcon", stablecoin: "USDF", startBlock: 21_818_184, eventFamily: "falcon-restriction" },

  // USDGO (OSL / AnchorageTokenV2) -- Ethereum Wave-1 pilot (pinned block 26499592).
  // Reuses Anchorage batch AccountsBlocked(address[]) / AccountsUnblocked(address[])
  // event family (3 historical block logs, 0 releases through 26499592).
  { chainId: "ethereum", stablecoinId: "usdgo-osl", stablecoin: "USDGO", startBlock: 26_000_413, eventFamily: "usdtb" },
];

/** Retired FreezeWatch identities that retain historical ledger rows without live contract scans. */
export const BLACKLIST_RETIRED_LEDGER_SPECS: readonly {
  readonly stablecoinId: string;
  readonly stablecoin: BlacklistStablecoin;
}[] = [
  { stablecoinId: "usda-avalon", stablecoin: "USDA" },
  { stablecoinId: "aeur-anchored-coins", stablecoin: "AEUR" },
];

/** Ordered unique canonical stablecoin IDs indexed by the live freeze/blacklist tracker. */
export const BLACKLIST_TRACKED_STABLECOIN_ID_LIST: readonly string[] = [
  ...new Set(BLACKLIST_CONTRACT_SPECS.map((spec) => spec.stablecoinId)),
];

/** Canonical stablecoin ID set indexed by the live freeze/blacklist tracker. */
export const BLACKLIST_TRACKED_STABLECOIN_IDS: ReadonlySet<string> = new Set(
  BLACKLIST_TRACKED_STABLECOIN_ID_LIST,
);

const BLACKLIST_STABLECOIN_BY_ID: ReadonlyMap<string, BlacklistStablecoin> = new Map(
  BLACKLIST_CONTRACT_SPECS.map((spec) => [spec.stablecoinId, spec.stablecoin]),
);

const BLACKLIST_LEDGER_STABLECOIN_BY_ID: ReadonlyMap<string, BlacklistStablecoin> = new Map([
  ...BLACKLIST_CONTRACT_SPECS.map((spec) => [spec.stablecoinId, spec.stablecoin] as const),
  ...BLACKLIST_RETIRED_LEDGER_SPECS.map((spec) => [spec.stablecoinId, spec.stablecoin] as const),
]);

const BLACKLIST_STABLECOIN_ID_BY_SYMBOL: ReadonlyMap<string, string> = new Map([
  ...BLACKLIST_CONTRACT_SPECS.map((spec) => [spec.stablecoin, spec.stablecoinId] as const),
  ...BLACKLIST_RETIRED_LEDGER_SPECS.map((spec) => [spec.stablecoin, spec.stablecoinId] as const),
]);

/** Resolve a canonical stablecoin ID to its FreezeWatch ledger symbol, or null when not live-tracked. */
export function getBlacklistStablecoinById(stablecoinId: string): BlacklistStablecoin | null {
  return BLACKLIST_STABLECOIN_BY_ID.get(stablecoinId) ?? null;
}

/** Whether a canonical stablecoin ID has live FreezeWatch contract event tracking. */
export function isBlacklistTrackedStablecoinId(stablecoinId: string): boolean {
  return BLACKLIST_TRACKED_STABLECOIN_IDS.has(stablecoinId);
}

/** Resolve a canonical stablecoin ID to its FreezeWatch ledger symbol (live-tracked or retired archive), or null when not in FreezeWatch. */
export function getBlacklistLedgerStablecoinById(stablecoinId: string): BlacklistStablecoin | null {
  return BLACKLIST_LEDGER_STABLECOIN_BY_ID.get(stablecoinId) ?? null;
}

/** Whether a canonical stablecoin ID has live FreezeWatch tracking or retained retired ledger history. */
export function hasBlacklistLedgerHistoryById(stablecoinId: string): boolean {
  return BLACKLIST_LEDGER_STABLECOIN_BY_ID.has(stablecoinId);
}

/** Resolve a FreezeWatch ledger symbol (live-tracked or retired archive) to its canonical stablecoin ID, or null when unknown. */
export function getBlacklistStablecoinIdBySymbol(symbol: string): string | null {
  return BLACKLIST_STABLECOIN_ID_BY_SYMBOL.get(symbol) ?? null;
}
