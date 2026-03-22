import type { LiveReservesConfig, LiveReserveWarning, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./types";
import { fetchJsonWithRetry, getAdapterTimeout, requireJsonInputFromConfig, reserveDegradedWarning, slicesFromValues } from "./helpers";

interface DefiLlamaProtocolResponse {
  tokensInUsd: Array<{
    date: number;
    tokens: Record<string, number>;
  }>;
}

type SkyBucket = "stablecoins" | "eth-lsd" | "btc" | "other";

const STABLECOIN_TOKENS = new Set(["USDC", "GUSD", "USDP", "DAI", "USDT", "TUSD"]);
const ETH_TOKENS = new Set(["WETH", "WSTETH", "RETH"]);
const BTC_TOKENS = new Set(["WBTC", "RENBTC"]);

const KNOWN_TOKENS = new Set([...STABLECOIN_TOKENS, ...ETH_TOKENS, ...BTC_TOKENS,
  "LINK", "UNI", "COMP", "BAT", "YFI", "AAVE", "ZRX", "BAL", "WMATIC", "LRC", "KNC", "MANA",
]);

function bucketForToken(token: string): SkyBucket {
  const upper = token.toUpperCase();
  if (STABLECOIN_TOKENS.has(upper)) return "stablecoins";
  if (ETH_TOKENS.has(upper)) return "eth-lsd";
  if (BTC_TOKENS.has(upper)) return "btc";
  return "other";
}

export function listUnexpectedTokens(tokens: Record<string, number>): string[] {
  return Object.keys(tokens).filter((t) => !KNOWN_TOKENS.has(t.toUpperCase()));
}

export function adaptSkyCollateral(tokens: Record<string, number>): AdapterResult["slices"] {
  const bucketTotals = new Map<SkyBucket, number>();

  for (const [token, value] of Object.entries(tokens)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    const bucket = bucketForToken(token);
    bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + value);
  }

  return slicesFromValues([
    {
      name: "Stablecoins (USDC via PSM)",
      value: bucketTotals.get("stablecoins") ?? 0,
      risk: "low",
      coinId: "usdc-circle",
      depType: "mechanism" as const,
    },
    {
      name: "ETH / liquid staking (wstETH, rETH)",
      value: bucketTotals.get("eth-lsd") ?? 0,
      risk: "low",
    },
    {
      name: "BTC collateral (WBTC)",
      value: bucketTotals.get("btc") ?? 0,
      risk: "medium",
    },
    {
      name: "Other DeFi tokens",
      value: bucketTotals.get("other") ?? 0,
      risk: "high",
    },
  ]);
}

export async function fetchSkyMakercoreReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "sky-makercore");
  const payload = await fetchJsonWithRetry<DefiLlamaProtocolResponse>(
    primaryInput.url,
    signal,
    getAdapterTimeout(config, 15_000),
    ctx,
  );

  const entries = payload.tokensInUsd;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("sky-makercore: tokensInUsd array is empty or missing");
  }

  const latest = entries.reduce((maxEntry, entry) => (
    entry.date > maxEntry.date ? entry : maxEntry
  ));
  const tokens = latest.tokens;
  if (!tokens || typeof tokens !== "object") {
    throw new Error("sky-makercore: latest tokensInUsd entry has no tokens object");
  }

  const slices = adaptSkyCollateral(tokens);
  if (slices.length === 0) {
    throw new Error("sky-makercore: all token values are zero or invalid");
  }

  const totalUsd = Object.values(tokens).reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
  const unknown = listUnexpectedTokens(tokens);
  const unknownExposureUsd = unknown.reduce((sum, token) => {
    const value = tokens[token];
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
  const warnings: LiveReserveWarning[] = unknown.map((token) => reserveDegradedWarning(
    "unknown-asset",
    `Sky collateral token bucketed into other: ${token}`,
  ));

  return {
    slices,
    metadata: {
      tokenCount: Object.keys(tokens).length,
      totalCollateralUsd: Math.round(totalUsd),
      snapshotDate: latest.date,
      sourceTimestamp: latest.date,
      unknownExposurePct: totalUsd > 0 ? (unknownExposureUsd / totalUsd) * 100 : 0,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
