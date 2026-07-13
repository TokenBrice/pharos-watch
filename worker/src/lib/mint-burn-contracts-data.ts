import { chainConfig } from "./chain-config";
import type {
  MintBurnBridgeDetectionConfig,
  MintBurnContractConfigSpec,
} from "./mint-burn-contracts-types";
import {
  ccipBridgeDetection,
  cctpBridgeDetection,
  layerZeroOftBridgeDetection,
  transferMintBurn,
} from "./mint-burn-contracts-helpers";

const ETHEREUM = chainConfig("ethereum");
const ARBITRUM = chainConfig("arbitrum");

// Phase 2 readiness — USDT Tron uses these instead of Transfer
const USDT_ISSUE_TOPIC = "0xcb8241adb0c3fdb35b70c24ce35c5eb0c17af7431c99f827d44a445ca624176a";
const USDT_REDEEM_TOPIC = "0x702d5967f45f6513a38ffc42d6ba9bf230bd40e8f53b16363c7eb4fd2deb9a44";

// Reviewed Arbitrum deployment bound: the USDai proxy is live by block
// 336,209,932 (2025-05-13), with first observed contract activity the next day.
const USD_AI_ARBITRUM_DEPLOY_BLOCK = 336_209_932;

// Default Ethereum coverage-floor block: roughly 2025-01-13, the lower bound
// for mint/burn coverage on assets without a reviewed deploy block.
const ETHEREUM_COVERAGE_FLOOR_BLOCK = 21_900_000;

