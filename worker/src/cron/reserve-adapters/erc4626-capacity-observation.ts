import type { LiveReserveWarning, LiveReserveRedemptionTelemetryKnownFields } from "@shared/types/live-reserves";
import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext } from "./types";
import type { requireOnchainInput } from "./helpers";
import { reserveDegradedWarning } from "./helpers";
import type { SfrxusdCrosschainV9RouteAttempt } from "../../lib/redemption-backstop/sfrxusd-crosschain-redemption-route";
import type { ExecutableRedemptionObservation } from "./executable-redemption-read-client";

export type Erc4626RedemptionLiquidityConfig = NonNullable<
  LiveReserveAdapterParamsByKey["erc4626-single-asset"]["redemptionLiquidity"]
>;

export type Erc4626CapacitySource =
  | "erc4626-idle-underlying"
  | "erc4626-atomic-full-backing"
  | "morpho-vault-v1-liquidity"
  | "morpho-vault-v2-liquidity"
  | "yearn-v3-withdrawable"
  | "sbold-sp-withdrawable"
  | "fraxtal-hop-withdrawable";

export interface RedemptionCapacityTelemetry extends Pick<LiveReserveRedemptionTelemetryKnownFields,
  "settlementBoundUnproven" | "capacityRatioOfSupply" | "settlementDelaySec" | "blockNumber" |
  "sourceUrls" | "sourceTimestamp" | "capacityKind" | "holderEligibility" |
  "routeStatus" | "routeStatusReason" | "feeBps" | "outputAssetKeys"
> {
  /** Absent when underlying units have no admitted same-run USD valuation; the ratio then carries capacity. */
  capacityUsd?: NonNullable<LiveReserveRedemptionTelemetryKnownFields["capacityUsd"]>;
  capacityRaw: string;
  capacitySource:
    | Erc4626CapacitySource
    | ExecutableRedemptionObservation["capacitySource"];
  freshnessKind: Extract<NonNullable<LiveReserveRedemptionTelemetryKnownFields["freshnessKind"]>, "same-run-onchain" | "same-run-api">;
  /** Route-status evidence claim; absent unless this run observed an openness verdict. */
  routeStatusSource?: Extract<NonNullable<LiveReserveRedemptionTelemetryKnownFields["routeStatusSource"]>, "onchain" | "protocol-api">;
  idleUnderlyingBalanceRaw?: string;
  underlyingDecimals: number;
  observerDiagnostics?: Record<string, unknown>;
  yearnV3WithdrawableRaw?: string;
  sboldSpWithdrawableRaw?: string;
  sfrxusdCrosschainWithdrawableRaw?: string;
  morphoVaultV1LiquidityRaw?: string;
  morphoVaultV1LiquidityUsd?: number;
  morphoVaultV2LiquidityRaw?: string;
  morphoVaultV2LiquidityUsd?: number;
  morphoVaultV2ForceDeallocatableLiquidityRaw?: string;
  morphoVaultV2ForceDeallocatableLiquidityUsd?: number;
}

type Erc4626CapacityRoute = Pick<
  RedemptionCapacityTelemetry,
  "freshnessKind" | "routeStatusSource" | "capacityKind" | "settlementDelaySec" |
    "blockNumber" | "sourceUrls" | "sourceTimestamp" | "settlementBoundUnproven" |
    "holderEligibility" | "routeStatus" | "routeStatusReason"
>;

export const SOURCE_TELEMETRY_KEYS = [
  "morphoVaultV1LiquidityRaw", "morphoVaultV1LiquidityUsd",
  "yearnV3WithdrawableRaw", "sboldSpWithdrawableRaw", "sfrxusdCrosschainWithdrawableRaw",
  "morphoVaultV2LiquidityRaw", "morphoVaultV2LiquidityUsd",
  "morphoVaultV2ForceDeallocatableLiquidityRaw", "morphoVaultV2ForceDeallocatableLiquidityUsd",
] as const satisfies readonly (keyof RedemptionCapacityTelemetry)[];

