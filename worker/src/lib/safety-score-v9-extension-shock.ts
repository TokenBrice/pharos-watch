import shockCoverageRegistryAsset from "@shared/data/safety-score-v9/shock-coverage-measurements-v1.json";
import { V9CdpStressCoverageFactSchema, type V9CdpStressCoverageFact } from "@shared/types/safety-score-v9-backing";
import { isRecord } from "@shared/lib/type-guards";
import { z } from "zod";

const RegistryEntrySchema = z
  .object({
    journalPath: z.string().min(1),
    journalSha256: z.string().regex(/^[0-9a-f]{64}$/),
    assetId: z.string().min(1),
    archetype: z.literal("cdp"),
    family: z.string().min(1),
    applicability: z.enum(["measured", "not-measured"]),
    failureReason: z.string().min(1).nullable(),
    complete: z.boolean(),
    blockers: z.array(z.string().min(1)),
    exactReplayPassed: z.boolean(),
    replayVerification: z
      .object({
        attestationPath: z.string().min(1),
        attestedAt: z.string().date(),
        toolPath: z.string().min(1),
        toolVersion: z.string().min(1),
        mode: z.literal("offline-byte-identical"),
        callsConsumed: z.number().int().nonnegative(),
        codePinsConsumed: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    block: z
      .object({
        number: z.number().int().nonnegative(),
        hash: z.string().regex(/^0x[0-9a-f]{64}$/),
        timestampUnix: z.number().int().nonnegative(),
        timestampIso: z.string().datetime(),
      })
      .strict(),
    sourcePin: z
      .object({
        repository: z.string().url(),
        commit: z.string().regex(/^[0-9a-f]{40}$/),
        liquidationContractPath: z.string().min(1),
      })
      .strict(),
    shockPolicy: z
      .object({
        scoreShockFractionPpm: z.number().int().min(0).max(1_000_000),
        sensitivityShockFractionsPpm: z.array(z.number().int().min(0).max(1_000_000)),
        debtReconciliationTolerancePpm: z.number().int().nonnegative(),
      })
      .strict(),
    measuredFacts: z
      .object({
        applicability: z.enum(["measured", "not-measured"]),
        failureReason: z.string().min(1).nullable(),
        stressShockFraction: z.number().finite().min(0).max(1).nullable(),
        stressLiquidatableDebt: z
          .string()
          .regex(/^[0-9]+$/)
          .nullable(),
        stressPoolOffsetDebt: z
          .string()
          .regex(/^[0-9]+$/)
          .nullable(),
        stressLiquidationCoverageRatio: z.number().finite().min(0).max(1).nullable(),
        branchContributions: z.array(
          z
            .object({
              branchIndex: z.number().int().nonnegative(),
              stressLiquidatableDebt: z.string().regex(/^[0-9]+$/),
              stressPoolOffsetDebt: z.string().regex(/^[0-9]+$/),
              stressLiquidationCoverageRatio: z.number().finite().min(0).max(1),
            })
            .strict(),
        ),
      })
      .strict(),
    codePins: z.array(
      z
        .object({
          name: z.string().min(1),
          address: z.string().regex(/^0x[0-9a-f]{40}$/),
          role: z.string().min(1),
          codeHash: z.string().regex(/^0x[0-9a-f]{64}$/),
        })
        .strict(),
    ),
  })
  .strict();

const RegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("safety-score-v9-shock-coverage-registry"),
    measurements: z.array(RegistryEntrySchema),
  })
  .strict()
  .superRefine((registry, ctx) => {
    const keys = registry.measurements.map(
      (measurement) => `${measurement.assetId}:${measurement.block.timestampUnix}`,
    );
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", path: ["measurements"], message: "Measurement clocks must be unique per asset" });
    }
  });

const SHOCK_COVERAGE_REGISTRY = RegistrySchema.parse(shockCoverageRegistryAsset);
type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

