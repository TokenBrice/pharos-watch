import { z } from "zod";
import {
  DexExitRouteObservationsSchema,
  ExitRouteObservationCoverageSchema,
  type ExitRouteObservation,
} from "../types/market";
import type { RedemptionBackstopMap } from "../types/redemption";
import { REPORT_CARDS_REGISTRY_FINGERPRINT } from "../data/stablecoins/report-card-registry-fingerprint.generated";
import { compareCodeUnits, sortedRecord } from "./compare";
import { sha256Hex } from "./sha256";
import { stableJsonStringifyV1 } from "./stable-json";
import { V9RuntimeProducerVerdictSchema, v9EvidenceCauseScopeKey } from "../types/safety-score-v9-causes";
import { V9EvidenceReferenceV2Schema } from "../types/safety-score-v9-facts";
import { findV9EvidenceCauseProofIssues } from "../types/safety-score-v9-causes";

/** Captured reader verdicts are base facts, not mutable compute-time enrichment. */
export const PipelineGapByAssetIdSchema = z.record(z.string(), z.array(z.object({
  verdict: V9RuntimeProducerVerdictSchema,
  evidence: V9EvidenceReferenceV2Schema,
}).strict())).superRefine((rows, ctx) => {
  for (const [assetId, entries] of Object.entries(rows)) {
    const scopes = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const key = v9EvidenceCauseScopeKey(assetId, entry.verdict.scope);
      if (entry.verdict.assetId !== assetId || scopes.has(key)) {
        ctx.addIssue({ code: "custom", path: [assetId, index], message: "Pipeline verdict requires a unique exact asset/datum scope" });
      }
      scopes.add(key);
    }
  }
});
export type PipelineGapByAssetId = z.infer<typeof PipelineGapByAssetIdSchema>;

export function normalizePipelineGapByAssetId(rows: PipelineGapByAssetId): PipelineGapByAssetId {
  return sortedRecord(Object.fromEntries(Object.entries(rows).map(([id, entries]) => [id,
    [...entries].sort((a, b) => compareCodeUnits(
      v9EvidenceCauseScopeKey(id, a.verdict.scope), v9EvidenceCauseScopeKey(id, b.verdict.scope),
    )),
  ])));
}

export function assertPipelineGapCapture(rows: PipelineGapByAssetId, assetIds: readonly string[], asOfSec: number): void {
  for (const [assetId, entries] of Object.entries(rows)) {
    if (!assetIds.includes(assetId)) throw new Error(`Pipeline verdict has noncaptured asset ${assetId}`);
    for (const { verdict, evidence } of entries) {
      const issues = findV9EvidenceCauseProofIssues({
        proof: verdict.proof, assetId, scope: verdict.scope, asOfSec,
        sourceGenerationId: evidence.sourceGenerationId, evidence: [evidence], researchMaxAgeSec: 365 * 86400,
      });
      if (issues.length) throw new Error(`Pipeline verdict ${assetId}: ${issues.join("; ")}`);
      if (evidence.observedAtSec + evidence.freshness.ageSec !== asOfSec) {
        throw new Error(`Pipeline verdict ${assetId} freshness clock does not match capture`);
      }
    }
  }
}

/** Retained V3 identity stays historical unless the capture explicitly carries proofs. */
export function bindPipelineGapBaseInputIdentity(baseGenerationId: string, rows: PipelineGapByAssetId | undefined): string {
  return rows === undefined ? baseGenerationId : `report-cards-input:v1:${sha256Hex(stableJsonStringifyV1({
    domain: "report-cards.fixed-input.pipeline-proof.v1", baseGenerationId, pipelineGapByAssetId: normalizePipelineGapByAssetId(rows),
  }))}`;
}

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
    exitRouteObservations: DexExitRouteObservationsSchema.nullable().optional(),
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

/**
 * Rewrite every row of a keyed map through `normalizeRow`, then emit the map in
 * canonical key order. The row callback stays lane-specific — the native V9
 * capture admits a narrower DEX row than the v3 fixed input does — while the
 * ordering and re-mapping scaffold has one definition for both lanes.
 */
export function normalizeSortedRowMap<T>(
  record: Record<string, T>,
  normalizeRow: (row: T) => T,
): Record<string, T> {
  return sortedRecord(Object.fromEntries(Object.entries(record).map(([id, row]) => [id, normalizeRow(row)])));
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
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
        ? { trackedAssetIds: [...observation.output.trackedAssetIds].sort(compareCodeUnits) }
        : {}),
      ...(observation.output.assetKeys ? { assetKeys: [...observation.output.assetKeys].sort(compareCodeUnits) } : {}),
      ...(observation.output.basketWeights
        ? {
            basketWeights: [...observation.output.basketWeights].sort(
              (left, right) =>
                compareCodeUnits(left.assetId ?? "", right.assetId ?? "") ||
                compareCodeUnits(left.symbol ?? "", right.symbol ?? "") ||
                left.weight - right.weight,
            ),
          }
        : {}),
    },
    commonModeKeys: [...observation.commonModeKeys].sort(compareCodeUnits),
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
        compareCodeUnits(left.routeId, right.routeId) ||
        compareCodeUnits(stableJsonStringifyV1(left), stableJsonStringifyV1(right)),
    );
}

export function normalizeFixedDexLiquidityMap(
  record: Record<string, FixedDexLiquidityRow>,
): Record<string, FixedDexLiquidityRow> {
  return normalizeSortedRowMap(record, (row) => ({
    ...row,
    ...(row.exitRouteObservations !== undefined
      ? { exitRouteObservations: normalizeFixedInputExitRouteObservations(row.exitRouteObservations) }
      : {}),
  }));
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
