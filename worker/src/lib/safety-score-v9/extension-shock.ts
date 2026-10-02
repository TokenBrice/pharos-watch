import shockCoverageRegistryAsset from "@shared/data/safety-score-v9/shock-coverage-measurements-v1.json";
import { V9CdpStressCoverageFactSchema, type V9CdpStressCoverageFact } from "@shared/types/safety-score-v9-backing";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { isRecord } from "@shared/lib/type-guards";
import { z } from "zod";
import { CanonicalTextSchema } from "@shared/types/safety-schema-primitives";
import { createReviewedAssetRegistry } from "./extension-reviewed-registry";

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

const RegistryEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("safety-score-v9-shock-coverage-registry"),
  measurements: z.array(z.object({ assetId: CanonicalTextSchema }).passthrough()),
}).strict();
const SHOCK_COVERAGE_REGISTRY = RegistryEnvelopeSchema.parse(shockCoverageRegistryAsset);
const measurements = createReviewedAssetRegistry({
  rows: SHOCK_COVERAGE_REGISTRY.measurements,
  schema: RegistryEntrySchema,
  path: "shockCoverage.measurements",
  keyOf: (row) => {
    const block = row.block;
    return isRecord(block) && typeof block.timestampUnix === "number" ? `${row.assetId}:${block.timestampUnix}` : undefined;
  },
  keyPath: "block.timestampUnix",
});
type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

/** Admit every authored measurement before chronology selection can hide a bad row. */
export function validateSafetyScoreV9ShockRegistryAsset(assetId: string): void {
  measurements.getAll(assetId);
}

function latestMeasurement(assetId: string, asOfSec: number): RegistryEntry | null {
  const eligible = measurements.getAll(assetId)
    .filter((measurement) => measurement.block.timestampUnix <= asOfSec)
    .sort(
      (left, right) =>
        left.block.timestampUnix - right.block.timestampUnix ||
        (left.journalPath < right.journalPath ? -1 : left.journalPath > right.journalPath ? 1 : 0),
    );
  const latest = eligible[eligible.length - 1];
  if (!latest) return null;
  return latest;
}

/**
 * Projects a registry row admitted lazily inside its asset's isolation boundary.
 * The entry schema is narrower than `V9CdpStressCoverageFactSchema`, so the
 * projection does not re-parse. Supplied replay-pinned facts remain untrusted
 * input and are separately parsed in `validatePinnedMeasurement`.
 */
function projectMeasurement(measurement: RegistryEntry): V9CdpStressCoverageFact {
  const measured = measurement.measuredFacts;
  return {
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
  };
}

function validatePinnedMeasurement(assetId: string, value: unknown, asOfSec: number): void {
  // Supplied facts are untrusted replay input, so this parse stays.
  const supplied = V9CdpStressCoverageFactSchema.parse(value);
  const source = supplied.source;
  if (source === null || source.block.timestampUnix > asOfSec) {
    throw new Error(`Replay-pinned shock coverage for ${assetId} lacks chronology-valid journal provenance`);
  }
  const registered = measurements.getAll(assetId).find(
    (measurement) =>
      measurement.journalPath === source.journalPath &&
      measurement.journalSha256 === source.journalSha256,
  );
  if (!registered) throw new Error(`Replay-pinned shock coverage for ${assetId} is not in the committed registry`);
  // Canonical-form comparison: the journal sha256 pins the *journal file*, not
  // the supplied fact body, so the whole projection still has to match. Stable
  // canonicalization makes the comparison key-order independent instead of
  // depending on JSON.stringify insertion order.
  const normalizedSupplied = { ...supplied, evidenceRefIds: [] };
  if (
    stableJsonStringifyV1(normalizedSupplied) !== stableJsonStringifyV1(projectMeasurement(registered))
  ) {
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

/**
 * Materializes one asset's chronology-bounded journal facts without replacing
 * replay-pinned facts. A pinned fact that fails provenance throws; extension
 * admission quarantines that asset rather than the cohort.
 */
export function hydrateSafetyScoreV9ShockCoverageAsset(asset: unknown, asOfSec: number): unknown {
  if (!isRecord(asset) || asset.archetype !== "cdp" || typeof asset.assetId !== "string") {
    return asset;
  }
  if (Object.prototype.hasOwnProperty.call(asset, "cdpStressCoverage")) {
    validatePinnedMeasurement(asset.assetId, asset.cdpStressCoverage, asOfSec);
    return asset;
  }
  const measurement = selectSafetyScoreV9CdpShockMeasurement(asset.assetId, asOfSec);
  return measurement === undefined ? asset : { ...asset, cdpStressCoverage: measurement };
}
