import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveInput, LiveReserveRpcMode, LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchErc20Balance,
  fetchJsonWithRetry,
  normalizeSlices,
  requireJsonInput,
  reserveDegradedWarning,
  unverifiedFreshnessMetadata,
  valueUsdFromBigIntPrice,
} from "./helpers";

interface PositionDetailsEntry {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  positions: Array<{
    closed?: boolean;
    denied?: boolean;
    collateralBalance?: string;
  }>;
}

type PositionDetailsPayload = Record<string, PositionDetailsEntry>;
type PriceMappingPayload = Record<string, { price?: { usd?: number; eur?: number } }>;

interface PositionsApiParams {
  pricesUrl: string;
  otherThresholdPct?: number;
  redemptionBridge?: {
    chain: string;
    rpcMode: LiveReserveRpcMode;
    holder: string;
    tokenAddress: string;
    tokenDecimals: number;
    priceAddress?: string;
    rpcUrl?: string;
    fallbackRpcUrl?: string;
  };
}

interface ProtocolAssetConfig {
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}

function readParams(config: LiveReservesConfig): PositionsApiParams {
  return parseLiveReserveAdapterParams("collateral-positions-api", config.params);
}

/**
 * Protocol-specific assets used as collateral in Frankencoin / dEURO
 * that are too niche for the canonical risk map.
 */
const PROTOCOL_ASSET_CONFIG: Record<string, ProtocolAssetConfig> = {
  // Governance / participation shares
  FPS: { risk: "very-high" },
  WFPS: { risk: "very-high" },
  BOSS: { risk: "very-high" },
  // Stablecoins not in canonical map
  VCHF: { risk: "low" },
  YSYBOLD: { risk: "medium", coinId: "bold-liquity", depType: "wrapper" },
  // Wrapped BTC variants
  BBTC: { risk: "medium" },
  // Tokenized equities / RWA
  AAPLX: { risk: "high" },
  SPYON: { risk: "high" },
  GOOGLX: { risk: "high" },
  NVDAX: { risk: "high" },
  TSLAX: { risk: "high" },
  LENDS: { risk: "high" },
  REALU: { risk: "high" },
  DQTS: { risk: "high" },
  ESC: { risk: "high" },
};

function getProtocolAssetConfig(symbol: string): ProtocolAssetConfig | null {
  return PROTOCOL_ASSET_CONFIG[symbol.toUpperCase()] ?? null;
}

function isKnownAsset(symbol: string): boolean {
  return getCanonicalReserveAssetRisk(symbol) !== null || getProtocolAssetConfig(symbol) !== null;
}

function inferRisk(symbol: string): ReserveSlice["risk"] {
  const canonicalRisk = getCanonicalReserveAssetRisk(symbol);
  if (canonicalRisk) return canonicalRisk;
  const protocolConfig = getProtocolAssetConfig(symbol);
  if (protocolConfig) return protocolConfig.risk;
  return "high";
}

function inferCoinId(symbol: string): string | undefined {
  const protocolCoinId = getProtocolAssetConfig(symbol)?.coinId;
  if (protocolCoinId) return protocolCoinId;
  const upper = symbol.toUpperCase();
  switch (upper) {
    case "USDC":
      return "usdc-circle";
    case "DAI":
      return "dai-makerdao";
    case "LUSD":
      return "lusd-liquity";
    case "ZCHF":
      return "zchf-frankencoin";
    default:
      return undefined;
  }
}

function inferDepType(symbol: string): ReserveSlice["depType"] | undefined {
  return getProtocolAssetConfig(symbol)?.depType;
}

