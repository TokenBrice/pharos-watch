import { CHAIN_META } from "@shared/lib/chains";
import {
  BLACKLIST_STABLECOINS,
  type BlacklistStablecoin,
  type BlacklistEventType,
} from "@shared/types/market";
import { getTrackedStablecoin } from "@shared/lib/tracked-stablecoin-utils";
import { resolveRequiredTrackedContractConfig } from "./tracked-contract-resolution";

export interface ChainConfig {
  chainId: string;          // Internal identifier (e.g. "ethereum")
  chainName: string;
  evmChainId: number | null; // Numeric EVM chain ID for Etherscan v2 API (null for non-EVM)
  explorerUrl: string;       // Block explorer for tx/address links
  type: "evm" | "tron" | "other";
}

export interface ContractEventConfig {
  configKey: string;
  chain: ChainConfig;
  stablecoinId: string;
  stablecoin: BlacklistStablecoin;
  contractAddress: string;
  decimals: number;        // Token decimals (6 for USDC/USDT/XAUT, 18 for PAXG)
  startBlock?: number;     // Optional deployment/start block for initial sync bootstrapping
  events: BlacklistEventDef[];
}

export interface BlacklistEventDef {
  signature: string;     // Human-readable event signature
  topicHash: string;     // Keccak256 of the event signature
  eventType: BlacklistEventType;
  hasAmount: boolean;
  addressTopicIndex?: number;  // EVM: which topics[] slot holds the affected address (default 1)
  addressDataIndex?: number;   // EVM: which 32-byte data slot holds the affected address
  addressArrayData?: boolean;  // EVM: event data is ABI-encoded address[]; emits one row per address
  amountTopicIndex?: number;   // EVM: which topics[] slot holds an indexed uint256 amount
  amountDataIndex?: number;    // EVM: which 32-byte data slot holds a non-indexed uint256 amount
  tronResultKey?: string;      // Tron: which result key holds the affected address
}

export interface BlacklistEventFamily {
  key: string;
  events: readonly BlacklistEventDef[];
}

interface ContractEventConfigSpec {
  chain: ChainConfig;
  stablecoinId: string;
  stablecoin?: BlacklistStablecoin;
  contractSource?: "primary" | "traded";
  contractAddressOverride?: string;
  decimalsOverride?: number;
  startBlock?: number;
  events: readonly BlacklistEventDef[];
}

// --- Chain configurations (derived from shared CHAIN_META) ---

export function chainConfig(chainId: string): ChainConfig {
  const meta = CHAIN_META[chainId];
  if (!meta) throw new Error(`Unknown chain: ${chainId}`);
  return {
    chainId,
    chainName: meta.name,
    evmChainId: meta.evmChainId,
    explorerUrl: meta.explorerUrl,
    type: meta.type,
  };
}

const ETHEREUM  = chainConfig("ethereum");
const ARBITRUM  = chainConfig("arbitrum");
const BASE      = chainConfig("base");
const OPTIMISM  = chainConfig("optimism");
const POLYGON   = chainConfig("polygon");
const AVALANCHE = chainConfig("avalanche");
const BSC       = chainConfig("bsc");
const GNOSIS    = chainConfig("gnosis");
const TRON      = chainConfig("tron");

// --- Event topic hashes (Keccak256) ---

// USDC events
const USDC_BLACKLISTED_TOPIC = "0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855"; // Blacklisted(address)
const USDC_UNBLACKLISTED_TOPIC = "0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e"; // UnBlacklisted(address)

// USDT events (legacy: Ethereum, Tron, and pre-USDT0 L2 contracts)
const USDT_ADDED_BLACKLIST_TOPIC = "0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc"; // AddedBlackList(address)
const USDT_REMOVED_BLACKLIST_TOPIC = "0xd7e9ec6e6ecd65492dce6bf513cd6867560d49544421d0783ddf06e76c24470c"; // RemovedBlackList(address)
const USDT_DESTROYED_FUNDS_TOPIC = "0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6"; // DestroyedBlackFunds(address,uint256)

