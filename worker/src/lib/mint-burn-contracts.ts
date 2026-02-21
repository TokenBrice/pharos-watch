import { CHAIN_META } from "../../../src/lib/chains";
import type { ChainConfig } from "./blacklist-contracts";

export type MintBurnStablecoin = "USDC" | "USDT";
export type MintBurnEventType = "mint" | "burn";

export interface MintBurnEventDef {
  signature: string;
  topicHash: string;
  eventType: MintBurnEventType;
  /** true for USDC (indexed address in topics), false for USDT Issue/Redeem */
  hasAddress: boolean;
}

export interface MintBurnContractConfig {
  chain: ChainConfig;
  stablecoin: MintBurnStablecoin;
  contractAddress: string;
  decimals: number;
  events: MintBurnEventDef[];
  /** Block number to start scanning from (contract deployment block) */
  deployBlock: number;
}

// --- Chain configs (reuse from shared CHAIN_META) ---

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

// --- USDC events (Circle FiatTokenV1) ---
// Mint(address indexed minter, address indexed to, uint256 amount)
// Burn(address indexed burner, uint256 amount)

const USDC_EVENTS: MintBurnEventDef[] = [
  {
    signature: "Mint(address,address,uint256)",
    topicHash: "0xab8530f87dc9b59234c4623bf917212bb2536d647574c8e7e5da92c2ede0c9f8",
    eventType: "mint",
    hasAddress: true,
  },
  {
    signature: "Burn(address,uint256)",
    topicHash: "0xcc16f5dbb4873280815c1ee09dbd06736cffcc184412cf7a71a0fdb75d397ca5",
    eventType: "burn",
    hasAddress: true,
  },
];

// --- USDT events (TetherToken — Ethereum only) ---
// Issue(uint256 amount) — no indexed params
// Redeem(uint256 amount) — no indexed params

const USDT_EVENTS: MintBurnEventDef[] = [
  {
    signature: "Issue(uint256)",
    topicHash: "0xcb8241adb0c3fdb35b70c24ce35c5eb0c17af7431c99f827d44a445ca624176a",
    eventType: "mint",
    hasAddress: false,
  },
  {
    signature: "Redeem(uint256)",
    topicHash: "0x702d5967f45f6513a38ffc42d6ba9bf230bd40e8f53b16363c7eb4fd2deb9a44",
    eventType: "burn",
    hasAddress: false,
  },
];

// --- Contract addresses ---

export const MINT_BURN_CONFIGS: MintBurnContractConfig[] = [
  // USDC — 6 native chains (Circle mints directly via CCTP)
  // Deploy blocks are the block where the first Mint/Burn event occurs (not contract creation)
  { chain: ETHEREUM,  stablecoin: "USDC", contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, events: USDC_EVENTS, deployBlock: 6_082_465 },
  { chain: ARBITRUM,  stablecoin: "USDC", contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6, events: USDC_EVENTS, deployBlock: 101_000_000 },
  // Base and Optimism require paid Etherscan API plan — re-enable when available
  // { chain: BASE,      stablecoin: "USDC", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, events: USDC_EVENTS, deployBlock: 3_040_000 },
  // { chain: OPTIMISM,  stablecoin: "USDC", contractAddress: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6, events: USDC_EVENTS, deployBlock: 105_000_000 },
  { chain: POLYGON,   stablecoin: "USDC", contractAddress: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6, events: USDC_EVENTS, deployBlock: 47_000_000 },
  { chain: AVALANCHE, stablecoin: "USDC", contractAddress: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6, events: USDC_EVENTS, deployBlock: 6_700_000 },

  // USDT — Ethereum only (L2 USDT is bridged, not natively issued)
  { chain: ETHEREUM, stablecoin: "USDT", contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, events: USDT_EVENTS, deployBlock: 4_634_748 },
];
