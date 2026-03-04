import type { ChainConfig } from "./blacklist-contracts";
import { chainConfig } from "./blacklist-contracts";

// --- Types ---

export type MintBurnDirection = "mint" | "burn";
export type MintBurnTier = "critical" | "extended";

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
  enabled?: boolean;
  tier?: MintBurnTier;
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

// --- Ethereum configs ---

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
      tier: "extended",
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
      tier: "extended",
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
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "120", symbol: "PYUSD",
    contractAddress: "0x6c3ea9036406852006290770bedfcaba0e23a0e8",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
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
    tier: "extended",
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
  {
    chain: ETHEREUM, stablecoinId: "168", symbol: "fxUSD",
    contractAddress: "0x085780639cc2cacd35e474e71f4d000e2405d8f6",
    decimals: 18, dustThreshold: 10_000, startBlock: 19_287_523,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "110", symbol: "crvUSD",
    contractAddress: "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e",
    decimals: 18, dustThreshold: 10_000, startBlock: 17_257_952,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "205", symbol: "AUSD",
    contractAddress: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
    decimals: 6, dustThreshold: 10_000, startBlock: 20_257_620,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "226", symbol: "ZCHF",
    contractAddress: "0xb58e61c3098d85632df34eecfb899a1ed80921cb",
    decimals: 18, dustThreshold: 10_000, startBlock: 18_451_518,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "50", symbol: "EURC",
    contractAddress: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c",
    decimals: 6, dustThreshold: 10_000, startBlock: 14_807_227,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "gold-paxg", symbol: "PAXG",
    contractAddress: "0x45804880de22913dafe09f4980848ece6ecbaf78",
    decimals: 18, dustThreshold: 10_000, startBlock: 8_426_430,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "gold-xaut", symbol: "XAUT",
    contractAddress: "0x68749665ff8d2d112fa859aa293f07a622782f38",
    decimals: 6, dustThreshold: 10_000, startBlock: 13_524_498,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "286", symbol: "USDG",
    contractAddress: "0xe343167631d89b6ffc58b88d6b7fb0228795491d",
    decimals: 6, dustThreshold: 10_000, startBlock: 20_915_336,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "262", symbol: "USD1",
    contractAddress: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_720_503,
    tier: "extended",
    events: transferMintBurn(),
  },

  // --- Top-50 supported expansion (Ethereum only) ---
  {
    chain: ETHEREUM, stablecoinId: "246", symbol: "USDf",
    contractAddress: "0xfa2b947eec368f42195f24f36d2af29f7c24cec2",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "237", symbol: "USYC",
    contractAddress: "0x136471a34f6ef19fe571effc1ca711fdb8e49f2b",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "250", symbol: "RLUSD",
    contractAddress: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "129", symbol: "USDY",
    contractAddress: "0x96f6ef951840721adbf46ac996b59e0235cb985c",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "173", symbol: "BUIDL",
    contractAddress: "0x7712c34205737192402172409a8f7ccef8aa2aec",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "14", symbol: "USDD",
    contractAddress: "0x4f8e5de400de08b164e7421b3ee387f461becd1a",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "221", symbol: "USDTB",
    contractAddress: "0xc139190f447e929f090edeb554d95abb8b18ac1c",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "213", symbol: "M",
    contractAddress: "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "195", symbol: "USD0",
    contractAddress: "0x73a15fed60bf67631dc6cd7bc5b6e8da8190acf5",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "258", symbol: "A7A5",
    contractAddress: "0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "7", symbol: "TUSD",
    contractAddress: "0x0000000000085d4780b73119b644ae5ecd22b376",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "296", symbol: "CUSD",
    contractAddress: "0xcccc62962d17b8914c62d74ffb843d73b2a3cccc",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "197", symbol: "USR",
    contractAddress: "0x66a1e37c9b0eaddca17d3662d6c05f4decf3e110",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "220", symbol: "USDA",
    contractAddress: "0x8a60e489004ca22d775c5f2c657598278d17d9c2",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "6", symbol: "FRAX",
    contractAddress: "0x853d955acef822db058eb8505911ed77f175b99e",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "15", symbol: "DOLA",
    contractAddress: "0x865377367054516e17014ccded1e7d814edc9ce4",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "298", symbol: "IUSD",
    contractAddress: "0x48f9e38f3070ad8945dfeae3fa70987722e3d89c",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "218", symbol: "satUSD",
    contractAddress: "0x1958853a8be062dc4f401750eb233f5850f0d0d2",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "306", symbol: "GUSD",
    contractAddress: "0xaf6186b3521b60e27396b5d23b48abc34bf585c5",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "340", symbol: "rwaUSDi",
    contractAddress: "0xa39986f96b80d04e8d7aeaaf47175f47c23fd0f4",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "271", symbol: "avUSD",
    contractAddress: "0xf4c13d631450de6b12a19829e37c8e2826891dc4",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "332", symbol: "pmUSD",
    contractAddress: "0xc0c17dd08263c16f6b64e772fb9b723bf1344ddf",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "202", symbol: "USDz",
    contractAddress: "0xa469b7ee9ee773642b3e93e842e5d9b5baa10067",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "284", symbol: "MNEE",
    contractAddress: "0x8ccedbae4916b79da7f3f612efb2eb93a2bfd6cf",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "257", symbol: "TBILL",
    contractAddress: "0xdd50c053c096cb04a3e3362e2b622529ec5f2e8a",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "66", symbol: "FPI",
    contractAddress: "0x5ca135cb8527d76e932f34b5145575f9d8cbe08e",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },

  // --- Top-100 supported expansion (Ethereum only) ---
  {
    chain: ETHEREUM, stablecoinId: "241", symbol: "USDO",
    contractAddress: "0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "254", symbol: "EURCV",
    contractAddress: "0x5f7827fdeb7c20b443265fc2f40845b715385ff2",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "147", symbol: "AEUR",
    contractAddress: "0xa40640458fbc27b6eefedea1e9c9e17d4cee7a21",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "275", symbol: "USDQ",
    contractAddress: "0xc83e27f270cce0a3a3a29521173a83f402c1768b",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "256", symbol: "REUSD",
    contractAddress: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "325", symbol: "EURI",
    contractAddress: "0x9d1a7a3191102e9f900faa10540837ba84dcbae7",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "19", symbol: "GUSD",
    contractAddress: "0x056fd409e1d7a124bd7017459dfea2f387b6d5cd",
    decimals: 2, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "11", symbol: "USDP",
    contractAddress: "0x8e870d67f660d95d5be530380d0ec0bd388289e1",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "263", symbol: "USDX",
    contractAddress: "0xf8750b54d86be7ae9e32b4a0c826811198d63313",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "290", symbol: "XUSD",
    contractAddress: "0xc08e7e23c235073c6807c2efe7021304cb7c2815",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "313", symbol: "MUSD",
    contractAddress: "0xaca92e438df0b2401ff60da7e4337b687a2435da",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "255", symbol: "YUSD",
    contractAddress: "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "22", symbol: "SUSD",
    contractAddress: "0x57ab1ec28d129707052df4df418d58a2d46d5f51",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "8", symbol: "LUSD",
    contractAddress: "0x5f98805a4e8be255a32880fdec7f6728c6568ba0",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "10", symbol: "MIM",
    contractAddress: "0x99d8a9c45b2eca8864373a26d1459e3dff1e17f3",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "307", symbol: "USDCV",
    contractAddress: "0x5422374b27757da72d5265cc745ea906e0446634",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "225", symbol: "ZeUSD",
    contractAddress: "0x7dc9748da8e762e569f9269f48f69a1a9f8ea761",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "101", symbol: "EURE",
    contractAddress: "0x39b8b6385416f4ca36a20319f70d28621895279d",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "230", symbol: "USN",
    contractAddress: "0xda67b4284609d2d48e5d10cfac411572727dc1ed",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "106", symbol: "EUSD",
    contractAddress: "0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "55", symbol: "EURA",
    contractAddress: "0x1a7e4e63778b4f12a199c062f3efdd288afcbce8",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "303", symbol: "meUSD",
    contractAddress: "0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "326", symbol: "MSUSD",
    contractAddress: "0xab5eb14c09d416f0ac63661e57edb7aecdb9befa",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "346", symbol: "NUSD",
    contractAddress: "0xe556aba6fe6036275ec1f87eda296be72c811bce",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "343", symbol: "USAT",
    contractAddress: "0x07041776f5007aca2a54844f50503a18a72a8b68",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "20", symbol: "ALUSD",
    contractAddress: "0xbc6da0fe9ad5f3b0d58160288917aa56653660e9",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "348", symbol: "FIDD",
    contractAddress: "0x7c135549504245b5eae64fc0e99fa5ebabb8e35d",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "297", symbol: "MSUSD",
    contractAddress: "0x4ba01f22827018b4772cd326c7627fb4956a7c00",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },

  // --- Top-150 supported expansion (Ethereum only) ---
  {
    chain: ETHEREUM, stablecoinId: "266", symbol: "pUSD",
    contractAddress: "0xdddd73f5df1f0dc31373357beac77545dc5a6f3f",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "234", symbol: "WUSD",
    contractAddress: "0x7cd017ca5ddb86861fa983a34b5f495c6f898c41",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "324", symbol: "SBC",
    contractAddress: "0xf9fb20b8e097904f0ab7d12e9dbee88f2dcd0f16",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "23", symbol: "OUSD",
    contractAddress: "0x2a8e1e676ec238d8a992307b495b45b3feaa5e86",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "253", symbol: "USBD",
    contractAddress: "0x6bede1c6009a78c222d9bdb7974bb67847fdb68c",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "331", symbol: "USP",
    contractAddress: "0x098697ba3fee4ea76294c5d6a466a4e3b3e95fe6",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "240", symbol: "USDR",
    contractAddress: "0x7b43e3875440b44613dc3bc08e7763e6da63c8f8",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "304", symbol: "USDU",
    contractAddress: "0xdde3ec717f220fc6a29d6a4be73f91da5b718e55",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "cg-ustb", symbol: "USTB",
    contractAddress: "0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e",
    decimals: 6, dustThreshold: 1_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "cg-ousg", symbol: "OUSG",
    contractAddress: "0x1b19c19393e2d034d8ff31ff34c81252fcbbee92",
    decimals: 18, dustThreshold: 100, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "cg-uscc", symbol: "USCC",
    contractAddress: "0x14d60e7fdc0d71d8611742720e4c50e7a974020c",
    decimals: 6, dustThreshold: 1_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "cg-mtbill", symbol: "mTBILL",
    contractAddress: "0xdd629e5241cbc5919847783e6c96b2de4754e438",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "cg-wrapped-savings-rusd", symbol: "wsrUSD",
    contractAddress: "0xd3fd63209fa2d55b07a0f6db36c2f43900be3094",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "289", symbol: "XSGD",
    contractAddress: "0x70e8de73ce538da2beed35d14187f6959a8eca96",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "122", symbol: "GYEN",
    contractAddress: "0xc08512927d12348f6620a698105e1baac6ecd911",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "165", symbol: "AUDD",
    contractAddress: "0x4cce605ed955295432958d8951d0b176c10720d5",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "cg-jpyc", symbol: "JPYC",
    contractAddress: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "gold-xaum", symbol: "XAUm",
    contractAddress: "0x2103e845c5e135493bb6c2a4f0b8651956ea8682",
    decimals: 18, dustThreshold: 10, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "158", symbol: "VEUR",
    contractAddress: "0x6ba75d640bebfe5da1197bb5a2aff3327789b5d3",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "239", symbol: "EURR",
    contractAddress: "0x50753cfaf86c094925bf976f218d043f8791e408",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "247", symbol: "EUROP",
    contractAddress: "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "cg-eurq", symbol: "EURQ",
    contractAddress: "0x8df723295214ea6f21026eeeb4382d475f146f9f",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "319", symbol: "EURAU",
    contractAddress: "0x4933a85b5b5466fbaf179f72d3de273c287ec2c2",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "cg-deuro", symbol: "DEURO",
    contractAddress: "0xba3f535bbcccca2a154b573ca6c5a49baae0a3ea",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "157", symbol: "VCHF",
    contractAddress: "0x79d4f0232a66c4c91b89c76362016a1707cfbf4f",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "317", symbol: "tGBP",
    contractAddress: "0x27f6c8289550fce67f6b50bed1f519966afe5287",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "cg-zarp", symbol: "ZARP",
    contractAddress: "0xb755506531786c8ac63b756bab1ac387bacb0c04",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "145", symbol: "CADC",
    contractAddress: "0xcadc0acd4b445166f12d2c07eac6e2544fbe2eef",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "299", symbol: "PHT",
    contractAddress: "0xbe370ad45d44eb45174c4ec60b88839fef32c077",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "cg-syrupusdc", symbol: "syrupUSDC",
    contractAddress: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "cg-syrupusdt", symbol: "syrupUSDT",
    contractAddress: "0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d",
    decimals: 6, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "353", symbol: "AID",
    contractAddress: "0x18f52b3fb465118731d9e0d276d4eb3599d57596",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "354", symbol: "apxUSD",
    contractAddress: "0x98a878b1cd98131b271883b390f68d2c90674665",
    decimals: 18, dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
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