export function adaptCollateralPositions(
  details: PositionDetailsPayload,
  prices: PriceMappingPayload,
  otherThresholdPct = 2,
  immediateRedeemableUsd?: number | null,
): AdapterResult {
  const warnings: LiveReserveWarning[] = [];
  const values: Array<{
    name: string;
    usd: number;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
  }> = [];
  const missingPriceSymbols = new Set<string>();
  let unknownExposureUsd = 0;
  let activePositionCount = 0;

  for (const entry of Object.values(details)) {
    const totalBalance = entry.positions.reduce((acc, position) => {
      if (position.closed || position.denied) return acc;
      const raw = Number(position.collateralBalance ?? "0");
      return Number.isFinite(raw) && raw > 0 ? acc + raw / (10 ** entry.decimals) : acc;
    }, 0);

    if (totalBalance <= 0) continue;
    activePositionCount += entry.positions.filter((position) => {
      if (position.closed || position.denied) return false;
      const raw = Number(position.collateralBalance ?? "0");
      return Number.isFinite(raw) && raw > 0;
    }).length;

    const priceInfo = prices[entry.address.toLowerCase()];
    const usdPrice = priceInfo?.price?.usd;
    if (typeof usdPrice !== "number" || usdPrice <= 0) {
      missingPriceSymbols.add(entry.symbol);
      continue;
    }

    const risk = inferRisk(entry.symbol);
    if (!isKnownAsset(entry.symbol)) {
      warnings.push(reserveDegradedWarning(
        "unknown-asset",
        `Unmapped collateral symbol: ${entry.symbol} (inferred risk: ${risk})`,
      ));
      unknownExposureUsd += totalBalance * usdPrice;
    }

    values.push({
      name: `${entry.symbol}${entry.name && entry.name !== entry.symbol ? ` (${entry.name})` : ""}`,
      usd: totalBalance * usdPrice,
      risk,
      coinId: inferCoinId(entry.symbol),
      depType: inferDepType(entry.symbol),
    });
  }

  if (missingPriceSymbols.size > 0) {
    throw new Error(
      `collateral-positions-api missing USD price(s) for active collateral: ${Array.from(missingPriceSymbols).join(", ")}`,
    );
  }

  const total = values.reduce((acc, value) => acc + value.usd, 0);
  if (total <= 0) return { slices: [] };

  const major = values.filter((value) => (value.usd / total) * 100 >= otherThresholdPct);
  const minor = values.filter((value) => (value.usd / total) * 100 < otherThresholdPct);

  const slices = major.map((value) => ({
    name: value.name,
    pct: (value.usd / total) * 100,
    risk: value.risk,
    ...(value.coinId ? { coinId: value.coinId } : {}),
    ...(value.depType ? { depType: value.depType } : {}),
  }));

  if (minor.length > 0) {
    const otherUsd = minor.reduce((acc, value) => acc + value.usd, 0);
    const highestRisk = minor.some((value) => value.risk === "very-high")
      ? "very-high"
      : minor.some((value) => value.risk === "high")
        ? "high"
        : "medium";
    slices.push({
      name: "Other collateral",
      pct: (otherUsd / total) * 100,
      risk: highestRisk,
    });
  }

  return {
    slices: normalizeSlices(slices),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      assetCount: values.length,
      collateralAssetCount: Object.keys(details).length,
      activePositionCount,
      missingPriceCount: missingPriceSymbols.size,
      unknownAssetCount: warnings.length,
      unknownExposurePct: total > 0 ? (unknownExposureUsd / total) * 100 : 0,
      ...(immediateRedeemableUsd != null ? { immediateRedeemableUsd } : {}),
      ...unverifiedFreshnessMetadata(
        "position-and-price-apis",
        "Collateral positions and price payloads do not expose a trustworthy source timestamp",
      ),
    },
  };
}

async function fetchBridgeImmediateRedeemableUsd(
  bridge: NonNullable<PositionsApiParams["redemptionBridge"]>,
  prices: PriceMappingPayload,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<number | null> {
  const onchainInput: LiveReserveInput = {
    kind: "onchain-evm",
    chain: bridge.chain,
    rpcMode: bridge.rpcMode,
  };

  const balance = await fetchErc20Balance(
    onchainInput,
    bridge.tokenAddress,
    bridge.holder,
    signal,
    ctx,
    bridge.rpcUrl,
    bridge.fallbackRpcUrl,
  );

  if (balance == null) return null;
  if (balance <= 0n) return 0;

  const priceInfo = prices[(bridge.priceAddress ?? bridge.tokenAddress).toLowerCase()];
  const usdPrice = priceInfo?.price?.usd;
  if (typeof usdPrice !== "number" || usdPrice <= 0) return null;

  const usdValue = valueUsdFromBigIntPrice(balance, bridge.tokenDecimals, usdPrice);
  return Number.isFinite(usdValue) && usdValue >= 0 ? usdValue : null;
}

export async function fetchCollateralPositionsApiReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "collateral-positions-api");
  const params = readParams(config);

  const timeout = 12_000;
  const [details, prices] = await Promise.all([
    fetchJsonWithRetry<PositionDetailsPayload>(input.url, signal, timeout, ctx),
    fetchJsonWithRetry<PriceMappingPayload>(params.pricesUrl, signal, timeout, ctx),
  ]);

  const immediateRedeemableUsd = params.redemptionBridge
    ? await fetchBridgeImmediateRedeemableUsd(params.redemptionBridge, prices, signal, ctx)
    : null;

  return adaptCollateralPositions(
    details,
    prices,
    params.otherThresholdPct ?? 2,
    immediateRedeemableUsd,
  );
}