const EXTENDED_ETHEREUM_TRANSFER_EXPANSION_SPECS: Array<{
  stablecoinId: string;
  dustThreshold: number;
  bridgeDetection?: MintBurnBridgeDetectionConfig;
}> = [
  { stablecoinId: "u-united-stables", dustThreshold: 10_000 },
  { stablecoinId: "a7a5-old-vector", dustThreshold: 10_000 },
  { stablecoinId: "usda-avalon", dustThreshold: 10_000 },
  { stablecoinId: "brz-transfero", dustThreshold: 10_000 },
  { stablecoinId: "kag-kinesis", dustThreshold: 10 },
  { stablecoinId: "satusd-river", dustThreshold: 10_000 },
  { stablecoinId: "rwausdi-multipli", dustThreshold: 10_000 },
  { stablecoinId: "fpi-frax", dustThreshold: 10_000 },
  { stablecoinId: "usdq-quantoz", dustThreshold: 10_000 },
  { stablecoinId: "usdx-hex-trust", dustThreshold: 10_000 },
  { stablecoinId: "mim-abracadabra", dustThreshold: 10_000 },
  { stablecoinId: "usat-tether", dustThreshold: 10_000 },
  { stablecoinId: "zeusd-zoth", dustThreshold: 10_000 },
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
  { stablecoinId: "usdu-usdu-finance", dustThreshold: 10_000 },
  { stablecoinId: "zarp-zarp", dustThreshold: 10_000 },
  { stablecoinId: "usdp-parallel", dustThreshold: 10_000 },
  { stablecoinId: "pht-pht", dustThreshold: 10_000 },
  { stablecoinId: "vchf-vnx", dustThreshold: 10_000 },
  { stablecoinId: "ussd-sonic-labs", dustThreshold: 10_000 },
  { stablecoinId: "cadc-cad-coin", dustThreshold: 10_000 },
  { stablecoinId: "cadd-cad-digital", dustThreshold: 10_000 },
  { stablecoinId: "veur-vnx", dustThreshold: 10_000 },
  { stablecoinId: "dusd-dtrinity", dustThreshold: 10_000 },
  { stablecoinId: "usdaf-asymmetry", dustThreshold: 10_000 },
  { stablecoinId: "eurau-allunity", dustThreshold: 10_000 },
  { stablecoinId: "dusd-alto", dustThreshold: 10_000 },
  { stablecoinId: "ebusd-ebisu", dustThreshold: 10_000 },
  { stablecoinId: "ftusd-flying-tulip", dustThreshold: 10_000 },
  { stablecoinId: "usdkg-gold-dollar", dustThreshold: 10_000 },
  { stablecoinId: "chfau-allunity", dustThreshold: 10_000 },
  { stablecoinId: "mxnb-juno", dustThreshold: 10_000 },
  { stablecoinId: "cjpy-yamato", dustThreshold: 10_000 },
  { stablecoinId: "stusds-sky", dustThreshold: 10_000 },
  { stablecoinId: "busd0-usual", dustThreshold: 10_000 },
  { stablecoinId: "stkgho-umbrella-aave", dustThreshold: 10_000 },
  { stablecoinId: "stcusd-cap", dustThreshold: 10_000 },
  { stablecoinId: "sbold-k3-capital", dustThreshold: 10_000 },
  { stablecoinId: "ybold-yearn", dustThreshold: 10_000 },
  { stablecoinId: "yusd-yieldfi", dustThreshold: 10_000 },
  { stablecoinId: "said-gaib", dustThreshold: 10_000 },
  // --- Top-50 supported expansion (Ethereum only) ---
  { stablecoinId: "usdf-falcon", dustThreshold: 10_000 },
  { stablecoinId: "usyc-hashnote", dustThreshold: 10_000 },
  { stablecoinId: "rlusd-ripple", dustThreshold: 10_000 },
  { stablecoinId: "usdy-ondo-finance", dustThreshold: 10_000 },
  { stablecoinId: "buidl-blackrock", dustThreshold: 10_000 },
  { stablecoinId: "usdd-tron-dao-reserve", dustThreshold: 10_000 },
  { stablecoinId: "usdtb-ethena", dustThreshold: 10_000 },
  { stablecoinId: "m-m0", dustThreshold: 10_000 },
  { stablecoinId: "usd0-usual", dustThreshold: 10_000 },
  { stablecoinId: "tusd-trueusd", dustThreshold: 10_000 },
  { stablecoinId: "cusd-cap", dustThreshold: 10_000 },
  { stablecoinId: "frax-frax", dustThreshold: 10_000 },
  { stablecoinId: "dola-inverse-finance", dustThreshold: 10_000 },
  { stablecoinId: "iusd-infinifi", dustThreshold: 10_000 },
  { stablecoinId: "gusd-gate", dustThreshold: 10_000 },
  {
    stablecoinId: "avusd-avant",
    dustThreshold: 10_000,
    bridgeDetection: ccipBridgeDetection([
      "0x81b72171642fab457aa815c0b8412a22b63a6af8",
    ]),
  },
  { stablecoinId: "pmusd-precious-metals", dustThreshold: 10_000 },
  { stablecoinId: "usdz-anzen", dustThreshold: 10_000 },
  { stablecoinId: "mnee-mnee", dustThreshold: 10_000 },
  { stablecoinId: "tbill-openeden", dustThreshold: 10_000 },
  // --- Top-100 supported expansion (Ethereum only) ---
  {
    stablecoinId: "usdo-openeden",
    dustThreshold: 10_000,
    bridgeDetection: ccipBridgeDetection([
      "0x500d4882938020e939a5666c1b4200873da7efd3",
    ]),
  },
  { stablecoinId: "eurcv-societe-generale-forge", dustThreshold: 10_000 },
  { stablecoinId: "reusd-resupply", dustThreshold: 10_000 },
  { stablecoinId: "euri-banking-circle", dustThreshold: 10_000 },
  { stablecoinId: "gusd-gemini", dustThreshold: 10_000 },
  { stablecoinId: "usdp-paxos", dustThreshold: 10_000 },
  { stablecoinId: "xusd-straitsx", dustThreshold: 10_000 },
  { stablecoinId: "musd-metamask", dustThreshold: 10_000 },
  { stablecoinId: "yusd-aegis", dustThreshold: 10_000 },
  { stablecoinId: "lusd-liquity", dustThreshold: 10_000 },
  { stablecoinId: "usdcv-societe-generale-forge", dustThreshold: 10_000 },
  { stablecoinId: "eure-monerium", dustThreshold: 10_000 },
  { stablecoinId: "usn-noon", dustThreshold: 10_000 },
  { stablecoinId: "eusd-electronic-usd", dustThreshold: 10_000 },
  { stablecoinId: "meusd-mezo", dustThreshold: 10_000 },
  { stablecoinId: "msusd-metronome", dustThreshold: 10_000 },
  { stablecoinId: "nusd-neutrl", dustThreshold: 10_000 },
  { stablecoinId: "alusd-alchemix", dustThreshold: 10_000 },
  { stablecoinId: "fidd-fidelity", dustThreshold: 10_000 },
  // --- Top-150 supported expansion (Ethereum only) ---
  { stablecoinId: "wusd-worldwide", dustThreshold: 10_000 },
  { stablecoinId: "sbc-brale", dustThreshold: 10_000 },
  { stablecoinId: "ousd-origin-protocol", dustThreshold: 10_000 },
  { stablecoinId: "usp-pikudao", dustThreshold: 10_000 },
  { stablecoinId: "ustb-superstate", dustThreshold: 1_000 },
  { stablecoinId: "ousg-ondo-finance", dustThreshold: 100 },
  { stablecoinId: "mtbill-midas", dustThreshold: 10_000 },
  { stablecoinId: "thbill-theo", dustThreshold: 10_000 },
  { stablecoinId: "wsrusd-reservoir", dustThreshold: 10_000 },
  { stablecoinId: "audd-novatti", dustThreshold: 10_000 },
  { stablecoinId: "jpyc-jpyc", dustThreshold: 10_000 },
  { stablecoinId: "xaum-matrixdock", dustThreshold: 10 },
  { stablecoinId: "europ-schuman", dustThreshold: 10_000 },
  { stablecoinId: "deuro-deuro", dustThreshold: 10_000 },
  { stablecoinId: "tgbp-tokenised", dustThreshold: 10_000 },
  { stablecoinId: "syrupusdc-maple", dustThreshold: 10_000 },
  { stablecoinId: "syrupusdt-maple", dustThreshold: 10_000 },
  { stablecoinId: "aid-gaib", dustThreshold: 10_000 },
  { stablecoinId: "apxusd-apyx", dustThreshold: 10_000 },
];

