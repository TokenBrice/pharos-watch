import { splitCompositePriceSource } from "@shared/lib/pricing-sources";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { sumPegBuckets } from "@shared/lib/supply";
import type { PriceConfidence, PriceObservedAtMode, StablecoinMeta } from "@shared/types/core";
import type { PeggedAsset } from "../cron/sync-stablecoins/enrich-prices-shared";
import { fetchMarketBackfillPriceSeries } from "../api/backfill-price-sources";
import { binarySearchNearest } from "./binary-search";
import { fetchEvmCallHexAtBlock, resolveClosestBlockAtOrBeforeTimestamp, type EvmBlockSearchCache } from "./evm-rpc";
import { getArchiveFallbackRpcUrls } from "./public-rpc-registry";
import { rethrowIfAborted } from "./abort";
import { validateCompositePricingSourceFreshness } from "./pricing-source-freshness";
import { isReplaySafePriceSource } from "./pricing-source-policy";
import type { PriceValidationReferences } from "./price-validation";

const ETHEREUM_CHAIN = "ethereum";

const PROTOCOL_REDEEM_SOURCE = "protocol-redeem";
const CAP_CUSD_ID = "cusd-cap";
const IUSD_INFINIFI_ID = "iusd-infinifi";
const USDAI_USD_AI_ID = "usdai-usd-ai";
const PYUSD_PAYPAL_ID = "pyusd-paypal";
const M_M0_ID = "m-m0";
const USDK_KAST_ID = "usdk-kast";
const XO_EXODUS_ID = "xo-exodus";
const USDNR_NERONA_ID = "usdnr-nerona";
const WM_M0_ID = "wm-m0";
const USDC_CIRCLE_ID = "usdc-circle";
const USDT_TETHER_ID = "usdt-tether";
const USDE_ETHENA_ID = "usde-ethena";
const AUSD_AGORA_ID = "ausd-agora";
const AVUSD_AVANT_ID = "avusd-avant";
const GHO_AAVE_ID = "gho-aave";
const USN_NOON_ID = "usn-noon";
const YZUSD_YUZU_ID = "yzusd-yuzu";
const CHFAU_ALLUNITY_ID = "chfau-allunity";
const SOFID_SOFI_ID = "sofid-sofi";
const WEUSD_PICWE_ID = "weusd-picwe";
const USBD_BIMA_ID = "usbd-bima";
const USDQ_QUILL_ID = "usdq-quill";
const CAP_GET_BURN_AMOUNT_SELECTOR = "0xb7c4a6bf"; // getBurnAmount(address,uint256)
const IUSD_RECEIPT_TO_ASSET_SELECTOR = "0xf308cf65"; // receiptToAsset(uint256)
const IUSD_INFINIFI_REDEEM_CONTROLLER = "0xCb1747E89a43DEdcF4A2b831a0D94859EFeC7601";
const ERC4626_CONVERT_TO_ASSETS_SELECTOR = "0x07a2d13a"; // convertToAssets(uint256)
const ERC4626_NAV_MIN_RATIO = 0.5;
const ERC4626_NAV_MAX_RATIO = 10;
const PREVIEW_REDEEM_SELECTOR = "0x4cdad506"; // previewRedeem(uint256)
const IDLE_CDO_VIRTUAL_PRICE_SELECTOR = "0x9290d427"; // virtualPrice(address)

const CAP_SAMPLE_SUPPLY_FRACTION = 0.01;
const CAP_SAMPLE_NOTIONAL_MIN_USD = 1_000;
const CAP_SAMPLE_NOTIONAL_MAX_USD = 1_000_000;
const CAP_HISTORICAL_MIN_COVERAGE = 0.8;
const INHERITED_PARENT_SYNC_MAX_AGE_SEC = 30 * 60;
const BASIS_POINTS_DENOMINATOR = 10_000;

interface InheritedTrackedPriceConfig {
  parentId: string;
  multiplier?: number;
}

const INHERITED_TRACKED_PRICE_CONFIGS = {
  [USDAI_USD_AI_ID]: { parentId: PYUSD_PAYPAL_ID },
  "iusd-initia": { parentId: AUSD_AGORA_ID },
  "usdcx-movement": { parentId: USDC_CIRCLE_ID },
  [M_M0_ID]: { parentId: WM_M0_ID },
  [USDK_KAST_ID]: { parentId: WM_M0_ID },
  [XO_EXODUS_ID]: { parentId: WM_M0_ID },
  [USDNR_NERONA_ID]: { parentId: WM_M0_ID },
  [WEUSD_PICWE_ID]: { parentId: USDC_CIRCLE_ID, multiplier: 0.99 },
} as const satisfies Record<string, InheritedTrackedPriceConfig>;

interface ProtocolParConfig {
  id: string;
  pegType: "peggedUSD" | "peggedCHF";
  feeBps?: number;
}

