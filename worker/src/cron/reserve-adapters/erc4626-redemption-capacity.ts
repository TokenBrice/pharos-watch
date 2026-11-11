import { decimalNumberFromBigInt } from "./helpers";
import { parseBoundedDecimals, ratioFromRaw } from "./slice-math";
import { observeFraxtalHopCapacity } from "./erc4626-capacity-fraxtal";
import type { ExecutableRedemptionObservation } from "./executable-redemption-read-client";
import { fetchYearnV3WithdrawableCapacity } from "./erc4626-capacity-yearn";
import { fetchSboldSpWithdrawableCapacity } from "./erc4626-capacity-sbold";
import { fetchMorphoVaultV1Liquidity, fetchMorphoVaultV2Liquidity } from "./erc4626-capacity-morpho";
import {
  SOURCE_TELEMETRY_KEYS, makeObservation, makeUnavailableObservation, routeForSource,
  type CapacityProbeResult, type Erc4626CapacityObservation, type Erc4626CapacityPauseProbe,
  type Erc4626CapacitySource, type ObserveConfiguredErc4626CapacityInput, type RedemptionCapacityTelemetry,
} from "./erc4626-capacity-observation";

type Erc4626CapacityDiagnostics = { capacityUnavailable?: true; collateralHealthGate?: "open" | "restricted" | "unreadable" };

function decodeErc20Decimals(raw: bigint | null): number | null {
  return raw == null ? null : parseBoundedDecimals(raw);
}

export async function observeConfiguredErc4626Capacity(
  input: ObserveConfiguredErc4626CapacityInput,
): Promise<Erc4626CapacityObservation | null> {
  const configured = input.configured;
  if (!configured) {
    const underlyingDecimals = decodeErc20Decimals(input.underlyingDecimalsRaw);
    return input.idleCapacityRaw != null && underlyingDecimals != null
      ? makeObservation("erc4626-idle-underlying", input.idleCapacityRaw, underlyingDecimals)
      : null;
  }

  if (configured.source === "atomic-full-backing") {
    const underlyingDecimals = decodeErc20Decimals(input.underlyingDecimalsRaw);
    return makeObservation(
      "erc4626-atomic-full-backing",
      input.supplyAssetsRaw,
      underlyingDecimals ?? 0,
      [],
      undefined,
      underlyingDecimals == null ? { capacityUnavailable: true } : {},
    );
  }

  if (configured.source === "fraxtal-hop-withdrawable") {
    return observeFraxtalHopCapacity(input, configured);
  }

  let probe: CapacityProbeResult;
  if (configured.source === "morpho-vault-v2") {
    probe = await fetchMorphoVaultV2Liquidity({ ...input, config: configured });
  } else if (configured.source === "morpho-vault-v1") {
    probe = await fetchMorphoVaultV1Liquidity({ ...input, config: configured });
  } else if (configured.source === "yearn-v3-withdrawable") {
    probe = await fetchYearnV3WithdrawableCapacity({
      ...input,
      settlementDelaySec: configured.settlementDelaySec,
    });
  } else {
    probe = await fetchSboldSpWithdrawableCapacity(input);
  }

  const underlyingDecimals = decodeErc20Decimals(input.underlyingDecimalsRaw);
  const source: Erc4626CapacitySource =
    configured.source === "morpho-vault-v1"
      ? "morpho-vault-v1-liquidity"
      : configured.source === "morpho-vault-v2"
        ? "morpho-vault-v2-liquidity"
        : configured.source;
  if (probe.capacityRaw != null && underlyingDecimals != null) {
    return makeObservation(source, probe.capacityRaw, underlyingDecimals, probe.warnings, probe.route, probe.diagnostics, probe.telemetry);
  }

  return makeUnavailableObservation(source, input.idleCapacityRaw, underlyingDecimals, probe.warnings, probe.route, undefined, probe.diagnostics);
}

