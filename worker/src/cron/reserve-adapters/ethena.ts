import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig, LiveReserveWarning } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  accumulateBucketedExposure,
  buildBucketSlices,
  fetchJsonWithRetry,
  requireJsonInputFromConfig,
  reserveDegradedWarning,
  SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC,
  summarizeSourceTimestamps,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";
import { buildBrowserHeaders } from "./request";

interface EthenaCollateralRow {
  asset: string;
  exchange: string;
  timestamp: number;
  usdAmount: number;
}

export interface EthenaCollateralResponse {
  collateral: EthenaCollateralRow[];
  totalBackingAssetsInUsd: number;
}

type EthenaBucket = "stable" | "btc" | "eth" | "other";

const ETHENA_ETH_ASSETS = new Set(["ETH", "stETH", "WBETH", "mETH", "LsETH"]);
const ETHENA_BTC_ASSETS = new Set(["BTC"]);
const ETHENA_STABLE_ASSETS = new Set(["Liquid Cash"]);
const ETHENA_OTHER_ASSETS = new Set(["SOL", "XRP", "BNB", "HYPE"]);
const ETHENA_BROWSER_HEADERS = buildBrowserHeaders(
  "https://app.ethena.fi",
  "https://app.ethena.fi/dashboards/transparency",
);

function bucketForEthenaAsset(asset: string): EthenaBucket {
  if (ETHENA_STABLE_ASSETS.has(asset)) return "stable";
  if (ETHENA_BTC_ASSETS.has(asset)) return "btc";
  if (ETHENA_ETH_ASSETS.has(asset)) return "eth";
  return "other";
}

export function listUnexpectedEthenaAssets(payload: EthenaCollateralResponse): string[] {
  const knownAssets = new Set([
    ...ETHENA_STABLE_ASSETS,
    ...ETHENA_BTC_ASSETS,
    ...ETHENA_ETH_ASSETS,
    ...ETHENA_OTHER_ASSETS,
  ]);

  return Array.from(new Set(payload.collateral.map((row) => row.asset)))
    .filter((asset) => !knownAssets.has(asset));
}

export function adaptEthenaCollateral(
  payload: EthenaCollateralResponse,
  _sourceUrl?: string,
): AdapterResult {
  const knownAssets = new Set([
    ...ETHENA_STABLE_ASSETS,
    ...ETHENA_BTC_ASSETS,
    ...ETHENA_ETH_ASSETS,
    ...ETHENA_OTHER_ASSETS,
  ]);

  const {
    bucketTotals,
    totalValue: computedTotalBackingAssetsInUsd,
    unknownValue: unknownExposureUsd,
  } = accumulateBucketedExposure({
    items: payload.collateral,
    getValue: (row) => row.usdAmount,
    getBucket: (row) => bucketForEthenaAsset(row.asset),
    isUnknown: (row) => !knownAssets.has(row.asset),
  });

  if (
    payload.totalBackingAssetsInUsd > 0
    && Math.abs(computedTotalBackingAssetsInUsd - payload.totalBackingAssetsInUsd) / payload.totalBackingAssetsInUsd > 0.02
  ) {
    throw new Error(
      `Ethena collateral total ${computedTotalBackingAssetsInUsd.toFixed(2)} does not match totalBackingAssetsInUsd ${payload.totalBackingAssetsInUsd.toFixed(2)}`,
    );
  }

  const { slices } = buildBucketSlices(
    bucketTotals,
    [
      {
        name: "Liquid Cash strategy basket",
        bucket: "stable",
        risk: "medium",
      },
      {
        name: "BTC collateral",
        bucket: "btc",
        risk: "medium",
      },
      {
        name: "ETH / liquid staking collateral",
        bucket: "eth",
        risk: "medium",
      },
      {
        name: "Other crypto collateral",
        bucket: "other",
        risk: "high",
      },
    ],
    "stable",
  );

  const assetCount = new Set(payload.collateral.map((row) => row.asset)).size;
  const timestampSummary = summarizeSourceTimestamps(
    payload.collateral
      .filter((row) => Number.isFinite(row.usdAmount) && row.usdAmount > 0)
      .map((row) => row.timestamp),
  );
  const lastUpdatedAt = timestampSummary?.latestSourceTimestamp ?? 0;
  const warnings: LiveReserveWarning[] = [];
  if (
    timestampSummary
    && timestampSummary.sourceTimestampSpreadSec > SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC
  ) {
    warnings.push(reserveDegradedWarning(
      "source-timestamp-spread",
      `Ethena material collateral rows span ${timestampSummary.sourceTimestampSpreadSec}s of source timestamps`,
    ));
  }

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      assetCount,
      computedTotalBackingAssetsInUsd,
      totalBackingAssetsInUsd: payload.totalBackingAssetsInUsd,
      lastUpdatedAt,
      ...(timestampSummary
        ? {
            ...verifiedFreshnessMetadata(timestampSummary.sourceTimestamp),
            latestRowUpdatedAt: timestampSummary.latestSourceTimestamp,
            sourceTimestampSpreadSec: timestampSummary.sourceTimestampSpreadSec,
            sourceTimestampCount: timestampSummary.timestampCount,
          }
        : unverifiedFreshnessMetadata(
            "issuer-api",
            "Ethena collateral rows did not expose a trustworthy source timestamp",
          )),
      unknownExposurePct:
        computedTotalBackingAssetsInUsd > 0
          ? (unknownExposureUsd / computedTotalBackingAssetsInUsd) * 100
          : 0,
    },
  };
}

export async function fetchEthenaReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "ethena");
  const payload = await fetchJsonWithRetry<EthenaCollateralResponse>(
    primaryInput.url,
    signal,
    12_000,
    ctx,
    { headers: ETHENA_BROWSER_HEADERS },
  );
  const adapted = adaptEthenaCollateral(payload, primaryInput.url);
  const warnings: LiveReserveWarning[] = listUnexpectedEthenaAssets(payload).map((asset) => reserveDegradedWarning(
    "unknown-asset",
    `Ethena asset bucketed into other-crypto: ${asset}`,
  ));

  return {
    ...adapted,
    ...((adapted.warnings?.length ?? 0) + warnings.length > 0
      ? { warnings: [...(adapted.warnings ?? []), ...warnings] }
      : {}),
  };
}
