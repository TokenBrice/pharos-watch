import type { ChainConfig } from "./blacklist-contracts";
import { chainConfig } from "./blacklist-contracts";
import { getTrackedStablecoin, resolveTrackedContractConfig } from "@shared/lib/tracked-stablecoin-utils";

// --- Types ---

export type MintBurnDirection = "mint" | "burn";
export type MintBurnTier = "critical" | "extended";
export type MintBurnType = "effective_burn" | "bridge_burn" | "review_required";

export interface MintBurnBridgeDetectionConfig {
  protocol: "ccip";
  knownBridgePoolAddresses: string[];
  knownBridgeRouterAddresses: string[];
  bridgeSignalTopics: string[];
  bridgeSignalSelectors: string[];
}

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
  bridgeDetection?: MintBurnBridgeDetectionConfig;
}

interface MintBurnContractConfigSpec {
  chain: ChainConfig;
  stablecoinId: string;
  contractSource?: "primary" | "traded";
  contractAddressOverride?: string;
  decimalsOverride?: number;
  dustThreshold: number;
  startBlock: number;
  events: MintBurnEventDef[];
  enabled?: boolean;
  tier?: MintBurnTier;
  bridgeDetection?: MintBurnBridgeDetectionConfig;
}

// --- Constants ---

const ZERO_ADDRESS_PADDED = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Phase 2 readiness — USDT Tron uses these instead of Transfer
const USDT_ISSUE_TOPIC = "0xcb8241adb0c3fdb35b70c24ce35c5eb0c17af7431c99f827d44a445ca624176a";
const USDT_REDEEM_TOPIC = "0x702d5967f45f6513a38ffc42d6ba9bf230bd40e8f53b16363c7eb4fd2deb9a44";
const CCIP_ETHEREUM_ROUTER = "0x80226fc0ee2b096224eeac085bb9a8cba1146f7d";
const CCIP_SEND_REQUESTED_TOPIC = "0xd0c3c799bf9e2639de44391e7f524d229b2b55f5b1ea94b2bf7da42f7243dddd";
const CCIP_SEND_SELECTOR = "0x96f4e9f9";


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

function ccipBridgeDetection(
  knownBridgePoolAddresses: string[],
): MintBurnBridgeDetectionConfig {
  return {
    protocol: "ccip",
    knownBridgePoolAddresses,
    knownBridgeRouterAddresses: [
      CCIP_ETHEREUM_ROUTER,
    ],
    bridgeSignalTopics: [
      CCIP_SEND_REQUESTED_TOPIC,
    ],
    bridgeSignalSelectors: [
      CCIP_SEND_SELECTOR,
    ],
  };
}

function resolveMintBurnContractConfig(
  spec: MintBurnContractConfigSpec,
): MintBurnContractConfig {
  const stablecoin = getTrackedStablecoin(spec.stablecoinId);
  if (!stablecoin) {
    throw new Error(`Unknown tracked stablecoin: ${spec.stablecoinId}`);
  }

  const resolvedContract = resolveTrackedContractConfig(spec.stablecoinId, spec.chain.chainId, {
    source: spec.contractSource,
    addressOverride: spec.contractAddressOverride,
    decimalsOverride: spec.decimalsOverride,
  });
  if (!resolvedContract) {
    throw new Error(`Missing tracked contract for ${spec.stablecoinId} on ${spec.chain.chainId}`);
  }

  return {
    chain: spec.chain,
    stablecoinId: spec.stablecoinId,
    symbol: resolvedContract.stablecoin.symbol,
    contractAddress: resolvedContract.contractAddress,
    decimals: resolvedContract.decimals,
    dustThreshold: spec.dustThreshold,
    startBlock: spec.startBlock,
    events: spec.events,
    enabled: spec.enabled,
    tier: spec.tier,
    bridgeDetection: spec.bridgeDetection,
  };
}

// --- reUSD (Re Protocol) event topic hashes ---
// Deposited(address user, address token, uint256 amount) — all params unindexed
// Confirmed from ETH tx 0xf58255931c37cbca0859946c45d9a19e48b1da5476d1aab76ec788100c8d7a59
const REUSD_DEPOSITED_TOPIC     = "0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7";
// InstantRedemptionProcessed(address indexed user, uint256 sharesBurned, uint256 netPayout) — user indexed
// Confirmed from ETH tx 0x831367d37ebb2bd3bf41a1152124a493c309b1f092ce161da578d635b49d23e8
const REUSD_INSTANT_REDEEM_TOPIC = "0xa58dba63852b106a5b3bbc558fa3fbcfe606497cbc0af66837a83c3560ec6220";

// --- Ethereum configs ---

const ETHEREUM = chainConfig("ethereum");

