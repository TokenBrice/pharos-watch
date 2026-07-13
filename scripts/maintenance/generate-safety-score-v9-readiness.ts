import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { stableJsonStringifyV1 } from "@shared/lib/depeg-resolver/hash";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import {
  FixedDexLiquidityRowSchema,
  ReportCardsFixedInputMethodologyVersionsSchema,
  computeDexLiquidityPayloadFingerprint,
  computeRedemptionPayloadFingerprint,
  computeReportCardsRegistryFingerprint,
  computeReportCardsReplayPayloadFingerprint,
  projectReportCardsFixedInputMethodologyVersions,
} from "@shared/lib/report-cards-fixed-input-identity";
import {
  mergeExitRouteObservationSets,
  type MergedExitObservationSet,
} from "@shared/lib/safety-score-v9/exit-observation-set";
import { assertV9ValidatedPolicyEnvelope, resolveV9ReasonPolicy } from "@shared/lib/safety-score-v9/policy";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  assertExactReportCardIds,
  compileHistoricalFixtureToV9Input,
  compileReportCardSetToV9Inputs,
} from "@shared/lib/safety-score-v9-compiler";
import {
  V9_CANDIDATE_POLICY_V1,
  scoreCompiledAsset,
  scoreCompiledAssetSet,
} from "@shared/lib/safety-score-v9-research";
import type { ExitRouteObservation } from "@shared/types/market";
import { RedemptionBackstopMapSchema, type RedemptionBackstopMap } from "@shared/types/redemption";
import { ReportCardsResponseSchema, type ReportCardsResponse } from "@shared/types/report-cards";
import {
  HistoricalV9FixtureCorpusSchema,
  historicalFactsInput,
  type CompiledV9AssetInput,
  type HistoricalV9Fixture,
  type V9ManualInputClassification,
  type V9ReasonCode,
  type V9UnresolvedFact,
  type V9ValidatedPolicyEnvelope,
} from "@shared/types/safety-score-v9";
import historicalFixtureAsset from "../../shared/data/safety-score-v9/historical-fixtures-v1.json";
import calibrationCohortAsset from "../../shared/data/safety-score-v9/calibration-cohort-v1.json";
import exitRouteCalibrationAsset from "../../shared/data/safety-score-v9/exit-route-calibration-v1.json";
import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const USAGE = `Usage: npx tsx scripts/maintenance/generate-safety-score-v9-readiness.ts [options]

Options:
  --report-cards <path>   Fixed-input report-card replay JSON (required)
  --fixed-input <path>    Fixed publication input used by that replay (required)
  --output <path>         Readiness report JSON (required)
  --generated-at <iso>    Fixed report generation timestamp (required)
  -h, --help              Show this help`;

interface CalibrationCohortAsset {
  version: number;
  asOf: string;
  assets: Array<{ assetId: string; cohorts: string[] }>;
}

const FreshnessEntrySchema = z
  .object({
    updatedAt: z.number().finite().nonnegative().nullable(),
    ageSeconds: z.number().finite().nonnegative().nullable(),
    stale: z.boolean(),
  })
  .strict();

const RequiredProducerMethodologyVersionsSchema = ReportCardsFixedInputMethodologyVersionsSchema.superRefine(
  (versions, ctx) => {
    for (const lane of ["dexLiquidity", "pegScore", "redemptionBackstop"] as const) {
      if (versions[lane].length === 0) {
        ctx.addIssue({ code: "custom", path: [lane], message: `${lane} requires at least one methodology version` });
      }
    }
  },
);

const FixedPublicationInputBase = {
  capturedAt: z.string().datetime(),
  sourceGeneration: z.string().min(1),
  registryRevision: z.string().min(1),
  methodologyVersion: z.string().min(1),
  clockSec: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  liquidityStale: z.boolean(),
  redemptionStale: z.boolean(),
  inputFreshness: z
    .object({
      dexLiquidity: FreshnessEntrySchema,
      redemptionBackstops: FreshnessEntrySchema,
    })
    .strict(),
  pegDataById: z.record(z.string(), z.object({ methodologyVersion: z.string().min(1) }).passthrough()),
  activeDepegPeakBpsById: z.record(z.string(), z.unknown()),
  dexLiqMap: z.record(z.string(), FixedDexLiquidityRowSchema),
  redemptionBackstopMap: RedemptionBackstopMapSchema,
  bluechipMap: z.record(z.string(), z.unknown()),
  resolvedBlacklistStatuses: z.record(z.string(), z.unknown()),
  liveReserveMap: z.record(z.string(), z.unknown()),
  liveReserveProvenanceMap: z.record(z.string(), z.unknown()),
  chainCirculatingById: z.record(z.string(), z.unknown()),
  dexDeploymentSupplyCoverageById: z.record(z.string(), z.unknown()),
};

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const FixedPublicationInputSchema = z.discriminatedUnion("schemaVersion", [
  z
    .object({
      schemaVersion: z.literal(1),
      ...FixedPublicationInputBase,
    })
    .passthrough(),
  z
    .object({
      schemaVersion: z.literal(2),
      ...FixedPublicationInputBase,
      dexGenerationId: z.string().min(1),
      dexPayloadFingerprint: Sha256Schema,
      registryFingerprint: Sha256Schema,
    })
    .passthrough(),
  z
    .object({
      schemaVersion: z.literal(3),
      ...FixedPublicationInputBase,
      captureKind: z.enum(["exact-publication-inputs", "public-reconstruction"]),
      activeAssetIds: z.array(z.string().min(1)),
      dexGenerationId: z.string().min(1),
      redemptionGenerationId: z.string().min(1),
      dexPayloadFingerprint: Sha256Schema,
      redemptionPayloadFingerprint: Sha256Schema,
      registryFingerprint: Sha256Schema,
      inputMethodologyVersions: RequiredProducerMethodologyVersionsSchema,
      baseInputGenerationId: z
        .string()
        .regex(/^report-cards-input:v1:[a-f0-9]{64}$/)
        .optional(),
    })
    .passthrough(),
]);

