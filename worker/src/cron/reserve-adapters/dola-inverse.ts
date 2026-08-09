import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  accumulateBucketedExposure,
  fetchJsonAdapterInput,
  freshnessMetadataFromTimestamp,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  slicesFromValues,
} from "./helpers";

export interface FirmMarket {
  name: string;
  underlying: { symbol: string };
  totalDebt: number;
  borrowPaused: boolean;
}

interface FirmMarketsResponse {
  markets: FirmMarket[];
  timestamp: number | string;
}

type DolaBucket = "stablecoin" | "eth-lst" | "btc" | "governance" | "other";

const STABLECOIN_ASSETS = new Set(["sUSDe", "sUSDS", "DAI", "USDC", "USDT", "crvUSD", "scrvUSD", "FRAX", "PYUSD", "USR", "wstUSR", "FraxPyUSD lp", "DOLA-FRAXBP"]);
const ETH_LST_ASSETS = new Set(["WETH", "wstETH", "stETH", "rETH", "weETH", "cbETH"]);
const BTC_ASSETS = new Set(["WBTC", "cbBTC", "tBTC"]);
const GOVERNANCE_ASSETS = new Set(["INV", "CRV", "CVX", "cvxCRV", "st-yCRV", "cvxFXS"]);
const TRACKED_STABLECOIN_ASSETS: Partial<Record<string, { coinId: string; risk: ReserveSlice["risk"] }>> = {
  sUSDe: { coinId: "susde-ethena", risk: "high" },
  sUSDS: { coinId: "susds-sky", risk: "low" },
  DAI: { coinId: "dai-makerdao", risk: "low" },
  USDC: { coinId: "usdc-circle", risk: "low" },
  USDT: { coinId: "usdt-tether", risk: "low" },
  crvUSD: { coinId: "crvusd-curve", risk: "medium" },
  scrvUSD: { coinId: "scrvusd-curve", risk: "medium" },
  FRAX: { coinId: "frax-frax", risk: "low" },
  PYUSD: { coinId: "pyusd-paypal", risk: "low" },
  USR: { coinId: "usr-resolv", risk: "high" },
};

function getTrackedStablecoinAsset(symbol: string): { coinId: string; risk: ReserveSlice["risk"] } | undefined {
  if (!Object.prototype.hasOwnProperty.call(TRACKED_STABLECOIN_ASSETS, symbol)) return undefined;
  return TRACKED_STABLECOIN_ASSETS[symbol];
}

const KNOWN_ASSETS = new Set([...STABLECOIN_ASSETS, ...ETH_LST_ASSETS, ...BTC_ASSETS, ...GOVERNANCE_ASSETS]);

export function bucketForAsset(symbol: string): DolaBucket {
  if (STABLECOIN_ASSETS.has(symbol)) return "stablecoin";
  if (ETH_LST_ASSETS.has(symbol)) return "eth-lst";
  if (BTC_ASSETS.has(symbol)) return "btc";
  if (GOVERNANCE_ASSETS.has(symbol)) return "governance";
  return "other";
}

/** Resolve the base asset symbol from compound names like "DOLA-sUSDe clp" or "yv-DOLA-sUSDS". */
export function resolveBaseSymbol(market: FirmMarket): string {
  const sym = market.underlying.symbol;

  // Yearn vault wrappers: "yv-DOLA-sUSDe" → "sUSDe", "yv-sDOLA-scrvUSD" → "scrvUSD"
  if (sym.startsWith("yv-")) {
    const rest = sym.slice(3);
    if (rest.startsWith("DOLA-")) return rest.slice(5);
    if (rest.startsWith("sDOLA-")) return rest.slice(6);
    return rest;
  }

  // Curve LP tokens: "DOLA-sUSDe clp" → "sUSDe", "DOLA-wstUSR clp" → "wstUSR"
  if (sym.startsWith("DOLA-") && (sym.endsWith(" clp") || sym.endsWith(" lp"))) {
    const inner = sym.slice(5, sym.lastIndexOf(" "));
    if (inner) return inner;
  }

  // FraxPyUSD LP: "yv-DOLA-FraxPyUSD lp" already handled by yv-match above
  return sym;
}

