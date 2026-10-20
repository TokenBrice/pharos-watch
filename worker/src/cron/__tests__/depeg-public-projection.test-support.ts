import {
  DdrFrozenDurationSchema,
  DdrPredictionMetaSchema,
  DdrV2BaseRowSchema,
  DdrV2FrozenPayloadSchema,
  DdrV2NoCallPayloadSchema,
  type DdrRow,
} from "@shared/types/depeg-resolver";
import { readRecord } from "@shared/lib/type-guards";
import type {
  DdrCanonicalIncident,
  DdrPublicationManifest,
  DdrSealedPublicPrediction,
} from "../depeg-resolver-v2-contracts";

interface ResolverRowOptions {
  defaultAgeSec?: number;
  factorLabel?: string;
  name?: string;
  nowSec?: number;
  stablecoinId?: string;
  symbol?: string;
}

export function makeDdrResolverRow(
  overrides: Partial<DdrRow> = {},
  options: ResolverRowOptions = {},
): DdrRow {
  const nowSec = options.nowSec ?? 1_779_984_600;
  const startedAt = overrides.startedAt ?? nowSec - (options.defaultAgeSec ?? 6 * 3600);
  return {
    stablecoinId: options.stablecoinId ?? "projection-test",
    symbol: options.symbol ?? "PRJ",
    name: options.name ?? "Projection Test",
    pegCurrency: "USD",
    governance: "decentralized",
    status: "active",
    eventId: 42,
    startedAt,
    ageSec: overrides.ageSec ?? nowSec - startedAt,
    direction: "below",
    peakDeviationBps: -250,
    currentDeviationBps: -180,
    resolution: {
      tier: "recovery_likely",
      factors: [
        {
          code: "R2_hard_collateral_redemption",
          kind: "anchor",
          severity: "strong",
          label: options.factorLabel ?? "Fixture has a hard collateral recovery anchor",
        },
      ],
    },
    duration: {
      suppressed: false,
      suppressedReason: null,
      stratum: "below - moderate - robust - USD",
      medianSec: 3600,
      iqrSec: [1800, 7200],
      ageStatus: "ordinary",
      horizons: [
        {
          horizon: "6h",
          state: "benchmarked",
          probability: 0.75,
          probabilityDisplay: "70-80%",
          probabilityInterval: { lower: 0.7, upper: 0.8 },
          rawAtRisk: 20,
          uniqueCoins: 12,
          intervalClosures: 15,
          intervalNonClosures: 5,
        },
      ],
    },
    relatedContext: {
      dewsBand: "WATCH",
      dewsScore: 22,
      liquidityScore: 88,
      safetyGrade: "A",
      safetyScore: 91,
      supplyChange7dPct: 0,
      supplyChange30dPct: 0,
      mintSurge: false,
    },
    ...overrides,
  };
}

export function makeDdrCanonicalIncident(
  row: DdrRow,
  overrides: Partial<DdrCanonicalIncident> = {},
): DdrCanonicalIncident {
  return {
    incidentKey: `ddr2:projection-${row.eventId}`,
    eventId: row.eventId,
    currentEventId: row.eventId,
    stablecoinId: row.stablecoinId,
    pegCurrency: row.pegCurrency,
    direction: row.direction,
    startedAt: row.startedAt,
    eligibleAt: row.startedAt + 24 * 3600,
    policyUniverseIncluded: true,
    rolloutActiveAtEnablement: true,
    confirmedAt: null,
    lockState: null,
    ...overrides,
  };
}

export type DdrSealedPredictionOverrides = Partial<Omit<DdrSealedPublicPrediction, "sealedPayload">> & {
  sealedPayload?: Record<string, unknown>;
};

