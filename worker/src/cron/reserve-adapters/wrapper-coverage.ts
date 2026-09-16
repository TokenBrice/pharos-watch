import type { ReserveSlice } from "@shared/types/core";
import type { LiveReserveWarning } from "@shared/types/live-reserves";
import { buildCoverageShortfallWarnings } from "./helpers";
import { capacityFromTokenAmounts } from "./slice-math";
import type { AdapterResult } from "./types";

export interface WrapperCoverage {
  totalSupplyRaw: bigint;
  wrapperDecimals: number;
  underlyingBalanceRaw: bigint;
  underlyingDecimals: number;
  capacityUsd: number;
  capacityRatioOfSupply: number | undefined;
  collateralizationRatio: number | undefined;
}

export function readWrapperCoverage(args: {
  totalSupplyRaw: bigint;
  wrapperDecimals: number;
  underlyingBalanceRaw: bigint;
  underlyingDecimals: number;
}): WrapperCoverage {
  return {
    ...args,
    ...capacityFromTokenAmounts(
      args.underlyingBalanceRaw,
      args.underlyingDecimals,
      args.totalSupplyRaw,
      args.wrapperDecimals,
    ),
  };
}

export function wrapperCoverageResult(args: {
  coverage: WrapperCoverage;
  slice: ReserveSlice;
  warningMessage: (coveragePct: string) => string;
  warnings?: LiveReserveWarning[];
  metadata: Record<string, unknown>;
  redemption: {
    routeStatus: "open" | "paused" | "cohort-limited" | "unknown";
    routeStatusReason?: string;
    holderEligibility: "any-holder" | "whitelisted-primary";
    sourceUrls?: string[];
  };
}): AdapterResult {
  const { coverage } = args;
  const warnings = [
    ...buildCoverageShortfallWarnings({
      code: "reserve-undercollateralized",
      message: args.warningMessage,
      coverageRatio: coverage.collateralizationRatio,
    }),
    ...(args.warnings ?? []),
  ];
  return {
    slices: [args.slice],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...args.metadata,
      totalSupplyRaw: coverage.totalSupplyRaw.toString(),
      wrapperDecimals: coverage.wrapperDecimals,
      underlyingBalanceRaw: coverage.underlyingBalanceRaw.toString(),
      underlyingDecimals: coverage.underlyingDecimals,
      ...(coverage.collateralizationRatio != null && Number.isFinite(coverage.collateralizationRatio)
        ? { collateralizationRatio: coverage.collateralizationRatio }
        : {}),
      redemption: {
        capacityUsd: coverage.capacityUsd,
        ...(coverage.capacityRatioOfSupply != null
          ? { capacityRatioOfSupply: coverage.capacityRatioOfSupply }
          : {}),
        capacityKind: "live-direct" as const,
        freshnessKind: "same-run-onchain" as const,
        routeStatus: args.redemption.routeStatus,
        routeStatusSource: "onchain" as const,
        ...(args.redemption.routeStatusReason ? { routeStatusReason: args.redemption.routeStatusReason } : {}),
        holderEligibility: args.redemption.holderEligibility,
        settlementDelaySec: 0,
        ...(args.redemption.sourceUrls ? { sourceUrls: args.redemption.sourceUrls } : {}),
      },
    },
  };
}