export function adaptFirmMarkets(payload: FirmMarketsResponse): AdapterResult {
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.timestamp);
  const {
    bucketTotals,
    totalValue: totalDebt,
    unknownValue: unknownDebt,
  } = accumulateBucketedExposure({
    items: payload.markets,
    getValue: (market) => market.totalDebt,
    getBucket: (market) => {
      const symbol = resolveBaseSymbol(market);
      if (getTrackedStablecoinAsset(symbol)) return "stablecoin";
      return bucketForAsset(symbol);
    },
    isUnknown: (market) => !KNOWN_ASSETS.has(resolveBaseSymbol(market)),
  });
  const trackedStableValues = new Map<string, number>();
  for (const market of payload.markets) {
    const value = market.totalDebt;
    if (!Number.isFinite(value) || value <= 0) continue;
    const symbol = resolveBaseSymbol(market);
    if (!getTrackedStablecoinAsset(symbol)) continue;
    trackedStableValues.set(symbol, (trackedStableValues.get(symbol) ?? 0) + value);
  }
  const trackedStableTotal = Array.from(trackedStableValues.values()).reduce((sum, value) => sum + value, 0);

  const slices = slicesFromValues([
    ...Array.from(trackedStableValues, ([symbol, value]) => {
      const config = getTrackedStablecoinAsset(symbol)!;
      return {
        name: `${symbol} collateral`,
        value,
        risk: config.risk,
        coinId: config.coinId,
        depType: "collateral" as const,
      };
    }),
    {
      name: "Other stablecoin collateral",
      value: Math.max(0, (bucketTotals.get("stablecoin") ?? 0) - trackedStableTotal),
      risk: getCanonicalReserveAssetRisk("sUSDe") ?? "low",
    },
    {
      name: "ETH / Liquid staking (wstETH, WETH)",
      value: bucketTotals.get("eth-lst") ?? 0,
      risk: getCanonicalReserveAssetRisk("wstETH") ?? "low",
    },
    {
      name: "BTC (WBTC, cbBTC)",
      value: bucketTotals.get("btc") ?? 0,
      risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium",
    },
    {
      name: "Governance tokens (INV, CRV, CVX)",
      value: bucketTotals.get("governance") ?? 0,
      risk: "very-high",
    },
    {
      name: "Other collateral",
      value: bucketTotals.get("other") ?? 0,
      risk: "high",
    },
  ]);

  const activeMarkets = payload.markets.filter((m) => m.totalDebt > 0).length;

  return {
    slices,
    metadata: {
      activeMarkets,
      totalMarkets: payload.markets.length,
      timestamp: sourceTimestamp,
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "firm-markets-api",
        "FiRM markets payload did not expose a trustworthy source timestamp",
      ),
      unknownExposurePct: totalDebt > 0 ? (unknownDebt / totalDebt) * 100 : 0,
    },
  };
}

export function listUnexpectedDolaAssets(payload: FirmMarketsResponse): string[] {
  return Array.from(
    accumulateBucketedExposure({
      items: payload.markets,
      getValue: (market) => market.totalDebt,
      getBucket: (market) => bucketForAsset(resolveBaseSymbol(market)),
      isUnknown: (market) => !KNOWN_ASSETS.has(resolveBaseSymbol(market)),
      getUnknownKey: (market) => resolveBaseSymbol(market),
    }).unknownValuesByKey.keys(),
  );
}

export async function fetchDolaInverseReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<FirmMarketsResponse>(
    config,
    "dola-inverse",
    signal,
    12_000,
    ctx,
  );
  const adapted = adaptFirmMarkets(payload);
  const warnings: LiveReserveWarning[] = listUnexpectedDolaAssets(payload).map((asset) => reserveDegradedWarning(
    "unknown-asset",
    `DOLA FiRM asset bucketed into other: ${asset}`,
  ));

  return {
    ...adapted,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