// USDT0 events (new Tether L2 contract: WithBlockedList + TetherToken, uses indexed address)
const USDT0_BLOCK_PLACED_TOPIC = "0x406bbf2d8d145125adf1198d2cf8a67c66cc4bb0ab01c37dccd4f7c0aae1e7c7"; // BlockPlaced(address indexed)
const USDT0_BLOCK_RELEASED_TOPIC = "0x665918c9e02eb2fd85acca3969cb054fc84c138e60ec4af22ab6ef2fd4c93c27"; // BlockReleased(address indexed)
const USDT0_DESTROYED_FUNDS_TOPIC = "0x6a2859ae7902313752498feb80a014e6e7275fe964c79aa965db815db1c7f1e9"; // DestroyedBlockedFunds(address indexed,uint256)

// --- USDC event definitions ---

function defineEventFamily(key: string, events: readonly BlacklistEventDef[]): BlacklistEventFamily {
  return { key, events };
}

const USDC_EVENT_FAMILY = defineEventFamily("circle-blacklist", [
  {
    signature: "Blacklisted(address)",
    topicHash: USDC_BLACKLISTED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "UnBlacklisted(address)",
    topicHash: USDC_UNBLACKLISTED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- USDT event definitions ---

const USDT_EVENT_FAMILY = defineEventFamily("tether-legacy-blacklist", [
  {
    signature: "AddedBlackList(address)",
    topicHash: USDT_ADDED_BLACKLIST_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "RemovedBlackList(address)",
    topicHash: USDT_REMOVED_BLACKLIST_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
  {
    signature: "DestroyedBlackFunds(address,uint256)",
    topicHash: USDT_DESTROYED_FUNDS_TOPIC,
    eventType: "destroy",
    hasAmount: true,
  },
]);

// --- USDT0 event definitions (Arbitrum and other USDT0-upgraded L2s) ---
// These use indexed address params, so the address is in topics[1] not data.

const USDT0_EVENT_FAMILY = defineEventFamily("tether-indexed-blacklist", [
  {
    signature: "BlockPlaced(address)",
    topicHash: USDT0_BLOCK_PLACED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "BlockReleased(address)",
    topicHash: USDT0_BLOCK_RELEASED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
  {
    signature: "DestroyedBlockedFunds(address,uint256)",
    topicHash: USDT0_DESTROYED_FUNDS_TOPIC,
    eventType: "destroy",
    hasAmount: true,
  },
]);

// Combined: listen for both legacy and USDT0 events on chains where
// the old bridged USDT was upgraded in-place to USDT0 (Arbitrum, Polygon)
const USDT_UPGRADED_EVENT_FAMILY = defineEventFamily("tether-upgraded-blacklist", [
  ...USDT_EVENT_FAMILY.events,
  ...USDT0_EVENT_FAMILY.events,
]);

// --- PAXG event definitions ---
// AddressFrozen/AddressUnfrozen/FrozenAddressWiped — address is indexed (in topics[1])

const PAXG_FROZEN_TOPIC = "0x90811a8edd3b3c17eeaefffc17f639cc69145d41a359c9843994dc2538203690"; // AddressFrozen(address)
const PAXG_UNFROZEN_TOPIC = "0xc3776b472ebf54114339eec9e4dc924e7ce307a97f5c1ee72b6d474e6e5e8b7c"; // AddressUnfrozen(address)
const PAXG_WIPED_TOPIC = "0xfc5960f1c5a5d2b60f031bf534af053b1bf7d9881989afaeb8b1d164db23aede"; // FrozenAddressWiped(address)

const PAXG_EVENT_FAMILY = defineEventFamily("paxos-freeze", [
  {
    signature: "AddressFrozen(address)",
    topicHash: PAXG_FROZEN_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "AddressUnfrozen(address)",
    topicHash: PAXG_UNFROZEN_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
  {
    signature: "FrozenAddressWiped(address)",
    topicHash: PAXG_WIPED_TOPIC,
    eventType: "destroy",
    hasAmount: false, // Amount not in event; fetched via balanceOf at blockNumber-1
  },
]);

// --- pyUSD event definitions (Paxos PaxosTokenV2 contract) ---
// FreezeAddress/UnfreezeAddress/FrozenAddressWiped — address is indexed (in topics[1])

const PYUSD_FREEZE_TOPIC = "0x1aa660498c83ea285bc55e4cfc00afcaa7120798db87b74f3c0d7c6e001bc392"; // FreezeAddress(address)
const PYUSD_UNFREEZE_TOPIC = "0x150465b020dfc06a59269da94ed66db9b65a516cf4fdd5f583b0f12752339bbe"; // UnfreezeAddress(address)
const PYUSD_WIPED_TOPIC = PAXG_WIPED_TOPIC; // FrozenAddressWiped(address) — same signature as PAXG

const PYUSD_EVENT_FAMILY = defineEventFamily("paxos-pyusd-freeze", [
  {
    signature: "FreezeAddress(address)",
    topicHash: PYUSD_FREEZE_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "UnfreezeAddress(address)",
    topicHash: PYUSD_UNFREEZE_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
  {
    signature: "FrozenAddressWiped(address)",
    topicHash: PYUSD_WIPED_TOPIC,
    eventType: "destroy",
    hasAmount: false, // Amount not in event; fetched via balanceOf at blockNumber-1
  },
]);

// --- USD1 event definitions (World Liberty Financial Stablecoin contract) ---
// Freeze(address indexed caller, address indexed account) / Unfreeze — affected address in topics[2]

const USD1_FREEZE_TOPIC = "0x51d18786e9cb144f87d46e7b796309ea84c7c687d91e09c97f051eacf59bc528"; // Freeze(address,address)
const USD1_UNFREEZE_TOPIC = "0x4f3ab9ff0cc4f039268532098e01239544b0420171876e36889d01c62c784c79"; // Unfreeze(address,address)

const USD1_EVENT_FAMILY = defineEventFamily("wlfi-freeze", [
  {
    signature: "Freeze(address,address)",
    topicHash: USD1_FREEZE_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
    addressTopicIndex: 2,
    tronResultKey: "account",
  },
  {
    signature: "Unfreeze(address,address)",
    topicHash: USD1_UNFREEZE_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
    addressTopicIndex: 2,
    tronResultKey: "account",
  },
]);

// --- RLUSD event definitions (Ripple StablecoinUpgradeableV2 contract) ---
// AccountPaused/AccountUnpaused — affected address is non-indexed in data

const RLUSD_ACCOUNT_PAUSED_TOPIC = "0xae7f60c1b8f645c3beffeb531169cbc446874bbf247698325318879ac850c346"; // AccountPaused(address)
const RLUSD_ACCOUNT_UNPAUSED_TOPIC = "0x0c18efbde61ac471ead6960a3f1097735c68ecdb685ae8e2a108c28385399a65"; // AccountUnpaused(address)

const RLUSD_EVENT_FAMILY = defineEventFamily("ripple-account-pause", [
  {
    signature: "AccountPaused(address)",
    topicHash: RLUSD_ACCOUNT_PAUSED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "AccountUnpaused(address)",
    topicHash: RLUSD_ACCOUNT_UNPAUSED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- USDTB event definitions (Anchorage / Ethena USDtb contract) ---
// AccountsBlocked/AccountsUnblocked — event data is a dynamic address[].

const USDTB_ACCOUNTS_BLOCKED_TOPIC = "0x5444f9841c04ce78987f28701fa07fc4c112840c1c8439e8f52bda50c3788a87"; // AccountsBlocked(address[])
const USDTB_ACCOUNTS_UNBLOCKED_TOPIC = "0x4a637dd1cd99ae43d353009d0ffbc16b05cc69808b819ebf852c68ea47b34dd4"; // AccountsUnblocked(address[])

const USDTB_EVENT_FAMILY = defineEventFamily("anchorage-batch-block", [
  {
    signature: "AccountsBlocked(address[])",
    topicHash: USDTB_ACCOUNTS_BLOCKED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
    addressArrayData: true,
  },
  {
    signature: "AccountsUnblocked(address[])",
    topicHash: USDTB_ACCOUNTS_UNBLOCKED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
    addressArrayData: true,
  },
]);

// --- A7A5 event definitions (Old Vector RUB-backed token) ---
// Blacklisted/DeBlacklisted addresses are non-indexed in event data.

const A7A5_DEBLACKLISTED_TOPIC = "0x8e6c9e5ceff66044a0b27759779a9be2e7c99655252b235ff3f754efb6b8a616"; // DeBlacklisted(address)

const A7A5_EVENT_FAMILY = defineEventFamily("a7a5-blacklist", [
  {
    signature: "Blacklisted(address)",
    topicHash: USDC_BLACKLISTED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "DeBlacklisted(address)",
    topicHash: A7A5_DEBLACKLISTED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
  {
    signature: "DestroyedBlackFunds(address,uint256)",
    topicHash: USDT_DESTROYED_FUNDS_TOPIC,
    eventType: "destroy",
    hasAmount: true,
  },
]);

// --- AccountFrozen/AccountUnfrozen event definitions (Agora AUSD) ---

const ACCOUNT_FROZEN_TOPIC = "0x4f2a367e694e71282f29ab5eaa04c4c0be45ac5bf2ca74fb67068b98bdc2887d"; // AccountFrozen(address)
const ACCOUNT_UNFROZEN_TOPIC = "0xf915cd9fe234de6e8d3afe7bf2388d35b2b6d48e8c629a24602019bde79c213a"; // AccountUnfrozen(address)

const ACCOUNT_FREEZE_EVENT_FAMILY = defineEventFamily("account-freeze", [
  {
    signature: "AccountFrozen(address)",
    topicHash: ACCOUNT_FROZEN_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "AccountUnfrozen(address)",
    topicHash: ACCOUNT_UNFROZEN_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- MNEE freeze/confiscation event definitions ---

const MNEE_FUNDS_CONFISCATED_TOPIC = "0x5a592536e075e29026312219123e24de374314962469686d4c992d3c7292c1b4"; // FundsConfiscated(address,uint256,address)
const MNEE_HOLDINGS_BURNT_TOPIC = "0x1b560ad975f2a2685fce792af7ad191c5f1c0bfbbf108c676319be3ccb014ddf"; // HoldingsBurnt(address,uint256)

const MNEE_EVENT_FAMILY = defineEventFamily("mnee-freeze-confiscation", [
  ...ACCOUNT_FREEZE_EVENT_FAMILY.events,
  {
    signature: "FundsConfiscated(address,uint256,address)",
    topicHash: MNEE_FUNDS_CONFISCATED_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    amountTopicIndex: 2,
  },
  {
    signature: "HoldingsBurnt(address,uint256)",
    topicHash: MNEE_HOLDINGS_BURNT_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    amountTopicIndex: 2,
  },
]);

// --- OpenEden / tokenized issuer account ban events ---

const ACCOUNT_BANNED_TOPIC = "0xf5ccd95e2294edead25b59a71c189b3543cffbde2ec0d763800bdcc8807c7c3e"; // AccountBanned(address)
const ACCOUNT_UNBANNED_TOPIC = "0xc98af8f4ec4ddc4c9cd83aa9d9adbf34053062dc51ad93a562c787c2cc5dbc47"; // AccountUnbanned(address)

const ACCOUNT_BAN_EVENT_FAMILY = defineEventFamily("account-ban", [
  {
    signature: "AccountBanned(address)",
    topicHash: ACCOUNT_BANNED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "AccountUnbanned(address)",
    topicHash: ACCOUNT_UNBANNED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- Hex Trust blacklist events ---

const ADDED_BLACKLIST_TOPIC = "0x86c048150dfc5def3c35f7bc81582956dd964e56d8c028c9f4f5e978bb203c31"; // AddedBlacklist(address)
const REMOVED_BLACKLIST_TOPIC = "0x90792cb7177eb70be35a14e39400d4143370da97f528237fd2b069e408ca68fb"; // RemovedBlacklist(address)

const ADDED_REMOVED_BLACKLIST_EVENT_FAMILY = defineEventFamily("added-removed-blacklist", [
  {
    signature: "AddedBlacklist(address)",
    topicHash: ADDED_BLACKLIST_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "RemovedBlacklist(address)",
    topicHash: REMOVED_BLACKLIST_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- Deny-list batch events ---

const ADDED_TO_DENY_LIST_TOPIC = "0x02dd2f2ab1d45714c6f178e8ff8c5594023ec5d134bb99bbb230adabdb718c05"; // AddedToDenyList(address[])
const REMOVED_FROM_DENY_LIST_TOPIC = "0xfe849628f690f8527fe506998b4ddf44a5b11ecb3ec64257db0951b62d9a4f38"; // RemovedFromDenyList(address[])

const DENY_LIST_EVENT_FAMILY = defineEventFamily("deny-list", [
  {
    signature: "AddedToDenyList(address[])",
    topicHash: ADDED_TO_DENY_LIST_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
    addressArrayData: true,
  },
  {
    signature: "RemovedFromDenyList(address[])",
    topicHash: REMOVED_FROM_DENY_LIST_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
    addressArrayData: true,
  },
]);

// --- Tokenised GBP ban events ---

const BANNED_TOPIC = "0x30d1df1214d91553408ca5384ce29e10e5866af8423c628be22860e41fb81005"; // Banned(address)
const UNBANNED_TOPIC = "0xb39966eac8a0ae96284afcbb1a1e8eb366677548a09cf1bf773b39b26bedd234"; // UnBanned(address)

const BANNED_EVENT_FAMILY = defineEventFamily("banned-unbanned", [
  {
    signature: "Banned(address)",
    topicHash: BANNED_TOPIC,
    eventType: "blacklist",
    hasAmount: false,
  },
  {
    signature: "UnBanned(address)",
    topicHash: UNBANNED_TOPIC,
    eventType: "unblacklist",
    hasAmount: false,
  },
]);

// --- Securitize / BUIDL seize-only events ---

const SECURITIZE_SEIZE_TOPIC = "0x5068c48f7f290ce2b8d555bd28014be9f312999bb621037ea3e9fc86335a21d7"; // Seize(address,address,uint256,string)
const SECURITIZE_OMNIBUS_SEIZE_TOPIC = "0x5c719d01bb88860dfca685ad3818d8b61a083caaf8f68abe6fa0fba4e40e33a9"; // OmnibusSeize(address,address,uint256,string,uint8)

const SECURITIZE_SEIZE_EVENT_FAMILY = defineEventFamily("securitize-seize", [
  {
    signature: "Seize(address,address,uint256,string)",
    topicHash: SECURITIZE_SEIZE_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    addressTopicIndex: 1, // from (victim)
    amountDataIndex: 0,   // value occupies the first 32-byte data slot (reason follows as dynamic tail)
  },
  {
    signature: "OmnibusSeize(address,address,uint256,string,uint8)",
    topicHash: SECURITIZE_OMNIBUS_SEIZE_TOPIC,
    eventType: "destroy",
    hasAmount: true,
    addressDataIndex: 0,
    amountDataIndex: 1,
  },
]);

const BLACKLIST_STABLECOIN_SET = new Set<BlacklistStablecoin>(BLACKLIST_STABLECOINS);

function resolveBlacklistStablecoinSymbol(
  stablecoinId: string,
  override?: BlacklistStablecoin,
): BlacklistStablecoin {
  if (override) return override;
  const symbol = getTrackedStablecoin(stablecoinId)?.symbol;
  if (!symbol || !BLACKLIST_STABLECOIN_SET.has(symbol as BlacklistStablecoin)) {
    throw new Error(`Unsupported blacklist stablecoin symbol for ${stablecoinId}`);
  }
  return symbol as BlacklistStablecoin;
}

function resolveBlacklistContractConfig(
  spec: ContractEventConfigSpec,
): ContractEventConfig {
  const resolvedContract = resolveRequiredTrackedContractConfig(spec.stablecoinId, spec.chain.chainId, {
    source: spec.contractSource,
    addressOverride: spec.contractAddressOverride,
    decimalsOverride: spec.decimalsOverride,
  });

  return {
    configKey: `${spec.chain.chainId}-${resolvedContract.contractAddress.toLowerCase()}`,
    chain: spec.chain,
    stablecoinId: spec.stablecoinId,
    stablecoin: resolveBlacklistStablecoinSymbol(spec.stablecoinId, spec.stablecoin),
    contractAddress: resolvedContract.contractAddress,
    decimals: resolvedContract.decimals,
    startBlock: spec.startBlock,
    events: [...spec.events],
  };
}

// --- Contract addresses per chain ---

const CONTRACT_CONFIG_SPECS: ContractEventConfigSpec[] = [
  // USDC
  { chain: ETHEREUM, stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
  { chain: BASE, stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
  { chain: OPTIMISM, stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
  { chain: POLYGON, stablecoinId: "usdc-circle", events: USDC_EVENT_FAMILY.events },
  { chain: AVALANCHE, stablecoinId: "usdc-circle", startBlock: 7_388_829, events: USDC_EVENT_FAMILY.events },

  // USDT (EVM)
  { chain: ETHEREUM, stablecoinId: "usdt-tether", events: USDT_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "usdt-tether", events: USDT_UPGRADED_EVENT_FAMILY.events },
  { chain: OPTIMISM, stablecoinId: "usdt-tether", events: USDT_EVENT_FAMILY.events },
  { chain: OPTIMISM, stablecoinId: "usdt-tether", contractSource: "traded", events: USDT0_EVENT_FAMILY.events },
  { chain: POLYGON, stablecoinId: "usdt-tether", events: USDT_UPGRADED_EVENT_FAMILY.events },
  { chain: AVALANCHE, stablecoinId: "usdt-tether", startBlock: 4_663_628, events: USDT_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "usdt-tether", startBlock: 176_416, events: USDT_EVENT_FAMILY.events },

  // USDT (Tron)
  { chain: TRON, stablecoinId: "usdt-tether", events: USDT_EVENT_FAMILY.events },

  // PAXG (Ethereum only)
  { chain: ETHEREUM, stablecoinId: "paxg-paxos", events: PAXG_EVENT_FAMILY.events },

  // XAUT (Ethereum only — same event pattern as USDT0: BlockPlaced/BlockReleased/DestroyedBlockedFunds)
  { chain: ETHEREUM, stablecoinId: "xaut-tether", events: USDT0_EVENT_FAMILY.events },

  // pyUSD (Ethereum + Arbitrum)
  { chain: ETHEREUM, stablecoinId: "pyusd-paypal", events: PYUSD_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "pyusd-paypal", events: PYUSD_EVENT_FAMILY.events },

  // USD1 (Ethereum + BSC + Tron)
  { chain: ETHEREUM, stablecoinId: "usd1-world-liberty-financial", startBlock: 21_720_503, events: USD1_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "usd1-world-liberty-financial", startBlock: 46_151_905, events: USD1_EVENT_FAMILY.events },
  { chain: TRON, stablecoinId: "usd1-world-liberty-financial", events: USD1_EVENT_FAMILY.events },

  // USDG (Paxos Global Dollar — Ethereum only for first-wave coverage)
  { chain: ETHEREUM, stablecoinId: "usdg-paxos", startBlock: 20_915_336, events: PYUSD_EVENT_FAMILY.events },

  // RLUSD (Ripple USD — Ethereum account pause/unpause; clawback is not event-covered here)
  { chain: ETHEREUM, stablecoinId: "rlusd-ripple", startBlock: 20_492_031, events: RLUSD_EVENT_FAMILY.events },

  // U (United Stables — Ethereum + BSC, same dual-indexed freeze pattern as USD1)
  { chain: ETHEREUM, stablecoinId: "u-united-stables", startBlock: 24_030_193, events: USD1_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "u-united-stables", startBlock: 71_922_111, events: USD1_EVENT_FAMILY.events },

  // USDtb (Ethena / Anchorage — Ethereum batch block/unblock events)
  { chain: ETHEREUM, stablecoinId: "usdtb-ethena", startBlock: 21_287_284, events: USDTB_EVENT_FAMILY.events },

  // A7A5 (Old Vector — Ethereum only; Tron requires separate result-key verification)
  { chain: ETHEREUM, stablecoinId: "a7a5-old-vector", startBlock: 22_080_045, events: A7A5_EVENT_FAMILY.events },

  // Wave 2A direct EVM coverage
  { chain: ETHEREUM, stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 17_144_262, events: USD1_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 27_850_220, events: USD1_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "fdusd-first-digital", stablecoin: "FDUSD", startBlock: 336_278_229, events: USD1_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "brz-transfero", stablecoin: "BRZ", startBlock: 17_517_084, events: USDC_EVENT_FAMILY.events },
  { chain: GNOSIS, stablecoinId: "brz-transfero", stablecoin: "BRZ", startBlock: 33_257_603, events: USDC_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "ausd-agora", stablecoin: "AUSD", startBlock: 342_153_906, events: ACCOUNT_FREEZE_EVENT_FAMILY.events },
  { chain: BASE, stablecoinId: "ausd-agora", stablecoin: "AUSD", startBlock: 35_760_121, events: ACCOUNT_FREEZE_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "mnee-mnee", stablecoin: "MNEE", startBlock: 19_482_225, events: MNEE_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "euri-banking-circle", stablecoin: "EURI", startBlock: 20_217_556, events: USD1_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "euri-banking-circle", stablecoin: "EURI", startBlock: 40_115_386, events: USD1_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "usdq-quantoz", stablecoin: "USDQ", startBlock: 21_179_575, events: USDT0_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "usdo-openeden", stablecoin: "USDO", startBlock: 20_833_910, events: ACCOUNT_BAN_EVENT_FAMILY.events },
  { chain: BASE, stablecoinId: "usdo-openeden", stablecoin: "USDO", startBlock: 25_154_101, events: ACCOUNT_BAN_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "usdx-hex-trust", stablecoin: "USDX", startBlock: 21_062_695, events: ADDED_REMOVED_BLACKLIST_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "aid-gaib", stablecoin: "AID", startBlock: 23_682_560, events: DENY_LIST_EVENT_FAMILY.events },
  { chain: ETHEREUM, stablecoinId: "tgbp-tokenised", stablecoin: "TGBP", startBlock: 23_046_391, events: BANNED_EVENT_FAMILY.events },
  { chain: AVALANCHE, stablecoinId: "tgbp-tokenised", stablecoin: "TGBP", startBlock: 69_696_101, events: BANNED_EVENT_FAMILY.events },

  // EURC re-enabled with mirror-zero suppression
  { chain: ETHEREUM, stablecoinId: "eurc-circle", startBlock: 14_807_227, events: USDC_EVENT_FAMILY.events },
  { chain: BASE, stablecoinId: "eurc-circle", startBlock: 15_107_859, events: USDC_EVENT_FAMILY.events },
  { chain: AVALANCHE, stablecoinId: "eurc-circle", startBlock: 26_857_185, events: USDC_EVENT_FAMILY.events },

  // BUIDL seize-only coverage (Securitize token family)
  { chain: ETHEREUM, stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 19_343_293, events: SECURITIZE_SEIZE_EVENT_FAMILY.events },
  { chain: BSC, stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 63_931_579, events: SECURITIZE_SEIZE_EVENT_FAMILY.events },
  { chain: OPTIMISM, stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 127_565_419, events: SECURITIZE_SEIZE_EVENT_FAMILY.events },
  { chain: ARBITRUM, stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 270_969_308, events: SECURITIZE_SEIZE_EVENT_FAMILY.events },
  { chain: AVALANCHE, stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 52_649_153, events: SECURITIZE_SEIZE_EVENT_FAMILY.events },
  { chain: POLYGON, stablecoinId: "buidl-blackrock", stablecoin: "BUIDL", startBlock: 63_877_025, events: SECURITIZE_SEIZE_EVENT_FAMILY.events },
];

export const CONTRACT_CONFIGS: ContractEventConfig[] = CONTRACT_CONFIG_SPECS.map(
  resolveBlacklistContractConfig,
);

const CONTRACT_CONFIG_BY_KEY = new Map(CONTRACT_CONFIGS.map((config) => [config.configKey, config]));
const CONTRACT_CONFIG_BY_CHAIN_AND_ADDRESS = new Map(
  CONTRACT_CONFIGS.map((config) => [`${config.chain.chainId}-${config.contractAddress.toLowerCase()}`, config]),
);

function buildBlacklistConfigKey(chainId: string, contractAddress: string): string {
  return `${chainId}-${contractAddress.toLowerCase()}`;
}

export function getBlacklistConfigByKey(configKey: string): ContractEventConfig | undefined {
  return CONTRACT_CONFIG_BY_KEY.get(configKey.toLowerCase());
}

export function getBlacklistConfigByContract(
  chainId: string,
  contractAddress: string,
): ContractEventConfig | undefined {
  return CONTRACT_CONFIG_BY_CHAIN_AND_ADDRESS.get(buildBlacklistConfigKey(chainId, contractAddress));
}

export function getBlacklistConfigsForSymbolAndChain(
  stablecoin: BlacklistStablecoin,
  chainId: string,
): ContractEventConfig[] {
  return CONTRACT_CONFIGS.filter((config) => config.stablecoin === stablecoin && config.chain.chainId === chainId);
}

export function getBlacklistEventByTopic(
  config: Pick<ContractEventConfig, "events">,
  topicHash: string | null | undefined,
): BlacklistEventDef | undefined {
  if (!topicHash) return undefined;
  return config.events.find((event) => event.topicHash.toLowerCase() === topicHash.toLowerCase());
}

export function getBlacklistEventBySignature(
  config: Pick<ContractEventConfig, "events">,
  signature: string | null | undefined,
): BlacklistEventDef | undefined {
  if (!signature) return undefined;
  return config.events.find((event) => event.signature === signature || event.signature.split("(")[0] === signature);
}

export function getBlacklistTopicHashes(
  config: Pick<ContractEventConfig, "events">,
): string[] {
  return [...new Set(config.events.map((event) => event.topicHash))];
}
