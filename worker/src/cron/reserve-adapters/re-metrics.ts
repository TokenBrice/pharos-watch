import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchPrimaryHtmlInput,
  htmlLayoutChangedError,
  htmlParseError,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  slicesFromValues,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";
import { extractEscapedJsonValueAfterKey } from "./html";

interface ReMetricsChainRow {
  tokenSymbol?: string;
  valueWei?: string;
  valueKnown?: boolean;
}

interface ReMetricsChainBreakdown {
  asOf?: string;
  rows?: ReMetricsChainRow[];
}

interface ReMetricsSeriesPoint {
  date?: string;
  value?: number;
}

interface ReMetricsSeries {
  seriesKey?: string;
  stats?: {
    current?: number;
  };
  points?: ReMetricsSeriesPoint[];
}

interface ReMetricsTvlPoint {
  date?: string;
  offchain_capital?: number;
}

const ESCAPED_INITIAL_BREAKDOWNS_KEY = "\\\"initialChainBreakdowns\\\":";
const ESCAPED_SERIES_KEY = "\\\"series\\\":";
const ESCAPED_INITIAL_TVL_DATA_KEY = "\\\"initialTvlData\\\":";

const SYMBOL_CONFIG: Record<string, {
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}> = {
  susde: {
    name: "sUSDe (delta-neutral ETH basis)",
    risk: "high",
    coinId: "usde-ethena",
    depType: "wrapper",
  },
  usde: {
    name: "USDe (delta-neutral ETH basis)",
    risk: "high",
    coinId: "usde-ethena",
  },
  usdc: {
    name: "USDC reserves",
    risk: "low",
    coinId: "usdc-circle",
  },
  usdt: {
    name: "USDT reserves",
    risk: "low",
    coinId: "usdt-tether",
  },
  dai: {
    name: "DAI reserves",
    risk: "low",
    coinId: "dai-makerdao",
  },
  frax: {
    name: "FRAX reserves",
    risk: "low",
    coinId: "frax-frax",
  },
  "reusd/susde": {
    name: "reUSD / sUSDe LP position",
    risk: "high",
  },
  "liusd-4w": {
    name: "liUSD 4w vault",
    risk: "medium",
  },
};

function parseValueUsdFromWei(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const whole = raw.length > 18 ? raw.slice(0, -18) : "0";
  const fraction = raw.length > 18 ? raw.slice(-18) : raw.padStart(18, "0");
  return Number(`${whole}.${fraction}`.replace(/\.$/, ""));
}

function parseInitialChainBreakdowns(html: string): Record<string, ReMetricsChainBreakdown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      extractEscapedJsonValueAfterKey(html, ESCAPED_INITIAL_BREAKDOWNS_KEY, "re-metrics"),
    ) as unknown;
  } catch (error) {
    throw htmlParseError(
      "re-metrics",
      `initialChainBreakdowns JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw htmlParseError("re-metrics", "initialChainBreakdowns was not an object");
  }
  return parsed as Record<string, ReMetricsChainBreakdown>;
}

function parseSeries(html: string): ReMetricsSeries[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      extractEscapedJsonValueAfterKey(html, ESCAPED_SERIES_KEY, "re-metrics"),
    ) as unknown;
  } catch (error) {
    throw htmlParseError(
      "re-metrics",
      `series JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw htmlParseError("re-metrics", "series was not an array");
  }
  return parsed as ReMetricsSeries[];
}

