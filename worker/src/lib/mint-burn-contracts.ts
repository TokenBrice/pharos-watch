import type { ChainConfig } from "./blacklist-contracts";
import { chainConfig } from "./blacklist-contracts";

// --- Types ---

export type MintBurnDirection = "mint" | "burn";

export interface MintBurnEventDef {
  signature: string;
  topicHash: string;
  direction: MintBurnDirection;
  amountEncoding: "transfer-value" | "first-data-uint256" | "nth-data-uint256";
  dataSlot?: number; // Required when amountEncoding = "nth-data-uint256"; 0-indexed slot in ABI-encoded data
  filterTopic?: {
    index: number;
    value: string;
  };
}

export interface MintBurnContractConfig {
  chain: ChainConfig;
  stablecoinId: string;
  symbol: string;
  contractAddress: string;
  decimals: number;
  dustThreshold: number;
  startBlock: number;
  events: MintBurnEventDef[];
}

// --- Constants ---

const ZERO_ADDRESS_PADDED = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Phase 2 readiness — USDT Tron uses these instead of Transfer
const USDT_ISSUE_TOPIC = "0xcb8241adb0c3fdb35b70c24ce35c5eb0c17af7431c99f827d44a445ca624176a";
const USDT_REDEEM_TOPIC = "0x702d5967f45f6513a38ffc42d6ba9bf230bd40e8f53b16363c7eb4fd2deb9a44";


// --- Helpers ---

function transferMintBurn(): MintBurnEventDef[] {
  return [
    {
      signature: "Transfer(address,address,uint256)",
      topicHash: TRANSFER_TOPIC,
      direction: "mint",
      amountEncoding: "transfer-value",
      filterTopic: { index: 1, value: ZERO_ADDRESS_PADDED }, // from = zero
    },
    {
      signature: "Transfer(address,address,uint256)",
      topicHash: TRANSFER_TOPIC,
      direction: "burn",
      amountEncoding: "transfer-value",
      filterTopic: { index: 2, value: ZERO_ADDRESS_PADDED }, // to = zero
    },
  ];
}

// --- reUSD (Re Protocol) event topic hashes ---
// Deposited(address user, address token, uint256 amount) — all params unindexed
// Confirmed from ETH tx 0xf58255931c37cbca0859946c45d9a19e48b1da5476d1aab76ec788100c8d7a59
const REUSD_DEPOSITED_TOPIC     = "0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7";
// InstantRedemptionProcessed(address indexed user, uint256 sharesBurned, uint256 netPayout) — user indexed
// Confirmed from ETH tx 0x831367d37ebb2bd3bf41a1152124a493c309b1f092ce161da578d635b49d23e8
const REUSD_INSTANT_REDEEM_TOPIC = "0xa58dba63852b106a5b3bbc558fa3fbcfe606497cbc0af66837a83c3560ec6220";

// --- Phase 1 configs (Ethereum only, 10 stablecoins) ---

const ETHEREUM  = chainConfig("ethereum");
const ARBITRUM  = chainConfig("arbitrum");
const BASE      = chainConfig("base");
const AVALANCHE = chainConfig("avalanche");

// --- Re Protocol vault config builder ---
// Generates deposit + instant-redemption config pairs across multiple chains.
// Deposit event amount is emitted in 18-dec token units (e.g. DAI/FRAX/USR);
// redeem event amount = sharesBurned (18 dec).

interface ReProtocolChainEntry {
  chain: ChainConfig;
  depositAddress: string;
  depositStartBlock: number;
  redeemAddress: string;
  redeemStartBlock: number;
}

function reProtocolVaultConfigs(
  stablecoinId: string,
  symbol: string,
  chains: ReProtocolChainEntry[],
): MintBurnContractConfig[] {
  return chains.flatMap(({ chain, depositAddress, depositStartBlock, redeemAddress, redeemStartBlock }) => [
    {
      chain, stablecoinId, symbol,
      contractAddress: depositAddress,
      decimals: 18, dustThreshold: 10_000, startBlock: depositStartBlock,
      events: [{
        signature: "Deposited(address,address,uint256)",
        topicHash: REUSD_DEPOSITED_TOPIC,
        direction: "mint" as const,
        amountEncoding: "nth-data-uint256" as const,
        dataSlot: 2, // data = [user(32B), token(32B), amount(32B)]
      }],
    },
    {
      chain, stablecoinId, symbol,
      contractAddress: redeemAddress,
      decimals: 18, dustThreshold: 10_000, startBlock: redeemStartBlock,
      events: [{
        signature: "InstantRedemptionProcessed(address,uint256,uint256)",
        topicHash: REUSD_INSTANT_REDEEM_TOPIC,
        direction: "burn" as const,
        amountEncoding: "first-data-uint256" as const, // data[0] = sharesBurned
      }],
    },
  ]);
}

