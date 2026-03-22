import type { LiveReserveWarning, LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import { CANONICAL_ETH_RESERVE_RISK, getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterResult } from "./types";
import { fetchJsonWithRetry, getAdapterTimeout, normalizeSlices, requireJsonInput } from "./helpers";

interface CurveMarketEntry {
  collateral_amount_usd?: number;
  collateral_token?: {
    symbol?: string;
  };
}

interface CurveMarketsPayload {
  chains?: {
    ethereum?: {
      data?: CurveMarketEntry[];
    };
  };
}

const RISK_SEVERITY: Record<ReserveSlice["risk"], number> = {
  "very-low": 0,
  low: 1,
  medium: 2,
  high: 3,
  "very-high": 4,
};

function worseRisk(a: ReserveSlice["risk"], b: ReserveSlice["risk"]): ReserveSlice["risk"] {
  return RISK_SEVERITY[a] >= RISK_SEVERITY[b] ? a : b;
}

function classifySymbol(symbol: string): { name: string; risk: ReserveSlice["risk"] } | null {
  const upper = symbol.toUpperCase();
  if (["WBTC", "CBBTC", "LBTC", "ZKBTC"].includes(upper)) {
    return { name: "WBTC / cbBTC / LBTC", risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium" };
  }
  if (upper === "TBTC") {
    return { name: "tBTC", risk: getCanonicalReserveAssetRisk("TBTC") ?? "medium" };
  }
  if (["WSTETH", "SFRXETH", "WEETH"].includes(upper)) {
    return { name: "wstETH / sfrxETH / weETH", risk: getCanonicalReserveAssetRisk(upper) ?? "low" };
  }
  if (upper === "ETH" || upper === "WETH") {
    return { name: "ETH", risk: CANONICAL_ETH_RESERVE_RISK };
  }
  return null;
}

export function adaptCrvUsd(payload: CurveMarketsPayload): { slices: ReserveSlice[]; warnings: LiveReserveWarning[] } {
  const markets = payload.chains?.ethereum?.data ?? [];
  const buckets = new Map<string, { usd: number; risk: ReserveSlice["risk"] }>();
  const warnings: LiveReserveWarning[] = [];
  let unknownUsd = 0;

  for (const market of markets) {
    const symbol = market.collateral_token?.symbol;
    const usd = market.collateral_amount_usd ?? 0;
    if (!symbol || !Number.isFinite(usd) || usd <= 0) continue;

    const bucket = classifySymbol(symbol);
    if (!bucket) {
      warnings.push({
        code: "unknown-market",
        message: `Unmapped crvUSD collateral market: ${symbol}`,
        severity: "warning",
      });
      unknownUsd += usd;
      continue;
    }

    const existing = buckets.get(bucket.name);
    if (existing) {
      existing.usd += usd;
      existing.risk = worseRisk(existing.risk, bucket.risk);
    } else {
      buckets.set(bucket.name, { usd, risk: bucket.risk });
    }
  }

  const total = Array.from(buckets.values()).reduce((acc, bucket) => acc + bucket.usd, 0);
  const totalWithUnknown = total + unknownUsd;
  if (totalWithUnknown <= 0) return { slices: [], warnings };

  if (unknownUsd > 0) {
    buckets.set("Other / unmapped collateral markets", {
      usd: unknownUsd,
      risk: "high",
    });
  }

  const slices = normalizeSlices(
    Array.from(buckets.entries()).map(([name, bucket]) => ({
      name,
      pct: (bucket.usd / totalWithUnknown) * 100,
      risk: bucket.risk,
    })),
  );

  return { slices, warnings };
}

export async function fetchCrvUsdReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "crvusd");
  const payload = await fetchJsonWithRetry<CurveMarketsPayload>(input.url, signal, getAdapterTimeout(config, 12_000));
  return adaptCrvUsd(payload);
}
