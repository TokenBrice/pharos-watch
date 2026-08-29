import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  decimalNumberFromBigInt,
  fetchPrimaryHtmlInput,
  freshnessMetadataFromTimestamp,
  htmlLayoutChangedError,
  htmlParseError,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  slicesFromValues,
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

interface ReMetricsRedemptionRow {
  chainName?: string;
  vaultAddress?: string;
  custodialWalletAddress?: string;
  totalReserveValueWei?: string;
}

const ESCAPED_INITIAL_BREAKDOWNS_KEY = "\\\"initialChainBreakdowns\\\":";
const ESCAPED_SERIES_KEY = "\\\"series\\\":";
const ESCAPED_INITIAL_TVL_DATA_KEY = "\\\"initialTvlData\\\":";
const ESCAPED_REDEMPTION_ROWS_KEY = "\\\"redemptionRows\\\":";

const SYMBOL_CONFIG: Record<string, {
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
}> = {
  susde: {
    name: "sUSDe (delta-neutral ETH basis)",
    risk: "high",
    coinId: "susde-ethena",
    depType: "collateral",
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
  susds: {
    name: "sUSDS (Sky savings USDS)",
    risk: "low",
    coinId: "susds-sky",
    depType: "collateral",
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
  const value = decimalNumberFromBigInt(BigInt(raw), 18);
  return Number.isFinite(value) ? value : null;
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
      `initialChainBreakdowns JSON is malformed: ${toErrorMessage(error)}`,
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
      `series JSON is malformed: ${toErrorMessage(error)}`,
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
      `initialTvlData JSON is malformed: ${toErrorMessage(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw htmlParseError("re-metrics", "initialTvlData was not an array");
  }
  return parsed as ReMetricsTvlPoint[];
}

function parseRedemptionRows(html: string): ReMetricsRedemptionRow[] | null {
  if (!html.includes(ESCAPED_REDEMPTION_ROWS_KEY)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      extractEscapedJsonValueAfterKey(html, ESCAPED_REDEMPTION_ROWS_KEY, "re-metrics"),
    ) as unknown;
  } catch (error) {
    throw htmlParseError(
      "re-metrics",
      `redemptionRows JSON is malformed: ${toErrorMessage(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw htmlParseError("re-metrics", "redemptionRows was not an array");
  }
  return parsed as ReMetricsRedemptionRow[];
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

function extractInstantRedemptionCapacity(html: string): {
  capacityUsd: number;
  rows: Array<{
    chainName?: string;
    vaultAddress?: string;
    custodialWalletAddress?: string;
    capacityUsd: number;
  }>;
} | null {
  const rows = parseRedemptionRows(html);
  if (!rows) return null;
  const parsedRows = rows
    .map((row) => {
      const capacityUsd = parseValueUsdFromWei(row.totalReserveValueWei);
      if (capacityUsd == null || capacityUsd <= 0) return null;
      return {
        ...(row.chainName ? { chainName: row.chainName } : {}),
        ...(row.vaultAddress ? { vaultAddress: row.vaultAddress } : {}),
        ...(row.custodialWalletAddress ? { custodialWalletAddress: row.custodialWalletAddress } : {}),
        capacityUsd,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);
  const capacityUsd = parsedRows.reduce((sum, row) => sum + row.capacityUsd, 0);
  return capacityUsd > 0 ? { capacityUsd, rows: parsedRows } : null;
}

export function adaptReMetrics(html: string): AdapterResult {
  const breakdowns = parseInitialChainBreakdowns(html);
  const { offchainCapitalUsd, offchainTimestamp } = extractOffchainCapitalContext(html);
  const instantRedemptionCapacity = extractInstantRedemptionCapacity(html);

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
        sourceKey: `re-metrics:token:${symbol}`,
        name: config?.name ?? symbol,
        risk: config?.risk ?? "medium",
        ...(config?.coinId ? { coinId: config.coinId } : {}),
        ...(config?.depType ? { depType: config.depType } : {}),
      };
    }),
    ...(offchainCapitalUsd != null && Number.isFinite(offchainCapitalUsd) && offchainCapitalUsd > 0
      ? [{
          value: offchainCapitalUsd,
          sourceKey: "re-metrics:offchain-capital",
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
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "nextjs-embedded-payload",
        "Re Metrics embedded payload did not expose a trustworthy source timestamp",
      ),
      stableAssetUsd: stableRedeemableUsd,
      ...(instantRedemptionCapacity
        ? {
            immediateRedeemableUsd: instantRedemptionCapacity.capacityUsd,
            redemptionRowsCount: instantRedemptionCapacity.rows.length,
            redemption: {
              capacityUsd: instantRedemptionCapacity.capacityUsd,
              capacityKind: "live-direct-bounded" as const,
              freshnessKind: "same-run-api" as const,
              routeStatus: "unknown" as const,
              routeStatusSource: "protocol-api" as const,
              holderEligibility: "any-holder" as const,
              sourceUrls: [
                "https://app.re.xyz/metrics",
                "https://docs.re.xyz/protocol/smart-contract-addresses.md",
              ],
            },
            details: {
              redemptionRows: instantRedemptionCapacity.rows,
            },
          }
        : {}),
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
