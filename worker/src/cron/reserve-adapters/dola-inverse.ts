import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  accumulateBucketedExposure,
  fetchJsonWithRetry,
  requireJsonInputFromConfig,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  slicesFromValues,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
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
    getBucket: (market) => bucketForAsset(resolveBaseSymbol(market)),
    isUnknown: (market) => !KNOWN_ASSETS.has(resolveBaseSymbol(market)),
  });

  const slices = slicesFromValues([
    {
      name: "Stablecoin collateral (sUSDe, sUSDS, crvUSD)",
      value: bucketTotals.get("stablecoin") ?? 0,
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
      ...(sourceTimestamp != null
        ? verifiedFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "firm-markets-api",
            "FiRM markets payload did not expose a trustworthy source timestamp",
          )),
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
  const primaryInput = requireJsonInputFromConfig(config, "dola-inverse");
  const payload = await fetchJsonWithRetry<FirmMarketsResponse>(
    primaryInput.url,
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
