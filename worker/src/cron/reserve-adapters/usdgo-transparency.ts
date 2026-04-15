import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
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

export function adaptUsdgoTransparency(payload: UsdgoTransparencyPayload): AdapterResult {
  if (!payload.ok || !payload.data) {
    throw new Error("usdgo-transparency returned an invalid response");
  }

  const buidlUsd = parseMillionUsd(payload.data.buidlUsdM, "buidlUsdM");
  const stablecoinReserveFundUsd = parseMillionUsd(payload.data.gsUsdM, "gsUsdM");
  const cashUsd = parseMillionUsd(payload.data.usdUsdM, "usdUsdM");
  const totalReserveUsd = parseMillionUsd(payload.data.backingAssetsM, "backingAssetsM");
  const supplyUsd = parseMillionUsd(payload.data.circulationSupplyMFormatted, "circulationSupplyMFormatted");
  const componentTotalUsd = buidlUsd + stablecoinReserveFundUsd + cashUsd;
  if (totalReserveUsd > 0 && Math.abs(componentTotalUsd - totalReserveUsd) / totalReserveUsd > 0.01) {
    throw new Error(
      `usdgo-transparency reserve components sum to ${componentTotalUsd.toFixed(2)}, expected ${totalReserveUsd.toFixed(2)}`,
    );
  }

  const publishedRatio = typeof payload.data.collateralizationRatio === "number"
    ? payload.data.collateralizationRatio / 100
    : null;
  const derivedRatio = supplyUsd > 0 ? totalReserveUsd / supplyUsd : null;
  if (
    publishedRatio != null
    && derivedRatio != null
    && Math.abs(publishedRatio - derivedRatio) / publishedRatio > 0.02
  ) {
    throw new Error(
      `usdgo-transparency collateralization ratio ${publishedRatio.toFixed(6)} `
      + `does not match derived ratio ${derivedRatio.toFixed(6)}`,
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
      ...(publishedRatio != null ? { publishedCollateralizationRatio: publishedRatio } : {}),
      ...(derivedRatio != null ? { collateralizationRatio: derivedRatio } : {}),
      sourceProvenance:
        "Public USDGO transparency endpoint. Kept proof-class until field provenance, date freshness, and per-slice risk evidence are methodology-approved.",
    },
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