export function makeDdrSealedPublicPrediction(
  overrides: DdrSealedPredictionOverrides = {},
): DdrSealedPublicPrediction {
  const payload = overrides.sealedPayload ?? {};
  const lockedAt = overrides.lockedAt ?? 1_779_984_600;
  const eventAgeAtLockSec = overrides.eventAgeAtLockSec ?? 86_400;
  const row = makeDdrResolverRow({
    eventId: overrides.eventId ?? 42,
    startedAt: lockedAt - eventAgeAtLockSec,
  });
  const base = DdrV2BaseRowSchema.parse({ ...row, incidentKey: overrides.incidentKey ?? "ddr2:fixture", ...payload });
  const prediction = DdrPredictionMetaSchema.partial().parse(payload.prediction ?? {});
  const frozen = readRecord(payload.frozen);
  const rawDuration = readRecord(frozen?.duration);
  const duration = DdrFrozenDurationSchema.parse({
    ...row.duration,
    remainingAsOf: lockedAt,
    medianResolveAt: lockedAt + 3600,
    iqrResolveAt: [lockedAt + 1800, lockedAt + 7200],
    ...rawDuration,
    horizons: ((rawDuration?.horizons ?? row.duration.horizons) as DdrRow["duration"]["horizons"]).map((cell) => ({
      ...cell,
      horizonEndAt: lockedAt + ({ "6h": 21600, "24h": 86400, "7d": 604800, "30d": 2592000 } as const)[cell.horizon],
      anchoredLabel: `within ${cell.horizon} of lock`,
    })),
  });
  const sealedPayload = overrides.outcomeKind === "no_call"
    ? {
        ...base, kind: "no_call" as const, prediction, frozen: null,
        noCall: DdrV2NoCallPayloadSchema.parse({
          lockedAt, eventAgeAtLockSec, missingReasons: [], relatedContext: row.relatedContext,
          ...readRecord(payload.noCall),
        }),
      }
    : {
        ...base, kind: "prediction" as const, prediction,
        frozen: DdrV2FrozenPayloadSchema.parse({
          resolution: row.resolution, relatedContext: row.relatedContext, sourceRow: row,
          ...frozen, duration,
        }),
      };
  const metadata: Omit<DdrSealedPublicPrediction, "outcomeKind" | "sealedPayload"> = {
    id: 7,
    incidentKey: "ddr2:fixture",
    eventId: 42,
    assessmentId: 70,
    predictionPolicyVersion: "sticky-24h-v1",
    predictionMethodologyVersion: "2.0",
    predictionMethodologyVersionLabel: "v2.0",
    resolutionRubricVersion: "resolution-rubric-v2",
    durationModelVersion: "duration-landmark-v2",
    incidentGroupingVersion: "incident-group-v2",
    supportRulesVersion: "support-rules-v2",
    policyDelaySec: 86_400,
    eligibleAt: 1_779_984_600,
    lockedAt: 1_779_984_600,
    eventAgeAtLockSec: 86_400,
    lockTiming: "on_time",
    lockTrigger: null,
    forecastReadinessScore: null,
    forecastReadinessVersion: null,
    readinessThreshold: null,
    backstopAt: null,
    backstopDelaySec: null,
    rowHash: "a".repeat(64),
    createdAt: overrides.lockedAt ?? 1_779_984_600,
    ...overrides,
    sealedPayloadJson: JSON.stringify(sealedPayload),
  };
  return sealedPayload.kind === "prediction"
    ? { ...metadata, outcomeKind: "prediction", sealedPayload }
    : { ...metadata, outcomeKind: "no_call", sealedPayload };
}

export function makeDdrPublicationManifest(
  overrides: Partial<DdrPublicationManifest> = {},
): DdrPublicationManifest {
  return {
    snapshotToken: "ddr-public-1",
    snapshotKind: "ddr_public",
    snapshotGeneration: 2,
    snapshotSequence: 1,
    publishedAt: 1_779_984_600,
    basePayloadHash: "b".repeat(64),
    publicPredictionIdsHash: "c".repeat(64),
    publicPredictionIds: [7],
    publicPredictionRowHashes: { 7: "a".repeat(64) },
    basePayloadJson: JSON.stringify({ rows: [] }),
    baseRowCount: 0,
    publicPredictionCount: 1,
    createdAt: 1_779_984_600,
    finalizedAt: 1_779_984_600,
    validatorVersion: "vitest",
    ...overrides,
  };
}
