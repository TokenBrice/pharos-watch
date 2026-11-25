import { startOfUtcDaySec } from "./time-buckets";
import { CHAIN_META } from "../types/chain-identity";
import type { StablecoinMeta } from "../types/stablecoin-meta-schemas";
import type { SupplyUnavailableReason } from "../types/supply";
import { PUBLIC_RPC_URLS, SUPPLY_RPC_DEFAULTS } from "./chain-rpc-registry";
import { HYPEREVM_HISTORY_RPC_URL } from "./evm-rpc-capabilities";
import { isFixedDecimalDeployment } from "./deployment-amounts";
import { XrplIssuedCurrencyAmountSchema } from "../types/deployment-amounts";

export type OnchainSupplyContract = NonNullable<StablecoinMeta["contracts"]>[number];
export const NAV_SUPPLY_LEDGER_FRESHNESS = { maxAgeSec: 600, maxFutureSkewSec: 60 } as const;

export interface CuratedOnchainSupplyContractConfig {
  chain: string;
  /** Exact deployment when a chain hosts multiple independently issued registers. */
  address?: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  /** Issuer-documented operational holders excluded by XRPL gateway_balances. */
  hotwallet?: readonly string[];
  /** Explicit classic Stellar asset code when catalog metadata stores only the bare issuer G-account. */
  stellarAssetCode?: string;
  /** Issuer-documented Solana pre-mint/treasury SPL token accounts subtracted atomically at the same finalized slot. */
  excludedTokenAccounts?: readonly string[];
  /**
   * Some reviewed native deployments are live with zero supply. Keep this
   * opt-in so ordinary aggregate paths still fail closed on empty reads.
   */
  allowZeroSupply?: boolean;
}

function supplyProbeChain(
  chain: keyof typeof SUPPLY_RPC_DEFAULTS,
  overrides: Omit<ReviewedOnchainSupplyDeployment, "chain"> = {},
): ReviewedOnchainSupplyDeployment {
  return { chain, ...SUPPLY_RPC_DEFAULTS[chain], ...overrides };
}

export interface CuratedAggregateOnchainSupplyContract {
  config: CuratedOnchainSupplyContractConfig;
  contract: OnchainSupplyContract;
}

