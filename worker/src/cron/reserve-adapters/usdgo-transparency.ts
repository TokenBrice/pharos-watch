import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  reserveInfoWarning,
  slicesFromValues,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";

interface UsdgoTransparencyPayload {
  ok?: boolean;
  data?: {
    collateralizationRatio?: number;
    buidlUsdM?: string | number;
    gsUsdM?: string | number;
    jltxxUsdM?: string | number;
    usdUsdM?: string | number;
    backingAssetsM?: string | number;
    circulationSupplyMFormatted?: string | number;
    lastUpdated?: string;
  };
}

function parseMillionUsd(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`usdgo-transparency invalid ${label}`);
  }
  return parsed * 1_000_000;
}

function parseOptionalMillionUsd(value: unknown, label: string): number {
  if (value == null) return 0;
  return parseMillionUsd(value, label);
}

function normalizePublishedCollateralizationRatio(value: unknown): {
  ratio: number | null;
  format: "total-percent" | "excess-percent" | "raw-ratio" | null;
} {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ratio: null, format: null };
  }

  if (value >= 50) {
    return { ratio: value / 100, format: "total-percent" };
  }

  return { ratio: 1 + value / 100, format: "excess-percent" };
}

function resolvePublishedCollateralizationRatio(
  value: unknown,
  derivedRatio: number | null,
): {
  ratio: number | null;
  format: "total-percent" | "excess-percent" | "raw-ratio" | null;
} {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ratio: null, format: null };
  }

  if (derivedRatio == null) {
    return normalizePublishedCollateralizationRatio(value);
  }

  return [
    { ratio: value / 100, format: "total-percent" as const },
    { ratio: 1 + value / 100, format: "excess-percent" as const },
    { ratio: value, format: "raw-ratio" as const },
  ]
    .filter((candidate) => candidate.ratio > 0)
    .sort(
      (left, right) =>
        Math.abs(left.ratio - derivedRatio) / left.ratio - Math.abs(right.ratio - derivedRatio) / right.ratio,
    )[0];
}

export function adaptUsdgoTransparency(payload: UsdgoTransparencyPayload): AdapterResult {
  if (!payload.ok || !payload.data) {
    throw new Error("usdgo-transparency returned an invalid response");
  }

  const buidlUsd = parseMillionUsd(payload.data.buidlUsdM, "buidlUsdM");
  const stablecoinReserveFundUsd = parseMillionUsd(payload.data.gsUsdM, "gsUsdM");
  const jpmorganLiquidityTokenUsd = parseOptionalMillionUsd(payload.data.jltxxUsdM, "jltxxUsdM");
  const cashUsd = parseMillionUsd(payload.data.usdUsdM, "usdUsdM");
  const totalReserveUsd = parseMillionUsd(payload.data.backingAssetsM, "backingAssetsM");
  const supplyUsd = parseMillionUsd(payload.data.circulationSupplyMFormatted, "circulationSupplyMFormatted");
  const componentTotalUsd = buidlUsd + stablecoinReserveFundUsd + jpmorganLiquidityTokenUsd + cashUsd;
  if (totalReserveUsd > 0 && Math.abs(componentTotalUsd - totalReserveUsd) / totalReserveUsd > 0.01) {
    throw new Error(
      `usdgo-transparency reserve components sum to ${componentTotalUsd.toFixed(2)}, expected ${totalReserveUsd.toFixed(2)}`,
    );
  }

  const derivedRatio = supplyUsd > 0 ? totalReserveUsd / supplyUsd : null;
  const publishedRatio = resolvePublishedCollateralizationRatio(payload.data.collateralizationRatio, derivedRatio);
  if (
    publishedRatio.ratio != null &&
    derivedRatio != null &&
    Math.abs(publishedRatio.ratio - derivedRatio) / publishedRatio.ratio > 0.02
  ) {
    throw new Error(
      `usdgo-transparency collateralization ratio ${publishedRatio.ratio.toFixed(6)} ` +
        `does not match derived ratio ${derivedRatio.toFixed(6)}`,
    );
  }

  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.data.lastUpdated);

  return {
    slices: slicesFromValues([
      {
        name: "BlackRock BUIDL",
        value: buidlUsd,
        risk: "low",
        coinId: "buidl-blackrock",
      },
      {
        name: "Goldman Sachs Stablecoin Reserves Fund (STBXX)",
        value: stablecoinReserveFundUsd,
        risk: "low",
      },
      {
        name: "JPMorgan OnChain Liquidity-Token Money Market Fund (JLTXX)",
        value: jpmorganLiquidityTokenUsd,
        risk: "low",
      },
      {
        name: "Cash / USD deposits",
        value: cashUsd,
        risk: "very-low",
      },
    ]),
    metadata: {
      ...(sourceTimestamp != null
        ? verifiedFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "usdgo-transparency-api",
            "USDGO transparency payload did not expose a trustworthy source timestamp",
          )),
      totalReserveUsd,
      supplyUsd,
      componentTotalUsd,
      ...(publishedRatio.ratio != null ? { publishedCollateralizationRatio: publishedRatio.ratio } : {}),
      ...(publishedRatio.format != null ? { publishedCollateralizationRatioFormat: publishedRatio.format } : {}),
      ...(derivedRatio != null ? { collateralizationRatio: derivedRatio } : {}),
      sourceProvenance:
        "Public USDGO transparency endpoint. Kept proof-class until field provenance, date freshness, and per-slice risk evidence are methodology-approved.",
    },
    ...(publishedRatio.format === "excess-percent"
      ? {
          warnings: [
            reserveInfoWarning(
              "usdgo-collateralization-ratio-excess-percent",
              "USDGO transparency collateralizationRatio is reported as excess backing percent; normalized against derived reserve/supply ratio.",
            ),
          ],
        }
      : {}),
  };
}

export async function fetchUsdgoTransparencyReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInputFromConfig(config, "usdgo-transparency");
  const payload = await fetchJsonWithRetry<UsdgoTransparencyPayload>(input.url, signal, 12_000, ctx);
  return adaptUsdgoTransparency(payload);
}