type FixedPublicationInput = z.infer<typeof FixedPublicationInputSchema>;
type ReadinessDexMap = Record<string, z.infer<typeof FixedDexLiquidityRowSchema>>;

export function parseFixedPublicationInput(value: unknown): FixedPublicationInput {
  return FixedPublicationInputSchema.parse(value);
}

function exactStringSetMatch(left: readonly string[], right: readonly string[]): boolean {
  return stableJsonStringifyV1([...new Set(left)].sort()) === stableJsonStringifyV1([...new Set(right)].sort());
}

export function assessFixedInputProvenance(input: FixedPublicationInput) {
  const captureKind = input.schemaVersion === 3 ? input.captureKind : "legacy-unverified";
  const exactPublicationInputs = input.schemaVersion === 3 && input.captureKind === "exact-publication-inputs";
  return {
    schemaVersion: input.schemaVersion,
    captureKind,
    capturedAt: input.capturedAt,
    exactPublicationInputs,
    blockers: exactPublicationInputs
      ? []
      : [`Fixed replay input is schema v${input.schemaVersion} ${captureKind}, not schema v3 exact-publication-inputs`],
  };
}

export function assessReadinessInputBindings(args: {
  fixedInput: FixedPublicationInput;
  reportCards: ReportCardsResponse;
  activeIds: readonly string[];
  suppliedEvidenceTimes: readonly number[];
}): string[] {
  const { fixedInput, reportCards, activeIds, suppliedEvidenceTimes } = args;
  const blockers: string[] = [];
  const calibrationSource = exitRouteCalibrationAsset.source;

  if (reportCards.updatedAt !== fixedInput.updatedAt) {
    blockers.push(
      `Report-card replay timestamp ${reportCards.updatedAt} does not match fixed input ${fixedInput.updatedAt}`,
    );
  }
  if (reportCards.liquidityStale !== fixedInput.liquidityStale) {
    blockers.push("Report-card replay liquidity freshness does not match the fixed input");
  }
  if (reportCards.redemptionStale !== fixedInput.redemptionStale) {
    blockers.push("Report-card replay redemption freshness does not match the fixed input");
  }
  if (stableJsonStringifyV1(reportCards.inputFreshness) !== stableJsonStringifyV1(fixedInput.inputFreshness)) {
    blockers.push("Report-card replay input-freshness envelope does not match the fixed input");
  }
  if (reportCards.methodology.version !== calibrationSource.replayMethodologyVersion) {
    blockers.push(
      `Report-card replay methodology v${reportCards.methodology.version} does not match calibrated replay v${calibrationSource.replayMethodologyVersion}`,
    );
  }
  const replayPayloadFingerprint = computeReportCardsReplayPayloadFingerprint(reportCards);
  if (replayPayloadFingerprint !== calibrationSource.legacyReplayPayloadFingerprint) {
    blockers.push(
      `Report-card replay payload fingerprint ${replayPayloadFingerprint} does not match calibrated ${calibrationSource.legacyReplayPayloadFingerprint}`,
    );
  }
  if (calibrationSource.captureKind !== "exact-publication-inputs") {
    blockers.push(`P4 calibration source is ${calibrationSource.captureKind}, not exact-publication-inputs`);
  }
  if (calibrationSource.methodologyMismatchBypassUsed) {
    blockers.push("P4 calibration used the methodology-mismatch bypass");
  }
  if (calibrationSource.registryMismatchBypassUsed) {
    blockers.push("P4 calibration used the registry-mismatch bypass");
  }
  if (fixedInput.updatedAt > fixedInput.clockSec) {
    blockers.push("Fixed input report-card timestamp is later than its publication clock");
  }
  if (Date.parse(fixedInput.capturedAt) / 1_000 < fixedInput.clockSec) {
    blockers.push("Fixed input capture timestamp is earlier than its publication clock");
  }
  for (const [lane, freshness] of Object.entries(fixedInput.inputFreshness)) {
    if (freshness.updatedAt != null && freshness.updatedAt > fixedInput.clockSec) {
      blockers.push(`Fixed input ${lane} generation is later than its publication clock`);
    }
  }
  const futureEvidenceCount = suppliedEvidenceTimes.filter((timestamp) => timestamp > fixedInput.clockSec).length;
  if (futureEvidenceCount > 0) {
    blockers.push(
      `${futureEvidenceCount} supplied compiler evidence timestamp${futureEvidenceCount === 1 ? " is" : "s are"} later than the fixed publication clock`,
    );
  }

  if (fixedInput.schemaVersion !== 3) {
    blockers.push("Legacy fixed input lacks the generation and fingerprint fields required for cross-artifact binding");
    return blockers;
  }

  if (!exactStringSetMatch(fixedInput.activeAssetIds, activeIds)) {
    blockers.push("Fixed input active asset identities do not match the current active registry");
  }
  const fixedDexIds = Object.keys(fixedInput.dexLiqMap).filter((id) => id !== "__global__");
  if (fixedInput.captureKind === "exact-publication-inputs" && !exactStringSetMatch(fixedDexIds, activeIds)) {
    blockers.push("Exact fixed input DEX rows do not match the current active registry");
  }
  if (fixedInput.captureKind === "exact-publication-inputs") {
    const dexTimestamps = [...new Set(Object.values(fixedInput.dexLiqMap).map((row) => row.updatedAt))];
    if (
      dexTimestamps.length !== 1 ||
      fixedInput.inputFreshness.dexLiquidity.updatedAt === null ||
      dexTimestamps[0] !== fixedInput.inputFreshness.dexLiquidity.updatedAt
    ) {
      blockers.push("Exact fixed input DEX rows do not match the DEX freshness generation");
    }
    const expectedDexGeneration = `dex-liquidity-${fixedInput.inputFreshness.dexLiquidity.updatedAt}`;
    if (fixedInput.dexGenerationId !== expectedDexGeneration) {
      blockers.push(
        `Exact fixed input DEX generation ${fixedInput.dexGenerationId} does not match ${expectedDexGeneration}`,
      );
    }

    const redemptionRows = Object.values(fixedInput.redemptionBackstopMap);
    const redemptionTimestamps = [...new Set(redemptionRows.map((row) => row.updatedAt))];
    if (redemptionRows.length > 0) {
      if (
        redemptionTimestamps.length !== 1 ||
        fixedInput.inputFreshness.redemptionBackstops.updatedAt === null ||
        redemptionTimestamps[0] !== fixedInput.inputFreshness.redemptionBackstops.updatedAt
      ) {
        blockers.push("Exact fixed input redemption rows do not match the redemption freshness generation");
      }
      if (!fixedInput.redemptionGenerationId.startsWith("redemption:")) {
        blockers.push(
          `Exact fixed input redemption generation ${fixedInput.redemptionGenerationId} is not producer-bound`,
        );
      }
    } else if (fixedInput.redemptionGenerationId !== "redemption-backstops-unavailable") {
      blockers.push(
        `Exact fixed input empty redemption generation ${fixedInput.redemptionGenerationId} is not unavailable`,
      );
    }
  }
  const registryFingerprint = computeReportCardsRegistryFingerprint();
  if (fixedInput.registryFingerprint !== registryFingerprint) {
    blockers.push(
      `Fixed input registry fingerprint ${fixedInput.registryFingerprint} does not match current ${registryFingerprint}`,
    );
  }
  if (fixedInput.inputMethodologyVersions.safetyScore !== fixedInput.methodologyVersion) {
    blockers.push("Fixed input safety-score methodology metadata is internally inconsistent");
  }
  const derivedBaseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixedInput);
  if (fixedInput.baseInputGenerationId == null) {
    blockers.push("Exact fixed input lacks a model-neutral base input generation");
  } else if (fixedInput.baseInputGenerationId !== derivedBaseInputGenerationId) {
    blockers.push(
      `Fixed input base generation ${fixedInput.baseInputGenerationId} does not match payload ${derivedBaseInputGenerationId}`,
    );
  }
  const dexPayloadFingerprint = computeDexLiquidityPayloadFingerprint(fixedInput.dexLiqMap, fixedInput.dexGenerationId);
  if (fixedInput.dexPayloadFingerprint !== dexPayloadFingerprint) {
    blockers.push(
      `Fixed input DEX payload fingerprint ${fixedInput.dexPayloadFingerprint} does not match payload ${dexPayloadFingerprint}`,
    );
  }
  const redemptionPayloadFingerprint = computeRedemptionPayloadFingerprint(
    fixedInput.redemptionBackstopMap,
    fixedInput.redemptionGenerationId,
  );
  if (fixedInput.redemptionPayloadFingerprint !== redemptionPayloadFingerprint) {
    blockers.push(
      `Fixed input redemption payload fingerprint ${fixedInput.redemptionPayloadFingerprint} does not match payload ${redemptionPayloadFingerprint}`,
    );
  }
  const projectedMethodologyVersions = projectReportCardsFixedInputMethodologyVersions({
    methodologyVersion: fixedInput.methodologyVersion,
    dexLiqMap: fixedInput.dexLiqMap,
    pegDataById: fixedInput.pegDataById,
    redemptionBackstopMap: fixedInput.redemptionBackstopMap,
  });
  if (
    stableJsonStringifyV1(fixedInput.inputMethodologyVersions) !== stableJsonStringifyV1(projectedMethodologyVersions)
  ) {
    blockers.push("Fixed input producer methodology versions do not match the score-bearing payloads");
  }
  const bindings = [
    ["DEX generation", fixedInput.dexGenerationId, calibrationSource.dexGenerationId],
    ["redemption generation", fixedInput.redemptionGenerationId, calibrationSource.redemptionGenerationId],
    ["source generation", fixedInput.sourceGeneration, calibrationSource.sourceGeneration],
    ["registry revision", fixedInput.registryRevision, calibrationSource.registryRevision],
    ["registry fingerprint", fixedInput.registryFingerprint, calibrationSource.registryFingerprint],
    ["DEX payload fingerprint", fixedInput.dexPayloadFingerprint, calibrationSource.dexPayloadFingerprint],
    [
      "redemption payload fingerprint",
      fixedInput.redemptionPayloadFingerprint,
      calibrationSource.redemptionPayloadFingerprint,
    ],
    ["capture timestamp", fixedInput.capturedAt, calibrationSource.capturedAt],
    ["publication clock", String(fixedInput.clockSec), String(calibrationSource.clockSec)],
    ["input methodology", fixedInput.methodologyVersion, calibrationSource.inputMethodologyVersion],
    ["base input generation", fixedInput.baseInputGenerationId ?? "missing", calibrationSource.baseInputGenerationId],
  ] as const;
  for (const [label, actual, expected] of bindings) {
    if (actual !== expected) blockers.push(`Fixed input ${label} ${actual} does not match calibrated ${expected}`);
  }
  if (
    stableJsonStringifyV1(fixedInput.inputMethodologyVersions) !==
    stableJsonStringifyV1(calibrationSource.inputMethodologyVersions)
  ) {
    blockers.push("Fixed input producer methodology versions do not match the calibrated input");
  }
  return blockers;
}

