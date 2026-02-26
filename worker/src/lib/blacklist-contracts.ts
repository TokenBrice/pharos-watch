import { CHAIN_META } from "../../../src/lib/chains";
import type { BlacklistStablecoin, BlacklistEventType } from "../../../src/lib/types";

export interface ChainConfig {
  chainId: string;          // Internal identifier (e.g. "ethereum")
  chainName: string;
  evmChainId: number | null; // Numeric EVM chain ID for Etherscan v2 API (null for non-EVM)
  explorerUrl: string;       // Block explorer for tx/address links
  type: "evm" | "tron" | "other";
}

export interface ContractEventConfig {
  chain: ChainConfig;
  stablecoin: BlacklistStablecoin;
  contractAddress: string;
  decimals: number;        // Token decimals (6 for USDC/USDT/XAUT, 18 for PAXG)
  events: {
    signature: string;     // Human-readable event signature
    topicHash: string;     // Keccak256 of the event signature
    eventType: BlacklistEventType;
    hasAmount: boolean;
  }[];
}

// --- Chain configurations (derived from shared CHAIN_META) ---

function chainConfig(chainId: string): ChainConfig {
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

const USDC_EVENTS: ContractEventConfig["events"] = [
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
];

// --- USDT event definitions ---

const USDT_EVENTS: ContractEventConfig["events"] = [
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
];

// --- USDT0 event definitions (Arbitrum and other USDT0-upgraded L2s) ---
// These use indexed address params, so the address is in topics[1] not data.

const USDT0_EVENTS: ContractEventConfig["events"] = [
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
];

// Combined: listen for both legacy and USDT0 events on chains where
// the old bridged USDT was upgraded in-place to USDT0 (Arbitrum, Polygon)
const USDT_UPGRADED_EVENTS: ContractEventConfig["events"] = [
  ...USDT_EVENTS,
  ...USDT0_EVENTS,
];

// --- PAXG event definitions ---
// AddressFrozen/AddressUnfrozen/FrozenAddressWiped — address is indexed (in topics[1])

const PAXG_FROZEN_TOPIC = "0x90811a8edd3b3c17eeaefffc17f639cc69145d41a359c9843994dc2538203690"; // AddressFrozen(address)
const PAXG_UNFROZEN_TOPIC = "0xc3776b472ebf54114339eec9e4dc924e7ce307a97f5c1ee72b6d474e6e5e8b7c"; // AddressUnfrozen(address)
const PAXG_WIPED_TOPIC = "0xfc5960f1c5a5d2b60f031bf534af053b1bf7d9881989afaeb8b1d164db23aede"; // FrozenAddressWiped(address)

const PAXG_EVENTS: ContractEventConfig["events"] = [
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
];

// --- Contract addresses per chain ---

export const CONTRACT_CONFIGS: ContractEventConfig[] = [
  // USDC
  { chain: ETHEREUM, stablecoin: "USDC", contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, events: USDC_EVENTS },
  { chain: ARBITRUM, stablecoin: "USDC", contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6, events: USDC_EVENTS },
  { chain: BASE, stablecoin: "USDC", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, events: USDC_EVENTS },
  { chain: OPTIMISM, stablecoin: "USDC", contractAddress: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6, events: USDC_EVENTS },
  { chain: POLYGON, stablecoin: "USDC", contractAddress: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6, events: USDC_EVENTS },
  { chain: AVALANCHE, stablecoin: "USDC", contractAddress: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6, events: USDC_EVENTS },

  // USDT (EVM)
  { chain: ETHEREUM, stablecoin: "USDT", contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, events: USDT_EVENTS },
  { chain: ARBITRUM, stablecoin: "USDT", contractAddress: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6, events: USDT_UPGRADED_EVENTS },
  { chain: OPTIMISM, stablecoin: "USDT", contractAddress: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", decimals: 6, events: USDT_EVENTS },
  { chain: OPTIMISM, stablecoin: "USDT", contractAddress: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071", decimals: 6, events: USDT0_EVENTS },
  { chain: POLYGON, stablecoin: "USDT", contractAddress: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6, events: USDT_UPGRADED_EVENTS },
  { chain: AVALANCHE, stablecoin: "USDT", contractAddress: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", decimals: 6, events: USDT_EVENTS },
  { chain: BSC, stablecoin: "USDT", contractAddress: "0x55d398326f99059ff775485246999027b3197955", decimals: 18, events: USDT_EVENTS },

  // USDT (Tron)
  { chain: TRON, stablecoin: "USDT", contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6, events: USDT_EVENTS },

  // PAXG (Ethereum only)
  { chain: ETHEREUM, stablecoin: "PAXG", contractAddress: "0x45804880De22913dAFE09f4980848ECE6EcbAf78", decimals: 18, events: PAXG_EVENTS },

  // XAUT (Ethereum only — same event pattern as USDT0: BlockPlaced/BlockReleased/DestroyedBlockedFunds)
  { chain: ETHEREUM, stablecoin: "XAUT", contractAddress: "0x68749665FF8D2d112Fa859AA293F07A622782F38", decimals: 6, events: USDT0_EVENTS },
];
