/**
 * DEWS source-state legacy compatibility bridge.
 *
 * Two distinct shape-migration concerns live here:
 *
 *   1. `stress_signals.signals_json` — older rows are flat
 *      `{ supply: { value, available }, pool: { ... } }` blobs without the
 *      `{ signals, amplifiers }` envelope introduced alongside contagion
 *      amplifier persistence. `decodeLegacyStressSignals` accepts either
 *      shape and returns the unwrapped signals map for the downstream
 *      smoothing read path.
 *
 *   2. `cache.yield-rankings` — the yield-rankings cron may emit
 *      forward-compatible fields that this consumer must coerce defensively.
 *      `normalizeYieldSourceRisk` / `normalizeYieldRankChangeAttribution`
 *      validate enum membership and discard unknown variants so future
 *      additions don't crash the DEWS run.
 *
 * Keep this bridge functional until all production rows have rolled forward
 * to the wrapped stress-signals envelope. Status today: both legacy and
 * wrapped shapes are still observed in production (see
 * `source-state-legacy.test.ts`), so this module is load-bearing.
 */

import { decodeJsonString } from "../../cache-json";
import { unwrapStressSignalsEnvelope } from "@shared/lib/stress-signals-envelope";
import type { YieldRankChangeAttribution, YieldSourceRisk } from "@shared/types/yield";
import type { PersistedJsonDecodeReason } from "../contracts";

export function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export type LegacyDecodeResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: PersistedJsonDecodeReason };

/**
 * Decodes a `stress_signals.signals_json` blob and unwraps the envelope if
 * present. Pre-envelope rows pass through unchanged; envelope rows surface as
 * `parsed.signals` for back-compat with the smoothing read path.
 */
export function decodeLegacyStressSignals(
  signalsJson: string | null,
  computedAt: number,
): LegacyDecodeResult<Record<string, { value: number }>> {
  const decoded = decodeJsonString<Record<string, unknown>, PersistedJsonDecodeReason>(signalsJson, {
    updatedAt: computedAt,
    missingReason: "missing",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => {
      const unwrapped = unwrapStressSignalsEnvelope(parsed);
      if (unwrapped == null) {
        return { ok: false, reason: "invalid-shape" as const };
      }
      return { ok: true, payload: unwrapped.signals };
    },
  });
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  return { ok: true, payload: decoded.payload as Record<string, { value: number }> };
}

export function normalizeYieldSourceRisk(value: unknown): YieldSourceRisk | null {
  const row = getObject(value);
  if (!row) return null;
  const venueRiskTier = getString(row.venueRiskTier);
  const deploymentPlace = getString(row.deploymentPlace);
  const trancheSide = getString(row.trancheSide);
  const marketStatus = getString(row.marketStatus);
  return {
    sourceRiskScore: getNumber(row.sourceRiskScore),
    sourceRiskPenalty: getNumber(row.sourceRiskPenalty),
    sourceDepthRatio: getNumber(row.sourceDepthRatio),
    rewardShare: getNumber(row.rewardShare),
    sourceAgeSeconds: getNumber(row.sourceAgeSeconds),
    observationCount30d: getNumber(row.observationCount30d),
    sourceSwitchCount30d: getNumber(row.sourceSwitchCount30d),
    deploymentPlace:
      deploymentPlace === "native-wrapper" ||
      deploymentPlace === "issuer-savings" ||
      deploymentPlace === "lending-market" ||
      deploymentPlace === "strategy-vault" ||
      deploymentPlace === "structured-tranche" ||
      deploymentPlace === "lp-or-dex" ||
      deploymentPlace === "rwa-fund" ||
      deploymentPlace === "reward-program" ||
      deploymentPlace === "rate-derived" ||
      deploymentPlace === "price-derived"
        ? deploymentPlace
        : null,
    venueProtocol: getString(row.venueProtocol),
    venueChain: getString(row.venueChain),
    venueRiskTier:
      venueRiskTier === "low" || venueRiskTier === "medium" || venueRiskTier === "high" || venueRiskTier === "unknown"
        ? venueRiskTier
        : null,
    investabilityFlags: Array.isArray(row.investabilityFlags)
      ? row.investabilityFlags.filter((flag): flag is string => typeof flag === "string")
      : [],
    trancheSide: trancheSide === "senior" || trancheSide === "junior" ? trancheSide : null,
    trancheSafetyScore: getNumber(row.trancheSafetyScore),
    trancheSafetyPenalty: getNumber(row.trancheSafetyPenalty),
    underlyingSafetyScore: getNumber(row.underlyingSafetyScore),
    marketCoverageRatio: getNumber(row.marketCoverageRatio),
    marketMinCoverageRatio: getNumber(row.marketMinCoverageRatio),
    marketUtilizationRatio: getNumber(row.marketUtilizationRatio),
    marketUtilizationLimitRatio: getNumber(row.marketUtilizationLimitRatio),
    marketDrawdownRatio: getNumber(row.marketDrawdownRatio),
    marketTotalDrawdowns: getNumber(row.marketTotalDrawdowns),
    marketStatus:
      marketStatus === "normal" ||
      marketStatus === "protected" ||
      marketStatus === "unhealthy" ||
      marketStatus === "critical"
        ? marketStatus
        : null,
    marketTvlUsd: getNumber(row.marketTvlUsd),
    trancheTvlUsd: getNumber(row.trancheTvlUsd),
    trancheShareTokenAddress: getString(row.trancheShareTokenAddress),
    trancheDepositTokenAddress: getString(row.trancheDepositTokenAddress),
    withdrawalDelaySeconds: getNumber(row.withdrawalDelaySeconds),
    kycRequired: getBoolean(row.kycRequired),
    accessRestricted: getBoolean(row.accessRestricted),
  };
}

export function normalizeYieldRankChangeAttribution(value: unknown): YieldRankChangeAttribution | null {
  const row = getObject(value);
  if (!row) return null;
  const primaryDriver = getString(row.primaryDriver);
  return {
    previousRank: getNumber(row.previousRank),
    rankDelta: getNumber(row.rankDelta),
    previousPys: getNumber(row.previousPys),
    pysDelta: getNumber(row.pysDelta),
    primaryDriver:
      primaryDriver === "apy" ||
      primaryDriver === "benchmark" ||
      primaryDriver === "stablecoin-safety" ||
      primaryDriver === "source-risk" ||
      primaryDriver === "source-switch" ||
      primaryDriver === "freshness" ||
      primaryDriver === "volatility" ||
      primaryDriver === "tvl-depth"
        ? primaryDriver
        : null,
    driverContributions: null,
  };
}
