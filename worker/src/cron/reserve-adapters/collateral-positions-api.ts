import type { LiveReserveWarning, LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterResult } from "./types";
import { fetchJsonWithRetry, getAdapterTimeout, normalizeSlices, requireJsonInput } from "./helpers";

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
}

function readParams(config: LiveReservesConfig): PositionsApiParams {
  const params = (config.params ?? {}) as Partial<PositionsApiParams>;
  if (!params.pricesUrl) {
    throw new Error("collateral-positions-api adapter requires params.pricesUrl");
  }
  return params as PositionsApiParams;
}

/**
 * Protocol-specific assets used as collateral in Frankencoin / dEURO
 * that are too niche for the canonical risk map.
 */
const PROTOCOL_ASSET_RISK: Record<string, ReserveSlice["risk"]> = {
  // Governance / participation shares
  FPS: "very-high",
  WFPS: "very-high",
  BOSS: "very-high",
  // Stablecoins not in canonical map
  VCHF: "low",
  // Wrapped BTC variants
  BBTC: "medium",
  // Tokenized equities / RWA
  AAPLX: "high",
  SPYON: "high",
  GOOGLX: "high",
  NVDAX: "high",
  TSLAX: "high",
  LENDS: "high",
  REALU: "high",
  DQTS: "high",
  ESC: "high",
};

function isKnownAsset(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  return getCanonicalReserveAssetRisk(upper) !== null || upper in PROTOCOL_ASSET_RISK;
}

function inferRisk(symbol: string): ReserveSlice["risk"] {
  const upper = symbol.toUpperCase();
  const canonicalRisk = getCanonicalReserveAssetRisk(upper);
  if (canonicalRisk) return canonicalRisk;
  const protocolRisk = PROTOCOL_ASSET_RISK[upper];
  if (protocolRisk) return protocolRisk;
  return "high";
}

function inferCoinId(symbol: string): string | undefined {
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

export function adaptCollateralPositions(
  details: PositionDetailsPayload,
  prices: PriceMappingPayload,
  otherThresholdPct = 2,
): AdapterResult {
  const warnings: LiveReserveWarning[] = [];
  const values: Array<{ name: string; usd: number; risk: ReserveSlice["risk"]; coinId?: string }> = [];
  const missingPriceSymbols = new Set<string>();

  for (const entry of Object.values(details)) {
    const totalBalance = entry.positions.reduce((acc, position) => {
      if (position.closed || position.denied) return acc;
      const raw = Number(position.collateralBalance ?? "0");
      return Number.isFinite(raw) && raw > 0 ? acc + raw / (10 ** entry.decimals) : acc;
    }, 0);

    if (totalBalance <= 0) continue;

    const priceInfo = prices[entry.address.toLowerCase()];
    const usdPrice = priceInfo?.price?.usd;
    if (typeof usdPrice !== "number" || usdPrice <= 0) {
      missingPriceSymbols.add(entry.symbol);
      continue;
    }

    const risk = inferRisk(entry.symbol);
    if (!isKnownAsset(entry.symbol)) {
      warnings.push({
        code: "unknown-asset",
        message: `Unmapped collateral symbol: ${entry.symbol} (inferred risk: ${risk})`,
        severity: "warning",
      });
    }

    values.push({
      name: `${entry.symbol}${entry.name && entry.name !== entry.symbol ? ` (${entry.name})` : ""}`,
      usd: totalBalance * usdPrice,
      risk,
      coinId: inferCoinId(entry.symbol),
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
  };
}

export async function fetchCollateralPositionsApiReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "collateral-positions-api");
  const params = readParams(config);

  const timeout = getAdapterTimeout(config, 12_000);
  const [details, prices] = await Promise.all([
    fetchJsonWithRetry<PositionDetailsPayload>(input.url, signal, timeout),
    fetchJsonWithRetry<PriceMappingPayload>(params.pricesUrl, signal, timeout),
  ]);

  return adaptCollateralPositions(details, prices, params.otherThresholdPct ?? 2);
}
