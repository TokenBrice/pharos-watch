import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import type { OnchainRateProbe } from "./helpers";
import {
  buildCoverageShortfallWarnings,
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchJsonWithRetry,
  freshnessMetadataFromTimestamp,
  getJsonPath,
  isHttpJsonInput,
  makeOnchainCallers,
  parsePositiveNumericLike,
  parseTimestampLikeToUnixSeconds,
  probeOptionalRedemptionRateBps,
  probeOnchainTotalSupply,
  requireOnchainInput,
  reserveInfoWarning,
  notApplicableFreshnessMetadata,
} from "./helpers";
import { parseEvmAddressResult } from "./evm";
import { encodeBalanceOfCallData, encodeUint256 } from "../../lib/evm-selectors";
import { rethrowIfAborted } from "../../lib/abort";

interface JsonPathProbe {
  kind: "json-path";
  path: string[];
  scale?: number;
}

type RedemptionCapacityParams = NonNullable<
  LiveReserveAdapterParamsByKey["single-asset"]["redemptionCapacity"]
>;

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
  redemptionCapacity?: RedemptionCapacityParams;
}

interface SingleAssetRedemptionProbe {
  /** Payout float, floored by the remaining daily allowance when one is pinned. */
  capacityUsd: number;
  payoutBalanceUsd: number;
  /** `null` when the coin pinned no daily-limit getters. */
  remainingDailyLimitUsd: number | null;
  /** `null` when the coin pinned no fee getter. */
  feeBps: number | null;
  capacityReason: string;
}

/**
 * Same-run read of an opted-in coin's executable exit route: the payout float
 * the redeemer can pay out right now, floored by whatever remains of its daily
 * allowance. Every pinned identity must still resolve and every read must
 * succeed, otherwise the probe returns `null` and the caller falls back to the
 * documented bound rather than publishing an unproven live route.
 */