const PROTOCOL_PAR_PRICE_CONFIGS: readonly ProtocolParConfig[] = [
  { id: SOFID_SOFI_ID, pegType: "peggedUSD" },
  { id: USBD_BIMA_ID, pegType: "peggedUSD" },
  { id: USDQ_QUILL_ID, pegType: "peggedUSD" },
  { id: CHFAU_ALLUNITY_ID, pegType: "peggedCHF" },
];

const PROTOCOL_PAR_PRICE_CONFIGS_BY_ID = new Map<string, ProtocolParConfig>(
  PROTOCOL_PAR_PRICE_CONFIGS.map((entry) => [entry.id, entry]),
);

interface Erc4626NavVaultConfig {
  id: string;
  parentId: string;
  chain: string;
  vault: string;
  vaultDecimals: number;
  assetDecimals: number;
  rpcUrls?: readonly string[];
}

// ERC-4626 vaults that should be priced from `convertToAssets(1 share)` * parent.price.
// Each entry must have a single tracked parent that already prices through normal consensus.
const ERC4626_NAV_VAULTS: readonly Erc4626NavVaultConfig[] = [
  {
    id: "susdt-spark",
    parentId: USDT_TETHER_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xe2e7a17dff93280dec073c995595155283e3c372",
    vaultDecimals: 6,
    assetDecimals: 6,
  },
  {
    id: "susdc-spark",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d",
    vaultDecimals: 6,
    assetDecimals: 6,
  },
  {
    id: "steakusdt-steakhouse",
    parentId: USDT_TETHER_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xbeef003c68896c7d2c3c60d363e8d71a49ab2bf9",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "steakusdc-steakhouse",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xbeef088055857739c12cd3765f20b7679def0f51",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "srusde-strata",
    parentId: USDE_ETHENA_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "gtusdc-gauntlet",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xdd0f28e19c1780eb6396170735d45153d261490d",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "gtusdcp-gauntlet",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x8c106eedad96553e64287a5a6839c3cc78afa3d0",
    vaultDecimals: 18,
    assetDecimals: 6,
  },
  {
    id: "yvusdc-yearn",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xbe53a109b494e5c9f97b9cd39fe969be68bf6204",
    vaultDecimals: 6,
    assetDecimals: 6,
  },
  {
    id: "savusd-avant",
    parentId: AVUSD_AVANT_ID,
    chain: "avalanche",
    vault: "0x06d47f3fb376649c3a9dafe069b3d6e35572219e",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "susn-noon",
    parentId: USN_NOON_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0xe24a3dc889621612422a64e6388927901608b91d",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "syzusd-yuzu",
    parentId: YZUSD_YUZU_ID,
    chain: "plasma",
    vault: "0xc8a8df9b210243c55d31c73090f06787ad0a1bf6",
    vaultDecimals: 18,
    assetDecimals: 18,
    rpcUrls: ["https://rpc.plasma.to"],
  },
  {
    id: "stkgho-umbrella-aave",
    parentId: GHO_AAVE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x4f827a63755855cdf3e8f3bcd20265c833f15033",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "sbold-k3-capital",
    parentId: "bold-liquity",
    chain: ETHEREUM_CHAIN,
    vault: "0x50bd66d59911f5e086ec87ae43c811e0d059dd11",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
  {
    id: "ybold-yearn",
    parentId: "bold-liquity",
    chain: ETHEREUM_CHAIN,
    vault: "0x9f4330700a36b29952869fac9b33f45eedd8a3d8",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
];

const ERC4626_NAV_VAULTS_BY_ID = new Map<string, Erc4626NavVaultConfig>(
  ERC4626_NAV_VAULTS.map((entry) => [entry.id, entry]),
);

const PREVIEW_REDEEM_VAULTS: readonly Erc4626NavVaultConfig[] = [
  {
    id: "sgho-aave",
    parentId: GHO_AAVE_ID,
    chain: ETHEREUM_CHAIN,
    vault: "0x1a88df1cfe15af22b3c4c783d4e6f7f9e0c1885d",
    vaultDecimals: 18,
    assetDecimals: 18,
  },
];

const PREVIEW_REDEEM_VAULTS_BY_ID = new Map<string, Erc4626NavVaultConfig>(
  PREVIEW_REDEEM_VAULTS.map((entry) => [entry.id, entry]),
);

interface IdleCdoTrancheConfig {
  id: string;
  parentId: string;
  chain: string;
  cdo: string;
  tranche: string;
  assetDecimals: number;
}

// Idle Perpetual Yield Tranches priced from `virtualPrice(address tranche)`
// on the CDO contract. The returned amount is denominated in the underlying
// asset's decimals, so the published price multiplies it by the tracked
// parent's live USD price.
const IDLE_CDO_TRANCHES: readonly IdleCdoTrancheConfig[] = [
  {
    id: "aa-falconx-mev-capital",
    parentId: USDC_CIRCLE_ID,
    chain: ETHEREUM_CHAIN,
    cdo: "0x433d5b175148da32ffe1e1a37a939e1b7e79be4d",
    tranche: "0xc26a6fa2c37b38e549a4a1807543801db684f99c",
    assetDecimals: 6,
  },
];

const IDLE_CDO_TRANCHES_BY_ID = new Map<string, IdleCdoTrancheConfig>(
  IDLE_CDO_TRANCHES.map((entry) => [entry.id, entry]),
);

export interface CurrentPriceOverride {
  price: number;
  source: string;
  confidence: PriceConfidence;
  observedAt?: number | null;
  observedAtMode?: PriceObservedAtMode | null;
  metadata?: {
    inheritedFrom?: string;
    parentSource?: string | null;
    parentConfidence?: PriceConfidence | null;
    parentObservedAt?: number | null;
    parentObservedAtMode?: PriceObservedAtMode | null;
    parentReplaySafe?: boolean;
  };
}

export interface HistoricalPricePoint {
  timestamp: number;
  price: number;
}

export interface HistoricalSupplySnapshot {
  ts: number;
  supply: number;
}

export interface HistoricalPriceContext {
  candidateTimestamps: number[];
  supplySnapshots?: HistoricalSupplySnapshot[];
  signal?: AbortSignal;
  coingeckoApiKey?: string | null;
}

export interface HistoricalPriceResolution {
  matched: boolean;
  source: string | null;
  prices: HistoricalPricePoint[] | null;
}

interface LivePriceContext {
  assetsById: Map<string, PeggedAsset>;
  validationReferences?: PriceValidationReferences;
}

interface PriceSourceProvider {
  source: string;
  matches(stablecoinId: string): boolean;
  matchesHistoricalPrices?(stablecoinId: string): boolean;
  fetchLivePrice?(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null>;
  fetchHistoricalPrices?(meta: StablecoinMeta, context: HistoricalPriceContext): Promise<HistoricalPricePoint[] | null>;
}

type HistoricalBlockPriceResolver = (
  blockNumber: number,
  timestamp: number,
  signal?: AbortSignal,
) => Promise<number | null>;

function encodeAddress(address: string): string {
  return address.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

function encodeUint256(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function decodeUint256WordBigInt(result: `0x${string}`, wordIndex = 0): bigint | null {
  const start = 2 + wordIndex * 64;
  const end = start + 64;
  if (result.length < end) return null;

  try {
    return BigInt(`0x${result.slice(start, end)}`);
  } catch (err) {
    console.warn("[price-sources] hex parse ignored:", err);
    return null;
  }
}

function ratioToNumber(
  outputAmount: bigint,
  outputDecimals: number,
  inputAmount: bigint,
  inputDecimals: number,
  precision = 8,
): number {
  if (inputAmount <= 0n) return Number.NaN;

  const scale = 10n ** BigInt(precision);
  const numerator = outputAmount * 10n ** BigInt(inputDecimals) * scale;
  const denominator = inputAmount * 10n ** BigInt(outputDecimals);
  if (denominator <= 0n) return Number.NaN;

  return Number(numerator / denominator) / 10 ** precision;
}

function clampSampleNotionalUsd(supplyUsd: number | null): number {
  const scaled =
    supplyUsd != null && Number.isFinite(supplyUsd) && supplyUsd > 0
      ? supplyUsd * CAP_SAMPLE_SUPPLY_FRACTION
      : CAP_SAMPLE_NOTIONAL_MAX_USD;

  return Math.max(CAP_SAMPLE_NOTIONAL_MIN_USD, Math.min(CAP_SAMPLE_NOTIONAL_MAX_USD, scaled));
}

function getFinitePositivePrice(asset: Pick<PeggedAsset, "price"> | undefined): number | null {
  const price = asset?.price;
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}

function getInheritedTrackedPriceConfig(stablecoinId: string): InheritedTrackedPriceConfig | null {
  return INHERITED_TRACKED_PRICE_CONFIGS[
    stablecoinId as keyof typeof INHERITED_TRACKED_PRICE_CONFIGS
  ] ?? null;
}

function isExplicitAuthoritativeParent(asset: PeggedAsset): boolean {
  return asset.priceSource === PROTOCOL_REDEEM_SOURCE &&
    asset.priceConfidence !== "fallback" &&
    asset.priceConfidence !== "low" &&
    asset.priceConfidence != null;
}

function normalizeFreshSyncedAt(value: number | null | undefined, nowSec: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const syncedAt = Math.floor(value);
  if (syncedAt > nowSec + 60) return null;
  return nowSec - syncedAt <= INHERITED_PARENT_SYNC_MAX_AGE_SEC ? syncedAt : null;
}

function resolveTrustedInheritedParent(asset: PeggedAsset, nowSec: number): {
  price: number;
  observedAt: number;
  observedAtMode: PriceObservedAtMode | null;
  replaySafe: boolean;
} | null {
  const price = getFinitePositivePrice(asset);
  if (price == null) return null;

  const parentSource = asset.priceSource ?? null;
  const parentConfidence = asset.priceConfidence ?? null;
  if (!parentSource) return null;

  const confidenceTrusted = parentConfidence === "high" || isExplicitAuthoritativeParent(asset);
  if (!confidenceTrusted) return null;

  const replaySafe = isReplaySafePriceSource(parentSource);
  if (!replaySafe) return null;

  const observedAt = asset.priceObservedAt ?? asset.priceUpdatedAt ?? null;
  const observedAtMode = asset.priceObservedAtMode ?? null;
  const freshness = validateCompositePricingSourceFreshness({
    source: parentSource,
    observedAt,
    observedAtMode,
    nowSec,
    requireObservedAt: true,
  });
  if (!freshness.accepted || freshness.observedAt == null) {
    const syncedAt = normalizeFreshSyncedAt(asset.priceSyncedAt, nowSec);
    if (
      freshness.accepted === false &&
      freshness.reason === "stale_observed_at" &&
      syncedAt != null &&
      splitCompositePriceSource(parentSource).length > 1
    ) {
      return {
        price,
        observedAt: syncedAt,
        observedAtMode: "local_fetch",
        replaySafe,
      };
    }
    return null;
  }

  return {
    price,
    observedAt: freshness.observedAt,
    observedAtMode: freshness.observedAtMode,
    replaySafe,
  };
}

interface TrustedOverrideParent {
  parentId: string;
  parentAsset: PeggedAsset;
  trustedParent: {
    price: number;
    observedAt: number;
    observedAtMode: PriceObservedAtMode | null;
    replaySafe: boolean;
  };
}

function resolveTrustedOverrideParent(
  context: LivePriceContext,
  parentId: string,
  untrustedParentMessage: () => string,
): TrustedOverrideParent | null {
  const parentAsset = context.assetsById.get(parentId);
  if (!parentAsset) return null;

  const trustedParent = resolveTrustedInheritedParent(parentAsset, Math.floor(Date.now() / 1000));
  if (!trustedParent) {
    console.warn(untrustedParentMessage());
    return null;
  }

  return {
    parentId,
    parentAsset,
    trustedParent,
  };
}

function buildParentDerivedLiveOverride(
  parent: TrustedOverrideParent,
  parentPriceMultiplier: number,
): CurrentPriceOverride | null {
  const price = parent.trustedParent.price * parentPriceMultiplier;
  if (!Number.isFinite(price) || price <= 0) return null;

  const parentObservedAt = parent.parentAsset.priceObservedAt ?? parent.parentAsset.priceUpdatedAt ?? null;
  return {
    price,
    source: PROTOCOL_REDEEM_SOURCE,
    confidence: "high",
    observedAt: parent.trustedParent.observedAt,
    observedAtMode: parent.trustedParent.observedAtMode,
    metadata: {
      inheritedFrom: parent.parentId,
      parentSource: parent.parentAsset.priceSource ?? null,
      parentConfidence: parent.parentAsset.priceConfidence ?? null,
      parentObservedAt,
      parentObservedAtMode: parent.parentAsset.priceObservedAtMode ?? null,
      parentReplaySafe: parent.trustedParent.replaySafe,
    },
  };
}

function findNearestSupply(snapshots: HistoricalSupplySnapshot[] | undefined, timestamp: number): number | null {
  if (!snapshots || snapshots.length === 0) return null;
  const nearest = binarySearchNearest(snapshots, timestamp, (s) => s.ts);
  return nearest?.supply ?? null;
}

function getContractConfig(stablecoinId: string): {
  contract: string;
  contractDecimals: number;
  quoteContract: string;
  quoteDecimals: number;
} | null {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  const quoteMeta = TRACKED_META_BY_ID.get(USDC_CIRCLE_ID);
  if (!meta || !quoteMeta) return null;

  const contract = meta.contracts?.find((entry) => entry.chain === ETHEREUM_CHAIN);
  const quoteContract = quoteMeta.contracts?.find((entry) => entry.chain === ETHEREUM_CHAIN);
  if (!contract || !quoteContract) return null;

  return {
    contract: contract.address,
    contractDecimals: contract.decimals,
    quoteContract: quoteContract.address,
    quoteDecimals: quoteContract.decimals,
  };
}

function normalizeHistoricalTimestamps(candidateTimestamps: number[]): number[] {
  return Array.from(
    new Set(candidateTimestamps.filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0)),
  ).sort((a, b) => a - b);
}

async function collectHistoricalBlockPrices(
  context: HistoricalPriceContext,
  resolvePrice: HistoricalBlockPriceResolver,
): Promise<HistoricalPricePoint[] | null> {
  const requestedTimestamps = normalizeHistoricalTimestamps(context.candidateTimestamps);
  if (requestedTimestamps.length === 0) return null;

  const blockSearchCache: EvmBlockSearchCache = {
    blockTimestampByNumber: new Map(),
  };
  const quoteByBlock = new Map<number, number>();
  const prices: HistoricalPricePoint[] = [];

  for (const timestamp of requestedTimestamps) {
    const blockNumber = await resolveClosestBlockAtOrBeforeTimestamp(ETHEREUM_CHAIN, timestamp, blockSearchCache, {
      signal: context.signal,
      extraRpcUrls: getArchiveFallbackRpcUrls(ETHEREUM_CHAIN),
      timeoutMs: 15_000,
    });
    if (blockNumber == null) continue;

    let price = quoteByBlock.get(blockNumber) ?? null;
    if (price == null) {
      price = await resolvePrice(blockNumber, timestamp, context.signal);
      if (price == null) continue;
      quoteByBlock.set(blockNumber, price);
    }

    prices.push({ timestamp, price });
  }

  if (prices.length === 0) return null;
  if (prices.length / requestedTimestamps.length < CAP_HISTORICAL_MIN_COVERAGE) {
    return null;
  }

  return prices;
}

async function fetchCapRedeemQuote(
  sampleNotionalUsd: number,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
): Promise<number | null> {
  const config = getContractConfig(CAP_CUSD_ID);
  if (!config) return null;

  const sampleInputAmount = BigInt(Math.round(sampleNotionalUsd)) * 10n ** BigInt(config.contractDecimals);
  if (sampleInputAmount <= 0n) return null;

  const calldata = `${CAP_GET_BURN_AMOUNT_SELECTOR}${encodeAddress(config.quoteContract)}${encodeUint256(sampleInputAmount)}`;
  const quoteHex = await fetchEvmCallHexAtBlock(ETHEREUM_CHAIN, config.contract, calldata, blockNumberOrTag, {
    signal,
    extraRpcUrls: getArchiveFallbackRpcUrls(ETHEREUM_CHAIN),
  });
  if (!quoteHex) {
    console.warn(`[authoritative-price-sources] cusd-cap: RPC returned null`);
    return null;
  }

  const outputAmount = decodeUint256WordBigInt(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    console.warn(`[authoritative-price-sources] cusd-cap: contract returned zero or invalid output`);
    return null;
  }

  const price = ratioToNumber(outputAmount, config.quoteDecimals, sampleInputAmount, config.contractDecimals);
  return Number.isFinite(price) && price > 0 ? price : null;
}

const capCusdProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return stablecoinId === CAP_CUSD_ID;
  },
  async fetchLivePrice(asset: PeggedAsset, _context: LivePriceContext, signal?: AbortSignal): Promise<CurrentPriceOverride | null> {
    const sampleNotionalUsd = clampSampleNotionalUsd(sumPegBuckets(asset.circulating));
    const price = await fetchCapRedeemQuote(sampleNotionalUsd, "latest", signal);
    if (price == null) return null;

    return {
      price,
      source: PROTOCOL_REDEEM_SOURCE,
      confidence: "high",
    };
  },
  async fetchHistoricalPrices(
    _meta: StablecoinMeta,
    context: HistoricalPriceContext,
  ): Promise<HistoricalPricePoint[] | null> {
    return collectHistoricalBlockPrices(context, async (blockNumber, timestamp, signal) => {
      const supplyUsd = findNearestSupply(context.supplySnapshots, timestamp);
      const sampleNotionalUsd = clampSampleNotionalUsd(supplyUsd);
      return fetchCapRedeemQuote(sampleNotionalUsd, blockNumber, signal);
    });
  },
};

async function fetchInfiniFiRedeemQuote(
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
): Promise<number | null> {
  const config = getContractConfig(IUSD_INFINIFI_ID);
  if (!config) return null;

  const inputAmount = 10n ** BigInt(config.contractDecimals);
  const quoteHex = await fetchEvmCallHexAtBlock(
    ETHEREUM_CHAIN,
    IUSD_INFINIFI_REDEEM_CONTROLLER,
    `${IUSD_RECEIPT_TO_ASSET_SELECTOR}${encodeUint256(inputAmount)}`,
    blockNumberOrTag,
    {
      signal,
      extraRpcUrls: getArchiveFallbackRpcUrls(ETHEREUM_CHAIN),
    },
  );
  if (!quoteHex) {
    console.warn(`[authoritative-price-sources] iusd-infinifi: RPC returned null`);
    return null;
  }

  const outputAmount = decodeUint256WordBigInt(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    console.warn(`[authoritative-price-sources] iusd-infinifi: contract returned zero or invalid output`);
    return null;
  }

  const price = ratioToNumber(outputAmount, config.quoteDecimals, inputAmount, config.contractDecimals);
  return Number.isFinite(price) && price > 0 ? price : null;
}

const iusdInfinifiProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return stablecoinId === IUSD_INFINIFI_ID;
  },
  async fetchLivePrice(
    _asset: PeggedAsset,
    _context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    const price = await fetchInfiniFiRedeemQuote("latest", signal);
    if (price == null) return null;

    return {
      price,
      source: PROTOCOL_REDEEM_SOURCE,
      confidence: "high",
    };
  },
  async fetchHistoricalPrices(
    _meta: StablecoinMeta,
    context: HistoricalPriceContext,
  ): Promise<HistoricalPricePoint[] | null> {
    return collectHistoricalBlockPrices(
      context,
      (blockNumber, _timestamp, signal) => fetchInfiniFiRedeemQuote(blockNumber, signal),
    );
  },
};

