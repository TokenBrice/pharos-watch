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