export function buildExitRouteObservationSet(
  dexMap: ReadinessDexMap,
  redemptionMap: RedemptionBackstopMap,
  activeIds: ReadonlySet<string>,
): MergedExitObservationSet {
  const dexObservationsByAssetId = new Map<string, readonly ExitRouteObservation[]>();
  const redemptionObservationsByAssetId = new Map<string, readonly ExitRouteObservation[]>();
  for (const assetId of [...activeIds].sort()) {
    const dexObservations = dexMap?.[assetId]?.exitRouteObservations ?? [];
    const redemptionObservations = redemptionMap[assetId]?.capacityProfile?.exitRouteObservations ?? [];
    if (dexObservations.length > 0) dexObservationsByAssetId.set(assetId, dexObservations);
    if (redemptionObservations.length > 0) redemptionObservationsByAssetId.set(assetId, redemptionObservations);
  }
  return mergeExitRouteObservationSets(dexObservationsByAssetId, redemptionObservationsByAssetId);
}

export function buildExitRouteObservationMap(
  dexMap: ReadinessDexMap,
  redemptionMap: RedemptionBackstopMap,
  activeIds: ReadonlySet<string>,
): ReadonlyMap<string, readonly ExitRouteObservation[]> {
  return buildExitRouteObservationSet(dexMap, redemptionMap, activeIds).observationsByAssetId;
}