function parseInitialTvlData(html: string): ReMetricsTvlPoint[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      extractEscapedJsonValueAfterKey(html, ESCAPED_INITIAL_TVL_DATA_KEY, "re-metrics"),
    ) as unknown;
  } catch (error) {
    throw htmlParseError(
      "re-metrics",
      `initialTvlData JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw htmlParseError("re-metrics", "initialTvlData was not an array");
  }
  return parsed as ReMetricsTvlPoint[];
}

function normalizeTokenSymbol(symbol: string): string {
  return symbol.trim().toLowerCase();
}

function lastItem<T>(items: T[] | undefined): T | undefined {
  return items && items.length > 0 ? items[items.length - 1] : undefined;
}

function extractOffchainCapitalContext(html: string): {
  offchainCapitalUsd: number | null;
  offchainTimestamp: number | null;
} {
  if (html.includes(ESCAPED_SERIES_KEY)) {
    const series = parseSeries(html);
    const offchainSeries = series.find((entry) => entry.seriesKey === "offchain_capital");
    return {
      offchainCapitalUsd: offchainSeries?.stats?.current
        ?? lastItem(offchainSeries?.points)?.value
        ?? null,
      offchainTimestamp: parseTimestampLikeToUnixSeconds(lastItem(offchainSeries?.points)?.date),
    };
  }

  if (html.includes(ESCAPED_INITIAL_TVL_DATA_KEY)) {
    const tvlData = parseInitialTvlData(html);
    const latestPoint = lastItem(tvlData);
    return {
      offchainCapitalUsd:
        latestPoint?.offchain_capital != null && Number.isFinite(latestPoint.offchain_capital)
          ? latestPoint.offchain_capital
          : null,
      offchainTimestamp: parseTimestampLikeToUnixSeconds(latestPoint?.date),
    };
  }

  throw htmlLayoutChangedError(
    "re-metrics",
    `missing ${ESCAPED_SERIES_KEY} and ${ESCAPED_INITIAL_TVL_DATA_KEY}`,
  );
}

export function adaptReMetrics(html: string): AdapterResult {
  const breakdowns = parseInitialChainBreakdowns(html);
  const { offchainCapitalUsd, offchainTimestamp } = extractOffchainCapitalContext(html);

  const tokenValues = new Map<string, number>();
  const snapshotTimestamps: number[] = [];
  const warnings: LiveReserveWarning[] = [];

  for (const breakdown of Object.values(breakdowns)) {
    const asOf = parseTimestampLikeToUnixSeconds(breakdown.asOf);
    if (asOf != null) {
      snapshotTimestamps.push(asOf);
    }

    for (const row of breakdown.rows ?? []) {
      if (!row.valueKnown) continue;
      const tokenSymbol = row.tokenSymbol?.trim();
      const valueUsd = parseValueUsdFromWei(row.valueWei);
      if (!tokenSymbol || valueUsd == null || valueUsd <= 0) continue;
      const key = normalizeTokenSymbol(tokenSymbol);
      tokenValues.set(key, (tokenValues.get(key) ?? 0) + valueUsd);
    }
  }
  if (offchainTimestamp != null) {
    snapshotTimestamps.push(offchainTimestamp);
  }
  const stableRedeemableUsd = ["usdc", "usdt", "dai", "frax"]
    .reduce((sum, symbol) => sum + (tokenValues.get(symbol) ?? 0), 0);

  const slices = slicesFromValues([
    ...Array.from(tokenValues.entries()).map(([symbol, value]) => {
      const config = SYMBOL_CONFIG[symbol];
      if (!config) {
        warnings.push(reserveDegradedWarning("unmapped-token", `Re Metrics token defaulted to medium risk: ${symbol}`));
      }
      return {
        value,
        name: config?.name ?? symbol,
        risk: config?.risk ?? "medium",
        ...(config?.coinId ? { coinId: config.coinId } : {}),
        ...(config?.depType ? { depType: config.depType } : {}),
      };
    }),
    ...(offchainCapitalUsd != null && Number.isFinite(offchainCapitalUsd) && offchainCapitalUsd > 0
      ? [{
          value: offchainCapitalUsd,
          name: "Off-chain insurance / reinsurance capital",
          risk: "medium" as const,
        }]
      : []),
  ].sort((left, right) => right.value - left.value));

  if (slices.length === 0) {
    throw htmlLayoutChangedError("re-metrics", "no reserve composition entries found");
  }

  const sourceTimestamp =
    snapshotTimestamps.length > 0
      ? Math.min(...snapshotTimestamps)
      : null;

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      chainBreakdownCount: Object.keys(breakdowns).length,
      offchainCapitalUsd,
      trackedTokenCount: tokenValues.size,
      ...(sourceTimestamp != null
        ? verifiedFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "nextjs-embedded-payload",
            "Re Metrics embedded payload did not expose a trustworthy source timestamp",
          )),
      immediateRedeemableUsd: stableRedeemableUsd,
      redemption: {
        capacityUsd: stableRedeemableUsd,
        capacityKind: "live-queue" as const,
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" as const : "unverified" as const,
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: stableRedeemableUsd > 0 ? "open" as const : "unknown" as const,
        sourceUrls: ["https://app.re.xyz/transparency"],
      },
    },
  };
}

export async function fetchReMetricsReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const html = await fetchPrimaryHtmlInput(config, "re-metrics", signal, ctx);
  return adaptReMetrics(html);
}