async function probeRedemptionCapacity(
  params: SingleAssetParams,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<SingleAssetRedemptionProbe | null> {
  const capacity = params.redemptionCapacity;
  if (!capacity) return null;

  const onchain = makeOnchainCallers(
    { chain: capacity.chain },
    { signal, ctx, rpcUrl: params.rpcUrl, fallbackRpcUrl: params.fallbackRpcUrl },
  );
  // The cap is metered on `block.timestamp / 86400`. Deriving the bucket from
  // wall-clock time can straddle a UTC midnight by a few seconds; the cap is
  // enforced on-chain regardless and capacity is additionally floored by the
  // payout balance, so a boundary run misreads the allowance, never the float.
  const currentDay = Math.floor(Date.now() / 1000 / 86_400);

  try {
    const [identityResults, payoutBalanceRaw, dailyLimitRaw, dailyUsedRaw, feeBpsRaw] = await Promise.all([
      Promise.all(capacity.identityChecks.map((check) => onchain.raw(check.contract, check.selector))),
      onchain.uint256(capacity.payoutToken.address, encodeBalanceOfCallData(capacity.redeemer)),
      capacity.dailyLimit ? onchain.uint256(capacity.redeemer, capacity.dailyLimit.limitSelector) : null,
      capacity.dailyLimit
        ? onchain.uint256(capacity.redeemer, `${capacity.dailyLimit.usedSelector}${encodeUint256(currentDay)}`)
        : null,
      capacity.feeBpsSelector ? onchain.uint256(capacity.redeemer, capacity.feeBpsSelector) : null,
    ]);

    for (const [index, check] of capacity.identityChecks.entries()) {
      const raw = identityResults[index];
      const observed = raw ? parseEvmAddressResult(raw as `0x${string}`) : null;
      if (observed !== check.expectedAddress.toLowerCase()) return null;
    }

    if (payoutBalanceRaw == null || payoutBalanceRaw < 0n) return null;
    const payoutBalanceUsd = decimalNumberFromBigInt(payoutBalanceRaw, capacity.payoutToken.decimals);
    if (!Number.isFinite(payoutBalanceUsd) || payoutBalanceUsd < 0) return null;

    let remainingDailyLimitUsd: number | null = null;
    if (capacity.dailyLimit) {
      if (dailyLimitRaw == null || dailyUsedRaw == null || dailyLimitRaw < 0n || dailyUsedRaw < 0n) return null;
      const remainingRaw = dailyLimitRaw > dailyUsedRaw ? dailyLimitRaw - dailyUsedRaw : 0n;
      remainingDailyLimitUsd = decimalNumberFromBigInt(remainingRaw, capacity.dailyLimit.decimals);
      if (!Number.isFinite(remainingDailyLimitUsd) || remainingDailyLimitUsd < 0) return null;
    }

    let feeBps: number | null = null;
    if (capacity.feeBpsSelector) {
      if (feeBpsRaw == null || feeBpsRaw < 0n || feeBpsRaw > 10_000n) return null;
      feeBps = Number(feeBpsRaw);
    }

    const capacityUsd = remainingDailyLimitUsd != null
      ? Math.min(payoutBalanceUsd, remainingDailyLimitUsd)
      : payoutBalanceUsd;
    const bound = remainingDailyLimitUsd != null && remainingDailyLimitUsd < payoutBalanceUsd
      ? "remaining daily allowance"
      : `${capacity.payoutToken.address} balance of ${capacity.redeemer}`;

    return {
      capacityUsd,
      payoutBalanceUsd,
      remainingDailyLimitUsd,
      feeBps,
      capacityReason: `${bound} read in the same run on ${capacity.chain}: ${payoutBalanceRaw.toString()} (${capacity.payoutToken.decimals} decimals)`,
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
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
  const slices: ReserveSlice[] = [{
    name: params.label,
    pct: 100,
    risk: params.risk,
    ...(params.coinId ? { coinId: params.coinId } : {}),
    ...(params.depType ? { depType: params.depType } : {}),
  }];

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

    const freshnessMetadata = freshnessMetadataFromTimestamp(
      sourceTimestamp,
      "single-asset-json-probe",
      "The configured single-asset reserve probe does not include a trustworthy source timestamp",
    );
    const collateralizationRatio = totalReserveUsd != null && supplyUsd != null && supplyUsd > 0
      ? totalReserveUsd / supplyUsd
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
        ...(totalReserveUsd != null ? { totalReserveUsd } : {}),
        ...(supplyUsd != null ? { supplyUsd } : {}),
        ...(collateralizationRatio != null
          ? { collateralizationRatio }
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

    const [, redemptionFeeBps, capacityProbe] = await Promise.all([
      supplyProbe,
      redemptionFeeProbe,
      probeRedemptionCapacity(params, signal, ctx),
    ]);

    const capacity = params.redemptionCapacity;
    const warnings: LiveReserveWarning[] = [];
    if (capacity && capacityProbe == null) {
      warnings.push(
        reserveInfoWarning(
          "single-asset-redemption-capacity-unreadable",
          `single-asset redemption probe for ${coin.id} did not return a matching identity/capacity set this run; live redemption telemetry withheld`,
        ),
      );
    }

    return {
      slices,
      ...(warnings.length > 0 ? { warnings } : {}),
      metadata: {
        ...notApplicableFreshnessMetadata({
          proofKind: "erc20-total-supply-liveness",
          reserveSourceLabel: params.reserveSourceLabel ?? params.label,
        }),
        ...buildRedemptionSnapshotMetadata(
          capacity && capacityProbe
            ? {
                capacityUsd: capacityProbe.capacityUsd,
                // The route is holder-eligibility conditioned and its fee,
                // allowance and implementation are all owner-mutable, so the
                // measurement is a bounded live read rather than live-direct.
                capacityKind: "live-direct-bounded",
                freshnessKind: "same-run-onchain",
                holderEligibility: capacity.holderEligibility,
                settlementDelaySec: 0,
                // A measured zero is no evidence the route is closed, only that
                // it cannot pay out right now, so openness is never asserted.
                ...(capacityProbe.capacityUsd > 0
                  ? {
                      routeStatus: "open" as const,
                      routeStatusSource: "onchain" as const,
                      routeStatusReason: capacityProbe.capacityReason,
                    }
                  : { routeStatus: "unknown" as const }),
                // Only published when the allowance is what actually bounds the
                // route; a cap orders of magnitude above the float is noise.
                ...(capacityProbe.remainingDailyLimitUsd != null
                  && capacityProbe.remainingDailyLimitUsd <= capacityProbe.payoutBalanceUsd
                  ? { dailyLimitUsd: capacityProbe.remainingDailyLimitUsd }
                  : {}),
                sourceUrls: [...capacity.sourceUrls],
                feeBps: capacityProbe.feeBps ?? redemptionFeeBps,
              }
            : {
                capacityKind: "documented-bound",
                freshnessKind: "same-run-onchain",
                routeStatus: "unknown",
                feeBps: redemptionFeeBps,
              },
        ),
      },
    };
  }
}
