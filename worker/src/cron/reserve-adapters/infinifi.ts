import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildRedemptionSnapshotMetadata,
  buildUnknownExposureWarning,
  catchAndWarn,
  fetchJsonWithRetry,
  normalizeSlices,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";
import { cefiPositionMeta, wrapperAssetMeta } from "./wrapper-assets";

interface InfiniFiFarm {
  name: string;
  label: string;
  assetsNormalized: number;
  type: "LIQUID" | "ILLIQUID" | "PROTOCOL";
  underlyingAssetSymbol: string;
}

export interface InfiniFiProtocolData {
  code: string;
  data: {
    stats: {
      asset: {
        totalTVLAssetNormalized: number;
        totalLiquidAssetNormalized?: number;
        totalIlliquidAssetNormalized?: number;
        pendingRedemptionsAssetNormalized?: number;
      };
      staked?: {
        exchangeRateNormalized?: number;
      };
    };
    receipt?: {
      totalSupplyNormalized?: number;
    };
    farms: InfiniFiFarm[];
  };
}

export interface InfiniFiRateHistoryResponse {
  code: string;
  data?: {
    dataPoints?: Array<{ time?: number; value?: number }>;
  };
}

interface FarmRiskConfig {
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  blacklistable?: boolean;
}

const FARM_RISK_MAP: Record<string, FarmRiskConfig> = {
  "fasanara-rwa-farm":       { risk: "high", ...cefiPositionMeta() },
  "fasanara-gdaf":           { risk: "high", ...cefiPositionMeta() },
  "falconx-farm":            { risk: "high", ...cefiPositionMeta() },
  "morpho-v2-sentora-pyusd": { risk: "high", ...wrapperAssetMeta("pyusd") },
  "maple-farm-institutional": { risk: "high", ...cefiPositionMeta() },
  "maple-farm-syrup":        { risk: "high", ...wrapperAssetMeta("usdc") },
  "spark-sUSDC-refcode":     { risk: "low", ...wrapperAssetMeta("usdc") },
  "fluid-fUSDC":             { risk: "low", ...wrapperAssetMeta("usdc") },
  "aavev3":                  { risk: "low", ...wrapperAssetMeta("usdc") },
  "aavev3-horizon-usdc":     { risk: "low", ...wrapperAssetMeta("usdc") },
  "aavev3-rlusd-farm":       { risk: "low", ...wrapperAssetMeta("usdc") },
  "euler-sentora-usdc":      { risk: "low", ...wrapperAssetMeta("usdc") },
  "morpho-steakUSDCinfinifi": { risk: "medium", ...wrapperAssetMeta("usdc") },
  "capfarm":                 { risk: "medium", coinId: "stcusd-cap", depType: "collateral" },
  SwapFarm:                  { risk: "low" },
  "tokemak-autoUSD":         { risk: "medium" },
  "tokemak-auto-infinifiUSD": { risk: "medium" },
  "gauntlet-alpha-farm":     { risk: "medium" },
  "reservoir-wsrUSD":        { risk: "medium" },
  "sGHO":                    { risk: "medium", coinId: "sgho-aave", depType: "collateral" },
  "liquid-cap":              { risk: "medium", coinId: "stcusd-cap", depType: "collateral" },
  "cowswap-fxSave":          { risk: "medium" },
  "pendle-v3-PT-apxUSD-18JUN2026": { risk: "high", coinId: "apxusd-apyx", depType: "collateral" },
  "pendle-v3-PT-apyUSD-18JUN2026": { risk: "high", coinId: "apyusd-apyx", depType: "collateral" },
  "new-silver-junior":       { risk: "high", ...cefiPositionMeta() },
  "morpho-v2-sentora-prime": { risk: "high", coinId: "pyusd-paypal", depType: "collateral" },
};

const SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT = 0.5;

// The protocol /data payload exposes no timestamp of its own. The transparency
// dashboard's siUSD rate-history series is written by the same backend
// snapshotter on a 2-hour cadence; its latest point timestamps that snapshot,
// and matching its value against the live staked exchange rate ties the
// timestamp to the reserve state we are reporting. History values are rounded
// to 4 decimals, so the tolerance covers rounding plus sub-cadence yield drift.
export const INFINIFI_RATE_HISTORY_PATH = "/api/protocol/rate-history/siUSD?daysAgo=7";
const RATE_CROSS_CHECK_TOLERANCE = 5e-4;
const RATE_HISTORY_PROBE_TIMEOUT_MS = 6_000;