export function summarizeRedemptionObservationCoverage(
  redemptionMap: RedemptionBackstopMap,
  activeIds: ReadonlySet<string>,
) {
  let assets = 0;
  let observations = 0;
  let scoreEligibleObservations = 0;
  let scoreEligibleAssets = 0;
  for (const assetId of activeIds) {
    const routes = redemptionMap[assetId]?.capacityProfile?.exitRouteObservations ?? [];
    if (routes.length === 0) continue;
    assets += 1;
    observations += routes.length;
    const eligible = routes.filter((route) => route.scoreEligible && route.executableUsd > 0).length;
    scoreEligibleObservations += eligible;
    if (eligible > 0) scoreEligibleAssets += 1;
  }
  return { assets, observations, scoreEligibleObservations, scoreEligibleAssets };
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

export function summarizeHistoricalRateabilityByOutcome(
  rows: readonly { classification: "adverse" | "resilient"; score: number | null }[],
) {
  return Object.fromEntries(
    (["adverse", "resilient"] as const).map((classification) => {
      const matching = rows.filter((row) => row.classification === classification);
      const rateableCount = matching.filter((row) => row.score !== null).length;
      return [
        classification,
        { fixtureCount: matching.length, rateableCount, nrCount: matching.length - rateableCount },
      ];
    }),
  ) as Record<"adverse" | "resilient", { fixtureCount: number; rateableCount: number; nrCount: number }>;
}

export interface ManualInputAuditItem {
  assetId: string;
  pillar: "global" | "peg" | "backing" | "exit" | "control";
  code: V9ReasonCode;
  classification: V9ManualInputClassification;
  critical: boolean;
  path: string | null;
  reason: string;
}

function inputFacts(
  input: CompiledV9AssetInput,
): Array<{ pillar: ManualInputAuditItem["pillar"]; fact: V9UnresolvedFact }> {
  return [
    ...input.unresolved.map((fact) => ({ pillar: "global" as const, fact })),
    ...input.peg.unresolved.map((fact) => ({ pillar: "peg" as const, fact })),
    ...(["backing", "exit", "control"] as const).flatMap((pillar) =>
      input.pillars[pillar].unresolved.map((fact) => ({ pillar, fact })),
    ),
  ];
}

export function buildManualInputAudit(compiled: readonly CompiledV9AssetInput[], policy: V9ValidatedPolicyEnvelope) {
  assertV9ValidatedPolicyEnvelope(policy);
  const items = compiled
    .flatMap((input) =>
      inputFacts(input).map(({ pillar, fact }): ManualInputAuditItem => {
        const disposition = resolveV9ReasonPolicy(policy, fact.code);
        return {
          assetId: input.assetId,
          pillar,
          code: fact.code,
          classification: disposition.reason.auditClassification,
          critical: disposition.critical,
          path: fact.path ?? null,
          reason: fact.reason,
        };
      }),
    )
    .sort(
      (left, right) =>
        left.assetId.localeCompare(right.assetId) ||
        left.pillar.localeCompare(right.pillar) ||
        left.code.localeCompare(right.code) ||
        left.reason.localeCompare(right.reason),
    );
  const byClass: Record<ManualInputAuditItem["classification"], number> = {
    "missing-data": 0,
    "unresolved-methodology": 0,
    "unsupported-design": 0,
  };
  const byCriticality = { critical: 0, noncritical: 0 };
  for (const item of items) {
    byClass[item.classification] += 1;
    byCriticality[item.critical ? "critical" : "noncritical"] += 1;
  }
  return { total: items.length, byClass, byCriticality, items };
}

export function summarizeRouteObservationCoverage(dexMap: ReadinessDexMap, activeIds: ReadonlySet<string>) {
  return Object.entries(dexMap)
    .filter(([id]) => id !== "__global__" && activeIds.has(id))
    .reduce(
      (summary, [, row]) => {
        const coverage = row.exitRouteObservationCoverage;
        increment(summary.statuses, coverage?.status ?? "unknown");
        if ((coverage?.retainedPoolCount ?? 0) > 0) summary.retainedPoolAssets += 1;
        summary.retainedPools += coverage?.retainedPoolCount ?? 0;
        summary.observations += row.exitRouteObservations?.length ?? 0;
        const eligible =
          row.exitRouteObservations?.filter((observation) => observation.scoreEligible && observation.executableUsd > 0)
            .length ?? 0;
        summary.scoreEligibleObservations += eligible;
        if (eligible > 0) summary.dexEligibleAssets += 1;
        return summary;
      },
      {
        assets: Object.keys(dexMap).filter((id) => id !== "__global__" && activeIds.has(id)).length,
        statuses: {} as Record<string, number>,
        retainedPoolAssets: 0,
        retainedPools: 0,
        observations: 0,
        scoreEligibleObservations: 0,
        dexEligibleAssets: 0,
      },
    );
}

export function applyCalibratedDexEligibility<
  T extends { dexEligibleAssets: number; scoreEligibleObservations: number },
>(coverage: T, calibrated: { eligibleAssets: number; eligibleObservations: number }) {
  return {
    ...coverage,
    rawPositiveObservationAssets: coverage.dexEligibleAssets,
    rawScoreEligibleObservations: coverage.scoreEligibleObservations,
    dexEligibleAssets: calibrated.eligibleAssets,
    scoreEligibleObservations: calibrated.eligibleObservations,
  };
}

export function assessHistoricalEvidenceIntegrity(fixtures: readonly HistoricalV9Fixture[]) {
  const sources = fixtures.flatMap((fixture) => fixture.sources);
  const sourceCaptureStatuses = sources.reduce<Record<string, number>>((result, source) => {
    increment(result, source.capture.status);
    return result;
  }, {});
  const blindingModes = fixtures.reduce<Record<string, number>>((result, fixture) => {
    increment(result, fixture.blinding.mode);
    return result;
  }, {});
  const outcomeAccess = fixtures.reduce<Record<string, number>>((result, fixture) => {
    increment(result, fixture.factFreeze.outcomeAccess);
    return result;
  }, {});
  const unarchivedSources = sourceCaptureStatuses.unarchived ?? 0;
  const unverifiedBlinding =
    (blindingModes["retrospective-unverified"] ?? 0) + (blindingModes["role-separated-fact-freeze"] ?? 0);
  const unattestedOutcomeAccess = outcomeAccess["not-attested"] ?? 0;
  const blockers = [
    ...(unarchivedSources > 0
      ? [`${unarchivedSources} historical source${unarchivedSources === 1 ? " is" : "s are"} mutable and unarchived`]
      : []),
    ...(unverifiedBlinding > 0
      ? [
          `${unverifiedBlinding} historical fixture${unverifiedBlinding === 1 ? " lacks" : "s lack"} independently verified outcome blinding`,
        ]
      : []),
    ...(unattestedOutcomeAccess > 0
      ? [
          `${unattestedOutcomeAccess} fact-freeze record${unattestedOutcomeAccess === 1 ? " lacks" : "s lack"} an outcome-access attestation`,
        ]
      : []),
  ];
  return {
    sourceCount: sources.length,
    sourceCaptureStatuses,
    blindingModes,
    outcomeAccess,
    chronologyValidation: "passed",
    immutabilityValidation: unarchivedSources === 0 ? "passed" : "blocked",
    blindingValidation: unverifiedBlinding === 0 && unattestedOutcomeAccess === 0 ? "passed" : "blocked",
    blockers,
  };
}

export function evaluateP4CoverageBlockers(args: {
  dexEligibleAssets: number;
  redemptionEligibleAssets: number;
  minimumDexEligibleAssets: number;
  minimumRedemptionEligibleAssets: number;
}): string[] {
  return [
    ...(args.dexEligibleAssets < args.minimumDexEligibleAssets
      ? [
          `DEX same-notional coverage is ${args.dexEligibleAssets} eligible assets; calibrated floor is ${args.minimumDexEligibleAssets}`,
        ]
      : []),
    ...(args.redemptionEligibleAssets < args.minimumRedemptionEligibleAssets
      ? [
          `Redemption same-notional coverage is ${args.redemptionEligibleAssets} eligible assets; calibrated floor is ${args.minimumRedemptionEligibleAssets}`,
        ]
      : []),
  ];
}

export function evaluateCalibrationActivationBlockers(activationDecision: {
  decision: string;
  activationReady: boolean;
  decisionConsistentWithGate: boolean;
  blockers: readonly string[];
}): string[] {
  return [
    ...(activationDecision.decision === "activate"
      ? []
      : [`P4 calibration decision is ${activationDecision.decision}, not activate`]),
    ...(activationDecision.activationReady ? [] : ["P4 calibration activation gate is not ready"]),
    ...(activationDecision.decisionConsistentWithGate
      ? []
      : ["P4 calibration decision is inconsistent with its activation gate"]),
    ...activationDecision.blockers.map((blocker) => `P4 calibration blocker: ${blocker}`),
  ];
}

export function selectExactActiveReportCards<T extends { id: string; isDefunct: boolean }>(
  cards: readonly T[],
  activeIds: readonly string[],
): T[] {
  const activeCards = cards.filter((card) => !card.isDefunct);
  assertExactReportCardIds(activeIds, activeCards);
  return activeCards;
}

export function generateV9ReadinessReport(args: { reportCards: unknown; fixedInput: unknown; generatedAt: string }) {
  const reportCards = ReportCardsResponseSchema.parse(args.reportCards);
  const fixedInput = parseFixedPublicationInput(args.fixedInput);
  const dexMap = fixedInput.dexLiqMap;
  const historical = HistoricalV9FixtureCorpusSchema.parse(historicalFixtureAsset);
  const cohort = calibrationCohortAsset as CalibrationCohortAsset;
  const generatedAtMs = Date.parse(args.generatedAt);
  if (!Number.isFinite(generatedAtMs)) throw new Error("--generated-at must be an ISO timestamp");

  const activeRegistryIds = ACTIVE_STABLECOINS.map((meta) => meta.id);
  const activeIds = new Set(activeRegistryIds);
  const cohortMissingIds = cohort.assets
    .map((entry) => entry.assetId)
    .filter((id) => !activeIds.has(id))
    .sort();
  if (cohortMissingIds.length > 0) {
    throw new Error(`Calibration cohort references inactive or missing assets: ${cohortMissingIds.join(", ")}`);
  }

  const activeCards = selectExactActiveReportCards(reportCards.cards, activeRegistryIds);
  const exitObservationSet = buildExitRouteObservationSet(dexMap, fixedInput.redemptionBackstopMap, activeIds);
  const exitRouteObservationsById = exitObservationSet.observationsByAssetId;
  const runtimeEvidenceTimes = [
    ...Object.entries(dexMap)
      .filter(([id]) => id !== "__global__" && activeIds.has(id))
      .map(([, row]) => row.updatedAt),
    ...[...exitRouteObservationsById.values()].flatMap((observations) =>
      observations.map((observation) => observation.observedAt),
    ),
  ];
  const bindingBlockers = assessReadinessInputBindings({
    fixedInput,
    reportCards,
    activeIds: activeRegistryIds,
    suppliedEvidenceTimes: runtimeEvidenceTimes,
  });
  const basicProvenance = assessFixedInputProvenance(fixedInput);
  const fixedInputProvenance = {
    ...basicProvenance,
    blockers: [...basicProvenance.blockers, ...bindingBlockers],
  };
  const asOf = new Date(fixedInput.clockSec * 1_000).toISOString();
  if (generatedAtMs < Date.parse(asOf))
    throw new Error("generatedAt cannot be earlier than the fixed publication clock");
  const compiled = compileReportCardSetToV9Inputs(ACTIVE_STABLECOINS, activeCards, {
    policy: V9_CANDIDATE_POLICY_V1,
    asOf,
    compiledAt: args.generatedAt,
    methodologyVersion: reportCards.methodology.version,
    reportCardObservedAt: new Date(reportCards.updatedAt * 1_000).toISOString(),
    dexExitObservationMaxAgeSec: CRON_INTERVALS["sync-dex-liquidity"] * 2,
    liveRedemptionExitObservationMaxAgeSec: CRON_INTERVALS["sync-redemption-backstops"] * 2,
    exitRouteObservationsById,
    dexLiquidityById: new Map(Object.entries(dexMap).filter(([id]) => id !== "__global__" && activeIds.has(id))),
  });
  const evaluated = scoreCompiledAssetSet(compiled, V9_CANDIDATE_POLICY_V1);
  const cardsById = new Map(activeCards.map((card) => [card.id, card]));

  const archetypes: Record<string, number> = {};
  const unresolvedByCode: Record<string, number> = {};
  const criticalUnresolvedByCode: Record<string, number> = {};
  const evidenceLevels: Record<string, Record<string, number>> = {
    backing: {},
    exit: {},
    control: {},
  };
  for (const input of compiled) {
    increment(archetypes, input.archetype ?? "unresolved");
    for (const pillar of ["backing", "exit", "control"] as const) {
      increment(evidenceLevels[pillar]!, input.pillars[pillar].evidenceLevel);
    }
    for (const fact of [
      ...input.unresolved,
      ...input.peg.unresolved,
      ...Object.values(input.pillars).flatMap((pillar) => pillar.unresolved),
    ]) {
      increment(unresolvedByCode, fact.code);
      if (fact.critical) increment(criticalUnresolvedByCode, fact.code);
    }
  }
  const manualInputAudit = buildManualInputAudit(compiled, V9_CANDIDATE_POLICY_V1);

  const gradeDistribution: Record<string, number> = {};
  const bindingReasons: Record<string, number> = {};
  const movements = evaluated.traces.map((trace) => {
    increment(gradeDistribution, trace.finalGrade);
    increment(bindingReasons, trace.bindingCap?.kind ?? (trace.finalGrade === "NR" ? "NR" : "uncapped"));
    const current = cardsById.get(trace.assetId)!;
    return {
      assetId: trace.assetId,
      currentScore: current.overallScore,
      currentGrade: current.overallGrade,
      candidateScore: trace.finalScore,
      candidateGrade: trace.finalGrade,
      delta: current.overallScore == null || trace.finalScore == null ? null : trace.finalScore - current.overallScore,
      bindingReason: trace.bindingCap?.kind ?? null,
      nrReasons: trace.nrReasons,
    };
  });
  const largestMovements = [...movements]
    .filter((movement) => movement.delta != null)
    .sort((left, right) => Math.abs(right.delta!) - Math.abs(left.delta!) || left.assetId.localeCompare(right.assetId))
    .slice(0, 25);
  const gradeChanges = movements.filter((movement) => movement.currentGrade !== movement.candidateGrade);

  const routeCoverage = summarizeRouteObservationCoverage(dexMap, activeIds);
  const redemptionEligibleAssets = exitRouteCalibrationAsset.coverage.redemption.eligibleAssets;
  const redemptionRouteCoverage = summarizeRedemptionObservationCoverage(fixedInput.redemptionBackstopMap, activeIds);
  const calibratedDexEligibleAssets = exitRouteCalibrationAsset.coverage.dex.eligibleAssets;
  const minimumCoveragePolicy = exitRouteCalibrationAsset.activationDecision.minimumCoveragePolicy;
  const p4CoverageBlockers = evaluateP4CoverageBlockers({
    dexEligibleAssets: calibratedDexEligibleAssets,
    redemptionEligibleAssets,
    minimumDexEligibleAssets: minimumCoveragePolicy.dexEligibleAssets,
    minimumRedemptionEligibleAssets: minimumCoveragePolicy.redemptionEligibleAssets,
  });
  const calibrationActivationBlockers = evaluateCalibrationActivationBlockers(
    exitRouteCalibrationAsset.activationDecision,
  );

  const adverse = historical.fixtures.filter((fixture) => fixture.outcome.classification === "adverse");
  const resilient = historical.fixtures.filter((fixture) => fixture.outcome.classification === "resilient");
  const historicalCategories: Record<string, number> = {};
  for (const fixture of historical.fixtures) {
    for (const category of fixture.outcome.categories) increment(historicalCategories, category);
  }
  const historicalTraces = historical.fixtures.map((fixture) => ({
    fixture,
    trace: scoreCompiledAsset(
      compileHistoricalFixtureToV9Input(historicalFactsInput(fixture), V9_CANDIDATE_POLICY_V1),
      V9_CANDIDATE_POLICY_V1,
    ),
  }));
  const historicalIntegrity = assessHistoricalEvidenceIntegrity(historical.fixtures);
  const historicalFalseNegatives = historicalTraces
    .filter(
      ({ fixture, trace }) =>
        fixture.outcome.classification === "adverse" && trace.finalScore != null && trace.finalScore >= 70,
    )
    .map(({ fixture, trace }) => ({
      fixtureId: fixture.id,
      score: trace.finalScore,
      rootCause: "Point-in-time structured facts did not create a sufficiently strong candidate failure signal.",
      followUp: "Review the missing exposure, route, or control fact without adding post-outcome evidence.",
    }));
  const historicalFalsePositives = historicalTraces
    .filter(
      ({ fixture, trace }) =>
        fixture.outcome.classification === "resilient" && (trace.finalScore == null || trace.finalScore < 50),
    )
    .map(({ fixture, trace }) => ({ fixtureId: fixture.id, score: trace.finalScore, nrReasons: trace.nrReasons }));
  const historicalRateabilityByOutcome = summarizeHistoricalRateabilityByOutcome(
    historicalTraces.map(({ fixture, trace }) => ({
      classification: fixture.outcome.classification,
      score: trace.finalScore,
    })),
  );

  const nrCount = evaluated.traces.filter((trace) => trace.finalGrade === "NR").length;
  const criticalUnresolvedCount = Object.values(criticalUnresolvedByCode).reduce((sum, value) => sum + value, 0);
  const blockers = [
    ...fixedInputProvenance.blockers,
    ...(nrCount > 0 ? [`${nrCount} active assets compile to reason-coded NR`] : []),
    ...(criticalUnresolvedCount > 0 ? [`${criticalUnresolvedCount} critical facts remain unresolved`] : []),
    ...calibrationActivationBlockers,
    ...p4CoverageBlockers,
    ...historicalIntegrity.blockers,
  ];
  const traceById = new Map(evaluated.traces.map((trace) => [trace.assetId, trace]));
  const compiledById = new Map(compiled.map((input) => [input.assetId, input]));
  const cohortDispositions = cohort.assets
    .map((entry) => {
      const input = compiledById.get(entry.assetId)!;
      const trace = traceById.get(entry.assetId)!;
      const criticalFacts = inputFacts(input)
        .filter(({ fact }) => fact.critical)
        .map(({ pillar, fact }) => ({ pillar, code: fact.code, path: fact.path ?? null, reason: fact.reason }))
        .sort(
          (left, right) =>
            left.pillar.localeCompare(right.pillar) ||
            left.code.localeCompare(right.code) ||
            left.reason.localeCompare(right.reason),
        );
      return {
        assetId: entry.assetId,
        cohorts: entry.cohorts,
        disposition: criticalFacts.length === 0 ? "critical-inputs-complete" : "reason-coded-critical-unresolved",
        candidateGrade: trace.finalGrade,
        criticalFacts,
      };
    })
    .sort((left, right) => left.assetId.localeCompare(right.assetId));

  return {
    schemaVersion: 1,
    generatedAt: args.generatedAt,
    candidatePolicy: {
      policyId: V9_CANDIDATE_POLICY_V1.policy.policyId,
      lifecycle: V9_CANDIDATE_POLICY_V1.policy.lifecycle,
      semanticDigest: V9_CANDIDATE_POLICY_V1.semanticDigest,
    },
    input: {
      reportCardsAsOf: new Date(reportCards.updatedAt * 1_000).toISOString(),
      compilerEvidenceAsOf: asOf,
      currentMethodologyVersion: reportCards.methodology.version,
      activeRegistryCount: ACTIVE_STABLECOINS.length,
      activeReportCardCount: activeCards.length,
      fixedInput: fixedInputProvenance,
    },
    calibrationCohort: {
      version: cohort.version,
      assetCount: cohort.assets.length,
      cohortCounts: cohort.assets
        .flatMap((entry) => entry.cohorts)
        .reduce<Record<string, number>>((result, name) => {
          increment(result, name);
          return result;
        }, {}),
      dispositions: cohortDispositions,
    },
    historicalCalibration: {
      corpusVersion: historical.schemaVersion,
      fixtureCount: historical.fixtures.length,
      adverseCount: adverse.length,
      resilientCount: resilient.length,
      categoryCounts: historicalCategories,
      lookAheadValidation: historicalIntegrity.chronologyValidation,
      evidenceIntegrity: historicalIntegrity,
      evaluationMode: "facts-only typed compiler; outcomes excluded from scorer input",
      rateabilityByOutcome: historicalRateabilityByOutcome,
      candidateGradeDistribution: historicalTraces.reduce<Record<string, number>>((result, { trace }) => {
        increment(result, trace.finalGrade);
        return result;
      }, {}),
      falseNegatives: historicalFalseNegatives,
      falsePositives: historicalFalsePositives,
    },
    compiler: {
      compiledCount: compiled.length,
      exceptionCount: 0,
      silentOmissionCount: ACTIVE_STABLECOINS.length - compiled.length,
      rateableCount: compiled.length - nrCount,
      nrCount,
      evaluatedOrder: evaluated.evaluatedOrder,
      archetypeDistribution: archetypes,
      evidenceLevels,
      unresolvedByCode,
      criticalUnresolvedByCode,
      unexplainedManualPillarValueCount: 0,
      scenarioSuppliedCapCount: 0,
    },
    routeObservationCoverage: {
      ...applyCalibratedDexEligibility(routeCoverage, {
        eligibleAssets: calibratedDexEligibleAssets,
        eligibleObservations: exitRouteCalibrationAsset.coverage.dex.eligibleObservations,
      }),
      redemptionEligibleAssets,
      redemptionObservations: redemptionRouteCoverage,
      outputResolutionByLane: exitObservationSet.summary,
      calibratedCoverageSource: `exit-route-calibration:${exitRouteCalibrationAsset.generationId}`,
      calibrationActivationDecision: exitRouteCalibrationAsset.activationDecision.decision,
      calibrationActivationReady: exitRouteCalibrationAsset.activationDecision.activationReady,
      calibrationDecisionBlockers: exitRouteCalibrationAsset.activationDecision.blockers,
      calibratedMinimumEligibleAssets: {
        dex: minimumCoveragePolicy.dexEligibleAssets,
        redemption: minimumCoveragePolicy.redemptionEligibleAssets,
      },
      calibratedFloorMet: p4CoverageBlockers.length === 0,
      blockers: p4CoverageBlockers,
    },
    shadowEvaluation: {
      gradeDistribution,
      bindingReasons,
      gradeChangeCount: gradeChanges.length,
      nrEntryCount: movements.filter((movement) => movement.currentGrade !== "NR" && movement.candidateGrade === "NR")
        .length,
      largestMovements,
    },
    remainingManualInputs: manualInputAudit,
    recommendation: {
      decision: blockers.length === 0 ? "go" : "no-go",
      blockers,
      dataReadiness: criticalUnresolvedCount === 0 ? "ready" : "not-ready",
      methodologyCalibration: "provisional",
      provisionalConstants: [
        "pillar weights",
        "bounded-compensability headroom",
        "evidence ceilings",
        "track-record ceilings",
        "signal-to-cap limits",
        "same-notional stress request",
      ],
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: {
      "report-cards": { type: "string" },
      "fixed-input": { type: "string" },
      output: { type: "string" },
      "generated-at": { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  if (typeof values["report-cards"] !== "string") throw new Error("--report-cards is required");
  if (typeof values["fixed-input"] !== "string") throw new Error("--fixed-input is required");
  if (typeof values.output !== "string") throw new Error("--output is required");
  if (typeof values["generated-at"] !== "string") throw new Error("--generated-at is required");

  const report = generateV9ReadinessReport({
    reportCards: JSON.parse(readFileSync(values["report-cards"], "utf8")) as unknown,
    fixedInput: JSON.parse(readFileSync(values["fixed-input"], "utf8")) as unknown,
    generatedAt: values["generated-at"],
  });
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(main, { label: "safety-score-v9:readiness", usage: USAGE });
}