export const MINT_BURN_CONFIGS: MintBurnContractConfig[] = [
  // --- Safe havens ---
  {
    chain: ETHEREUM, stablecoinId: "1", symbol: "USDT",
    contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    events: [
      ...transferMintBurn(),
      // USDT Ethereum uses custom Issue/Redeem events (issue() does NOT emit Transfer)
      {
        signature: "Issue(uint256)",
        topicHash: USDT_ISSUE_TOPIC,
        direction: "mint" as const,
        amountEncoding: "first-data-uint256" as const,
      },
      {
        signature: "Redeem(uint256)",
        topicHash: USDT_REDEEM_TOPIC,
        direction: "burn" as const,
        amountEncoding: "first-data-uint256" as const,
      },
    ],
  },
  {
    chain: ETHEREUM, stablecoinId: "2", symbol: "USDC",
    contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "119", symbol: "FDUSD",
    contractAddress: "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "120", symbol: "PYUSD",
    contractAddress: "0x6c3ea9036406852006290770bedfcaba0e23a0e8",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },

  // --- Risky / crypto-backed ---
  {
    chain: ETHEREUM, stablecoinId: "5", symbol: "DAI",
    contractAddress: "0x6b175474e89094c44da98b954eedeac495271d0f",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "118", symbol: "GHO",
    contractAddress: "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "146", symbol: "USDe",
    contractAddress: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "209", symbol: "USDS",
    contractAddress: "0xdc035d45d973e3ec169d2276ddab16f1e407384f",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "235", symbol: "FRXUSD",
    contractAddress: "0xcacd6fd266af91b8aed52accc382b4e165586e29",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "269", symbol: "BOLD",
    contractAddress: "0x6440f144b7e50d6a8439336510312d2f54beb01d",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },

  // --- reUSD (Re Protocol, ID 339) — deposit + instant-redemption across 4 chains ---
  ...reProtocolVaultConfigs("339", "reUSD", [
    { chain: ETHEREUM,  depositAddress: "0x4691c475be804fa85f91c2d6d0adf03114de3093", depositStartBlock: 21_675_000,  redeemAddress: "0x8aeb9453ef22cb38abc7a3af9c208f65c1bfe31e", redeemStartBlock: 23_479_000  },
    { chain: ARBITRUM,  depositAddress: "0x802edbb1ec20548a4388abc337e4011718eb0291", depositStartBlock: 305_400_000, redeemAddress: "0xfd4016ea13ca8acc04a11a99702df076a4d3b852", redeemStartBlock: 382_974_000 },
    { chain: BASE,      depositAddress: "0x7d214438d0f27afccc23b3d1e1a53906ace5cfea", depositStartBlock: 24_000_000,  redeemAddress: "0x9ab62aebabe738ab233c447eedce88d1d0a61fe3", redeemStartBlock: 24_000_000  },
    { chain: AVALANCHE, depositAddress: "0xb22a8533e6cd81598f82514a42f0b3161745fbe1", depositStartBlock: 55_000_000,  redeemAddress: "0xe13292f97e38da0c64398de5e0bfc95180de9d23", redeemStartBlock: 55_000_000  },
  ]),
];

/**
 * Hardcoded safe-haven IDs — used as fallback for flight-to-quality detection
 * when the report_card_cache is unavailable or stale (>2h).
 * Prefer grade-based classification from report card scores when available.
 */
export const SAFE_HAVEN_IDS = new Set(
  MINT_BURN_CONFIGS.filter((c) =>
    ["USDT", "USDC", "FDUSD", "PYUSD"].includes(c.symbol)
  ).map((c) => c.stablecoinId)
);
