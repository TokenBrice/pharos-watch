import {
  DdrRowSchema,
  DdrV2ResponseRowSchema,
  type DdrResolutionTier,
  type DdrResponse,
  type DdrRow,
  type DdrV2LiveOverlay,
  type DdrV2ResponseRow,
} from "@shared/types/depeg-resolver";
import { DDR_METHODOLOGY_VERSION, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/depeg-resolver";

export const DDR_TEST_META: DdrResponse["_meta"] = {
  schemaVersion: 2,
  dataAsOf: 1,
  modelAsOf: 1,
  computedAt: 1,
  expiresAt: 2,
  snapshotToken: null,
  snapshotGeneration: null,
  publicPredictionIds: [],
  publicPredictionRowHashes: {},
  basePayloadHash: null,
  readOverlay: { degradedLockDeferralIncidentKeys: [], closedPendingReviewIncidentKeys: [], suppressedIncidentKeys: [] },
  degraded: false,
  degradedReason: null,
  publicWarning: "",
  resolutionRubricVersion: "resolution-rubric-v1",
  durationModelVersion: "duration-landmark-v1",
  incidentGroupingVersion: "incident-group-v1",
  supportRulesVersion: "support-rules-v1",
  lineage: null,
};

export function makeDdrSourceRow(overrides: Partial<DdrRow> = {}): DdrRow {
  return DdrRowSchema.parse({
    stablecoinId: "lusd-liquity",
    symbol: "LUSD",
    name: "Liquity USD",
    pegCurrency: "USD",
    governance: "decentralized",
    status: null,
    eventId: 1,
    startedAt: 1,
    ageSec: 3600,
    direction: "below",
    peakDeviationBps: -300,
    currentDeviationBps: -250,
    resolution: { tier: "at_risk", factors: [] },
    duration: {
      suppressed: true,
      suppressedReason: "insufficient_support",
      stratum: null,
      medianSec: null,
      iqrSec: null,
      ageStatus: null,
      horizons: [],
    },
    relatedContext: {
      dewsBand: null,
      dewsScore: null,
      liquidityScore: null,
      safetyGrade: null,
      safetyScore: null,
      supplyChange7dPct: null,
      supplyChange30dPct: null,
      mintSurge: null,
    },
    ...overrides,
  });
}

export function makeFrozenDdrV2Row(source = makeDdrSourceRow(), overrides: Record<string, unknown> = {}): DdrV2ResponseRow {
  return DdrV2ResponseRowSchema.parse({
    stablecoinId: source.stablecoinId,
    symbol: source.symbol,
    name: source.name,
    pegCurrency: source.pegCurrency,
    governance: source.governance,
    status: source.status,
    eventId: source.eventId,
    incidentKey: "ddr2:test",
    startedAt: source.startedAt,
    direction: source.direction,
    kind: "prediction",
    prediction: {
      state: "frozen",
      publicPredictionId: 7,
      incidentKey: "ddr2:test",
      predictionPolicyVersion: "sticky-24h-v1",
      predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
      predictionMethodologyVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      resolutionRubricVersion: "resolution-rubric-v1",
      durationModelVersion: "duration-landmark-v1",
      incidentGroupingVersion: "incident-group-v1",
      supportRulesVersion: "support-rules-v1",
      eligibleAt: 86400,
      policyDelaySec: 86400,
      lockedAt: 86401,
      publishedAt: 86500,
      publicationSnapshotToken: "ddrpub:test",
      snapshotGeneration: 2,
      eventAgeAtLockSec: 86400,
      lockTiming: "on_time",
      lockTrigger: "scheduled_24h",
      readiness: null,
      backstop: null,
      source: "public_prediction",
      deferralReason: null,
      deferralCount: null,
      rowHash: "a".repeat(64),
      lineage: null,
      modelAsOf: 86401,
      latestErratum: null,
      errataCount: 0,
      errataHistory: [],
    },
    frozen: {
      resolution: source.resolution,
      duration: { ...source.duration, remainingAsOf: 86401, medianResolveAt: null, iqrResolveAt: null },
      relatedContext: source.relatedContext,
      sourceRow: source,
    },
    live: {
      currentEventId: source.eventId,
      ageSec: source.ageSec,
      peakDeviationBps: source.peakDeviationBps,
      currentDeviationBps: source.currentDeviationBps,
      eventState: "active",
      updatedAt: source.startedAt + source.ageSec,
      stale: false,
      degradedReason: null,
    },
    ...overrides,
  });
}

export interface MakeDdrResponseRowOptions {
  stablecoinId?: string;
  symbol?: string;
  name?: string;
  tier?: DdrResolutionTier;
  sourceOverrides?: Partial<DdrRow>;
  liveOverrides?: Partial<DdrV2LiveOverlay>;
}

export function makeDdrResponseRow({
  stablecoinId = "lusd-liquity",
  symbol = "LUSD",
  name = "Liquity USD",
  tier = "at_risk",
  sourceOverrides = {},
  liveOverrides = {},
}: MakeDdrResponseRowOptions = {}): DdrV2ResponseRow {
  const source = makeDdrSourceRow({
    ...sourceOverrides,
    stablecoinId,
    symbol,
    name,
    resolution: { tier, factors: [] },
  });
  const incidentKey = `ddr2:${source.stablecoinId}`;
  const base = makeFrozenDdrV2Row(source);
  return makeFrozenDdrV2Row(source, {
    incidentKey,
    prediction: {
      ...base.prediction,
      incidentKey,
      publicPredictionId: source.eventId,
      publicationSnapshotToken: `ddrpub:${source.stablecoinId}`,
    },
    live: { ...base.live, ...liveOverrides },
  });
}