export const MINT_BURN_CONFIG_SPECS: MintBurnContractConfigSpec[] = [
  // --- Safe havens ---
  {
    chain: ETHEREUM,
    stablecoinId: "usdt-tether",
    dustThreshold: 10_000,
    startBlock: ETHEREUM_COVERAGE_FLOOR_BLOCK,
    // USDT issue()/redeem() emit only Issue/Redeem, not Transfer.
    // No zero-address Transfer events are produced.
    events: [
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
    chain: ETHEREUM,
    stablecoinId: "usdc-circle",
    dustThreshold: 10_000,
    startBlock: ETHEREUM_COVERAGE_FLOOR_BLOCK,
    events: transferMintBurn(),
    bridgeDetection: cctpBridgeDetection([
      "0xfd78ee919681417d192449715b2594ab58f5d002",
    ]),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "fdusd-first-digital",
    dustThreshold: 10_000,
    startBlock: ETHEREUM_COVERAGE_FLOOR_BLOCK,
    tier: "extended",
    isDefaultStartBlock: true,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "pyusd-paypal",
    dustThreshold: 10_000,
    startBlock: ETHEREUM_COVERAGE_FLOOR_BLOCK,
    tier: "extended",
    isDefaultStartBlock: true,
    events: transferMintBurn(),
  },

  // --- Risky / crypto-backed ---
  {
    // 3Jane USD3 TransparentUpgradeableProxy, verified Blockscout deployment tx
    // 0xa50b1bacaceebe52c33a9815fa9e0eb8549f2c38218f41745647b881a7008243.
    chain: ETHEREUM,
    stablecoinId: "usd3-3jane",
    dustThreshold: 10_000,
    startBlock: 23_214_680,
    tier: "extended",
    startBlockSource: "blockscout-ethereum-proxy-deployment-2025-08-25",
    startBlockConfidence: "high",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "dai-makerdao",
    dustThreshold: 10_000,
    startBlock: ETHEREUM_COVERAGE_FLOOR_BLOCK,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "gho-aave",
    dustThreshold: 10_000,
    startBlock: ETHEREUM_COVERAGE_FLOOR_BLOCK,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "usde-ethena",
    dustThreshold: 10_000,
    startBlock: ETHEREUM_COVERAGE_FLOOR_BLOCK,
    tier: "extended",
    isDefaultStartBlock: true,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "usds-sky",
    dustThreshold: 10_000,
    startBlock: ETHEREUM_COVERAGE_FLOOR_BLOCK,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "frxusd-frax",
    dustThreshold: 10_000,
    startBlock: ETHEREUM_COVERAGE_FLOOR_BLOCK,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "bold-liquity",
    dustThreshold: 10_000,
    startBlock: ETHEREUM_COVERAGE_FLOOR_BLOCK,
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "fxusd-f-x-protocol",
    dustThreshold: 10_000,
    startBlock: 19_287_523,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "crvusd-curve",
    dustThreshold: 10_000,
    startBlock: 17_257_952,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "ausd-agora",
    dustThreshold: 10_000,
    startBlock: 20_257_620,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "zchf-frankencoin",
    dustThreshold: 10_000,
    startBlock: 18_451_518,
    tier: "extended",
    events: transferMintBurn(),
    bridgeDetection: ccipBridgeDetection([
      "0x9359cd75549dae00cdd8d22297bc9b13fbbe4b79",
    ]),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "eurc-circle",
    dustThreshold: 10_000,
    startBlock: 14_807_227,
    tier: "extended",
    events: transferMintBurn(),
    bridgeDetection: cctpBridgeDetection([
      "0xfd78ee919681417d192449715b2594ab58f5d002",
    ]),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "paxg-paxos",
    dustThreshold: 10,
    startBlock: 8_426_430,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "xaut-tether",
    dustThreshold: 10,
    startBlock: 13_524_498,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "usdg-paxos",
    dustThreshold: 10_000,
    startBlock: 20_915_336,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    chain: ETHEREUM,
    stablecoinId: "usd1-world-liberty-financial",
    dustThreshold: 10_000,
    startBlock: 21_720_503,
    tier: "extended",
    events: transferMintBurn(),
    bridgeDetection: ccipBridgeDetection([
      "0x36a72ed0096b414521c45e3ddc9ed657d1d9c141",
    ]),
  },

  // --- Top-50 supported expansion (Ethereum only) ---
  {
    // Saturn USDat — proxy 0x23238f20b894f29041f48d88ee91131c395aaa71, deployed 2026-03-10
    chain: ETHEREUM,
    stablecoinId: "usdat-saturn",
    dustThreshold: 10_000,
    startBlock: 24_629_431,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    // Tangent USD (USG) — verified ERC-20 deployed by tangent-finance.eth in tx
    // 0xeae86c6a45b049ab20cb3d7e13b6dcd39e2a5b4b47ac05d79a35cf7c2018a1ed.
    chain: ETHEREUM,
    stablecoinId: "usg-tangent",
    dustThreshold: 10_000,
    startBlock: 24_442_033,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    // Wrapped M (wM) — WrappedMToken proxy 0x437cc33344a0b27a429f795ff6b469c72698b291, deployed ~Aug 2024
    // startBlock bisected via eth_getCode: contract absent at 20_527_909, present at 20_527_947
    chain: ETHEREUM,
    stablecoinId: "wm-m0",
    dustThreshold: 10_000,
    startBlock: 20_527_947,
    tier: "extended",
    events: transferMintBurn(),
  },
  {
    // Nerona USD (USDnr) — proxy 0xd48e565561416de59da1050ed70b8d75e8ef28f9
    // Default start block (deploy block unresolved without Etherscan API key); ~$50M supply
    chain: ETHEREUM,
    stablecoinId: "usdnr-nerona",
    dustThreshold: 10_000,
    startBlock: ETHEREUM_COVERAGE_FLOOR_BLOCK,
    tier: "extended",
    isDefaultStartBlock: true,
    events: transferMintBurn(),
  },

  // --- Top-50/100/150 supported expansion (Ethereum only) ---
  // Mechanical default-block entries live in EXTENDED_ETHEREUM_TRANSFER_EXPANSION_SPECS.
  ...EXTENDED_ETHEREUM_TRANSFER_EXPANSION_SPECS.map(
    ({ stablecoinId, dustThreshold, bridgeDetection }): MintBurnContractConfigSpec => ({
      chain: ETHEREUM,
      stablecoinId,
      dustThreshold,
      bridgeDetection,
      startBlock: ETHEREUM_COVERAGE_FLOOR_BLOCK,
      tier: "extended",
      isDefaultStartBlock: true,
      events: transferMintBurn(),
    }),
  ),
  {
    chain: ARBITRUM,
    stablecoinId: "usdai-usd-ai",
    dustThreshold: 10_000,
    startBlock: USD_AI_ARBITRUM_DEPLOY_BLOCK,
    tier: "extended",
    bridgeDetection: layerZeroOftBridgeDetection([
      "0xffa10065ce1d1c42fabc46e06b84ed8ffeb4bae5",
      "0x31cae3b7fb82d847621859fb1585353c5720660d",
    ]),
    startBlockSource: "reviewed-arbitrum-deployment-2025-05-13",
    startBlockConfidence: "high",
    events: transferMintBurn(),
  },

  // --- reUSD (Re Protocol, ID 339) — Ethereum only ---
  // Track the reUSD token's canonical zero-address Transfers. The vault
  // Deposited event reports deposited collateral units, so USDC/USDT mints
  // are not valid 18-decimal reUSD issuance amounts.
  {
    chain: ETHEREUM,
    stablecoinId: "reusd-re-protocol",
    dustThreshold: 10_000,
    startBlock: 21_675_000,
    tier: "extended",
    events: transferMintBurn(),
  },
];