async function replayInheritedTrackedPriceSeries(
  config: InheritedTrackedPriceConfig,
  context: HistoricalPriceContext,
): Promise<HistoricalPricePoint[] | null> {
  const parentMeta = TRACKED_META_BY_ID.get(config.parentId);
  if (!parentMeta?.geckoId) return null;

  const series = await fetchMarketBackfillPriceSeries(parentMeta, parentMeta.geckoId, {
    granularity: "hourly",
    coingeckoApiKey: context.coingeckoApiKey ?? null,
  });
  if (!series.prices) return null;

  const multiplier = config.multiplier ?? 1;
  return multiplier === 1
    ? series.prices
    : series.prices.map((point) => ({ ...point, price: point.price * multiplier }));
}

const inheritedTrackedPriceProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return getInheritedTrackedPriceConfig(stablecoinId) != null;
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
  ): Promise<CurrentPriceOverride | null> {
    const config = getInheritedTrackedPriceConfig(asset.id);
    if (!config) return null;

    const parent = resolveTrustedOverrideParent(
      context,
      config.parentId,
      () =>
        `[authoritative-price-sources] ${asset.id}: skipped inherited ${config.parentId} price because parent provenance is not trusted`,
    );
    if (!parent) return null;

    return buildParentDerivedLiveOverride(parent, config.multiplier ?? 1);
  },
  async fetchHistoricalPrices(
    meta: StablecoinMeta,
    context: HistoricalPriceContext,
  ): Promise<HistoricalPricePoint[] | null> {
    const config = getInheritedTrackedPriceConfig(meta.id);
    if (!config) return null;

    return replayInheritedTrackedPriceSeries(config, context);
  },
};