export function resolveInfiniFiFreshness(
  payload: InfiniFiProtocolData,
  rateHistory: InfiniFiRateHistoryResponse | null,
):
  | { sourceTimestamp: number; freshnessMode: "verified" }
  | { freshnessMode: "unverified"; details: { freshnessSource: string; freshnessReason: string } } {
  const points = rateHistory?.code === "OK" ? rateHistory.data?.dataPoints ?? [] : [];
  let latest: { time: number; value: number } | null = null;
  for (const point of points) {
    if (
      typeof point.time === "number" && Number.isFinite(point.time)
      && typeof point.value === "number" && Number.isFinite(point.value)
    ) {
      latest = { time: point.time, value: point.value };
    }
  }
  if (latest == null) {
    return unverifiedFreshnessMetadata(
      "protocol-stats-api",
      "InfiniFi protocol stats payload does not expose a trustworthy source timestamp",
    );
  }

  const liveRate = payload.data.stats.staked?.exchangeRateNormalized;
  if (
    typeof liveRate !== "number"
    || !Number.isFinite(liveRate)
    || Math.abs(liveRate - latest.value) > RATE_CROSS_CHECK_TOLERANCE
  ) {
    return unverifiedFreshnessMetadata(
      "protocol-stats-api",
      "InfiniFi siUSD rate-history freshness probe diverged from the live staked exchange rate",
    );
  }

  const sourceTimestamp = parseTimestampLikeToUnixSeconds(latest.time);
  if (sourceTimestamp == null) {
    return unverifiedFreshnessMetadata(
      "protocol-stats-api",
      "InfiniFi siUSD rate-history latest point carried an unreadable timestamp",
    );
  }
  return verifiedFreshnessMetadata(sourceTimestamp);
}

export interface AdaptInfiniFiResult {
  slices: ReserveSlice[];
  /** Farm names not found in FARM_RISK_MAP (for operator awareness). */
  unknownFarms: string[];
  unknownExposurePct: number;
  sourceTotalGapPct: number;
  excludedProtocolFarms: string[];
  activeFarmCount: number;
  immediateRedeemableUsd: number;
  supplyUsd?: number;
}

/** Convert raw InfiniFi protocol data to ReserveSlice[]. Pure function — no I/O. */
export function adaptInfiniFi(payload: InfiniFiProtocolData): AdaptInfiniFiResult {
  const tvl = payload.data.stats.asset.totalTVLAssetNormalized;
  if (!tvl || tvl <= 0) {
    return {
      slices: [],
      unknownFarms: [],
      unknownExposurePct: 0,
      sourceTotalGapPct: 0,
      excludedProtocolFarms: [],
      activeFarmCount: 0,
      immediateRedeemableUsd: payload.data.stats.asset.totalLiquidAssetNormalized ?? 0,
      ...(payload.data.receipt?.totalSupplyNormalized != null ? { supplyUsd: payload.data.receipt.totalSupplyNormalized } : {}),
    };
  }

  const activeFarms = payload.data.farms.filter(
    (f) => f.type !== "PROTOCOL" && f.assetsNormalized > 0,
  );
  const excludedProtocolFarms = payload.data.farms.filter(
    (f) => f.type === "PROTOCOL" && f.assetsNormalized > 0,
  );
  const activeFarmTotal = activeFarms.reduce((sum, farm) => sum + farm.assetsNormalized, 0);
  const sourceTotalGapUsd = Math.max(0, tvl - activeFarmTotal);
  const sourceTotalGapPct = (sourceTotalGapUsd / tvl) * 100;

  const unknownFarms: string[] = [];
  let unknownExposurePct = 0;

  const rawSlices: ReserveSlice[] = [];

  for (const f of activeFarms) {
    const pct = (f.assetsNormalized / tvl) * 100;
    const config = FARM_RISK_MAP[f.name];
    if (!config) {
      unknownFarms.push(f.name);
      unknownExposurePct += pct;
    }
    const risk: ReserveSlice["risk"] = config?.risk
      ?? (f.type === "LIQUID" ? "low" : "medium");
    rawSlices.push({
      name: f.label,
      pct,
      risk,
      ...(config?.coinId ? { coinId: config.coinId } : {}),
      ...(config?.depType ? { depType: config.depType } : {}),
      ...(config?.blacklistable != null ? { blacklistable: config.blacklistable } : {}),
    } satisfies ReserveSlice);
  }

  if (sourceTotalGapPct > SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT) {
    rawSlices.push({
      name: excludedProtocolFarms.length > 0
        ? "InfiniFi protocol-level reserve positions"
        : "Unmapped InfiniFi TVL gap",
      pct: sourceTotalGapPct,
      risk: "high",
    });
  }

  return {
    slices: normalizeSlices(rawSlices),
    unknownFarms,
    unknownExposurePct,
    sourceTotalGapPct,
    excludedProtocolFarms: excludedProtocolFarms.map((farm) => farm.name).sort(),
    activeFarmCount: activeFarms.length,
    immediateRedeemableUsd: payload.data.stats.asset.totalLiquidAssetNormalized ?? 0,
    ...(payload.data.receipt?.totalSupplyNormalized != null ? { supplyUsd: payload.data.receipt.totalSupplyNormalized } : {}),
  };
}