export const ZEPHYR_ZSD_ASSET_ID = "zsd-zephyr-protocol";
export const ZEPHYR_ZYS_ASSET_ID = "zys-zephyr-protocol";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Shared by Starknet contract addresses (felts: hex, up to 252 bits, usually
// written zero-padded to 64 nibbles) and Aptos-framework fungible-asset metadata
// addresses (32-byte account ids, leading zeros customarily trimmed). All use
// a 0x prefix followed by at most 64 nibbles.
const HEX32_ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;
// ICP canister ids are 10-byte principals in base32-with-CRC text form, i.e.
// four groups of five characters plus a three-character tail. Longer
// self-authenticating (user) principals are deliberately rejected.
// eslint-disable-next-line security/detect-unsafe-regex -- anchored fixed-width principal pattern; finite quantifiers, no backtracking risk.
const ICP_CANISTER_ID_RE = /^[a-z2-7]{5}(-[a-z2-7]{5}){3}-[a-z2-7]{3}$/;

/**
 * Supply-read families the probe lanes can dispatch. EVM and Solana are the
 * original two; Starknet and ICP were added so non-EVM legs can join
 * fail-closed curated aggregates instead of poisoning them.
 */
export const EEARN_SUI_COIN_TYPE = "0x34469c8accdd673df02600265cbbad3688577f0e716866e257f88d448d463492::eearn::EEARN";

export type OnchainSupplyProbeFamily = "evm" | "solana" | "movement" | "aptos" | "starknet" | "icp" | "sui" | "stellar" | "xrpl";

const NON_EVM_PROBE_FAMILY_BY_CHAIN: Readonly<Record<string, OnchainSupplyProbeFamily>> = {
  solana: "solana",
  movement: "movement",
  aptos: "aptos",
  starknet: "starknet",
  icp: "icp",
  stellar: "stellar",
  xrpl: "xrpl",
};

/** Owner-reviewed current-token-stock perimeter; pending/retired claims are separate diagnostics. */
export const SFRAX_STOCK_PERIMETER = {
  assetId: "sfrax-frax",
  contracts: [
    { chain: "ethereum", address: "0xa663b02cf0a4b149d2ad41910cb81e23e1c41c32", decimals: 18 },
    { chain: "arbitrum", address: "0xe3b3fe7bca19ca77ad877a5bebab186becfad906", decimals: 18 },
    { chain: "avalanche", address: "0x3405e88af759992937b84e58f2fe691ef0eea320", decimals: 18 },
    { chain: "base", address: "0xe4796ccb6bb5de2290c417ac337f2b66ca2e770e", decimals: 18 },
    { chain: "blast", address: "0xe4796ccb6bb5de2290c417ac337f2b66ca2e770e", decimals: 18, ...SUPPLY_RPC_DEFAULTS.blast },
    { chain: "bsc", address: "0xa63f56985f9c7f3bc9ffc5685535649e0c1a55f3", decimals: 18 },
    { chain: "fraxtal", address: "0x5bff88ca1442c2496f7e475e9e7786383bc070c0", decimals: 18, ...SUPPLY_RPC_DEFAULTS.fraxtal },
    { chain: "metis", address: "0xe4796ccb6bb5de2290c417ac337f2b66ca2e770e", decimals: 18, ...SUPPLY_RPC_DEFAULTS.metis },
    { chain: "optimism", address: "0x2dd1b4d4548accea497050619965f91f78b3b532", decimals: 18 },
    { chain: "solana", address: "DnVyztLHnDyTqL3xfPYF9Uqpgrhcxphn6e31sVAwtg6K", decimals: 9 },
  ],
  oftAdapter: "0xe4796ccb6bb5de2290c417ac337f2b66ca2e770e",
  migratedStandardBridge: "0x34c0bd5877a5ee7099d0f5688d65f4bb9158bde2",
  migratedRemoteToken: "0xfc00000000000000000000000000000000000008",
  migratedL1Token: "0xcf62f905562626cfcdd2261162a51fd02fc9c5b6",
  // Included in native stock. No sFRAX-specific protocol-owned exclusion is reviewed.
  compoundHolder: "0x3afdc9bca9213a35503b077a6072f3d0d5ab0840",
  ferries: [
    { chain: "arbitrum", key: "arbitrumFerry", native: "0x2453b1fbd17cea069a31c9d16a27f4f93a85cc0d", remote: "0x1b0b9991df27a4f2847478127d51fb29883882f5" },
    { chain: "avalanche", key: "avalancheFerry", native: "0x59ae66fb395893e3fd965adb06a52d06c49df8a9", remote: "0x0304a365c0fbb4b1ad423887861b9b69a5f0c00e" },
    { chain: "bsc", key: "bscFerry", native: "0xe3e7f354ac948ceba925181c81618d7c9b3da8c9", remote: "0x5e8422345238f34275888049021821e8e08caa1f" },
    { chain: "optimism", key: "optimismFerry", native: "0x9694dcf5b6ccf6216b05fe64945f62603e2d2367", remote: "0xd1738eb733a636d1b8665f48bc8a24da889c2562" },
  ],
  historicalNativeFerries: [
    { chain: "fraxtal", key: "historicalFraxtalFerry", native: "0x2b4864c2f2a2c275c6c66b90a2ae6be9fa9cbe47", targetToken: "0xfc00000000000000000000000000000000000008" },
    // Halted destination is outside active float. Measure L1 custody; do not invent its L2 zero or pending outcome.
    { chain: "polygon-zkevm", key: "retiredZkevmFerry", native: "0x602ccfee6b4ba8eb5e35cf26e05fdede379e578e", targetToken: "0x2c37fb628b35dfdfd515d41b0caae11b542773c3" },
  ],
  solanaMintAuthority: "3BcysJF4fQx86fVTDTBGNpZyRpeMyTF8XsuvPHJQuP3V",
  solanaProgram: "DBQQ2NrApPx8uarKmBtZGTg6jsPk4ya2Mi2hRKZvV2tY",
} as const;

export function isSfraxStockContractRoster(meta: StablecoinMeta): boolean {
  return meta.id === SFRAX_STOCK_PERIMETER.assetId
    && meta.contracts?.length === SFRAX_STOCK_PERIMETER.contracts.length
    && SFRAX_STOCK_PERIMETER.contracts.every((expected) => meta.contracts?.some((actual) =>
      isFixedDecimalDeployment(actual) && actual.chain === expected.chain
      && (expected.chain === "solana" ? actual.address === expected.address : actual.address.toLowerCase() === expected.address)
      && actual.decimals === expected.decimals));
}

// Default refusal remains until the same run produces an admitted, complete
// current-token-stock observation. It is not a blanket acceptance of restored rows.
const REVIEWED_ONCHAIN_SUPPLY_HOLDS: Readonly<Record<string, SupplyUnavailableReason>> = {
  [SFRAX_STOCK_PERIMETER.assetId]: "economic-float-unreconciled",
  // sBOLD was exploited on 2026-11-18 (Ethereum block 26441936): about 4.4e19
  // shares now claim about 4.5 BOLD, so its token stock is no economic float.
  // K3 Capital paused the vault; remove once K3 restores it.
  "sbold-k3-capital": "economic-float-unreconciled",
};

export function getOnchainSupplyHoldReason(assetId: string): SupplyUnavailableReason | null {
  return Object.prototype.hasOwnProperty.call(REVIEWED_ONCHAIN_SUPPLY_HOLDS, assetId)
    ? REVIEWED_ONCHAIN_SUPPLY_HOLDS[assetId] : null;
}

export function isOnchainSupplyPartitionExcluded(assetId: string): boolean {
  // USTB includes off-chain book entries; gtUSDCp has independent vault NAVs.
  return assetId === "ustb-superstate" || assetId === "gtusdcp-gauntlet";
}

export function prefersOnChainSupplyMcap(meta: Pick<StablecoinMeta, "id">): boolean {
  return REVIEWED_ONCHAIN_SUPPLY_PLANS[meta.id]?.preferMcap === true;
}

/** Non-commodity preferred-native plans run through the shared fiat-cg native-supply lane. */
export function prefersReviewedNativeFiatSupply(
  meta: Pick<StablecoinMeta, "id" | "flags">,
): boolean {
  return meta.flags.pegCurrency !== "GOLD"
    && meta.flags.pegCurrency !== "SILVER"
    && prefersOnChainSupplyMcap(meta);
}

export function isKinesisWrapperSupplyId(id: string): boolean {
  return id === "kau-kinesis" || id === "kag-kinesis";
}

export type SupplementalOnChainSupplySource = "onchain-total-supply" | "onchain-circulating-supply";

export interface OnChainSupplyExclusionConfig {
  chain: string;
  holderAddresses: string[];
  supplySource: SupplementalOnChainSupplySource;
  historicalBackfillStartDay?: number;
}

interface ReviewedOnchainSupplyDeployment extends CuratedOnchainSupplyContractConfig {
  /** Explicit permission for additive dropout repair, independent of aggregate readability. */
  dropoutRepair?: "registry";
  reader?: "buidl-aptos";
}

interface ReviewedOnchainSupplyPlan {
  aggregateContracts?: readonly ReviewedOnchainSupplyDeployment[];
  repairContracts?: readonly ReviewedOnchainSupplyDeployment[];
  preferMcap?: boolean;
  canonicalSupplyChain?: string;
  excludedRepresentations?: readonly { chain: string; address: string; canonicalChain: string }[];
  unreadableDeployments?: readonly { chain: string; address: string }[];
  escrowResidual?: CuratedAggregateEscrowResidualConfig;
  excludedBalances?: OnChainSupplyExclusionConfig;
  nativeWorkflow?: "hive-debt" | "zephyr-scanner" | "pinned-native-shares";
}

/** Reviewed deployment stock, accounting and supply preference, owned together per asset. */
export const REVIEWED_ONCHAIN_SUPPLY_PLANS: Readonly<Record<string, ReviewedOnchainSupplyPlan>> = {
  // Reviewed 2026-11-12: issuer-identified native share registers. Verified EVM
  // bridges burn source shares and issue destination shares, not lock/mint.
  // Non-EVM bridge accounting and a complete issuer-escrow census are unverified;
  // issuer share-class identity supports addition, not a universal no-escrow claim.
  // https://public-feed.securitize.io/asset-info?symbol=BUIDL
  // Both Ethereum classes are independent six-decimal registers; sum them once.
  // Six-decimal shares: ETH 170,226,737.157549 + I-class 144,103,743.045100
  // (26399392); BSC 277,532,492.635 (133176007); OP 26,575,157.77 (159446793);
  // ARB 12,630,305.63 (523586559); AVAX 356,359,217.49 (100119134);
  // Polygon 10,478,611.20 (97192152); SOL 483,827,334.40 (slot 468558788);
  // Aptos 157,418,928.49 (version 8018167035); Tempo 17,174,363.99 (48676770).
  // Sum 1,656,326,891.807649: last DL stock plus its omitted Tempo leg.
  // Tempo's +12,422.08 since reviewed block 47370052 reconciles to five mints
  // before Nov 11; the list-specific exclusion remains valid for list repair.
  // Every zero or unreadable leg rejects the aggregate under current readers.
  // A genuinely redeemed-to-zero class requires a reviewed plan change.
  "buidl-blackrock": {
    preferMcap: true,
    aggregateContracts: [
      { chain: "ethereum", address: "0x7712c34205737192402172409a8f7ccef8aa2aec" },
      { chain: "ethereum", address: "0x6a9da2d710bb9b700acde7cb81f10f1ff8c89041" },
      { chain: "bsc" }, { chain: "optimism" }, { chain: "arbitrum" },
      { chain: "avalanche" }, { chain: "polygon" }, { chain: "solana" },
      supplyProbeChain("aptos", { reader: "buidl-aptos" }), supplyProbeChain("tempo"),
    ],
  },
  "hbd-hive": { nativeWorkflow: "hive-debt" },
  // The registry identities cover the Ethereum wrappers, not the native programs.
  "kau-kinesis": { preferMcap: true, aggregateContracts: [{ chain: "ethereum", allowZeroSupply: true }] },
  "kag-kinesis": { preferMcap: true, aggregateContracts: [{ chain: "ethereum", allowZeroSupply: true }] },
  [ZEPHYR_ZSD_ASSET_ID]: { nativeWorkflow: "zephyr-scanner" },
  [ZEPHYR_ZYS_ASSET_ID]: { nativeWorkflow: "zephyr-scanner" },
  "jltxx-jpmorgan": { nativeWorkflow: "pinned-native-shares" },
  "cdp-enosys": {
    aggregateContracts: [supplyProbeChain("flare")],
  },
  // Reviewed issuer-native deployments, not bridge representations. Contracts/decimals are catalog-owned.
  "usdg-paxos": {
    repairContracts: [
      { chain: "xlayer", dropoutRepair: "registry" },
      { chain: "ink", dropoutRepair: "registry" },
    ],
  },
  // Issuer confirms native Solana XUSD and the catalog mint: https://www.straitsx.com/blog-post/xsgd-and-xusd-live-on-solana
  "xusd-straitsx": {
    repairContracts: [{ chain: "solana", dropoutRepair: "registry" }],
  },
  // Catalog mint-authority reviews identify independent issuer-native stocks; no bridge subtraction.
  "moveusd-cfx": {
    repairContracts: [{ chain: "solana", dropoutRepair: "registry" }],
  },
  // Curve satellites lock Ethereum shares; reallocate, never add their stock.
  // Reviewed 2026-11-04: canonical stock / CG cap = 0.953799 at $1.11/share.
  "scrvusd-curve": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "optimism", allowZeroSupply: true }, { chain: "base", allowZeroSupply: true },
      supplyProbeChain("fraxtal", { allowZeroSupply: true }),
      { chain: "fantom", rpcUrl: PUBLIC_RPC_URLS.fantom, allowZeroSupply: true },
      { chain: "bsc", allowZeroSupply: true }, { chain: "avalanche", allowZeroSupply: true },
      { chain: "xdc", allowZeroSupply: true }, supplyProbeChain("sonic", { allowZeroSupply: true }),
      supplyProbeChain("etherlink", { allowZeroSupply: true }),
    ],
    canonicalSupplyChain: "ethereum",
  },
  // XGLDToken OFTs burn/mint their own stock; Ethereum is live at observed zero.
  // Reviewed 2026-11-04: sum / CG implied units = 1.000011.
  "xgld-unitas": {
    aggregateContracts: [
      { chain: "bsc" }, { chain: "base", allowZeroSupply: true },
      { chain: "ethereum", allowZeroSupply: true }, supplyProbeChain("mantle", { allowZeroSupply: true }),
    ],
  },
  // Reviewed 2026-10-25: all nine EVM issuer registers sum; Solana/Stellar
  // are Ethereum-escrowed representations listed explicitly below, not new stock.
  "jaaa-janus-henderson-anemoy": {
    aggregateContracts: [
      { chain: "ethereum" }, { chain: "base" }, { chain: "bsc" }, { chain: "avalanche" },
      supplyProbeChain("monad"), { chain: "arbitrum" },
      supplyProbeChain("pharos", { allowZeroSupply: true }),
      supplyProbeChain("xlayer", { allowZeroSupply: true }),
      { chain: "arc", allowZeroSupply: true },
    ],
    // Reviewed 2026-10-25: Stellar's issuer metadata names its Ethereum escrow;
    // Solana burn/Ethereum release pairs identify separate conserved custody.
    // shortcut: remote custody stays on Ethereum, split when mixed native/escrow accounting is supported.
    excludedRepresentations: [
      { chain: "solana", address: "AAAJXeGjpKu7W3X4QTSU4pm1Wbj4G2LPcdg7A6xJLLyG", canonicalChain: "ethereum" },
      { chain: "stellar", address: "CDV6U7OEVY6KUEJ4WNS63AYB6RFU3BAE7AZJOQ7LPH447C6NWUXEZZSO", canonicalChain: "ethereum" },
    ],
  },
  // Reviewed 2026-10-25: native ICL deposits and CCIP burn/mint stocks sum.
  // Both Tempo tokens have separate collateral-funded mints; neither replaces
  // the other. Address-bound legs prevent counting the first token twice.
  "reusd-re-protocol": {
    aggregateContracts: [
      { chain: "ethereum" }, { chain: "avalanche" }, { chain: "arbitrum" }, { chain: "base" },
      { chain: "bsc" }, supplyProbeChain("ink"), supplyProbeChain("plasma"), supplyProbeChain("katana"),
      supplyProbeChain("tempo", { address: "0x20c000000000000000000000e09a4cfec804f102" }),
      { chain: "solana" }, supplyProbeChain("berachain", { allowZeroSupply: true }),
      supplyProbeChain("monad"), supplyProbeChain("sei"), supplyProbeChain("megaeth", { allowZeroSupply: true }),
      supplyProbeChain("tempo", { address: "0x20c000000000000000000000383a23bacb546ab9" }),
    ],
  },
  // Reviewed 2026-10-25: Spiko's independent native share registers sum, with
  // Soroban total_supply on Stellar.
  "eutbl-spiko": {
    aggregateContracts: [
      { chain: "arbitrum", allowZeroSupply: true }, { chain: "ethereum", allowZeroSupply: true },
      { chain: "polygon", allowZeroSupply: true }, { chain: "base", allowZeroSupply: true },
      supplyProbeChain("etherlink", { allowZeroSupply: true }), { chain: "starknet", allowZeroSupply: true },
      { chain: "stellar", allowZeroSupply: true }, { chain: "solana", allowZeroSupply: true },
    ],
  },
  "ustbl-spiko": {
    aggregateContracts: [
      { chain: "arbitrum", allowZeroSupply: true }, { chain: "ethereum", allowZeroSupply: true },
      { chain: "polygon", allowZeroSupply: true }, { chain: "base", allowZeroSupply: true },
      supplyProbeChain("etherlink", { allowZeroSupply: true }), { chain: "starknet", allowZeroSupply: true },
      { chain: "stellar", allowZeroSupply: true }, { chain: "solana", allowZeroSupply: true },
    ],
  },
  // Movement USDCx is a Circle xReserve representation. Its fungible-asset
  // supply is admitted only after the Worker reconciles it to the matching
  // Ethereum xReserve domain balance (0 bps under-collateralized fail-closed,
  // up to 500 bps excess backing for asynchronous deposit/burn settlement).
  // Reviewed 2026-11-22 (owner-approved): prefer xReserve-reconciled Movement
  // stock over stalled CoinGecko market caps.
  "usdcx-movement": {
    aggregateContracts: [{ chain: "movement" }],
    preferMcap: true,
  },
  // Reviewed issuer-native USDon deployments: each separately minted stock is
  // additive, not an Ethereum lockbox plus representation. The complete roster
  // repairs DefiLlama's omitted Solana leg without mixing a retained baseline.
  "usdon-ondo": {
    aggregateContracts: [
      { chain: "ethereum", allowZeroSupply: true },
      { chain: "bsc", allowZeroSupply: true },
      { chain: "solana", allowZeroSupply: true },
    ],
  },
  // Reviewed 2026-10-15: five independently deposit-backed Legacy sUSDC vaults.
  // Local held sUSDS equals each local sUSDC supply. These native liabilities
  // sum; they are not remote tokens minted against Ethereum sUSDC escrow.
  "susdc-spark-v1": {
    aggregateContracts: [
      { chain: "ethereum", allowZeroSupply: true },
      { chain: "arbitrum", allowZeroSupply: true },
      { chain: "base", allowZeroSupply: true },
      { chain: "optimism", allowZeroSupply: true },
      supplyProbeChain("unichain", { allowZeroSupply: true }),
    ],
  },
  // DefiLlama currently lists these active assets but intermittently reports a
  // zero supply row. Use only verified live deployments and fail closed if any
  // configured chain cannot be read, so this cannot silently undercount.
  // Reviewed 2026-11-25: Tetra's supported-blockchains roster binds four
  // independent issuer-native CADD deployments (no bridge lockbox): Ethereum
  // 1,825,864.12 (block 26491782) + Base 6,356,928.80 (block 62071808) +
  // Solana Token-2022 82,998.023043 (slot 473723301) + Tempo TIP-20 99.00
  // (block 50740563) = 8,265,889.943043 CADD. ETH+Base matches DefiLlama 387
  // exactly; ETH+Base+Solana matches CoinGecko; Tempo dust allows zero.
  "cadd-cad-digital": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "base" },
      { chain: "solana" },
      supplyProbeChain("tempo", { allowZeroSupply: true }),
    ],
  },
  // Bridge's OUSD reserve page binds these four issuer deployments. Reviewed
  // 2026-09-30: their combined totalSupply/getTokenSupply reconciles to the
  // Bridge ousd transparency total (~$477.31M), so sum rather than reallocate.
  // This repairs a zero DefiLlama row only; it never replaces positive list supply.
  "ousd-open-standard": {
    aggregateContracts: [
      supplyProbeChain("tempo"),
      { chain: "ethereum" },
      { chain: "base" },
      { chain: "solana" },
    ],
  },
  // Reviewed 2026-10-25: AllUnity lists six issuer-native CHFAU deployments;
  // include Solana and Arc, all at 6 decimals, with observed live zero legs.
  "chfau-allunity": {
    aggregateContracts: [
      { chain: "ethereum", allowZeroSupply: true },
      { chain: "polygon", allowZeroSupply: true },
      { chain: "base", allowZeroSupply: true },
      { chain: "tempo", allowZeroSupply: true },
      { chain: "solana", allowZeroSupply: true },
      { chain: "arc", allowZeroSupply: true },
    ],
  },
  // PYUSDx native Portal burn/mint supplies sum. Extension-held balances are
  // already in these totalSupply reads, so never add CUSD/ConcUSD separately.
  // Include the positive 0G native deployment in the complete five-chain roster.
  "pyusdx-moonpay": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "arbitrum" },
      supplyProbeChain("monad"),
      { chain: "base", allowZeroSupply: true },
      supplyProbeChain("0g", { allowZeroSupply: true }),
    ],
  },
  // Reviewed 2026-10-25: USYC Teller issuance and BSC burn/mint stock sum;
  // Ethereum does not escrow the BSC supply. Arc is a verified live zero leg.
  // https://usyc.docs.hashnote.com/overview/smart-contracts
  "usyc-hashnote": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "bsc" },
      { chain: "solana" },
      { chain: "arc", allowZeroSupply: true },
    ],
    // Reviewed 2026-11-01: the complete four-chain native roster read
    // 1,960,810,518.68 USYC against a CoinGecko market cap that still reflected
    // pre-2026-10-31 BSC burns. Prefer the on-chain stock; never republish the
    // contradicted cap when a leg is unreadable.
    // https://bscscan.com/token/0x8d0fa28f221eb5735bc71d3a0da67ee5bc821311
    preferMcap: true,
  },
  // Reviewed 2026-11-08: Centrifuge Spoke burn/reissue stocks sum; X Layer/Arc
  // are required observed-zero legs. Stellar is already in Ethereum's issuer escrow.
  // https://docs.centrifuge.io/developer/protocol/guides/bridge-share-tokens/
  "jtrsy-anemoy": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "base" },
      { chain: "arbitrum" },
      { chain: "avalanche" },
      supplyProbeChain("plume"),
      { chain: "bsc" },
      supplyProbeChain("monad"),
      { chain: "solana", allowZeroSupply: true },
      supplyProbeChain("pharos"),
      supplyProbeChain("xlayer", { allowZeroSupply: true }),
      supplyProbeChain("arc", { allowZeroSupply: true }),
    ],
    // Reviewed 2026-11-07: Centrifuge's complete issuance is 55,613,550.471566
    // JTRSY; CoinGecko counts only Ethereum's 42,075,827.831111 shares.
    // https://docs.centrifuge.io/developer/centrifuge-api/#tokens
    preferMcap: true,
  },
  // Reviewed 2026-10-25: Ethereum syrupUSDG includes CCIP LockRelease custody;
  // remote BurnMint stocks reallocate it. Ink and Solana currently read zero.
  // https://docs.maple.finance/integrate/crosschain/syrupusd-crosschain.md
  "syrupusdg-maple": {
    aggregateContracts: [
      { chain: "ethereum" },
      supplyProbeChain("robinhood"),
      { chain: "arbitrum" },
      supplyProbeChain("ink", { allowZeroSupply: true }),
      { chain: "solana", allowZeroSupply: true },
    ],
    canonicalSupplyChain: "ethereum",
  },
  // Reviewed 2026-10-25: strUSD and sUSDat remote CCIP shares are locked in
  // Ethereum, not independent vault liabilities. Reallocate canonical stock.
  // https://docs.tori.finance/resources/contracts.md
  "strusd-tori": {
    aggregateContracts: [
      { chain: "ethereum" },
      supplyProbeChain("monad"),
      supplyProbeChain("pharos"),
    ],
    canonicalSupplyChain: "ethereum",
    // D11, re-pinned 2026-11-04: pool.getLockBox()/getToken() bind this custody.
    // Unprobed CCIP representations remain in the conserved residual.
    escrowResidual: {
      escrowAddress: "0xc1a9e4bbb58573b8971c9b3c24e17f9851268f86",
      unattributedChainLabel: "strUSD unattributed CCIP escrow",
    },
  },
  // Reviewed 2026-11-04 (D12): Base vault stock backs the two OFT spokes.
  // https://docs.yieldpoint.io/protocol/architecture/contracts.md
  "uty-xsy": {
    aggregateContracts: [
      { chain: "base" },
      { chain: "avalanche", allowZeroSupply: true },
      supplyProbeChain("katana", { allowZeroSupply: true }),
    ],
    canonicalSupplyChain: "base",
    escrowResidual: {
      escrowAddress: "0xc6fe7c5010621ab3ca5f4c018fad632f78b4d3f1",
      unattributedChainLabel: "UTY unattributed OFT escrow",
    },
  },
  // Brale burns on the source register and mints on the destination; no escrow.
  // https://docs.brale.xyz/guides/stablecoin-to-stablecoin-swap
  "mxne-real-mxn": {
    aggregateContracts: [
      { chain: "base", allowZeroSupply: true },
      { chain: "solana", allowZeroSupply: true },
      { chain: "stellar", allowZeroSupply: true },
    ],
    // Reviewed 2026-11-04 (owner-approved restatement): the complete native
    // Base + Solana + Stellar registers read 8,786,145.85 MXNe while the
    // CoinGecko cap implied ~1.43M; the 2026-10-19 risk review already calls
    // that cap inconsistent with measured supply. Prefer the native stock.
    preferMcap: true,
  },
  // Reviewed 2026-10-25 (updated 2026-11-23 cur-chains): Ethereum LockRelease /
  // BSC+Monad+X Layer BurnMint pools (X Layer 0.0004 sUSDat seed allows zero).
  // https://docs.chain.link/ccip/directory/mainnet/token/sUSDat
  "susdat-saturn": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "bsc" },
      supplyProbeChain("monad"),
      supplyProbeChain("xlayer", { allowZeroSupply: true }),
    ],
    canonicalSupplyChain: "ethereum",
  },
  // CoinGecko only exposes an Ethereum market-cap row for ftUSD and currently
  // leaves it stale; aggregate the verified native Ethereum + Sonic supplies.
  "ftusd-flying-tulip": {
    aggregateContracts: [{ chain: "ethereum" }, { chain: "sonic" }],
  },
  // Reviewed 2026-11-22: Ethereum CCIP LockRelease escrows apyUSD for Base,
  // BNB, Monad (reciprocally peer-verified at blocks 26471570/124473582) and
  // Solana BurnMint representations; conserve canonical shares and keep
  // escrowResidual for the remaining ~1.138 apyUSD unmatched pool custody.
  "apyusd-apyx": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "base" },
      { chain: "bsc" },
      supplyProbeChain("monad"),
      { chain: "solana" },
    ],
    canonicalSupplyChain: "ethereum",
    escrowResidual: {
      escrowAddress: "0x0f1bac2ea0311130da778c1ca287204338739f73",
      unattributedChainLabel: "apyUSD unattributed CCIP escrow",
    },
  },
  // DUSD is a Makina Machine share issued canonically on Ethereum and mirrored
  // to Ink through Wormhole NTT locking. Ethereum totalSupply already includes
  // the tokens escrowed for Ink, so the aggregate path must reallocate rather
  // than sum the two deployments.
  "dusd-dialectic": {
    aggregateContracts: [
      { chain: "ethereum" },
      // override: retain this asset's reviewed primary-only supply profile.
      supplyProbeChain("ink", { fallbackRpcUrl: undefined }),
    ],
    canonicalSupplyChain: "ethereum",
  },
  // GLDT is native on the Internet Computer and reaches Ethereum, Base and
  // Arbitrum through Omnity's ICP-custody lock/mint bridge, so the ICP ledger
  // total already contains the EVM float and is reallocated rather than summed.
  // Verified 2026-07-29: icrc1_total_supply 594,500.00000000 (the ic0.app
  // replica query and the DFINITY ICRC REST indexer agree to the unit, and
  // CoinGecko publishes exactly that figure) against Base 5,345.40392636 +
  // Ethereum 7.64444464 + Arbitrum 0, so every bridge leg is far below the 10%
  // deployment floor.
  "gldt-gold-dao": {
    aggregateContracts: [
      { chain: "icp" },
      { chain: "ethereum" },
      { chain: "base" },
      { chain: "arbitrum", allowZeroSupply: true },
    ],
    canonicalSupplyChain: "icp",
  },
  // Reviewed 2026-10-25 (updated 2026-11-23 cur-chains): sUSN locks shares in its
  // Ethereum token contract; conserve canonical totalSupply and isolate self-escrow
  // beyond read satellites. Retain deprecated Sophon/TAC stock until burned; BSC
  // reads zero at pin (allowZeroSupply), and Sui LayerZero OFT stays in
  // unreadableDeployments / escrowResidual until a reviewed Sui supply reader lands.
  "susn-noon": {
    unreadableDeployments: [
      { chain: "sui", address: "0x0a672389b7b73df60d40666ac9545433d59d3128086b9e3a425a66bbffdf4dc5::susn::SUSN" },
    ],
    aggregateContracts: [
      { chain: "ethereum" },
      supplyProbeChain("zksync"),
      supplyProbeChain("sophon"),
      { chain: "starknet" },
      supplyProbeChain("hyperevm"),
      { chain: "base" },
      { chain: "citrea", rpcUrl: "https://rpc.mainnet.citrea.xyz" },
      supplyProbeChain("berachain"),
      supplyProbeChain("tac"),
      { chain: "solana" },
      { chain: "bsc", allowZeroSupply: true },
    ],
    canonicalSupplyChain: "ethereum",
    escrowResidual: {
      escrowAddress: "0xe24a3dc889621612422a64e6388927901608b91d",
      unattributedChainLabel: "sUSN unattributed bridge escrow",
    },
  },
  // Reviewed 2026-11-25: JPYm is natively issued on Celo and bridged to Monad
  // via Wormhole NTT (0x7431419fe761e7da37587245c55a35e5a356c91b): Celo NTT
  // Manager mode()=0 (LOCKING, getPeer(48)=self) escrows 4,255,984.92206028
  // JPYm at block 83703975, matching Monad totalSupply() (mode()=1 BURNING,
  // getPeer(14)=self, block 125272619) to the wei. Conserve Celo's 11,555,435.78
  // canonical totalSupply and reallocate Monad out of it rather than summing.
  "jpym-mento": {
    aggregateContracts: [
      { chain: "celo" },
      supplyProbeChain("monad"),
    ],
    canonicalSupplyChain: "celo",
  },
  "zarm-mento": {
    aggregateContracts: [{ chain: "celo" }],
  },
  "xofm-mento": {
    aggregateContracts: [{ chain: "celo" }],
  },
  // sUSDS and sDAI are Sky savings NAV wrappers with no DefiLlama market row
  // (llamaId null), so upstream supplies no per-chain breakdown and the
  // CoinGecko intake lanes leave chainCirculating empty. Read Ethereum and all
  // cataloged canonical-bridge deployments: Base/Optimism/Arbitrum/Unichain for
  // sUSDS and Base/Optimism/World Chain for sDAI. Ethereum totalSupply already
  // includes their L1 escrow; the canonical policy below reallocates remote
  // supply instead of adding it. This roster is not an economic supply plan.
  "susds-sky": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "base" },
      { chain: "optimism" },
      { chain: "arbitrum" },
      supplyProbeChain("unichain"),
    ],
    canonicalSupplyChain: "ethereum",
    escrowResidual: {
      escrowByChain: {
        base: "0x7f311a4d48377030bd810395f4ccfc03bdbe9ef3",
        optimism: "0x467194771dae2967aef3ecbedd3bf9a310c76c65",
        arbitrum: "0xa10c7ce4b876998858b1a9e12b10092229539400",
        unichain: "0x1196f688c585d3e5c895ef8954ffb0dcdafc566a",
      },
      unattributedChainLabel: "sUSDS unattributed SkyLink escrow",
    },
  },
  "sdai-sky": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "base" },
      { chain: "optimism" },
      supplyProbeChain("worldchain"),
    ],
    canonicalSupplyChain: "ethereum",
  },
  // sUSDe has the same shape (llamaId null, CoinGecko detail provider), but its
  // reviewed representations are LayerZero OFTs minted against the Ethereum OFT
  // adapter 0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2, which escrows canonical
  // sUSDe. Ethereum totalSupply() is therefore the conserved global total and
  // every reviewed representation is reallocated out of it. Legs outside
  // buildChainRpcs() carry a verified public endpoint. The TON jetton and the
  // Aptos fungible asset stay unconfigured: neither stock is proven to draw on
  // the adapter escrow (an aptos probe family exists; proof precedes
  // configuration), so the escrow residual is unallocated escrow — it does not
  // contain their balances, and subtracting either stock requires the
  // escrow-proof prerequisites in the evidence-log note beside escrowResidual
  // below.
  "susde-ethena": {
    aggregateContracts: [
      { chain: "ethereum" },
      supplyProbeChain("plasma"),
      supplyProbeChain("linea"),
      supplyProbeChain("fraxtal"),
      supplyProbeChain("hyperevm"),
      supplyProbeChain("berachain"),
      supplyProbeChain("zircuit"),
      supplyProbeChain("metis"),
      // The X Layer OFT is deployed and reviewed but currently holds no supply.
      supplyProbeChain("xlayer", { allowZeroSupply: true }),
      { chain: "base" },
      { chain: "bsc" },
      supplyProbeChain("morph-l2"),
      supplyProbeChain("scroll"),
      supplyProbeChain("kava"),
      supplyProbeChain("swellchain"),
      supplyProbeChain("mode"),
      supplyProbeChain("mantle"),
      { chain: "arbitrum" },
      supplyProbeChain("manta"),
      supplyProbeChain("blast"),
      { chain: "optimism" },
      supplyProbeChain("zksync"),
      { chain: "avalanche" },
      { chain: "solana" },
      // Reviewed 2026-11-01: Monad's LayerZero OFT held 16,640,244.562356 sUSDe
      // (MonadScan), previously absorbed by the unattributed escrow residual.
      supplyProbeChain("monad"),
    ],
    canonicalSupplyChain: "ethereum",
    // The unprobed TON jetton and Aptos fungible asset are not proven to draw
    // on the Ethereum OFT Adapter escrow: the 2026-07-29 reconciliation
    // (canonical Ethereum totalSupply 1,240,195,620.187629; TON 2,397,958.18
    // (0.1934%), Aptos 1,074,420.00 (0.0866%) and 13,587,459.52 of escrow
    // matching no reviewed route (1.0956%) were all being published as Ethereum
    // float while the TON and Aptos controls reported a hard 0 share) is
    // arithmetic, not escrow proof. Neither stock may be subtracted from the
    // residual without the escrow-proof requirements in
    // docs/process/report-cards-evidence-log.md ("Escrow and Unmatched-Supply
    // Rows — 2026-11-20").
    escrowResidual: {
      escrowAddress: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2",
      unattributedChainLabel: "sUSDe unattributed OFT escrow",
    },
  },
  // wsrUSD is an ERC-4626 NAV wrapper with no DefiLlama pegged-asset row
  // (llamaId null), so the CoinGecko fiat-cg lane leaves chainCirculating empty
  // and the V9 supply review caps on runtime-bridge-materiality-unavailable.
  // Reservoir issues every remote deployment through a LayerZero OFT whose
  // Ethereum peer is the OFT Adapter lockbox
  // 0xbb431abd156b960e5b77cc45c75f107e3991258a, so Ethereum totalSupply already
  // escrows them and the canonical reallocation below applies. Chains absent
  // from the worker RPC registry carry an explicit public endpoint; any
  // unreadable leg fails the whole probe closed.
  "wsrusd-reservoir": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "base" },
      supplyProbeChain("berachain"),
      // override: retain this asset's reviewed primary-only supply profile.
      supplyProbeChain("sonic", { fallbackRpcUrl: undefined }),
      { chain: "arbitrum" },
      { chain: "bsc" },
      { chain: "avalanche" },
      supplyProbeChain("unichain"),
      supplyProbeChain("plume"),
      // override: retain this asset's reviewed primary-only supply profile.
      supplyProbeChain("sei", { fallbackRpcUrl: undefined }),
      supplyProbeChain("worldchain"),
      supplyProbeChain("katana"),
      supplyProbeChain("hyperevm"),
      supplyProbeChain("linea"),
      supplyProbeChain("monad"),
      // override: retain this asset's reviewed primary-only supply profile.
      supplyProbeChain("pharos", { fallbackRpcUrl: undefined }),
      { chain: "solana" },
      // Reviewed 2026-10-25: complete the four issuer-listed OFT legs; their
      // stock is already escrowed on Ethereum. MegaETH is observed zero.
      supplyProbeChain("plasma"),
      supplyProbeChain("megaeth", { allowZeroSupply: true }),
      supplyProbeChain("tempo"),
      { chain: "xdc", rpcUrl: "https://rpc.xdcrpc.com" },
    ],
    canonicalSupplyChain: "ethereum",
  },
  // yUSD is native on Ethereum with LayerZero OFT burn/mint representations on
  // nine chains, so no leg escrows another and the reviewed deployments sum.
  // Verified 2026-07-29: CoinGecko circulating 10,877,090.58638517 is the exact
  // sum of the seven deployments it indexes, and the three it omits (BSC,
  // Avalanche, Plasma) add 35,462.36 more. Sonic, Plume, Katana and Plasma have
  // no chain-registry RPC, so pin reviewed public endpoints; any unreadable leg
  // still fails the whole aggregate closed.
  "yusd-yieldfi": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "arbitrum" },
      { chain: "base" },
      { chain: "optimism" },
      supplyProbeChain("sonic"),
      supplyProbeChain("plume"),
      supplyProbeChain("katana"),
      { chain: "bsc" },
      { chain: "avalanche" },
      supplyProbeChain("plasma"),
    ],
  },
  // savUSD is Avant's Avalanche-native staking vault mirrored by Chainlink CCIP
  // BurnMint pools. Verified 2026-07-29: the Avalanche CCIP LockRelease pool
  // 0x8FcC42c414E29e8e3dBFa1628CF45E8ed80C999D escrows 52,769,640.25 savUSD
  // against 52,761,208.00 minted on the destination chains, so the canonical
  // Avalanche totalSupply already contains them and is reallocated below rather
  // than summed. Katana currently reads exactly zero and BSC/MegaETH hold
  // reviewed dust, so those legs may contribute zero.
  "savusd-avant": {
    aggregateContracts: [
      { chain: "avalanche" },
      { chain: "ethereum" },
      supplyProbeChain("linea"),
      supplyProbeChain("plasma"),
      supplyProbeChain("berachain"),
      { chain: "bsc", allowZeroSupply: true },
      supplyProbeChain("monad"),
      supplyProbeChain("katana", { allowZeroSupply: true }),
      supplyProbeChain("megaeth", { allowZeroSupply: true }),
      supplyProbeChain("sei"),
    ],
    canonicalSupplyChain: "avalanche",
    // Avalanche CCIP LockRelease custody includes the Base, Arbitrum and Movement
    // representations absent from the probe roster. Keep their residual separate
    // from Avalanche free float; pool getToken() reverified 2026-09-22.
    escrowResidual: {
      escrowAddress: "0x8fcc42c414e29e8e3dbfa1628cf45e8ed80c999d",
      unattributedChainLabel: "savUSD unattributed CCIP escrow",
    },
  },
  // cUSDO runs an independent ERC-4626 wrapper on each chain over that chain's
  // own USDO, so nothing escrows anything. Verified 2026-07-29: every remote
  // vault's asset() is the local USDO and its totalAssets() equals its own USDO
  // balance, Ethereum cUSDO balanceOf(self) is 0, and CoinGecko's circulating
  // supply reproduces the Ethereum+Base+BSC sum exactly. The Solana mint adds
  // 817,113.90 cUSDO (+5.3%) that CoinGecko never indexes.
  "cusdo-openeden": {
    aggregateContracts: [
      { chain: "ethereum" }, { chain: "base" }, { chain: "bsc" }, { chain: "solana" },
      // Kaia cUSDO wraps its local USDO, like the other independent vaults.
      supplyProbeChain("klaytn"),
    ],
  },
  // sUSDai uses direct burn/mint across all six deployments; the reviewed
  // preference includes additive Solana (6 decimals) and Arc stock omitted by CG.
  "susdai-usd-ai": {
    aggregateContracts: [
      { chain: "arbitrum" },
      { chain: "ethereum" },
      { chain: "base" },
      supplyProbeChain("plasma"),
      { chain: "solana" },
      { chain: "arc" },
    ],
    preferMcap: true,
  },
  // sYUSD stakes each chain's own YUSD in a local ERC-4626 vault. Verified
  // 2026-07-29: the BSC vault's asset() is BSC YUSD and its totalAssets()
  // equals its own YUSD balance, so it is locally backed rather than escrowed
  // against Ethereum. BSC holds 0.0094% of supply, so allow it to read zero.
  "syusd-aegis": {
    aggregateContracts: [{ chain: "ethereum" }, { chain: "bsc", allowZeroSupply: true }],
  },
  // USDK and XO are single-deployment Solana assets that already resolve
  // through the single-contract probe. They are configured here only so the
  // aggregate lane publishes a per-chain row: the reviewed M0 Portal lock/mint
  // escrows the underlying $M, never USDK or XO, so the mint totalSupply is the
  // whole global supply and the published aggregate is unchanged.
  "usdk-kast": {
    aggregateContracts: [{ chain: "solana" }],
  },
  "xo-exodus": {
    aggregateContracts: [{ chain: "solana" }],
  },
  // hbUSDT's only deployment is on HyperEVM, a pin-only chain with no Worker
  // registry RPC, so the generic single-contract probe cannot read it. This
  // one-leg roster pins the reviewed HyperEVM supply endpoints; the vault-share
  // totalSupply is the whole global supply. Verified 2026-09-28 on both
  // endpoints: totalSupply 3,204,481.46 hbUSDT (18 decimals), within 0.3% of the
  // ~3.21M units implied by CoinGecko's last (09-26) market cap, so no holder
  // exclusion applies.
  "hbusdt-hyperbeat": {
    aggregateContracts: [supplyProbeChain("hyperevm")],
  },
  // sDOLA's four remote deployments share byte-identical owner-minted ERC-20
  // bytecode with no token()/l1Token()/bridge() surface and no Ethereum escrow,
  // so they sum. Every one of them carries deployment seed dust (Base 0.0212,
  // the rest wei-level), so all four legs must tolerate a zero read.
  "sdola-inverse-finance": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "base", allowZeroSupply: true },
      { chain: "optimism", allowZeroSupply: true },
      { chain: "arbitrum", allowZeroSupply: true },
      supplyProbeChain("berachain", { allowZeroSupply: true }),
    ],
  },
  // thBILL is a LayerZero OFT mesh whose Ethereum leg is the MyOFTAdapter
  // lockbox 0xfDD22Ce6D1F66bc0Ec89b20BF16CcB6670F55A5a. Verified 2026-07-29:
  // it escrows 37,999,100.42 thBILL against 37,998,884.22 minted on Arbitrum,
  // Base, HyperEVM and Stable, so Ethereum totalSupply() is the conserved
  // global total and is reallocated below. The Stable-chain representation is
  // now a tracked deployment (chainId 988, 35,612,981.743756 thBILL read
  // 2026-07-29 on two independent endpoints), so it reallocates out of the
  // Ethereum bucket and the per-chain split is finally true.
  "thbill-theo": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "arbitrum" },
      { chain: "base", allowZeroSupply: true },
      supplyProbeChain("hyperevm"),
      supplyProbeChain("stable"),
    ],
    canonicalSupplyChain: "ethereum",
  },
  // thUSD is a LayerZero OFT mesh whose Ethereum leg is the OFTAdapter lockbox
  // 0x9AA9Aa0530a6AF70EE7BC47cF1240100f514b065. Verified 2026-09-29 at Ethereum
  // block 26083731: the adapter escrows 50,106,870.731594 thUSD against
  // 49,916,245.786914 minted on Stable and 190,624.946680 on Arbitrum (sum
  // 50,106,870.733574, adapter escrow within rounding of the live reads), so
  // Ethereum totalSupply() 133,670,676.056526 is the conserved global total and
  // is reallocated below. CoinGecko lists theo-usd with a price but zero market
  // cap, so this aggregate is the market-cap admission path. BSC and Mantle
  // OFTs are deployed at the same address but hold zero supply and have no
  // documented live lane, so they are not tracked deployments.
  "thusd-theo": {
    aggregateContracts: [
      { chain: "ethereum" },
      supplyProbeChain("stable"),
      { chain: "arbitrum" },
    ],
    canonicalSupplyChain: "ethereum",
  },
  // Reviewed 2026-11-25: wiTRY's Ethereum LayerZero OFTAdapter lockbox
  // 0x698b7518711bDe4832fDc19F5262DF705c713006 (approvalRequired()=true,
  // token()=wiTRY, peers(30398 & 30416)=0x15b2...de5) holds 63,394,914.393496
  // wiTRY at block 26491782, matching MegaETH 63,394,829.386790 (block 32807727)
  // + Robinhood 85.006706 (block 122992827) to the wei. Ethereum totalSupply()
  // 63,440,164.448328 matches CoinGecko and is conserved; Robinhood dust allows zero.
  "witry-brix": {
    aggregateContracts: [
      { chain: "ethereum" },
      supplyProbeChain("megaeth"),
      supplyProbeChain("robinhood", { allowZeroSupply: true }),
    ],
    canonicalSupplyChain: "ethereum",
  },
  // KRWQ's five spokes are self-referencing LayerZero OFTs that all resolve
  // peers(30101) to the Ethereum OFT Adapter 0xbdc82654f3574a113cdbd62f39cbe02e5b522d57
  // (approvalRequired() === true). Verified 2026-07-29: that adapter escrows
  // 790,548,884.86 KRWQ against a 790,537,884.86 spoke total, so summing would
  // double count. Note: this drops the published supply from CoinGecko's
  // Ethereum+Base double count to the conserved 1,069,438,010.15 KRWQ. The
  // Codex leg is a 5 KRWQ seed mint, so allow it to read zero.
  "krwq-iq": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "base" },
      { chain: "polygon" },
      supplyProbeChain("fraxtal"),
      supplyProbeChain("codex", { allowZeroSupply: true }),
      supplyProbeChain("morph-l2"),
    ],
    canonicalSupplyChain: "ethereum",
  },
  // syrupUSDT is an Ethereum ERC-4626 vault mirrored by Chainlink CCIP BurnMint
  // spokes. Verified 2026-07-29: the Ethereum LockReleaseTokenPool
  // 0xDE76A096C5eadDdf97Af3fE15ee49d32AEDa9822 escrows 280,871,803.77
  // syrupUSDT against a 280,871,803.67 spoke total, and the vault's 406.1M USDT
  // only reconciles to the quoted 1.14 NAV against Ethereum shares alone, so
  // the canonical total is reallocated rather than summed.
  "syrupusdt-maple": {
    aggregateContracts: [
      { chain: "ethereum" },
      supplyProbeChain("plasma"),
      { chain: "bsc" },
      supplyProbeChain("mantle"),
      supplyProbeChain("ink"),
    ],
    canonicalSupplyChain: "ethereum",
  },
  // syrupUSDC is an Ethereum ERC-4626 vault carried to eight Chainlink CCIP
  // representations. Chainlink's directory identifies Ethereum as the
  // LockRelease leg and every remote token as BurnMint, so Ethereum totalSupply
  // is the conserved global total and the remote supplies are reallocated out
  // of it. Verified 2026-08-23: Monad held 147,171,074.696779 shares at block
  // 98,551,586; the three routes absent from CoinGecko were live but immaterial
  // (Ink 0.000110, Robinhood 0.009000, Tempo 886.105125). Pin reviewed public
  // RPCs for chains outside buildChainRpcs(); any unreadable leg fails closed.
  // Arc joins the same reviewed BurnMint representation partition (2026-10-01).
  "syrupusdc-maple": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "base" },
      { chain: "arbitrum" },
      { chain: "solana" },
      supplyProbeChain("ink", { allowZeroSupply: true }),
      supplyProbeChain("monad"),
      supplyProbeChain("robinhood", { allowZeroSupply: true }),
      supplyProbeChain("tempo", { allowZeroSupply: true }),
      { chain: "arc" },
    ],
    canonicalSupplyChain: "ethereum",
  },
  // srUSD has the same Reservoir shape as wsrUSD but a different adapter:
  // 0x316cd39632Cac4F4CdfC21757c4500FE12f64514 (SrusdOftAdapter). Verified
  // 2026-07-29: it escrows 6,882.636512 srUSD, exactly the Berachain
  // totalSupply(), so Ethereum is the conserved total and is reallocated.
  "srusd-reservoir": {
    aggregateContracts: [
      { chain: "ethereum" },
      supplyProbeChain("berachain"),
    ],
    canonicalSupplyChain: "ethereum",
  },
  // PGOLD is issuer-native on Arbitrum, which is the conserved global total:
  // its Chainlink CCIP LockRelease pool 0x5b5CE779709360A6B6906b79CAc5029A5B7CCdc4
  // escrows exactly the Ethereum + Pharos burn/mint supply (1,110.0 verified
  // 2026-07-29), and the LayerZero OFTAdapter 0xbfd47e6098017c04957ba218dade65e23f661793
  // escrows the ApeChain OFT representation. Reallocate rather than sum.
  // ApeChain and Pharos are absent from buildChainRpcs(), so pin reviewed
  // public endpoints; any unreadable leg still fails the aggregate closed.
  "pgold-pleasing": {
    aggregateContracts: [
      { chain: "arbitrum" },
      { chain: "ethereum" },
      supplyProbeChain("apechain"),
      supplyProbeChain("pharos"),
    ],
    canonicalSupplyChain: "arbitrum",
  },
  // PAXG is issuer-native on Ethereum, Solana and Base. The Ethereum LayerZero
  // OFTWrapper 0xd09ede557ef195983c9544a5724046fbd6e8a3c6 is a burn/mint
  // SupplyController (approvalRequired false; balanceOf 0), so Ethereum
  // totalSupply does not escrow the Solana or Base float and the legs sum.
  // KPMG's 2026-09-30 PAXG examination reconciles 235 Base PAXG among redeemable
  // tokens (liabilities Ethereum 432,506 / Solana 2,560 / Base 235 / Robinhood 5),
  // and the Base proxy is reviewed as Paxos issuer-native issuance rather than a
  // bridge representation. Explorer reads on 2026-11-01: Ethereum
  // 442,885.899659 + Solana 3,215.284434, with Base the ~235 oz remainder.
  // Do not add CANONICAL_SUPPLY_CHAINS.
  "paxg-paxos": {
    aggregateContracts: [{ chain: "ethereum" }, { chain: "solana" }, { chain: "base" }],
  },
  // DGLD is independently gold-backed on Ethereum, Base and Solana after the
  // 2026-06-30 bridge close. Re-verified 2026-11-25: Ethereum 1,603.687 (block
  // 26491782) + Base 401.159 (block 62071814) + Solana Token-2022 812.343 (slot
  // 473723308) = 2,817.189 DGLD, matching CoinGecko (2,817.189) and Gold Token
  // SA's live bar registry (/v1/networks, gap 0) to the unit.
  "dgld-gold-token-sa": {
    aggregateContracts: [{ chain: "ethereum" }, { chain: "base" }, { chain: "solana" }],
  },
  // VNXAU is independently issuer-native across seven deployments. Reviewed
  // 2026-11-25: Ethereum + Polygon + Base + Etherlink + Solana sum to
  // 43,984.43777116 (-0.0354% vs CoinGecko 44,000), classic Stellar reads 0
  // (Horizon ledger 65663736), and Tezos FA2 KT1LSH97386CURN9FgRNqdQJoHaHY6e1vxUv
  // reads 0 (TzKT level 15967010) but is live (paused: false) with no supply
  // probe family. Withhold the whole roster and keep CoinGecko upstream.
  // Independent native Ethereum and Sui receipts. The Sui reader pins Ember's
  // vault and reads its embedded TreasuryCap (coinMetadata.supply is null).
  "eearn-ember": {
    aggregateContracts: [{ chain: "ethereum" }, { chain: "sui" }],
    // Prefer the complete native Ethereum + Sui receipt aggregate over a
    // CoinGecko row that historically covered only Sui.
    preferMcap: true,
  },
  // USTB is native on Ethereum and Solana; Plume is Superstate issuer-native
  // burn/mint (bridge() burns source, no lockbox). Verified 2026-08-19:
  // Ethereum 67,696,661.464479 + Plume 169,698.550490 + Solana 224,120.571877
  // = 68,090,480.586846, matching Superstate's token rows exactly. Superstate
  // book-entry 16,278,150.21 (19.29% of AUM) is not a token and stays outside
  // this token-stock fallback; never partition the book-entry-inclusive CG cap.
  // CG circulating 84,341,804.96 includes it. Plume is absent
  // from buildChainRpcs(), so pin the reviewed public endpoint.
  "ustb-superstate": {
    aggregateContracts: [
      { chain: "ethereum" },
      supplyProbeChain("plume"),
      { chain: "solana" },
    ],
  },
  // VBILL is Securitize-native on Avalanche, Ethereum, BSC and Solana (no
  // Wormhole lockbox). Verified 2026-08-19: Avalanche 136,217,752.38 +
  // Ethereum 21,684,333.099655 + BSC 21,501,301.39 + Solana 13,926,019.96
  // = 193,329,406.829655, equal to CoinGecko market cap at $1 NAV.
  "vbill-vaneck": {
    aggregateContracts: [
      { chain: "avalanche" },
      { chain: "ethereum" },
      { chain: "bsc" },
      { chain: "solana" },
    ],
  },
  // spUSDC is a per-chain Spark ERC-4626 over local USDC. The reviewed
  // aggregate path replaces the former Ethereum-only fallback and publishes
  // a complete chainCirculating split. Verified
  // 2026-08-19: Ethereum 262,732,021.385906 (asset=USDC, totalAssets
  // 271,160,715.325800, convertToAssets(1e6)=1.032081) + Avalanche
  // 11,720,796.241001 (asset=0xb97e…8a6e, totalAssets 12,024,527.957899)
  // = 274,452,817.626907. Ethereum balanceOf(self)=0. X Layer is the same
  // local "Spark Savings USDC" vault shape (asset=0xb6ce…3061); verified
  // 2026-10-23: totalSupply 92,646,552.847606, totalAssets 92,926,672.078548.
  // Every registered contract must be probed, so this leg is required.
  "susdc-spark": {
    aggregateContracts: [{ chain: "ethereum" }, { chain: "avalanche" }, supplyProbeChain("xlayer")],
  },
  // spUSDT is a per-chain Spark ERC-4626 (USDT on Ethereum, USDT0 on Arbitrum
  // and X Layer). USDT0 is collateral, not a bridged spUSDT representation.
  // Verified 2026-08-19: Ethereum 364,164,245.855785 (totalAssets
  // 374,349,718.457184) + Arbitrum 1,273.135898 (totalAssets 1,276.509506)
  // = 364,165,518.991683. Ethereum balanceOf(self)=0. Arbitrum is dust; allow
  // a zero read.
  "susdt-spark": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "arbitrum", allowZeroSupply: true },
      supplyProbeChain("xlayer"),
    ],
  },
  // sUSDD is an independent SavingsUsdd ERC-4626 on Ethereum and BSC over local USDD.
  // No Tron sUSDD token in issuer deployment/collateral pages or CoinGecko platforms.
  // Verified 2026-08-18: ETH 222,174,299.983810 + BSC 12,526,473.143741
  // = 234,700,773.127551 (−0.14% vs CoinGecko 235,033,744.23).
  "susdd-tron-dao-reserve": {
    aggregateContracts: [{ chain: "ethereum" }, { chain: "bsc" }],
  },
  // ZARP is issuer-native on Ethereum, Base, Polygon and Solana. Verified 2026-08-19:
  // Ethereum 41,826,590.83270887 + Base 15,729,937.39 + Polygon 10,020,000.00 +
  // Solana 6,403,393.992399 = 73,979,922.21510787, exactly CoinGecko's circulating.
  // A same-address Gnosis token exists and reads 0; the issuer contract list omits it.
  "zarp-zarp": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "base" },
      { chain: "polygon" },
      { chain: "solana" },
    ],
  },
  // MXNB is an independently issuer-native FiatTokenV2_2 proxy across six EVMs.
  // Re-verified 2026-11-25: Ethereum 1,944,524.727714 + Polygon 36,547.877689 +
  // Arbitrum 45,764,259.249495 + Avalanche 2,306,288.787538 + Base 31,381,203.788630
  // + Arc 1,198,977.257144 (block 33065279) = 82,631,801.688210 MXNB, matching
  // CoinGecko circulating (82,631,801.68821) to the displayed unit.
  "mxnb-juno": {
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "polygon" },
      { chain: "arbitrum" },
      { chain: "avalanche" },
      { chain: "base" },
      supplyProbeChain("arc"),
    ],
  },
  // GBPe is issuer-native on six EVMs (official Monerium /tokens list). Verified
  // 2026-08-19: Ethereum 0 + Gnosis 422,355.12 + Linea 22,858.47 + Arbitrum 11.00
  // + Base 433.95 + Polygon 21.24 = 445,679.78. CoinGecko total 422,355.12 is
  // the Gnosis leg only. V1 TokenFrontends (Gnosis 0x5cb9…, Polygon 0x7579…)
  // report the same totalSupply as the v2 proxies — do not add them.
  "gbpe-monerium": {
    aggregateContracts: [
      { chain: "ethereum", allowZeroSupply: true },
      { chain: "gnosis" },
      supplyProbeChain("linea"),
      { chain: "arbitrum" },
      { chain: "base" },
      { chain: "polygon" },
    ],
  },
  // AxCNH is issuer-native FiatTokenV2 on Conflux and Ethereum (independent masterMinters).
  // Verified 2026-08-19: Ethereum 1,000,000.4 + Conflux 38,128,445.4 = 39,128,445.8,
  // exact CoinGecko circulating. Conflux is absent from buildChainRpcs(); pin the
  // official eSpace endpoint. Ethereum cannot escrow Conflux (1.00M < 38.13M).
  "axcnh-anchorx": {
    aggregateContracts: [
      { chain: "ethereum" },
      supplyProbeChain("conflux"),
    ],
  },
  // MYRC is Blox issuer-native on Ethereum, Arbitrum, Base and Solana.
  // Verified 2026-08-19: Ethereum 1,054,500 + Arbitrum 4,099,598.66 + Base 500,000
  // + Solana 711,199.990103 = 6,365,298.650103. CoinGecko 5,310,798.650103 equals
  // the three platforms it indexes and omits Ethereum (16.57% of the true total).
  "myrc-blox": {
    aggregateContracts: [{ chain: "ethereum" }, { chain: "arbitrum" }, { chain: "base" }, { chain: "solana" }],
    preferMcap: true,
  },
  // EUROT is independently mintable on Avalanche, Ethereum and Polygon.
  // Verified 2026-08-19: Avalanche 160,000 + Ethereum 0 + Polygon 0 = 160,000,
  // exact CoinGecko circulating. Ethereum/Polygon are reviewed live zeros.
  "eurot-token-teknoloji": {
    aggregateContracts: [
      { chain: "avalanche" },
      { chain: "ethereum", allowZeroSupply: true },
      { chain: "polygon", allowZeroSupply: true },
    ],
  },
  // JPYT is minted natively on each OP-Stack chain by that chain's DepositManager.
  // Verified 2026-08-19: Optimism 6,641,129.778467 + Base 992,314.925958 =
  // 7,633,444.704425, exact CoinGecko circulating. Base is 13.00% of the total.
  "jpyt-dephaser": {
    aggregateContracts: [{ chain: "optimism" }, { chain: "base" }],
  },
  // BRLV is Crown's Base-native token. The Base BRLVCanonicalGateway's outbound
  // path calls BRLV burnAssets (and its inbound path mintAssets) rather than
  // escrowing, and the Ethereum bridgedBRLV is a relayer-minted representation,
  // so the two reviewed deployments sum. Verified 2026-09-01: Base
  // 373,483,803.832830 (block 50734266) + Ethereum 24.500000 (block 25881782)
  // = 373,483,828.332830, bit-for-bit CoinGecko's total supply
  // 373,483,828.3328299. The Ethereum leg is 0.0000066% of the total and can be
  // burned to nothing, so allow it to read zero.
  // Reviewed 2026-10-25: issuer-listed Tempo TIP-20 is 6 decimals; include its
  // burn/mint stock, with zero allowed after complete redemption.
  "brlv-crown": {
    aggregateContracts: [
      { chain: "base" },
      { chain: "ethereum", allowZeroSupply: true },
      supplyProbeChain("tempo", { allowZeroSupply: true }),
    ],
  },
  // syzUSD is natively issued on Plasma and carried to Ethereum and Monad by
  // Chainlink CCIP BurnMintTokenPool 1.6.1 spokes whose Plasma counterparty is
  // LockReleaseTokenPool 0x31672de4726227feb22f2dfbcfa985c71bea86b2. Verified
  // 2026-09-01: that pool escrows 23,243,788.814824 syzUSD at Plasma block
  // 31317318 against an Ethereum 809,744.184523 (block 25881782) + Monad
  // 10,153,703.107279 (block 101016246) spoke total of 10,963,447.291802, so the
  // Plasma totalSupply 53,725,933.522240 already contains the remote float and is
  // reallocated rather than summed. CoinGecko's total supply 63,879,636.629519 is
  // its Plasma+Monad platform sum to the wei (it does not index Ethereum) and
  // therefore double counts Monad; conserving the canonical total restates the
  // published supply by -15.82% (krwq-iq double-count precedent). Monad is in
  // buildChainRpcs() as a public-only chain (added for the Dwellir
  // provider-parity lane) and Plasma entered it for the reviewed Curve factory
  // capture, so both legs still pin reviewed public endpoints here and stay
  // independent of that registry.
  // The reviewed Aptos CCIP BurnMint representation joins this same canonical
  // partition (2026-10-01); its pinned-ledger reader is distinct from Movement.
  "syzusd-yuzu": {
    aggregateContracts: [
      supplyProbeChain("plasma"),
      { chain: "ethereum" },
      supplyProbeChain("monad"),
      supplyProbeChain("hyperevm", { allowZeroSupply: true }),
      // override: retain this asset's reviewed primary-only supply profile.
      supplyProbeChain("sei", { fallbackRpcUrl: undefined }),
      // override: pharos.drpc.org answers eth_call with -32601 (method not
      // available; re-checked 2026-09-28), so this leg reads the ZAN primary
      // alone rather than declaring a fallback that can never serve totalSupply.
      supplyProbeChain("pharos", { fallbackRpcUrl: undefined }),
      supplyProbeChain("berachain"),
      supplyProbeChain("aptos"),
      // Reciprocal Plasma/Base pool identity reviewed 2026-10-20. This is a
      // represented-stock census leg, not bridge-control or in-flight clearance.
      // totalSupply() read 0 on 2026-10-23; a zero leg is an observed zero, not
      // a failed read, so it must not void the whole partition.
      { chain: "base", allowZeroSupply: true },
    ],
    canonicalSupplyChain: "plasma",
  },
  // IDRT is minted natively on Ethereum, BSC and Polygon: each is a
  // non-upgradeable Ownable ERC-20 whose owner() is the same PT Rupiah Token
  // Indonesia 4-of-6 Safe, so no leg escrows another and the deployments sum.
  // Historical four-ledger verification, 2026-09-01: Ethereum 44,876,696,516.00 (block
  // 25881782) + BSC 31,739,108,295.00 (block 119325993) + Polygon
  // 14,040,000,000.000000 (block 93035233) + Harmony 1,201,000.00 (block 93230607)
  // = 90,657,005,811.00. RESTATEMENT: CoinGecko's 173,856,905,811 reconciles to
  // the unit as (live Ethereum+BSC+Polygon totalSupply sum + a flat
  // 40,000,000,000 issuer-declared addend) - bit-exact against history through
  // 2025-08-30, when the series froze (the issuer's own supply API at
  // api-client.rupiahtoken.com/v1/supply is dead) - so 43,201,101,000 of
  // subsequent on-chain burns were never applied, and the Harmony 1,201,000 CG
  // never counted closes the 83,199,900,000 delta exactly. Known gap: the
  // issuer's own site names two further ledgers this aggregate cannot read -
  // IDRTB (BEP-2 IDRTB-178, chain sunset Jun 2024, ~90B with 98.98% parked in
  // one post-migration address) and IDRTL (permissioned Luniverse, no public
  // explorer); the flat 40B addend is issuer-declared supply on those unreadable
  // ledgers and stays outside this aggregate.
  // Publishing the pinned reads restates supply by -47.86%; even crediting
  // IDRTB/IDRTL at face value, CoinGecko's own basis would give ~130.7B today,
  // never the frozen 173.9B (owner-ratified 2026-09-01).
  // Reviewed 2026-11-12: Harmony shard 0 unreadable since 2026-11-11 (both
  // official endpoints HTTP 502; network closure proposed). Its frozen
  // 1,201,000 IDRT lock-mint representation (0.0014%) joins IDRTB/IDRTL outside
  // the readable perimeter, not as observed zero; the three issuer-native legs sum.
  "idrt-rupiah-token": {
    preferMcap: true,
    unreadableDeployments: [{ chain: "harmony", address: "0xcefbea899cfccdc653b171d063481b622086be3f" }],
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "bsc" },
      { chain: "polygon" },
    ],
  },
  // cNGN's Bantu-native float has no supported supply reader. Destination
  // representations such as Asset Chain cannot prove its global supply; leave
  // it on upstream supply until canonical accounting is available.
  "usg-tangent": {
    // Reviewed 2026-11-02: USG's circulating stock is its issuer-native Ethereum
    // totalSupply less the two PegKeeper balances Tangent's own UI excludes
    // (`CURATED_ONCHAIN_SUPPLY_EXCLUSIONS`). The CoinGecko market cap counts that
    // keeper inventory, so it must never replace the adjusted read.
    // https://etherscan.io/token/0xB1c2Db5d6cA03FCe73dBd304d320bF76C55Ae1B1
    preferMcap: true,
    // Tangent mints USG inventory to PegKeeper contracts that deposit/withdraw
    // from protocol liquidity pools. Tangent's own UI excludes those live
    // balances from circulating USG, so Pharos mirrors that rule.
    excludedBalances: {
      chain: "ethereum",
      holderAddresses: [
        "0xf89615f75c8161dc185c03020240905f6b66bad9",
        "0x8a7f16508d1e8b48bdf36023f378cc04d9506d4e",
      ],
      supplySource: "onchain-circulating-supply",
      historicalBackfillStartDay: startOfUtcDaySec(new Date(Date.UTC(2026, 4, 7))),
    },
  },
  "sfrax-frax": {
    preferMcap: true,
  },
  // === #2169 Wave-1 non-USD reviewed on-chain supply checkpoints (clocked native DEWS velocity) ===
  // EURCV: SG-FORGE issuer-native across Ethereum, XRPL, Stellar and Solana (no lock/mint bridge).
  // Verified live 2026-11-22: Ethereum 141,867,733.95 + XRPL 10,000,000.00 (validated ledger
  // 108496941, zero frozen/locked) + Stellar 15,030,600.00 (Horizon classic EURCV) + Solana
  // 1,938,004.30 = 168,836,338.25 EURCV (-0.0535% vs DefiLlama implied 168,926,766.20;
  // SG-FORGE 22/11/2026 disclosure 169,866,718.22). Stellar metadata stores the bare issuer
  // G-account, so bind classic code EURCV explicitly.
  "eurcv-societe-generale-forge": {
    preferMcap: true,
    aggregateContracts: [
      { chain: "ethereum" },
      supplyProbeChain("xrpl"),
      { chain: "stellar", stellarAssetCode: "EURCV" },
      { chain: "solana" },
    ],
  },
  // BRLA: Avenia issuer-native OPERATOR_ROLE mint/redeem across EVM chains (no lockbox).
  // Verified live 2026-11-22 (Wave 1) and re-verified 2026-11-23 (D5 on-chain state clocks):
  // Moonbeam halted at final block 16796699 (2026-08-10T11:36:12Z); its frozen 4,294.09 BRLA
  // (0.0013% of 324.46M supply; DefiLlama reported 0) stays outside the live clocked perimeter in
  // unreadableDeployments so Polygon, Gnosis and Celo enforce fresh EIP-1898 block clocks.
  "brla-brla-digital": {
    preferMcap: true,
    unreadableDeployments: [{ chain: "moonbeam", address: "0xfeb25f3fddad13f82c4d6dbc1481516f62236429" }],
    aggregateContracts: [
      { chain: "polygon" },
      { chain: "gnosis" },
      { chain: "celo" },
    ],
  },
  // ZCHF: Frankencoin native Ethereum + seven Chainlink CCIP BurnMintTokenPool 1.5.1 L2 spokes.
  // Verified live 2026-11-22: Ethereum CCIP pool 0x9359cd75549DaE00Cdd8D22297BC9B13FbBe4B79 holds
  // 0 ZCHF (zero escrow double-count); Ethereum 27,751,496.09 + Optimism 1,960,211.88 + Gnosis
  // 1,201,882.65 + Base 1,608,214.90 + Arbitrum 15,054.19 + Polygon 1,133.02 + Avalanche 16.67 +
  // Sonic 4.00 = 32,538,013.40 ZCHF (-0.0050% vs DefiLlama implied 32,539,636.63).
  "zchf-frankencoin": {
    preferMcap: true,
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "optimism" },
      { chain: "gnosis" },
      { chain: "base" },
      { chain: "arbitrum" },
      { chain: "polygon" },
      { chain: "avalanche", allowZeroSupply: true },
      supplyProbeChain("sonic", { allowZeroSupply: true }),
    ],
  },
  // EURI: Banking Circle issuer-native deployments on Ethereum and BSC (no bridge lockbox).
  // Verified live 2026-11-22: Ethereum 25,539,092.81 + BSC 2,963,988.35 = 28,503,081.16 EURI
  // (bit-exact match to DefiLlama implied 28,503,081.16).
  "euri-banking-circle": {
    preferMcap: true,
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "bsc" },
    ],
  },
  // === #2169 D5: EURC reviewed on-chain circulating supply checkpoints ===
  // Circle issuer-native across nine chains; five lock/mint bridge representations (Polygon,
  // Sonic, Tempo, Cardano, Optimism) remain conserved in Ethereum totalSupply(). On Solana,
  // Circle holds unreleased pre-mint inventory in three published SPL token accounts
  // (circlefin/centre-ecosystem eurc/solana/minters.json) that must be subtracted atomically
  // at the same finalized slot. Verified live 2026-11-23: Ethereum 322,465,823.79 + Base
  // 48,557,235.90 + Avalanche 3,661,692.96 + World Chain 417,589.73 + Stellar 4,571,572.20 +
  // Solana 69,162,684.27 (115,017,211.83 gross - 45,854,527.56 pre-mint) + Cronos 274,243.04 +
  // Plasma 231,394.28 + Arc 10,418,885.19 = 459,761,121.36 EURC (-0.000055% vs Circle API
  // 459,761,376.36).
  "eurc-circle": {
    preferMcap: true,
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "base" },
      { chain: "avalanche" },
      supplyProbeChain("worldchain"),
      { chain: "stellar" },
      {
        chain: "solana",
        excludedTokenAccounts: [
          "89LjSs8wP3EZNCKcs8aCxngQaEuyhUyGE4STkFwNgRT3",
          "HQHDva1bR4vqxvz6Y8yaLvqkD4AeWCDso8aJ9v5rfLHY",
          "A6sLLUWebvoUUnQoCiB45ktetd34iamfD8kwTsBSReAb",
        ],
      },
      supplyProbeChain("cronos"),
      { chain: "plasma" },
      supplyProbeChain("arc"),
    ],
    excludedRepresentations: [
      { chain: "polygon", address: "0x8a037dbca8134ffc72c362e394e35e0cad618f85", canonicalChain: "ethereum" },
      { chain: "sonic", address: "0xe715cba7b5ccb33790cebff1436809d36cb17e57", canonicalChain: "ethereum" },
      { chain: "tempo", address: "0x20c0000000000000000000001621e21f71cf12fb", canonicalChain: "ethereum" },
      { chain: "cardano", address: "25c5de5f5b286073c593edfd77b48abc7a48e5a4f3d4cd9d428ff93545555243", canonicalChain: "ethereum" },
      { chain: "optimism", address: "0xdcb612005417dc906ff72c87df732e5a90d49e11", canonicalChain: "ethereum" },
    ],
  },
  // === #2306: wM (wm-m0) 17-chain reviewed native on-chain supply plan (Option A2, owner decision A5 2026-11-25) ===
  // M0 Portal V2, Portal Lite (Plume), Portal V1, and Solana Portal V2 atomically unwrap (burn)
  // wM into $M on send and wrap (mint) $M into wM on delivery; only $M is locked in Ethereum
  // HubPortal, so every chain's wM.totalSupply() is distinct 1:1 $M-backed supply (zero wM
  // escrow deduction). Pinned EIP-1898 + finalized-Solana reads (2026-11-25): 17 CHAIN_META
  // deployments total 70,143,205.87 wM (~99.896% of global wM). Ethereum HubPortal (block
  // 26491774) proves Nexus (chainId 3946) is an isolated spoke (bridgedPrincipal == 1.380000,
  // bounding Nexus wM to <= 1.520478 wM while RPC stays down); Nexus is recorded in
  // unreadableDeployments. Mantra EVM (72,948.06 wM) and Moca (2.31 wM) stay outside this
  // perimeter under an explicit dated owner exception until CHAIN_META identity is settled.
  "wm-m0": {
    preferMcap: true,
    unreadableDeployments: [
      { chain: "nexus", address: "0x437cc33344a0b27a429f795ff6b469c72698b291" },
    ],
    aggregateContracts: [
      { chain: "ethereum" },
      { chain: "solana" },
      { chain: "arbitrum", allowZeroSupply: true },
      { chain: "base", allowZeroSupply: true },
      { chain: "plume", allowZeroSupply: true, fallbackRpcUrl: SUPPLY_RPC_DEFAULTS.plume.fallbackRpcUrl },
      { chain: "linea", allowZeroSupply: true, fallbackRpcUrl: SUPPLY_RPC_DEFAULTS.linea.rpcUrl },
      { chain: "bsc", allowZeroSupply: true },
      { chain: "hyperevm", allowZeroSupply: true, fallbackRpcUrl: HYPEREVM_HISTORY_RPC_URL },
      supplyProbeChain("soneium", { allowZeroSupply: true }),
      { chain: "plasma", allowZeroSupply: true },
      supplyProbeChain("citrea", { allowZeroSupply: true }),
      { chain: "monad", allowZeroSupply: true },
      { chain: "optimism", allowZeroSupply: true },
      supplyProbeChain("rise", { allowZeroSupply: true }),
      supplyProbeChain("0g", { allowZeroSupply: true }),
      supplyProbeChain("sei", { allowZeroSupply: true }),
      supplyProbeChain("fluent", { allowZeroSupply: true }),
    ],
  },
};