const ROUTE_OPEN_REASON_BY_CAPACITY_SOURCE: Partial<Record<Erc4626CapacitySource, string>> = {
  "erc4626-atomic-full-backing":
    "Reviewer-asserted unconstrained external-savings redemption; full convertible backing readable on-chain this run",
  "erc4626-idle-underlying":
    "Idle underlying redemption liquidity readable on-chain this run; no on-chain pause surface reported paused",
  "morpho-vault-v1-liquidity":
    "Morpho listed-vault in-kind liquidity positive via protocol API this run",
  "morpho-vault-v2-liquidity":
    "Morpho listed-vault in-kind liquidity positive via protocol API this run",
  "yearn-v3-withdrawable":
    "Yearn V3 withdrawable liquidity positive and isShutdown() false this run",
  "sbold-sp-withdrawable":
    "sBOLD Stability Pool withdrawable BOLD positive via calcFragments() this run",
};

function resolveRouteOpenness(
  capacitySource: Erc4626CapacitySource,
  capacityRaw: bigint,
  pauseProbe: Erc4626CapacityPauseProbe,
): Pick<RedemptionCapacityTelemetry, "routeStatus" | "routeStatusSource" | "routeStatusReason"> {
  if (pauseProbe.paused === true) {
    return {
      routeStatus: "paused",
      routeStatusSource: "onchain",
      routeStatusReason: "Vault paused() returned true on-chain",
    };
  }
  if (pauseProbe.shutdown === true) {
    return {
      routeStatus: "paused",
      routeStatusSource: "onchain",
      routeStatusReason: "Yearn vault isShutdown() returned true on-chain",
    };
  }
  if (capacityRaw <= 0n) return {};
  // A null pause word covers both a vault without the surface and a failed
  // probe; neither supports an openness verdict, so publish none.
  if (pauseProbe.paused == null) return {};
  if (capacitySource === "yearn-v3-withdrawable" && pauseProbe.shutdown !== false) return {};
  const routeStatusReason = ROUTE_OPEN_REASON_BY_CAPACITY_SOURCE[capacitySource];
  if (!routeStatusReason) return {};
  const protocolApi = routeForSource(capacitySource).freshnessKind === "same-run-api";
  return {
    routeStatus: "open",
    routeStatusSource: protocolApi ? "protocol-api" : "onchain",
    routeStatusReason,
  };
}

export function buildExecutableRedemptionCapacityTelemetry(
  observation: ExecutableRedemptionObservation,
  supplyAssetsRaw: bigint,
): RedemptionCapacityTelemetry | null {
  const capacityRaw =
    observation.capacityRaw > supplyAssetsRaw ? supplyAssetsRaw : observation.capacityRaw;
  const capacityUsd = decimalNumberFromBigInt(capacityRaw, observation.underlyingDecimals);
  if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;
  const capacityRatioOfSupply = ratioFromRaw(capacityRaw, supplyAssetsRaw);
  return {
    capacityUsd,
    capacityRaw: capacityRaw.toString(),
    capacitySource: observation.capacitySource,
    ...(observation.settlementBoundUnproven ? { settlementBoundUnproven: true } : {}),
    freshnessKind: observation.freshnessKind,
    routeStatusSource: observation.routeStatusSource,
    underlyingDecimals: observation.underlyingDecimals,
    ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
    capacityKind: observation.capacityKind,
    ...(observation.settlementDelaySec != null
      ? { settlementDelaySec: observation.settlementDelaySec }
      : {}),
    blockNumber: observation.blockNumber,
    sourceTimestamp: observation.sourceTimestamp,
    sourceUrls: observation.sourceUrls,
    holderEligibility: observation.holderEligibility,
    routeStatus: observation.routeStatus,
    routeStatusReason: observation.routeStatusReason,
    ...(observation.feeBps != null ? { feeBps: observation.feeBps } : {}),
    outputAssetKeys: observation.outputAssetKeys,
    observerDiagnostics: observation.diagnostics,
  };
}

