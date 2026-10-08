import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig, NativeReserveQuantityBasis } from "@shared/types/live-reserves";
import {
  parseLiveReserveAdapterParams,
} from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  fetchJsonWithRetry,
  unverifiedFreshnessMetadata,
  getJsonPath,
  isHttpJsonInput,
  parsePositiveNumericLike,
  parseTimestampLikeToUnixSeconds,
  probeOnchainTotalSupply,
  requireOnchainInput,
  notApplicableFreshnessMetadata,
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
  reserveProbe?: JsonPathProbe;
  supplyProbe?: JsonPathProbe;
  timestampProbe?: JsonPathProbe;
  reserveSourceLabel?: string;
  nativeQuantityBasis?: NativeReserveQuantityBasis;
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
  const scaled = parsed / scale;
  if (!Number.isFinite(scaled) || scaled <= 0) {
    throw new Error(`single-asset source returned invalid scaled ${label} probe value`);
  }
  return scaled;
}

export async function fetchSingleAssetReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = readParams(config);
  const primary = config.inputs.primary;
  const slices: ReserveSlice[] = [{
    name: params.label,
    pct: 100,
    risk: params.risk,
    ...(params.coinId ? { coinId: params.coinId } : {}),
    ...(params.depType ? { depType: params.depType } : {}),
  }];

  if (isHttpJsonInput(primary)) {
    const reserveProbe = params.reserveProbe;
    if (!reserveProbe && !params.supplyProbe) {
      throw new Error("single-asset http-json mode requires params.reserveProbe or params.supplyProbe");
    }
    const payload = await fetchJsonWithRetry<Record<string, unknown>>(
      primary.url,
      signal,
      12_000,
      ctx,
    );
    const totalReserveQuantity = reserveProbe
      ? readScaledProbeValue(payload, reserveProbe, "reserve")
      : null;
    const supplyTokens = params.supplyProbe
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

    const freshnessMetadata = unverifiedFreshnessMetadata(
      "single-asset-json-probe",
      "The issuer quantity probe does not provide a whole-reserve observation clock; any configured timestamp describes chain supply only",
    );
    const basis = params.nativeQuantityBasis;
    const nominalValue = basis?.supplyToken === coin.symbol ? basis.nominalValuePerToken : undefined;
    const collateralizationRatio = totalReserveQuantity != null && supplyTokens != null && nominalValue != null
      ? totalReserveQuantity / (supplyTokens * nominalValue)
      : null;
    const warnings = buildCoverageShortfallWarnings({
      code: "reserve-undercollateralized",
      message: (pct) => `Single-asset reserve probe covers ${pct}% of observed supply`,
      coverageRatio: collateralizationRatio,
    });

    return {
      slices,
      ...(warnings.length > 0 ? { warnings } : {}),
      metadata: {
        ...freshnessMetadata,
        ...(totalReserveQuantity != null ? { totalReserveQuantity } : {}),
        ...(supplyTokens != null ? { supplyTokens } : {}),
        ...(basis ? { nativeQuantityBasis: basis } : {}),
        ...(collateralizationRatio != null
          ? { collateralizationRatio }
          : {}),
        details: {
          ...freshnessMetadata.details,
          proofKind: totalReserveQuantity != null && supplyTokens != null
            ? "reserve-and-supply-probe"
            : "single-asset-liveness-probe",
          reserveSourceLabel: params.reserveSourceLabel ?? params.label,
          ...(sourceTimestamp != null ? {
            chainSupplyObservedAt: sourceTimestamp,
            chainSupplyTimestampPath: params.timestampProbe?.path,
          } : {}),
          quantityScope: "issuer-reported; configured bucket is not measured portfolio composition",
        },
      },
    };
  }

  const onchainInput = requireOnchainInput(primary, "single-asset");
  await probeOnchainTotalSupply(
    coin,
    onchainInput,
    signal,
    "single-asset",
    ctx,
    params.rpcUrl,
    params.fallbackRpcUrl,
  );

  return {
    slices,
    metadata: {
      ...notApplicableFreshnessMetadata({
        proofKind: "erc20-total-supply-liveness",
        reserveSourceLabel: params.reserveSourceLabel ?? params.label,
      }),
    },
  };
}
