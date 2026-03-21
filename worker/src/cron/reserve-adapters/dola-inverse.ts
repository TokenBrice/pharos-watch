import type { LiveReserveWarning, LiveReservesConfig, StablecoinMeta } from "@shared/types";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchJsonWithRetry, getAdapterTimeout, requireJsonInputFromConfig, slicesFromValues } from "./helpers";

interface FirmMarket {
  name: string;
  underlying: { symbol: string };
  totalDebt: number;
  borrowPaused: boolean;
}

interface FirmMarketsResponse {
  markets: FirmMarket[];
  timestamp: number;
}

type DolaBucket = "stablecoin" | "eth-lst" | "btc" | "governance" | "other";

const STABLECOIN_ASSETS = new Set(["sUSDe", "sUSDS", "DAI", "USDC", "USDT", "crvUSD", "scrvUSD", "FRAX", "PYUSD", "USR", "wstUSR", "FraxPyUSD lp", "DOLA-FRAXBP"]);
const ETH_LST_ASSETS = new Set(["WETH", "wstETH", "stETH", "rETH", "weETH", "cbETH"]);
const BTC_ASSETS = new Set(["WBTC", "cbBTC", "tBTC"]);
const GOVERNANCE_ASSETS = new Set(["INV", "CRV", "CVX", "cvxCRV", "st-yCRV", "cvxFXS"]);

const KNOWN_ASSETS = new Set([...STABLECOIN_ASSETS, ...ETH_LST_ASSETS, ...BTC_ASSETS, ...GOVERNANCE_ASSETS]);

function bucketForAsset(symbol: string): DolaBucket {
  if (STABLECOIN_ASSETS.has(symbol)) return "stablecoin";
  if (ETH_LST_ASSETS.has(symbol)) return "eth-lst";
  if (BTC_ASSETS.has(symbol)) return "btc";
  if (GOVERNANCE_ASSETS.has(symbol)) return "governance";
  return "other";
}

/** Resolve the base asset symbol from compound names like "DOLA-sUSDe clp" or "yv-DOLA-sUSDS". */
function resolveBaseSymbol(market: FirmMarket): string {
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
  const bucketTotals = new Map<DolaBucket, number>();
  const seenSymbols = new Set<string>();

  for (const market of payload.markets) {
    if (!Number.isFinite(market.totalDebt) || market.totalDebt <= 0) continue;
    const baseSymbol = resolveBaseSymbol(market);
    seenSymbols.add(baseSymbol);
    const bucket = bucketForAsset(baseSymbol);
    bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + market.totalDebt);
  }

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
      timestamp: payload.timestamp,
    },
  };
}

export function listUnexpectedDolaAssets(payload: FirmMarketsResponse): string[] {
  const unknown = new Set<string>();
  for (const market of payload.markets) {
    if (market.totalDebt <= 0) continue;
    const baseSymbol = resolveBaseSymbol(market);
    if (!KNOWN_ASSETS.has(baseSymbol)) unknown.add(baseSymbol);
  }
  return Array.from(unknown);
}

export async function fetchDolaInverseReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  _ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "dola-inverse");
  const payload = await fetchJsonWithRetry<FirmMarketsResponse>(primaryInput.url, signal, getAdapterTimeout(config, 12_000));
  const adapted = adaptFirmMarkets(payload);
  const unknownAssets = listUnexpectedDolaAssets(payload);
  const warnings: LiveReserveWarning[] = unknownAssets.map((asset) => ({
    code: "unknown-asset",
    message: `DOLA FiRM asset bucketed into other: ${asset}`,
    severity: "warning",
  }));

  return {
    ...adapted,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
