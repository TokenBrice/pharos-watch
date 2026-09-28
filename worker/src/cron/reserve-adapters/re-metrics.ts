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
  reserveFatalWarning,
  reserveInfoWarning,
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

interface ReMetricsCard {
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
// The metrics page embeds its chart cards (one per `seriesKey`, including
// `offchain_capital`) under `initialCards`. The older `"series":` anchor is
// gone from the page (the escape depth changed upstream), so it must not be
// silently relied on.
const ESCAPED_INITIAL_CARDS_KEY = "\\\"initialCards\\\":";
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

function parseValueUsdFromWei(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
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

function parseInitialCards(html: string): ReMetricsCard[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      extractEscapedJsonValueAfterKey(html, ESCAPED_INITIAL_CARDS_KEY, "re-metrics"),
    ) as unknown;
  } catch (error) {
    throw htmlParseError(
      "re-metrics",
      `initialCards JSON is malformed: ${toErrorMessage(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw htmlParseError("re-metrics", "initialCards was not an array");
  }
  return parsed as ReMetricsCard[];
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

function extractOffchainCapitalContext(
  html: string,
  warnings: LiveReserveWarning[],
): {
  offchainCapitalUsd: number | null;
  offchainTimestamp: number | null;
} {
  if (html.includes(ESCAPED_INITIAL_CARDS_KEY)) {
    const cards = parseInitialCards(html);
    const offchainCard = cards.find((entry) => entry.seriesKey === "offchain_capital");
    warnings.push(reserveInfoWarning(
      "re-metrics-offchain-capital-branch",
      "Re Metrics offchain capital read from the page's initialCards series",
    ));
    return {
      offchainCapitalUsd: offchainCard?.stats?.current
        ?? lastItem(offchainCard?.points)?.value
        ?? null,
      offchainTimestamp: parseTimestampLikeToUnixSeconds(lastItem(offchainCard?.points)?.date),
    };
  }

  if (html.includes(ESCAPED_INITIAL_TVL_DATA_KEY)) {
    const tvlData = parseInitialTvlData(html);
    const latestPoint = lastItem(tvlData);
    warnings.push(reserveInfoWarning(
      "re-metrics-offchain-capital-branch",
      "Re Metrics offchain capital read from the initialTvlData fallback (the initialCards series was absent)",
    ));
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
    `missing ${ESCAPED_INITIAL_CARDS_KEY} and ${ESCAPED_INITIAL_TVL_DATA_KEY}`,
  );
}

function extractInstantRedemptionCapacity(html: string, warnings: LiveReserveWarning[]): {
  capacityUsd: number;
  rows: Array<{
    chainName?: string;
    vaultAddress?: string;
    custodialWalletAddress?: string;
    capacityUsd: number;
  }>;
} | null {
  const rows = parseRedemptionRows(html);
  if (!rows || rows.length === 0) return null;
  const parsedRows = [];
  let capacityUsd = 0;
  for (const [index, row] of rows.entries()) {
    const value = parseValueUsdFromWei(row?.totalReserveValueWei);
    if (value == null || !Number.isFinite(capacityUsd + value)) {
      warnings.push(reserveDegradedWarning(
        "re-metrics-redemption-incomplete",
        `Redemption row ${index} (${row?.chainName ?? "unknown chain"}) has an unavailable amount; aggregate capacity withheld`,
      ));
      return null;
    }
    capacityUsd += value;
    parsedRows.push({
      ...(row.chainName ? { chainName: row.chainName } : {}),
      ...(row.vaultAddress ? { vaultAddress: row.vaultAddress } : {}),
      ...(row.custodialWalletAddress ? { custodialWalletAddress: row.custodialWalletAddress } : {}),
      capacityUsd: value,
    });
  }
  return { capacityUsd, rows: parsedRows };
}

export function adaptReMetrics(html: string): AdapterResult {
  const warnings: LiveReserveWarning[] = [];
  const breakdowns = parseInitialChainBreakdowns(html);
  const { offchainCapitalUsd, offchainTimestamp } = extractOffchainCapitalContext(html, warnings);
  const instantRedemptionCapacity = extractInstantRedemptionCapacity(html, warnings);

  const tokenValues = new Map<string, number>();
  const componentTimestamps: number[] = [];
  let missingComponentTimestamp = false;
  let incompleteComposition = false;
  if (typeof offchainCapitalUsd !== "number" || !Number.isFinite(offchainCapitalUsd) || offchainCapitalUsd < 0) {
    incompleteComposition = true;
    warnings.push(reserveFatalWarning("re-metrics-offchain-value-unavailable", "Off-chain capital amount unavailable; composition withheld"));
  }

  for (const [chain, breakdown] of Object.entries(breakdowns)) {
    if (!breakdown || !Array.isArray(breakdown.rows)) {
      incompleteComposition = true;
      warnings.push(reserveFatalWarning("re-metrics-reserve-rows-unavailable", `${chain} reserve rows unavailable; composition withheld`));
      continue;
    }
    const asOf = parseTimestampLikeToUnixSeconds(breakdown.asOf);
    let hasValue = false;
    for (const [index, row] of breakdown.rows.entries()) {
      const tokenSymbol = typeof row?.tokenSymbol === "string" ? row.tokenSymbol.trim() : "";
      const valueUsd = parseValueUsdFromWei(row?.valueWei);
      const reason = !tokenSymbol ? "identity-unavailable"
        : row?.valueKnown !== true ? "valuation-unavailable"
          : valueUsd == null ? "amount-unavailable" : null;
      if (reason) {
        incompleteComposition = true;
        warnings.push(reserveFatalWarning(
          `re-metrics-reserve-${reason}`,
          `${chain} reserve row ${index} (${tokenSymbol || "missing identity"}) is incomplete; composition withheld`,
        ));
        continue;
      }
      if (valueUsd === 0 || valueUsd == null) continue;
      hasValue = true;
      const key = normalizeTokenSymbol(tokenSymbol);
      tokenValues.set(key, (tokenValues.get(key) ?? 0) + valueUsd);
    }
    if (hasValue) {
      if (asOf != null) componentTimestamps.push(asOf);
      else missingComponentTimestamp = true;
    }
  }
  const stableRedeemableUsd = ["usdc", "usdt", "dai", "frax"]
    .reduce((sum, symbol) => sum + (tokenValues.get(symbol) ?? 0), 0);

  const slices = incompleteComposition ? [] : slicesFromValues([
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

  if (!incompleteComposition && slices.length === 0) {
    throw htmlLayoutChangedError("re-metrics", "no reserve composition entries found");
  }

  // Every component contributing to the mix needs its own freshness evidence.
  if (offchainCapitalUsd != null && offchainCapitalUsd > 0) {
    if (offchainTimestamp != null) componentTimestamps.push(offchainTimestamp);
    else missingComponentTimestamp = true;
  }
  if (missingComponentTimestamp) {
    warnings.push(reserveDegradedWarning(
      "re-metrics-component-undated",
      "A contributing reserve component has no trustworthy source timestamp",
    ));
  }
  const sourceTimestamp = !incompleteComposition && !missingComponentTimestamp && componentTimestamps.length > 0
    ? Math.min(...componentTimestamps)
    : null;

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      chainBreakdownCount: Object.keys(breakdowns).length,
      ...(typeof offchainCapitalUsd === "number" && Number.isFinite(offchainCapitalUsd) && offchainCapitalUsd >= 0
        ? { offchainCapitalUsd } : {}),
      ...(offchainTimestamp != null ? { offchainAsOf: offchainTimestamp } : {}),
      trackedTokenCount: tokenValues.size,
      ...(componentTimestamps.length > 0 ? { newestSourceTimestamp: Math.max(...componentTimestamps) } : {}),
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "nextjs-embedded-payload",
        "Re Metrics embedded payload did not expose a trustworthy source timestamp",
      ),
      ...(!incompleteComposition ? { stableAssetUsd: stableRedeemableUsd } : {}),
      ...(instantRedemptionCapacity
        ? {
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
