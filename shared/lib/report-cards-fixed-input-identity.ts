import { z } from "zod";
import {
  DexExitRouteObservationSchema,
  ExitRouteObservationCoverageSchema,
  type ExitRouteObservation,
} from "../types/market";
import type { RedemptionBackstopMap } from "../types/redemption";
import { REPORT_CARDS_REGISTRY_FINGERPRINT } from "../data/stablecoins/report-card-registry-fingerprint.generated";
import { sha256Hex } from "./sha256";
import { stableJsonStringifyV1 } from "./stable-json";

export const FixedDexLiquidityRowSchema = z
  .object({
    liquidityScore: z.number().min(0).max(100).nullable(),
    concentrationHhi: z.number().min(0).max(1).nullable(),
    poolCount: z.number().int().nonnegative(),
    chainCount: z.number().int().nonnegative(),
    coverageClass: z.enum(["primary", "mixed", "fallback", "legacy", "unobserved"]).nullable().optional(),
    coverageConfidence: z.number().min(0).max(1).nullable().optional(),
    liquidityEvidenceClass: z
      .enum(["unobserved", "measured", "partial_measured", "observed_unmeasured"])
      .nullable()
      .optional(),
    hasMeasuredLiquidityEvidence: z.boolean().nullable().optional(),
    effectiveTvlUsd: z.number().finite().nonnegative().nullable().optional(),
    balanceMeasuredTvlUsd: z.number().finite().nonnegative().nullable().optional(),
    organicMeasuredTvlUsd: z.number().finite().nonnegative().nullable().optional(),
    deploymentCoverage: z
      .object({
        observedPools: z.number().int().nonnegative(),
        verifiedNoPools: z.number().int().nonnegative(),
        providerInaccessible: z.number().int().nonnegative(),
      })
      .nullable()
      .optional(),
    exitRouteObservations: z.array(DexExitRouteObservationSchema).nullable().optional(),
    exitRouteObservationCoverage: ExitRouteObservationCoverageSchema.optional(),
    methodologyVersion: z.string().min(1).optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .superRefine((row, ctx) => {
    if (!row.exitRouteObservations || !row.exitRouteObservationCoverage) return;
    const eligibleObservationCount = row.exitRouteObservations.filter(
      (observation) => observation.scoreEligible,
    ).length;
    if (row.exitRouteObservationCoverage.observationCount !== row.exitRouteObservations.length) {
      ctx.addIssue({
        code: "custom",
        path: ["exitRouteObservationCoverage", "observationCount"],
        message: "coverage observation count does not match DEX observations",
      });
    }
    if (row.exitRouteObservationCoverage.scoreEligibleObservationCount !== eligibleObservationCount) {
      ctx.addIssue({
        code: "custom",
        path: ["exitRouteObservationCoverage", "scoreEligibleObservationCount"],
        message: "coverage eligible-observation count does not match DEX observations",
      });
    }
  });

export type FixedDexLiquidityRow = z.infer<typeof FixedDexLiquidityRowSchema>;

export const ReportCardsFixedInputMethodologyVersionsSchema = z.object({
  safetyScore: z.string().min(1),
  dexLiquidity: z.array(z.string().min(1)),
  pegScore: z.array(z.string().min(1)),
  redemptionBackstop: z.array(z.string().min(1)),
});

export type ReportCardsFixedInputMethodologyVersions = z.infer<typeof ReportCardsFixedInputMethodologyVersionsSchema>;

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export function normalizeReportCardsFixedInputMethodologyVersions(
  versions: ReportCardsFixedInputMethodologyVersions,
): ReportCardsFixedInputMethodologyVersions {
  return {
    safetyScore: versions.safetyScore,
    dexLiquidity: uniqueSorted(versions.dexLiquidity),
    pegScore: uniqueSorted(versions.pegScore),
    redemptionBackstop: uniqueSorted(versions.redemptionBackstop),
  };
}

function normalizeFixedInputExitRouteObservation<T extends ExitRouteObservation>(observation: T): T {
  return {
    ...observation,
    output: {
      ...observation.output,
      ...(observation.output.trackedAssetIds
        ? { trackedAssetIds: [...observation.output.trackedAssetIds].sort() }
        : {}),
      ...(observation.output.assetKeys ? { assetKeys: [...observation.output.assetKeys].sort() } : {}),
      ...(observation.output.basketWeights
        ? {
            basketWeights: [...observation.output.basketWeights].sort(
              (left, right) =>
                (left.assetId ?? "").localeCompare(right.assetId ?? "") ||
                (left.symbol ?? "").localeCompare(right.symbol ?? "") ||
                left.weight - right.weight,
            ),
          }
        : {}),
    },
    commonModeKeys: [...observation.commonModeKeys].sort(),
    ...(observation.capacityCurve
      ? {
          capacityCurve: [...observation.capacityCurve].sort(
            (left, right) =>
              left.maxCostBps - right.maxCostBps || left.requestedNotionalUsd - right.requestedNotionalUsd,
          ),
        }
      : {}),
  } as T;
}

export function normalizeFixedInputExitRouteObservations<T extends ExitRouteObservation>(
  observations: readonly T[] | null | undefined,
): T[] | null | undefined {
  if (observations == null) return observations;
  return observations
    .map(normalizeFixedInputExitRouteObservation)
    .sort(
      (left, right) =>
        left.routeId.localeCompare(right.routeId) ||
        stableJsonStringifyV1(left).localeCompare(stableJsonStringifyV1(right)),
    );
}

export function normalizeFixedDexLiquidityMap(
  record: Record<string, FixedDexLiquidityRow>,
): Record<string, FixedDexLiquidityRow> {
  return sortedRecord(
    Object.fromEntries(
      Object.entries(record).map(([id, row]) => [
        id,
        {
          ...row,
          ...(row.exitRouteObservations !== undefined
            ? { exitRouteObservations: normalizeFixedInputExitRouteObservations(row.exitRouteObservations) }
            : {}),
        },
      ]),
    ),
  );
}

export function projectFixedDexLiquidityMap(
  record: Record<string, FixedDexLiquidityRow>,
): Record<string, FixedDexLiquidityRow> {
  return Object.fromEntries(Object.entries(record).map(([id, row]) => [id, FixedDexLiquidityRowSchema.parse(row)]));
}

export function normalizeFixedRedemptionBackstopMap(record: RedemptionBackstopMap): RedemptionBackstopMap {
  return sortedRecord(
    Object.fromEntries(
      Object.entries(record).map(([id, row]) => [
        id,
        {
          ...row,
          ...(row.capacityProfile?.exitRouteObservations
            ? {
                capacityProfile: {
                  ...row.capacityProfile,
                  exitRouteObservations: normalizeFixedInputExitRouteObservations(
                    row.capacityProfile.exitRouteObservations,
                  )!,
                },
              }
            : {}),
        },
      ]),
    ),
  );
}

export function computeReportCardsRegistryFingerprint(): string {
  return REPORT_CARDS_REGISTRY_FINGERPRINT;
}

export function computeDexLiquidityPayloadFingerprint(
  dexLiqMap: Record<string, FixedDexLiquidityRow>,
  dexGenerationId: string,
): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "report-cards.fixed-input.dex-payload.v1",
      dexGenerationId,
      dexLiqMap: normalizeFixedDexLiquidityMap(projectFixedDexLiquidityMap(dexLiqMap)),
    }),
  );
}

export function computeRedemptionPayloadFingerprint(
  redemptionBackstopMap: RedemptionBackstopMap,
  redemptionGenerationId: string,
): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "report-cards.fixed-input.redemption-payload.v1",
      redemptionGenerationId,
      redemptionBackstopMap: normalizeFixedRedemptionBackstopMap(redemptionBackstopMap),
    }),
  );
}

export function projectReportCardsFixedInputMethodologyVersions(input: {
  methodologyVersion: string;
  dexLiqMap: Record<string, { methodologyVersion?: string }>;
  pegDataById: Record<string, { methodologyVersion: string }>;
  redemptionBackstopMap: RedemptionBackstopMap;
}): ReportCardsFixedInputMethodologyVersions {
  return normalizeReportCardsFixedInputMethodologyVersions({
    safetyScore: input.methodologyVersion,
    dexLiquidity: Object.values(input.dexLiqMap).flatMap((row) =>
      row.methodologyVersion ? [row.methodologyVersion] : [],
    ),
    pegScore: Object.values(input.pegDataById).map((row) => row.methodologyVersion),
    redemptionBackstop: Object.values(input.redemptionBackstopMap).map((row) => row.methodologyVersion),
  });
}