// These canonical-chain totalSupply values already include tokens escrowed for
// the listed lock/mint representations. Reallocate that supply across chains
// instead of adding representation supplies to the canonical total.
export const CURATED_AGGREGATE_CANONICAL_SUPPLY_CHAINS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(REVIEWED_ONCHAIN_SUPPLY_PLANS).flatMap(([id, plan]) =>
    plan.canonicalSupplyChain ? [[id, plan.canonicalSupplyChain]] : []),
);

/** Reviewed representation stock already included in its selected native register. */
export const CURATED_AGGREGATE_EXCLUDED_REPRESENTATIONS: Readonly<Record<string, NonNullable<ReviewedOnchainSupplyPlan["excludedRepresentations"]>>> = Object.fromEntries(
  Object.entries(REVIEWED_ONCHAIN_SUPPLY_PLANS).flatMap(([id, plan]) =>
    plan.excludedRepresentations ? [[id, plan.excludedRepresentations]] : []),
);

export type CuratedAggregateEscrowResidualConfig = (
  | { escrowAddress: string; escrowByChain?: never }
  | { escrowByChain: Readonly<Record<string, string>>; escrowAddress?: never }
) & {
  /**
   * Deliberately non-canonical `chainCirculating` label for escrowed supply
   * that no configured representation leg claims. `resolveChainId()` must
   * return null for it so V9 pools it under the unmatched-chain-label route
   * instead of silently crediting it to the canonical chain.
   */
  unattributedChainLabel: string;
};