export function finalizeErc4626RedemptionCapacity(input: {
  supplyAssetsRaw: bigint;
  idleCapacityRaw: bigint | null;
  configured: Erc4626CapacityObservation | null;
  pause: Erc4626CapacityPauseProbe;
}): RedemptionCapacityTelemetry | null {
  const { configured } = input;
  if (!configured || configured.diagnostics.capacityUnavailable === true) return null;
  // Remote withdrawability is diagnostic, not an executable whole-route bound.
  // Retain the accepted packet and route diagnosis without emitting a fake zero
  // or falling back to independently measured Ethereum idle.
  if (configured.source === "fraxtal-hop-withdrawable" && configured.route.settlementBoundUnproven) return null;

  const { supplyAssetsRaw, idleCapacityRaw, pause } = input;
  const underlyingDecimals = configured.underlyingDecimals;
  if (configured.source === "erc4626-atomic-full-backing") {
    const capacityUsd = decimalNumberFromBigInt(supplyAssetsRaw, underlyingDecimals);
    if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;
    const capacityRatioOfSupply = ratioFromRaw(supplyAssetsRaw, supplyAssetsRaw);
    return {
      capacityUsd,
      capacityRaw: supplyAssetsRaw.toString(),
      capacitySource: "erc4626-atomic-full-backing",
      ...configured.route,
      ...(idleCapacityRaw != null ? { idleUnderlyingBalanceRaw: idleCapacityRaw.toString() } : {}),
      underlyingDecimals,
      ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
      ...resolveRouteOpenness("erc4626-atomic-full-backing", supplyAssetsRaw, pause),
    };
  }

  const idleRaw = idleCapacityRaw ?? 0n;
  // These source-bound routes cannot use wallet cash as an executable floor.
  // MetaMorpho V1/V1.1 ordinary withdrawals source market claims, not donations.
  const sourceBound = configured.source === "fraxtal-hop-withdrawable" ||
    configured.source === "morpho-vault-v1-liquidity";
  let capacitySource: Erc4626CapacitySource = sourceBound ? configured.source : "erc4626-idle-underlying";
  let uncappedCapacityRaw = sourceBound ? configured.capacityRaw : idleRaw;
  if (
    configured.source !== "erc4626-idle-underlying" &&
    configured.capacityRaw > uncappedCapacityRaw
  ) {
    capacitySource = configured.source;
    uncappedCapacityRaw = configured.capacityRaw;
  }
  const capacityRaw = uncappedCapacityRaw > supplyAssetsRaw ? supplyAssetsRaw : uncappedCapacityRaw;
  const capacityUsd = decimalNumberFromBigInt(capacityRaw, underlyingDecimals);
  if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;

  const capacityRatioOfSupply = ratioFromRaw(capacityRaw, supplyAssetsRaw);
  const route = configured.route;
  const provenance = routeForSource(capacitySource);
  const diagnostics = configured.diagnostics as Erc4626CapacityDiagnostics;
  const usesSboldSpWithdrawable = configured.source === "sbold-sp-withdrawable";
  const observedRouteOpenness = resolveRouteOpenness(capacitySource, capacityRaw, pause);
  const defaultRouteOpenness = observedRouteOpenness.routeStatus === "paused"
    ? observedRouteOpenness
    : route.routeStatus === "paused" || route.routeStatus === "degraded"
      ? {
          routeStatus: route.routeStatus,
          routeStatusSource: route.routeStatusSource,
          routeStatusReason: route.routeStatusReason,
        }
      : configured.diagnostics.routeOpennessUnproven === true
        ? {}
        : observedRouteOpenness;
  const routeOpenness =
    usesSboldSpWithdrawable && defaultRouteOpenness.routeStatus !== "paused"
      ? diagnostics.collateralHealthGate === "restricted"
        ? {
            routeStatus: "degraded" as const,
            routeStatusSource: "onchain" as const,
            routeStatusReason:
              "sBOLD collateral in BOLD exceeds maxCollInBold; _maxWithdraw() and _maxRedeem() return zero",
          }
        : diagnostics.collateralHealthGate !== "open"
          ? {
              routeStatus: "unknown" as const,
              routeStatusReason: "sBOLD collateral-health gate could not be read on-chain this run",
            }
          : defaultRouteOpenness.routeStatus === "open"
          ? {
              routeStatus: "open" as const,
              routeStatusSource: "onchain" as const,
              routeStatusReason:
                "sBOLD Stability Pool withdrawable BOLD positive and collateral-health gate open on-chain this run",
            }
          : defaultRouteOpenness
      : defaultRouteOpenness;
  // Per-source raw projections arrive with the observation. Publish them when
  // the probe's source actually backs the capacity, except Morpho, whose
  // liquidity fields document the configured source regardless of the winner.
  const publishProbeTelemetry =
    capacitySource === configured.source ||
    configured.source === "morpho-vault-v1-liquidity" ||
    configured.source === "morpho-vault-v2-liquidity";

  return {
    capacityUsd,
    capacityRaw: capacityRaw.toString(),
    capacitySource,
    freshnessKind: provenance.freshnessKind,
    ...(idleCapacityRaw != null ? { idleUnderlyingBalanceRaw: idleCapacityRaw.toString() } : {}),
    underlyingDecimals,
    ...(capacityRatioOfSupply != null ? { capacityRatioOfSupply } : {}),
    ...routeOpenness,
    ...(usesSboldSpWithdrawable && route.capacityKind
      ? { capacityKind: route.capacityKind }
      : {}),
    ...(capacitySource === "yearn-v3-withdrawable"
      ? {
          settlementDelaySec: route.settlementDelaySec,
          ...(route.capacityKind ? { capacityKind: route.capacityKind } : {}),
        }
      : {}),
    ...(capacitySource === "fraxtal-hop-withdrawable"
      ? { ...route, ...routeOpenness, capacityKind: route.capacityKind ?? "documented-bound" as const }
      : {}),
    ...(publishProbeTelemetry ? configured.telemetry : {}),
    ...(configured.diagnostics.morphoWarnings != null
      ? { observerDiagnostics: { morphoWarnings: configured.diagnostics.morphoWarnings } }
      : {}),
  };
}

