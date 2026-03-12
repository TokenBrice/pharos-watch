import type { LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import type { AdapterResult } from "./index";
import { fetchJsonWithRetry, normalizeSlices, requireJsonInput } from "./helpers";

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

function inferRisk(symbol: string): ReserveSlice["risk"] {
  const upper = symbol.toUpperCase();
  if (["USDC", "DAI", "LUSD", "ZCHF", "DEURO", "DEPS"].includes(upper)) return upper === "DEPS" ? "very-high" : "low";
  if (["WBTC", "CBBTC", "KBTC", "TBTC", "BTC", "XAUT", "PAXG"].includes(upper)) return "medium";
  if (["WETH", "ETH", "WSTETH", "LSETH", "STETH", "RETH"].includes(upper)) return upper.includes("WST") || upper.includes("STETH") || upper === "RETH" ? "low" : "medium";
  if (["CRV", "GNO", "UNI"].includes(upper)) return "very-high";
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
): ReserveSlice[] {
  const values: Array<{ name: string; usd: number; risk: ReserveSlice["risk"]; coinId?: string }> = [];

  for (const entry of Object.values(details)) {
    const priceInfo = prices[entry.address.toLowerCase()];
    const usdPrice = priceInfo?.price?.usd ?? priceInfo?.price?.eur;
    if (typeof usdPrice !== "number" || usdPrice <= 0) continue;

    const totalBalance = entry.positions.reduce((acc, position) => {
      if (position.closed || position.denied) return acc;
      const raw = Number(position.collateralBalance ?? "0");
      return Number.isFinite(raw) && raw > 0 ? acc + raw / (10 ** entry.decimals) : acc;
    }, 0);

    if (totalBalance <= 0) continue;

    values.push({
      name: `${entry.symbol}${entry.name && entry.name !== entry.symbol ? ` (${entry.name})` : ""}`,
      usd: totalBalance * usdPrice,
      risk: inferRisk(entry.symbol),
      coinId: inferCoinId(entry.symbol),
    });
  }

  const total = values.reduce((acc, value) => acc + value.usd, 0);
  if (total <= 0) return [];

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

  return normalizeSlices(slices);
}

export async function fetchCollateralPositionsApiReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "collateral-positions-api");
  const params = readParams(config);

  const [details, prices] = await Promise.all([
    fetchJsonWithRetry<PositionDetailsPayload>(input.url, signal),
    fetchJsonWithRetry<PriceMappingPayload>(params.pricesUrl, signal),
  ]);

  return {
    slices: adaptCollateralPositions(details, prices, params.otherThresholdPct ?? 2),
  };
}