/** Fetch + adapt infiniFi protocol data. Uses fetchWithRetry for resilience. */
export async function fetchInfiniFiReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "infinifi");

  const url = primaryInput.url;
  const payload = await fetchJsonWithRetry<InfiniFiProtocolData>(url, signal, 12_000, ctx);
  if (payload.code !== "OK") throw new Error("infiniFi API returned non-OK code");
  const adapted = adaptInfiniFi(payload);
  const warnings: LiveReserveWarning[] = adapted.unknownFarms.length > 0
    ? [buildUnknownExposureWarning({
        code: "unknown-position",
        message: `Unmapped reserve positions: ${adapted.unknownFarms.sort().join(", ")}`,
        unknownExposurePct: adapted.unknownExposurePct,
      })]
    : [];
  if (adapted.sourceTotalGapPct > SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT) {
    warnings.push(buildUnknownExposureWarning({
      code: "source-total-gap",
      message: adapted.excludedProtocolFarms.length > 0
        ? `InfiniFi PROTOCOL farm exposure excluded from mapped farm rows: ${adapted.excludedProtocolFarms.join(", ")}`
        : "InfiniFi total TVL exceeds mapped active farm assets",
      unknownExposurePct: adapted.sourceTotalGapPct,
      thresholdPct: SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT,
    }));
  }

  // The freshness probe is optional context: bound it to a hard 6s overall
  // budget (including retries) so a slow probe can never push the attempt past
  // the orchestrator's 20s wall and cost us an otherwise-good snapshot.
  const rateHistoryUrl = new URL(INFINIFI_RATE_HISTORY_PATH, url).toString();
  const rateHistory = await catchAndWarn(
    fetchJsonWithRetry<InfiniFiRateHistoryResponse>(
      rateHistoryUrl,
      AbortSignal.any([signal, AbortSignal.timeout(RATE_HISTORY_PROBE_TIMEOUT_MS)]),
      RATE_HISTORY_PROBE_TIMEOUT_MS,
      ctx,
    ),
    "freshness-probe-failed",
    "InfiniFi siUSD rate-history freshness probe",
    warnings,
  );
  const freshness = resolveInfiniFiFreshness(payload, rateHistory);

  const totalReserveUsd = payload.data.stats.asset.totalTVLAssetNormalized;
  const illiquidReserveUsd = payload.data.stats.asset.totalIlliquidAssetNormalized ?? 0;

  return {
    slices: adapted.slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      farmCount: payload.data.farms.length,
      activeFarmCount: adapted.activeFarmCount,
      unknownFarmCount: adapted.unknownFarms.length,
      unknownExposurePct: adapted.unknownExposurePct,
      sourceTotalGapPct: adapted.sourceTotalGapPct,
      ...(adapted.excludedProtocolFarms.length > 0 ? { excludedProtocolFarms: adapted.excludedProtocolFarms } : {}),
      ...freshness,
      totalReserveUsd,
      immediateRedeemableUsd: adapted.immediateRedeemableUsd,
      illiquidReserveUsd,
      ...(adapted.supplyUsd != null && adapted.supplyUsd > 0
        ? { immediateRedeemableRatio: adapted.immediateRedeemableUsd / adapted.supplyUsd }
        : {}),
      pendingRedemptionsUsd:
        payload.data.stats.asset.pendingRedemptionsAssetNormalized,
      ...(adapted.supplyUsd != null ? { supplyUsd: adapted.supplyUsd } : {}),
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: adapted.immediateRedeemableUsd,
        ...(adapted.supplyUsd != null && adapted.supplyUsd > 0
          ? { capacityRatioOfSupply: adapted.immediateRedeemableUsd / adapted.supplyUsd }
          : {}),
        capacityKind: "live-queue",
        ...(freshness.freshnessMode === "verified"
          ? { freshnessKind: "verified-source-timestamp" as const, sourceTimestamp: freshness.sourceTimestamp }
          : { freshnessKind: "unverified" as const }),
        routeStatus: "unknown",
        routeStatusSource: "protocol-api",
        ...(payload.data.stats.asset.pendingRedemptionsAssetNormalized != null
          ? { queueDepthUsd: payload.data.stats.asset.pendingRedemptionsAssetNormalized }
          : {}),
        sourceUrls: [url],
      }),
    },
  };
}