function getReferenceType(
  references: PriceValidationReferences | undefined,
  pegType: string,
): PriceValidationReferences["type"] {
  return references?.typeByPeg?.[pegType] ?? references?.type ?? "none";
}

function getProtocolParPrice(
  config: ProtocolParConfig,
  references: PriceValidationReferences | undefined,
): { price: number; observedAt: number | null; observedAtMode: PriceObservedAtMode } | null {
  const multiplier = 1 - ((config.feeBps ?? 0) / BASIS_POINTS_DENOMINATOR);
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1) return null;

  if (config.pegType === "peggedUSD") {
    return {
      price: multiplier,
      observedAt: null,
      observedAtMode: "local_fetch",
    };
  }

  const referenceType = getReferenceType(references, config.pegType);
  if (referenceType !== "fresh" && referenceType !== "static") return null;

  const rate = references?.rates[config.pegType];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;

  return {
    price: rate * multiplier,
    observedAt: references?.updatedAtByPeg?.[config.pegType] ?? references?.updatedAt ?? null,
    observedAtMode: referenceType === "fresh" ? "upstream" : "local_fetch",
  };
}

const protocolParProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return PROTOCOL_PAR_PRICE_CONFIGS_BY_ID.has(stablecoinId);
  },
  matchesHistoricalPrices(stablecoinId: string): boolean {
    return PROTOCOL_PAR_PRICE_CONFIGS_BY_ID.get(stablecoinId)?.pegType === "peggedUSD";
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
  ): Promise<CurrentPriceOverride | null> {
    const config = PROTOCOL_PAR_PRICE_CONFIGS_BY_ID.get(asset.id);
    if (!config) return null;

    const resolved = getProtocolParPrice(config, context.validationReferences);
    if (!resolved) return null;

    return {
      price: resolved.price,
      source: PROTOCOL_REDEEM_SOURCE,
      confidence: "high",
      observedAt: resolved.observedAt,
      observedAtMode: resolved.observedAtMode,
    };
  },
  async fetchHistoricalPrices(
    meta: StablecoinMeta,
    context: HistoricalPriceContext,
  ): Promise<HistoricalPricePoint[] | null> {
    const config = PROTOCOL_PAR_PRICE_CONFIGS_BY_ID.get(meta.id);
    if (!config || config.pegType !== "peggedUSD") return null;

    const multiplier = 1 - ((config.feeBps ?? 0) / BASIS_POINTS_DENOMINATOR);
    const timestamps = normalizeHistoricalTimestamps(context.candidateTimestamps);
    return timestamps.map((timestamp) => ({ timestamp, price: multiplier }));
  },
};

