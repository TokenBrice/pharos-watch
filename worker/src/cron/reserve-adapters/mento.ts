import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { CANONICAL_ETH_RESERVE_RISK, getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromPercentages,
  unverifiedFreshnessMetadata,
} from "./helpers";
import { requireJsonInput } from "./input-guards";

interface MentoReserveEntry {
  symbol: string;
  percent: number;
}

interface MentoReserveApiAsset {
  symbol?: unknown;
  percentage?: unknown;
}

interface MentoReserveApiResponse {
  collateral?: {
    assets?: MentoReserveApiAsset[];
  };
}

interface TokenConfig {
  key: string;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  stableLike?: boolean;
}

const TOKEN_CONFIG: Record<string, TokenConfig> = {
  sUSDS: {
    key: "sUSDS",
    name: "sUSDS (Sky savings USDS)",
    risk: "low",
    coinId: "usds-sky",
    stableLike: true,
  },
  EURC: {
    key: "EURC",
    name: "EURC (Circle euro stablecoin)",
    risk: "low",
    coinId: "eurc-circle",
    stableLike: true,
  },
  axlEUROC: {
    key: "EURC",
    name: "EURC (Circle euro stablecoin)",
    risk: "low",
    coinId: "eurc-circle",
    stableLike: true,
  },
  CELO: { key: "CELO", name: "CELO", risk: getCanonicalReserveAssetRisk("CELO") ?? "high" },
  USDGLO: {
    key: "USDGLO",
    name: "USDGLO (Glo Dollar)",
    risk: "low",
    stableLike: true,
  },
  stETH: {
    key: "stETH",
    name: "stETH (Lido staked ETH)",
    risk: getCanonicalReserveAssetRisk("stETH") ?? "low",
  },
  USDT: {
    key: "USDT",
    name: "USDT",
    risk: "low",
    coinId: "usdt-tether",
    stableLike: true,
  },
  USDC: {
    key: "USDC",
    name: "USDC",
    risk: "low",
    coinId: "usdc-circle",
    stableLike: true,
  },
  axlUSDC: {
    key: "USDC",
    name: "USDC",
    risk: "low",
    coinId: "usdc-circle",
    stableLike: true,
  },
  AUSD: {
    key: "AUSD",
    name: "AUSD (Agora Dollar)",
    risk: getCanonicalReserveAssetRisk("AUSD") ?? "low",
    coinId: "ausd-agora",
    stableLike: true,
  },
  ETH: { key: "ETH", name: "ETH", risk: CANONICAL_ETH_RESERVE_RISK },
  WETH: { key: "ETH", name: "ETH", risk: CANONICAL_ETH_RESERVE_RISK },
  WBTC: {
    key: "WBTC",
    name: "WBTC",
    risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium",
  },
};

function getCollateralAssets(payload: unknown): MentoReserveApiAsset[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("mento: layout-changed: response was not an object");
  }

  const response = payload as MentoReserveApiResponse;
  const assets = response.collateral?.assets;
  if (!Array.isArray(assets)) {
    throw new Error("mento: layout-changed: missing collateral.assets");
  }

  return assets;
}

export function parseMentoReserveComposition(payload: unknown): MentoReserveEntry[] {
  const assets = getCollateralAssets(payload);
  const entries = assets.flatMap((asset) => (
    typeof asset.symbol === "string" && typeof asset.percentage === "number"
      ? [{ symbol: asset.symbol, percent: asset.percentage }]
      : []
  ));

  if (entries.length === 0) {
    throw new Error("mento: layout-changed: collateral.assets contained no usable entries");
  }

  return entries;
}

export function adaptMentoReserveComposition(payload: unknown): AdapterResult {
  const entries = parseMentoReserveComposition(payload);
  const warnings: LiveReserveWarning[] = [];

  if (entries.length < 3) {
    warnings.push(reserveInfoWarning(
      "mento-low-entry-count",
      `Mento reserve composition has only ${entries.length} entries (expected >= 3)`,
    ));
  }

  const grouped = new Map<string, {
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    pct: number;
    stableLike: boolean;
  }>();

  let stablePct = 0;
  for (const entry of entries) {
    const config = TOKEN_CONFIG[entry.symbol];
    if (!config) {
      warnings.push(reserveDegradedWarning("unknown-asset", `Unmapped Mento reserve symbol: ${entry.symbol}`));
      const existing = grouped.get(entry.symbol);
      if (existing) {
        existing.pct += entry.percent;
      } else {
        grouped.set(entry.symbol, {
          name: entry.symbol,
          risk: "medium",
          pct: entry.percent,
          stableLike: false,
        });
      }
      continue;
    }

    const existing = grouped.get(config.key);
    if (existing) {
      existing.pct += entry.percent;
    } else {
      grouped.set(config.key, {
        name: config.name,
        risk: config.risk,
        coinId: config.coinId,
        pct: entry.percent,
        stableLike: config.stableLike ?? false,
      });
    }

    if (config.stableLike) {
      stablePct += entry.percent;
    }
  }

  const totalPct = entries.reduce((sum, entry) => sum + entry.percent, 0);
  const slices = slicesFromPercentages(
    Array.from(grouped.values(), (group) => ({
      name: group.name,
      pct: group.pct,
      risk: group.risk,
      ...(group.coinId ? { coinId: group.coinId } : {}),
    })),
    { decimals: 1, context: "Mento reserve composition" },
  );

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      entryCount: entries.length,
      totalPct,
      ...unverifiedFreshnessMetadata(
        "mento-analytics-api",
        "Mento analytics API exposes reserve composition but not a trustworthy payload update timestamp",
      ),
      stableReservePct: stablePct,
    },
  };
}

export async function fetchMentoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "mento");
  const payload = await fetchJsonWithRetry<MentoReserveApiResponse>(input.url, signal, 12_000, ctx);
  return adaptMentoReserveComposition(payload);
}
