import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import type { OnchainRateProbe } from "./helpers";
import {
  buildRedemptionSnapshotMetadata,
  fetchJsonWithRetry,
  getJsonPath,
  isHttpJsonInput,
  parsePositiveNumericLike,
  parseTimestampLikeToUnixSeconds,
  probeOptionalRedemptionRateBps,
  probeOnchainTotalSupply,
  requireOnchainInput,
  notApplicableFreshnessMetadata,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
} from "./helpers";

interface JsonPathProbe {
  kind: "json-path";
  path: string[];
  scale?: number;
}

interface SingleAssetParams {
  label: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  probe?: JsonPathProbe;
  reserveProbe?: JsonPathProbe;
  supplyProbe?: JsonPathProbe;
  timestampProbe?: JsonPathProbe;
  reserveSourceLabel?: string;
  redemptionRateProbe?: OnchainRateProbe;
}

function readParams(config: LiveReservesConfig): SingleAssetParams {
  return parseLiveReserveAdapterParams("single-asset", config.params);
}

function readScaledProbeValue(payload: Record<string, unknown>, probe: JsonPathProbe, label: string): number {
  const rawValue = getJsonPath(payload, probe.path);
  const parsed = parsePositiveNumericLike(rawValue);
  if (parsed == null) {
    throw new Error(`single-asset source returned zero/empty ${label} probe value`);
  }
  const scale = probe.scale ?? 1;
  return parsed / scale;
}

export async function fetchSingleAssetReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = readParams(config);
  const primary = config.inputs.primary;

  if (isHttpJsonInput(primary)) {
    const reserveProbe = params.reserveProbe ?? params.probe;
    if (!reserveProbe && !params.supplyProbe) {
      throw new Error("single-asset http-json mode requires params.probe/reserveProbe or params.supplyProbe");
    }
    const payload = await fetchJsonWithRetry<Record<string, unknown>>(
      primary.url,
      signal,
      12_000,
      ctx,
    );
    const totalReserveUsd = reserveProbe
      ? readScaledProbeValue(payload, reserveProbe, "reserve")
      : null;
    const supplyUsd = params.supplyProbe
      ? readScaledProbeValue(payload, params.supplyProbe, "supply")
      : null;
    const timestampRaw = params.timestampProbe
      ? getJsonPath(payload, params.timestampProbe.path)
      : null;
    const sourceTimestamp = params.timestampProbe
      ? parseTimestampLikeToUnixSeconds(timestampRaw)
      : null;

    if (params.timestampProbe && sourceTimestamp == null) {
      throw new Error("single-asset source returned unreadable timestamp probe value");
    }

    const freshnessMetadata = sourceTimestamp != null
      ? verifiedFreshnessMetadata(sourceTimestamp)
      : unverifiedFreshnessMetadata(
          "single-asset-json-probe",
          "The configured single-asset reserve probe does not include a trustworthy source timestamp",
        );

    return {
      slices: [{
        name: params.label,
        pct: 100,
        risk: params.risk,
        ...(params.coinId ? { coinId: params.coinId } : {}),
        ...(params.depType ? { depType: params.depType } : {}),
      }],
      metadata: {
        ...freshnessMetadata,
        ...(totalReserveUsd != null ? { totalReserveUsd } : {}),
        ...(supplyUsd != null ? { supplyUsd } : {}),
        ...(totalReserveUsd != null && supplyUsd != null && supplyUsd > 0
          ? { collateralizationRatio: totalReserveUsd / supplyUsd }
          : {}),
        ...buildRedemptionSnapshotMetadata({
          capacityKind: "documented-bound",
          freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" : "unverified",
          ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
          routeStatus: "unknown",
        }),
        details: {
          proofKind: totalReserveUsd != null && supplyUsd != null
            ? "reserve-and-supply-probe"
            : "single-asset-liveness-probe",
          reserveSourceLabel: params.reserveSourceLabel ?? params.label,
        },
      },
    };
  } else {
    const onchainInput = requireOnchainInput(primary, "single-asset");
    const supplyProbe = probeOnchainTotalSupply(
      coin,
      onchainInput,
      signal,
      "single-asset",
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    );
    const redemptionFeeProbe = probeOptionalRedemptionRateBps(
      onchainInput,
      params.redemptionRateProbe,
      signal,
      ctx,
      params.rpcUrl,
      params.fallbackRpcUrl,
    );

    const [, redemptionFeeBps] = await Promise.all([supplyProbe, redemptionFeeProbe]);

    return {
      slices: [{
        name: params.label,
        pct: 100,
        risk: params.risk,
        ...(params.coinId ? { coinId: params.coinId } : {}),
        ...(params.depType ? { depType: params.depType } : {}),
      }],
      metadata: {
        ...notApplicableFreshnessMetadata({
          proofKind: "erc20-total-supply-liveness",
          reserveSourceLabel: params.reserveSourceLabel ?? params.label,
        }),
        ...buildRedemptionSnapshotMetadata({
          capacityKind: "documented-bound",
          freshnessKind: "same-run-onchain",
          routeStatus: "unknown",
          feeBps: redemptionFeeBps,
        }),
      },
    };
  }
}