async function fetchErc4626AssetsPerShare(
  config: Erc4626NavVaultConfig,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
): Promise<number | null> {
  const oneShareRaw = 10n ** BigInt(config.vaultDecimals);
  const calldata = `${ERC4626_CONVERT_TO_ASSETS_SELECTOR}${encodeUint256(oneShareRaw)}`;
  const quoteHex = await fetchEvmCallHexAtBlock(config.chain, config.vault, calldata, blockNumberOrTag, {
    signal,
    extraRpcUrls: [...(config.rpcUrls ?? getArchiveFallbackRpcUrls(config.chain))],
  });
  if (!quoteHex) {
    console.warn(`[authoritative-price-sources] ${config.id}: convertToAssets() returned null`);
    return null;
  }
  const outputAmount = decodeUint256WordBigInt(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    console.warn(`[authoritative-price-sources] ${config.id}: convertToAssets() returned zero or invalid output`);
    return null;
  }
  const assetsPerShare = ratioToNumber(outputAmount, config.assetDecimals, oneShareRaw, config.vaultDecimals);
  if (!Number.isFinite(assetsPerShare) || assetsPerShare <= 0) return null;
  if (assetsPerShare < ERC4626_NAV_MIN_RATIO || assetsPerShare > ERC4626_NAV_MAX_RATIO) {
    console.warn(
      `[authoritative-price-sources] ${config.id}: convertToAssets() ratio ${assetsPerShare} outside trusted bounds`,
    );
    return null;
  }
  return assetsPerShare;
}

