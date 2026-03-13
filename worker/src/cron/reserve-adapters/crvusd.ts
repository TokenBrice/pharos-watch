import type { LiveReserveWarning, LiveReservesConfig, ReserveSlice, StablecoinMeta } from "@shared/types";
import { CANONICAL_ETH_RESERVE_RISK, getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterResult } from "./index";
import { fetchJsonWithRetry, normalizeSlices, requireJsonInput } from "./helpers";

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

function classifySymbol(symbol: string): { name: string; risk: ReserveSlice["risk"] } | null {
  const upper = symbol.toUpperCase();
  if (["WBTC", "CBBTC", "LBTC", "ZKBTC"].includes(upper)) {
    return { name: "WBTC / cbBTC / LBTC", risk: "medium" };
  }
  if (upper === "TBTC") {
    return { name: "tBTC", risk: "medium" };
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
      continue;
    }

    const existing = buckets.get(bucket.name);
    if (existing) {
      existing.usd += usd;
    } else {
      buckets.set(bucket.name, { usd, risk: bucket.risk });
    }
  }

  const total = Array.from(buckets.values()).reduce((acc, bucket) => acc + bucket.usd, 0);
  if (total <= 0) return { slices: [], warnings };

  const slices = normalizeSlices(
    Array.from(buckets.entries()).map(([name, bucket]) => ({
      name,
      pct: (bucket.usd / total) * 100,
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
  const payload = await fetchJsonWithRetry<CurveMarketsPayload>(input.url, signal);
  return adaptCrvUsd(payload);
}
