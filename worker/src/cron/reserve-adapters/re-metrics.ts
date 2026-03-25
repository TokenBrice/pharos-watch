import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchTextWithRetry,
  getAdapterTimeout,
  htmlLayoutChangedError,
  htmlParseError,
  parseTimestampLikeToUnixSeconds,
  requireHtmlInput,
  slicesFromValues,
} from "./helpers";

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

const ESCAPED_INITIAL_BREAKDOWNS_KEY = "\\\"initialChainBreakdowns\\\":";
const ESCAPED_SERIES_KEY = "\\\"series\\\":";

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
};

function extractEscapedJsonValue(html: string, key: string): string {
  const keyIndex = html.indexOf(key);
  if (keyIndex < 0) {
    throw htmlLayoutChangedError("re-metrics", `missing ${key}`);
  }

  const valueStart = keyIndex + key.length;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let index = valueStart; index < html.length; index += 1) {
    const char = html[index];
    if (start === -1) {
      if (char === "{" || char === "[") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(start, index + 1).replace(/\\"/g, "\"");
      }
    }
  }

  throw htmlParseError("re-metrics", `unterminated ${key}`);
}

function parseValueUsdFromWei(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const whole = raw.length > 18 ? raw.slice(0, -18) : "0";
  const fraction = raw.length > 18 ? raw.slice(-18) : raw.padStart(18, "0");
  return Number(`${whole}.${fraction}`.replace(/\.$/, ""));
}

function parseInitialChainBreakdowns(html: string): Record<string, ReMetricsChainBreakdown> {
  const parsed = JSON.parse(extractEscapedJsonValue(html, ESCAPED_INITIAL_BREAKDOWNS_KEY)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw htmlParseError("re-metrics", "initialChainBreakdowns was not an object");
  }
  return parsed as Record<string, ReMetricsChainBreakdown>;
}

function parseSeries(html: string): ReMetricsSeries[] {
  const parsed = JSON.parse(extractEscapedJsonValue(html, ESCAPED_SERIES_KEY)) as unknown;
  if (!Array.isArray(parsed)) {
    throw htmlParseError("re-metrics", "series was not an array");
  }
  return parsed as ReMetricsSeries[];
}

function normalizeTokenSymbol(symbol: string): string {
  return symbol.trim().toLowerCase();
}

function lastItem<T>(items: T[] | undefined): T | undefined {
  return items && items.length > 0 ? items[items.length - 1] : undefined;
}

export function adaptReMetrics(html: string): AdapterResult {
  const breakdowns = parseInitialChainBreakdowns(html);
  const series = parseSeries(html);

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

  const offchainSeries = series.find((entry) => entry.seriesKey === "offchain_capital");
  const offchainCapitalUsd = offchainSeries?.stats?.current
    ?? lastItem(offchainSeries?.points)?.value
    ?? null;
  const offchainTimestamp = parseTimestampLikeToUnixSeconds(lastItem(offchainSeries?.points)?.date);
  if (offchainTimestamp != null) {
    snapshotTimestamps.push(offchainTimestamp);
  }

  const slices = slicesFromValues([
    ...Array.from(tokenValues.entries()).map(([symbol, value]) => {
      const config = SYMBOL_CONFIG[symbol];
      if (!config) {
        warnings.push({
          code: "unmapped-token",
          message: `Re Metrics token defaulted to medium risk: ${symbol}`,
          severity: "warning",
          effect: "degraded",
        });
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
        ? { sourceTimestamp, freshnessMode: "verified" as const }
        : { freshnessMode: "unverified" as const }),
    },
  };
}

export async function fetchReMetricsReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireHtmlInput(config.inputs.primary, "re-metrics");
  const html = await fetchTextWithRetry(
    input.url,
    signal,
    getAdapterTimeout(config, 15_000),
    ctx,
  );
  return adaptReMetrics(html);
}
