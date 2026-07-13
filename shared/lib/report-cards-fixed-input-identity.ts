import { z } from "zod";
import {
  DexExitRouteObservationSchema,
  ExitRouteObservationCoverageSchema,
  type ExitRouteObservation,
} from "../types/market";
import type { RedemptionBackstopMap } from "../types/redemption";
import { ReportCardsResponseSchema, type ReportCard, type ReportCardsResponse } from "../types/report-cards";
import { DEAD_STABLECOINS } from "./dead-stablecoins";
import { sha256Hex } from "./sha256";
import { stableJsonStringifyV1 } from "./stable-json";
import { ACTIVE_STABLECOINS, FROZEN_STABLECOINS } from "./stablecoins/registry";

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

export function normalizeFixedInputExitRouteObservation<T extends ExitRouteObservation>(observation: T): T {
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
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "report-cards.fixed-input.registry.v1",
      activeStablecoins: [...ACTIVE_STABLECOINS].sort((left, right) => left.id.localeCompare(right.id)),
      frozenStablecoins: [...FROZEN_STABLECOINS].sort((left, right) => left.id.localeCompare(right.id)),
      deadStablecoins: [...DEAD_STABLECOINS].sort((left, right) => left.id.localeCompare(right.id)),
    }),
  );
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

function normalizeReportCardForReplay(card: ReportCard): ReportCard {
  return {
    ...card,
    dimensions: Object.fromEntries(
      Object.entries(card.dimensions).map(([key, dimension]) => [
        key,
        {
          ...dimension,
          ...(dimension.detailItems
            ? { detailItems: [...dimension.detailItems].sort((left, right) => left.label.localeCompare(right.label)) }
            : {}),
        },
      ]),
    ) as ReportCard["dimensions"],
    rawInputs: {
      ...card.rawInputs,
      dependencies: [...card.rawInputs.dependencies].sort(
        (left, right) =>
          left.id.localeCompare(right.id) ||
          (left.type ?? "collateral").localeCompare(right.type ?? "collateral") ||
          left.weight - right.weight,
      ),
    },
  };
}

/** Removes publication-envelope ordering so fixed-input replay output is byte-comparable. */
export function normalizeReportCardsReplayPayload(value: unknown): ReportCardsResponse {
  const snapshot = ReportCardsResponseSchema.parse(value);
  return {
    cards: [...snapshot.cards].map(normalizeReportCardForReplay).sort((left, right) => left.id.localeCompare(right.id)),
    methodology: snapshot.methodology,
    dependencyGraph: {
      edges: [...snapshot.dependencyGraph.edges].sort(
        (left, right) =>
          left.from.localeCompare(right.from) ||
          left.to.localeCompare(right.to) ||
          left.type.localeCompare(right.type) ||
          left.weight - right.weight,
      ),
    },
    updatedAt: snapshot.updatedAt,
    ...(snapshot.liquidityStale != null ? { liquidityStale: snapshot.liquidityStale } : {}),
    ...(snapshot.redemptionStale != null ? { redemptionStale: snapshot.redemptionStale } : {}),
    ...(snapshot.inputFreshness ? { inputFreshness: snapshot.inputFreshness } : {}),
    ...(snapshot.collateralDriftCoins
      ? {
          collateralDriftCoins: [...snapshot.collateralDriftCoins].sort((left, right) =>
            left.id.localeCompare(right.id),
          ),
        }
      : {}),
    ...(snapshot.liveToFallbackCoins ? { liveToFallbackCoins: [...snapshot.liveToFallbackCoins].sort() } : {}),
  };
}

export function computeReportCardsReplayPayloadFingerprint(value: unknown): string {
  return sha256Hex(
    stableJsonStringifyV1({
      domain: "report-cards.fixed-input.replay-payload.v1",
      payload: normalizeReportCardsReplayPayload(value),
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