/**
 * Canonical-chain escrow reads that split a reallocating aggregate's canonical
 * row into free float and an explicit unattributed remainder. Without this the
 * remainder (untracked representations plus any escrow that matches no route)
 * hides inside the canonical chain's published supply and grows unobserved.
 */
export const CURATED_AGGREGATE_ESCROW_RESIDUALS: Readonly<Record<string, CuratedAggregateEscrowResidualConfig>> = Object.fromEntries(
  Object.entries(REVIEWED_ONCHAIN_SUPPLY_PLANS).flatMap(([id, plan]) =>
    plan.escrowResidual ? [[id, plan.escrowResidual]] : []),
);

export function isZephyrScannerSupplyId(id: string): boolean {
  return REVIEWED_ONCHAIN_SUPPLY_PLANS[id]?.nativeWorkflow === "zephyr-scanner";
}

export function reviewedOnchainSupplyReader(
  meta: Pick<StablecoinMeta, "id">,
  contract: OnchainSupplyContract,
): ReviewedOnchainSupplyDeployment["reader"] {
  return REVIEWED_ONCHAIN_SUPPLY_PLANS[meta.id]?.aggregateContracts
    ?.find((deployment) => deployment.chain === contract.chain
      && (deployment.address == null || deployment.address === contract.address))?.reader;
}