function latestMeasurement(assetId: string, asOfSec: number): RegistryEntry | null {
  const eligible = SHOCK_COVERAGE_REGISTRY.measurements
    .filter((measurement) => measurement.assetId === assetId && measurement.block.timestampUnix <= asOfSec)
    .sort(
      (left, right) =>
        left.block.timestampUnix - right.block.timestampUnix ||
        (left.journalPath < right.journalPath ? -1 : left.journalPath > right.journalPath ? 1 : 0),
    );
  const latest = eligible[eligible.length - 1];
  if (!latest) return null;
  return latest;
}

function projectMeasurement(measurement: RegistryEntry): V9CdpStressCoverageFact {
  const measured = measurement.measuredFacts;
  return V9CdpStressCoverageFactSchema.parse({
    family: measurement.family,
    applicability: measurement.applicability,
    failureReason: measurement.failureReason,
    complete: measurement.complete,
    blockers: measurement.blockers,
    exactReplayPassed: measurement.exactReplayPassed,
    replayVerification: measurement.replayVerification,
    source: {
      journalPath: measurement.journalPath,
      journalSha256: measurement.journalSha256,
      block: measurement.block,
      sourcePin: measurement.sourcePin,
    },
    shockPolicy: measurement.shockPolicy,
    stressShockFraction: measured.stressShockFraction,
    stressLiquidatableDebt: measured.stressLiquidatableDebt,
    stressPoolOffsetDebt: measured.stressPoolOffsetDebt,
    stressLiquidationCoverageRatio: measured.stressLiquidationCoverageRatio,
    branchContributions: measured.branchContributions,
    codeHashPins: measurement.codePins,
    evidenceRefIds: [],
  });
}

function validatePinnedMeasurement(assetId: string, value: unknown, asOfSec: number): void {
  const supplied = V9CdpStressCoverageFactSchema.parse(value);
  const source = supplied.source;
  if (source === null || source.block.timestampUnix > asOfSec) {
    throw new Error(`Replay-pinned shock coverage for ${assetId} lacks chronology-valid journal provenance`);
  }
  const registered = SHOCK_COVERAGE_REGISTRY.measurements.find(
    (measurement) =>
      measurement.assetId === assetId &&
      measurement.journalPath === source.journalPath &&
      measurement.journalSha256 === source.journalSha256,
  );
  if (!registered) throw new Error(`Replay-pinned shock coverage for ${assetId} is not in the committed registry`);
  const normalizedSupplied = { ...supplied, evidenceRefIds: [] };
  if (JSON.stringify(normalizedSupplied) !== JSON.stringify(projectMeasurement(registered))) {
    throw new Error(`Replay-pinned shock coverage for ${assetId} differs from its committed journal projection`);
  }
}

export function selectSafetyScoreV9CdpShockMeasurement(
  assetId: string,
  asOfSec: number,
): V9CdpStressCoverageFact | undefined {
  const measurement = latestMeasurement(assetId, asOfSec);
  if (!measurement) return undefined;

  return projectMeasurement(measurement);
}

/** Materializes chronology-bounded journal facts without replacing replay-pinned facts. */
export function hydrateSafetyScoreV9ShockCoverageExtension(extension: unknown, asOfSec: number): unknown {
  if (!isRecord(extension) || !Array.isArray(extension.assets)) return extension;
  return {
    ...extension,
    assets: extension.assets.map((asset) => {
      if (!isRecord(asset) || asset.archetype !== "cdp" || typeof asset.assetId !== "string") {
        return asset;
      }
      if (Object.prototype.hasOwnProperty.call(asset, "cdpStressCoverage")) {
        validatePinnedMeasurement(asset.assetId, asset.cdpStressCoverage, asOfSec);
        return asset;
      }
      const measurement = selectSafetyScoreV9CdpShockMeasurement(asset.assetId, asOfSec);
      return measurement === undefined ? asset : { ...asset, cdpStressCoverage: measurement };
    }),
  };
}