const erc4626NavProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return ERC4626_NAV_VAULTS_BY_ID.has(stablecoinId);
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    const config = ERC4626_NAV_VAULTS_BY_ID.get(asset.id);
    if (!config) return null;

    const parent = resolveTrustedOverrideParent(
      context,
      config.parentId,
      () =>
        `[authoritative-price-sources] ${asset.id}: skipped ERC-4626 NAV price because parent ${config.parentId} provenance is not trusted`,
    );
    if (!parent) return null;

    const assetsPerShare = await fetchErc4626AssetsPerShare(config, "latest", signal);
    if (assetsPerShare == null) return null;

    return buildParentDerivedLiveOverride(parent, assetsPerShare);
  },
};

async function fetchPreviewRedeemAssetsPerShare(
  config: Erc4626NavVaultConfig,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
): Promise<number | null> {
  const oneShareRaw = 10n ** BigInt(config.vaultDecimals);
  const calldata = `${PREVIEW_REDEEM_SELECTOR}${encodeUint256(oneShareRaw)}`;
  const quoteHex = await fetchEvmCallHexAtBlock(config.chain, config.vault, calldata, blockNumberOrTag, {
    signal,
    extraRpcUrls: [...(config.rpcUrls ?? getArchiveFallbackRpcUrls(config.chain))],
  });
  if (!quoteHex) {
    console.warn(`[authoritative-price-sources] ${config.id}: previewRedeem() returned null`);
    return null;
  }
  const outputAmount = decodeUint256WordBigInt(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    console.warn(`[authoritative-price-sources] ${config.id}: previewRedeem() returned zero or invalid output`);
    return null;
  }
  const assetsPerShare = ratioToNumber(outputAmount, config.assetDecimals, oneShareRaw, config.vaultDecimals);
  if (!Number.isFinite(assetsPerShare) || assetsPerShare <= 0) return null;
  if (assetsPerShare < ERC4626_NAV_MIN_RATIO || assetsPerShare > ERC4626_NAV_MAX_RATIO) {
    console.warn(
      `[authoritative-price-sources] ${config.id}: previewRedeem() ratio ${assetsPerShare} outside trusted bounds`,
    );
    return null;
  }
  return assetsPerShare;
}

const previewRedeemProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return PREVIEW_REDEEM_VAULTS_BY_ID.has(stablecoinId);
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    const config = PREVIEW_REDEEM_VAULTS_BY_ID.get(asset.id);
    if (!config) return null;

    const parent = resolveTrustedOverrideParent(
      context,
      config.parentId,
      () =>
        `[authoritative-price-sources] ${asset.id}: skipped previewRedeem price because parent ${config.parentId} provenance is not trusted`,
    );
    if (!parent) return null;

    const assetsPerShare = await fetchPreviewRedeemAssetsPerShare(config, "latest", signal);
    if (assetsPerShare == null) return null;

    return buildParentDerivedLiveOverride(parent, assetsPerShare);
  },
};

async function fetchIdleCdoTrancheAssetsPerShare(
  config: IdleCdoTrancheConfig,
  blockNumberOrTag: number | "latest",
  signal?: AbortSignal,
): Promise<number | null> {
  const calldata = `${IDLE_CDO_VIRTUAL_PRICE_SELECTOR}${encodeAddress(config.tranche)}`;
  const quoteHex = await fetchEvmCallHexAtBlock(config.chain, config.cdo, calldata, blockNumberOrTag, {
    signal,
    extraRpcUrls: getArchiveFallbackRpcUrls(config.chain),
  });
  if (!quoteHex) {
    console.warn(`[authoritative-price-sources] ${config.id}: virtualPrice() returned null`);
    return null;
  }
  const outputAmount = decodeUint256WordBigInt(quoteHex, 0);
  if (outputAmount == null || outputAmount <= 0n) {
    console.warn(`[authoritative-price-sources] ${config.id}: virtualPrice() returned zero or invalid output`);
    return null;
  }
  const assetsPerShare = Number(outputAmount) / 10 ** config.assetDecimals;
  if (!Number.isFinite(assetsPerShare) || assetsPerShare <= 0) return null;
  if (assetsPerShare < ERC4626_NAV_MIN_RATIO || assetsPerShare > ERC4626_NAV_MAX_RATIO) {
    console.warn(
      `[authoritative-price-sources] ${config.id}: virtualPrice() ratio ${assetsPerShare} outside trusted bounds`,
    );
    return null;
  }
  return assetsPerShare;
}

const idleCdoTrancheProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return IDLE_CDO_TRANCHES_BY_ID.has(stablecoinId);
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    const config = IDLE_CDO_TRANCHES_BY_ID.get(asset.id);
    if (!config) return null;

    const parent = resolveTrustedOverrideParent(
      context,
      config.parentId,
      () =>
        `[authoritative-price-sources] ${asset.id}: skipped Idle CDO virtualPrice because parent ${config.parentId} provenance is not trusted`,
    );
    if (!parent) return null;

    const assetsPerShare = await fetchIdleCdoTrancheAssetsPerShare(config, "latest", signal);
    if (assetsPerShare == null) return null;

    return buildParentDerivedLiveOverride(parent, assetsPerShare);
  },
};

const AUTHORITATIVE_PRICE_PROVIDERS: PriceSourceProvider[] = [
  capCusdProvider,
  iusdInfinifiProvider,
  inheritedTrackedPriceProvider,
  protocolParProvider,
  erc4626NavProvider,
  previewRedeemProvider,
  idleCdoTrancheProvider,
];

export async function fetchAuthoritativeLivePriceOverrides(
  assets: PeggedAsset[],
  signal?: AbortSignal,
  validationReferences?: PriceValidationReferences,
): Promise<Map<string, CurrentPriceOverride>> {
  const results = new Map<string, CurrentPriceOverride>();
  const liveContext: LivePriceContext = {
    assetsById: new Map(assets.map((asset) => [asset.id, asset])),
    validationReferences,
  };

  for (const asset of assets) {
    const provider = AUTHORITATIVE_PRICE_PROVIDERS.find((candidate) => candidate.matches(asset.id));
    if (!provider?.fetchLivePrice) continue;

    try {
      const override = await provider.fetchLivePrice(asset, liveContext, signal);
      if (override) {
        results.set(asset.id, override);
      }
    } catch (error) {
      rethrowIfAborted(error, signal);
      console.warn(`[authoritative-price-sources] ${asset.id} live override failed:`, error);
    }
  }

  return results;
}

export async function fetchAuthoritativeHistoricalPriceSeries(
  meta: StablecoinMeta,
  context: HistoricalPriceContext,
): Promise<HistoricalPriceResolution> {
  const provider = AUTHORITATIVE_PRICE_PROVIDERS.find((candidate) =>
    candidate.matches(meta.id) && (candidate.matchesHistoricalPrices?.(meta.id) ?? true)
  );
  if (!provider?.fetchHistoricalPrices) {
    return { matched: false, source: null, prices: null };
  }

  try {
    const prices = await provider.fetchHistoricalPrices(meta, context);
    return {
      matched: true,
      source: provider.source,
      prices,
    };
  } catch (error) {
    rethrowIfAborted(error, context.signal);
    console.warn(`[authoritative-price-sources] ${meta.id} historical source failed:`, error);
    return {
      matched: true,
      source: provider.source,
      prices: null,
    };
  }
}