/**
 * Resolve which supply reader can read a tracked deployment, or null when no
 * reader exists for that chain family or the address shape is wrong.
 */
export function onchainSupplyProbeFamily(
  contract: OnchainSupplyContract,
  stellarAssetCode?: string,
): OnchainSupplyProbeFamily | null {
  if (contract.chain === "sui") return contract.address === EEARN_SUI_COIN_TYPE ? "sui" : null;
  switch (NON_EVM_PROBE_FAMILY_BY_CHAIN[contract.chain]) {
    case "solana":
      return contract.address.length > 0 ? "solana" : null;
    case "movement":
      return HEX32_ADDRESS_RE.test(contract.address) ? "movement" : null;
    case "aptos":
      return HEX32_ADDRESS_RE.test(contract.address) ? "aptos" : null;
    case "starknet":
      return HEX32_ADDRESS_RE.test(contract.address) ? "starknet" : null;
    case "icp":
      return ICP_CANISTER_ID_RE.test(contract.address) ? "icp" : null;
    case "stellar":
      // eslint-disable-next-line security/detect-unsafe-regex -- bounded optional code plus fixed-width StrKey; linear.
      return /^(?:[a-zA-Z0-9]{1,12}-)?C[A-Z2-7]{55}$/.test(contract.address)
        || /^[a-zA-Z0-9]{1,12}-G[A-Z2-7]{55}$/.test(contract.address)
        || (stellarAssetCode != null
          && /^[a-zA-Z0-9]{1,12}$/.test(stellarAssetCode)
          && /^G[A-Z2-7]{55}$/.test(contract.address)) ? "stellar" : null;
    case "xrpl": {
      const [currency, issuer, extra] = contract.address.split(".");
      return contract.decimals === null && contract.amountEncoding?.kind === "xrpl-issued-currency"
        && extra === undefined && XrplIssuedCurrencyAmountSchema.safeParse({ currency, issuer, value: "0" }).success
        ? "xrpl" : null;
    }
    default:
      break;
  }

  return CHAIN_META[contract.chain]?.type === "evm" && EVM_ADDRESS_RE.test(contract.address) ? "evm" : null;
}