/** Per-source raw projections the observation carries for the finalize step. */
type Erc4626CapacityTelemetry = Pick<RedemptionCapacityTelemetry, (typeof SOURCE_TELEMETRY_KEYS)[number]>;

export type Erc4626CapacityObservation = {
  source: Erc4626CapacitySource;
  capacityRaw: bigint;
  underlyingDecimals: number;
  warnings: LiveReserveWarning[];
  route: Erc4626CapacityRoute;
  diagnostics: Record<string, unknown>;
  telemetry: Erc4626CapacityTelemetry;
  v9RouteAttempt?: SfrxusdCrosschainV9RouteAttempt;
};

export type Erc4626CapacityPauseProbe = { paused: boolean | null; shutdown: boolean | null };

export type ObserveConfiguredErc4626CapacityInput = {
  coinId: string;
  contractAddress: string;
  assetAddress: string;
  configured?: Erc4626RedemptionLiquidityConfig;
  idleCapacityRaw: bigint | null;
  underlyingDecimalsRaw: bigint | null;
  supplyAssetsRaw: bigint;
  call: (data: string) => Promise<string | null>;
  signal: AbortSignal;
  ctx?: AdapterContext;
  rpcMode: ReturnType<typeof requireOnchainInput>["rpcMode"];
  chain: string;
  rpcUrl?: string;
  fallbackRpcUrl?: string;
  timeoutMs: number;
};
export type CapacityProbeResult = {
  capacityRaw: bigint | null;
  warnings: LiveReserveWarning[];
  route?: Erc4626CapacityRoute;
  diagnostics?: Record<string, unknown>;
  telemetry?: Erc4626CapacityTelemetry;
};

export function routeForSource(source: Erc4626CapacitySource): Erc4626CapacityRoute {
  const api = source === "morpho-vault-v1-liquidity" || source === "morpho-vault-v2-liquidity";
  return { freshnessKind: api ? "same-run-api" : "same-run-onchain" };
}

export function probeFailure(code: string, message: string): CapacityProbeResult {
  return {
    capacityRaw: null,
    warnings: [reserveDegradedWarning(code, message)],
  };
}


export function makeObservation(
  source: Erc4626CapacitySource,
  capacityRaw: bigint,
  underlyingDecimals: number,
  warnings: LiveReserveWarning[] = [],
  route: Erc4626CapacityRoute = routeForSource(source),
  diagnostics: Record<string, unknown> = {},
  telemetry: Erc4626CapacityTelemetry = {},
  v9RouteAttempt?: SfrxusdCrosschainV9RouteAttempt,
): Erc4626CapacityObservation {
  return {
    source,
    capacityRaw,
    underlyingDecimals,
    warnings,
    route,
    diagnostics,
    telemetry,
    ...(v9RouteAttempt ? { v9RouteAttempt } : {}),
  };
}

export function makeUnavailableObservation(
  source: Erc4626CapacitySource,
  idleCapacityRaw: bigint | null,
  underlyingDecimals: number | null,
  warnings: LiveReserveWarning[],
  route?: Erc4626CapacityRoute,
  v9RouteAttempt?: SfrxusdCrosschainV9RouteAttempt,
  diagnostics: Record<string, unknown> = {},
): Erc4626CapacityObservation {
  const unavailableDiagnostics = { ...diagnostics, routeOpennessUnproven: true };
  if (source !== "morpho-vault-v1-liquidity" && idleCapacityRaw != null && underlyingDecimals != null) {
    return makeObservation("erc4626-idle-underlying", idleCapacityRaw, underlyingDecimals, warnings,
      { ...route, freshnessKind: "same-run-onchain" }, unavailableDiagnostics, undefined, v9RouteAttempt);
  }
  return makeObservation(source, 0n, underlyingDecimals ?? 0, warnings, route,
    { ...unavailableDiagnostics, capacityUnavailable: true }, undefined, v9RouteAttempt);
}