export function projectErc4626RedemptionMetadata(
  telemetry: RedemptionCapacityTelemetry,
): Record<string, unknown> {
  return {
    redemptionCapacityRaw: telemetry.capacityRaw,
    redemptionCapacitySource: telemetry.capacitySource,
    ...(telemetry.idleUnderlyingBalanceRaw != null ? { idleUnderlyingBalanceRaw: telemetry.idleUnderlyingBalanceRaw } : {}),
    underlyingDecimals: telemetry.underlyingDecimals,
    ...projectPresentCapacityFields(telemetry, SOURCE_TELEMETRY_KEYS),
  };
}

function projectPresentCapacityFields<Key extends keyof RedemptionCapacityTelemetry>(
  telemetry: RedemptionCapacityTelemetry,
  keys: readonly Key[],
): Pick<RedemptionCapacityTelemetry, Key> {
  const projected = {} as Pick<RedemptionCapacityTelemetry, Key>;
  for (const key of keys) {
    const value = telemetry[key];
    if (value != null) projected[key] = value;
  }
  return projected;
}

/** Nested public fields, without raw source diagnostics or adapter-owned route overrides. */
export function projectErc4626RedemptionTelemetry(telemetry: RedemptionCapacityTelemetry) {
  return {
    ...projectPresentCapacityFields(telemetry, ["capacityUsd", "capacityRatioOfSupply"]),
    capacityKind: telemetry.capacityKind ?? "live-direct" as const,
    ...projectPresentCapacityFields(telemetry, [
      "settlementBoundUnproven", "settlementDelaySec", "blockNumber", "sourceTimestamp",
      "sourceUrls", "holderEligibility", "feeBps", "observerDiagnostics", "freshnessKind",
    ]),
  };
}