// Test seam (keep exported): the per-chain address-format matrix is asserted
// directly; the resolver wrappers below are the production entry points.
export function supportsOnchainSupplyProbe(contract: OnchainSupplyContract): boolean {
  return onchainSupplyProbeFamily(contract) !== null;
}

export function selectSingleOnchainSupplyProbeContract(meta: StablecoinMeta): OnchainSupplyContract | null {
  if (getOnchainSupplyHoldReason(meta.id)) return null;
  const contracts = meta.contracts ?? [];
  if (contracts.length !== 1) return null;
  const [contract] = contracts;
  return contract && supportsOnchainSupplyProbe(contract) ? contract : null;
}

export function selectSupplementalOnchainSupplyProbeContract(meta: StablecoinMeta): OnchainSupplyContract | null {
  return selectSingleOnchainSupplyProbeContract(meta);
}

export function selectCuratedAggregateOnchainSupplyProbeContracts(
  meta: StablecoinMeta,
): readonly CuratedAggregateOnchainSupplyContract[] | null {
  if (getOnchainSupplyHoldReason(meta.id)) return null;
  const curatedContracts = REVIEWED_ONCHAIN_SUPPLY_PLANS[meta.id]?.aggregateContracts;
  if (!curatedContracts || curatedContracts.length === 0) return null;

  const selected: CuratedAggregateOnchainSupplyContract[] = [];
  for (const { dropoutRepair: _dropoutRepair, reader: _reader, ...config } of curatedContracts) {
    const matches = meta.contracts?.filter((entry) => entry.chain === config.chain
      && (config.address == null || entry.address === config.address));
    const contract = matches?.length === 1 ? matches[0] : undefined;
    if (!contract || onchainSupplyProbeFamily(contract, config.stellarAssetCode) === null) return null;
    selected.push({ config, contract });
  }

  const representations = CURATED_AGGREGATE_EXCLUDED_REPRESENTATIONS[meta.id] ?? [];
  const unreadable = REVIEWED_ONCHAIN_SUPPLY_PLANS[meta.id]?.unreadableDeployments ?? [];
  if (representations.some((review) =>
    !selected.some(({ contract }) => contract.chain === review.canonicalChain)
    || !meta.contracts?.some((contract) => contract.chain === review.chain && contract.address === review.address)
    || selected.some(({ contract }) => contract.chain === review.chain))) return null;

  // A roster speaks for the whole asset only when every registered deployment
  // participates. A summed roster that skips one under-counts; a canonical
  // lock/mint roster conserves remote supply but attributes the unprobed
  // remainder to the canonical chain. Only shared lockboxes and explicit
  // reviewed exclusions excuse an unselected deployment.
  if (
    CURATED_AGGREGATE_ESCROW_RESIDUALS[meta.id]?.escrowAddress == null
    && meta.contracts?.some((contract) => !selected.some((entry) => entry.contract === contract)
      && ![...representations, ...unreadable].some((review) => review.chain === contract.chain && review.address === contract.address))
  ) {
    return null;
  }
  return selected;
}

export function hasRuntimeOnchainSupplyPath(meta: StablecoinMeta): boolean {
  return (
    getOnchainSupplyHoldReason(meta.id) != null ||
    isZephyrScannerSupplyId(meta.id) ||
    selectSupplementalOnchainSupplyProbeContract(meta) != null ||
    selectCuratedAggregateOnchainSupplyProbeContracts(meta) != null
  );
}