const EXTENDED_ETHEREUM_TRANSFER_EXPANSION_SPECS: Array<{
  stablecoinId: string;
  dustThreshold: number;
}> = [
  { stablecoinId: "u-united-stables", dustThreshold: 10_000 },
  { stablecoinId: "a7a5-old-vector", dustThreshold: 10_000 },
  { stablecoinId: "usdai-usd-ai", dustThreshold: 10_000 },
  { stablecoinId: "usda-avalon", dustThreshold: 10_000 },
  { stablecoinId: "brz-transfero", dustThreshold: 10_000 },
  { stablecoinId: "kag-kinesis", dustThreshold: 10 },
  { stablecoinId: "satusd-river", dustThreshold: 10_000 },
  { stablecoinId: "rwausdi-multipli", dustThreshold: 10_000 },
  { stablecoinId: "fpi-frax", dustThreshold: 10_000 },
  { stablecoinId: "aeur-anchored-coins", dustThreshold: 10_000 },
  { stablecoinId: "usdq-quantoz", dustThreshold: 10_000 },
  { stablecoinId: "usdx-hex-trust", dustThreshold: 10_000 },
  { stablecoinId: "mim-abracadabra", dustThreshold: 10_000 },
  { stablecoinId: "usat-tether", dustThreshold: 10_000 },
  { stablecoinId: "zeusd-zoth", dustThreshold: 10_000 },
  { stablecoinId: "gyd-gyroscope", dustThreshold: 10_000 },
  { stablecoinId: "ggbr-goldfish-gold", dustThreshold: 10 },
  { stablecoinId: "xsgd-straitsx", dustThreshold: 10_000 },
  { stablecoinId: "idrt-rupiah-token", dustThreshold: 10_000 },
  { stablecoinId: "tryb-bilira", dustThreshold: 10_000 },
  { stablecoinId: "eurs-stasis", dustThreshold: 10_000 },
  { stablecoinId: "pusd-plume", dustThreshold: 10_000 },
  { stablecoinId: "usbd-bima", dustThreshold: 10_000 },
  { stablecoinId: "dgld-gold-token-sa", dustThreshold: 10 },
  { stablecoinId: "axcnh-anchorx", dustThreshold: 10_000 },
  { stablecoinId: "eurq-quantoz", dustThreshold: 10_000 },
  { stablecoinId: "gyen-gyen", dustThreshold: 10_000 },
  { stablecoinId: "usdu-usdu-finance", dustThreshold: 10_000 },
  { stablecoinId: "zarp-zarp", dustThreshold: 10_000 },
  { stablecoinId: "usdp-parallel", dustThreshold: 10_000 },
  { stablecoinId: "pht-pht", dustThreshold: 10_000 },
  { stablecoinId: "vchf-vnx", dustThreshold: 10_000 },
  { stablecoinId: "ussd-sonic-labs", dustThreshold: 10_000 },
  { stablecoinId: "cadc-cad-coin", dustThreshold: 10_000 },
  { stablecoinId: "veur-vnx", dustThreshold: 10_000 },
  { stablecoinId: "dusd-dtrinity", dustThreshold: 10_000 },
  { stablecoinId: "usdaf-asymmetry", dustThreshold: 10_000 },
  { stablecoinId: "eurau-allunity", dustThreshold: 10_000 },
  { stablecoinId: "dusd-alto", dustThreshold: 10_000 },
  { stablecoinId: "ebusd-ebisu", dustThreshold: 10_000 },
];

const MINT_BURN_CONFIG_SPECS: MintBurnContractConfigSpec[] = [
  // --- Safe havens ---
  {
    chain: ETHEREUM, stablecoinId: "usdt-tether",
    dustThreshold: 10_000, startBlock: 21_900_000,
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
    chain: ETHEREUM, stablecoinId: "usdc-circle",
    dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
    bridgeDetection: ccipBridgeDetection([
      "0x03d19033ada17750d5bc2d8e325337d0748f9fef",
    ]),
  },
  {
    chain: ETHEREUM, stablecoinId: "fdusd-first-digital",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "pyusd-paypal",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },

  // --- Risky / crypto-backed ---
  {
    chain: ETHEREUM, stablecoinId: "dai-makerdao",
    dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "gho-aave",
    dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usde-ethena",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usds-sky",
    dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "frxusd-frax",
    dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "bold-liquity",
    dustThreshold: 10_000, startBlock: 21_900_000,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "fxusd-f-x-protocol",
    dustThreshold: 10_000, startBlock: 19_287_523,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "crvusd-curve",
    dustThreshold: 10_000, startBlock: 17_257_952,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "ausd-agora",
    dustThreshold: 10_000, startBlock: 20_257_620,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "zchf-frankencoin",
    dustThreshold: 10_000, startBlock: 18_451_518,
    tier: "extended",
    events: transferMintBurn(),
    bridgeDetection: ccipBridgeDetection([
      "0x9359cd75549dae00cdd8d22297bc9b13fbbe4b79",
    ]),
  },
  {
    chain: ETHEREUM, stablecoinId: "eurc-circle",
    dustThreshold: 10_000, startBlock: 14_807_227,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "paxg-paxos",
    dustThreshold: 10, startBlock: 8_426_430,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "xaut-tether",
    dustThreshold: 10, startBlock: 13_524_498,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usdg-paxos",
    dustThreshold: 10_000, startBlock: 20_915_336,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usd1-world-liberty-financial",
    dustThreshold: 10_000, startBlock: 21_720_503,
    tier: "extended",
    events: transferMintBurn(),
    bridgeDetection: ccipBridgeDetection([
      "0x36a72ed0096b414521c45e3ddc9ed657d1d9c141",
    ]),
  },

  // --- Top-50 supported expansion (Ethereum only) ---
  {
    chain: ETHEREUM, stablecoinId: "usdf-falcon",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usyc-hashnote",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "rlusd-ripple",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usdy-ondo-finance",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "buidl-blackrock",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usdd-tron-dao-reserve",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usdtb-ethena",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "m-m0",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usd0-usual",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "tusd-trueusd",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "cusd-cap",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usr-resolv",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "frax-frax",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "dola-inverse-finance",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "iusd-infinifi",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "gusd-gate",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "avusd-avant",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
    bridgeDetection: ccipBridgeDetection([
      "0x81b72171642fab457aa815c0b8412a22b63a6af8",
    ]),
  },
  {
    chain: ETHEREUM, stablecoinId: "pmusd-precious-metals",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usdz-anzen",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "mnee-mnee",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "tbill-openeden",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },

  // --- Top-100 supported expansion (Ethereum only) ---
  {
    chain: ETHEREUM, stablecoinId: "usdo-openeden",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
    bridgeDetection: ccipBridgeDetection([
      "0x500d4882938020e939a5666c1b4200873da7efd3",
    ]),
  },
  {
    chain: ETHEREUM, stablecoinId: "eurcv-societe-generale-forge",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "reusd-resupply",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "euri-banking-circle",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "gusd-gemini",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usdp-paxos",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "xusd-straitsx",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "musd-metamask",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "yusd-aegis",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "susd-synthetix",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "lusd-liquity",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usdcv-societe-generale-forge",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "eure-monerium",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usn-noon",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "eusd-electronic-usd",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "meusd-mezo",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "msusd-metronome",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "nusd-neutrl",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "alusd-alchemix",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "fidd-fidelity",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "msusd-main-street",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },

  // --- Top-150 supported expansion (Ethereum only) ---
  {
    chain: ETHEREUM, stablecoinId: "wusd-worldwide",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "sbc-brale",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "ousd-origin-protocol",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usp-pikudao",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "usdr-stablr",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "ustb-superstate",
    dustThreshold: 1_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "ousg-ondo-finance",
    dustThreshold: 100, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "mtbill-midas",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "thbill-theo",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "wsrusd-reservoir",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "audd-novatti",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "jpyc-jpyc",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "xaum-matrixdock",
    dustThreshold: 10, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "eurr-stablr",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "europ-schuman",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "deuro-deuro",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "tgbp-tokenised",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "syrupusdc-maple",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "syrupusdt-maple",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "aid-gaib",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM, stablecoinId: "apxusd-apyx",
    dustThreshold: 10_000, startBlock: 21_900_000,
    tier: "extended",
    events: transferMintBurn(),
  },
  ...EXTENDED_ETHEREUM_TRANSFER_EXPANSION_SPECS.map(
    ({ stablecoinId, dustThreshold }): MintBurnContractConfigSpec => ({
      chain: ETHEREUM,
      stablecoinId,
      dustThreshold,
      startBlock: 21_900_000,
      tier: "extended",
      events: transferMintBurn(),
    }),
  ),

  // --- reUSD (Re Protocol, ID 339) — Ethereum only ---
  {
    chain: ETHEREUM, stablecoinId: "reusd-re-protocol",
    contractAddressOverride: "0x4691c475be804fa85f91c2d6d0adf03114de3093",
    decimalsOverride: 18,
    dustThreshold: 10_000, startBlock: 21_675_000,
    tier: "extended",
    events: [{
      signature: "Deposited(address,address,uint256)",
      topicHash: REUSD_DEPOSITED_TOPIC,
      direction: "mint",
      amountEncoding: "nth-data-uint256",
      dataSlot: 2, // data = [user(32B), token(32B), amount(32B)]
    }],
  },
  {
    chain: ETHEREUM, stablecoinId: "reusd-re-protocol",
    contractAddressOverride: "0x8aeb9453ef22cb38abc7a3af9c208f65c1bfe31e",
    decimalsOverride: 18,
    dustThreshold: 10_000, startBlock: 23_479_000,
    tier: "extended",
    events: [{
      signature: "InstantRedemptionProcessed(address,uint256,uint256)",
      topicHash: REUSD_INSTANT_REDEEM_TOPIC,
      direction: "burn",
      amountEncoding: "first-data-uint256", // data[0] = sharesBurned
    }],
  },
];

export const MINT_BURN_CONFIGS: MintBurnContractConfig[] = MINT_BURN_CONFIG_SPECS.map(
  resolveMintBurnContractConfig,
);

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
